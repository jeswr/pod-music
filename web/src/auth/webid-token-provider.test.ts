// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * Regression test for the CROSS-USER SESSION LEAK (the HIGH roborev finding).
 *
 * The bug: `WebIdDPoPTokenProvider` caches the resolved issuer + the per-issuer
 * session (DPoP key + access token) + the authenticated-WebID claim in memory.
 * If logout only clears React state, a later login as a DIFFERENT WebID would
 * reuse the previous user's session, and a login-detection probe that merely
 * checks "is a token attached" would look authenticated with the STALE token.
 *
 * The fix has two halves, both pinned here:
 *  1. `reset()` drops EVERYTHING per-identity — issuer, sessions, the
 *     authenticated-WebID claim, and the running token-attach count — so nothing
 *     from a prior login can be reused by the next.
 *  2. the provider records the WebID the OP actually authenticated AS (the
 *     id_token `webid`/`sub` claim), exposed via `authenticatedWebId()`, and
 *     `webIdsEqual` is the strict comparison the login flow uses to confirm the
 *     authenticated identity matches the requested one — never inferring "logged
 *     in" purely from a token being attached.
 *
 * The full OAuth/DPoP/profile-fetch stack is mocked so this runs with no browser
 * and no network: we control exactly which WebID each authentication "returns".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the heavy auth dependencies so #authenticate is fully controllable. ---
// A module-level switch lets each test decide which WebID the next id_token
// authenticates AS, so we can simulate user A then a DIFFERENT user B.
const authState = { webId: "https://alice.example/profile/card#me", accessToken: "tok-A" };

vi.mock("@jeswr/fetch-rdf", () => ({
  // Issuer resolution dereferences the WebID profile; the dataset content is
  // irrelevant because resolveIssuers is mocked below.
  fetchRdf: vi.fn(async () => ({ dataset: new Set() })),
}));

vi.mock("./login-ux", () => ({
  validateWebId: (s: string) => s,
  // One issuer for every WebID — keeps issuer resolution deterministic.
  resolveIssuers: () => ["https://issuer.example/"],
}));

// Test fixtures for the `dpop` mock, in a `vi.hoisted` holder so they are
// initialised BEFORE the hoisted `vi.mock("dpop")` factory's closure runs — a plain
// top-level `const`/`let` is hoisted AFTER the mock factory by Vitest, so the
// factory could reference them in their temporal dead zone. Fields:
//  - `calls`: the args every `DPoP.generateProof` call receives, so a test can
//    assert the `htu` (arg 2) the provider mints — the round-4c regression hinges
//    on it.
//  - `gate`: an OPTIONAL deferred the round-4d reset-during-proof test installs to
//    PARK the awaited `DPoP.generateProof()` mid-flight (so a reset() can race the
//    proof await). Null = resolve immediately (every prior test is unaffected).
//  - `onEnter`: an OPTIONAL callback that fires the instant the proof mock is
//    ENTERED, so the test deterministically observes the flow is parked at the await
//    BEFORE it fires reset() — not relying on a fixed number of microtask ticks (the
//    mocked oauth flow has several real awaits before the proof await).
// `gate`/`onEnter` are reset to null in `beforeEach` so they never leak between tests.
const dpopMock = vi.hoisted(() => ({
  calls: [] as unknown[][],
  gate: null as Promise<void> | null,
  onEnter: null as (() => void) | null,
}));
vi.mock("dpop", () => ({
  generateProof: vi.fn(async (...args: unknown[]) => {
    dpopMock.calls.push(args);
    dpopMock.onEnter?.();
    if (dpopMock.gate) await dpopMock.gate;
    return "dpop-proof";
  }),
}));

vi.mock("oauth4webapi", () => {
  const allowInsecureRequests = Symbol("allowInsecureRequests");
  return {
    allowInsecureRequests,
    None: () => () => {},
    ClientSecretBasic: () => () => {},
    expectNoNonce: Symbol("expectNoNonce"),
    nopkce: Symbol("nopkce"),
    DPoP: () => ({}),
    discoveryRequest: vi.fn(async () => ({})),
    processDiscoveryResponse: vi.fn(async () => ({
      issuer: "https://issuer.example/",
      authorization_endpoint: "https://issuer.example/auth",
      token_endpoint: "https://issuer.example/token",
      code_challenge_methods_supported: ["S256"],
    })),
    dynamicClientRegistrationRequest: vi.fn(),
    processDynamicClientRegistrationResponse: vi.fn(),
    generateKeyPair: vi.fn(async () => ({ publicKey: {}, privateKey: {} })),
    generateRandomCodeVerifier: () => "verifier",
    generateRandomNonce: () => "nonce",
    generateRandomState: () => "state",
    calculatePKCECodeChallenge: vi.fn(async () => "challenge"),
    validateAuthResponse: vi.fn(() => new URLSearchParams({ code: "auth-code" })),
    authorizationCodeGrantRequest: vi.fn(async () => ({})),
    // The token response carries the access token for the CURRENT authState.
    processAuthorizationCodeResponse: vi.fn(async () => ({
      access_token: authState.accessToken,
    })),
    // The id_token claims pin the WebID the OP vouched for.
    getValidatedIdTokenClaims: vi.fn(() => ({
      iss: "https://issuer.example/",
      sub: authState.webId,
      webid: authState.webId,
      aud: "client",
      iat: 0,
      exp: 0,
    })),
    AuthorizationResponseError: class extends Error {},
  };
});

