// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// SessionProvider — the ONE place auth is wired for the Pod Docs static host.
// It mounts the browser-only <authorization-code-flow> popup element, builds a
// WebID-driven DPoP token provider bound to THIS origin's static Client
// Identifier Document, and calls registerGlobally() so EVERY plain `fetch()`
// (including the ones inside @jeswr/fetch-rdf and the @jeswr/pod-docs data layer)
// transparently upgrades on a 401 with a DPoP token. The library's
// `fetch?:` seam can then be left as the ambient global — no per-call wiring.
//
// LOAD-BEARING HOUSE RULES (do not "simplify" away):
//  1. @solid/reactive-authentication is pure-ESM + browser-only (custom elements,
//     popups). It is loaded via a DYNAMIC import inside an effect so it NEVER
//     evaluates at module-eval / SSR / prerender time. (This host has no SSR, but
//     keeping the dynamic import means the bundle has no top-level reactive-auth
//     evaluation — verified by the build gate.)
//  2. The 0.1.3 ReactiveFetchManager CONSTRUCTOR DOES NOT PATCH fetch — you MUST
//     call `manager.registerGlobally()`. Forgetting it is the #1 reactive-auth bug.
//  3. The client_id is the per-origin static Client Identifier Document at
//     `${origin}/clientid.jsonld` (generated at build by scripts/gen-clientid.mjs),
//     so the OP shows "Pod Docs" on the consent screen instead of a throwaway
//     dynamic registration.
//  4. `allowInsecureLoopback` is enabled ONLY for a localhost origin (dev against
//     a local CSS over HTTP); a deployed HTTPS origin stays strict.

import type { AuthorizationCodeFlow, GetCodeCallback } from "@solid/reactive-authentication";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { authFlowHolder, getCodeThroughHolder } from "./auth-flow-holder";
import { assessLoginProbe } from "./login-result";
import { readProfile } from "./profile";
import { type DerivedSession, deriveSession } from "./session-derivation";
import { decideSingleFlight } from "./single-flight";
import {
  AmbiguousIssuerError,
  WebIdDPoPTokenProvider,
  webIdsEqual,
  withProbeFragment,
} from "./webid-token-provider";

export interface SessionContextValue {
  /** The authenticated user's WebID, else null. */
  webId: string | null;
  /** The derived session (pod root + documents container) once logged in. */
  session: DerivedSession | null;
  /** True while a login flow is running. */
  loggingIn: boolean;
  /** Last login error, surfaced to the UI. */
  error: string | null;
  /** True once the auth runtime has loaded and registerGlobally() ran. */
  ready: boolean;
  /** Begin login for a WebID. Resolves when authenticated, rejects on failure. */
  login: (webId: string) => Promise<void>;
  /** Drop the in-memory session (tokens are memory-only; this clears app state). */
  logout: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Read the session state anywhere under <SessionProvider>. */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
};

/**
 * MODULE-LEVEL singleton for the auth runtime — the fix for the global-fetch
 * patch lifecycle bug (Finding 2). `ReactiveFetchManager.registerGlobally()`
 * monkey-patches `globalThis.fetch` and offers no idempotency guard or cleanup,
 * so a naive per-mount effect is unsafe: under React.StrictMode the mount effect
 * runs TWICE, and the second pass would (a) snapshot the ALREADY-PATCHED fetch as
 * if it were pristine, and (b) call `registerGlobally()` again, STACKING a second
 * patch over the first. Two stacked patches double-handle auth and break plain
 * reads. Hoisting the build+register out of React, behind a once-only guard,
 * makes it run exactly once for the lifetime of the page regardless of how many
 * times the effect mounts — the pristine fetch is captured once and the global is
 * patched once.
 */
interface AuthRuntime {
  provider: WebIdDPoPTokenProvider;
  /** The original, un-upgrading fetch captured BEFORE registerGlobally patched it. */
  profileFetch: typeof fetch;
}

interface AuthRuntimeConfig {
  callbackUri: string;
  clientId: string;
  allowInsecureLoopback: boolean;
  getWebId: () => Promise<string>;
}

let authRuntimeSingleton: Promise<AuthRuntime> | null = null;

/**
 * The WebID the user is currently logging in with, in a MODULE-level holder (not
 * a per-mount ref). The auth runtime is a page-lifetime singleton (Finding 2), so
 * its `getWebId` closure must read the latest value through a stable holder rather
 * than capturing one mount's ref — otherwise a StrictMode remount's `login()`
 * would write a ref the singleton never reads. `login()` sets this; the singleton
 * reads it on each 401 upgrade.
 */
const pendingWebIdHolder: { current: string | null } = { current: null };

