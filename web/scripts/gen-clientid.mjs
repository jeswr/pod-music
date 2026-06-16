// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// gen-clientid.mjs — emit the per-origin static auth artifacts BEFORE every
// build/dev (wired INLINE at the front of the `build`/`dev` scripts in
// package.json — NOT a `prebuild`/`predev` lifecycle hook, which `ignore-scripts=true`
// would silently skip):
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
// ORIGIN SOURCE. Two equivalent origin variables are supported, `APP_ORIGIN`
// (preferred) and `VITE_APP_ORIGIN`, set either in the shell or in a `.env` /
// `.env.local` file. Set APP_ORIGIN=https://music.solid-test.jeswr.org for a production build.
//
// ENV FILES + PRECEDENCE. This Node script runs BEFORE Vite, so Vite's own `.env`
// loading has NOT happened yet — without the explicit load below, a `.env` /
// `.env.local` holding the origin would be IGNORED and the build would silently
// fall back to the localhost default, emitting a production-broken clientid
// (wrong origin). We load `.env` then `.env.local` from web/ and resolve a single
// origin with this STRICT priority:
//
//   1. a NON-EMPTY shell-set origin var (`APP_ORIGIN` or `VITE_APP_ORIGIN`) — an
//      explicit `APP_ORIGIN=… npm run build` always wins; an EMPTY shell var
//      (`APP_ORIGIN=`) is treated as ABSENT, so it does not suppress a file value;
//   2. else the origin from `.env.local`;
//   3. else the origin from `.env`;
//   4. else the dev default.
//
// RESOLVE PER LAYER, THEN BY LAYER PRIORITY — NOT per variable across a merge.
// Each layer (shell / `.env.local` / `.env`) resolves its OWN origin first (its
// `APP_ORIGIN`, else its `VITE_APP_ORIGIN`); we then take the first layer that
// yielded one. This is what "`.env.local` FULLY overrides `.env`" means at the
// origin level: if `.env.local` provides EITHER origin var, `.env` is ignored
// entirely — even across variables. A naive `{...env, ...envLocal}` dictionary
// merge followed by one `APP_ORIGIN ?? VITE_APP_ORIGIN` pick is WRONG here: when
// `.env` sets `APP_ORIGIN` and `.env.local` sets `VITE_APP_ORIGIN`, the merged
// dict keeps BOTH keys and the `APP_ORIGIN`-first pick would wrongly return the
// `.env` value, letting `.env` beat `.env.local`. Per-layer resolution avoids that.

import { readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const publicDir = resolve(webRoot, "public");

export const DEV_DEFAULT = "http://localhost:5173";

/**
 * Resolve a single origin from ONE env layer: its `APP_ORIGIN` (preferred), else
 * its `VITE_APP_ORIGIN`, else `""`. Empty/undefined values are skipped by `||`.
 */
const layerOrigin = (layer) => layer.APP_ORIGIN || layer.VITE_APP_ORIGIN || "";

/**
 * Resolve the deployment origin from three env layers, by STRICT layer priority:
 *
 *   shell (non-empty origin vars) → `.env.local` → `.env` → `devDefault`.
 *
 * Each layer resolves its own origin (`layerOrigin`) FIRST, then we take the
 * first non-empty one — so `.env.local` providing EITHER origin var fully
 * overrides `.env` (even cross-variable), and a shell var beats both files.
 * An EMPTY shell origin var is dropped here, so it counts as absent.
 *
 * Pure + exported for unit testing (no filesystem / `process.env` access).
 *
 * @param {object} p
 * @param {Record<string,string|undefined>} [p.shellEnv]      shell environment
 * @param {Record<string,string>}           [p.envFile]       parsed `.env`
 * @param {Record<string,string>}           [p.envLocalFile]  parsed `.env.local`
 * @param {string}                          [p.devDefault]    fallback origin
 * @returns {string} the resolved origin (unvalidated raw value)
 */
export function resolveOriginValue({
  shellEnv = {},
  envFile = {},
  envLocalFile = {},
  devDefault = DEV_DEFAULT,
} = {}) {
  // Shell layer: keep ONLY non-empty origin vars (an empty `APP_ORIGIN=` is absent).
  const shellLayer = {};
  for (const key of ["APP_ORIGIN", "VITE_APP_ORIGIN"]) {
    const value = shellEnv[key];
    if (value !== undefined && value !== "") shellLayer[key] = value;
  }
  return layerOrigin(shellLayer) || layerOrigin(envLocalFile) || layerOrigin(envFile) || devDefault;
}

/**
 * Validate + normalise a raw origin to its byte-exact `URL.origin` form (no
 * path/query/hash, no trailing slash) — exactly what the OP compares `client_id`
 * against. Throws on a malformed or non-http(s) value. Pure + exported for tests.
 */
export function normaliseOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_ORIGIN is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`APP_ORIGIN must be http(s): ${raw}`);
  }
  return url.origin;
}

/**
 * Read + parse a `.env`-style file from web/ into a plain object. A missing or
 * unreadable file yields `{}` (not every checkout ships one). Uses Node's
 * built-in `util.parseEnv` (added in Node 20.12 — the package's `engines.node`
 * floor is `>=20.12` to guarantee it), so there is no dotenv dependency.
 */
function readEnvFile(name) {
  let content;
  try {
    content = readFileSync(resolve(webRoot, name), "utf8");
  } catch {
    return {}; // file absent — fine.
  }
  return parseEnv(content);
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
  // Files first (`.env`, `.env.local`), shell origin vars overlaid by priority.
  const origin = normaliseOrigin(
    resolveOriginValue({
      shellEnv: process.env,
      envFile: readEnvFile(".env"),
      envLocalFile: readEnvFile(".env.local"),
    }),
  );
  await mkdir(publicDir, { recursive: true });
  await writeFile(
    resolve(publicDir, "clientid.jsonld"),
    `${JSON.stringify(clientIdDocument(origin), null, 2)}\n`,
  );
  await writeFile(resolve(publicDir, "callback.html"), callbackHtml(origin));
  console.log(`gen-clientid: wrote clientid.jsonld + callback.html for origin ${origin}`);
}

// Only run the generator when executed directly (`node scripts/gen-clientid.mjs`),
// NOT when imported by a test — keep the pure resolvers importable side-effect-free.
// Compare REAL paths so a symlinked invocation path (e.g. macOS `/tmp` →
// `/private/tmp`) still matches this module's own real path.
function isInvokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(entry) === real(fileURLToPath(import.meta.url));
}
if (isInvokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
