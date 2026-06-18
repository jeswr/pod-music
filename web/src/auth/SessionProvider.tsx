// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// SessionProvider — the ONE place auth is wired for the Pod Music static host.
// It mounts the browser-only <authorization-code-flow> popup element, builds a
// WebID-driven DPoP token provider bound to THIS origin's static Client
// Identifier Document, and installs the @jeswr/solid-elements PROACTIVE auth-fetch
// patch (`installProactiveAuthFetch`) so EVERY plain `fetch()` (including the ones
// inside @jeswr/fetch-rdf and the @jeswr/pod-music data layer) PROACTIVELY carries
// the DPoP token on the FIRST request to an allowed origin. The library's `fetch?:`
// seam can then be left as the ambient global — no per-call wiring.
//
// WHY THE SEAM, NOT THE RAW `ReactiveFetchManager` (task #123): the raw upstream
// manager sends every request UNAUTHENTICATED first and attaches the token only
// REACTIVELY on a 401 — per resource, with no origin/storage cache — so every
// distinct pod URL pays a wasted 401 → upgrade → retry (a library of N tracks paid
// N+1 wasted 401s: the container listing + one per-track read). The seam-based
// proactive patch attaches up front for an allowed origin (zero wasted 401s) AND
// enforces a real credential boundary (the provider's own `matches()` is
// unconditional; `isOriginAllowed` is the gate), so the token never rides
// cross-origin. The shared, generalized helper lives in @jeswr/solid-elements/auth
// (pod-music IMPORTS it — it is NOT a per-app copy).
//
// LOAD-BEARING HOUSE RULES (do not "simplify" away):
//  1. @solid/reactive-authentication is pure-ESM + browser-only (custom elements,
//     popups), and the WebIdDPoPTokenProvider builds on it. The provider lives in
//     ./webid-token-provider; the seam primitives are pure + tree-shakeable, so the
//     proactive patch carries no browser-only top-level evaluation (verified by the
//     build gate). The provider's login/restore/logout/DPoP invariants are UNCHANGED
//     by the #123 fetch-layer swap — only HOW the token is attached to fetches moved
//     from reactive (ReactiveFetchManager) to proactive (the seam).
//  2. The proactive patch is installed EXACTLY ONCE per page (its own once-only guard,
//     mirroring this file's auth-runtime singleton): a StrictMode double-mount re-uses
//     the install and never stacks a second patch over the first.
//  3. The client_id is the per-origin static Client Identifier Document at
//     `${origin}/clientid.jsonld` (generated at build by scripts/gen-clientid.mjs),
//     so the OP shows "Pod Music" on the consent screen instead of a throwaway
//     dynamic registration.
//  4. `allowInsecureLoopback` is enabled ONLY for a localhost origin (dev against
//     a local CSS over HTTP); a deployed HTTPS origin stays strict. It also gates
//     whether the proactive credential boundary admits an http:// loopback pod origin.

