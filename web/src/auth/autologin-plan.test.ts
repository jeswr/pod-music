// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Tests for the PURE autologin decision (planAutologin) + the pure URL helpers the
// SessionProvider effect uses. These cover the three security-critical scenarios the
// feature brief requires WITHOUT a DOM / React test env (the host ships none, and
// adding one is gated):
//   (a) opening with `#autologin/<encoded-webid>` and no session → BEGIN a redirect
//       login for that decoded WebID;
//   (b) a stored/active session takes precedence → autologin is NOT begun;
//   (c) a bounced-back-still-unauthenticated autologin does NOT loop → with the
//       sentinel already set, a repeat `#autologin` falls through (clear-sentinel),
//       NOT a re-begin.
import { describe, expect, it } from "vitest";
import { type AutologinInputs, planAutologin } from "./autologin-plan";
import {
  cleanedUrl,
  hasAuthCodeParams,
  hasAuthErrorParams,
  parseAutologinFragment,
} from "./SessionProvider";
import { webIdsEqual } from "./webid-token-provider";

const WEBID = "https://alice.solid-test.jeswr.org/profile/card#me";
const WEBID_B = "https://bob.solid-test.jeswr.org/profile/card#me";
const ENCODED = encodeURIComponent(WEBID);

/** A baseline "ready, not logged in, fresh page, nothing pending/seen" input. */
function base(overrides: Partial<AutologinInputs> = {}): AutologinInputs {
  return {
    ready: true,
    hasProvider: true,
    loggedIn: false,
    effectAlreadyRan: false,
    hasPendingRedirect: false,
    pendingRedirectWebId: null,
    hasCodeParams: false,
    hasErrorParams: false,
    fragmentWebId: null,
    sentinel: null,
    // Use the SAME equality the SessionProvider injects, so the test pins the exact
    // comparison the production code runs (mirrors decideSingleFlight's pattern).
    webIdsEqual,
    ...overrides,
  };
}

describe("parseAutologinFragment", () => {
  it("decodes the WebID from a #autologin/<encoded> deep-link", () => {
    expect(parseAutologinFragment(`#autologin/${ENCODED}`)).toBe(WEBID);
  });

  it("returns null for a non-autologin hash, an empty payload, or bad encoding", () => {
    expect(parseAutologinFragment("")).toBeNull();
    expect(parseAutologinFragment("#documents")).toBeNull();
    expect(parseAutologinFragment("#autologin/")).toBeNull();
    // A lone `%` is invalid percent-encoding → decodeURIComponent throws → null.
    expect(parseAutologinFragment("#autologin/%")).toBeNull();
  });
});

describe("hasAuthCodeParams", () => {
  it("is true only when BOTH code and state are present", () => {
    expect(hasAuthCodeParams("?code=abc&state=xyz")).toBe(true);
    expect(hasAuthCodeParams("?code=abc")).toBe(false);
    expect(hasAuthCodeParams("?state=xyz")).toBe(false);
    expect(hasAuthCodeParams("")).toBe(false);
  });
});

describe("hasAuthErrorParams", () => {
  it("is true only when BOTH error and state are present", () => {
    expect(hasAuthErrorParams("?error=login_required&state=xyz")).toBe(true);
    expect(hasAuthErrorParams("?error=access_denied&state=xyz")).toBe(true);
    // error without state is NOT a redirect return (could be an unrelated query).
    expect(hasAuthErrorParams("?error=login_required")).toBe(false);
    expect(hasAuthErrorParams("?state=xyz")).toBe(false);
    expect(hasAuthErrorParams("")).toBe(false);
  });

  it("does not conflate a success return (code&state) with an error return", () => {
    expect(hasAuthErrorParams("?code=abc&state=xyz")).toBe(false);
  });
});

describe("cleanedUrl", () => {
  it("strips BOTH the query and the fragment, keeping the path", () => {
    expect(cleanedUrl("https://app.example/?code=abc&state=xyz")).toBe("https://app.example/");
    expect(cleanedUrl(`https://app.example/#autologin/${ENCODED}`)).toBe("https://app.example/");
    expect(cleanedUrl("https://app.example/docs?x=1#frag")).toBe("https://app.example/docs");
  });
});

describe("planAutologin — guards", () => {
  it("does nothing until the runtime is ready / the provider exists", () => {
    expect(planAutologin(base({ ready: false, fragmentWebId: WEBID })).kind).toBe("none");
    expect(planAutologin(base({ hasProvider: false, fragmentWebId: WEBID })).kind).toBe("none");
  });

  it("does nothing once the once-guard has fired (StrictMode double-mount)", () => {
    expect(planAutologin(base({ effectAlreadyRan: true, fragmentWebId: WEBID })).kind).toBe("none");
  });
});

describe("planAutologin — (a) fresh #autologin deep-link begins a redirect login", () => {
  it("BEGINS a redirect login for the decoded WebID when not logged in + nothing pending", () => {
    const action = planAutologin(base({ fragmentWebId: WEBID }));
    expect(action).toEqual({ kind: "begin", webId: WEBID });
  });
});

