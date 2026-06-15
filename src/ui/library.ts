// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// The library view's data-facing logic, kept React-free so it is unit-testable
// in isolation. It drives the EXISTING data layer (MusicStore) — listing a
// per-class container, then reading each child resource through the typed
// wrappers — and shapes the result into the flat `LibraryItem` rows the view
// renders. It NEVER touches RDF directly: the only RDF reading is via the store
// (getTrack / getAlbum / getPlaylist) and the store's safe `labelFromDataset`
// label resolver, so the house "never hand-build/parse triples" rule holds.

import type { Store } from "n3";
import { AccessDeniedError } from "../lib/errors.js";
import type { Album, Playlist, Track } from "../lib/model.js";
import type { MusicLayout } from "../lib/store.js";
import { MusicStore } from "../lib/store.js";

/**
 * The store builds every wrapper from an `n3.Store`, but @rdfjs/wrapper types
 * `.dataset` as the wider `DatasetCore` (whose `match()` is not iterable). The
 * concrete value here is always the `n3.Store` the store parsed, so we narrow it
 * for `labelFromDataset` (which iterates a `match()` result). This mirrors the
 * single documented RDF/JS boundary narrowing the data layer's own `read()`
 * uses — it is a typing-gap narrowing, not a bespoke RDF path.
 */
function safeLabel(wrapper: Track | Album | Playlist, iri: string): string {
  return MusicStore.labelFromDataset(wrapper.dataset as unknown as Store, iri);
}

/** The library sections the view can browse — one per primary music container. */
export type LibraryKind = "tracks" | "albums" | "playlists";

/** The ordered set of sections the view offers (the tab order). */
export const LIBRARY_KINDS: readonly LibraryKind[] = ["tracks", "albums", "playlists"];

/** A human label for a section tab. */
export function kindLabel(kind: LibraryKind): string {
  switch (kind) {
    case "tracks":
      return "Tracks";
    case "albums":
      return "Albums";
    case "playlists":
      return "Playlists";
  }
}

/**
 * Ensure a single trailing slash. LDP containers are slash-terminated, so a
 * container URL is normalised here before it reaches the data layer — a `.ttl`
 * resource IRI is NOT a container and must NOT be slashed, so this is only ever
 * applied to values already known to be containers (the per-class layout).
 */
export function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * A short, decoded display label for an IRI: its last path segment (a trailing
 * slash is trimmed first), percent-decoded. Falls back to the whole IRI when
 * there is no segment, and keeps a malformed percent-encoding verbatim rather
 * than throwing. Pure string logic, kept here so it is unit-testable in
 * isolation and reusable by any view that renders an artist/album reference.
 */
