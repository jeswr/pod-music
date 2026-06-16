// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Display hint: the suite's HOME identity provider. The auth issuer always
   *  comes from the WebID profile, so this is non-load-bearing for login. */
  readonly VITE_HOME_IDP?: string;
  /** Mirror of APP_ORIGIN for UI labelling; the client_id is derived at runtime
   *  from the actual window origin. */
  readonly VITE_APP_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The build version (short git SHA, else package version) injected by Vite's
 * `define` at build time — see vite.config.ts. Used as the header
 * FeedbackButton's `appVersion` so a filed issue pins the deployed commit. In
 * the test environment vitest provides it via the same `define`.
 */
declare const __APP_VERSION__: string;