/**
 * SINGLE-FLIGHT login (round-4 + the round-4b fix for roborev finding 1). The auth
 * runtime + token provider are a page-lifetime singleton, so the in-flight guard is
 * MODULE-level (matching that model) rather than a per-mount ref: a StrictMode
 * remount's `login()` must observe the SAME in-flight promise.
 *
 * The guard tracks the in-flight WebID ALONGSIDE its promise. While a login is
 * running:
 *  - a second `login()` for the SAME WebID (a double-click / StrictMode remount)
 *    AWAITS the in-flight promise — exactly one login proceeds, the other is a
 *    clean shared await/no-op;
 *  - a second `login()` for a DIFFERENT WebID REJECTS cleanly WITHOUT starting an
 *    overlapping probe. The round-4 design (before finding 1) returned the in-flight
 *    promise unconditionally, so `login("bob")` while `login("alice")` ran resolved
 *    as if BOB had logged in — a false-positive for a different identity. Rejecting
 *    is correct: Bob was never attempted, so his promise must not resolve as success.
 *
 * Either way there is never a SECOND concurrent login, which is what keeps the
 * provider's generation-scoped probe proof collision-free: no second login can
 * overwrite the first's probe registration or upgrade a same-URL request inside the
 * login's generation window.
 */
let inFlight: { id: string; promise: Promise<void> } | null = null;

/**
 * Build + globally-register the auth runtime EXACTLY ONCE per page. Repeated
 * calls (e.g. a StrictMode double-mount) return the same in-flight/settled
 * promise without re-snapshotting fetch or re-patching the global.
 *
 * The provider is given `getCodeThroughHolder`, NOT a `getCode` bound to one
 * element: the singleton outlives any single <authorization-code-flow> element, so
 * binding the first element here would leave the singleton calling a StrictMode-
 * removed element forever. The holder is updated on every mount; the singleton
 * reads the latest from it at authentication time.
 */
