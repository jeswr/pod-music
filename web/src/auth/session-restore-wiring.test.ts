// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Adversarial tests for the SILENT SESSION RESTORE wiring (cross-app UX invariant
// #1) added to pod-music's auth seam. The durable CORE is the audited
// @jeswr/solid-session-restore package (its own suite exhaustively tests the
// refresh-grant + invalid_grant classification internals); these tests pin THIS
// APP'S thin wiring of it — the security-critical behaviours the task calls out:
//
//   1. RESTORES a persisted session on mount: runSilentRestore → decideSilentRestore
//      → provider.restoreIssuer → restoreSession (mocked), and the provider PINS the
//      restored session in-memory under its generation/reset fence.
//   2. TEARS DOWN FAIL-CLOSED on a WebID mismatch — and the test genuinely FAILS
//      without the WebID-binding guard (we prove the guard is load-bearing), then
//      with it the teardown happens in the correct order (reset → forget → clear).
//   3. CLEARS the persisted credential on a definitive `invalid_grant` but PRESERVES
//      it on a transient failure — exercised through pod-music's restoreIssuer +
//      hasPersistedFor against a real in-memory store, with restoreSession's
//      documented clear/preserve contract simulated at the package boundary (the
//      package's own suite tests the oauth4webapi internals; here we verify pod-music
//      delegates correctly and the store state is what the contract guarantees).
//
// We mock ONLY the package's `restoreSession` (the one fetch-bearing call), keeping
// the pure decision (`decideSilentRestore`, `shouldDropRememberedPointer`,
// `webIdsEqual`) and the trivial store-delegating lifecycle (`forgetPersisted`,
// `hasPersisted`) REAL — so the wiring + the keep/drop matrix run against real code.

import type { PersistedSession, RestoredSession, SessionStore } from "@jeswr/solid-session-restore";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WEBID_A = "https://alice.example/profile/card#me";
const WEBID_B = "https://bob.example/profile/card#me";
const ISSUER = "https://issuer.example/";

// What the next mocked restoreSession does. Each test sets this in its own setup.
// On `invalid_grant` the mock CLEARS the store entry (the package's documented
// contract: a definitively dead token is cleared); on `transient` it PRESERVES it
// (a blip on load must not erase an otherwise-valid credential); on `ok` it returns
// a rebuilt session and (per the package) re-persists the rotated token.
type RestoreOutcome =
  | { kind: "ok"; webId: string }
  | { kind: "invalid_grant" }
  | { kind: "transient" };
const restoreState: { outcome: RestoreOutcome } = { outcome: { kind: "ok", webId: WEBID_A } };

// Mock ONLY restoreSession; keep the rest of the package real (the pure decision +
// the store-delegating forgetPersisted/hasPersisted).
vi.mock("@jeswr/solid-session-restore", async (orig) => {
  const real = (await orig()) as typeof import("@jeswr/solid-session-restore");
  return {
    ...real,
    restoreSession: vi.fn(
      async (opts: {
        store: SessionStore;
        issuer: URL;
        clientId?: string;
      }): Promise<RestoredSession | undefined> => {
        const o = restoreState.outcome;
        if (o.kind === "invalid_grant") {
          // Definitive dead token → the package clears the entry. Model that.
          await opts.store.delete(opts.issuer.href);
          return undefined;
        }
        if (o.kind === "transient") {
          // A blip → the credential is preserved (no delete), restore is undefined.
          return undefined;
        }
        // Success: re-persist the rotated token (the package does this) + return the
        // rebuilt session. dpopKey/handle shapes are irrelevant to the wiring under test.
        const existing = await opts.store.get(opts.issuer.href);
        const dpopKey = existing?.dpopKey ?? ({} as CryptoKeyPair);
        await opts.store.put({
          issuer: opts.issuer.href,
          webId: o.webId,
          refreshToken: "rotated-refresh-token",
          dpopKey,
          ...(opts.clientId !== undefined ? { clientId: opts.clientId } : {}),
        });
        return {
          webId: o.webId,
          accessToken: "fresh-access-token",
          refreshToken: "rotated-refresh-token",
          dpopKey,
          dpopHandle: {} as RestoredSession["dpopHandle"],
          expiresAt: undefined,
          issuer: opts.issuer.href,
        };
      },
    ),
  };
});