// Import AFTER the mocks are registered.
const { WebIdDPoPTokenProvider, webIdsEqual, ReactiveAuthResetError, withProbeFragment, httpUri } =
  await import("./webid-token-provider");

const WEBID_A = "https://alice.example/profile/card#me";
const WEBID_B = "https://bob.example/profile/card#me";

const REDIRECT = "https://app.example/callback.html?code=auth-code&state=state";

/** Build a provider whose getWebId returns the WebID currently in `authState`. */
function makeProvider(
  getCode: (uri: URL, signal: AbortSignal) => Promise<string> = async () => REDIRECT,
) {
  return new WebIdDPoPTokenProvider(
    "https://app.example/callback.html",
    // getCode — the popup; returns a redirect URL with the auth code.
    getCode,
    // getWebId — hand back whichever WebID the current attempt is for.
    async () => authState.webId,
    { clientId: "https://app.example/clientid.jsonld" },
  );
}

/** A deferred whose `getCode` resolves only when the test calls `release()`. */
function deferredGetCode() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const getCode = async () => {
    await gate;
    return REDIRECT;
  };
  return { getCode, release };
}

/** A provider that exposes the round-4 login-probe API used by these tests. */
type ProbeProvider = InstanceType<typeof WebIdDPoPTokenProvider>;

/**
 * Register a login probe Request on the provider via the round-4 API
 * (`beginLoginProbe`) — NOT a network header (the round-3 CORS fix is preserved),
 * and NOT a free-floating module registry (the round-4 fix moves the record ONTO
 * the provider so reset() clears it). The proof travels in process memory only, so
 * the returned Request carries NO app-custom header.
 *
 * ROUND-4B (finding 2): the probe URL carries a unique unguessable `#probe-<uuid>`
 * fragment via `withProbeFragment` — exactly as the login flow builds it — so the
 * provider's URL fallback recognises THIS exact probe and not a plain same-base-URL
 * data fetch. Returns the request, the provider's generation snapshot, and the FULL
 * fragment-bearing url the login flow would compare against.
 */
function beginProbe(
  provider: ProbeProvider,
  baseUrl: string,
): { req: Request; generation: number; url: string } {
  const generation = provider.loginGeneration();
  const url = withProbeFragment(baseUrl);
  const req = new Request(url);
  provider.beginLoginProbe(req);
  return { req, generation, url };
}

/**
 * Re-wrap a Request exactly as `ReactiveFetchManager.#fetch` does
 * (`new Request(input, init)`) before it calls `provider.upgrade(request)`. This
 * produces a DIFFERENT object than the one the login flow registered, so it proves
 * the side channel survives the manager's re-wrap (object identity is lost; the
 * single-use fragment-URL channel — the `#probe-<uuid>` is PRESERVED on `.url` by
 * `new Request(input)` — carries the proof across).
 */
function asManagerWraps(req: Request): Request {
  return new Request(req);
}

describe("webIdsEqual", () => {
  it("treats identical WebIDs as equal", () => {
    expect(webIdsEqual(WEBID_A, WEBID_A)).toBe(true);
  });

  it("is case-insensitive on scheme + host only, strict on path/fragment", () => {
    expect(
      webIdsEqual("https://Alice.Example/profile/card#me", "https://alice.example/profile/card#me"),
    ).toBe(true);
    // Different fragment = different identity.
    expect(
      webIdsEqual(
        "https://alice.example/profile/card#me",
        "https://alice.example/profile/card#you",
      ),
    ).toBe(false);
    // Different path = different identity.
    expect(webIdsEqual(WEBID_A, "https://alice.example/other/card#me")).toBe(false);
  });

  it("fails closed for a missing or unparseable WebID", () => {
    expect(webIdsEqual(undefined, WEBID_A)).toBe(false);
    expect(webIdsEqual(WEBID_A, undefined)).toBe(false);
    expect(webIdsEqual("not a url", WEBID_A)).toBe(false);
  });

  it("never equates two DIFFERENT users' WebIDs", () => {
    expect(webIdsEqual(WEBID_A, WEBID_B)).toBe(false);
  });
});

