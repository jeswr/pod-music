// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
// Ported verbatim from create-solid-app's reference provider (which itself ports
// the published 0.1.2 DPoPTokenProvider). The host shell uses its STATIC Client
// Identifier Document branch (the `clientId` option) so the consent screen shows
// "Pod Docs" instead of a throwaway dynamic registration.
/**
 * webid-token-provider.ts — a custom @solid/reactive-authentication `TokenProvider`
 * whose OIDC issuer is resolved from the user's WebID profile (via callbacks),
 * instead of the published `DPoPTokenProvider`'s hard-coded host map.
 *
 * Ported from the published `DPoPTokenProvider` (v0.1.2), preserving its
 * authorization-code + PKCE + DPoP flow and its `prompt=none` silent-retry
 * behaviour. The ONE structural change: `#resolveIssuer()` dereferences the
 * WebID and reads `solid:oidcIssuer`, then asks `chooseIssuer` when several are
 * advertised — never silently the first.
 *
 * Two app-supplied callbacks drive identity:
 *  - `getWebId()`   — UI that asks the user for their WebID (see `promptWebIdDialog`).
 *  - `getCode(uri)` — the existing `<authorization-code-flow>` element's `getCode`.
 *
 * In ADDITION to that popup flow, this provider exposes a TWO-PHASE FULL-PAGE
 * REDIRECT login ({@link WebIdDPoPTokenProvider.beginRedirectLogin} /
 * {@link WebIdDPoPTokenProvider.completeRedirectLogin}) for the Pod-Manager
 * autologin deep-link. @solid/reactive-authentication 0.1.3 has NO non-popup
 * mode, and a popup auto-opened on load (no user gesture) is browser-blocked, so
 * autologin needs a full-page redirect. Because that redirect destroys all
 * in-memory state, the two phases PERSIST the DPoP key (exported to JWK) + PKCE
 * verifier + state + nonce to sessionStorage between them. The popup path is
 * unchanged.
 *
 * `allowInsecureLoopback` is what makes LOCAL CSS work: it flips oauth4webapi's
 * `allowInsecureRequests` ONLY for `localhost`/`127.0.0.1` issuers, so the HTTP
 * issuer of a dev CSS is accepted while remote HTTPS issuers stay strict.
 */

import { fetchRdf } from "@jeswr/fetch-rdf";
import type { GetCodeCallback } from "@solid/reactive-authentication";
import * as DPoP from "dpop";
import * as oauth from "oauth4webapi";
import { resolveIssuers, validateWebId } from "./login-ux";

/**
 * The library's TokenProvider interface. @solid/reactive-authentication 0.1.2
 * does NOT re-export the `TokenProvider` type from its package entrypoint (only
 * the concrete providers), so we restate the (tiny, stable) structural contract
 * here. `ReactiveFetchManager` accepts any `Iterable<TokenProvider>`, and
 * matches structurally — this is the exact shape from the package's
 * `TokenProvider.d.ts`.
 */
export interface TokenProvider {
  matches(request: Request): Promise<boolean>;
  upgrade(request: Request): Promise<Request>;
}

/**
 * The active login probe, captured per-login on the provider instance — NOT a
 * free-floating module registry, and NOT a network header.
 *
 * A login probe must prove THIS specific request — not merely "some request" —
 * was token-upgraded. Two earlier designs are rejected here:
 *
 *  - A custom `x-reactive-auth-probe-id` HEADER (round 2) broke CROSS-ORIGIN
 *    login: a custom request header makes the request non-"simple", so the browser
 *    fires a CORS preflight (OPTIONS) that many Solid pods reject — the probe
 *    failed before the 401/upgrade path ever ran. NOTHING app-specific goes on the
 *    wire.
 *  - A module-level `Map<url, id>` URL registry (round 3) was keyed only on the
 *    request URL (the one property surviving the manager's `new Request(input)`
 *    re-wrap). Keyed on URL alone, it was vulnerable to (a) a same-URL non-probe
 *    upgrade between registration and the probe's own upgrade stealing the proof,
 *    and (b) overlapping/double-clicked logins to the same storage root
 *    overwriting each other's registration.
 *
 * The round-4 design closes both: the login is SINGLE-FLIGHTED in the
 * SessionProvider, so there is never a second concurrent login (closing finding
 * (b) — no second registration can ever exist to overwrite). And the probe record
 * is held as a SINGLE generation-scoped entry ON the provider instance, so
 * `reset()` clears it for free. The record matches a request by OBJECT IDENTITY
 * first (the precise channel that survives when the manager does NOT re-wrap, e.g.
 * a direct `upgrade()` in a unit test) and falls back to URL+generation as the
 * single-use channel that carries across the manager's `new Request(input)`
 * re-wrap.
 *
 * ROUND-4B (roborev finding 2): the URL fallback alone was forgeable — keyed on
 * the bare storage-root URL, the FIRST same-URL request in the generation (even a
 * non-probe data fetch) could consume the proof. That relied on an external,
 * unverifiable "the data layer is idle mid-login" assumption. The fix makes the
 * probe URL carry a unique, UNGUESSABLE fragment ({@link withProbeFragment} →
 * `#probe-<uuid>`): an UNFORGEABLE in-process marker that (a) survives the
 * manager's `new Request(input)` re-wrap (fragments are preserved on `.url`), and
 * (b) is NEVER sent on the wire (RFC 3986 §3.5 — the browser strips it, so no
 * custom header / CORS preflight, and the pod still GETs the storage root). The
 * URL fallback now compares the FULL url-with-fragment, so an unrelated same-base
 * data fetch (no fragment, or a different/guessed one) can NEVER match. The
 * single-use latch is KEPT as defence-in-depth, but the unguessable fragment is
 * what makes the fallback genuinely collision-resistant. `upgrade()` matches on
 * the ORIGINAL request it receives — before the clone it makes to add
 * Authorization — and records the upgrade by GENERATION iff it attaches a token.
 */
interface LoginProbe {
  /** The provider generation in which this login's probe was registered. */
  generation: number;
  /**
   * The probe's FULL request URL — INCLUDING its unique unguessable
   * `#probe-<uuid>` fragment ({@link withProbeFragment}). The fragment survives
   * the manager's `new Request(input)` re-wrap (it lives on `.url`) yet is never
   * sent on the wire, so the URL fallback matches only the exact probe URL the
   * login flow built — never a plain same-base-URL data fetch. This is what makes
   * the URL fallback unforgeable (roborev finding 2).
   */
  url: string;
  /**
   * The exact Request object registered, held weakly so it cannot pin the Request
   * in memory. Matches when the manager does NOT re-wrap (object identity intact).
   */
  object: WeakRef<Request>;
  /**
   * Single-use latch: set true once this probe has been consumed by an
   * `upgrade()` (matched by object or URL), so a later same-URL request in the
   * same generation cannot re-acquire the proof.
   */
  consumed: boolean;
}

/**
 * Tag a probe URL with a unique, unguessable, OFF-THE-WIRE correlation marker — a
 * URL FRAGMENT (`#probe-<uuid>`). This is what makes the URL fallback in
 * {@link WebIdDPoPTokenProvider.upgrade matching} UNFORGEABLE (roborev finding 2):
 *
 *  - A fragment is preserved by `new Request(url + "#probe-<uuid>")` (it lands in
 *    `.url`) AND by the manager's re-wrap `new Request(thatRequest)` — so the
 *    URL-fallback match survives the exact path that loses object identity.
 *  - A plain `new Request(storageUrl)` from the data layer has NO fragment, so it
 *    can NEVER collide with the probe's fragment-bearing URL. The proof now
 *    requires the EXACT unguessable probe URL, which only this login flow knows —
 *    an unrelated same-base-URL fetch can no longer consume the single-use proof.
 *  - Fragments are CLIENT-SIDE only (RFC 3986 §3.5): the browser strips the
 *    fragment before sending the HTTP request, so this adds NO custom header, NO
 *    CORS preflight, and does NOT change which resource the pod actually serves
 *    (the pod still sees a GET to the storage root). The CORS-safety property of
 *    the round-2/3 work is fully preserved.
 *
 * Any pre-existing fragment on the input is REPLACED (a storage URL normally has
 * none, but this is defensive). Exported so it is unit-testable in isolation.
 */