// The OAuth/DPoP/profile stack the PROVIDER (not the package) reaches for the popup
// path is irrelevant to restoreIssuer (which goes straight to restoreSession), but
// the provider module imports them at top level, so stub them inertly.
vi.mock("@jeswr/fetch-rdf", () => ({ fetchRdf: vi.fn(async () => ({ dataset: new Set() })) }));
vi.mock("./login-ux", () => ({ validateWebId: (s: string) => s, resolveIssuers: () => [ISSUER] }));
vi.mock("dpop", () => ({ generateProof: vi.fn(async () => "p") }));
vi.mock("oauth4webapi", () => ({
  allowInsecureRequests: Symbol("a"),
  customFetch: Symbol("c"),
  None: () => () => {},
  expectNoNonce: Symbol("e"),
  nopkce: Symbol("n"),
  DPoP: () => ({}),
  isDPoPNonceError: () => false,
  discoveryRequest: vi.fn(async () => ({})),
  processDiscoveryResponse: vi.fn(async () => ({
    issuer: ISSUER,
    token_endpoint: `${ISSUER}token`,
  })),
  dynamicClientRegistrationRequest: vi.fn(),
  processDynamicClientRegistrationResponse: vi.fn(),
  getValidatedIdTokenClaims: vi.fn(() => ({ webid: WEBID_A })),
}));

// Import AFTER the mocks are registered.
const { WebIdDPoPTokenProvider } = await import("./webid-token-provider");
const { runSilentRestore, autologinTakesPrecedence } = await import("./SessionProvider");
const restorePkg = await import("@jeswr/solid-session-restore");

/** A trivial in-memory SessionStore double (the package's injectable contract). */
function inMemoryStore(
  seed?: PersistedSession,
): SessionStore & { map: Map<string, PersistedSession> } {
  const map = new Map<string, PersistedSession>();
  if (seed) map.set(seed.issuer, seed);
  return {
    map,
    async get(issuer) {
      return map.get(issuer);
    },
    async put(session) {
      map.set(session.issuer, session);
    },
    async delete(issuer) {
      map.delete(issuer);
    },
  };
}

/** A real (non-extractable) ES256 DPoP key pair — what the persisted record holds. */
async function es256Key(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

/** Build a provider wired to a given session store. */
function makeProvider(store: SessionStore) {
  return new WebIdDPoPTokenProvider(
    "https://app.example/callback.html",
    async () => "https://app.example/callback.html?code=c&state=s",
    async () => WEBID_A,
    { clientId: "https://app.example/clientid.jsonld", sessionStore: store },
  );
}

/**
 * An in-memory localStorage shim so the module-level RememberedAccount (which
 * runSilentRestore reads) returns a record we control. Installed on globalThis.
 */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return store;
}

const REMEMBERED_KEY = "pod-music:remembered-account";
function remember(ls: Map<string, string>, webId: string, issuer: string) {
  ls.set(REMEMBERED_KEY, JSON.stringify({ webId, issuer }));
}

beforeEach(() => {
  restoreState.outcome = { kind: "ok", webId: WEBID_A };
  installLocalStorage();
});

