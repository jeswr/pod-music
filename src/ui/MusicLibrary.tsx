// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// The Pod Music library VIEW — a list of your music library held in a Solid pod:
// switch between Tracks / Albums / Playlists, each row showing title and (for
// tracks) artist / album / duration, with a link to open the resource's details.
// Playback is deliberately OUT OF SCOPE — this is a render-only library browser
// (list + open), not a player.
//
// This component is FRAMEWORK-AGNOSTIC React (no Next.js import, no "use client"
// pragma): it drops straight into the create-solid-app Next.js shell's
// `components/` or any React app. It renders only — it never touches RDF or
// fetch directly; all data flows through `useMusicLibrary`, which calls the data
// layer (MusicStore). Styling is plain class names (`pod-music-*`) so the host
// app's CSS owns the look; the component ships no styles of its own.
//
// AUTH SEAM: the `fetch` prop is the injected authenticated fetch, threaded to
// `useMusicLibrary` → the data layer. See useMusicLibrary.ts for the full note.

import { formatDuration, isSafeHref } from "./format.js";
import {
  iriTail,
  kindLabel,
  LIBRARY_KINDS,
  type LibraryItem,
  type LibraryKind,
} from "./library.js";
import { useMusicLibrary } from "./useMusicLibrary.js";

/** Props for {@link MusicLibrary}. */
export interface MusicLibraryProps {
  /**
   * The pod-music container base (MUST be the music base, e.g.
   * `https://alice.example/music/`). The per-class containers
   * (`tracks/`, `albums/`, `playlists/`) are derived from it.
   */
  base: string;
  /**
   * The authenticated fetch for pod reads. Omit to use the ambient global fetch
   * (patched by @solid/reactive-authentication in a real session). The
   * injectable auth seam — unit tests pass a stub here.
   */
  fetch?: typeof fetch;
  /** The section to open first. Defaults to `"tracks"`. */
  initialKind?: LibraryKind;
  /** Optional heading rendered above the listing. */
  title?: string;
}

/**
 * A reference cell for an artist/album IRI: a link when the IRI is a safe
 * http(s)/mailto URL, otherwise plain escaped text. An em-dash when absent.
 */
function ReferenceCell({ iri }: { iri: string | undefined }) {
  if (iri === undefined) {
    return <span className="pod-music-empty-cell">—</span>;
  }
  const label = iriTail(iri);
  if (isSafeHref(iri)) {
    return (
      <a className="pod-music-ref-link" href={iri} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  return <span className="pod-music-ref-text">{label}</span>;
}

/** The columns rendered for a section. Tracks are richest; albums show artist. */
function columnsFor(kind: LibraryKind): string[] {
  if (kind === "tracks") {
    return ["Title", "Artist", "Album", "Duration", ""];
  }
  if (kind === "albums") {
    return ["Title", "Artist", ""];
  }
  return ["Title", ""];
}

/** One row's cells (excluding the leading title + trailing open link). */
function MetaCells({ kind, item }: { kind: LibraryKind; item: LibraryItem }) {
  if (kind === "tracks") {
    return (
      <>
        <td>
          <ReferenceCell iri={item.artistIri} />
        </td>
        <td>
          <ReferenceCell iri={item.albumIri} />
        </td>
        <td className="pod-music-duration">{formatDuration(item.durationSeconds)}</td>
      </>
    );
  }
  if (kind === "albums") {
    return (
      <td>
        <ReferenceCell iri={item.artistIri} />
      </td>
    );
  }
  return null;
}

/**
 * Render a Solid music library as a navigable, section-tabbed list. Render-only:
 * each row links out to the resource's own URL (the "details" target) — there is
 * no in-app player.
 */
export function MusicLibrary({ base, fetch, initialKind, title }: MusicLibraryProps) {
  const { items, kind, loading, error, isAccessError, selectKind, refresh } = useMusicLibrary(
    base,
    {
      ...(fetch ? { fetch } : {}),
      ...(initialKind ? { initialKind } : {}),
    },
  );

  const columns = columnsFor(kind);

  return (
    <section className="pod-music-library" aria-label={title ?? "Pod Music library"}>
      {title ? <h2 className="pod-music-title">{title}</h2> : null}

      <nav className="pod-music-sections" aria-label="Library sections">
        <ul>
          {LIBRARY_KINDS.map((k) => (
            <li key={k}>
              <button
                type="button"
                className={k === kind ? "pod-music-section-active" : "pod-music-section"}
                aria-current={k === kind ? "true" : undefined}
                onClick={() => selectKind(k)}
              >
                {kindLabel(k)}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {loading ? (
        <p className="pod-music-loading" role="status">
          Loading…
        </p>
      ) : null}

      {error ? (
        <div className="pod-music-error" role="alert">
          <p>{error}</p>
          {!isAccessError ? (
            <button type="button" onClick={refresh}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <p className="pod-music-empty">This section is empty.</p>
      ) : null}

      {!error && items.length > 0 ? (
        <table className="pod-music-table">
          <thead>
            <tr>
              {columns.map((col, index) => (
                // Column headers are a fixed, ordered set per section; the index
                // is a stable key here (the labels can repeat as "" for the
                // action column).
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed ordered header set
                <th key={`${kind}-col-${index}`} scope="col">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.iri} className="pod-music-row">
                <td className="pod-music-item-title">{item.title}</td>
                <MetaCells kind={kind} item={item} />
                <td className="pod-music-open">
                  {/* `item.iri` is always a safe, same-origin, in-pod http(s)
                      child: `loadLibrary` validates every contained IRI via
                      `isSafeContainedIri` before it can become a row, so a
                      `javascript:`/`data:`/cross-origin resource IRI never
                      reaches here. The Open link is therefore unconditionally
                      safe. (Artist/album refs come from the resource's own RDF,
                      not the container listing, so `ReferenceCell` still gates
                      THOSE hrefs.) */}
                  <a href={item.iri} target="_blank" rel="noopener noreferrer">
                    Open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
