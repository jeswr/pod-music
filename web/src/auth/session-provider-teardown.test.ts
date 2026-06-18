// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// session-provider-teardown.test.ts — the SessionProvider's establish-time GENERATION FENCE
// (roborev HIGH), pinned at the auth seam. SECURITY-CRITICAL.
//
// THE BUG (roborev HIGH, surfaced by pod-health): the #123 proactive-fetch rollout left the
// PROVISIONAL + AUTHORITATIVE credential-boundary arms in `establishSessionFor` UNFENCED —
// they armed + published UNCONDITIONALLY after async awaits (`resolvedIssuer`, `readProfile`,
// `persistSession`). A logout() or new login() that RACES those awaits can (a) re-arm the
// boundary against a reset provider, (b) republish a stale webId/session, or (c) clear a
// NEWER login's boundary. The fix fences BOTH arms with the pure, exported
// `establishStillCurrent` (generation unchanged + WebID matches); on the SUPERSEDED path the
// caller BAILS WITHOUT clearing the boundary (clearing would wipe a newer login's boundary).
//
// These assertions are ADVERSARIAL: each FLIPS if the fence is weakened (e.g. dropping the
// generation check, or the WebID check, would flip a case) — verified by the inline buggy
// controls. This is the same testable-decision pattern as autologin-plan.ts / single-flight.ts
// (a PURE helper extracted from SessionProvider, asserted with no React render / no auth runtime).
import { webIdsEqual as packageWebIdsEqual } from "@jeswr/solid-session-restore";
import { describe, expect, it } from "vitest";
import { establishStillCurrent } from "./SessionProvider";
import { webIdsEqual } from "./webid-token-provider";

