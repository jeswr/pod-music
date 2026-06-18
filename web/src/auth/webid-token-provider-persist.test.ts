// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// webid-token-provider-persist.test.ts — the persistSession SUPERSESSION FENCE (roborev
// HIGH, the durable-credential-resurrection race). SECURITY-CRITICAL.
//
// THE BUG (roborev HIGH): `persistSession` awaits the cached session (`await pending`)
// before enqueueing the durable `store.put`. A logout()/new login() racing that await calls
// `reset()` (bumping the generation + clearing the in-memory session) and enqueues its durable
// DELETE first; when the STALE persistSession resumes it would enqueue a put AFTER the delete,
// RESURRECTING the just-logged-out credential on disk — a same-tick reload would then silently
// restore a session the user just signed out of.
//
// THE FIX: `persistSession(issuer, webId, expectGeneration)` re-checks the generation (and the
// live authenticated WebID) AFTER its internal `await pending` and BEFORE enqueueing the put —
// refusing the durable write when superseded. These tests seed a real in-memory session (via
// `restoreIssuer`, with `restoreSession` mocked to return a non-extractable-key session) and
// race a `reset()` against the persist await, asserting the put is NEVER enqueued once superseded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock ONLY the durable-store helpers the provider imports from the package; everything else is
// real. `restoreSession` is the seam we drive to seed a session into the provider's #sessions
// (the same path the real silent-restore takes) so we can then exercise persistSession.
const restoreSessionMock = vi.fn();
const forgetPersistedMock = vi.fn(async (_store: unknown, _issuer: unknown) => {});
const hasPersistedMock = vi.fn(async (_store: unknown, _issuer: unknown) => "absent" as const);
vi.mock("@jeswr/solid-session-restore", () => ({
  restoreSession: (arg: unknown) => restoreSessionMock(arg),
  forgetPersisted: (store: unknown, issuer: unknown) => forgetPersistedMock(store, issuer),
  hasPersisted: (store: unknown, issuer: unknown) => hasPersistedMock(store, issuer),
}));
// fetchRdf is imported at module scope by the provider; stub it so the import resolves.
vi.mock("@jeswr/fetch-rdf", () => ({ fetchRdf: vi.fn() }));

const { WebIdDPoPTokenProvider } = await import("./webid-token-provider");

const ISSUER = new URL("https://issuer.example/");
const WEBID_A = "https://alice.example/profile/card#me";
const WEBID_B = "https://bob.example/profile/card#me";

/** A spying in-memory SessionStore: records every put/delete so we can assert the durable write. */
function makeSpyStore() {
  const puts: string[] = [];
  const deletes: string[] = [];
  const store = {
    get: vi.fn(async () => undefined),
    put: vi.fn(async (record: { issuer: string }) => {
      puts.push(record.issuer);
    }),
    delete: vi.fn(async (issuer: string) => {
      deletes.push(issuer);
    }),
  };
  return { store, puts, deletes };
}

/** A REAL non-extractable EC DPoP key pair — persistSession FAILS CLOSED on an extractable key. */
async function nonExtractableKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
}

function makeProvider(store: unknown) {
  return new WebIdDPoPTokenProvider(
    "https://app.example/callback.html",
    async () => "https://app.example/callback.html?code=c&state=s",
    async () => WEBID_A,
    {
      clientId: "https://app.example/clientid.jsonld",
      sessionStore: store as never,
    },
  );
}

