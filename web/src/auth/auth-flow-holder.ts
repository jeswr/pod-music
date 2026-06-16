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

import type { GetCodeCallback } from "@solid/reactive-authentication";

/**
 * The CURRENT live <authorization-code-flow> element's `getCode`, in a stable
 * module-level holder. Each mount writes `element.getCode.bind(element)` here; the
 * singleton reads it lazily via {@link getCodeThroughHolder}. `null` until the
 * first element mounts (or after a deliberate clear).
 */
export const authFlowHolder: { current: GetCodeCallback | null } = { current: null };

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