describe("provider.restoreIssuer — pins on success, clears on invalid_grant, preserves on transient", () => {
  it("restores a persisted session on mount (mocked refresh grant) and PINS it in-memory", async () => {
    const store = inMemoryStore({
      issuer: ISSUER,
      webId: WEBID_A,
      refreshToken: "rt-A",
      dpopKey: await es256Key(),
      clientId: "https://app.example/clientid.jsonld",
    });
    const provider = makeProvider(store);

    const result = await provider.restoreIssuer(new URL(ISSUER));

    expect(result).toEqual({ webId: WEBID_A });
    // The provider PINNED the restored identity so a later 401 upgrade reuses it
    // with no re-prompt (the README "thin wiring" invariant).
    expect(provider.authenticatedWebId()).toBe(WEBID_A);
    // The rotated refresh token was re-persisted by the restore.
    expect(store.map.get(ISSUER)?.refreshToken).toBe("rotated-refresh-token");
  });

  it("CLEARS the persisted credential on a definitive invalid_grant (dead token)", async () => {
    restoreState.outcome = { kind: "invalid_grant" };
    const store = inMemoryStore({
      issuer: ISSUER,
      webId: WEBID_A,
      refreshToken: "dead-rt",
      dpopKey: await es256Key(),
    });
    const provider = makeProvider(store);

    const result = await provider.restoreIssuer(new URL(ISSUER));

    expect(result).toBeUndefined();
    // A dead token must be cleared so a doomed restore is not retried forever.
    expect(store.map.has(ISSUER)).toBe(false);
    // hasPersistedFor delegates to the REAL hasPersisted → reads the (now empty) store.
    expect(await provider.hasPersistedFor(new URL(ISSUER))).toBe("absent");
    // The provider pinned NOTHING for a failed restore.
    expect(provider.authenticatedWebId()).toBeUndefined();
  });

  it("PRESERVES the credential on a transient failure (a blip must not force re-login)", async () => {
    restoreState.outcome = { kind: "transient" };
    const store = inMemoryStore({
      issuer: ISSUER,
      webId: WEBID_A,
      refreshToken: "good-rt",
      dpopKey: await es256Key(),
    });
    const provider = makeProvider(store);

    const result = await provider.restoreIssuer(new URL(ISSUER));

    expect(result).toBeUndefined();
    // The credential is intact — the next reload retries.
    expect(store.map.get(ISSUER)?.refreshToken).toBe("good-rt");
    expect(await provider.hasPersistedFor(new URL(ISSUER))).toBe("present");
  });

  it("forgetIssuer drops the durable credential (logout side, delegates to forgetPersisted)", async () => {
    const store = inMemoryStore({
      issuer: ISSUER,
      webId: WEBID_A,
      refreshToken: "rt",
      dpopKey: await es256Key(),
    });
    const provider = makeProvider(store);
    await provider.forgetIssuer(new URL(ISSUER));
    expect(store.map.has(ISSUER)).toBe(false);
  });

  it("a reset() racing the grant supersedes the restore — pins NOTHING (generation fence)", async () => {
    // Make restoreSession PARK so reset() can fire mid-grant.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spy = restorePkg.restoreSession as unknown as ReturnType<typeof vi.fn>;
    spy.mockImplementationOnce(async () => {
      await gate;
      return {
        webId: WEBID_A,
        accessToken: "at",
        refreshToken: "rt2",
        dpopKey: {} as CryptoKeyPair,
        dpopHandle: {} as RestoredSession["dpopHandle"],
        expiresAt: undefined,
        issuer: ISSUER,
      } satisfies RestoredSession;
    });

    const store = inMemoryStore({
      issuer: ISSUER,
      webId: WEBID_A,
      refreshToken: "rt",
      dpopKey: await es256Key(),
    });
    const provider = makeProvider(store);
    const p = provider.restoreIssuer(new URL(ISSUER));
    provider.reset(); // a logout / new login fires DURING the grant.
    release();
    const result = await p;

    expect(result).toBeUndefined();
    // The superseded restore must NOT have pinned an identity onto the fresh generation.
    expect(provider.authenticatedWebId()).toBeUndefined();
  });

  it("a provider with NO session store persists/restores NOTHING (restore is opt-in)", async () => {
    const provider = new WebIdDPoPTokenProvider(
      "https://app.example/callback.html",
      async () => "x",
      async () => WEBID_A,
      { clientId: "https://app.example/clientid.jsonld" }, // no sessionStore
    );
    expect(await provider.restoreIssuer(new URL(ISSUER))).toBeUndefined();
    expect(await provider.hasPersistedFor(new URL(ISSUER))).toBe("absent");
  });

  it("NEVER persists an EXTRACTABLE DPoP key (the redirect-flow key) — roborev HIGH", async () => {
    // The autologin redirect path mints an EXTRACTABLE key (it exports it to survive
    // the full-page redirect). Persisting THAT defeats the sender-constraint — so
    // persistSession must skip it. Seed an in-memory session carrying an EXTRACTABLE
    // key via a restoreIssuer mock, then clear the store and prove persistSession
    // refuses to write it.
    const extractableKey = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true, // ← EXTRACTABLE (the redirect-flow key shape)
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(extractableKey.privateKey.extractable).toBe(true);

    const store = inMemoryStore();
    const provider = makeProvider(store);
    const spy = restorePkg.restoreSession as unknown as ReturnType<typeof vi.fn>;
    spy.mockImplementationOnce(
      async (opts: { issuer: URL }): Promise<RestoredSession> => ({
        webId: WEBID_A,
        accessToken: "at",
        refreshToken: "rt-extractable",
        dpopKey: extractableKey,
        dpopHandle: {} as RestoredSession["dpopHandle"],
        expiresAt: undefined,
        issuer: opts.issuer.href,
      }),
    );
    // restoreIssuer pins the (extractable-keyed) session in #sessions.
    await provider.restoreIssuer(new URL(ISSUER));
    store.map.clear(); // ignore any restore-side write; isolate persistSession.

    // persistSession MUST refuse to persist the extractable-keyed session.
    await provider.persistSession(new URL(ISSUER), WEBID_A);
    expect(store.map.has(ISSUER)).toBe(false);

    // Control: a NON-extractable key IS persisted (so the popup path stays restorable).
    const nonExtractable = await es256Key();
    expect(nonExtractable.privateKey.extractable).toBe(false);
    const store2 = inMemoryStore();
    const provider2 = makeProvider(store2);
    spy.mockImplementationOnce(
      async (opts: { issuer: URL }): Promise<RestoredSession> => ({
        webId: WEBID_A,
        accessToken: "at",
        refreshToken: "rt-nonextractable",
        dpopKey: nonExtractable,
        dpopHandle: {} as RestoredSession["dpopHandle"],
        expiresAt: undefined,
        issuer: opts.issuer.href,
      }),
    );
    await provider2.restoreIssuer(new URL(ISSUER));
    store2.map.clear();
    expect(await provider2.persistSession(new URL(ISSUER), WEBID_A)).toBe(true);
    expect(store2.map.get(ISSUER)?.refreshToken).toBe("rt-nonextractable");
  });

  it("persistSession REPORTS whether it wrote — so the pointer is written only on a real persist (roborev LOW)", async () => {
    // No store wired → false.
    const noStore = new WebIdDPoPTokenProvider(
      "https://app.example/callback.html",
      async () => "x",
      async () => WEBID_A,
      { clientId: "https://app.example/clientid.jsonld" },
    );
    expect(await noStore.persistSession(new URL(ISSUER), WEBID_A)).toBe(false);

    // Session has NO refresh token → false (nothing restorable to persist).
    const store = inMemoryStore();
    const provider = makeProvider(store);
    const spy = restorePkg.restoreSession as unknown as ReturnType<typeof vi.fn>;
    const key = await es256Key();
    spy.mockImplementationOnce(
      async (opts: { issuer: URL }): Promise<RestoredSession> => ({
        webId: WEBID_A,
        accessToken: "at",
        refreshToken: "", // ← no refresh token issued (offline_access not granted)
        dpopKey: key,
        dpopHandle: {} as RestoredSession["dpopHandle"],
        expiresAt: undefined,
        issuer: opts.issuer.href,
      }),
    );
    await provider.restoreIssuer(new URL(ISSUER));
    store.map.clear();
    expect(await provider.persistSession(new URL(ISSUER), WEBID_A)).toBe(false);
    expect(store.map.has(ISSUER)).toBe(false);

    // Extractable key → false (the redirect-flow key is never persisted).
    const extractable = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const store3 = inMemoryStore();
    const provider3 = makeProvider(store3);
    spy.mockImplementationOnce(
      async (opts: { issuer: URL }): Promise<RestoredSession> => ({
        webId: WEBID_A,
        accessToken: "at",
        refreshToken: "rt",
        dpopKey: extractable,
        dpopHandle: {} as RestoredSession["dpopHandle"],
        expiresAt: undefined,
        issuer: opts.issuer.href,
      }),
    );
    await provider3.restoreIssuer(new URL(ISSUER));
    store3.map.clear();
    expect(await provider3.persistSession(new URL(ISSUER), WEBID_A)).toBe(false);
  });

  it("SERIALISES forget-then-persist — a logout delete cannot wipe a re-login's credential (roborev MEDIUM)", async () => {
    // A store whose delete + put each resolve on a LATER microtask, so an un-serialised
    // forget could land after a put. We record the COMMIT order to prove serialisation.
    const committed: string[] = [];
    // A real NON-extractable key — persistSession only persists non-extractable keys.
    const map = new Map<string, PersistedSession>([
      [ISSUER, { issuer: ISSUER, webId: WEBID_A, refreshToken: "old", dpopKey: await es256Key() }],
    ]);
    // The delete is SLOWER than the put (a longer async tail). Un-serialised, the put
    // would commit FIRST and the slow delete would land AFTER, WIPING the credential.
    // Serialised on #storeOps, the delete is forced to complete before the put runs.
    const store: SessionStore = {
      get: async (i) => map.get(i),
      put: async (s) => {
        await Promise.resolve();
        map.set(s.issuer, s);
        committed.push(`put:${s.refreshToken}`);
      },
      delete: async (i) => {
        // A longer tail than put — several microtasks — so an un-serialised delete
        // would resolve AFTER the put (the race this serialisation prevents).
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        map.delete(i);
        committed.push("delete");
      },
    };
    const provider = makeProvider(store);
    // Seed an in-memory session so persistSession has something to persist (mimics a
    // confirmed re-login to the SAME issuer right after logout fired forget). The
    // restore mock carries the seed's non-extractable key through, so persistSession
    // accepts it.
    restoreState.outcome = { kind: "ok", webId: WEBID_A };
    await provider.restoreIssuer(new URL(ISSUER)); // pins + re-persists "rotated-refresh-token"
    committed.length = 0; // ignore the restore's own write; focus on the race below.

    // Fire forget (logout) and persist (re-login) WITHOUT awaiting between them — the
    // exact race: an un-serialised delete could land after the put.
    const forget = provider.forgetIssuer(new URL(ISSUER));
    const persist = provider.persistSession(new URL(ISSUER), WEBID_A);
    await Promise.all([forget, persist]);

    // Serialised in call order: delete THEN put → the credential survives (put wins).
    expect(committed).toEqual(["delete", "put:rotated-refresh-token"]);
    expect(map.get(ISSUER)?.refreshToken).toBe("rotated-refresh-token");
  });

  it("a SUPERSEDED restore forgets the just-rotated credential (no resurrection after logout)", async () => {
    // restoreSession PARKS, a reset() (logout) fires mid-grant, then the grant
    // resolves having re-persisted the rotated token. The fence must then forget it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const map = new Map<string, PersistedSession>([
      [
        ISSUER,
        { issuer: ISSUER, webId: WEBID_A, refreshToken: "old", dpopKey: {} as CryptoKeyPair },
      ],
    ]);
    const store: SessionStore = {
      get: async (i) => map.get(i),
      put: async (s) => {
        map.set(s.issuer, s);
      },
      delete: async (i) => {
        map.delete(i);
      },
    };
    const spy = restorePkg.restoreSession as unknown as ReturnType<typeof vi.fn>;
    spy.mockImplementationOnce(async (opts: { store: SessionStore; issuer: URL }) => {
      await gate;
      // The package re-persists the rotated token before returning.
      await opts.store.put({
        issuer: opts.issuer.href,
        webId: WEBID_A,
        refreshToken: "rotated",
        dpopKey: {} as CryptoKeyPair,
      });
      return {
        webId: WEBID_A,
        accessToken: "at",
        refreshToken: "rotated",
        dpopKey: {} as CryptoKeyPair,
        dpopHandle: {} as RestoredSession["dpopHandle"],
        expiresAt: undefined,
        issuer: opts.issuer.href,
      } satisfies RestoredSession;
    });

    const provider = makeProvider(store);
    const p = provider.restoreIssuer(new URL(ISSUER));
    provider.reset(); // logout fires mid-grant.
    release();
    expect(await p).toBeUndefined();
    // The superseded restore forgot the rotated credential — nothing left to restore.
    expect(map.has(ISSUER)).toBe(false);
    expect(provider.authenticatedWebId()).toBeUndefined();
  });

  it("logoutForget drops the ACTIVE issuer's credential even with NO pointer (no orphan)", async () => {
    const store = inMemoryStore({
      issuer: ISSUER,
      webId: WEBID_A,
      refreshToken: "rt",
      dpopKey: await es256Key(),
    });
    const provider = makeProvider(store);
    // Establish the session so the provider's #issuer is resolved (the restore pins it).
    await provider.restoreIssuer(new URL(ISSUER));
    expect(store.map.has(ISSUER)).toBe(true);
    // Logout with NO extra (pointer) issuers — logoutForget must still forget the
    // provider's resolved issuer, so the credential is not orphaned in IndexedDB.
    await provider.logoutForget([]);
    expect(store.map.has(ISSUER)).toBe(false);
  });

  it("logoutForget enqueues SYNCHRONOUSLY so a fast re-login persist wins the race (delete-before-put)", async () => {
    const committed: string[] = [];
    // A real NON-extractable key — persistSession only persists non-extractable keys.
    const map = new Map<string, PersistedSession>([
      [ISSUER, { issuer: ISSUER, webId: WEBID_A, refreshToken: "old", dpopKey: await es256Key() }],
    ]);
    const store: SessionStore = {
      get: async (i) => map.get(i),
      put: async (s) => {
        await Promise.resolve();
        map.set(s.issuer, s);
        committed.push(`put:${s.refreshToken}`);
      },
      // A slower delete: an un-synchronised enqueue would let the put commit first.
      delete: async (i) => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        map.delete(i);
        committed.push("delete");
      },
    };
    const provider = makeProvider(store);
    await provider.restoreIssuer(new URL(ISSUER)); // pins #issuer + persists "rotated-refresh-token"
    committed.length = 0;

    // The race: logout fires logoutForget, then a fast re-login persists — both
    // WITHOUT awaiting between them. logoutForget enqueues the delete synchronously,
    // so the delete is strictly ordered BEFORE the re-login's put → the credential
    // survives (put wins).
    const forget = provider.logoutForget([]);
    const persist = provider.persistSession(new URL(ISSUER), WEBID_A);
    await Promise.all([forget, persist]);

    expect(committed).toEqual(["delete", "put:rotated-refresh-token"]);
    expect(map.get(ISSUER)?.refreshToken).toBe("rotated-refresh-token");
  });
});