describe("planAutologin — (b) a stored/active session takes precedence", () => {
  it("does NOT begin autologin when already logged in, even with a deep-link fragment", () => {
    const action = planAutologin(base({ loggedIn: true, fragmentWebId: WEBID }));
    expect(action.kind).toBe("none");
  });

  it("does NOT complete a returning redirect when already logged in", () => {
    const action = planAutologin(
      base({
        loggedIn: true,
        hasPendingRedirect: true,
        pendingRedirectWebId: WEBID,
        hasCodeParams: true,
      }),
    );
    expect(action.kind).toBe("none");
  });
});

describe("planAutologin — (c) a bounced-back autologin does NOT loop", () => {
  it("with the sentinel set for the SAME WebID, a repeat #autologin falls through to clear-sentinel (no re-begin)", () => {
    const action = planAutologin(base({ fragmentWebId: WEBID, sentinel: WEBID }));
    // NOT a re-begin — the loop guard. The effect clears the sentinel + URL and shows login.
    expect(action.kind).toBe("clear-sentinel");
    expect(action).not.toMatchObject({ kind: "begin" });
  });

  it("a clean (no-code, no-fragment) return after a bounce is inert (login screen)", () => {
    // The fragment was already cleaned before the redirect, so on a no-code bounce
    // there is no fragment and no pending record → nothing re-triggers.
    expect(planAutologin(base({ sentinel: WEBID })).kind).toBe("none");
  });
});

describe("planAutologin — (Finding 2) the loop guard is per-WebID, not blanket", () => {
  it("a #autologin for a DIFFERENT WebID than the sentinel BEGINS a fresh login (not swallowed)", () => {
    // The sentinel records a prior attempt for WEBID; a later deep-link in the SAME
    // tab for WEBID_B must start a fresh login for WEBID_B, not be cleared away.
    const action = planAutologin(base({ fragmentWebId: WEBID_B, sentinel: WEBID }));
    expect(action).toEqual({ kind: "begin", webId: WEBID_B });
  });

  it("a #autologin for the SAME WebID as the sentinel is still the loop guard (clear-sentinel)", () => {
    const action = planAutologin(base({ fragmentWebId: WEBID, sentinel: WEBID }));
    expect(action.kind).toBe("clear-sentinel");
  });

  it("normalisation-tolerant: a sentinel that differs only by host case is the SAME WebID (loop guard)", () => {
    // webIdsEqual lower-cases the host, so a case-variant sentinel still guards the loop.
    const upperHost = WEBID.replace("alice.solid-test", "alice.SOLID-test");
    const action = planAutologin(base({ fragmentWebId: WEBID, sentinel: upperHost }));
    expect(action.kind).toBe("clear-sentinel");
  });
});

describe("planAutologin — (Finding 1) an OAuth error redirect return is cleaned up", () => {
  it("ABORTS (abort-redirect) when a pending record returns with ?error&state", () => {
    const action = planAutologin(
      base({ hasPendingRedirect: true, pendingRedirectWebId: WEBID, hasErrorParams: true }),
    );
    // A dedicated abort action — the effect resets the provider (clearing the persisted
    // record + DPoP key), clears the sentinel, cleans the URL, and surfaces the error.
    expect(action).toEqual({ kind: "abort-redirect" });
  });

  it("a code return still COMPLETES even if an error param is somehow also present (code wins)", () => {
    // CASE A is evaluated before ABORT, so a code-bearing return is completed.
    const action = planAutologin(
      base({
        hasPendingRedirect: true,
        pendingRedirectWebId: WEBID,
        hasCodeParams: true,
        hasErrorParams: true,
      }),
    );
    expect(action).toEqual({ kind: "complete", webId: WEBID });
  });

  it("an error param with NO pending record does not abort (nothing to clean up) — inert", () => {
    expect(planAutologin(base({ hasErrorParams: true })).kind).toBe("none");
  });

  it("does NOT abort when already logged in (a session wins, like CASE A)", () => {
    const action = planAutologin(
      base({ loggedIn: true, hasPendingRedirect: true, hasErrorParams: true }),
    );
    expect(action.kind).toBe("none");
  });
});

describe("planAutologin — CASE A returning from the redirect", () => {
  it("COMPLETES the persisted login when a pending record + ?code&state are present", () => {
    const action = planAutologin(
      base({ hasPendingRedirect: true, pendingRedirectWebId: WEBID, hasCodeParams: true }),
    );
    expect(action).toEqual({ kind: "complete", webId: WEBID });
  });

  it("does NOT treat a fresh deep-link as CASE B while a redirect record is pending", () => {
    // A pending record means we are mid-redirect; a fragment must not start a SECOND
    // begin. Without ?code yet, the plan is inert (waiting for the code-bearing return).
    const action = planAutologin(base({ hasPendingRedirect: true, fragmentWebId: WEBID }));
    expect(action.kind).toBe("none");
  });
});