export function withProbeFragment(url: string): string {
  const u = new URL(url);
  u.hash = `probe-${crypto.randomUUID()}`;
  return u.toString();
}

/**
 * The RFC 9449 §4.2 DPoP `htu`: the request URI with the query AND fragment
 * removed (scheme + authority + path only).
 *
 * The login probe carries a `#probe-<uuid>` fragment ({@link withProbeFragment})
 * as an UNFORGEABLE, in-process correlation marker — it is NEVER sent on the wire
 * (RFC 3986 §3.5: the browser strips the fragment before sending). When we mint
 * the DPoP proof we MUST strip that fragment, because the `dpop` package uses its
 * `htu` argument VERBATIM (it does not normalise), so the fragment would leak into
 * the proof's `htu` claim. A Solid server computes `htu` from the RECEIVED request
 * URI with query + fragment removed and compares; since the browser already
 * stripped the fragment on the wire, the server-computed `htu` is fragment-less
 * and would NOT match a fragment-bearing proof `htu` — the authenticated probe's
 * token would be rejected in production. We also strip the query for full
 * §4.2 correctness (a storage probe normally has none, but this is defensive).
 *
 * Exported so it is unit-testable in isolation.
 */
export function httpUri(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.search = "";
  return u.toString();
}

/** Ask the user for their WebID. Resolves to the WebID string, or rejects/cancels. */
export type GetWebIdCallback = () => Promise<string>;

/**
 * The sessionStorage key under which the TWO-PHASE full-page redirect login
 * persists its in-between state ({@link PersistedRedirectFlow}). A full-page
 * redirect destroys ALL in-memory state (the DPoP key, PKCE verifier, state,
 * nonce held in {@link WebIdDPoPTokenProvider.#authenticate}'s closure), so the
 * autologin redirect path serialises exactly what {@link
 * WebIdDPoPTokenProvider.completeRedirectLogin} needs to resume after the broker
 * redirects back. ONE key holds ONE record (a single in-flight redirect login per
 * tab — autologin is single-shot, see SessionProvider's sentinel).
 *
 * Scope: sessionStorage is PER-TAB and same-origin, cleared on tab close — the
 * record never outlives the tab and is never shared across origins.
 */
export const REDIRECT_FLOW_KEY = "pss.autologin.flow";

/**
 * The serialised state a full-page-redirect login persists to sessionStorage
 * between {@link WebIdDPoPTokenProvider.beginRedirectLogin} (before the redirect)
 * and {@link WebIdDPoPTokenProvider.completeRedirectLogin} (after the broker
 * redirects back). It carries the PKCE verifier + the DPoP private JWK + the OIDC
 * `state`/`nonce`.
 *
 * SECURITY — why persisting the DPoP private JWK here is acceptable:
 *  - sessionStorage is SAME-ORIGIN and PER-TAB and is cleared when the tab closes,
 *    so the key is reachable only by this origin's own code for the brief duration
 *    of one redirect round-trip;
 *  - this is the STANDARD pattern for redirect-based PKCE+DPoP SPAs: a full-page
 *    redirect has no closure to keep the key in, so the only alternatives are a
 *    persisted extractable key (this) or abandoning DPoP for the redirect path;
 *  - the `state` is verified on return (`oauth.validateAuthResponse`), the PKCE
 *    verifier is single-use against the code, and the record is CLEARED the instant
 *    it is consumed (success OR failure — see `completeRedirectLogin`'s `finally`)
 *    so a refresh/back-button cannot replay it.
 * The popup path keeps its DPoP key NON-extractable (it never leaves the closure);
 * ONLY this redirect path exports the key, and only because the redirect erases
 * the closure.
 */
interface PersistedRedirectFlow {
  /** The DPoP keypair, exported to JWK so it survives the full-page redirect. */
  dpopPrivateJwk: JsonWebKey;
  dpopPublicJwk: JsonWebKey;
  /** The PKCE code verifier — exchanged (single-use) for the code on return. */
  codeVerifier: string;
  /** Whether PKCE is in use (the AS advertised a challenge method). */
  usePkce: boolean;
  /** The OIDC `state`, verified against the callback by `validateAuthResponse`. */
  state: string;
  /** The OIDC `nonce`, the `expectedNonce` for the token exchange. */
  nonce: string;
  /** The resolved issuer href (the discovery + token endpoints are re-derived). */
  issuer: string;
  /** The `client_id` used (this app's static Client Identifier Document URL). */
  clientId: string;
  /**
   * The redirect_uri sent in BOTH the authorization request AND the token
   * exchange — they MUST be byte-identical or the token exchange is rejected.
   */
  redirectUri: string;
  /** The WebID the user asked to log in as (the deep-link target). */
  webId: string;
}

/** Read the persisted redirect-flow record, or null if absent/unparseable. */
function readPersistedRedirectFlow(): PersistedRedirectFlow | null {
  let raw: string | null;
  try {
    raw = globalThis.sessionStorage?.getItem(REDIRECT_FLOW_KEY) ?? null;
  } catch {
    return null; // sessionStorage unavailable (SSR / disabled) — no pending flow.
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedRedirectFlow;
  } catch {
    return null; // corrupt record — treat as absent (the caller falls back to login).
  }
}

/** Remove the persisted redirect-flow record (idempotent; swallows storage errors). */
function clearPersistedRedirectFlow(): void {
  try {
    globalThis.sessionStorage?.removeItem(REDIRECT_FLOW_KEY);
  } catch {
    // sessionStorage unavailable — nothing to clear.
  }
}

/**
 * Whether a full-page-redirect login is mid-flight (a persisted record exists in
 * sessionStorage). The SessionProvider calls this ON MOUNT to detect a returning
 * autologin (Case A) before deciding whether the `?code&state` on the URL belongs
 * to us. A module function (not an instance method) so it is callable before the
 * provider singleton has resolved.
 */
export function hasPendingRedirectLogin(): boolean {
  return readPersistedRedirectFlow() !== null;
}

/**
 * The WebID a pending redirect login is for, or null when no record exists. The
 * SessionProvider reads this to know which identity the returning autologin is
 * resuming (so it can confirm the OP authenticated AS that WebID).
 */
export function consumePendingRedirectWebId(): string | null {
  return readPersistedRedirectFlow()?.webId ?? null;
}

/** WebCrypto params for an ES256 (P-256 ECDSA) key, used to re-import the DPoP JWK. */
const ES256_IMPORT_ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

/**
 * Choose one issuer from several advertised on the profile. The default policy
 * is: a single issuer is used directly; more than one is an error (no callback =
 * no UI to choose, and silently picking the first is wrong). Apps that surface a
 * picker pass their own `chooseIssuer`.
 */
export type ChooseIssuerCallback = (issuers: string[]) => Promise<string>;