export function iriTail(iri: string): string {
  const trimmed = iri.endsWith("/") ? iri.slice(0, -1) : iri;
  const tail = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const candidate = tail.length > 0 ? tail : iri;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

/**
 * One row in the library list. `iri` is the resource URL (the stable React key
 * + the details target); the rest are display fields, all OPTIONAL because pod
 * data may omit them — the view renders an em-dash for an absent field rather
 * than failing. `title` always has a value (the store's label fallback chain
 * resolves schema:name → dcterms:title → rdfs:label → the IRI tail).
 */
export interface LibraryItem {
  iri: string;
  title: string;
  artistIri?: string;
  albumIri?: string;
  durationSeconds?: number;
}

/** The container IRI for a section, taken from the store's derived layout. */
export function containerForKind(layout: MusicLayout, kind: LibraryKind): string {
  return layout[kind];
}

/**
 * Is `iri` a SAFE in-pod child of `containerIri` that we are willing to fetch?
 *
 * A container listing is untrusted input: a malicious or malformed container can
 * emit `ldp:contains` objects pointing anywhere — a `javascript:`/`data:`/`file:`
 * URI, a cross-origin host, or a path outside the container root. Fetching those
 * blindly is an SSRF-ish vector (and runs BEFORE any href safety gate, so it is
 * the only guard for a server-side consumer of {@link loadLibrary}). We therefore
 * fetch a contained IRI ONLY when ALL of the following hold:
 *
 *  - it parses as an absolute URL with an `http:` or `https:` scheme (never
 *    `javascript:`/`data:`/`file:`/`blob:`/relative);
 *  - it is SAME-ORIGIN with the container (scheme + host + port all match);
 *  - it is strictly UNDER the container path — its href starts with the
 *    (slash-terminated) container href and has a non-empty remainder, i.e. it is
 *    a real descendant, not the container itself nor a sibling/parent.
 *
 * Anything else is dropped from the listing rather than fetched. The origin check
 * is done on parsed `URL.origin` (not raw string prefixing) so it cannot be
 * fooled by a userinfo/`@` or a look-alike-prefix host.
 */
export function isSafeContainedIri(containerIri: string, iri: string): boolean {
  let container: URL;
  let child: URL;
  try {
    container = new URL(containerIri);
    child = new URL(iri);
  } catch {
    return false;
  }
  if (child.protocol !== "http:" && child.protocol !== "https:") {
    return false;
  }
  if (child.origin !== container.origin) {
    return false;
  }
  // Path-prefix under the (slash-terminated) container root, with a real child
  // segment after it. Compare hrefs so origin (already equal) + path are checked
  // together; require a strict, non-empty remainder so the container itself,
  // a parent, or a sibling cannot pass.
  const root = container.href.endsWith("/") ? container.href : `${container.href}/`;
  return child.href.length > root.length && child.href.startsWith(root);
}

/**
 * Read one resource into a display row. The title is read via the store's safe
 * label resolver (schema:name → dcterms:title → rdfs:label → IRI tail) rather
 * than the wrapper's `Required` `title` getter — that getter THROWS when a
 * resource omits schema:name, so a title-less track would otherwise blow up the
 * whole listing. The optional fields are read via the wrappers' optional getters
 * (which return `undefined`, never throw). A genuine read failure (a child that
 * 401/403/404s, or returns unparseable RDF) is NOT swallowed here — it rejects
 * and surfaces through the hook's error state; only the missing-name case is
 * handled gracefully, by `safeLabel`.
 *
 * The kind selects which typed wrapper to read; tracks expose artist/album/
 * duration, albums expose artist, playlists expose only a title.
 */
async function readItem(store: MusicStore, kind: LibraryKind, iri: string): Promise<LibraryItem> {
  if (kind === "tracks") {
    const { track } = await store.getTrack(iri);
    const item: LibraryItem = {
      iri,
      title: safeLabel(track, iri),
    };
    if (track.artist !== undefined) {
      item.artistIri = track.artist;
    }
    if (track.album !== undefined) {
      item.albumIri = track.album;
    }
    if (track.durationSeconds !== undefined) {
      item.durationSeconds = track.durationSeconds;
    }
    return item;
  }
  if (kind === "albums") {
    const { album } = await store.getAlbum(iri);
    const item: LibraryItem = {
      iri,
      title: safeLabel(album, iri),
    };
    if (album.artist !== undefined) {
      item.artistIri = album.artist;
    }
    return item;
  }
  const { playlist } = await store.getPlaylist(iri);
  return { iri, title: safeLabel(playlist, iri) };
}

/**
 * List a section's container and read each child into a `LibraryItem`, sorted by
 * title (locale-independent, case-insensitive) for a stable render order. A
 * 401/403 on the CONTAINER read propagates as the typed `AccessDeniedError` (the
 * view distinguishes it from an empty section); any child read failure likewise
 * rejects and is surfaced by the hook (see {@link readItem}) rather than
 * silently dropping a row.
 *
 * The container listing is UNTRUSTED: each `ldp:contains` IRI is validated by
 * {@link isSafeContainedIri} before it is fetched, so a malicious/malformed
 * container cannot drive a request to a `javascript:`/`data:`/`file:`,
 * cross-origin, or out-of-pod URL (an SSRF-ish vector — this guard runs BEFORE
 * any href safety gate and is the only guard for a server-side consumer). An
 * unsafe contained IRI is DROPPED from the listing, not fetched and not failed:
 * it never reaches {@link readItem}, mirroring the per-item resilience that keeps
 * one bad child from sinking the whole listing. A legitimate child that 401/403s
 * still rejects as before.
 *
 * Reads run concurrently. There is no cancellation here: the data layer
 * (`MusicStore`) exposes no per-read abort signal, so an in-flight load always
 * runs to completion. STALENESS is handled entirely by the caller — the hook's
 * monotonic request-id guard discards the result of any load a newer one has
 * superseded (see {@link useMusicLibrary}). That keeps this function a simple,
 * side-effect-free list-and-shape with no lifecycle coupling.
 */
export async function loadLibrary(store: MusicStore, kind: LibraryKind): Promise<LibraryItem[]> {
  const container = containerForKind(store.layout, kind);
  const iris = await store.listContainer(container);
  const safe = iris.filter((iri) => isSafeContainedIri(container, iri));
  const items = await Promise.all(safe.map((iri) => readItem(store, kind, iri)));
  return items.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

/** Type guard re-export so the hook can branch on access errors without importing the class. */
export function isAccessDenied(err: unknown): err is AccessDeniedError {
  return err instanceof AccessDeniedError;
}