describe("WebIdDPoPTokenProvider — no prior identity survives reset / re-login", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
  });

  it("records the WebID + token the session authenticated AS, and counts the attach", async () => {
    const provider = makeProvider();
    expect(provider.authenticatedWebId()).toBeUndefined();
    expect(provider.tokensAttachedCount()).toBe(0);

    const req = await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(provider.authenticatedWebId()).toBe(WEBID_A);
    expect(provider.tokensAttachedCount()).toBe(1);
    // The minted token (A's) is what got attached.
    expect(req.headers.get("Authorization")).toBe("DPoP tok-A");
  });

  it("reset() drops the cached issuer, session, authenticated WebID and attach count", async () => {
    const provider = makeProvider();
    await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(provider.authenticatedWebId()).toBe(WEBID_A);
    expect(provider.tokensAttachedCount()).toBe(1);

    provider.reset();

    // Nothing from A's identity may survive the reset.
    expect(provider.authenticatedWebId()).toBeUndefined();
    expect(provider.tokensAttachedCount()).toBe(0);
  });

  it("after logout (reset) a login as WebID-B never surfaces WebID-A's session or token", async () => {
    const provider = makeProvider();

    // --- User A logs in. ---
    const reqA = await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(provider.authenticatedWebId()).toBe(WEBID_A);
    expect(reqA.headers.get("Authorization")).toBe("DPoP tok-A");

    // --- Logout: the provider is reset (the Finding-1 fix). ---
    provider.reset();

    // --- A DIFFERENT user, B, logs in on the same provider instance. ---
    authState.webId = WEBID_B;
    authState.accessToken = "tok-B";
    const reqB = await provider.upgrade(new Request("https://bob.example/storage/"));

    // The provider must now report B's identity + B's token — never A's.
    expect(provider.authenticatedWebId()).toBe(WEBID_B);
    expect(provider.authenticatedWebId()).not.toBe(WEBID_A);
    expect(reqB.headers.get("Authorization")).toBe("DPoP tok-B");
    // The login flow's gate: B's authenticated WebID matches the requested B,
    // and does NOT match A.
    expect(webIdsEqual(provider.authenticatedWebId(), WEBID_B)).toBe(true);
    expect(webIdsEqual(provider.authenticatedWebId(), WEBID_A)).toBe(false);
  });

  it("WITHOUT reset, a stale issuer cache would pin the first identity (proves reset is load-bearing)", async () => {
    const provider = makeProvider();
    await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(provider.authenticatedWebId()).toBe(WEBID_A);

    // Switch the would-be user to B but DO NOT reset: the memoised issuer +
    // cached session are still A's, so the provider keeps reporting A. This is
    // exactly the leak reset() prevents — asserting it here documents why the
    // logout/new-login reset is mandatory, not cosmetic.
    authState.webId = WEBID_B;
    authState.accessToken = "tok-B";
    const reqStale = await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(provider.authenticatedWebId()).toBe(WEBID_A); // leaked without reset
    expect(reqStale.headers.get("Authorization")).toBe("DPoP tok-A"); // A's token reused
  });
});

