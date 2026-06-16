// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
// auth-flow-holder.ts — the StrictMode-safe holder for the CURRENT mounted
// <authorization-code-flow> element's `getCode`.
//
// THE BUG THIS FIXES (StrictMode-stale auth-flow element):
//   The auth runtime is a PAGE-LIFETIME singleton (it patches globalThis.fetch
//   exactly once — re-patching would stack handlers). The token provider's
//   `getCode` is therefore captured ONCE, at the singleton's construction. If we
//   bind it directly to the FIRST mounted <authorization-code-flow> element
//   (`element.getCode.bind(element)`), React.StrictMode breaks login: StrictMode
//   mounts the element, runs the mount effect, then UNMOUNTS that first element
//   immediately (and mounts a fresh one). The singleton survives the remount, so
//   it keeps calling a `getCode` bound to the REMOVED popup element — later logins
//   open a popup on a detached element and never resolve.
//
// THE FIX (mirrors `pendingWebIdHolder`):
//   A MODULE-LEVEL holder for the current element's `getCode`, updated on EVERY
//   mount. The singleton is handed `getCodeThroughHolder`, a stable callback that
//   reads the LATEST `getCode` out of the holder at authentication time — so it
//   always drives whichever <authorization-code-flow> element is currently live,
//   never one a StrictMode remount removed. The mount effect writes the holder on
//   mount; we never close over the first element.
//
// COLD-START SAFETY (roborev HIGH):
//   The value written to the holder is a LAZY accessor `(uri, signal) =>
//   ui.getCode(uri, signal)`, NOT an eagerly-bound `ui.getCode.bind(ui)`. On a COLD
//   first mount the dynamically-imported reactive-auth chunk (which runs
//   `customElements.define("authorization-code-flow", …)`) has not resolved yet, so
//   the element is not upgraded and `ui.getCode` is `undefined` — eagerly reading or
//   binding it at mount time would THROW and break first-load login. Reading
//   `ui.getCode` only at CALL time (login time, after the import + registration have
//   awaited) keeps the holder safe to populate on the very first synchronous mount.

import type { AuthorizationCodeFlow, GetCodeCallback } from "@solid/reactive-authentication";

/**
 * The CURRENT live <authorization-code-flow> element's `getCode`, in a stable
 * module-level holder. Each mount writes a LAZY accessor (see {@link
 * lazyElementGetCode}) here; the singleton reads it via {@link
 * getCodeThroughHolder}. `null` until the first element mounts (or after a
 * deliberate clear).
 */
export const authFlowHolder: { current: GetCodeCallback | null } = { current: null };

/** The custom-element name registered by @solid/reactive-authentication. */
export const AUTH_FLOW_ELEMENT = "authorization-code-flow";

/**
 * Build the LAZY `getCode` accessor a mount publishes to {@link authFlowHolder}.
 *
 * COLD-START SAFETY (roborev HIGH): on a COLD first mount the dynamically-imported
 * reactive-auth chunk — whose top-level `customElements.define(AUTH_FLOW_ELEMENT,
 * …)` upgrades the element — has not resolved yet, so `ui.getCode` is `undefined`.
 * Eagerly reading/binding it at mount time (`ui.getCode.bind(ui)`) would THROW and
 * break first-load login. This accessor reads `ui.getCode` only at CALL time (login
 * time), with the correct `this` (= the element), and forwards both args. If the
 * element is STILL not upgraded when first called (a very-early login racing the
 * import), it awaits the custom-element registration first — so even that can't
 * throw. `whenDefined` resolves immediately once the element is already registered.
 *
 * The parameter is typed as the upgraded {@link AuthorizationCodeFlow}, but the
 * whole point is the RUNTIME case where the element is not yet upgraded and
 * `getCode` is absent — hence the runtime `typeof` guard rather than relying on the
 * static type.
 */
export function lazyElementGetCode(ui: AuthorizationCodeFlow): GetCodeCallback {
  return async (authorizationUri, signal) => {
    if (typeof ui.getCode !== "function") {
      await customElements.whenDefined(AUTH_FLOW_ELEMENT);
    }
    return ui.getCode(authorizationUri, signal);
  };
}

/**
 * A STABLE `getCode` for the page-lifetime auth singleton: it delegates to
 * whatever `getCode` is currently in {@link authFlowHolder} at call time, so the
 * auth flow always runs against the latest mounted element — never one captured at
 * singleton construction and later removed by a StrictMode remount. Throws if no
 * element is mounted (the popup cannot run without a live element).
 */
export const getCodeThroughHolder: GetCodeCallback = async (authorizationUri, signal) => {
  const getCode = authFlowHolder.current;
  if (!getCode) {
    throw new Error("No <authorization-code-flow> element is mounted for login");
  }
  return getCode(authorizationUri, signal);
};
