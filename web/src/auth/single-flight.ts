// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// single-flight.ts — the PURE decision for the WebID-scoped single-flight login
// gate (roborev round-4b finding 1). Factored out of SessionProvider so it is
// testable with no browser/React/oauth stack: given the WebID currently in flight
// (if any) and the WebID a new login() asks for, decide ONE of three actions.
//
// THE RULE (and the bug it fixes):
//   The round-4 gate returned the in-flight promise unconditionally, so a
//   concurrent login("bob") while login("alice") was running resolved as if BOB
//   had logged in — a false-positive for a DIFFERENT identity (Bob was never even
//   attempted). The fix keys the gate on the in-flight WebID:
//     - nothing in flight                → START a new login.
//     - SAME WebID in flight             → SHARE the in-flight promise (double-click
//                                          / StrictMode remount → one login).
//     - DIFFERENT WebID in flight        → REJECT cleanly, WITHOUT starting an
//                                          overlapping probe (do not resolve as the
//                                          other identity; do not disturb the
//                                          in-flight attempt's state).

/**
 * The three outcomes of the single-flight gate for an incoming `login(id)`:
 *  - `"start"`  — no login in flight; begin `doLogin(id)` and record it as in-flight.
 *  - `"share"`  — a login for the SAME WebID is already running; await its promise.
 *  - `"reject"` — a login for a DIFFERENT WebID is running; reject without overlap.
 */
export type SingleFlightDecision = "start" | "share" | "reject";

/**
 * Decide what `login(id)` should do given the WebID currently in flight. Pure — no
 * I/O, no state mutation. `webIdsEqual` is injected so this module stays free of
 * the provider import (and so the test pins the exact equality used by the caller).
 *
 * @param inFlightId  the WebID of the in-flight login, or null when none is running.
 * @param requestedId the WebID the new `login()` call wants to authenticate as.
 * @param webIdsEqual the strict WebID identity comparison the caller uses.
 */
export function decideSingleFlight(
  inFlightId: string | null,
  requestedId: string,
  webIdsEqual: (a: string | undefined, b: string | undefined) => boolean,
): SingleFlightDecision {
  if (inFlightId === null) return "start";
  return webIdsEqual(inFlightId, requestedId) ? "share" : "reject";
}