describe("FIX 2 — reset() fences in-flight auth work (no contamination after logout/re-login)", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
    dpopMock.gate = null; // no proof gate unless a test installs one (round-4d).
    dpopMock.onEnter = null;
  });

  it("an upgrade() that resolves AFTER reset() writes NO provider state and is discarded", async () => {
    // Stall the popup so user A's upgrade is in flight when logout/reset fires.
    const { getCode, release } = deferredGetCode();
    const provider = makeProvider(getCode);

    const inflight = provider.upgrade(new Request("https://alice.example/storage/"));
    // Let the flow reach the (stalled) getCode, then log out mid-flight.
    await Promise.resolve();
    provider.reset();
    expect(provider.authenticatedWebId()).toBeUndefined();
    expect(provider.tokensAttachedCount()).toBe(0);

    // Now let A's stalled flow complete — it must NOT write any state.
    release();
    await expect(inflight).rejects.toBeInstanceOf(ReactiveAuthResetError);

    // The superseded upgrade contaminated nothing: clean baseline survives.
    expect(provider.authenticatedWebId()).toBeUndefined();
    expect(provider.tokensAttachedCount()).toBe(0);
  });

  it("after a fenced in-flight upgrade, a fresh login as B reports ONLY B (no A residue)", async () => {
    // A's popup is stalled, so A's upgrade is in flight when logout fires.
    const { getCode: getCodeA, release: releaseA } = deferredGetCode();
    const provider = makeProvider(getCodeA);
    const inflightA = provider.upgrade(new Request("https://alice.example/storage/"));
    await Promise.resolve();

    // Logout (reset) fences A, then user B is the new identity.
    provider.reset();
    authState.webId = WEBID_B;
    authState.accessToken = "tok-B";

    // Release A's stalled flow — it must reject as superseded, writing nothing.
    releaseA();
    await expect(inflightA).rejects.toBeInstanceOf(ReactiveAuthResetError);

    // B logs in on the same provider (the gate is now open, so B's flow completes).
    const { req: reqBProbe, generation: genB } = beginProbe(
      provider,
      "https://bob.example/storage/",
    );
    const reqB = await provider.upgrade(reqBProbe);
    expect(provider.authenticatedWebId()).toBe(WEBID_B);
    expect(provider.authenticatedWebId()).not.toBe(WEBID_A);
    expect(reqB.headers.get("Authorization")).toBe("DPoP tok-B");
    // A's fenced attempt left no probe-upgrade record; only B's probe is recorded
    // (in B's generation — A's reset() advanced the generation past A's window).
    expect(provider.wasLoginProbeUpgraded(genB)).toBe(true);
  });

  it("round-4d — a reset() racing DURING the DPoP proof await writes NO state and rejects", async () => {
    // The round-4d HIGH: the generation fence ran BEFORE `await DPoP.generateProof()`,
    // so a reset() (logout / new login) firing DURING the proof await let the stale
    // upgrade resume and mutate provider state — set #authenticatedWebId, attach the
    // OLD token, bump #tokensAttached, and record #probeUpgradedGeneration for the
    // SUPERSEDED generation. The fix re-fences AFTER the proof await, before any state
    // write. Model: the proof await is PARKED via dpopGate, reset() fires while it is
    // parked, then the gate is released and the upgrade must reject + leave clean state.
    let releaseProof!: () => void;
    dpopMock.gate = new Promise<void>((resolve) => {
      releaseProof = resolve;
    });
    // Resolves the INSTANT generateProof is entered, so we fire reset() only once the
    // flow is provably parked at the proof await — deterministic, not tick-counting.
    let proofEntered!: () => void;
    const dpopEntered = new Promise<void>((resolve) => {
      proofEntered = resolve;
    });
    dpopMock.onEnter = proofEntered;

    const provider = makeProvider();
    // A login probe (with the unguessable fragment) — its upgrade must NOT record a
    // probe proof for the captured (pre-reset) generation if a reset races the proof.
    const { req: probe, generation: gen } = beginProbe(provider, "https://alice.example/storage/");

    // Kick off the upgrade. Issuer resolution + login resolve immediately (no getCode
    // gate); the flow then reaches the PARKED `DPoP.generateProof()` await.
    const inflight = provider.upgrade(probe);
    inflight.catch(() => {}); // pre-attach so the rejection is never "unhandled".
    // Wait until the proof mock is ENTERED — the upgrade is now parked at the await,
    // PAST the pre-await fence, which is exactly the window the round-4d bug needs.
    await dpopEntered;

    // Logout / new login fires WHILE the proof await is parked.
    provider.reset();
    // Mid-flight clean: the parked upgrade has written nothing yet.
    expect(provider.tokensAttachedCount()).toBe(0);
    expect(provider.authenticatedWebId()).toBeUndefined();

    // Release the parked proof — the (now superseded) upgrade resumes past the await
    // and MUST hit the post-await re-fence, rejecting and writing nothing.
    releaseProof();
    await expect(inflight).rejects.toBeInstanceOf(ReactiveAuthResetError);

    // Post-resolution clean: no token attached, no identity published, and the
    // (pre-reset) generation recorded NO probe upgrade — a stale upgrade records nothing.
    expect(provider.tokensAttachedCount()).toBe(0);
    expect(provider.authenticatedWebId()).toBeUndefined();
    expect(provider.wasLoginProbeUpgraded(gen)).toBe(false);
  });
});

