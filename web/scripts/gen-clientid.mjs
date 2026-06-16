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
//
// ENV FILES. This Node script runs BEFORE Vite, so Vite's own `.env` loading has
// NOT happened yet — without the explicit load below, a `.env` / `.env.local`
// holding `APP_ORIGIN` would be IGNORED and the build would silently fall back to
// the localhost default, emitting a production-broken clientid (wrong origin).
// We load `.env` then `.env.local` from web/ here, mirroring Vite's precedence:
// the SHELL environment WINS over both files, and `.env.local` overrides `.env`.
// A missing file is fine (not every checkout has one).
//
// PRECEDENCE IS RESOLVED PER-VALUE, NOT PER-VARIABLE. The origin can come from
// either `APP_ORIGIN` (preferred) or `VITE_APP_ORIGIN`, so "shell wins" must hold
// ACROSS the pair: a shell-provided `VITE_APP_ORIGIN` must beat a file-provided
// `APP_ORIGIN` even though `APP_ORIGIN` ranks first. We therefore resolve the
// SHELL origin (snapshotted before any file load) first, and only fall through to
// the file-sourced origin when the shell provided neither variable.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const publicDir = resolve(webRoot, "public");

const DEV_DEFAULT = "http://localhost:5173";

/** Pick the first non-empty origin from a source's two origin variables. */
const pickOrigin = (src) => src.APP_ORIGIN || src.VITE_APP_ORIGIN || "";

// Snapshot the SHELL-provided origin BEFORE loading any file, so a shell value
// (from either origin variable) always wins over a file value.
const shellOrigin = pickOrigin(process.env);

/**
 * Merge a `.env`-style file into `process.env` for keys NOT already set by the
 * shell, so an explicit `APP_ORIGIN=… npm run build` always wins. Later files in
 * the load order (`.env.local`) override earlier ones (`.env`) but never the
 * shell. A missing/unreadable file is a no-op (not every checkout ships one).
 * Uses Node's built-in `util.parseEnv` (added in Node 20.12 — the package's
 * `engines.node` floor is `>=20.12` to guarantee it), so no dotenv dependency.
 */
function loadEnvFile(name) {
  let content;
  try {
    content = readFileSync(resolve(webRoot, name), "utf8");
  } catch {
    return; // file absent — fine.
  }
  const parsed = parseEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    // Shell-set values win; `.env.local` (loaded after `.env`) may fill what the
    // shell left unset, overriding `.env` because `.env`'s key is now present —
    // so track which keys WE set vs the shell set.
    if (!shellKeys.has(key)) {
      process.env[key] = value;
    }
  }
}

// Keys the SHELL set to a NON-EMPTY value before we load any file — these are
// never overridden by a `.env*` file. An EMPTY shell var (`APP_ORIGIN=`) is
// treated as ABSENT (consistent with the `||` chains, which skip empty values),
// so it does NOT suppress a non-empty file-provided value.
const shellKeys = new Set(
  Object.entries(process.env)
    .filter(([, value]) => value !== "" && value !== undefined)
    .map(([key]) => key),
);

// Load order: `.env` first, then `.env.local` overrides it (both yield to shell).
loadEnvFile(".env");
loadEnvFile(".env.local");

/** Resolve + validate the deployment origin. Throws on a malformed value. */
function resolveOrigin() {
  // Shell origin (snapshotted pre-load) wins across BOTH origin variables; only
  // when the shell set neither do we use the now-merged (file-sourced) values.
  const raw = shellOrigin || pickOrigin(process.env) || DEV_DEFAULT;
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
