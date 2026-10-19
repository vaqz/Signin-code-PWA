const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbymWQbpg2VDIH4aEdKkM0KMigJKooqFcKvKeP-54BqO4R2DgYT56CK7KQyIyoQ_PZf0/exec";

export async function onRequestPost(context) {
  const request = context.request;
  const origin = request.headers.get("Origin");

  // Only accept browser requests from this same site.
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
  const email = String(body.email || "").trim().toLowerCase();

  if (
    !salesId || salesId.length > 64 ||
    !email || email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json({ ok: false, verified: false, message: "Enter a valid Sales ID and email address." }, 400);
  }

  try {
    // Server-to-server request avoids exposing the Apps Script endpoint in the page code.
    // Apps Script accepts JSON text even when sent as text/plain.
    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ salesId, email }),
      redirect: "follow",
      signal: AbortSignal.timeout(12000)
    });

    if (!upstream.ok) {
      return json({ ok: false, verified: false, message: "Verification is temporarily unavailable." }, 502);
    }

    const result = await upstream.json();
    if (!result || typeof result.verified !== "boolean") {
      return json({ ok: false, verified: false, message: "Verification is temporarily unavailable." }, 502);
    }

    return json({
      ok: result.ok === true,
      verified: result.verified,
      message: result.verified
        ? "Your order details have been verified."
        : "We couldn't verify those details. Check them and try again."
    }, 200);
  } catch {
    return json({ ok: false, verified: false, message: "Verification is temporarily unavailable." }, 502);
  }
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
