# Sign-in Code PWA

A mobile-first Progressive Web App foundation for Vaqz Mobiz order verification.

## Current scope

- Responsive customer interface for entering an order number.
- PWA manifest and offline app-shell caching.
- No customer email addresses or authentication codes are stored in the browser.
- Backend integration is intentionally not enabled until a secure, authorized verification endpoint is configured.

## Files

- `index.html` — customer-facing interface
- `manifest.webmanifest` — installable PWA metadata
- `sw.js` — static app-shell cache
- `wrangler.toml` — Cloudflare Pages configuration

## Local preview

Serve the repository root with any static HTTP server, for example:

```sh
npx http-server . -p 4173 -c-1
```

Open `http://localhost:4173`.

## Cloudflare Pages

Create a Pages project connected to this repository.

- Production branch: `main`
- Build command: leave empty
- Build output directory: `/`

Attach the custom domain only after the preview is tested.

## Backend integration still required

The order lookup endpoint is not implemented yet. Do not put Google credentials, service tokens, mailbox credentials, or other secrets in frontend files. Implement order validation server-side and return only the minimum data needed. Do not return private customer information or authentication codes unless the flow is authorized and protected against abuse.