function getAuthRuntime(cfg: AuthRuntimeConfig): Promise<AuthRuntime> {
  if (authRuntimeSingleton) return authRuntimeSingleton;
  authRuntimeSingleton = (async () => {
    // Snapshot the pristine global fetch BEFORE the manager patches it — captured
    // here, inside the once-only guard, so a second effect pass can never grab the
    // already-patched fetch as the "pristine" baseline.
    const profileFetch = globalThis.fetch.bind(globalThis);
    const { ReactiveFetchManager } = await import("@solid/reactive-authentication");
    const provider = new WebIdDPoPTokenProvider(
      cfg.callbackUri,
      // getCode reads the CURRENT mounted element from the module-level holder —
      // never a first-mount element a StrictMode remount removed.
      getCodeThroughHolder,
      cfg.getWebId,
      {
        clientId: cfg.clientId,
        allowInsecureLoopback: cfg.allowInsecureLoopback,
        profileFetch,
      },
    );
    const manager = new ReactiveFetchManager([provider]);
    manager.registerGlobally(); // patched exactly once for the page lifetime.
    return { provider, profileFetch };
  })().catch((e) => {
    // A failed build must not poison the singleton — allow a later retry.
    authRuntimeSingleton = null;
    throw e;
  });
  return authRuntimeSingleton;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const flowRef = useRef<AuthorizationCodeFlow>(null);
  // The token provider + pristine fetch, resolved from the page-lifetime singleton.
  const providerRef = useRef<WebIdDPoPTokenProvider | null>(null);
  // The original, un-upgrading fetch snapshotted BEFORE registerGlobally patches
  // the global — used for the pre-popup public profile read so it can never
  // recurse into the provider on a 401.
  const profileFetchRef = useRef<typeof fetch | null>(null);
  const [ready, setReady] = useState(false);
  const [webId, setWebId] = useState<string | null>(null);
  const [session, setSession] = useState<DerivedSession | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Acquire the auth runtime, client-side, after the element exists. The runtime
  // is a page-lifetime singleton (getAuthRuntime), so a StrictMode double-mount
  // re-uses it instead of re-patching the global fetch (Finding 2).
  useEffect(() => {
    let cancelled = false;
    const ui = flowRef.current;
    if (!ui) return;
    const origin = location.origin;
    // Publish THIS mount's element to the module-level holder so the page-lifetime
    // singleton's getCode always drives the CURRENT live element. Under StrictMode
    // the first element is unmounted right after this effect runs; the second mount
    // overwrites the holder with its (live) element — so the singleton never ends
    // up bound to a removed element.
    const getCode: GetCodeCallback = ui.getCode.bind(ui);
    authFlowHolder.current = getCode;
    getAuthRuntime({
      callbackUri: new URL("/callback.html", location.href).toString(),
      clientId: new URL("/clientid.jsonld", location.href).toString(),
      // Only a localhost deployment may target an HTTP/loopback issuer.
      allowInsecureLoopback: isLoopbackOrigin(origin),
      // Read the latest pending WebID through the module-level holder (not a
      // per-mount ref the singleton's closure would freeze).
      getWebId: async () => {
        const id = pendingWebIdHolder.current;
        if (!id) throw new Error("No WebID set for login");
        return id;
      },
    })
      .then(({ provider, profileFetch }) => {
        if (cancelled) return;
        providerRef.current = provider;
        profileFetchRef.current = profileFetch;
        setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      // Only relinquish the holder if it still points at THIS element's getCode —
      // a later mount may already have replaced it (StrictMode remount). Never null
      // out a newer element's getCode.
      if (authFlowHolder.current === getCode) authFlowHolder.current = null;
    };
  }, []);

  // The actual login body — run AT MOST ONCE concurrently via the module-level
  // single-flight gate in `login` below.
  const doLogin = useCallback(async (id: string) => {
    setError(null);
    setLoggingIn(true);
    // IDENTITY CHANGE — drop EVERY trace of any prior identity FIRST (Finding 1):
    //  - reset the provider so its cached issuer, per-issuer sessions (DPoP keys +
    //    access tokens), authenticated-WebID claim, and token-attach count are gone
    //    — a login as a different WebID can never reuse the previous user's session;
    //  - clear session-derived React state (pod root, etc.) so nothing from WebID-A
    //    is rendered while authenticating as WebID-B.
    providerRef.current?.reset();
    setWebId(null);
    setSession(null);
    pendingWebIdHolder.current = id;
    // Snapshot THIS login's generation immediately AFTER reset() — it equals the
    // generation the probe will run in. Single-flight (the `login` wrapper) means
    // no other login advances the generation between here and the assertion below,
    // so the generation-scoped probe proof is unambiguous for THIS login.
    const loginGeneration = providerRef.current?.loginGeneration() ?? -1;
    try {
      // Read the PUBLIC profile FIRST (pristine fetch) so an unusable WebID errors
      // early — before any popup — and gives us the storage to probe.
      const pub = await readProfile(id, profileFetchRef.current ?? undefined);
      // Defence-in-depth: the provider-wide attach-count delta (per-attempt, not a
      // sticky flag) is kept alongside the per-probe proof below.
      const tokensAttachedBefore = providerRef.current?.tokensAttachedCount() ?? 0;
      // PER-PROBE PROOF (primary): register this probe Request on the provider (by
      // object identity, with a URL+generation single-use fallback) — NOT a network
      // header. The provider records an upgrade in THIS generation iff it actually
      // upgrades THIS probe — so we can prove THIS login's probe was token-upgraded,
      // not merely that "some request" was (a concurrent upgraded request for the
      // SAME WebID can bump the provider-wide count, but cannot satisfy our own
      // generation-scoped probe proof). Putting nothing on the wire keeps the probe
      // a "simple" CORS request, so a cross-origin pod does not reject a preflight
      // before the 401/upgrade path can run.
      //
      // Probe a protected resource via the PATCHED global fetch: a 401 triggers the
      // popup → token mint → retry. The retry's status + whether THIS probe was
      // token-upgraded prove login. A storage root is private on CSS/PSS by default,
      // so it 401s. Build the Request OBJECT first and register it before fetching —
      // the provider matches the id off this exact object (or its url-with-fragment
      // after the manager's re-wrap).
      //
      // FINDING 2 (round-4b): tag the probe URL with a unique unguessable fragment
      // (#probe-<uuid>). It is the UNFORGEABLE in-process marker that lets the
      // provider's URL fallback recognise THIS exact probe and reject an unrelated
      // same-base-URL data fetch — while being stripped on the wire (RFC 3986 §3.5),
      // so the pod still sees a plain GET to the storage root, no custom header, no
      // CORS preflight.
      const probeBase = pub.storages[0] ?? new URL("/", id).toString();
      const probeRequest = new Request(withProbeFragment(probeBase), { method: "GET" });
      providerRef.current?.beginLoginProbe(probeRequest);
      let res: Response;
      try {
        res = await fetch(probeRequest);
      } finally {
        // Drop the active probe registration regardless of outcome (e.g. a public
        // 200 with no 401 → no upgrade ran), so a later request can never match it.
        providerRef.current?.endLoginProbe();
      }
      const tokensAttachedAfter = providerRef.current?.tokensAttachedCount() ?? 0;
      const assessment = assessLoginProbe({
        status: res.status,
        tokensAttachedBefore,
        tokensAttachedAfter,
      });
      if (!assessment.ok) throw new Error(assessment.message);
      // The primary, per-probe gate: THIS login's probe must have been token-
      // upgraded IN THIS LOGIN'S GENERATION. A concurrent same-WebID upgrade for a
      // DIFFERENT request cannot satisfy it.
      if (!providerRef.current?.wasLoginProbeUpgraded(loginGeneration)) {
        throw new Error(
          "Login did not complete — no token was attached to this login's own " +
            "request (the probed resource may be public, or a different request " +
            "was upgraded). For your security you were not logged in.",
        );
      }
      // PROVE the session authenticated AS the requested WebID — never infer
      // "logged in" from "a token is attached" (Finding 1). The OP's id_token
      // `webid`/`sub` claim is the identity it vouched for; if it doesn't match
      // what the user asked to log in as (e.g. a stale session leaked from a prior
      // identity, or an IdP that authenticated a different account), fail closed.
      const authedWebId = providerRef.current?.authenticatedWebId();
      if (!webIdsEqual(authedWebId, id)) {
        throw new Error(
          "Login did not complete — the identity provider authenticated a " +
            `different WebID (${authedWebId ?? "unknown"}) than the one requested ` +
            `(${id}). For your security you were not logged in.`,
        );
      }
      // Re-read the profile (now authenticated) and derive the session.
      const me = await readProfile(id);
      const derived = deriveSession(me);
      setWebId(id);
      setSession(derived);
    } catch (e) {
      // The attempt failed — clear the pending WebID AND drop any partial provider
      // state, so a half-established session can't leak into the next attempt.
      pendingWebIdHolder.current = null;
      providerRef.current?.reset();
      const msg =
        e instanceof AmbiguousIssuerError
          ? "This WebID lists multiple identity providers — multi-issuer choice is not yet wired in this host."
          : e instanceof Error
            ? e.message
            : String(e);
      setError(msg);
      throw e;
    } finally {
      setLoggingIn(false);
    }
  }, []);

  // SINGLE-FLIGHT login, WebID-SCOPED (round-4 + round-4b finding-1 fix). The gate
  // tracks the in-flight WebID alongside its promise:
  //  - SAME WebID in flight (double-click / StrictMode remount) → share the one
  //    in-flight promise; exactly one login proceeds, the other is a clean await.
  //  - DIFFERENT WebID in flight → REJECT cleanly without starting an overlapping
  //    probe. The pre-fix design returned the in-flight (other-WebID) promise, so a
  //    concurrent login for a different identity resolved as if THAT identity had
  //    logged in — a false-positive. Rejecting is the correct guard: this branch
  //    touches NO React state (it does not flip global loggingIn, which belongs to
  //    the in-flight attempt), it just hands back a rejected promise.
  // Either way there is never a second concurrent login, so the provider's
  // generation-scoped probe proof stays collision-free.
  const login = useCallback(
    (id: string): Promise<void> => {
      const existing = inFlight;
      // The WebID-scoped gate decision is a pure, unit-tested helper.
      const decision = decideSingleFlight(existing?.id ?? null, id, webIdsEqual);
      if (decision === "share" && existing) return existing.promise; // same WebID → share.
      if (decision === "reject") {
        // Different WebID → reject without overlapping the in-flight probe. Do NOT
        // touch React state: the in-flight attempt owns loggingIn/error.
        return Promise.reject(
          new Error(
            "A login for a different WebID is already in progress — wait for it to " +
              "finish or log out first.",
          ),
        );
      }
      const run = doLogin(id).finally(() => {
        // Clear the gate only if it still points at THIS run — never strand a later
        // login that already replaced it.
        if (inFlight?.promise === run) inFlight = null;
      });
      inFlight = { id, promise: run };
      return run;
    },
    [doLogin],
  );

  const logout = useCallback(() => {
    // RESET THE PROVIDER, not just React state (Finding 1): the in-memory issuer,
    // per-issuer sessions (DPoP key + access/refresh tokens), authenticated-WebID
    // claim, and token-attach count are all dropped, so a later login as a DIFFERENT
    // WebID cannot reuse this user's token/session and a login probe cannot look
    // authenticated with the stale token.
    providerRef.current?.reset();
    pendingWebIdHolder.current = null;
    setWebId(null);
    setSession(null);
    setError(null);
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ webId, session, loggingIn, error, ready, login, logout }),
    [webId, session, loggingIn, error, ready, login, logout],
  );

  return (
    <SessionContext.Provider value={value}>
      {/* The popup UI element. Kept mounted so getCode() has an element; the
          library renders its own dialog parts. */}
      <authorization-code-flow ref={flowRef} data-testid="solid-auth-flow" />
      {children}
    </SessionContext.Provider>
  );
}
