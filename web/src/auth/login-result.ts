// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
// Ported verbatim from create-solid-app's reference implementation.
// login-result.ts — the pure success criterion for the interactive login probe.
//
// This is deliberately a TINY, dependency-free module so the rule "what counts as
// a successful login" is testable in isolation (no browser, no oauth stack) and
// cannot be quietly weakened.
//
// THE RULE (and the bugs it fixes):
//   The login flow probes a resource and lets @solid/reactive-authentication
//   upgrade a 401 with a DPoP token, then RETRIES. A naive "any 2xx => logged in"
//   check is WRONG: probing a PUBLIC resource (a public storage root, or the `/`
//   fallback) returns 200 with NO token attached and NO auth flow having run — yet
//   would mark the user authenticated. Conversely a final 401/403 means the popup
//   was cancelled or the minted token was rejected — also not a session.
//
//   A genuine login therefore requires BOTH:
//     1. the token provider actually minted + attached a token DURING THIS LOGIN
//        ATTEMPT (an auth flow ran to completion for THIS probe), AND
//     2. the probe's final response was 2xx (the attached token was ACCEPTED).
//   A 2xx with no token attached this attempt is a public read, not a login.
//
//   THE SUBTLE PART (round-3 fix): "a token was attached" must be measured
//   PER-ATTEMPT, never inferred from a sticky provider-level flag. A boolean
//   "session ever established" is sticky — once a previous successful upgrade set
//   it, it stays set, so a LATER attempt whose probe hits a public 200 (no upgrade
//   for THAT probe) would still look authenticated. That reintroduces the bug
//   after a previously-rejected probe, or after logout→re-login. The robust signal
//   is the provider's MONOTONIC count of token attachments: snapshot it BEFORE the
//   probe and read it AFTER — a strictly higher count proves a token was attached
//   during THIS attempt and nothing before it can masquerade as the current login.

export interface LoginProbeOutcome {
  /** The final HTTP status of the probe (after any reactive-auth popup→retry). */
  status: number;
  /**
   * The provider's running token-attachment count snapshotted immediately BEFORE
   * this login attempt's probe ran.
   */
  tokensAttachedBefore: number;
  /**
   * The provider's running token-attachment count read immediately AFTER the
   * probe (and any popup→retry) completed. A value strictly greater than
   * {@link tokensAttachedBefore} is the proof that the provider attached a token
   * DURING THIS attempt — the per-attempt signal that replaces the old sticky
   * "session established" flag.
   */
  tokensAttachedAfter: number;
}

export type LoginAssessment =
  | { ok: true }
  | { ok: false; reason: "public-no-token" | "rejected" | "error"; message: string };

/** True for HTTP 2xx. */
function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Decide whether a login probe proves an authenticated session. Pure — no I/O.
 *
 * "Token attached this attempt" is `tokensAttachedAfter > tokensAttachedBefore`
 * — a per-attempt DELTA on the provider's monotonic attach counter, NOT a sticky
 * flag a previous session could have left set.
 *
 * - 2xx + token attached THIS attempt   → logged in.
 * - 2xx + NO token THIS attempt         → PUBLIC resource (or stale prior session) → NOT logged in.
 * - 401/403                             → token absent/rejected (cancelled popup or refused) → NOT logged in.
 * - any other non-2xx                   → probe error → NOT logged in.
 */
export function assessLoginProbe(outcome: LoginProbeOutcome): LoginAssessment {
  const { status, tokensAttachedBefore, tokensAttachedAfter } = outcome;
  // The per-attempt proof: a token was minted + attached DURING THIS probe iff
  // the provider's running count went up while this attempt ran. A flag left set
  // by a previous session/attempt cannot satisfy this — the count was already
  // included in `tokensAttachedBefore`.
  const tokenAttachedThisAttempt = tokensAttachedAfter > tokensAttachedBefore;
  if (is2xx(status)) {
    if (tokenAttachedThisAttempt) return { ok: true };
    return {
      ok: false,
      reason: "public-no-token",
      message:
        "Login did not complete — no token was attached during this login " +
        "attempt (the probed resource is public, so no authentication actually " +
        "happened). Try a resource that requires login, or check your WebID's " +
        "storage is private.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      reason: "rejected",
      message:
        "Login did not complete — no valid token was accepted (the popup may have " +
        "been cancelled, or the identity provider rejected the login).",
    };
  }
  return { ok: false, reason: "error", message: `Login probe failed: ${status}` };
}
