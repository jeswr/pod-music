// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// gen-clientid.mjs — emit the per-origin static auth artifacts BEFORE every
// build/dev (chained inline in package.json's dev/build scripts):
//
//   public/clientid.jsonld   the Solid-OIDC Client Identifier Document
//   public/callback.html     the OAuth popup → opener post-back page
//
// WHY GENERATED, NOT COMMITTED. Solid-OIDC dereferences the `client_id` URL, so
// the document's `client_id` / `redirect_uris` / `client_uri` MUST all point at
// THIS deployment's own origin (https://music.solid-test.jeswr.org in prod,
// http://localhost:5173 in dev). The origin is the single input — both files are
// derived from it here, so a copy can never drift from the origin it claims.
//
// ORIGIN SOURCE (first non-empty wins): APP_ORIGIN, then VITE_APP_ORIGIN, else
// the dev default http://localhost:5173. Set
// APP_ORIGIN=https://music.solid-test.jeswr.org for a production build.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");

const DEV_DEFAULT = "http://localhost:5173";

/** Resolve + validate the deployment origin. Throws on a malformed value. */
function resolveOrigin() {
  const raw = process.env.APP_ORIGIN || process.env.VITE_APP_ORIGIN || DEV_DEFAULT;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_ORIGIN is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`APP_ORIGIN must be http(s): ${raw}`);
  }
  // `url.origin` strips any path/query/hash and the trailing slash — exactly the
  // byte-for-byte form the OP compares the client_id against.
  return url.origin;
}

/**
 * The Solid-OIDC Client Identifier Document. A PUBLIC browser client (no secret;
 * `token_endpoint_auth_method: "none"`). `client_id` MUST equal the URL this is
 * served from byte-for-byte, and `redirect_uris` MUST list the callback the
 * token provider passes (origin + /callback.html).
 */
function clientIdDocument(origin) {
  return {
    "@context": ["https://www.w3.org/ns/solid/oidc-context.jsonld"],
    client_id: `${origin}/clientid.jsonld`,
    client_name: "Pod Music",
    client_uri: `${origin}/`,
    redirect_uris: [`${origin}/callback.html`],
    scope: "openid webid offline_access",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * The OAuth popup callback page. After the user authorizes, the OP redirects the
 * popup here with `?code=&state=`; we hand the full URL back to the opener (the
 * app window) so its pending getCode() resolves.
 *
 * SECURITY: the URL carries the OAuth authorization code, so target the message
 * at OUR origin ONLY — never "*". callback.html is same-origin as the app, so
 * `${origin}` is the correct, restrictive target. The opener also origin-checks
 * the message it receives.
 */
function callbackHtml(origin) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signing you in… · Pod Music</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
             display: grid; place-items: center; min-height: 100vh; margin: 0;
             color: #1c2b30; background: #f3f8f9; }
      p { font-size: 0.95rem; }
    </style>
  </head>
  <body>
    <p>Signing you in…</p>
    <script>
      // Hand the authorization code back to the app window that opened this popup
      // (@solid/reactive-authentication's getCode() is awaiting it). Target OUR
      // origin only — the URL carries the OAuth code; never broadcast to "*".
      if (window.opener) {
        window.opener.postMessage(location.href, ${JSON.stringify(origin)});
      }
    </script>
  </body>
</html>
`;
}

async function main() {
  const origin = resolveOrigin();
  await mkdir(publicDir, { recursive: true });
  await writeFile(
    resolve(publicDir, "clientid.jsonld"),
    `${JSON.stringify(clientIdDocument(origin), null, 2)}\n`,
  );
  await writeFile(resolve(publicDir, "callback.html"), callbackHtml(origin));
  console.log(`gen-clientid: wrote clientid.jsonld + callback.html for origin ${origin}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