describe("FIX 2 (round 3) — a STALE issuer rejection after reset() must not clear the NEW generation's #issuer", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
  });

  it("a superseded issuer resolution rejecting late leaves the current generation's single-flight intact", async () => {
    // Drive issuer resolution timing via a controllable getWebId. The FIRST
    // resolution (generation 0) is stalled, then rejected — but only AFTER reset()
    // advanced the generation and a SECOND resolution (generation 1) is in flight.
    // The stale rejection must NOT clear #issuer, or the current generation loses
    // single-flight and the in-flight (and later) upgrades re-prompt / fail.
    let calls = 0;
    let releaseFirst!: () => void;
    let rejectFirst!: (e: Error) => void;
    const firstGate = new Promise<void>((resolve, reject) => {
      releaseFirst = () => resolve();
      rejectFirst = (e) => reject(e);
    });
    const getWebId = async () => {
      calls += 1;
      if (calls === 1) {
        // The first (soon-to-be-superseded) resolution stalls here until the test
        // decides to reject it.
        await firstGate;
        return WEBID_A;
      }
      // The second resolution (after reset) succeeds immediately.
      return WEBID_B;
    };
    const provider = new WebIdDPoPTokenProvider(
      "https://app.example/callback.html",
      async () => REDIRECT,
      getWebId,
      { clientId: "https://app.example/clientid.jsonld" },
    );

    // Generation 0: kick off the first upgrade; its issuer resolution stalls in
    // getWebId. Swallow its eventual rejection so it doesn't surface as unhandled.
    const firstUpgrade = provider.upgrade(new Request("https://alice.example/storage/"));
    firstUpgrade.catch(() => {});
    await Promise.resolve();

    // reset() → generation 1. The stalled first resolution is now superseded.
    provider.reset();

    // Generation 1: a fresh upgrade kicks off a SECOND issuer resolution (calls===2)
    // which succeeds and establishes B's session. Run it to completion.
    authState.webId = WEBID_B;
    authState.accessToken = "tok-B";
    const secondReq = await provider.upgrade(new Request("https://bob.example/storage/"));
    expect(provider.authenticatedWebId()).toBe(WEBID_B);
    expect(secondReq.headers.get("Authorization")).toBe("DPoP tok-B");

    // NOW reject the stale first resolution. Its catch must NOT clear #issuer,
    // because the generation advanced AND #issuer is no longer its promise.
    rejectFirst(new Error("stale issuer resolution aborted"));
    await firstUpgrade.catch(() => {}); // let the rejection propagate + run the catch
    await Promise.resolve();

    // The current generation's single-flight is intact: a further upgrade reuses
    // B's issuer/session WITHOUT a third issuer resolution (getWebId not called
    // again — calls stays at 2). If the stale catch had cleared #issuer, this
    // upgrade would re-resolve (calls === 3).
    const callsBefore = calls;
    const thirdReq = await provider.upgrade(new Request("https://bob.example/other/"));
    expect(calls).toBe(callsBefore); // no re-resolution — #issuer survived
    expect(provider.authenticatedWebId()).toBe(WEBID_B);
    expect(thirdReq.headers.get("Authorization")).toBe("DPoP tok-B");
    // Tidy: release the (already-rejected) gate's resolve path harmlessly.
    releaseFirst();
  });
});

describe("FIX 3 (round 4) — login proof is a GENERATION-SCOPED per-login probe, not a provider-wide counter", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
  });

  it("records the upgraded probe in THIS login's generation, and only that generation", async () => {
    const provider = makeProvider();
    const { req, generation } = beginProbe(provider, "https://alice.example/storage/");
    const upgraded = await provider.upgrade(req);
    expect(upgraded.headers.get("Authorization")).toBe("DPoP tok-A");
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
    // A DIFFERENT generation (e.g. another login attempt's snapshot) is NOT satisfied.
    expect(provider.wasLoginProbeUpgraded(generation + 1)).toBe(false);
    expect(provider.wasLoginProbeUpgraded(generation - 1)).toBe(false);
  });

  it("a concurrent same-WebID NON-probe upgrade does NOT make a non-upgraded probe look logged in (finding a)", async () => {
    const provider = makeProvider();
    const generation = provider.loginGeneration();

    // Our login's OWN probe targets the storage ROOT (imagine it gets a public 200,
    // so its own upgrade never runs). Register it but do NOT upgrade it.
    const probe = new Request("https://alice.example/storage/");
    provider.beginLoginProbe(probe);

    // Meanwhile a concurrent upgraded request for the SAME WebID — e.g. a data-layer
    // read to a DIFFERENT url — bumps the provider-wide attach count. It is NOT the
    // probe (different object AND different url), so it must not set the proof.
    const before = provider.tokensAttachedCount();
    await provider.upgrade(new Request("https://alice.example/data/doc"));
    const after = provider.tokensAttachedCount();
    expect(after).toBeGreaterThan(before); // the provider-wide counter DID advance

    // The generation-scoped per-probe proof must be FALSE even though the provider-
    // wide count moved — this is the spurious-pass the generation scope closes.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(false);
  });

  it("the fragment-URL match is FIRST-WINS + single-use within the generation (finding a, single-use defence-in-depth)", async () => {
    // The round-3 weakness: the proof was keyed only on URL via a free-floating
    // module Map, so a stray same-URL upgrade could mis-attribute or double-fire.
    // Round-4 binds the match to a SINGLE per-login record on the provider, single-
    // use within the generation; round-4b makes the matched URL carry an unguessable
    // fragment so it cannot be forged at all. This test pins the single-use property
    // (kept as defence-in-depth): the FIRST upgrade to the EXACT fragment-URL sets
    // the proof; a SECOND to the same fragment-URL does NOT re-fire or extend it.
    const provider = makeProvider();
    const { url, generation } = beginProbe(provider, "https://alice.example/storage/");

    // First upgrade to the EXACT fragment-URL (a different object, modelling the
    // manager's re-wrap) consumes the single-use latch and sets the proof.
    await provider.upgrade(new Request(url));
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);

    // A LATER upgrade to the same fragment-URL must NOT find the probe again
    // (single-use). The proof stays scoped to this one generation.
    await provider.upgrade(new Request(url));
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
    expect(provider.wasLoginProbeUpgraded(generation + 1)).toBe(false);
  });

  it("reset() clears the per-login probe record AND the upgrade proof", async () => {
    const provider = makeProvider();
    const { req, generation } = beginProbe(provider, "https://alice.example/storage/");
    await provider.upgrade(req);
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
    provider.reset();
    // The proof is cleared, and the generation has advanced past the probe's window.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(false);
    // A stale probe registered before reset() can never satisfy a later upgrade: a
    // post-reset same-url upgrade does not re-acquire it (the probe's generation no
    // longer equals the current generation).
    await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(false);
    expect(provider.wasLoginProbeUpgraded(provider.loginGeneration())).toBe(false);
  });
});