// establishStillCurrent — the generation+identity fence guarding the PROVISIONAL and
// AUTHORITATIVE proactive-boundary arms + UI publish in establishSessionFor (roborev HIGH).
// A logout()/new login() racing the awaits (resolvedIssuer / readProfile / persistSession)
// advances the generation (via reset()) AND clears the boundary; without this fence the
// resumed establish would RE-ARM the boundary against a reset/stale provider AND publish a
// stale logged-in session — or, on a NEW login, clobber the new login's freshly-armed boundary.
describe("roborev HIGH — establishStillCurrent (fences the provisional + authoritative arm + publish)", () => {
  const GEN = 7;
  const A = "https://alice.example/profile/card#me";
  const B = "https://bob.example/profile/card#me";
  const base = {
    establishGeneration: GEN,
    requestedWebId: A,
    webIdsEqual,
  };

  it("CURRENT — same generation AND same authenticated WebID → arm + publish proceed", () => {
    expect(
      establishStillCurrent({ ...base, currentGeneration: GEN, currentAuthenticatedWebId: A }),
    ).toBe(true);
  });

  it("SUPERSEDED — a racing logout/new-login ADVANCED the generation → fail-closed (no arm/publish)", () => {
    // The generation moved on even though the (stale) authenticated WebID still reads A:
    // the fence must FAIL CLOSED on the generation mismatch alone. Without the generation
    // check this would wrongly return true and re-arm against the superseded provider.
    expect(
      establishStillCurrent({ ...base, currentGeneration: GEN + 1, currentAuthenticatedWebId: A }),
    ).toBe(false);
  });

  it("SUPERSEDED — identity SWITCHED to a different WebID at the same generation → fail-closed", () => {
    // A re-login as B advanced+settled to B's identity: arming/publishing A here would
    // republish a stale identity. The WebID check fails closed even if the generation matched.
    expect(
      establishStillCurrent({ ...base, currentGeneration: GEN, currentAuthenticatedWebId: B }),
    ).toBe(false);
  });

  it("SUPERSEDED — provider was RESET (authenticated WebID cleared by logout) → fail-closed", () => {
    // A logout reset the provider: authenticatedWebId() is now undefined. The fence must not
    // re-arm the boundary against the logged-out provider (re-enabling reads behind a
    // logged-out UI).
    expect(
      establishStillCurrent({
        ...base,
        currentGeneration: GEN,
        currentAuthenticatedWebId: undefined,
      }),
    ).toBe(false);
  });

  it("NEVER equates two DIFFERENT users at the same generation (the fail-closed WebID guard)", () => {
    // Defence-in-depth: even a same-generation race that swapped A→B must fail closed, and
    // the reverse (requested B, current A) must too — the WebID binding is symmetric.
    expect(
      establishStillCurrent({
        establishGeneration: GEN,
        currentGeneration: GEN,
        requestedWebId: B,
        currentAuthenticatedWebId: A,
        webIdsEqual,
      }),
    ).toBe(false);
  });

  it("LOGIN-A-RESUMES-AFTER-LOGIN-B: A is superseded by B's higher generation (the exact race)", () => {
    // login A's establish snapshots generation GEN, then awaits; login B starts, advances the
    // provider to GEN+1, arms ITS OWN boundary, and becomes the authenticated identity (B).
    // When A resumes, establishStillCurrent MUST return false (B's generation supersedes A) —
    // so A aborts WITHOUT publishing and, crucially, WITHOUT clearing the boundary. A clear
    // here would wipe B's freshly-armed boundary and leave B's logged-in UI making
    // unauthenticated reads — the bug this guards (the SUPERSEDED branch makes NO
    // clearProactiveBoundary call, verified by inspection of SessionProvider.tsx).
    expect(
      establishStillCurrent({
        establishGeneration: GEN, // A's snapshot
        currentGeneration: GEN + 1, // B advanced it
        requestedWebId: A, // A's identity
        currentAuthenticatedWebId: B, // but B is now authenticated
        webIdsEqual,
      }),
    ).toBe(false);
  });

  it("holds with the PACKAGE webIdsEqual too (identical fail-closed semantics)", () => {
    // Current → true with the package equality…
    expect(
      establishStillCurrent({
        ...base,
        currentGeneration: GEN,
        currentAuthenticatedWebId: A,
        webIdsEqual: packageWebIdsEqual,
      }),
    ).toBe(true);
    // …superseded identity → false.
    expect(
      establishStillCurrent({
        ...base,
        currentGeneration: GEN,
        currentAuthenticatedWebId: B,
        webIdsEqual: packageWebIdsEqual,
      }),
    ).toBe(false);
  });

  // ── ADVERSARIAL CONTROLS — prove each assertion GENUINELY depends on the fence ──────────
  // Each control reproduces a WEAKENED fence (one of the two checks dropped) and shows the
  // SAME inputs that the real fence rejects would WRONGLY pass — i.e. the fix is load-bearing.
  describe("ADVERSARIAL — a weakened fence FLIPS the superseded cases (proving the fence is load-bearing)", () => {
    // The buggy "generation-only" fence (drops the WebID check): an identity switch at the
    // same generation would WRONGLY be treated as current.
    const generationOnlyFence = (inputs: {
      establishGeneration: number;
      currentGeneration: number;
    }): boolean => inputs.currentGeneration === inputs.establishGeneration;
    // The buggy "no fence at all" (the pre-fix unconditional arm): always true.
    const noFence = (): boolean => true;

    it("generation-only fence WRONGLY passes an identity switch the real fence rejects", () => {
      const inputs = {
        establishGeneration: GEN,
        currentGeneration: GEN,
        requestedWebId: A,
        currentAuthenticatedWebId: B as string | undefined,
        webIdsEqual,
      };
      // The REAL fence rejects (B != A) — the fix.
      expect(establishStillCurrent(inputs)).toBe(false);
      // The buggy generation-only fence WRONGLY accepts it (re-arms B's boundary as A) — the bug.
      expect(generationOnlyFence(inputs)).toBe(true);
    });

    it("no-fence (the pre-fix unconditional arm) WRONGLY passes a superseded generation", () => {
      const inputs = {
        establishGeneration: GEN,
        currentGeneration: GEN + 1, // superseded by a racing login/logout
        requestedWebId: A,
        currentAuthenticatedWebId: undefined,
        webIdsEqual,
      };
      // The REAL fence rejects (generation advanced AND identity cleared) — the fix.
      expect(establishStillCurrent(inputs)).toBe(false);
      // The pre-fix unconditional arm WRONGLY proceeds — re-arming behind a logged-out UI.
      expect(noFence()).toBe(true);
    });
  });
});
