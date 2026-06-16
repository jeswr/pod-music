// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// autologin-plan.ts — the PURE decision for the autologin mount effect, factored
// out of SessionProvider so the three security-critical scenarios are testable with
// NO browser / React / oauth stack (the host has no DOM test env or testing-library,
// and adding one is gated — so the rule "what autologin does on mount" lives here as
// a pure function, exactly as single-flight.ts / login-result.ts do for their rules).
//
// The autologin feature: the Pod Manager deep-links the app with
// `#autologin/<encodeURIComponent(webid)>`. Because the user already has a live IdP
// session at the shared broker AND the app was previously authorized, a FULL-PAGE
// Solid-OIDC redirect comes straight back ALREADY AUTHENTICATED (silent SSO). A popup
// auto-opened on load has no user gesture and is browser-blocked, so this MUST be a
// full-page redirect (which destroys in-memory state → the two-phase persisted flow
// in WebIdDPoPTokenProvider).
//
// On mount (after the runtime is `ready`, and ONLY when NOT already logged in) there
// are two cases plus the abort + loop guard:
//   CASE A — returning from the redirect (a persisted flow record exists AND the URL
//            has ?code&state): COMPLETE the login.
//   ABORT  — returning from the redirect (a persisted flow record exists) but the URL
//            carries an OAuth ERROR (?error&state — the broker declined silent SSO,
//            or the user declined): ABORT, cleaning up the persisted record, the DPoP
//            key material, the sentinel + the URL, and surfacing the error. WITHOUT
//            this, an error return is IGNORED (CASE A needs `code`), leaving the stale
//            pending record + sentinel in place — which BLOCKS future autologins in
//            the tab (the planner keeps waiting for a code that never comes).
//   CASE B — a fresh `#autologin/<webid>` deep-link, no pending record: BEGIN the
//            redirect (full-page navigation to the broker).
//   LOOP GUARD — a second `#autologin` for the SAME WebID while the one-shot sentinel
//            is already set for THAT WebID (we bounced back still unauthenticated)
//            must NOT loop: it falls through to the login screen and clears the
//            sentinel. A deep-link for a DIFFERENT WebID is NOT a loop — it begins a
//            fresh login (overwriting the stale sentinel).

/**
 * The decision the autologin mount effect should execute. Pure data — the effect
 * performs the side effects (URL cleaning, provider calls, navigation):
 *  - `"none"`            — do nothing (not ready / already logged in / not an
 *                          autologin URL / once-guard already fired).
 *  - `"complete"`       — CASE A: resume + complete the persisted redirect login;
 *                          `webId` is the persisted target (may be null if the record
 *                          omitted it — the effect then falls back to the OP claim).
 *  - `"abort-redirect"` — ABORT: a pending redirect returned with an OAuth ERROR
 *                          (?error&state). Reset the provider (clears the persisted
 *                          record + DPoP key material), clear the sentinel, clean the
 *                          URL, and surface the error. Distinct from `complete` so the
 *                          effect does not rely on validateAuthResponse to detect the
 *                          missing code, and so the persisted record can never leak.
 *  - `"begin"`          — CASE B: start a fresh redirect login for `webId`.
 *  - `"clear-sentinel"` — LOOP GUARD: a repeat deep-link for the SAME WebID with the
 *                          sentinel set; clean the URL + clear the sentinel, show the
 *                          login screen.
 */
export type AutologinAction =
  | { kind: "none" }
  | { kind: "complete"; webId: string | null }
  | { kind: "abort-redirect" }
  | { kind: "begin"; webId: string }
  | { kind: "clear-sentinel" };

export interface AutologinInputs {
  /** The auth runtime is loaded + registerGlobally() has run. */
  ready: boolean;
  /** The token provider singleton has resolved (mount has wired providerRef). */
  hasProvider: boolean;
  /** Already authenticated — a session WINS; autologin is skipped (test b). */
  loggedIn: boolean;
  /** The module-level once-guard: the effect body already fired this page load. */
  effectAlreadyRan: boolean;
  /** A persisted full-page-redirect flow record exists in sessionStorage. */
  hasPendingRedirect: boolean;
  /** The WebID the persisted redirect flow is for (CASE A target), or null. */
  pendingRedirectWebId: string | null;
  /** The URL carries an OAuth `?code` AND `?state` (a successful redirect return). */
  hasCodeParams: boolean;
  /** The URL carries an OAuth `?error` AND `?state` (a FAILED redirect return). */
  hasErrorParams: boolean;
  /** The WebID parsed from a `#autologin/<encoded>` fragment, or null. */
  fragmentWebId: string | null;
  /** The one-shot sentinel value (the WebID last attempted), or null. */
  sentinel: string | null;
  /**
   * The WebID identity comparison the rest of the auth seam uses
   * ({@link webIdsEqual}). Injected (like `decideSingleFlight` takes it) so this pure
   * module stays free of the provider import and the test pins the exact equality.
   * The loop guard compares the sentinel to `fragmentWebId` through this, so a stale
   * sentinel for a DIFFERENT WebID does not swallow a fresh deep-link.
   */
  webIdsEqual: (a: string | undefined, b: string | undefined) => boolean;
}

/**
 * Decide what the autologin mount effect should do. Pure — no I/O, no mutation.
 *
 * GUARDS first (in order): not ready / no provider / already logged in / once-guard
 * already fired → `none`. Then:
 *  - CASE A: a pending redirect record + `?code&state` → `complete`.
 *  - ABORT:  a pending redirect record + `?error&state` → `abort-redirect` (the broker
 *            declined silent SSO / the user declined — clean up, do not wait forever).
 *  - CASE B: NO pending record + an `#autologin/<webid>` fragment:
 *      - sentinel set for the SAME WebID (bounced back) → `clear-sentinel` (loop guard);
 *      - sentinel set for a DIFFERENT WebID (a new deep-link in the tab) → `begin`
 *        (the effect overwrites the stale sentinel with the new WebID it attempts);
 *      - no sentinel → `begin`.
 *  - anything else (no fragment, a pending record without code/error, …) → `none`.
 */
export function planAutologin(inputs: AutologinInputs): AutologinAction {
  if (!inputs.ready || !inputs.hasProvider || inputs.loggedIn || inputs.effectAlreadyRan) {
    return { kind: "none" };
  }
  // CASE A — returning from the full-page redirect with an authorization code.
  if (inputs.hasPendingRedirect && inputs.hasCodeParams) {
    return { kind: "complete", webId: inputs.pendingRedirectWebId };
  }
  // ABORT — returning from the full-page redirect with an OAuth ERROR. CASE A only
  // fires with a `code`, so without this an error return is silently ignored, leaving
  // the persisted record + DPoP key + sentinel in place and BLOCKING future autologins.
  if (inputs.hasPendingRedirect && inputs.hasErrorParams) {
    return { kind: "abort-redirect" };
  }
  // CASE B — a fresh autologin deep-link (only when NO redirect is mid-flight).
  if (!inputs.hasPendingRedirect && inputs.fragmentWebId) {
    // LOOP GUARD: the sentinel is set for the SAME WebID → we bounced back still
    // unauthenticated (a genuine loop). Do not re-attempt. A sentinel for a DIFFERENT
    // WebID is NOT a loop — fall through to `begin` for the new WebID (the effect's
    // begin path overwrites the stale sentinel with the WebID it now attempts).
    if (inputs.sentinel !== null && inputs.webIdsEqual(inputs.sentinel, inputs.fragmentWebId)) {
      return { kind: "clear-sentinel" };
    }
    return { kind: "begin", webId: inputs.fragmentWebId };
  }
  return { kind: "none" };
}