describe("FIX (round 4) — probe proof is an in-process side channel, NOT a network header (CORS)", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
  });

  it("the probe Request carries NO app-custom header (no x-reactive-auth-probe-id, nothing non-standard)", () => {
    // The CORS bug: a custom request header makes a cross-origin request
    // non-"simple" → preflight → pod rejection. The fix must put NOTHING
    // app-specific on the wire. Assert the registered probe Request has no headers
    // at all (the proof lives only in the provider's in-process record).
    const provider = makeProvider();
    const { req } = beginProbe(provider, "https://alice.example/storage/");
    const headerNames = [...req.headers.keys()];
    expect(headerNames).not.toContain("x-reactive-auth-probe-id");
    // Defensive: the probe sets no app-custom header whatsoever.
    expect(headerNames).toEqual([]);
  });

  it("the UPGRADED probe request carries only standard Authorization/DPoP — no probe header", async () => {
    const provider = makeProvider();
    const { req } = beginProbe(provider, "https://alice.example/storage/");
    const upgraded = await provider.upgrade(req);
    // The upgraded request carries the standard auth headers — and NO probe header.
    expect(upgraded.headers.get("Authorization")).toBe("DPoP tok-A");
    expect(upgraded.headers.get("DPoP")).toBe("dpop-proof");
    expect(upgraded.headers.get("x-reactive-auth-probe-id")).toBeNull();
    const upgradedNames = [...upgraded.headers.keys()].sort();
    expect(upgradedNames).toEqual(["authorization", "dpop"]);
  });

  it("resolves true via object identity when the SAME object reaches upgrade()", async () => {
    const provider = makeProvider();
    const { req, generation } = beginProbe(provider, "https://alice.example/storage/");
    const upgraded = await provider.upgrade(req);
    expect(upgraded.headers.get("Authorization")).toBe("DPoP tok-A");
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
  });

  it("survives the manager re-wrap: a new Request(input) copy PRESERVES the probe fragment so the URL fallback still matches", async () => {
    // ReactiveFetchManager does `new Request(input, init)` before calling upgrade(),
    // so the object the provider receives is NOT the one we registered (identity is
    // lost; a symbol/expando does not survive the copy). The fragment-URL channel
    // must carry the proof across this re-wrap — `new Request(probeReqWithFragment)`
    // PRESERVES the `#probe-<uuid>` fragment on `.url` — otherwise login detection
    // silently always reads "not upgraded".
    const provider = makeProvider();
    const {
      req: registered,
      generation,
      url,
    } = beginProbe(provider, "https://alice.example/storage/");
    const wrapped = asManagerWraps(registered);
    expect(wrapped).not.toBe(registered); // a different object, as the manager makes
    expect(wrapped.url).toBe(url); // ...but the fragment survived the re-wrap.
    expect(wrapped.url).toContain("#probe-");
    const upgraded = await provider.upgrade(wrapped);
    expect(upgraded.headers.get("Authorization")).toBe("DPoP tok-A");
    // Proven via the fragment-URL fallback, since object identity was lost across the wrap.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
  });

  it("the URL channel is SINGLE-USE: a later same-URL request does NOT inherit the probe", async () => {
    const provider = makeProvider();
    const { req: registered, generation } = beginProbe(provider, "https://alice.example/storage/");
    // First upgrade (the manager's wrapped copy) consumes the URL latch.
    await provider.upgrade(asManagerWraps(registered));
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);

    provider.endLoginProbe(); // the login flow's finally — the active probe is dropped.

    // A later request to the SAME URL (a different object, no registration) must NOT
    // re-acquire the consumed probe — and there is no active probe anyway.
    const after = await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(after.headers.get("Authorization")).toBe("DPoP tok-A"); // still upgrades, just not as a probe
    // The proof for the original generation is unchanged (true) but a NEW generation
    // snapshot is not satisfied.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
    expect(provider.wasLoginProbeUpgraded(generation + 1)).toBe(false);
  });

  it("endLoginProbe drops the active probe so no later request inherits it", async () => {
    const provider = makeProvider();
    const generation = provider.loginGeneration();
    const probe = new Request("https://alice.example/storage/");
    provider.beginLoginProbe(probe);
    // Simulate a public 200: the probe never reached upgrade(); the login flow then
    // ends the probe in its finally.
    provider.endLoginProbe();

    // A later upgrade of the same URL must not pick up the dropped probe.
    await provider.upgrade(new Request("https://alice.example/storage/"));
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(false);
  });
});

