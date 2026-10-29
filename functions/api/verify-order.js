export async function onRequestPost(context) {
  const request = context.request;
  const origin = request.headers.get("Origin");

  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin) {
        return json({ ok: false, verified: false, message: "Request not allowed." }, 403);
      }
    } catch {
      return json({ ok: false, verified: false, message: "Request not allowed." }, 403);
    }
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2048) {
      return json({ ok: false, verified: false, message: "Request is too large." }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, verified: false, message: "Invalid request." }, 400);
  }

  const salesId = String(body.salesId || "").trim().toUpperCase();

  if (!salesId || salesId.length > 64) {
    return json({ ok: false, verified: false, message: "Enter a valid Sales ID." }, 400);
  }

  const { INVENTORY_DB, MAIL_DB } = context.env;
  if (!INVENTORY_DB || !MAIL_DB) {
    return json({ ok: false, verified: false, message: "Verification is temporarily unavailable." }, 502);
  }

  try {
    const inventory = await INVENTORY_DB.prepare(
      `SELECT account_email, otp_url FROM inventory WHERE UPPER(sales_id) = ? LIMIT 1`
    )
      .bind(salesId)
      .first();

    if (!inventory) {
      return json({
        ok: true,
        verified: false,
        message: "We couldn't find that Sales ID. Check it and try again."
      }, 200);
    }

    // Prefer TOTP if otp_url contains a secret
    const totpCode = await generateTotpFromUrl(inventory.otp_url);
    if (totpCode) {
      return json({
        ok: true,
        verified: true,
        code: totpCode,
        message: "Code retrieved."
      }, 200);
    }

    // Fall back to email sign-in code
    const email = String(inventory.account_email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return json({
        ok: true,
        verified: true,
        code: null,
        message: "No email is linked to this Sales ID."
      }, 200);
    }

    const fifteenMinutesAgo = Math.floor(Date.now() / 1000) - 15 * 60;
    const emailPattern = `%${email}%`;

    // Match direct delivery (to_address) OR forwards that mention the original address in the body
    const { results } = await MAIL_DB.prepare(
      `SELECT subject, text_content, html_content, received_at, to_address
       FROM emails
       WHERE received_at >= ?
         AND (
           LOWER(to_address) = ?
           OR LOWER(COALESCE(subject, '')) LIKE ?
           OR LOWER(COALESCE(text_content, '')) LIKE ?
           OR LOWER(COALESCE(html_content, '')) LIKE ?
         )
       ORDER BY received_at DESC
       LIMIT 8`
    )
      .bind(fifteenMinutesAgo, email, emailPattern, emailPattern, emailPattern)
      .all();

    let code = null;
    for (const row of results || []) {
      const combined = [row.subject, row.text_content, row.html_content].filter(Boolean).join("\n");
      if (!looksLikeSignInCodeEmail(combined)) continue;
      code = extractBestCode(combined);
      if (code) break;
    }

    return json({
      ok: true,
      verified: true,
      code: code || null,
      message: code
        ? "Code retrieved."
        : "No recent sign-in code found. Please request a new code and try again."
    }, 200);
  } catch (err) {
    console.error("verify-order error:", err);
    return json({ ok: false, verified: false, message: "Verification is temporarily unavailable." }, 502);
  }
}

/**
 * Extract secret from otp_url and generate current 6-digit TOTP.
 * Supports URLs like https://vmtotp.vaqzvasquez.workers.dev/?secret=BASE32SECRET
 */
async function generateTotpFromUrl(otpUrl) {
  if (!otpUrl || typeof otpUrl !== "string") return null;
  const trimmed = otpUrl.trim();
  if (!trimmed) return null;

  let secret;
  try {
    const url = new URL(trimmed);
    secret = url.searchParams.get("secret");
  } catch {
    // Not a full URL — try to treat the whole string as a secret if it looks like base32
    if (/^[A-Z2-7]+=*$/i.test(trimmed)) secret = trimmed;
    else return null;
  }

  if (!secret) return null;
  secret = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (secret.length < 16) return null;

  try {
    return await generateTotp(secret);
  } catch {
    return null;
  }
}

/**
 * RFC 6238 TOTP (SHA1, 30s step, 6 digits)
 */
async function generateTotp(base32Secret) {
  const key = base32ToBytes(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, "0");
}

function base32ToBytes(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

function looksLikeSignInCodeEmail(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("sign in") ||
    lower.includes("sign-in") ||
    lower.includes("signin") ||
    lower.includes("enter this code") ||
    lower.includes("your code") ||
    lower.includes("verification code") ||
    lower.includes("one-time") ||
    lower.includes("netflix")
  );
}

function extractBestCode(text) {
  if (!text) return null;

  const normalized = text.replace(/\s+/g, " ");

  const contextPatterns = [
    /Enter this code to sign in[:\s]*([\d\s]{4,20})/i,
    /sign[- ]?in code[:\s]*([\d\s]{4,20})/i,
    /your code[:\s]*([\d\s]{4,20})/i,
    /verification code[:\s]*([\d\s]{4,20})/i,
    /code[:\s]*([\d\s]{4,15})/i
  ];

  for (const regex of contextPatterns) {
    const match = normalized.match(regex);
    if (match && match[1]) {
      const digits = match[1].replace(/\D/g, "");
      if ((digits.length === 4 || digits.length === 6) && !/^0+$/.test(digits)) {
        return digits;
      }
    }
  }

  const spaced = [
    /\b(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\b/,
    /\b(\d)\s+(\d)\s+(\d)\s+(\d)\b/
  ];

  for (const regex of spaced) {
    const matches = text.match(regex);
    if (matches && matches.length > 0) {
      const candidate = matches[matches.length - 1].replace(/\s/g, "");
      if ((candidate.length === 4 || candidate.length === 6) && !/^0+$/.test(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