describe("runSilentRestore — the mount-time decision + fail-closed teardown", () => {
  /** A fake provider exposing only the surface runSilentRestore drives. */
  function fakeProvider(opts: {
    restoreResult: { webId: string } | undefined;
    presence?: "present" | "absent" | "unknown";
  }) {
    return {
      reset: vi.fn(),
      forgetIssuer: vi.fn(async () => {}),
      hasPersistedFor: vi.fn(async () => opts.presence ?? "present"),
      restoreIssuer: vi.fn(async () => opts.restoreResult),
    };
  }
  type FakeAsProvider = InstanceType<typeof WebIdDPoPTokenProvider>;

  it("RESTORED — a matching restored WebID yields a restored result + re-confirms the pointer", async () => {
    const ls = installLocalStorage();
    remember(ls, WEBID_A, ISSUER);
    const provider = fakeProvider({ restoreResult: { webId: WEBID_A } });

    const result = await runSilentRestore(provider as unknown as FakeAsProvider);

    expect(result).toEqual({ kind: "restored", webId: WEBID_A, issuer: ISSUER });
    expect(provider.reset).not.toHaveBeenCalled();
    expect(provider.forgetIssuer).not.toHaveBeenCalled();
    expect(JSON.parse(ls.get(REMEMBERED_KEY) as string).webId).toBe(WEBID_A);
  });

  it("WEBID-MISMATCH — tears down FAIL-CLOSED: reset() BEFORE forgetIssuer, pointer cleared", async () => {
    const ls = installLocalStorage();
    remember(ls, WEBID_A, ISSUER);
    // The grant SUCCEEDED but authenticated a DIFFERENT WebID (B) than remembered (A).
    const provider = fakeProvider({ restoreResult: { webId: WEBID_B } });

    const order: string[] = [];
    provider.reset.mockImplementation(() => {
      order.push("reset");
    });
    provider.forgetIssuer.mockImplementation(async () => {
      order.push("forget");
    });

    const result = await runSilentRestore(provider as unknown as FakeAsProvider);

    expect(result).toEqual({ kind: "login" });
    // The session is NOT asserted for the wrong identity.
    expect(provider.reset).toHaveBeenCalledTimes(1);
    expect(provider.forgetIssuer).toHaveBeenCalledWith(new URL(ISSUER));
    // ORDER MATTERS (README): drop the in-memory session FIRST, then the durable one.
    expect(order).toEqual(["reset", "forget"]);
    // The known-bad pointer is dropped so it does not re-fail the isolation check.
    expect(ls.get(REMEMBERED_KEY)).toBeUndefined();
  });

  it("ADVERSARIAL — without the WebID guard a mismatched restore is ASSERTED (proves the guard is load-bearing)", async () => {
    // The fail-closed WebID-binding guard lives in decideSilentRestore's webIdsEqual
    // check. Prove it is load-bearing: with the REAL guard a B-restore for an
    // A-pointer is caught (webid-mismatch → login); with the guard DISABLED
    // (webIdsEqual forced true) the WRONG WebID (B) would be ASSERTED as restored —
    // the exact cross-identity assertion the guard exists to prevent.
    const guarded = await restorePkg.decideSilentRestore({
      lastActiveWebId: WEBID_A,
      remembered: [{ webId: WEBID_A, issuer: ISSUER }],
      restoreIssuer: async () => ({ webId: WEBID_B }),
      webIdsEqual: restorePkg.webIdsEqual, // the REAL fail-closed guard
    });
    const unguarded = await restorePkg.decideSilentRestore({
      lastActiveWebId: WEBID_A,
      remembered: [{ webId: WEBID_A, issuer: ISSUER }],
      restoreIssuer: async () => ({ webId: WEBID_B }),
      webIdsEqual: () => true, // ← guard removed: the regression this test pins
    });

    expect(guarded).toEqual({ outcome: "login", reason: "webid-mismatch" });
    // WITHOUT the guard the wrong identity is asserted — this assertion would make a
    // guard-removing regression FAIL loudly.
    expect(unguarded).toEqual({ outcome: "restored", webId: WEBID_B, issuer: ISSUER });

    // And runSilentRestore (which uses the REAL guard) never asserts B for an
    // A-pointer — it returns login (and tears down fail-closed).
    const ls = installLocalStorage();
    remember(ls, WEBID_A, ISSUER);
    const provider = fakeProvider({ restoreResult: { webId: WEBID_B } });
    expect(await runSilentRestore(provider as unknown as FakeAsProvider)).toEqual({
      kind: "login",
    });
    expect(provider.reset).toHaveBeenCalledTimes(1);
  });

  it("NO REMEMBERED ACCOUNT — login, no restore attempted, no teardown", async () => {
    installLocalStorage(); // empty
    const provider = fakeProvider({ restoreResult: undefined });
    const result = await runSilentRestore(provider as unknown as FakeAsProvider);
    expect(result).toEqual({ kind: "login" });
    expect(provider.restoreIssuer).not.toHaveBeenCalled();
    expect(provider.reset).not.toHaveBeenCalled();
  });

  it("RESTORE-FAILED + credential PRESENT — keep the pointer (retry next load)", async () => {
    const ls = installLocalStorage();
    remember(ls, WEBID_A, ISSUER);
    const provider = fakeProvider({ restoreResult: undefined, presence: "present" });
    const result = await runSilentRestore(provider as unknown as FakeAsProvider);
    expect(result).toEqual({ kind: "login" });
    // The credential survived (transient) → the pointer is KEPT for a later retry.
    expect(ls.get(REMEMBERED_KEY)).toBeDefined();
    expect(provider.reset).not.toHaveBeenCalled();
  });

  it("RESTORE-FAILED + credential ABSENT — drop the pointer (definitively gone)", async () => {
    const ls = installLocalStorage();
    remember(ls, WEBID_A, ISSUER);
    const provider = fakeProvider({ restoreResult: undefined, presence: "absent" });
    const result = await runSilentRestore(provider as unknown as FakeAsProvider);
    expect(result).toEqual({ kind: "login" });
    // The dead credential was cleared by restore → the pointer is dropped too.
    expect(ls.get(REMEMBERED_KEY)).toBeUndefined();
  });
});

describe("autologinTakesPrecedence — silent restore defers to an explicit flow", () => {
  it("defers to an #autologin deep-link", () => {
    expect(autologinTakesPrecedence(`#autologin/${encodeURIComponent(WEBID_A)}`, "", false)).toBe(
      true,
    );
  });

  it("defers to an OAuth ?code&state redirect return", () => {
    expect(autologinTakesPrecedence("", "?code=abc&state=xyz", false)).toBe(true);
  });

  it("defers to an OAuth ?error&state redirect return", () => {
    expect(autologinTakesPrecedence("", "?error=login_required&state=xyz", false)).toBe(true);
  });

  it("defers to a persisted pending redirect record", () => {
    expect(autologinTakesPrecedence("", "", true)).toBe(true);
  });

  it("does NOT defer on a plain load (no fragment / no params / no pending) — restore runs", () => {
    expect(autologinTakesPrecedence("", "", false)).toBe(false);
  });
});
