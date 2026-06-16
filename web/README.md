<!-- AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate -->

# `web/` — the Pod Music static host shell

This directory turns the framework-agnostic `@jeswr/pod-music/ui` React component
library (`../src/ui`) into a **deployable, statically-served single-page app**
with standalone Solid login. It is the canonical "host shell" pattern shared
across the `pod-*` apps (stamped from `pod-docs/web`).

The host is intentionally tiny. The whole app is: log in → derive the user's pod
→ resolve the music library container → mount `<MusicLibrary>` → let it read the
pod. All the data logic (LDP, RDF, Type-Index discovery) lives in the library;
the host wires **auth + a music base**.

## How it works

```
index.html → src/main.tsx
  └─ <SessionProvider>            (src/auth/SessionProvider.tsx — the ONE auth seam)
       └─ <App>                   (src/App.tsx)
            ├─ logged out → <LoginScreen>          (WebID-first login)
            └─ logged in  → <MusicLibrary          (@jeswr/pod-music/ui)
                              base={musicBase} />
```

### Auth (standalone, no server)

`src/auth/*` is copied **verbatim** from the hardened `pod-docs/web` host shell —
it went through two roborev rounds (cross-user-leak fix, StrictMode
auth-flow-holder, generation-fenced `reset()`, per-probe login proof). Do not
re-derive it. `SessionProvider`:

1. snapshots the pristine `globalThis.fetch` (for the pre-popup public profile
   read, so it can never recurse on a 401);
2. **dynamically** imports `@solid/reactive-authentication` (so the browser-only
   custom element + oauth stack never evaluate at module-eval / SSR time —
   verified by the build: `customElements.define` is `0` in the main bundle);
3. builds a `WebIdDPoPTokenProvider` bound to this origin's **static Client
   Identifier Document** at `${origin}/clientid.jsonld`, so the consent screen
   shows "Pod Music";
4. calls `manager.registerGlobally()` — **this is what patches the global
   `fetch`** (the 0.1.3 constructor does NOT).

Once patched, every plain `fetch()` — including the ones inside `@jeswr/fetch-rdf`
and the `@jeswr/pod-music` data layer — transparently upgrades on a 401 with a
DPoP token. So `<MusicLibrary>` is mounted with **no `fetch` prop**.

### How the music base is resolved

`<MusicLibrary base />` needs the music library **container** (the data layer
derives `tracks/`/`albums/`/`playlists/` directly under `base`), NOT a bare pod
root. `src/auth/session-derivation.ts` resolves it in two steps:

- **pod root** = the first `pim:storage` advertised on the WebID profile, else the
  WebID origin (`scheme://host/`). A banner tells the user when the fallback is
  used.
- **music base** = via the data layer's Type-Index helper
  `MusicStore.findTrackContainers(webId)` — the parent of a container registered
  for `mo:Track`. When there is no registration (no profile link / no entry / a
  read failure) it falls back to the conventional `${podRoot}music/` and shows a
  banner so the user knows discovery found nothing registered.

### The per-origin static auth artifacts

Solid-OIDC **dereferences** the `client_id` URL, so each deployment must serve its
OWN Client Identifier Document. `scripts/gen-clientid.mjs` generates both files
from a single `APP_ORIGIN` env, written into `public/` before every build:

- `public/clientid.jsonld` — `client_id: ${origin}/clientid.jsonld`,
  `client_name: "Pod Music"`, `redirect_uris: [${origin}/callback.html]`,
  `client_uri: ${origin}/`, `scope: "openid webid offline_access"`,
  `grant_types: [authorization_code, refresh_token]`,
  `response_types: [code]`, `token_endpoint_auth_method: "none"`.
- `public/callback.html` — the OAuth popup → opener post-back, targeting the
  message at **our origin only** (`postMessage(href, "${origin}")`), never `"*"`.

Both are git-ignored (the script + `APP_ORIGIN` are the source of truth) and
copied by Vite into `dist/` at the root.

> `ignore-scripts=true` (supply-chain hardening) means npm lifecycle hooks do NOT
> run — so the generator is chained INLINE in the `build`/`dev` scripts
> (`node scripts/gen-clientid.mjs && vite …`), not as a `prebuild` hook.

## Build + run

```bash
# Dev (defaults APP_ORIGIN to http://localhost:5173):
npm install
npm run dev

# Production build for the music subdomain:
APP_ORIGIN=https://music.solid-test.jeswr.org npm run build
#   → emits a fully static dist/:
#       dist/index.html
#       dist/clientid.jsonld          (client_id = that origin)
#       dist/callback.html            (postMessage target = that origin)
#       dist/assets/*.js, *.css       (hashed; reactive-auth code-split into a
#                                      lazily-imported chunk)
```

Serve `dist/` with any file server (`caddy file_server`, etc.). The Vite config
aliases `@jeswr/pod-music/ui` → `../src/ui/index.ts`, so Vite bundles the
library's **TypeScript source directly** — no pre-built `dist/ui` is required.

Gates: `npm run lint` (Biome), `npm run typecheck` (tsc — the library source is
NOT re-typechecked here; `src/pod-music-ui.d.ts` declares the consumed surface),
`npm test` (vitest — the copied auth tests + the music-base derivation test),
`npm run build`.

## Env

| Var | Used by | Default | Notes |
|---|---|---|---|
| `APP_ORIGIN` | `gen-clientid.mjs` (build) | `http://localhost:5173` | The deployment origin. Set per-subdomain for prod. |
| `VITE_APP_ORIGIN` | UI label only | `http://localhost:5173` | Mirror of `APP_ORIGIN`; non-load-bearing (the runtime `client_id` derives from the actual window origin). |
| `VITE_HOME_IDP` | `LoginScreen` hint | `https://idp.solid-test.jeswr.org` | Display only — the auth issuer always comes from the WebID profile. |