export interface WebIdDPoPTokenProviderOptions {
  /**
   * A **Solid-OIDC Client Identifier Document** URL. When set, the provider
   * SKIPS dynamic client registration and authenticates as a public client whose
   * `client_id` IS this URL (the spec's "Client Identifier" — a dereferenceable
   * JSON-LD document; see https://solidproject.org/TR/oidc#clientids). The OP
   * dereferences the URL and matches the redirect_uri against the document's
   * `redirect_uris`, so the document MUST list the {@link callbackUri} passed to
   * the constructor. With `none` token-endpoint auth (a public browser client),
   * no client secret is involved.
   *
   * The URL string MUST equal the document's `client_id` field byte-for-byte;
   * a trailing-slash or scheme/port mismatch makes the OP reject it.
   *
   * When ABSENT (default), the provider falls back to **dynamic client
   * registration** — convenient for local dev, but yields a throwaway client
   * with no stable name on the consent screen.
   */
  clientId?: string;
  /**
   * Pick one issuer when the profile advertises several. Defaults to a policy
   * that throws on ambiguity (see {@link AmbiguousIssuerError}). It is always
   * called with ≥ 1 issuer; with exactly one, the default returns it.
   */
  chooseIssuer?: ChooseIssuerCallback;
  /**
   * Enable oauth4webapi's `allowInsecureRequests` for `localhost` / `127.0.0.1`
   * issuers only (dev CSS over HTTP). Remote HTTPS issuers are unaffected, and
   * non-loopback HTTP issuers are never allowed. Default `false`.
   */
  allowInsecureLoopback?: boolean;
  /**
   * Override the fetch used to dereference the public WebID profile. Defaults to
   * the `globalThis.fetch` captured at CONSTRUCTION time (before
   * {@link https://github.com/solid-contrib/reactive-authentication ReactiveFetchManager}
   * patches the global) — see the recursion note in the class docs. Test-only.
   */
  profileFetch?: typeof fetch;
}

/** A WebID advertises several issuers but no `chooseIssuer` was supplied. */
export class AmbiguousIssuerError extends Error {
  readonly webId: string;
  readonly issuers: string[];
  constructor(webId: string, issuers: string[]) {
    super(
      `This WebID advertises ${issuers.length} OIDC issuers — the app must supply ` +
        `a 'chooseIssuer' callback so the user can pick one (${webId}).`,
    );
    this.name = "AmbiguousIssuerError";
    this.webId = webId;
    this.issuers = issuers;
  }
}

/**
 * An in-flight `upgrade()` resolved AFTER a {@link WebIdDPoPTokenProvider.reset}
 * (logout / new login) advanced the provider's generation. The result belongs to
 * a superseded identity, so the upgrade is rejected with this error and writes no
 * provider state — preventing a prior identity's token/claim from contaminating
 * the next attempt.
 */
export class ReactiveAuthResetError extends Error {
  constructor() {
    super(
      "Authentication was reset (logout or a new login started) while this request was upgrading.",
    );
    this.name = "ReactiveAuthResetError";
  }
}

/** The default issuer policy: single → it; several → throw (never pick silently). */
function defaultChooseIssuer(webId: string): ChooseIssuerCallback {
  return async (issuers: string[]) => {
    if (issuers.length === 1) return issuers[0];
    throw new AmbiguousIssuerError(webId, issuers);
  };
}

/** Per-issuer session state cached so repeat upgrades don't re-prompt. */
interface IssuerSession {
  authorizationServer: oauth.AuthorizationServer;
  clientRegistration: oauth.Client;
  dpopKey: CryptoKeyPair;
  accessToken: string;
  /**
   * The WebID this session actually authenticated AS — the `webid` claim of the
   * id_token (Solid-OIDC), falling back to `sub`. This is the identity the OP
   * vouched for, NOT the WebID the user typed; the login flow MUST confirm the
   * two agree before flipping to logged-in (see {@link WebIdDPoPTokenProvider.authenticatedWebId}).
   */
  authenticatedWebId: string | undefined;
}

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";

export class WebIdDPoPTokenProvider implements TokenProvider {
  readonly #callbackUri: string;
  readonly #getCode: GetCodeCallback;
  readonly #getWebId: GetWebIdCallback;
  readonly #clientId?: string;
  readonly #chooseIssuer?: ChooseIssuerCallback;
  readonly #allowInsecureLoopback: boolean;
  /**
   * The profile is PUBLIC, so reading it needs no auth. We must not read it
   * through the patched global fetch in a way that recurses back into this
   * provider on a 401. We snapshot `globalThis.fetch` at construction — the
   * provider is built BEFORE `new ReactiveFetchManager([provider])` patches the
   * global, so this snapshot is the original, un-upgrading fetch. (A public
   * profile won't 401 anyway, but this keeps the read provably out of the
   * reactive loop regardless of access-control surprises.)
   */
  readonly #profileFetch: typeof fetch;
  /**
   * Memoised issuer resolution: the user is asked for their WebID ONCE per
   * provider instance, not on every 401 — and concurrent 401s share the same
   * in-flight prompt (single-flight). Cleared on failure so a cancelled or
   * failed prompt can be retried.
   */
  #issuer?: Promise<URL>;
  /** Single-flight session per issuer: parallel 401s share one login flow. */
  readonly #sessions = new Map<string, Promise<IssuerSession>>();
  /**
   * Monotonic count of how many times {@link upgrade} has actually MINTED +
   * ATTACHED a DPoP/Authorization header to a request. This is the proof that an
   * auth flow ran — but, crucially, it is a *running total*, NOT a sticky "ever
   * established" flag.
   *
   * Why a counter and not a boolean: a boolean is sticky — once any prior
   * `upgrade()` set it, it stays set forever, so a LATER login attempt whose
   * probe hits a PUBLIC 200 (no `upgrade()` ran for THAT probe) would still see
   * the flag set by the earlier session and be wrongly accepted as logged in
   * (the "public 200 = logged in" bug, reintroduced after logout→re-login or a
   * prior rejected probe). With a counter, a login attempt snapshots the count
   * BEFORE its probe and checks it INCREASED after — proving a token was attached
   * during THIS attempt, never inferring it from a flag a previous session left.
   */
  #tokensAttached = 0;
  /**
   * The WebID the most-recently-established session actually authenticated AS
   * (the `webid`/`sub` claim of its id_token), or undefined when no session has
   * been established since the last {@link reset}. The login flow reads this to
   * PROVE the authenticated identity matches the WebID the user asked to log in
   * as — never inferring "logged in" from merely "a token is attached". Cleared
   * by {@link reset} so a prior identity cannot survive a logout / re-login.
   */
  #authenticatedWebId: string | undefined;
  /**
   * The active login probe for THIS login, or null when none is registered. Held
   * ON the instance (not a module global) so {@link reset} clears it for free.
   * Set by {@link beginLoginProbe}, cleared by {@link endLoginProbe} / {@link reset}.
   * See {@link LoginProbe} for why this replaces the round-3 module-level URL Map.
   */
  #loginProbe: LoginProbe | null = null;
  /**
   * The generation in which {@link upgrade} last attached a token to the active
   * login probe (matched by object identity or URL), else null. The login flow
   * snapshots {@link loginGeneration} after `reset()` and asserts
   * {@link wasLoginProbeUpgraded} for that generation — proving the provider
   * upgraded THIS login's own probe, not merely that "some request" was upgraded.
   * Cleared by {@link reset} / {@link endLoginProbe}.
   */
  #probeUpgradedGeneration: number | null = null;
  /**
   * A per-attempt GENERATION (epoch) counter that fences in-flight auth work
   * across a {@link reset}. {@link reset} increments it; an `upgrade()` /
   * `#authenticate()` already running captures the generation at its start and,
   * before mutating ANY provider state (`#sessions`, `#authenticatedWebId`,
   * `#tokensAttached`, `#probeUpgradedGeneration`), checks the generation is still
   * current. If a logout / new-login `reset()` advanced it mid-flight, the stale
   * result is discarded and NO state is written — so a login or upgrade that began
   * before the reset cannot contaminate the next identity's clean baseline.
   */
  #generation = 0;
  /**
   * Shared auth work (issuer resolution, login) is provider-owned: it must NOT
   * be tied to any single request's AbortSignal, or aborting one request would
   * cancel the login other concurrent 401 upgrades are waiting on. The user
   * cancels via the dialog/popup themselves, which rejects the shared promise.
   *
   * It is replaced on every {@link reset} (and any controller it replaces is
   * aborted) so in-flight auth work spawned by a prior identity is actively
   * cancelled, not merely fenced out after the fact.
   */
  #authController = new AbortController();