describe("FIX (round 4b) — the URL fallback is UNFORGEABLE via an unguessable probe fragment (finding 2)", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
  });

  it("withProbeFragment appends a unique off-the-wire #probe-<uuid> fragment", () => {
    const a = withProbeFragment("https://alice.example/storage/");
    const b = withProbeFragment("https://alice.example/storage/");
    // Same base, but each call produces a DISTINCT unguessable fragment.
    expect(a).not.toBe(b);
    expect(new URL(a).hash).toMatch(/^#probe-[0-9a-f-]{36}$/);
    expect(new URL(b).hash).toMatch(/^#probe-[0-9a-f-]{36}$/);
    // The path/host/scheme (what the pod actually serves) is untouched.
    expect(new URL(a).origin).toBe("https://alice.example");
    expect(new URL(a).pathname).toBe("/storage/");
  });

  it("REPLACES any pre-existing fragment (defensive — a storage URL normally has none)", () => {
    const out = withProbeFragment("https://alice.example/storage/#stale");
    expect(new URL(out).hash).toMatch(/^#probe-[0-9a-f-]{36}$/);
    expect(new URL(out).hash).not.toBe("#stale");
  });

  it("a non-login upgrade to the SAME BASE URL with NO fragment does NOT satisfy the probe proof (CORE finding-2 regression)", async () => {
    // This is the exact attack the fragment closes: the round-4 bare-URL fallback
    // let the FIRST same-URL request in the generation (even a non-probe data fetch)
    // consume the proof. Now the probe URL carries an unguessable fragment, so a
    // plain `new Request(storageBase)` (NO fragment) produces a DIFFERENT `.url` and
    // can never match — even though it bumps the provider-wide attach count.
    const provider = makeProvider();
    const { generation } = beginProbe(provider, "https://alice.example/storage/");

    const before = provider.tokensAttachedCount();
    // A non-login data fetch to the SAME storage root, but WITHOUT the probe fragment.
    await provider.upgrade(new Request("https://alice.example/storage/"));
    const after = provider.tokensAttachedCount();
    expect(after).toBeGreaterThan(before); // the provider-wide counter moved...

    // ...yet the per-probe proof is NOT satisfied: the bare-URL request did not carry
    // the unguessable fragment, so it could not consume the proof. THIS is finding 2.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(false);
  });

  it("a non-login upgrade to the same base URL with a DIFFERENT/guessed fragment does NOT satisfy the proof", async () => {
    const provider = makeProvider();
    const { generation } = beginProbe(provider, "https://alice.example/storage/");

    // An attacker who knows the base URL but NOT the fragment guesses one.
    await provider.upgrade(new Request("https://alice.example/storage/#probe-guessed"));
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(false);

    // The empty-fragment form is also no match.
    await provider.upgrade(new Request("https://alice.example/storage/#"));
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(false);
  });

  it("only the EXACT fragment-URL the login flow built satisfies the proof (across the manager re-wrap)", async () => {
    const provider = makeProvider();
    const { req, generation, url } = beginProbe(provider, "https://alice.example/storage/");
    // The manager re-wraps the EXACT probe Request, preserving the fragment.
    const upgraded = await provider.upgrade(asManagerWraps(req));
    expect(upgraded.url).toBe(url); // exact fragment-URL carried across the wrap.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
  });

  it("the probe fragment is stripped on the wire — the upgraded request still carries NO app-custom header", async () => {
    // The fragment lives in the URL, not a header (RFC 3986 §3.5 — stripped before
    // the HTTP request), so the CORS-safety of round-2/3 is preserved.
    const provider = makeProvider();
    const { req } = beginProbe(provider, "https://alice.example/storage/");
    expect([...req.headers.keys()]).toEqual([]); // no header on the probe.
    const upgraded = await provider.upgrade(req);
    expect([...upgraded.headers.keys()].sort()).toEqual(["authorization", "dpop"]);
  });
});

describe("FIX (round 4c) — the DPoP htu strips the probe fragment (and query) — RFC 9449 §4.2", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
  });

  it("httpUri strips fragment AND query, leaving scheme/authority/path intact", () => {
    expect(httpUri("https://alice.example/storage/#probe-abc")).toBe(
      "https://alice.example/storage/",
    );
    expect(httpUri("https://alice.example/storage/?q=1")).toBe("https://alice.example/storage/");
    expect(httpUri("https://alice.example/storage/res?q=1&r=2#probe-xyz")).toBe(
      "https://alice.example/storage/res",
    );
    // A bare URL (no query/fragment) is returned unchanged (modulo URL normalisation).
    expect(httpUri("https://alice.example:8443/a/b/c")).toBe("https://alice.example:8443/a/b/c");
  });

  it("the DPoP htu (generateProof arg 2) has NO probe fragment and NO query (CORE round-4c regression)", async () => {
    // round-4b stamps an in-process #probe-<uuid> fragment on the probe URL. The
    // `dpop` package uses its htu arg VERBATIM, so without the fix the fragment (and
    // any query) would leak into the proof's htu claim — but a Solid server computes
    // htu from the fragment/query-stripped received request URI (§4.2), so the proof
    // would be rejected in production. Assert the minted htu is the bare
    // scheme+authority+path.
    const provider = makeProvider();
    // A probe URL with BOTH a query and the unguessable fragment, for completeness.
    const probeUrl = `${withProbeFragment("https://alice.example/storage/")}`;
    const url = new URL(probeUrl);
    url.searchParams.set("ts", "123"); // append a query too
    // Re-stamp the fragment after the searchParams write (URL ordering keeps it last).
    const fullUrl = url.toString();
    expect(fullUrl).toContain("#probe-");
    expect(fullUrl).toContain("ts=123");
    const req = new Request(fullUrl);
    provider.beginLoginProbe(req);

    dpopMock.calls.length = 0; // isolate THIS upgrade's proof call.
    await provider.upgrade(req);

    expect(dpopMock.calls).toHaveLength(1);
    const htu = dpopMock.calls[0][1] as string;
    // The exact regression roborev asked for: no fragment, no query in the htu.
    expect(htu).not.toContain("#probe-");
    expect(htu).not.toContain("#");
    expect(htu).not.toContain("?");
    expect(htu).not.toContain("ts=123");
    // It equals the bare scheme + authority + path the server will reconstruct.
    expect(htu).toBe("https://alice.example/storage/");
  });

  it("stripping the htu does NOT regress the in-process probe match — the same upgrade is still recorded as the probe (finding-2 preserved)", async () => {
    // The fix strips ONLY the DPoP htu; the in-process probe match must STILL key off
    // the full fragment-bearing request.url. Prove the very upgrade that produced a
    // fragment-less htu also recorded the probe upgrade for its generation.
    const provider = makeProvider();
    const { req, generation, url } = beginProbe(provider, "https://alice.example/storage/");
    expect(url).toContain("#probe-");

    dpopMock.calls.length = 0;
    const upgraded = await provider.upgrade(asManagerWraps(req));

    // htu is fragment/query-free...
    const htu = dpopMock.calls[0][1] as string;
    expect(htu).toBe("https://alice.example/storage/");
    expect(htu).not.toContain("#probe-");
    // ...yet the probe match (which uses the full fragment-bearing url) still fired.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
    expect(upgraded.headers.get("DPoP")).toBe("dpop-proof");
  });
});

