// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// session-derivation.ts — derive the values <MusicLibrary> needs (the music
// library container `base` + the WebID) from the authenticated session.
//
// WHAT <MusicLibrary> NEEDS (and why it differs from pod-docs):
// <MusicLibrary base /> hands `base` to @jeswr/pod-music's `useMusicLibrary` →
// `MusicStore`, which derives its per-class containers (`tracks/`, `albums/`,
// `playlists/`, …) DIRECTLY under `base`. So unlike pod-docs (where the data
// layer owns container discovery from a bare pod root), `base` MUST already be
// the music library container itself — e.g. `https://alice.example/music/` — not
// the pod root. The host therefore (a) derives the pod ROOT from the profile,
// then (b) resolves the music container under/within it.
//
// POD-ROOT DERIVATION (first that yields a value):
//   1. the FIRST `pim:storage` advertised on the WebID profile (the canonical
//      Solid signal for "where this user's storage lives"). Most pods (CSS, PSS,
//      ESS) advertise exactly one; we take the first and note multi-storage as a
//      follow-up (a storage picker).
//   2. fallback: the WebID's ORIGIN + "/" — a reasonable guess when a profile
//      omits pim:storage (e.g. a bare CSS profile). The data layer's WAC + SSRF
//      guards still protect every read, so a wrong guess fails closed.
//
// MUSIC-BASE DISCOVERY (Type Index first, conventional fallback):
//   The data layer ships a real Type-Index discovery helper —
//   `MusicStore.findTrackContainers(webId)` — which reads the user's PUBLIC type
//   index off the WebID profile and returns the container(s) registered for
//   `mo:Track` (Pod Music's primary class; the closest Solid-OIDC convention to
//   the prompt's schema:MusicRecording/MusicPlaylist intent). A registered
//   container is the `tracks/` per-class container, so the music `base` is its
//   PARENT (strip the trailing `tracks/` segment). When no profile link or no
//   registration exists we fall back to the conventional `${podRoot}music/` and
//   surface a banner so the user knows discovery did not find a registration.
import type { MusicStore } from "@jeswr/pod-music";
import type { Profile } from "./profile";

export interface DerivedSession {
  /** The pod root URL (always ends in "/"). The music base is resolved under it. */
  podRoot: string;
  /** The authenticated user's WebID. Passed to discovery + shown in the header. */
  webId: string;
  /** True when the pod root came from the WebID origin fallback, not pim:storage. */
  podRootIsFallback: boolean;
}

/** The resolved music library container `base` + how it was discovered. */
export interface MusicBase {
  /** The music library container URL (always ends in "/"). Passed to <MusicLibrary base>. */
  base: string;
  /**
   * True when `base` is the conventional `${podRoot}music/` fallback rather than
   * a Type-Index registration for `mo:Track`. Drives the host's discovery banner.
   */
  isFallback: boolean;
}

/** Ensure a container URL ends in a single trailing slash. */
function asContainer(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Derive the pod root + WebID from a read profile (the synchronous part). */
export function deriveSession(profile: Profile): DerivedSession {
  const storage = profile.storages[0];
  if (storage) {
    return {
      podRoot: asContainer(storage),
      webId: profile.webId,
      podRootIsFallback: false,
    };
  }
  // Fallback: the WebID's origin. new URL("/", webId) gives `scheme://host/`.
  const fallback = new URL("/", profile.webId).toString();
  return {
    podRoot: asContainer(fallback),
    webId: profile.webId,
    podRootIsFallback: true,
  };
}

/**
 * Given a Type-Index-registered `tracks/` container, return its PARENT — the
 * music library `base` that `MusicStore` expects (it derives `tracks/` back under
 * it). Returns undefined when the registered container does not end in a
 * recognisable `tracks/` segment, so the caller falls back to the conventional
 * path rather than guessing a wrong base. Exported for unit testing.
 */
export function musicBaseFromTracksContainer(tracksContainer: string): string | undefined {
  const slashed = asContainer(tracksContainer);
  // Strip a single trailing `tracks/` segment: `.../music/tracks/` → `.../music/`.
  const match = slashed.match(/^(.*\/)tracks\/$/);
  return match ? match[1] : undefined;
}

/**
 * Resolve the music library `base` for the session. Tries the user's Type Index
 * first (via the data layer's `findTrackContainers`), deriving the music base as
 * the PARENT of a registered `tracks/` container; falls back to the conventional
 * `${podRoot}music/` when there is no usable registration (and flags it so the
 * host can show a banner). A discovery read that throws (no profile link, a
 * 401/403/404, a parse error) is treated as "no registration" — the conventional
 * fallback always yields a usable base, never an error to the user.
 *
 * `store` is a `MusicStore` whose `fetch` is the authenticated session fetch (in
 * the host it is the global patched by reactive-auth, so it is passed implicitly
 * by leaving the store's default fetch). The store's own `base` is irrelevant
 * here — `findTrackContainers` reads the type index off the WebID, not the base.
 */
export async function discoverMusicBase(
  store: Pick<MusicStore, "findTrackContainers">,
  session: DerivedSession,
): Promise<MusicBase> {
  const conventional: MusicBase = {
    base: asContainer(`${session.podRoot}music/`),
    isFallback: true,
  };
  try {
    const containers = await store.findTrackContainers(session.webId);
    for (const container of containers) {
      const base = musicBaseFromTracksContainer(container);
      if (base) {
        return { base, isFallback: false };
      }
    }
  } catch {
    // No type index / no profile link / read failure → conventional fallback.
    return conventional;
  }
  return conventional;
}