  constructor(
    callbackUri: string,
    getCode: GetCodeCallback,
    getWebId: GetWebIdCallback,
    options: WebIdDPoPTokenProviderOptions = {},
  ) {
    this.#callbackUri = callbackUri;
    this.#getCode = getCode;
    this.#getWebId = getWebId;
    this.#clientId = options.clientId;
    this.#chooseIssuer = options.chooseIssuer;
    this.#allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    this.#profileFetch = options.profileFetch ?? globalThis.fetch.bind(globalThis);
  }

  /** oauth4webapi request options, enabling insecure loopback per the policy. */
  #httpOptions(
    issuer: URL,
    signal: AbortSignal,
  ): { signal: AbortSignal; [oauth.allowInsecureRequests]?: true } {
    if (this.#allowInsecureLoopback && isLoopback(issuer.hostname)) {
      return { signal, [oauth.allowInsecureRequests]: true };
    }
    return { signal };
  }

  /**
   * WebID-driven issuer resolution — the one structural change from the
   * published provider. Ask the app for a WebID, validate it, dereference its
   * public profile (out-of-loop fetch), read every `solid:oidcIssuer`, then let
   * the app choose when several are advertised.
   */
  async #resolveIssuer(signal: AbortSignal): Promise<URL> {
    const webId = validateWebId(await this.#getWebId());
    signal.throwIfAborted();
    const { dataset } = await fetchRdf(webId, { fetch: this.#profileFetch });
    const issuers = resolveIssuers(webId, dataset);
    const choose = this.#chooseIssuer ?? defaultChooseIssuer(webId);
    const chosen = await choose(issuers);
    return new URL(chosen);
  }

  async matches(): Promise<boolean> {
    return true;
  }

  /**
   * The running total of requests this provider has minted + attached a token to
   * via {@link upgrade}. NOT a boolean "ever logged in" flag — it is read as a
   * BEFORE/AFTER pair around a single login attempt: a login attempt snapshots
   * this count, runs its probe, and re-reads it; an INCREASE proves a token was
   * attached during THAT attempt. This is what makes login detection
   * per-attempt rather than sticky — a prior session's attachments are already
   * counted, so they do not make a later token-less probe look authenticated.
   */
  tokensAttachedCount(): number {
    return this.#tokensAttached;
  }

  /**
   * The WebID the current authenticated session was issued FOR — the `webid`
   * claim of the id_token (Solid-OIDC), falling back to `sub` — or undefined
   * when nothing has authenticated since the last {@link reset}. The login flow
   * compares this against the WebID the user asked to log in as; they MUST match
   * before the app treats the user as logged in (a token being attached is NOT,
   * by itself, proof of THIS WebID — a stale session from a prior identity would
   * otherwise pass). The returned string is the issuer-vouched identity, not the
   * user's typed input.
   */
  authenticatedWebId(): string | undefined {
    return this.#authenticatedWebId;
  }

  /**
   * The CURRENT provider generation — the value of {@link #generation}. The login
   * flow snapshots this immediately AFTER its `reset()` (so it equals the
   * generation the probe will run in) and later passes it to
   * {@link wasLoginProbeUpgraded} to prove THIS login's probe was the request that
   * got upgraded. Single-flight login guarantees no other login advances the
   * generation between the snapshot and the assertion.
   */
  loginGeneration(): number {
    return this.#generation;
  }

  /**
   * Register THIS login's probe Request so {@link upgrade} can recognise it WITHOUT
   * any header on the wire — by object identity first, then by the probe's FULL
   * url-with-fragment (generation-scoped, single-use) as the channel that survives
   * the manager's `new Request(input)` re-wrap. The matching key is
   * `request.url`, which INCLUDES the unique `#probe-<uuid>` fragment the login
   * flow attached via {@link withProbeFragment} — so the URL fallback matches only
   * the exact unguessable probe URL, never a same-base-URL data fetch (finding 2).
   * Captures the current generation; a later `reset()` (and the generation bump it
   * makes) supersedes the record. Call on the EXACT Request object then passed to
   * `fetch`. Login is single-flight, so there is never a competing registration.
   */
  beginLoginProbe(request: Request): void {
    this.#loginProbe = {
      generation: this.#generation,
      url: request.url,
      object: new WeakRef(request),
      consumed: false,
    };
  }

  /**
   * Clear the active login probe (call in the login flow's `finally`). A no-op if
   * `reset()` already cleared it. Does NOT clear {@link #probeUpgradedGeneration};
   * the login flow reads {@link wasLoginProbeUpgraded} for its snapshot generation
   * BEFORE calling this, and the next login's `reset()` clears the proof anyway.
   */
  endLoginProbe(): void {
    this.#loginProbe = null;
  }

  /**
   * Whether THIS login's probe (registered via {@link beginLoginProbe}) was
   * token-upgraded by this provider DURING the given generation. The login flow
   * passes the generation it snapshotted right after its `reset()`. This is the
   * PRIMARY, per-probe proof of login — strictly stronger than the provider-wide
   * token-attach count, which a concurrent upgrade for the SAME requested WebID (a
   * different request) could bump spuriously. Matched in {@link upgrade} by object
   * identity OR URL, single-use within the generation, so a same-URL non-probe
   * upgrade cannot steal the proof. Cleared by {@link reset}.
   */
  wasLoginProbeUpgraded(generation: number): boolean {
    return this.#probeUpgradedGeneration === generation;
  }

  /**
   * Drop EVERY piece of per-identity state so nothing from a prior login can be
   * reused by the next one: the memoised issuer resolution, every cached
   * per-issuer session (its DPoP key pair + access/refresh tokens), the
   * authenticated-WebID claim, the per-probe upgrade record, and the running
   * token-attachment count. Also ADVANCES the generation and aborts any in-flight
   * auth controller, so an `upgrade()`/`#authenticate()` already running for the
   * prior identity is both cancelled AND fenced from writing state after it
   * resolves (see {@link #generation}).
   *
   * MUST be called on logout AND at the start of a new login. Without it, the
   * provider keeps the previous user's issuer + DPoP-bound token in memory, so a
   * login as a DIFFERENT WebID would silently reuse the prior identity's session
   * (a cross-user session leak), and a login-detection probe that only checks
   * "is a token attached" would look authenticated with the STALE token. Resetting
   * `#tokensAttached` to 0 also guarantees the per-attempt before/after delta the
   * login flow relies on starts from a clean baseline for the new identity.
   */
  reset(): void {
    // Advance the generation FIRST so any in-flight work that resolves after this
    // point sees a stale generation and writes nothing.
    this.#generation += 1;
    // Actively cancel in-flight auth work spawned by the prior identity.
    this.#authController.abort();
    this.#authController = new AbortController();
    this.#issuer = undefined;
    this.#sessions.clear();
    this.#authenticatedWebId = undefined;
    this.#loginProbe = null;
    this.#probeUpgradedGeneration = null;
    this.#tokensAttached = 0;
    // Also drop any persisted full-page-redirect (autologin) flow: a logout or a
    // NEW login must abandon a stale pending redirect record so its single-use
    // code/verifier/DPoP key cannot be resumed under a different identity.
    clearPersistedRedirectFlow();
  }

  /**
   * Whether `request` is the active login probe for THIS provider generation —
   * matched by OBJECT IDENTITY first (precise; survives when the manager does not
   * re-wrap), then by the probe's FULL url-with-fragment within the SAME
   * generation as a single-use fallback (the channel that carries across the
   * manager's `new Request(input)` re-wrap, where object identity is lost).
   *
   * The URL compared is `request.url`, which for the probe INCLUDES the unique
   * unguessable `#probe-<uuid>` fragment ({@link withProbeFragment}). Because that
   * fragment is unforgeable and off-the-wire, a same-base-URL data fetch (no
   * fragment, or a different/guessed one) produces a DIFFERENT `request.url` and
   * can NEVER match — closing roborev finding 2 (the bare-URL fallback was
   * forgeable by the first same-URL request in the generation). Single-use is KEPT
   * as defence-in-depth: the first match consumes the probe so a later request
   * with the same (already-leaked) URL in the same generation cannot re-acquire
   * the proof.
   */
  #matchesLoginProbe(request: Request): boolean {
    const probe = this.#loginProbe;
    // Only this generation's probe can match — a probe registered before a reset()
    // (which bumped the generation) is stale and must never satisfy a later upgrade.
    if (!probe || probe.consumed || probe.generation !== this.#generation) return false;
    // URL match compares the FULL url INCLUDING the unguessable probe fragment, so
    // an unrelated same-base-URL fetch (no/other fragment) cannot satisfy it.
    const matches = probe.object.deref() === request || probe.url === request.url;
    if (matches) probe.consumed = true; // single-use within the generation (defence-in-depth).
    return matches;
  }

  async upgrade(request: Request): Promise<Request> {
    // Match THIS request against the active login probe on the ORIGINAL request we
    // were handed — BEFORE any clone we make below to add Authorization (a clone is
    // a different object and would not match by identity). No header is on the wire;
    // this is a pure in-process check keyed on object identity (then the FULL
    // url-with-fragment), so a cross-origin probe stays a "simple" request and
    // triggers no CORS preflight. The URL fallback compares the probe's unguessable
    // `#probe-<uuid>` fragment, so an unrelated same-base-URL fetch cannot forge the
    // proof (finding 2). The match is single-use (defence-in-depth) so a later
    // same-URL request in this generation cannot re-acquire it — but we only RECORD
    // the upgrade after the generation fence passes and a token is actually
    // attached (below), never for a superseded/failed attempt.
    const isLoginProbe = this.#matchesLoginProbe(request);
    // Capture the generation + controller for THIS attempt up front. A concurrent
    // reset() advances the generation and swaps the controller; comparing against
    // the captured generation before any state write fences this attempt out.
    const generation = this.#generation;
    const controller = this.#authController;
    if (this.#issuer === undefined) {
      // Capture the EXACT promise we install so the catch only clears state it
      // actually owns. Without this, an OLD aborted issuer resolution rejecting
      // LATER (after a reset() advanced the generation and a NEW resolution is in
      // flight) would blindly clear `#issuer = undefined`, destroying the current
      // generation's single-flight — later requests would re-prompt or fail. The
      // catch below clears ONLY if the generation is unchanged AND `#issuer` is
      // still this same pending promise; a superseded/aborted resolution clears
      // nothing.
      const resolution: Promise<URL> = this.#resolveIssuer(controller.signal).catch((e) => {
        if (this.#generation === generation && this.#issuer === resolution) {
          this.#issuer = undefined; // allow retry after cancel/failure, current gen only
        }
        throw e;
      });
      this.#issuer = resolution;
    }
    const issuer = await this.#issuer;
    const session = await this.#getSession(issuer, generation, controller.signal);
    // FENCE (pre-await, fail fast): if a reset() (logout / new-login) advanced the
    // generation while this upgrade was in flight (issuer resolution / login), the
    // result belongs to a SUPERSEDED identity. Mutate NO provider state and reject.
    // This is the cheap early-out; the AUTHORITATIVE fence is re-checked AFTER the
    // proof await below — a reset() can still fire DURING `DPoP.generateProof()`.
    if (generation !== this.#generation) {
      throw new ReactiveAuthResetError();
    }
    // RFC 9449 §4.2 htu: scheme + authority + path only (query + fragment removed).
    // `request.url` may carry the in-process `#probe-<uuid>` marker fragment (and a
    // query); the `dpop` package uses this argument VERBATIM, so we MUST strip them
    // here or the proof's `htu` would not match the htu the server computes from the
    // fragment/query-stripped received request URI (the marker is never on the wire).
    const htu = httpUri(request.url);
    // Generate the proof into a LOCAL FIRST — before writing ANY provider state.
    // `DPoP.generateProof()` is awaited, and a reset() (logout / new login) can fire
    // DURING that await; the pre-await fence above does NOT cover this window. Doing
    // the (state-free) proof generation first lets us re-fence immediately after and
    // only then mutate state, so a reset racing the proof await writes nothing.
    const proof = await DPoP.generateProof(
      session.dpopKey,
      htu,
      request.method,
      undefined,
      session.accessToken,
    );
    // RE-FENCE (post-await, authoritative): a reset() may have advanced the
    // generation WHILE the proof await above was parked. If so, this attempt is now
    // superseded — reject and mutate NO provider state, so a stale upgrade can never
    // publish its identity (#authenticatedWebId), attach the old token, bump
    // #tokensAttached, or record #probeUpgradedGeneration for a superseded
    // generation (which would contaminate the next identity's clean baseline). Every
    // state write below MUST stay after this re-check.
    if (generation !== this.#generation) {
      throw new ReactiveAuthResetError();
    }
    // Record the identity the OP vouched for, so the login flow can confirm it
    // matches the requested WebID. Set here (not only at session creation) so a
    // cached/in-flight session shared across concurrent 401s also publishes it.
    // MUST be after the re-fence — a superseded attempt must not publish its identity.
    this.#authenticatedWebId = session.authenticatedWebId;
    const headers = new Headers(request.headers);
    headers.set("DPoP", proof);
    headers.set("Authorization", ["DPoP", session.accessToken].join(" "));
    // A token was minted AND attached: the auth flow ran to completion. Bump the
    // running total (only after the session resolved AND the re-fence passed — a
    // cancelled/failed/superseded flow throws above and never reaches here, so the
    // count is not bumped). The login flow reads this count BEFORE and AFTER its
    // probe; the DELTA — not any sticky flag — is what proves a token was attached
    // during THAT attempt.
    this.#tokensAttached += 1;
    // PER-PROBE PROOF: if THIS request is THIS login's probe (matched at the top of
    // upgrade() on the original request, by object identity or the full
    // url-with-fragment within this generation), record that a token was attached
    // to the probe IN THIS GENERATION. The login
    // flow asserts wasLoginProbeUpgraded(its snapshot generation) — proving THIS
    // probe was upgraded, not merely that some request was. Single-flight login
    // guarantees no other login can occupy this generation, and the re-fence above
    // guarantees we only record for the current, non-superseded identity. No header
    // was ever on the wire, so cross-origin login is unaffected.
    if (isLoginProbe) this.#probeUpgradedGeneration = generation;
    // The returned Request's `.url` still carries the probe fragment (it is built
    // from the original `request`), but that is CORRECT and needs no stripping: a
    // fragment is client-side only (RFC 3986 §3.5), so the browser drops it before
    // sending — the on-the-wire request URI is already fragment-less and matches the
    // fragment-stripped `htu` minted above. The fragment is preserved here only so
    // in-process probe matching keeps working; it never reaches the server.
    return new Request(request, { headers });
  }

  /** Reuse the (possibly in-flight) session for the issuer, else run the code flow once. */
  async #getSession(issuer: URL, generation: number, signal: AbortSignal): Promise<IssuerSession> {
    // A reset() between issuer resolution and here means this attempt is already
    // superseded — run the login NOT cached, so a stale attempt can never seed the
    // current generation's #sessions map. The upgrade() fence then discards it.
    if (generation !== this.#generation) {
      return this.#authenticate(issuer, signal);
    }
    const cached = this.#sessions.get(issuer.href);
    if (cached) return cached;
    const pending = this.#authenticate(issuer, signal).catch((e) => {
      // Only retract THIS generation's cache entry. If a reset() advanced the
      // generation, #sessions was already cleared and may hold the NEXT identity's
      // in-flight login — deleting blindly here could evict it. Guard on the
      // captured generation so a superseded attempt's failure cannot disturb the
      // current one's cache.
      if (generation === this.#generation) this.#sessions.delete(issuer.href);
      throw e;
    });
    this.#sessions.set(issuer.href, pending);
    return pending;
  }

  /**
   * The published DPoPTokenProvider flow, verbatim except for two changes
   * threaded through: the insecure-loopback option on every oauth4webapi call,
   * and a STATIC-vs-DYNAMIC client branch. Flow: discovery → client identity
   * (static Client Identifier Document when {@link WebIdDPoPTokenProviderOptions.clientId}
   * is set, else dynamic client registration) → PKCE/DPoP authorization-code
   * grant, with the `prompt=none` silent retry preserved.
   */
  async #authenticate(issuer: URL, signal: AbortSignal): Promise<IssuerSession> {
    const http = this.#httpOptions(issuer, signal);

    const authorizationServer = await this.#discover(issuer, http);

    const clientRegistration = await this.#resolveClient(authorizationServer, http);

    const [registeredRedirectUri] = (clientRegistration.redirect_uris as string[] | undefined) ?? [
      this.#callbackUri,
    ];
    const [registeredResponseType] = (clientRegistration.response_types as
      | string[]
      | undefined) ?? ["code"];

    const dpopKey = await oauth.generateKeyPair("ES256", { extractable: false });
    const dpop = oauth.DPoP({}, dpopKey);
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    const state = oauth.generateRandomState();

    const buildAuthorizationUrl = (withPrompt: boolean): URL => {
      const url = new URL(authorizationServer.authorization_endpoint as string);
      url.searchParams.set("client_id", clientRegistration.client_id);
      url.searchParams.set("redirect_uri", registeredRedirectUri);
      url.searchParams.set("response_type", registeredResponseType);
      url.searchParams.set("scope", "openid webid");
      if (withPrompt) url.searchParams.set("prompt", "none");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      if (authorizationServer.code_challenge_methods_supported !== undefined) {
        if (authorizationServer.code_challenge_methods_supported.includes("S256")) {
          url.searchParams.set("code_challenge_method", "S256");
          // challenge set asynchronously below
        } else {
          url.searchParams.set("code_challenge_method", "plain");
          url.searchParams.set("code_challenge", codeVerifier);
        }
      }
      return url;
    };

    // PKCE challenge (async) computed once and reused across prompt/no-prompt URLs.
    const usePkce = authorizationServer.code_challenge_methods_supported !== undefined;
    const useS256 =
      usePkce && authorizationServer.code_challenge_methods_supported?.includes("S256");
    const codeChallenge = useS256
      ? await oauth.calculatePKCECodeChallenge(codeVerifier)
      : codeVerifier;

    const authorizationUrl = buildAuthorizationUrl(true);
    if (usePkce) authorizationUrl.searchParams.set("code_challenge", codeChallenge);

    let authorizationCodeParams: URLSearchParams;
    const authorizationCodeResponse = await this.#getCode(authorizationUrl, signal);
    try {
      authorizationCodeParams = oauth.validateAuthResponse(
        authorizationServer,
        clientRegistration,
        new URL(authorizationCodeResponse),
        state,
      );
    } catch (e) {
      if (
        (e instanceof oauth.AuthorizationResponseError &&
          (e.error === "interaction_required" ||
            e.error === "consent_required" ||
            e.error === "login_required")) ||
        isEssMissingIssInteractionNeeded(e)
      ) {
        // The IdP needs the user to interact: retry once without `prompt=none`.
        const retryUrl = buildAuthorizationUrl(false);
        if (usePkce) retryUrl.searchParams.set("code_challenge", codeChallenge);
        const retryResponse = await this.#getCode(retryUrl, signal);
        authorizationCodeParams = oauth.validateAuthResponse(
          authorizationServer,
          clientRegistration,
          new URL(retryResponse),
          state,
        );
      } else {
        throw e;
      }
    }

    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      authorizationServer,
      clientRegistration,
      this.#clientAuth(authorizationServer.issuer, clientRegistration),
      authorizationCodeParams,
      this.#callbackUri,
      usePkce ? codeVerifier : oauth.nopkce,
      { DPoP: dpop, ...http },
    );
    const tokenResult = await oauth.processAuthorizationCodeResponse(
      authorizationServer,
      clientRegistration,
      tokenResponse,
      { expectedNonce: this.#nonceVerification(authorizationServer.issuer, nonce) },
    );

    return {
      authorizationServer,
      clientRegistration,
      dpopKey,
      accessToken: tokenResult.access_token,
      // The identity the OP actually vouched for. The login flow checks this
      // against the requested WebID before treating the user as logged in.
      authenticatedWebId: webIdFromClaims(oauth.getValidatedIdTokenClaims(tokenResult)),
    };
  }

  /**
   * Run OIDC discovery for an issuer and return its authorization server metadata
   * — the shared first step of BOTH the popup ({@link #authenticate}) and the
   * full-page-redirect ({@link beginRedirectLogin}/{@link completeRedirectLogin})
   * flows. Refactored out so the two paths cannot drift on discovery handling.
   */
  async #discover(
    issuer: URL,
    http: { signal: AbortSignal; [oauth.allowInsecureRequests]?: true },
  ): Promise<oauth.AuthorizationServer> {
    const discoveryResponse = await oauth.discoveryRequest(issuer, http);
    return oauth.processDiscoveryResponse(issuer, discoveryResponse);
  }

  // ── Two-phase FULL-PAGE redirect login (autologin) ──────────────────────────
  //
  // @solid/reactive-authentication 0.1.3 ships ONLY the POPUP <authorization-code-
  // flow> element — there is NO published non-popup/redirect mode. A popup
  // auto-opened on page load (no user gesture) is browser-blocked, so the autologin
  // deep-link MUST use a full-page redirect. A full-page redirect destroys all
  // in-memory state (the popup path keeps the DPoP key, PKCE verifier, state, nonce
  // in #authenticate's closure — all lost on navigation), so this is a TWO-PHASE
  // flow that PERSISTS the in-between state to sessionStorage:
  //   beginRedirectLogin()    — before navigating away
  //   completeRedirectLogin() — after the broker redirects back
  // These are NEW code paths; the popup #authenticate / upgrade / reset are
  // untouched and obey the same generation fence.

  /**
   * PHASE 1 of the full-page-redirect (autologin) login. Resolves the issuer from
   * the pending WebID (via the same `#resolveIssuer` path the popup uses), runs
   * discovery + client resolution, generates an **EXTRACTABLE** ES256 DPoP keypair
   * + PKCE verifier + `state` + `nonce`, builds the authorization URL, and PERSISTS
   * to sessionStorage everything {@link completeRedirectLogin} needs to resume after
   * the redirect erases all in-memory state. Returns the authorization URL the
   * caller navigates to (`location.assign`).
   *
   * Differences from the popup `#authenticate` (deliberate, per the redirect path):
   *  - the DPoP key is `extractable: true` so it can be exported to JWK + persisted
   *    + re-imported after the redirect (the popup key stays `extractable: false`);
   *  - scope is `openid webid offline_access` (the popup uses `openid webid`) so the
   *    redirect path can obtain a refresh token;
   *  - redirect_uri is the app-root `redirectReturnUri` the caller passes (the page
   *    that re-runs SessionProvider and can read `?code&state`), NOT the popup's
   *    `#callbackUri` (callback.html only does postMessage and does not run the app).
   *
   * @param redirectReturnUri the app-root URL the broker redirects back to; it MUST
   *   be one of the client document's registered `redirect_uris`, and is persisted +
   *   reused VERBATIM in the token exchange (the two must match byte-for-byte).
   */
  async beginRedirectLogin(redirectReturnUri: string): Promise<{ authorizationUrl: string }> {
    // Capture the generation for THIS flow up front; a reset() advances it and we
    // re-check after each await before persisting (consistent with upgrade()).
    const generation = this.#generation;
    const controller = this.#authController;
    const signal = controller.signal;

    const issuer = await this.#resolveIssuer(signal);
    if (generation !== this.#generation) throw new ReactiveAuthResetError();

    const http = this.#httpOptions(issuer, signal);
    const authorizationServer = await this.#discover(issuer, http);
    if (generation !== this.#generation) throw new ReactiveAuthResetError();

    const clientRegistration = await this.#resolveClient(authorizationServer, http);
    if (generation !== this.#generation) throw new ReactiveAuthResetError();

    // EXTRACTABLE so the key survives the full-page redirect (exported to JWK,
    // persisted, re-imported in completeRedirectLogin). The popup path's key stays
    // non-extractable — this is the ONE place we export a DPoP key, and only because
    // the redirect erases the closure that would otherwise hold it.
    const dpopKey = await oauth.generateKeyPair("ES256", { extractable: true });
    if (generation !== this.#generation) throw new ReactiveAuthResetError();
    const dpopPrivateJwk = await crypto.subtle.exportKey("jwk", dpopKey.privateKey);
    const dpopPublicJwk = await crypto.subtle.exportKey("jwk", dpopKey.publicKey);

    const codeVerifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    const state = oauth.generateRandomState();

    const usePkce = authorizationServer.code_challenge_methods_supported !== undefined;
    const useS256 =
      usePkce && authorizationServer.code_challenge_methods_supported?.includes("S256");
    const codeChallenge = useS256
      ? await oauth.calculatePKCECodeChallenge(codeVerifier)
      : codeVerifier;
    if (generation !== this.#generation) throw new ReactiveAuthResetError();

    const authorizationUrl = new URL(authorizationServer.authorization_endpoint as string);
    authorizationUrl.searchParams.set("client_id", clientRegistration.client_id);
    authorizationUrl.searchParams.set("redirect_uri", redirectReturnUri);
    authorizationUrl.searchParams.set("response_type", "code");
    // offline_access so the redirect path can mint a refresh token (silent SSO).
    authorizationUrl.searchParams.set("scope", "openid webid offline_access");
    // prompt=none makes autologin SILENT-with-fallback: a live OP session returns
    // the code without showing an interactive page; an ABSENT session makes the OP
    // return ?error=login_required (or interaction_required/consent_required) which
    // SessionProvider's OIDC-error abort path catches to clean up + fall back to the
    // normal interactive login. Without it the redirect would render an interactive
    // IdP page on autologin (no SSO session), and that abort path would be
    // unreachable. The popup path keeps its own two-attempt prompt=none→retry logic
    // (buildAuthorizationUrl) and is intentionally NOT touched here.
    authorizationUrl.searchParams.set("prompt", "none");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    if (usePkce) {
      authorizationUrl.searchParams.set("code_challenge_method", useS256 ? "S256" : "plain");
      authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    }

    const flow: PersistedRedirectFlow = {
      dpopPrivateJwk,
      dpopPublicJwk,
      codeVerifier,
      usePkce,
      state,
      nonce,
      issuer: issuer.href,
      clientId: clientRegistration.client_id,
      redirectUri: redirectReturnUri,
      webId: validateWebId(await this.#getWebId()),
    };
    // Final fence before we touch persistent state: a reset() during any await
    // above means this flow is superseded — persist nothing, throw.
    if (generation !== this.#generation) throw new ReactiveAuthResetError();
    try {
      globalThis.sessionStorage.setItem(REDIRECT_FLOW_KEY, JSON.stringify(flow));
    } catch (e) {
      throw new Error(
        `Could not persist the redirect login state to sessionStorage: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return { authorizationUrl: authorizationUrl.toString() };
  }

  /**
   * PHASE 2 of the full-page-redirect (autologin) login, run on the page the broker
   * redirected back to (the app root, carrying `?code&state`). Reads the persisted
   * record, RE-IMPORTS the DPoP JWK + reconstructs `oauth.DPoP`, validates the auth
   * response against the persisted `state`, exchanges the code (DPoP-bound, with the
   * persisted `nonce` expected), and ESTABLISHES the session in `#sessions` (so the
   * patched global fetch upgrades subsequent reads) and `#authenticatedWebId` (from
   * the id_token claims), bumping `#tokensAttached`.
   *
   * It CLEARS the persisted record in a `finally` (success OR failure) so a refresh
   * / back-button cannot replay it. On any failure it throws and leaves the provider
   * RESET-CLEAN — it does NOT half-establish a session. Obeys the same generation
   * fence as the rest of the provider: the generation is captured up front and
   * re-checked after every await before any provider state is written.
   *
   * @param callbackUrl the full return URL (`location.href`) with `?code&state`.
   */
  async completeRedirectLogin(callbackUrl: string): Promise<void> {
    const flow = readPersistedRedirectFlow();
    if (!flow) {
      throw new Error("No pending redirect login to complete (no persisted state found).");
    }
    // Capture the fence up front. Any reset() (logout / a new login) during the
    // awaits below supersedes this completion — it then writes NO provider state.
    const generation = this.#generation;
    const controller = this.#authController;
    const signal = controller.signal;
    try {
      const issuer = new URL(flow.issuer);
      const http = this.#httpOptions(issuer, signal);
      const authorizationServer = await this.#discover(issuer, http);
      if (generation !== this.#generation) throw new ReactiveAuthResetError();

      const clientRegistration: oauth.Client = {
        client_id: flow.clientId,
        token_endpoint_auth_method: "none",
        redirect_uris: [flow.redirectUri],
        response_types: ["code"],
      };

      // Re-import the persisted ES256 DPoP key (extractable so it survived the
      // redirect) and rebuild the DPoP handle for the token exchange.
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        flow.dpopPrivateJwk,
        ES256_IMPORT_ALG,
        true,
        ["sign"],
      );
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        flow.dpopPublicJwk,
        ES256_IMPORT_ALG,
        true,
        ["verify"],
      );
      if (generation !== this.#generation) throw new ReactiveAuthResetError();
      const dpopKey: CryptoKeyPair = { privateKey, publicKey };
      const dpop = oauth.DPoP(clientRegistration, dpopKey);

      // Validate the auth response against the PERSISTED state (CSRF/mix-up guard).
      const authorizationCodeParams = oauth.validateAuthResponse(
        authorizationServer,
        clientRegistration,
        new URL(callbackUrl),
        flow.state,
      );

      const tokenResponse = await oauth.authorizationCodeGrantRequest(
        authorizationServer,
        clientRegistration,
        this.#clientAuth(authorizationServer.issuer, clientRegistration),
        authorizationCodeParams,
        // The redirect_uri MUST match the one sent in the authorization request.
        flow.redirectUri,
        flow.usePkce ? flow.codeVerifier : oauth.nopkce,
        { DPoP: dpop, ...http },
      );
      if (generation !== this.#generation) throw new ReactiveAuthResetError();
      const tokenResult = await oauth.processAuthorizationCodeResponse(
        authorizationServer,
        clientRegistration,
        tokenResponse,
        { expectedNonce: this.#nonceVerification(authorizationServer.issuer, flow.nonce) },
      );
      // AUTHORITATIVE fence: a reset() may have fired during the token-exchange
      // awaits. If so this completion is superseded — write NO state, reject.
      if (generation !== this.#generation) throw new ReactiveAuthResetError();

      const authenticatedWebId = webIdFromClaims(oauth.getValidatedIdTokenClaims(tokenResult));
      // SECURITY (finding B — cross-identity guard, fail-closed): the OP may have an
      // active session for a DIFFERENT account that satisfies this deep-link, so the
      // id_token's WebID is NOT necessarily the one the user asked to log in as. PROVE
      // the OP authenticated AS the persisted requested WebID (`flow.webId`) BEFORE
      // writing ANY provider state — exactly the invariant the popup path enforces in
      // doLogin, but enforced HERE so the provider is authoritative (not reliant on the
      // SessionProvider's defence-in-depth check). `webIdsEqual` returns false if either
      // side is missing/unparseable, so an absent webId (token OR persisted record)
      // fails closed. The `finally` clears the persisted record, so this throw leaves
      // the provider reset-clean (no session, no #issuer, no authenticatedWebId, no
      // token-attach bump).
      if (!webIdsEqual(authenticatedWebId, flow.webId)) {
        throw new Error(
          "Login did not complete — the identity provider authenticated a different " +
            `WebID (${authenticatedWebId ?? "unknown"}) than the one requested ` +
            `(${flow.webId}). For your security you were not logged in.`,
        );
      }
      const session: IssuerSession = {
        authorizationServer,
        clientRegistration,
        dpopKey,
        accessToken: tokenResult.access_token,
        authenticatedWebId,
      };
      // Establish the session so the patched global fetch upgrades subsequent reads,
      // and publish the authenticated identity + count the attach (all AFTER the
      // re-fence so a superseded completion publishes nothing).
      this.#sessions.set(issuer.href, Promise.resolve(session));
      // FINDING A: seed #issuer with the resolved issuer of THIS completion, so a later
      // upgrade() (a data fetch on the now-authenticated page) REUSES the seeded session
      // instead of falling into #resolveIssuer → getWebId() (which has no pending WebID
      // after the full-page redirect and would throw). Mirrors how upgrade()/#getSession
      // rely on #issuer being set for subsequent upgrades. Written here, alongside the
      // other state writes AFTER the authoritative generation re-fence, so a superseded
      // completion seeds nothing.
      this.#issuer = Promise.resolve(issuer);
      this.#authenticatedWebId = authenticatedWebId;
      this.#tokensAttached += 1;
    } finally {
      // Clear the persisted record whether we succeeded OR failed, so a refresh /
      // back-button can never replay the (single-use) code + verifier + key.
      clearPersistedRedirectFlow();
    }
  }

  /**
   * Resolve the OAuth client used for this issuer.
   *
   * - **Static (a Client Identifier Document):** when `clientId` is set, return a
   *   public {@link oauth.Client} whose `client_id` IS that URL, with
   *   `token_endpoint_auth_method: "none"`. No network call is made here — the OP
   *   dereferences the document itself at the authorization/token endpoints and
   *   matches the redirect_uri against the document's `redirect_uris`. The
   *   document must therefore list this provider's `callbackUri`. `redirect_uris`
   *   and `response_types` are seeded locally so the shared URL-building code
   *   below has the values it needs.
   * - **Dynamic (the default):** dynamic client registration, exactly as the
   *   published provider does — a throwaway client per session, no stable name.
   */
  async #resolveClient(
    authorizationServer: oauth.AuthorizationServer,
    http: { signal: AbortSignal; [oauth.allowInsecureRequests]?: true },
  ): Promise<oauth.Client> {
    if (this.#clientId !== undefined) {
      // A public browser client identified by a dereferenceable URL. `oauth.Client`
      // requires only `client_id`; the rest are accepted via its index signature
      // and consumed by the shared authorization-URL builder below.
      return {
        client_id: this.#clientId,
        token_endpoint_auth_method: "none",
        redirect_uris: [this.#callbackUri],
        response_types: ["code"],
      };
    }
    const registrationResponse = await oauth.dynamicClientRegistrationRequest(
      authorizationServer,
      { redirect_uris: [this.#callbackUri] },
      http,
    );
    return oauth.processDynamicClientRegistrationResponse(registrationResponse);
  }

  /** Client authentication, mirroring the published provider's ESS workaround. */
  #clientAuth(issuer: string, client: oauth.Client): oauth.ClientAuth {
    if (client.token_endpoint_auth_method === "client_secret_basic") {
      return clientSecretBasicFor(issuer)(client.client_secret as string);
    }
    return oauth.None();
  }

  /** Some servers (NSS/ESS variants) omit the nonce; expect none for them. */
  #nonceVerification(issuer: string, nonce: string): string | typeof oauth.expectNoNonce {
    if (issuer === "https://datapod.igrant.io" || issuer === "https://solidweb.org") {
      return oauth.expectNoNonce;
    }
    return nonce;
  }
}

/**
 * Compare two WebIDs for IDENTITY equality, tolerant only of trivial URL
 * normalisation (case-insensitive scheme + host, default-port elision), never of
 * a different path/fragment. Returns false if either side is missing or unparseable
 * — an unverifiable identity must FAIL closed, not pass. Used by the login flow to
 * confirm the OP authenticated the user as the WebID they asked to log in as.
 */
export function webIdsEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.protocol === ub.protocol &&
      ua.host.toLowerCase() === ub.host.toLowerCase() &&
      ua.pathname === ub.pathname &&
      ua.search === ub.search &&
      ua.hash === ub.hash
    );
  } catch {
    return false;
  }
}

/**
 * The WebID an id_token authenticated AS. Solid-OIDC carries the WebID in the
 * `webid` claim; when absent (some servers put it in `sub`), `sub` is the WebID.
 * Returns undefined when neither is a usable string — the caller then refuses to
 * treat the login as verified rather than guessing an identity.
 */
function webIdFromClaims(claims: oauth.IDToken | undefined): string | undefined {
  if (!claims) return undefined;
  const webid = claims.webid;
  if (typeof webid === "string" && webid.length > 0) return webid;
  if (typeof claims.sub === "string" && claims.sub.length > 0) return claims.sub;
  return undefined;
}

function isEssMissingIssInteractionNeeded(e: unknown): boolean {
  try {
    return (
      (e as { cause: { parameters: URLSearchParams } }).cause.parameters.get("error") ===
      "interaction_required"
    );
  } catch {
    return false;
  }
}

/**
 * A variant of oauth4webapi's ClientSecretBasic that does NOT url-encode id and
 * secret — PodSpaces (ESS) fails when the spec is followed.
 * @see https://www.rfc-editor.org/rfc/rfc6749.html#section-2.3.1
 */
function noUrlEncodeClientSecretBasic(clientSecret: string): oauth.ClientAuth {
  return (_as, client, _body, headers) => {
    headers.set("Authorization", `Basic ${btoa(`${client.client_id}:${clientSecret}`)}`);
  };
}

function clientSecretBasicFor(issuer: string): (secret: string) => oauth.ClientAuth {
  if (issuer.includes("login.inrupt.com")) return noUrlEncodeClientSecretBasic;
  return oauth.ClientSecretBasic;
}

// NOTE: the upstream reference `promptWebIdDialog` (a default `getWebId` UI) is
// intentionally OMITTED here — this host supplies its own `getWebId` from the
// LoginScreen's WebID input, so the dialog helper is dead code in this shell.