import {
  deriveProactiveAllowedOrigins,
  installProactiveAuthFetch,
  type ProactiveFetchInstall,
} from "@jeswr/solid-elements/auth";
import {
  decideSilentRestore,
  IndexedDbSessionStore,
  indexedDbAvailable,
  RememberedAccount,
  type SessionStore,
  shouldDropRememberedPointer,
  webIdsEqual as ssrWebIdsEqual,
} from "@jeswr/solid-session-restore";
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
import { authFlowHolder, getCodeThroughHolder, lazyElementGetCode } from "./auth-flow-holder";
import { planAutologin } from "./autologin-plan";
import { assessLoginProbe } from "./login-result";
import { readProfile } from "./profile";
import { type DerivedSession, deriveSession } from "./session-derivation";
import { decideSingleFlight } from "./single-flight";
import {
  AmbiguousIssuerError,
  consumePendingRedirectWebId,
  hasPendingRedirectLogin,
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
  /**
   * True while a full-page-redirect (autologin) login is being initiated or
   * completed — i.e. "Signing you in…". Distinct from {@link loggingIn} (the
   * interactive popup flow): autologin runs WITHOUT a user gesture (a deep-link or
   * a redirect return), so App/LoginScreen surface a restoring state rather than the
   * interactive login form.
   */
  autologinPending: boolean;
  /**
   * True while the mount-time SILENT SESSION RESTORE is in flight — i.e. a returning
   * user's persisted DPoP-bound refresh token is being redeemed (a token-endpoint
   * fetch, no popup). The app shows a brief "Restoring…" state rather than flashing
   * the login form, and falls back to login only on a genuine restore failure. Set
   * on mount, cleared when the restore resolves (restored OR fell through to login).
   */
  restoring: boolean;
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

// ── Silent session restore — the durable, PER-APP credential store + pointer ──
//
// Cross-app UX invariant #1: reopening a closed tab (without logging out) silently
// re-establishes the session from the persisted DPoP-bound refresh token — no
// popup, no iframe, no flash of the login screen. The audited CORE is
// @jeswr/solid-session-restore; here we wire the two PER-APP instances (a distinct
// IndexedDB DB name + localStorage pointer key, so pod-music never shares a session
// store or pointer with another suite app on a shared origin).

/** The IndexedDB database name for Pod Music's persisted refresh-token sessions. */
const SESSION_DB_NAME = "pod-music:sessions";
/** The localStorage key for Pod Music's credential-free remembered-account pointer. */
const REMEMBERED_ACCOUNT_KEY = "pod-music:remembered-account";

/**
 * The durable, WebID/issuer-scoped credential store, constructed ONCE (module
 * level) so the provider singleton and the restore effect share one connection
 * factory. `undefined` when IndexedDB is unavailable (SSR / a locked-down env) —
 * the provider then persists nothing and silent restore is a no-op (the app falls
 * back to interactive login), never a throw.
 */
const sessionStore: SessionStore | undefined = indexedDbAvailable()
  ? new IndexedDbSessionStore({ dbName: SESSION_DB_NAME })
  : undefined;

/** The credential-free WebID→issuer pointer that selects which issuer to restore. */
const rememberedAccount = new RememberedAccount(REMEMBERED_ACCOUNT_KEY);

/**
 * MODULE-LEVEL single-flight latch for the mount-time silent restore. The auth
 * runtime is a page-lifetime singleton and React.StrictMode double-invokes mount
 * effects, so the restore — which redeems a credential — must run AT MOST ONCE per
 * page. The first call caches its promise here; a concurrent/second mount AWAITS
 * the same promise rather than firing a second refresh grant. Reset only by a full
 * page load (module re-eval).
 */
let silentRestoreInFlight: Promise<SilentRestoreResult> | null = null;

/** The outcome of {@link runSilentRestore}, consumed by the mount effect. */
type SilentRestoreResult = { kind: "restored"; webId: string; issuer: string } | { kind: "login" };

/**
 * MODULE-LEVEL singleton for the auth runtime — the fix for the global-fetch
 * patch lifecycle bug (Finding 2). The proactive patch (`installProactiveAuthFetch`)
 * monkey-patches `globalThis.fetch`, so a naive per-mount effect would be unsafe:
 * under React.StrictMode the mount effect runs TWICE, and a second pass could (a)
 * snapshot the ALREADY-PATCHED fetch as if it were pristine, and (b) install a second
 * patch, STACKING two patches that double-handle auth and break plain reads. Two
 * guards make this safe: this auth-runtime singleton (one provider per page) AND
 * `installProactiveAuthFetch`'s OWN once-only guard (one patch + one pristine-fetch
 * capture per page). Hoisting the build+install out of React, behind both guards,
 * makes it run exactly once for the lifetime of the page regardless of how many times
 * the effect mounts.
 */
interface AuthRuntime {
  provider: WebIdDPoPTokenProvider;
  /** The original, un-upgrading fetch captured BEFORE the proactive patch installed. */
  profileFetch: typeof fetch;
  /**
   * The proactive-auth-fetch install handle (the @jeswr/solid-elements seam-based
   * replacement for `ReactiveFetchManager.registerGlobally()`). The SessionProvider
   * calls `setState` on login / silent-restore / logout to update the live credential
   * boundary (the allowed-origins set + the provider), so the patched global fetch
   * PROACTIVELY attaches the token on the FIRST request to an allowed origin — no
   * per-resource 401-dance — and authenticates NOTHING when logged out.
   */
  fetchInstall: ProactiveFetchInstall;
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

// ── Autologin (full-page redirect deep-link) ──────────────────────────────────
//
// The Pod Manager deep-links here with `#autologin/<encodeURIComponent(webid)>`.
// Because the user already has a live IdP session at the shared broker AND the app
// was previously authorized, a full-page Solid-OIDC redirect comes straight back
// ALREADY AUTHENTICATED — silent SSO, no credential prompt. (A popup auto-opened on
// load has no user gesture and is browser-blocked, which is why this MUST be a
// full-page redirect — see WebIdDPoPTokenProvider.beginRedirectLogin.)

/** The deep-link fragment prefix that triggers a fresh autologin (Case B). */
const AUTOLOGIN_FRAGMENT_PREFIX = "#autologin/";

/**
 * sessionStorage sentinel key. ONE-SHOT loop guard: set to the WebID the instant a
 * fresh autologin is initiated, and consulted before re-attempting. If the broker
 * bounces back to the app root WITHOUT a `?code` (SSO unavailable / user declined /
 * prior authorization revoked) and the deep-link fragment is somehow seen again,
 * the already-set sentinel makes us fall through to the login screen instead of
 * looping. Cleared on a successful completion, and on a non-code bounce.
 */
const AUTOLOGIN_SENTINEL_KEY = "autologin-attempted";

/** Read the one-shot autologin sentinel (the WebID we last attempted), or null. */
function readAutologinSentinel(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(AUTOLOGIN_SENTINEL_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Set the one-shot autologin sentinel to the WebID being attempted. */
function setAutologinSentinel(webId: string): void {
  try {
    globalThis.sessionStorage?.setItem(AUTOLOGIN_SENTINEL_KEY, webId);
  } catch {
    // sessionStorage unavailable — the fragment-clean + once-guard still prevent loops.
  }
}

/** Clear the one-shot autologin sentinel (idempotent). */
function clearAutologinSentinel(): void {
  try {
    globalThis.sessionStorage?.removeItem(AUTOLOGIN_SENTINEL_KEY);
  } catch {
    // sessionStorage unavailable — nothing to clear.
  }
}

/**
 * MODULE-LEVEL once-guard so the autologin mount effect fires its redirect/complete
 * AT MOST ONCE per page, even under React.StrictMode (which double-invokes mount
 * effects in dev). The sentinel + persisted-redirect record are the durable
 * cross-navigation guards; this in-memory latch additionally stops the SAME render
 * pass's double-mount from firing two redirects. Reset only by a full page load
 * (module re-eval).
 */
let autologinEffectRan = false;

/**
 * The URL hash + search captured AT MODULE EVAL — i.e. BEFORE any React effect runs
 * and can mutate `location` (the autologin effect strips the `#autologin/…` fragment
 * / cleans the `?code&state` query EARLY, synchronously, before its async
 * `beginRedirectLogin()` has persisted a pending-redirect record). The silent-restore
 * gate MUST consult THIS pristine snapshot — not the live `location`, which the
 * autologin effect may already have cleaned — or a fresh `#autologin` load would slip
 * past `autologinTakesPrecedence` (clean URL + not-yet-persisted record) and race an
 * explicit login (roborev HIGH). Captured defensively (location may be absent in a
 * non-browser import). Reset only by a full page load (module re-eval).
 */
const INITIAL_URL: { hash: string; search: string } = {
  hash: globalThis.location?.hash ?? "",
  search: globalThis.location?.search ?? "",
};

/**
 * Set SYNCHRONOUSLY by the autologin mount effect the instant it commits to handling
 * an explicit autologin / redirect flow this load (any non-`none` plan action). The
 * silent-restore gate also checks this flag, so even if the autologin effect runs
 * FIRST and cleans the URL before its async redirect record is persisted, the
 * restore effect still defers (roborev HIGH — the second layer of the race fix,
 * complementing {@link INITIAL_URL}). Reset only by a full page load.
 */
let autologinInProgress = false;

/**
 * Parse the WebID out of a `#autologin/<encodeURIComponent(webid)>` fragment.
 * Returns the decoded WebID, or null if the hash is not an autologin deep-link or
 * decoding fails. Pure + exported for unit testing.
 */
export function parseAutologinFragment(hash: string): string | null {
  if (!hash.startsWith(AUTOLOGIN_FRAGMENT_PREFIX)) return null;
  const encoded = hash.slice(AUTOLOGIN_FRAGMENT_PREFIX.length);
  if (!encoded) return null;
  try {
    const webId = decodeURIComponent(encoded);
    return webId.length > 0 ? webId : null;
  } catch {
    return null; // malformed percent-encoding — not a usable deep-link.
  }
}

/** True when the current URL carries an OAuth `?code` AND `?state` (a redirect return). */
export function hasAuthCodeParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("code") && params.has("state");
}

/**
 * True when the current URL carries an OAuth `?error` AND `?state` (a FAILED redirect
 * return — e.g. `?error=login_required` / `?error=access_denied`: the broker declined
 * silent SSO or the user declined). A redirect ERROR return, as opposed to the success
 * return {@link hasAuthCodeParams} detects. The `state` is required so a stray `error`
 * query unrelated to our flow is not mistaken for a redirect return.
 */
export function hasAuthErrorParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("error") && params.has("state");
}

/**
 * Strip BOTH the query (`?code&state…`) and the fragment from a URL, leaving the
 * path. Used to clean the address bar after a redirect return / before a fresh
 * autologin redirect so a refresh / bounce cannot re-trigger and the WebID is not
 * left on display. Pure + exported for unit testing.
 */
export function cleanedUrl(href: string): string {
  const u = new URL(href);
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * Whether an EXPLICIT autologin / redirect flow is in play on this load — a
 * `#autologin/<webid>` deep-link, an OAuth `?code&state` / `?error&state` redirect
 * return, OR a persisted pending redirect record. When any is true, the autologin
 * mount effect OWNS this load and silent restore must DEFER to it (the explicit
 * deep-link is a stronger, user/Pod-Manager-initiated intent than a passive restore
 * — and running both would race two session establishments). Pure args so the
 * gating decision is unit-testable. `hasPending` is injected (it reads
 * sessionStorage) so the decision stays pure.
 */
export function autologinTakesPrecedence(
  hash: string,
  search: string,
  hasPending: boolean,
): boolean {
  return (
    parseAutologinFragment(hash) !== null ||
    hasAuthCodeParams(search) ||
    hasAuthErrorParams(search) ||
    hasPending
  );
}

/**
 * Whether THIS `establishSessionFor` is STILL the current login by the time it is ready to
 * arm a proactive boundary + publish the logged-in UI (roborev HIGH). Pure + exported so the
 * race is unit-testable WITHOUT a React render.
 *
 * `establishSessionFor` awaits several steps (`resolvedIssuer`, `readProfile`,
 * `persistSession`) after snapshotting its generation. A logout()/new login() racing those
 * awaits advances the provider generation (via reset()) AND clears the boundary. If we
 * re-armed + published unconditionally we would re-enable authenticated fetches against a
 * reset/stale provider behind a logged-out UI AND publish a stale session, or — for a NEW
 * login — clobber the new login's freshly-armed boundary. Returns true ONLY when the live
 * generation still equals the snapshot AND the provider's authenticated WebID still equals
 * the requested identity — fail-closed (false) on EITHER mismatch, so the caller bails
 * WITHOUT touching the boundary (clearing it would wipe a newer login's boundary).
 */
export function establishStillCurrent(inputs: {
  establishGeneration: number;
  currentGeneration: number;
  requestedWebId: string;
  currentAuthenticatedWebId: string | undefined;
  webIdsEqual: (a: string | undefined, b: string | undefined) => boolean;
}): boolean {
  return (
    inputs.currentGeneration === inputs.establishGeneration &&
    inputs.webIdsEqual(inputs.currentAuthenticatedWebId, inputs.requestedWebId)
  );
}

/**
 * Build the auth runtime + install the proactive auth-fetch patch EXACTLY ONCE per
 * page. Repeated calls (e.g. a StrictMode double-mount) return the same
 * in-flight/settled promise without re-snapshotting fetch or re-patching the global.
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
    // PROACTIVE AUTH FETCH (task #123) — adopt the @jeswr/solid-elements auth seam
    // instead of the raw `ReactiveFetchManager`. `installProactiveAuthFetch` snapshots
    // the pristine global fetch (so `profileFetch` is provably un-upgrading) and patches
    // the global EXACTLY ONCE behind its own once-only guard. Unlike the old reactive
    // manager (token attached only REACTIVELY on a 401, per resource, no origin gate),
    // the patched wrapper PROACTIVELY attaches the DPoP token on the FIRST request to an
    // ALLOWED origin and fail-closes for foreign origins — eliminating the per-resource
    // 401-dance. The credential boundary is provider-less/empty here (everything public)
    // until a login / silent-restore calls `fetchInstall.setState` with the live session
    // + allowed origins (see `establishSessionFor` / the logout teardown below).
    const fetchInstall = installProactiveAuthFetch();
    const profileFetch = fetchInstall.pristineFetch;
    // REGISTER the <authorization-code-flow> custom element. Its definition runs as a
    // module SIDE EFFECT of @solid/reactive-authentication (customElements.define in
    // AuthorizationCodeFlow.js). We adopted the proactive seam instead of the package's
    // ReactiveFetchManager (task #123), but the package is STILL the home of the popup
    // element the WebIdDPoPTokenProvider drives via getCode — so we MUST keep a VALUE
    // (side-effect) dynamic import here. A `import type {…}` is erased at compile and would
    // NOT register the element, leaving interactive login hung on `customElements.whenDefined`
    // (the roborev HIGH finding + the cause the e2e popup never opened). The dynamic import
    // keeps the browser-only element OUT of module-eval / SSR (the original Rule 1); we just
    // no longer construct a ReactiveFetchManager from it.
    await import("@solid/reactive-authentication");
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
        // The durable credential store backing silent session restore. The provider
        // persists the DPoP-bound refresh token here on a confirmed login and
        // restoreIssuer() rebuilds the session from it on reload.
        ...(sessionStore ? { sessionStore } : {}),
      },
    );
    return { provider, profileFetch, fetchInstall };
  })().catch((e) => {
    // A failed build must not poison the singleton — allow a later retry.
    authRuntimeSingleton = null;
    throw e;
  });
  return authRuntimeSingleton;
}

/**
 * The mount-time SILENT SESSION RESTORE (cross-app UX invariant #1). Run ONCE on
 * load (single-flighted via {@link silentRestoreInFlight}), BEFORE the app decides
 * "logged out", and ONLY when no explicit autologin deep-link / redirect return is
 * in play (that path WINS — the caller gates on it). It reads the remembered
 * pointer, runs the PURE {@link decideSilentRestore} over the provider's
 * {@link WebIdDPoPTokenProvider.restoreIssuer thin restore wrapper}, and disposes
 * of the outcome:
 *
 *  - `restored` → re-confirm the pointer, return the restored WebID/issuer (the
 *    caller establishes the React session). The provider has already pinned the
 *    session in memory, so a later private read upgrades with no re-prompt.
 *  - `webid-mismatch` → the refresh grant SUCCEEDED but authenticated a DIFFERENT
 *    WebID than remembered. `restoreSession` already pinned + re-persisted the
 *    WRONG WebID one layer down, so TEAR DOWN FAIL-CLOSED, in this exact order
 *    (the package README's order): (1) `reset()` the in-memory session FIRST, then
 *    (2) `forgetIssuer` the durable credential, then (3) clear the pointer. This is
 *    the fail-closed WebID-binding guard — a restored session is NEVER asserted for
 *    an identity that does not match the one we remembered.
 *  - any other `login` reason → keep/drop the remembered pointer per the pure
 *    matrix + the tri-state credential presence ({@link shouldDropRememberedPointer}).
 *
 * Never throws: a thrown restore is treated as `login`/`restore-failed` by the pure
 * decider (fail-closed). Exported for unit testing.
 */
export async function runSilentRestore(
  provider: WebIdDPoPTokenProvider,
): Promise<SilentRestoreResult> {
  const r = rememberedAccount.read();
  const decision = await decideSilentRestore({
    lastActiveWebId: r?.webId,
    remembered: r ? [r] : [],
    restoreIssuer: (issuer) => provider.restoreIssuer(new URL(issuer)),
    webIdsEqual: ssrWebIdsEqual,
  });

  if (decision.outcome === "restored") {
    // Re-confirm the pointer (idempotent) so the last-active record stays current.
    rememberedAccount.write(decision.webId, decision.issuer);
    return { kind: "restored", webId: decision.webId, issuer: decision.issuer };
  }

  // FAIL-CLOSED teardown for a WebID mismatch — reset the in-memory session FIRST,
  // THEN forget the durable credential, THEN clear the pointer (README order).
  if (decision.reason === "webid-mismatch") {
    provider.reset();
    if (r?.issuer) await provider.forgetIssuer(new URL(r.issuer));
    rememberedAccount.clear();
    return { kind: "login" };
  }

  // Any other login reason: keep the pointer iff the credential may still be there
  // (a transient blip preserved it / the store read was inconclusive); drop it when
  // it is definitively gone or unusable.
  const presence = r?.issuer ? await provider.hasPersistedFor(new URL(r.issuer)) : "absent";
  if (shouldDropRememberedPointer(decision.reason, presence)) rememberedAccount.clear();
  return { kind: "login" };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const flowRef = useRef<AuthorizationCodeFlow>(null);
  // The token provider + pristine fetch, resolved from the page-lifetime singleton.
  const providerRef = useRef<WebIdDPoPTokenProvider | null>(null);
  // The original, un-upgrading fetch snapshotted BEFORE the proactive patch installs —
  // used for the pre-popup public profile read so it can never recurse into the
  // provider on a 401.
  const profileFetchRef = useRef<typeof fetch | null>(null);
  // The proactive-auth-fetch install handle (task #123). The session-establish /
  // logout paths call `fetchInstallRef.current.setState(...)` to update the live
  // credential boundary (the allowed-origins set + the provider) so the patched global
  // fetch proactively attaches the token to allowed origins while logged in, and
  // authenticates NOTHING when logged out.
  const fetchInstallRef = useRef<ProactiveFetchInstall | null>(null);
  // localhost / loopback → admit an http:// pod origin into the credential boundary
  // (dev / test only). Computed once (the origin can't change for a page lifetime).
  const allowInsecureLoopbackRef = useRef<boolean>(
    typeof location !== "undefined" && isLoopbackOrigin(location.origin),
  );
  const [ready, setReady] = useState(false);
  const [webId, setWebId] = useState<string | null>(null);
  // A ref mirroring the LATEST `webId`, so async callbacks (the silent-restore
  // promise) can re-check "is a session already established?" without taking `webId`
  // as an effect dependency (which would re-run mount-only effects on login/logout).
  const webIdRef = useRef<string | null>(null);
  webIdRef.current = webId;
  const [session, setSession] = useState<DerivedSession | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [autologinPending, setAutologinPending] = useState(false);
  // Start TRUE: on a fresh load the mount-time silent restore may rebuild a session,
  // so the app shows "Restoring…" rather than flashing the login form until the
  // restore (or its fall-through to login) resolves. Cleared in the restore effect.
  const [restoring, setRestoring] = useState(true);
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
    //
    // COLD-START SAFETY (roborev HIGH): @solid/reactive-authentication is loaded by
    // a DYNAMIC import (`getAuthRuntime`), and `customElements.define(
    // "authorization-code-flow", …)` lives at the top of that chunk. So on a COLD
    // first mount this effect runs BEFORE the import resolves and BEFORE the element
    // is upgraded — `ui.getCode` is still `undefined`. Eagerly binding it here
    // (`ui.getCode.bind(ui)`) would THROW on that very first load and break login.
    //
    // The holder therefore gets a LAZY accessor (`lazyElementGetCode`) that reads
    // `getCode` at CALL time (login time), not at mount time. By the time the
    // singleton invokes it (inside `login()`, which has awaited the dynamic import +
    // element registration), the element is upgraded and `getCode` is defined; and
    // as belt-and-braces the accessor awaits `customElements.whenDefined` first if
    // the element is somehow still un-upgraded — so even a very-early login can't
    // throw. We do NOT touch `ui.getCode` until invocation.
    const getCode: GetCodeCallback = lazyElementGetCode(ui);
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
      .then(({ provider, profileFetch, fetchInstall }) => {
        if (cancelled) return;
        providerRef.current = provider;
        profileFetchRef.current = profileFetch;
        fetchInstallRef.current = fetchInstall;
        setReady(true);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          // Runtime init FAILED → `ready` never flips true, so the silent-restore
          // effect (gated on `ready`) would never clear `restoring` and the UI would
          // be STUCK on "Restoring…", hiding the login screen + this error (roborev
          // MEDIUM). Clear it here so the LoginScreen (with the error) is shown.
          setRestoring(false);
        }
      });
    return () => {
      cancelled = true;
      // Only relinquish the holder if it still points at THIS element's getCode —
      // a later mount may already have replaced it (StrictMode remount). Never null
      // out a newer element's getCode.
      if (authFlowHolder.current === getCode) authFlowHolder.current = null;
    };
  }, []);

  // PROACTIVE FETCH (task #123): drop the live credential boundary back to "authenticate
  // nothing" (no provider + empty allowed-origins). Called on logout and at the start of
  // an identity-switch login, so a request racing the teardown is fail-closed at the gate
  // (the patched global fetch leaves it unauthenticated). A no-op until the runtime has
  // installed the patch (fetchInstallRef set).
  const clearProactiveBoundary = useCallback(() => {
    fetchInstallRef.current?.setState({ provider: null, allowedOrigins: new Set() });
  }, []);

  // The SHARED post-authentication step, used by BOTH the popup login (doLogin) and
  // the full-page-redirect autologin completion. By the time this runs the provider
  // has an established, token-attached session whose `authenticatedWebId` is the
  // identity the OP vouched for. We PROVE that matches the WebID the user asked to
  // log in as (never inferring "logged in" from a token being attached — the
  // Finding-1 invariant), then re-read the (now authenticated) profile and derive
  // the session into React state. Throws (fail-closed) on a WebID mismatch.
  const establishSessionFor = useCallback(async (id: string) => {
    const authedWebId = providerRef.current?.authenticatedWebId();
    if (!webIdsEqual(authedWebId, id)) {
      throw new Error(
        "Login did not complete — the identity provider authenticated a " +
          `different WebID (${authedWebId ?? "unknown"}) than the one requested ` +
          `(${id}). For your security you were not logged in.`,
      );
    }
    // GENERATION FENCE (roborev HIGH): snapshot the provider's login generation up front.
    // A logout() / new login() advances it (via reset()), so re-checking it (with the
    // authenticated WebID) before each boundary arm + the UI publish below lets us BAIL if
    // this establish was superseded MID-FLIGHT (during the resolvedIssuer / profile /
    // persist awaits). Without the fence a racing logout/new-login could (a) re-arm the
    // boundary against a reset/stale provider behind a logged-out UI, (b) republish a stale
    // webId/session, or (c) — on the superseded path — wipe a NEWER login's boundary. -1
    // when no provider (defensive). See `establishStillCurrent`.
    const establishGeneration = providerRef.current?.loginGeneration() ?? -1;
    // PROACTIVE FETCH (task #123): arm a PROVISIONAL credential boundary (the WebID +
    // the resolved issuer origins) BEFORE the authenticated profile re-read below, so
    // that read actually carries the token. The SILENT-RESTORE path reaches its own
    // establishRestoredSession WITHOUT the login flow's pre-probe arming, and an
    // autologin-completion reaches HERE without it too — so without this the "now
    // authenticated" profile re-read would be UNAUTHENTICATED: a private profile would
    // fail (or, for a WebID whose storage lives on another origin, degrade to the wrong
    // fallback pod root and restore a wrong session shape — the roborev MEDIUM finding).
    // The pod-root boundary is the AUTHORITATIVE one re-armed once the profile yields
    // derived.podRoot (below). The popup-login path has already armed an equivalent
    // boundary via the probe; re-arming with the same origins is idempotent. The issuer
    // is folded in from the provider's already-resolved issuer (pod-music's provider
    // exposes it only via the async `resolvedIssuer()` — there is no sync `currentIssuer`
    // accessor as in pod-drive; awaiting it here is cheap, the promise is already settled
    // by the time login/restore reaches this point). It is best-effort — the WebID origin
    // is the load-bearing target for the profile re-read; the OIDC endpoints ride the
    // pristine fetch (the re-entrancy guard), so they do not depend on this boundary.
    const provisionalIssuer = await providerRef.current?.resolvedIssuer();
    // GENERATION FENCE for the PROVISIONAL arm (roborev HIGH): `resolvedIssuer()` is itself
    // an await, so a logout/new-login can WIN during it. Arming the provisional boundary
    // unconditionally afterwards would set origins for THIS (now-stale) WebID `id` against
    // the CURRENT provider — which, after a new login, belongs to a DIFFERENT user, so the
    // new user's token could be attached to the OLD user's origin (and a logout's cleared
    // boundary would be re-enabled behind a logged-out UI). Re-check BEFORE arming + before
    // the profile read: if superseded, return WITHOUT touching the boundary (the superseding
    // logout already cleared it / the new login already armed its own — clearing here would
    // wipe the newer login's boundary) and WITHOUT reading a stale profile.
    if (
      !establishStillCurrent({
        establishGeneration,
        currentGeneration: providerRef.current?.loginGeneration() ?? -1,
        requestedWebId: id,
        currentAuthenticatedWebId: providerRef.current?.authenticatedWebId(),
        webIdsEqual,
      })
    ) {
      return;
    }
    fetchInstallRef.current?.setState({
      provider: providerRef.current,
      allowedOrigins: deriveProactiveAllowedOrigins({
        webId: id,
        issuer: provisionalIssuer?.href,
        allowInsecureLoopback: allowInsecureLoopbackRef.current,
      }),
    });
    // Re-read the profile (now authenticated) and derive the session FIRST. For the
    // interactive popup login this read failing means the login FAILED — doLogin's
    // catch resets in-memory state and surfaces the error. So we must NOT persist the
    // durable credential / pointer until AFTER the profile read + derivation succeed
    // (roborev MEDIUM): persisting first would leave a credential + pointer behind that
    // silently restores, on the next load, a login the UI reported as FAILED. (The
    // silent-restore path is different — there a profile blip is fail-open because the
    // restored token is already proof; that lives in establishRestoredSession.)
    const me = await readProfile(id);
    const derived = deriveSession(me);
    // GENERATION FENCE for the DURABLE persist + pointer write (roborev HIGH, 2nd round).
    // `readProfile` above is an await, so a logout()/new login() can WIN during it. The
    // durable persist + remembered-pointer write below COMMIT restore state to disk — if a
    // logout raced the profile read, persisting here would leave a credential + pointer that
    // SILENTLY RESTORES an already-logged-out session next load; and after a NEW login (a
    // different user) it would persist/point at the OLD identity. So re-check BEFORE the
    // durable write: if superseded, BAIL — the superseding actor owns the durable state (a
    // logout is tearing it down, a new login will persist its own). The `resolvedIssuer()`
    // below is itself an await, but the persist/write are guarded as a unit by this check
    // plus the post-write authoritative fence (the in-between window only advances the
    // generation, which that fence then catches before any publish).
    if (
      !establishStillCurrent({
        establishGeneration,
        currentGeneration: providerRef.current?.loginGeneration() ?? -1,
        requestedWebId: id,
        currentAuthenticatedWebId: providerRef.current?.authenticatedWebId(),
        webIdsEqual,
      })
    ) {
      return;
    }
    // The login fully succeeded — NOW persist the DPoP-bound refresh credential for
    // SILENT RESTORE and record the remembered WebID→issuer pointer (after the identity
    // check above proved the OP authenticated AS `id`). Best-effort: a persistence
    // failure must not fail an otherwise-good login. Write the pointer ONLY when
    // persistSession actually wrote a credential (roborev LOW) — else we'd leave a
    // pointer to a non-restorable session, causing a doomed restore next load.
    //
    // B7P ORDERING (task #91 / #123): the durable credential is persisted BEFORE the
    // logged-in UI is published (`setWebId`/`setSession` below). A tab-close racing this
    // step therefore can never leave a PUBLISHED-but-UNPERSISTED session (the UI shows
    // logged-in but the next load's silent restore finds no credential). Persist → THEN
    // publish; do not reorder.
    const issuer = await providerRef.current?.resolvedIssuer();
    if (issuer) {
      // Pass THIS login's snapshot generation so persistSession FENCES the durable put
      // INTERNALLY (roborev HIGH): it re-checks the generation after its own `await pending`
      // and refuses to enqueue the credential write if a racing logout/new-login advanced it
      // — closing the resurrect-logged-out-credential race the SessionProvider-level fence
      // alone could not (persistSession's internal await is invisible from here).
      const persisted = await providerRef.current?.persistSession(issuer, id, establishGeneration);
      // POST-PERSIST GENERATION FENCE for the remembered-pointer write (roborev HIGH, 3rd
      // round): `persistSession()` is itself an await, so a logout()/new login() can WIN
      // during it and CLEAR or REPLACE the pointer. Without re-checking here, this stale
      // establish would then re-write `rememberedAccount` for an already-logged-out /
      // superseded session — resurrecting restore state the superseding flow just tore down.
      // The post-write authoritative fence below only blocks the UI publish, which is too
      // late to un-commit the pointer. So re-check AFTER the persist await, immediately
      // before the pointer write: write ONLY when this establish is still current.
      if (
        persisted &&
        establishStillCurrent({
          establishGeneration,
          currentGeneration: providerRef.current?.loginGeneration() ?? -1,
          requestedWebId: id,
          currentAuthenticatedWebId: providerRef.current?.authenticatedWebId(),
          webIdsEqual,
        })
      ) {
        rememberedAccount.write(id, issuer.href);
      }
    }
    // GENERATION FENCE for the AUTHORITATIVE boundary-arm + UI publish (roborev HIGH). The
    // steps above (`resolvedIssuer`, `readProfile`, `persistSession`) all await, during
    // which a logout()/new login() can race: it advances the provider generation (via
    // reset()) AND, for a logout, clears the boundary; a new login clears it then ARMS ITS
    // OWN. Without re-checking, this function would then resume and (a) RE-ARM the boundary
    // against a now-reset/stale provider — re-enabling authenticated fetches behind a
    // logged-out UI — and (b) publish a STALE logged-in session (or clobber a NEWER login's
    // boundary). So before arming the authoritative boundary + publishing, re-check BOTH the
    // generation and the authenticated WebID against this establish's snapshot. On the
    // SUPERSEDED path do NOT clear the boundary — the superseding actor already manages it (a
    // logout cleared it, a new login armed its own); clearing here would wipe the newer
    // login's freshly-armed boundary and strand its logged-in UI making UNAUTHENTICATED reads.
    if (
      !establishStillCurrent({
        establishGeneration,
        currentGeneration: providerRef.current?.loginGeneration() ?? -1,
        requestedWebId: id,
        currentAuthenticatedWebId: providerRef.current?.authenticatedWebId(),
        webIdsEqual,
      })
    ) {
      return;
    }
    // PROACTIVE FETCH (task #123): now that the session's pod root + issuer are known,
    // wire the AUTHORITATIVE credential boundary so the patched global fetch PROACTIVELY
    // attaches the DPoP token to the pod / WebID / issuer origins on the FIRST request
    // (no per-resource 401-dance — a library of N tracks no longer pays N+1 wasted 401s).
    // The pod root is the primary target (a pod on a DIFFERENT host than the WebID is a
    // valid Solid topology and MUST be listed); the WebID + issuer origins are folded in
    // by the seam's default. The boundary is https-only (http allowed only for a loopback
    // host under the dev/test opt-in), so the token can never ride cross-origin or over
    // cleartext. Armed BEFORE publishing the UI so the first library read is authenticated.
    fetchInstallRef.current?.setState({
      provider: providerRef.current,
      allowedOrigins: deriveProactiveAllowedOrigins({
        podRoot: derived.podRoot,
        webId: id,
        issuer: issuer?.href,
        allowInsecureLoopback: allowInsecureLoopbackRef.current,
      }),
    });
    setWebId(id);
    setSession(derived);
  }, []);

  // Establish the React session for a SILENTLY-RESTORED login (cross-app invariant
  // #1). `runSilentRestore` already confirmed the WebID-binding and the provider
  // already pinned the restored session in memory, so this only loads the (cosmetic)
  // profile and flips React state. The profile read is allowed to DEGRADE: a
  // restored token means logged-in even if the profile fetch later fails (a
  // transient blip must not bounce a fully-restored user to the login screen) — on a
  // profile failure we still set the WebID + a minimal derived session from the WebID
  // origin so the app renders. The credential is NOT re-persisted here (the restore
  // rotated + re-persisted it, and the pointer was re-confirmed in runSilentRestore).
  const establishRestoredSession = useCallback(async (id: string) => {
    // PROACTIVE FETCH (task #123): the silent-restore path NEVER runs the login flow's
    // pre-probe arming, so arm the credential boundary HERE before any read. First a
    // PROVISIONAL boundary (the WebID + the restored session's issuer origins) so the
    // (now-authenticated) cosmetic profile read carries the token; then the AUTHORITATIVE
    // boundary (adding the resolved pod root) so the FIRST library read after restore is
    // pre-authenticated — no per-resource 401-dance after a silent restore either. Without
    // this, a restored session's first reads would all be UNAUTHENTICATED (the boundary is
    // empty until armed) and the restored user would face the 401-dance the proactive
    // patch exists to kill. The OIDC endpoints ride the pristine fetch (re-entrancy guard),
    // so they do not depend on this boundary.
    const restoredIssuer = await providerRef.current?.resolvedIssuer();
    fetchInstallRef.current?.setState({
      provider: providerRef.current,
      allowedOrigins: deriveProactiveAllowedOrigins({
        webId: id,
        issuer: restoredIssuer?.href,
        allowInsecureLoopback: allowInsecureLoopbackRef.current,
      }),
    });
    try {
      const me = await readProfile(id);
      const derived = deriveSession(me);
      // Re-arm with the authoritative pod-root boundary now the profile is known.
      fetchInstallRef.current?.setState({
        provider: providerRef.current,
        allowedOrigins: deriveProactiveAllowedOrigins({
          podRoot: derived.podRoot,
          webId: id,
          issuer: restoredIssuer?.href,
          allowInsecureLoopback: allowInsecureLoopbackRef.current,
        }),
      });
      setSession(derived);
    } catch {
      // Cosmetic profile read failed — keep the user logged in with a minimal
      // session derived from the WebID origin (fail-open on the COSMETIC read only;
      // the SECURITY-critical WebID-binding was already enforced by runSilentRestore).
      // The provisional WebID+issuer boundary above already covers the WebID-origin
      // fallback pod root, so reads to it stay authenticated.
      const podRoot = new URL("/", id).toString();
      setSession({ podRoot, webId: id, podRootIsFallback: true });
    }
    setWebId(id);
  }, []);

  // The actual login body — run AT MOST ONCE concurrently via the module-level
  // single-flight gate in `login` below.
  const doLogin = useCallback(
    async (id: string) => {
      setError(null);
      setLoggingIn(true);
      // IDENTITY CHANGE — drop EVERY trace of any prior identity FIRST (Finding 1):
      //  - reset the provider so its cached issuer, per-issuer sessions (DPoP keys +
      //    access tokens), authenticated-WebID claim, and token-attach count are gone
      //    — a login as a different WebID can never reuse the previous user's session;
      //  - clear session-derived React state (pod root, etc.) so nothing from WebID-A
      //    is rendered while authenticating as WebID-B.
      providerRef.current?.reset();
      // PROACTIVE FETCH (task #123): clear the prior identity's credential boundary too,
      // so a data fetch racing the identity switch (before the probe / establishSessionFor
      // re-arm it for the new WebID) is fail-closed at the gate — WebID-A's token can never
      // ride a request during the switch window.
      clearProactiveBoundary();
      setWebId(null);
      setSession(null);
      pendingWebIdHolder.current = id;
      // CROSS-ACCOUNT cleanup (roborev MEDIUM): if a DIFFERENT account was remembered
      // (e.g. silent restore fell through to login and the user now signs in as another
      // WebID), drop the OLD account's durable refresh credential + pointer so it is not
      // orphaned in IndexedDB. Keyed on the WebID: a re-login to the SAME WebID keeps its
      // pointer/credential (it'll be re-persisted on success). The forget is enqueued on
      // the provider's #storeOps BEFORE the new session's persistSession, so ordering is
      // safe even for the same issuer. Done at login START (before any new persist).
      const prior = rememberedAccount.read();
      if (prior && !webIdsEqual(prior.webId, id)) {
        rememberedAccount.clear();
        void providerRef.current?.logoutForget([prior.issuer]).catch(() => {});
      }
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
        // PROACTIVE FETCH (task #123) — ARM the credential boundary for the login PROBE.
        // The probe below goes through the PATCHED global fetch and MUST reach
        // `provider.upgrade()` (which drives the popup → token mint) to prove login. The
        // proactive patch only calls `upgrade()` for an ALLOWED origin, so we must admit
        // the probe's origin BEFORE fetching it — otherwise the probe is left
        // unauthenticated, the popup never opens, and login can never complete. We arm
        // from the PUBLIC profile we just read (the WebID + its advertised storages); the
        // issuer is folded in once resolved. establishSessionFor RE-arms the authoritative
        // boundary post-login; the catch below clears it on failure. Without this the
        // proactive swap would break interactive login (caught by the e2e).
        fetchInstallRef.current?.setState({
          provider: providerRef.current,
          allowedOrigins: deriveProactiveAllowedOrigins({
            podRoot: pub.storages[0],
            webId: id,
            allowInsecureLoopback: allowInsecureLoopbackRef.current,
          }),
        });
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
        // "logged in" from "a token is attached" (Finding 1) — then re-read the
        // profile and derive the session. Shared with the autologin completion path.
        await establishSessionFor(id);
      } catch (e) {
        // The attempt failed — clear the pending WebID AND drop any partial provider
        // state, so a half-established session can't leak into the next attempt.
        pendingWebIdHolder.current = null;
        providerRef.current?.reset();
        // Drop any credential boundary the probe / a partially-completed
        // establishSessionFor armed, so a failed login never leaves the patched fetch
        // authenticating (task #123).
        clearProactiveBoundary();
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
    },
    [establishSessionFor, clearProactiveBoundary],
  );

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
    const provider = providerRef.current;
    // DROP THE DURABLE CREDENTIAL + the remembered pointer so a logout genuinely
    // signs the user out — silent restore must NOT resurrect a logged-out session on
    // the next load, and no orphaned refresh token may linger in IndexedDB.
    //
    // Forget the credential for EVERY issuer we can name, NOT only the remembered
    // pointer's (roborev MEDIUM): the pointer may be absent / cleared / corrupt while
    // the IndexedDB credential still exists, so relying on it alone would orphan the
    // token. We collect candidate issuers from BOTH (a) the provider's currently
    // resolved issuer (captured BEFORE reset(), which clears #issuer) and (b) the
    // remembered pointer — de-duped, each guarded against an unparseable URL — and
    // forget them all. forgetIssuer is idempotent + serialised on #storeOps, so
    // forgetting a not-persisted issuer is a harmless no-op. Fire-and-forget the async
    // deletes (the UI logout is synchronous); clearing the pointer immediately already
    // stops the next load from attempting a restore.
    const remembered = rememberedAccount.read();
    rememberedAccount.clear();
    // Forget the durable credential for every nameable issuer (the provider's resolved
    // #issuer + the pointer's), via the provider's SYNCHRONOUS-ENQUEUE logoutForget:
    // it places the delete onto the provider's #storeOps chain BEFORE this call
    // returns, so a fast re-login's persistSession (also on #storeOps) is strictly
    // ordered AFTER the delete and cannot be wiped by it. (A previous
    // `resolvedIssuer().then(forget)` deferred the enqueue and reintroduced the
    // delete-after-put race — roborev MEDIUM.) Fire-and-forget: the UI logout is
    // synchronous; clearing the pointer already stops the next load's restore.
    if (provider) void provider.logoutForget([remembered?.issuer]).catch(() => {});
    // RESET THE PROVIDER, not just React state (Finding 1): the in-memory issuer,
    // per-issuer sessions (DPoP key + access/refresh tokens), authenticated-WebID
    // claim, and token-attach count are all dropped, so a later login as a DIFFERENT
    // WebID cannot reuse this user's token/session and a login probe cannot look
    // authenticated with the stale token. (reset() advances the generation; the
    // already-cleared pointer + the synchronously-enqueued forget above handle the
    // durable side. logoutForget captured the pre-reset #issuer promise synchronously.)
    provider?.reset();
    // PROACTIVE FETCH (task #123): drop the credential boundary so the patched global
    // fetch authenticates NOTHING after logout — every request is public again until a
    // new login re-arms it. Belt-and-braces with `provider.reset()` (whose generation
    // fence already makes a racing `upgrade()` reject): clearing the allowed-origins set
    // means a foreign or post-logout request is fail-closed at the gate, never reaching
    // the (now-reset) provider.
    clearProactiveBoundary();
    pendingWebIdHolder.current = null;
    // Clear the module-level silent-restore single-flight cache (roborev MEDIUM): it
    // may hold a settled `{ kind: "restored" }` from this page's load. Without clearing
    // it, a later remount of SessionProvider in the SAME page lifetime would reuse that
    // cached result and re-apply establishRestoredSession — RESURRECTING the session we
    // just logged out of (the pointer was cleared, but the cache is independent). Null
    // it so any future restore re-decides from scratch (and finds no pointer → login).
    silentRestoreInFlight = null;
    setWebId(null);
    setSession(null);
    setError(null);
  }, [clearProactiveBoundary]);

  // ── AUTOLOGIN mount effect (full-page redirect deep-link / return) ───────────
  //
  // The DECISION (what to do given the URL + persisted/sentinel state + login state)
  // is the PURE `planAutologin`; this effect only EXECUTES the chosen action (URL
  // cleaning, provider calls, navigation). Keeping the decision pure makes the three
  // security-critical scenarios unit-testable with no DOM (autologin-plan.test.ts).
  //
  // It runs AFTER the runtime is `ready`, ONLY when NOT already logged in: a restored
  // / active session WINS — `planAutologin` returns `none` when `loggedIn`, so a
  // pre-set session short-circuits autologin (test (b)). Conversely, the silent
  // session-restore effect DEFERS to an explicit autologin deep-link / redirect
  // return (`autologinTakesPrecedence`), so the two never race: an explicit
  // deep-link drives the redirect here; a passive reopen drives silent restore.
  //
  // StrictMode double-invokes mount effects in dev; the module-level
  // `autologinEffectRan` latch (fed into the plan) + the persisted-redirect record +
  // the sessionStorage sentinel together make the body idempotent so at most one
  // redirect/complete fires.
  useEffect(() => {
    const provider = providerRef.current;
    const action = planAutologin({
      ready,
      hasProvider: provider !== null,
      loggedIn: webId !== null,
      effectAlreadyRan: autologinEffectRan,
      hasPendingRedirect: hasPendingRedirectLogin(),
      pendingRedirectWebId: consumePendingRedirectWebId(),
      hasCodeParams: hasAuthCodeParams(location.search),
      hasErrorParams: hasAuthErrorParams(location.search),
      fragmentWebId: parseAutologinFragment(location.hash),
      sentinel: readAutologinSentinel(),
      // The same WebID equality the rest of the auth seam uses, so a stale sentinel
      // for a DIFFERENT WebID does not swallow a fresh deep-link (Finding 2).
      webIdsEqual,
    });
    if (action.kind === "none" || !provider) return;
    // Any non-`none` action consumes the once-guard so a StrictMode double-mount
    // cannot fire a second redirect/complete.
    autologinEffectRan = true;
    // An ACTIVE autologin (completing a redirect return, or beginning a fresh
    // redirect) OWNS this load — set the in-memory flag SYNCHRONOUSLY, BEFORE any URL
    // cleaning / async redirect, so the silent-restore effect (which runs right after
    // this one in the same commit) defers even though the pending-redirect record is
    // not yet persisted (roborev HIGH). The terminal fall-through actions
    // (`clear-sentinel` / `abort-redirect`) deliberately do NOT set it — autologin is
    // NOT proceeding, so silent restore is the correct fallback there.
    if (action.kind === "complete" || action.kind === "begin") {
      autologinInProgress = true;
    }

    // LOOP GUARD (CASE B repeat): a second `#autologin` for the SAME WebID with the
    // sentinel already set means we bounced back still unauthenticated. Do NOT
    // re-attempt: clear the sentinel + fragment and fall through to the login screen.
    if (action.kind === "clear-sentinel") {
      clearAutologinSentinel();
      history.replaceState(null, "", cleanedUrl(location.href));
      return;
    }

    // ABORT — returning from the full-page redirect with an OAuth ERROR
    // (?error&state: the broker declined silent SSO / the user declined). Without this
    // the error return is ignored and the persisted record + DPoP key + sentinel + the
    // error query all leak, BLOCKING future autologins. Clean EVERYTHING up and surface
    // the error once — do NOT loop, do NOT spew.
    if (action.kind === "abort-redirect") {
      // Pull the OAuth error code BEFORE cleaning the URL, for a useful message.
      const errParams = new URLSearchParams(location.search);
      const oauthError = errParams.get("error");
      // reset() clears the persisted redirect record + the DPoP key material + all
      // in-memory session state; the sentinel is a distinct key, cleared separately.
      provider.reset();
      clearProactiveBoundary(); // task #123: never leave the fetch authenticating.
      clearAutologinSentinel();
      pendingWebIdHolder.current = null;
      history.replaceState(null, "", cleanedUrl(location.href));
      setAutologinPending(false);
      setError(
        `Automatic sign-in was declined or unavailable${
          oauthError ? ` (${oauthError})` : ""
        } — please sign in.`,
      );
      return;
    }

    // CASE A — returning from the full-page redirect: complete the persisted login.
    if (action.kind === "complete") {
      const callbackUrl = location.href;
      const targetWebId = action.webId;
      // Clean the URL IMMEDIATELY so a refresh cannot replay the code/state.
      history.replaceState(null, "", cleanedUrl(callbackUrl));
      setAutologinPending(true);
      setError(null);
      provider
        .completeRedirectLogin(callbackUrl)
        .then(async () => {
          // completeRedirectLogin established the session + authenticatedWebId in the
          // provider; reuse the SAME post-login step as doLogin to confirm identity +
          // derive the session. The persisted record told us which WebID to expect.
          const id = targetWebId ?? provider.authenticatedWebId();
          if (!id) throw new Error("Autologin completed without a target WebID.");
          await establishSessionFor(id);
          clearAutologinSentinel(); // success → clean slate for next time.
        })
        .catch((e) => {
          // Failure: drop any persisted record + the sentinel, fall back to the login
          // screen. Do NOT loop, do NOT spew — surface a single error.
          provider.reset(); // clears the persisted record too; leaves reset-clean.
          clearProactiveBoundary(); // task #123: never leave the fetch authenticating.
          clearAutologinSentinel();
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setAutologinPending(false));
      return;
    }

    // CASE B — fresh autologin deep-link: begin the full-page redirect.
    const targetWebId = action.webId;
    // Clean the URL (strip the fragment) BEFORE doing anything else, so a refresh /
    // redirect-bounce can't re-trigger and the WebID isn't left in the address bar.
    history.replaceState(null, "", cleanedUrl(location.href));
    // Set the one-shot sentinel to the WebID we are about to attempt.
    setAutologinSentinel(targetWebId);
    // Set the pending WebID + reset the provider for the new identity (mirror
    // doLogin's identity-change reset). reset() clears any stale persisted redirect
    // record but NOT the sentinel we just set (distinct keys).
    pendingWebIdHolder.current = targetWebId;
    provider.reset();
    clearProactiveBoundary(); // task #123: identity switch — drop the prior boundary.
    setAutologinPending(true);
    setError(null);

    const redirectReturnUri = new URL("/", location.href).toString();
    provider
      .beginRedirectLogin(redirectReturnUri)
      .then(({ authorizationUrl }) => {
        // Full-page redirect to the broker. Because the IdP session is live + the app
        // is pre-authorized, the broker redirects straight back authenticated.
        location.assign(authorizationUrl);
      })
      .catch((e) => {
        // Any error BEFORE the redirect: clear the sentinel, fall back to login.
        clearAutologinSentinel();
        pendingWebIdHolder.current = null;
        provider.reset();
        clearProactiveBoundary(); // task #123: never leave the fetch authenticating.
        setAutologinPending(false);
        setError(e instanceof Error ? e.message : String(e));
      });
    // `webId` is a dep so a logout (webId→null) does NOT re-trigger autologin — the
    // once-guard and the cleaned URL (no fragment / no code) keep it inert after the
    // first pass.
  }, [ready, webId, establishSessionFor, clearProactiveBoundary]);

  // ── SILENT SESSION RESTORE mount effect (cross-app UX invariant #1) ──────────
  //
  // On a fresh load, a returning user who merely closed the tab (did NOT log out)
  // still has their DPoP-bound refresh token + non-extractable key persisted in
  // IndexedDB. Before deciding "logged out" we attempt a SILENT restore — a
  // `refresh_token` grant (a token-endpoint fetch, no popup/iframe) — and only fall
  // back to the login screen on a genuine restore failure. The decision +
  // fail-closed WebID-mismatch teardown live in the module-level `runSilentRestore`
  // (single-flighted via `silentRestoreInFlight` so StrictMode's double-mount runs
  // the credential redemption ONCE).
  //
  // PRECEDENCE: an EXPLICIT autologin deep-link / redirect return OWNS the load — this
  // effect then becomes a clean no-op (just clears the `restoring` flag) so the two
  // flows never race two session establishments. The gate consults the PRISTINE
  // module-eval URL snapshot ({@link INITIAL_URL}) — NOT the live `location`, which
  // the autologin effect (running FIRST in this commit) may already have cleaned
  // before its async redirect record was persisted — AND the synchronous
  // `autologinInProgress` flag the autologin effect sets the instant it commits to a
  // redirect. Either signal defers restore (roborev HIGH: a fresh `#autologin` load
  // must never slip past on a cleaned URL + not-yet-persisted record).
  useEffect(() => {
    if (!ready) return;
    const provider = providerRef.current;
    if (!provider) return;
    // Defer entirely to an explicit autologin / redirect flow if one is in play.
    if (
      autologinInProgress ||
      autologinTakesPrecedence(INITIAL_URL.hash, INITIAL_URL.search, hasPendingRedirectLogin())
    ) {
      setRestoring(false);
      return;
    }
    let cancelled = false;
    // Single-flight DURING the active in-flight window: StrictMode's double-mount +
    // concurrent mounts must redeem the credential ONCE. The cached promise is CLEARED
    // once it settles to a NON-restored outcome (roborev LOW), so a genuine later
    // remount within the same page can retry a restore that a transient blip preserved
    // the credential for — rather than forever reusing a stale failed promise. A
    // `restored` outcome keeps the cache (the session is established; no retry needed).
    if (silentRestoreInFlight === null) silentRestoreInFlight = runSilentRestore(provider);
    const run = silentRestoreInFlight;
    run
      .then(async (result) => {
        if (result.kind !== "restored" && silentRestoreInFlight === run) {
          silentRestoreInFlight = null; // allow a later remount to retry.
        }
        if (cancelled) return;
        // A session may have been established by ANOTHER path (an autologin completion,
        // or a fast interactive login) WHILE this restore promise was resolving. Do NOT
        // overwrite it with the (now-stale) remembered account (roborev MEDIUM): only
        // apply a restored result when we are still logged OUT.
        if (result.kind === "restored" && webIdRef.current === null) {
          await establishRestoredSession(result.webId);
        }
        // else: nothing to restore / a session already won / fail-closed teardown
        // already handled — fall through (no error: a clean "please sign in").
      })
      .catch(() => {
        // runSilentRestore never throws (the pure decider is fail-closed), but guard
        // anyway: clear the cache so a remount can retry, then fall back to login.
        if (silentRestoreInFlight === run) silentRestoreInFlight = null;
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, establishRestoredSession]);

  const value = useMemo<SessionContextValue>(
    () => ({
      webId,
      session,
      loggingIn,
      autologinPending,
      restoring,
      error,
      ready,
      login,
      logout,
    }),
    [webId, session, loggingIn, autologinPending, restoring, error, ready, login, logout],
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
