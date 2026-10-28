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
      `SELECT account_email FROM inventory WHERE UPPER(sales_id) = ? LIMIT 1`
    )
      .bind(salesId)
      .first();

    if (!inventory || !inventory.account_email) {
      return json({
        ok: true,
        verified: false,
        message: "We couldn't find that Sales ID. Check it and try again."
      }, 200);
    }

    const email = String(inventory.account_email).trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return json({
        ok: true,
        verified: true,
        code: null,
        message: "No email is linked to this Sales ID."
      }, 200);
    }

    const fifteenMinutesAgo = Math.floor(Date.now() / 1000) - 15 * 60;

    const { results } = await MAIL_DB.prepare(
      `SELECT subject, text_content, html_content, received_at
       FROM emails
       WHERE LOWER(to_address) = ?
         AND received_at >= ?
       ORDER BY received_at DESC
       LIMIT 8`
    )
      .bind(email, fifteenMinutesAgo)
      .all();

    let code = null;
    for (const row of results || []) {
      const combined = [row.subject, row.text_content, row.html_content].filter(Boolean).join("\n");
      // Only attempt extraction on emails that look like sign-in code messages
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
 * True when the email content contains language typical of a Netflix / service sign-in code.
 */
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

/**
 * Prefer codes that appear near sign-in phrases. Fallback is only used when the
 * email already passed the looksLikeSignInCodeEmail check.
 */
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

  // Narrower fallback: only spaced 4/6 digit sequences (common in Netflix emails)
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