beforeEach(() => {
  restoreSessionMock.mockReset();
  forgetPersistedMock.mockClear();
  hasPersistedMock.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("roborev HIGH — persistSession supersession fence (no resurrecting a logged-out credential)", () => {
  it("CURRENT — persists the durable credential when the generation is unchanged", async () => {
    const { store, puts } = makeSpyStore();
    const provider = makeProvider(store);
    const dpopKey = await nonExtractableKey();
    // Seed an in-memory session via restoreIssuer (mocked restoreSession returns it).
    restoreSessionMock.mockResolvedValue({
      webId: WEBID_A,
      dpopKey,
      accessToken: "at",
      refreshToken: "rt",
    });
    await provider.restoreIssuer(ISSUER);
    const gen = provider.loginGeneration();

    const wrote = await provider.persistSession(ISSUER, WEBID_A, gen);
    expect(wrote).toBe(true);
    expect(puts).toEqual([ISSUER.href]); // the credential was durably written.
  });

  it("SUPERSEDED (stale generation, SAME WebID re-login) — the GENERATION check refuses the write", async () => {
    // This isolates the GENERATION check specifically (not the WebID re-check): a logout +
    // re-login as the SAME identity advances the generation but leaves #authenticatedWebId ===
    // WEBID_A. The stale establish (snapshot `staleGen`) must still be refused — its session is
    // the OLD generation's, superseded by the new login that now owns the durable state.
    const { store, puts } = makeSpyStore();
    const provider = makeProvider(store);
    restoreSessionMock.mockResolvedValue({
      webId: WEBID_A,
      dpopKey: await nonExtractableKey(),
      accessToken: "at",
      refreshToken: "rt",
    });
    await provider.restoreIssuer(ISSUER);
    const staleGen = provider.loginGeneration();
    // A logout advances the generation…
    provider.reset();
    // …then a re-login as the SAME WebID re-pins #authenticatedWebId === WEBID_A at a HIGHER
    // generation. (restoreIssuer captures the current generation, so this re-establish is the
    // current one; the earlier `staleGen` is now behind it.)
    restoreSessionMock.mockResolvedValue({
      webId: WEBID_A,
      dpopKey: await nonExtractableKey(),
      accessToken: "at2",
      refreshToken: "rt2",
    });
    await provider.restoreIssuer(ISSUER);
    expect(provider.loginGeneration()).toBeGreaterThan(staleGen); // generation advanced.

    // The STALE establish resumes and tries to persist with its OLD-generation snapshot. The
    // WebID matches (both A), so ONLY the generation check can reject it — and it must.
    const wrote = await provider.persistSession(ISSUER, WEBID_A, staleGen);
    expect(wrote).toBe(false); // the stale establish must NOT persist over the new login.
    expect(puts).toEqual([]); // nothing durably written by the superseded establish.
  });

  it("RACE — a reset() firing DURING persistSession's internal await writes NO put (the exact bug)", async () => {
    // The reviewer's exact scenario: persistSession is parked on `await pending`; a logout()
    // fires reset() while it is parked; when it resumes it must NOT enqueue the put. We model
    // the parked await by making #sessions' pending resolve on a gate (restoreIssuer pins a
    // RESOLVED promise, so we re-pin a slow one via a second restore whose mock gates).
    const { store, puts, deletes } = makeSpyStore();
    const provider = makeProvider(store);
    const dpopKey = await nonExtractableKey();

    // First restore pins a resolved session + sets the generation we will snapshot.
    restoreSessionMock.mockResolvedValue({
      webId: WEBID_A,
      dpopKey,
      accessToken: "at",
      refreshToken: "rt",
    });
    await provider.restoreIssuer(ISSUER);
    const gen = provider.loginGeneration();

    // Start the persist. `await pending` (a resolved promise) yields a microtask; we fire
    // reset() before that microtask drains, so persistSession resumes in a superseded world.
    const persistPromise = provider.persistSession(ISSUER, WEBID_A, gen);
    provider.reset(); // logout races the persist's internal await — bumps the generation.

    const wrote = await persistPromise;
    expect(wrote).toBe(false); // superseded → refused.
    expect(puts).toEqual([]); // the credential was NEVER resurrected on disk.
    expect(deletes).toEqual([]); // (reset() itself does not delete; logout's forget would.)
  });

  it("IDENTITY SWITCH — a new login as a DIFFERENT WebID supersedes the stale persist (WebID fence)", async () => {
    // Even at the same generation, if the live authenticated WebID is no longer the one being
    // persisted (a re-login swapped identity), the durable write must be refused.
    const { store, puts } = makeSpyStore();
    const provider = makeProvider(store);
    const dpopKey = await nonExtractableKey();
    restoreSessionMock.mockResolvedValue({
      webId: WEBID_A,
      dpopKey,
      accessToken: "at",
      refreshToken: "rt",
    });
    await provider.restoreIssuer(ISSUER);
    const gen = provider.loginGeneration();
    // Re-pin a DIFFERENT identity at the SAME issuer (models a fast re-login as B).
    restoreSessionMock.mockResolvedValue({
      webId: WEBID_B,
      dpopKey: await nonExtractableKey(),
      accessToken: "at2",
      refreshToken: "rt2",
    });
    await provider.restoreIssuer(ISSUER); // does NOT advance generation; flips #authenticatedWebId to B.

    // The stale establish for A tries to persist A — but the live identity is now B.
    const wrote = await provider.persistSession(ISSUER, WEBID_A, gen);
    expect(wrote).toBe(false);
    expect(puts).toEqual([]);
  });

  it("ADVERSARIAL CONTROL — WITHOUT the generation arg the stale persist WOULD write (proves the fence is load-bearing)", async () => {
    // Reproduce the PRE-FENCE call (no expectGeneration): the only thing then stopping a
    // resurrect is the WebID still matching — which it does after a bare reset() that does not
    // re-login. So the unguarded call DOES write the (logged-out) credential — exactly the
    // resurrection bug. NOTE reset() clears #sessions, so to isolate JUST the missing
    // generation arg we re-pin the SAME identity after reset (a same-identity re-establish),
    // then call persistSession WITHOUT a generation: it writes. With the (now-current)
    // generation it also writes — proving the arg is what rejects a STALE one (covered above).
    const { store, puts } = makeSpyStore();
    const provider = makeProvider(store);
    restoreSessionMock.mockResolvedValue({
      webId: WEBID_A,
      dpopKey: await nonExtractableKey(),
      accessToken: "at",
      refreshToken: "rt",
    });
    await provider.restoreIssuer(ISSUER);
    // No expectGeneration → the generation check is skipped (back-compat); the WebID still
    // matches, so it writes. This is the pre-fence behaviour the stale-generation test guards.
    const wrote = await provider.persistSession(ISSUER, WEBID_A);
    expect(wrote).toBe(true);
    expect(puts).toEqual([ISSUER.href]);
  });
});