describe("FIX (round 4) — generation scope is collision-free for two concurrent upgrades in ONE login", () => {
  beforeEach(() => {
    authState.webId = WEBID_A;
    authState.accessToken = "tok-A";
  });

  it("two concurrent upgrades in one generation still yield exactly one probe-upgrade proof (single-flight invariant)", async () => {
    // SessionProvider single-flights login, so there is never a second concurrent
    // login. At the PROVIDER level, the invariant this guarantees is: even if two
    // upgrades run in one generation (the probe + a same-WebID read), the proof is
    // bound to the ONE probe — it does not double-count or get stolen.
    const provider = makeProvider();
    const { req: probe, generation } = beginProbe(provider, "https://alice.example/storage/");

    // The probe and a concurrent data read upgrade together (same generation).
    const [probeUpgraded] = await Promise.all([
      provider.upgrade(probe),
      provider.upgrade(new Request("https://alice.example/data/doc")),
    ]);
    expect(probeUpgraded.headers.get("Authorization")).toBe("DPoP tok-A");

    // Exactly one probe proof exists, scoped to this login's generation. The
    // concurrent read could not steal it (different object + url), and the probe's
    // single-use latch means the proof is recorded once.
    expect(provider.wasLoginProbeUpgraded(generation)).toBe(true);
    // No proof leaks into an adjacent generation.
    expect(provider.wasLoginProbeUpgraded(generation + 1)).toBe(false);
  });
});
