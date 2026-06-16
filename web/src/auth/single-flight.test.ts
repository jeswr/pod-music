// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Test for the WebID-scoped single-flight login gate (roborev round-4b finding 1).
//
// THE BUG (finding 1): the round-4 gate returned the in-flight promise
// unconditionally, so `login("bob")` while `login("alice")` was in flight returned
// ALICE's promise — Bob was never attempted, yet the caller's promise resolved as
// if Bob had logged in. A false-positive for a DIFFERENT identity.
//
// THE FIX: track the in-flight WebID alongside the in-flight promise and decide:
//   - nothing in flight   → "start"
//   - SAME WebID          → "share"  (double-click / StrictMode remount → one login)
//   - DIFFERENT WebID     → "reject" (no overlapping probe; do not resolve as the
//                                     other identity)
//
// SessionProvider can't be cheaply mounted in this no-browser harness (it depends on
// the @solid/reactive-authentication custom element + a page-lifetime singleton), so
// the gate decision is factored into a tiny PURE helper, `decideSingleFlight`, and
// pinned here. SessionProvider.login() consumes exactly this decision, so testing the
// pure function pins the observable behaviour the finding requires.
import { describe, expect, it } from "vitest";
import { decideSingleFlight } from "./single-flight";
import { webIdsEqual } from "./webid-token-provider";

const WEBID_A = "https://alice.example/profile/card#me";
const WEBID_B = "https://bob.example/profile/card#me";

describe("decideSingleFlight — WebID-scoped single-flight gate (finding 1)", () => {
  it("starts a new login when nothing is in flight", () => {
    expect(decideSingleFlight(null, WEBID_A, webIdsEqual)).toBe("start");
  });

  it("SHARES the in-flight login for the SAME WebID (double-click / StrictMode remount)", () => {
    expect(decideSingleFlight(WEBID_A, WEBID_A, webIdsEqual)).toBe("share");
  });

  it("shares the in-flight login for a trivially-normalised SAME WebID (case-insensitive host)", () => {
    // webIdsEqual normalises scheme/host case — a double-click that re-types the host
    // in a different case is still the SAME identity and must share, not reject.
    expect(decideSingleFlight("https://alice.example/profile/card#me", WEBID_A, webIdsEqual)).toBe(
      "share",
    );
    expect(decideSingleFlight(WEBID_A, "https://Alice.Example/profile/card#me", webIdsEqual)).toBe(
      "share",
    );
  });

  it("REJECTS a concurrent login for a DIFFERENT WebID — never resolves as the wrong identity (CORE finding-1 regression)", () => {
    // The bug: returning the in-flight (Alice) promise for a Bob login resolved as if
    // Bob logged in. The gate must REJECT instead — Bob was never attempted.
    expect(decideSingleFlight(WEBID_A, WEBID_B, webIdsEqual)).toBe("reject");
    expect(decideSingleFlight(WEBID_B, WEBID_A, webIdsEqual)).toBe("reject");
  });

  it("rejects a different-path/fragment WebID on the same host (strict identity)", () => {
    // webIdsEqual is strict on path/fragment, so a different WebID document on the
    // same host is a DIFFERENT identity and must reject.
    expect(decideSingleFlight(WEBID_A, "https://alice.example/other/card#me", webIdsEqual)).toBe(
      "reject",
    );
    expect(decideSingleFlight(WEBID_A, "https://alice.example/profile/card#you", webIdsEqual)).toBe(
      "reject",
    );
  });
});
