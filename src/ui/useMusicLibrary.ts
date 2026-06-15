// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// The music-library's data hook — the SINGLE place the view touches the data
// layer. It owns the "which section am I viewing + its loading/error state"
// concern and delegates the actual list+read to `loadLibrary` (library.ts); it
// never re-implements LDP/RDF reading.
//
// ── AUTH SEAM ────────────────────────────────────────────────────────────────
// The authenticated `fetch` is INJECTED, not imported. Pass the session's fetch
// via the `fetch` option; omit it and the data layer (MusicStore) falls back to
// the global `fetch`. In production that global is the one
// @solid/reactive-authentication's ReactiveFetchManager.registerGlobally()
// patches (so a plain fetch transparently upgrades on a 401 with a DPoP token),
// wired ONCE in the create-solid-app shell's <SolidAuthProvider>. That wiring is
// #18-gated (create-solid-app S2 — interactive auth-code login;
// https://github.com/solid-contrib/reactive-authentication/issues/18). This hook
// is DELIBERATELY unaware of any of that: it works today against a stubbed fetch
// in unit tests and later against the real session with NO code change. Do NOT
// hard-wire a login flow here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MusicStore } from "../lib/store.js";
import { errorMessage } from "./format.js";
import type { LibraryItem, LibraryKind } from "./library.js";
import { ensureTrailingSlash, isAccessDenied, loadLibrary } from "./library.js";

/** What the view needs to render a section + its states. */
export interface MusicLibraryState {
  /** The current section's rows; `[]` until the first load resolves (or when empty). */
  items: LibraryItem[];
  /** The section currently being viewed. */
  kind: LibraryKind;
  /** True while a list+read is in flight. */
  loading: boolean;
  /**
   * A user-facing error message for the current section, or `null`. A 401/403 is
   * reported as a distinct login-/permission-flavoured message; any other
   * failure (404, network, parse) is reported generically.
   */
  error: string | null;
  /** True when the current error is an authentication/authorization failure (401/403). */
  isAccessError: boolean;
  /** Switch to another section (tracks / albums / playlists). */
  selectKind: (kind: LibraryKind) => void;
  /** Re-fetch the current section (e.g. a manual "retry" after an error). */
  refresh: () => void;
}

/** Options for {@link useMusicLibrary}. */
export interface UseMusicLibraryOptions {
  /**
   * The authenticated fetch. Omit to use the ambient global fetch (which
   * @solid/reactive-authentication patches in a real session). This is the
   * injectable auth seam — see the file header.
   */
  fetch?: typeof fetch;
  /** The section to open first. Defaults to `"tracks"`. */
  initialKind?: LibraryKind;
}

/**
 * React state for browsing a Solid music library. `base` is normalised to a
 * single trailing slash (it is the pod-music container base, e.g.
 * `.../music/`); the hook loads the current section on mount, whenever the user
 * switches section, and again whenever the (normalised) `base` prop changes — a
 * new base resets the view to its initial section rather than stranding it on
 * the previous pod's data. It cancels an in-flight load on switch/unmount so a
 * slow earlier request can never overwrite a newer one (the classic stale race).
 * All reads go through `loadLibrary` → `MusicStore`, so WAC handling, the typed
 * model, and the safe label fallback come for free.
 */
export function useMusicLibrary(
  base: string,
  options: UseMusicLibraryOptions = {},
): MusicLibraryState {
  const { fetch: authedFetch, initialKind = "tracks" } = options;
  // Normalise the base to a single trailing slash BEFORE it seeds any state, so
  // a slashless `base` still drives slash-terminated container GETs. The raw
  // prop is never used directly. (The per-class CONTAINER URLs the store derives
  // from this base are already slash-terminated; a track resource IRI is not a
  // container and is never slashed.)
  const normalizedBase = ensureTrailingSlash(base);

  // The store is rebuilt only when the base or the injected fetch changes — it
  // is a thin wrapper around them, so this keeps `loadLibrary`'s store identity
  // stable across unrelated re-renders.
  const store = useMemo(
    () =>
      new MusicStore(
        authedFetch ? { base: normalizedBase, fetch: authedFetch } : { base: normalizedBase },
      ),
    [normalizedBase, authedFetch],
  );

  const [kind, setKind] = useState<LibraryKind>(initialKind);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAccessError, setIsAccessError] = useState(false);
  // Bumped to force a re-fetch of the same section (refresh) without a change.
  const [reloadToken, setReloadToken] = useState(0);
  // Guards against a resolved-but-stale response overwriting newer state.
  const requestIdRef = useRef(0);
  // Tracks the normalised base the current state belongs to, kept in STATE (not
  // a ref) so the prop-change reset is concurrent-rendering safe: a ref written
  // during render can leak from an ABANDONED render, which would make a later
  // committed render with the same base skip the reset and strand the view on
  // the previous pod's data. State set during render is applied by React only
  // when the render commits, so the comparison below is always against the
  // committed value.
  const [prevBase, setPrevBase] = useState(normalizedBase);

  // Reset ALL state DURING render when the normalised base prop changes (React's
  // documented "adjusting state when a prop changes" pattern — applies in the
  // same commit, so the view never flashes the previous pod's section or a stale
  // loading flag). EVERY flag is reset, including `loading`, so a base change can
  // never leave a stale `loading=false` over empty data. The load effect below
  // then fetches the reset section. The mount case is excluded because
  // `prevBase` is seeded with the initial base.
  if (prevBase !== normalizedBase) {
    setPrevBase(normalizedBase);
    setKind(initialKind);
    setItems([]);
    setLoading(false);
    setError(null);
    setIsAccessError(false);
  }

  // `reloadToken` is a deliberate re-fetch TRIGGER (bumped by refresh()): it is
  // not read in the body, but its change must re-run the effect to load the same
  // section again. The static analyzer can't infer that intent — hence the
  // explicit dependency plus this suppression.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is an intentional refetch trigger
  useEffect(() => {
    // Each run claims a monotonic request id. A load (which cannot be cancelled —
    // the store exposes no abort) is discarded on settle if a newer run has since
    // claimed a higher id, so a slow earlier load can never overwrite a newer
    // one — the classic stale-response race — on EITHER the success or failure
    // path.
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setIsAccessError(false);

    loadLibrary(store, kind)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return; // a newer load superseded this one
        }
        setItems(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // The cleanup below bumps `requestIdRef`, so a superseded load is caught
        // by this same staleness check — we never surface an error or state from
        // a request that is no longer current.
        if (requestId !== requestIdRef.current) {
          return;
        }
        if (isAccessDenied(err)) {
          setIsAccessError(true);
          setError(
            err.status === 401
              ? "You need to log in to view this library."
              : "You don't have permission to view this library.",
          );
        } else {
          setError(errorMessage(err));
        }
        setLoading(false);
      });

    return () => {
      // Mark any in-flight response as stale so its settle is ignored.
      requestIdRef.current++;
    };
  }, [store, kind, reloadToken]);

  const selectKind = useCallback((next: LibraryKind) => {
    setKind(next);
  }, []);

  const refresh = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  return {
    items,
    kind,
    loading,
    error,
    isAccessError,
    selectKind,
    refresh,
  };
}
