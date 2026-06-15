// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Tests for the library view's data-facing logic, driven by a REAL MusicStore
// over a stubbed authenticated fetch (the auth seam). This exercises the genuine
// LDP-container listing + typed-wrapper reads the data layer performs — there is
// no mock of the store itself, so the test proves loadLibrary shapes a real pod
// response into rows.

import { describe, expect, it } from "vitest";
import { MusicStore } from "../../src/lib/store.js";
import {
  containerForKind,
  ensureTrailingSlash,
  iriTail,
  isAccessDenied,
  kindLabel,
  LIBRARY_KINDS,
  loadLibrary,
} from "../../src/ui/library.js";

const BASE = "https://alice.example/music/";

/** A fake authenticated fetch routing by URL to a canned Turtle body (200) or a status. */
function routerFetch(map: Record<string, string>, missingStatus = 404): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = map[url];
    if (body === undefined) {
      return new Response(null, { status: missingStatus });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/turtle", etag: '"v1"' },
    });
  }) as unknown as typeof globalThis.fetch;
}

/** A fetch that returns a fixed status for every request (for the 401/403 container paths). */
function statusFetch(status: number): typeof globalThis.fetch {
  return (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
}

const TRACKS_CONTAINER = `${BASE}tracks/`;
const T1 = `${TRACKS_CONTAINER}reverie`;
const T2 = `${TRACKS_CONTAINER}arabesque`;
const ARTIST = `${BASE}artists/debussy`;
const ALBUM = `${BASE}albums/suite-bergamasque`;

const TRACKS_LISTING = `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${TRACKS_CONTAINER}> a ldp:Container ; ldp:contains <${T1}>, <${T2}> .
`;

const TRACK_1 = `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${T1}> a mo:Track, schema:MusicRecording ;
  schema:name "Reverie" ;
  schema:byArtist <${ARTIST}> ;
  schema:inAlbum <${ALBUM}> ;
  schema:duration 270 .
`;

// A track WITHOUT schema:name (the Required-getter-throws hazard) — the label
// must fall back to the IRI tail via the store's safe resolver, not throw.
const TRACK_2_NO_NAME = `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${T2}> a mo:Track, schema:MusicRecording ; schema:duration 100 .
`;

describe("loadLibrary — tracks", () => {
  it("lists the tracks container and reads each track into a sorted row", async () => {
    const fetch = routerFetch({
      [TRACKS_CONTAINER]: TRACKS_LISTING,
      [T1]: TRACK_1,
      [T2]: TRACK_2_NO_NAME,
    });
    const store = new MusicStore({ base: BASE, fetch });
    const items = await loadLibrary(store, "tracks");

    expect(items).toHaveLength(2);
    // Sorted by title (case-insensitive): "arabesque" (IRI-tail fallback) < "Reverie".
    expect(items[0]?.title).toBe("arabesque");
    expect(items[0]?.iri).toBe(T2);
    expect(items[0]?.durationSeconds).toBe(100);
    expect(items[0]?.artistIri).toBeUndefined();
    expect(items[0]?.albumIri).toBeUndefined();

    expect(items[1]?.title).toBe("Reverie");
    expect(items[1]?.artistIri).toBe(ARTIST);
    expect(items[1]?.albumIri).toBe(ALBUM);
    expect(items[1]?.durationSeconds).toBe(270);
  });

  it("returns an empty array for an empty container", async () => {
    const fetch = routerFetch({
      [TRACKS_CONTAINER]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${TRACKS_CONTAINER}> a ldp:Container .
`,
    });
    const store = new MusicStore({ base: BASE, fetch });
    expect(await loadLibrary(store, "tracks")).toEqual([]);
  });

  it("propagates a typed AccessDeniedError when the container read is 403", async () => {
    const store = new MusicStore({ base: BASE, fetch: statusFetch(403) });
    await expect(loadLibrary(store, "tracks")).rejects.toSatisfy(isAccessDenied);
  });
});

describe("loadLibrary — albums", () => {
  it("reads album rows with the artist reference", async () => {
    const albumsContainer = `${BASE}albums/`;
    const a1 = `${albumsContainer}suite`;
    const fetch = routerFetch({
      [albumsContainer]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${albumsContainer}> a ldp:Container ; ldp:contains <${a1}> .
`,
      [a1]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${a1}> a mo:Record, schema:MusicAlbum ; schema:name "Suite" ; schema:byArtist <${ARTIST}> .
`,
    });
    const store = new MusicStore({ base: BASE, fetch });
    const items = await loadLibrary(store, "albums");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Suite");
    expect(items[0]?.artistIri).toBe(ARTIST);
    expect(items[0]?.durationSeconds).toBeUndefined();
  });
});

describe("loadLibrary — playlists", () => {
  it("reads playlist rows (title only)", async () => {
    const playlistsContainer = `${BASE}playlists/`;
    const p1 = `${playlistsContainer}favourites`;
    const fetch = routerFetch({
      [playlistsContainer]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${playlistsContainer}> a ldp:Container ; ldp:contains <${p1}> .
`,
      [p1]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${p1}> a mo:Playlist, schema:MusicPlaylist ; schema:name "Favourites" .
`,
    });
    const store = new MusicStore({ base: BASE, fetch });
    const items = await loadLibrary(store, "playlists");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Favourites");
    expect(items[0]?.artistIri).toBeUndefined();
  });
});

describe("loadLibrary — child read failures", () => {
  it("rejects (does not silently drop a row) when a child resource is unreadable", async () => {
    // The container lists two tracks but one child 404s — the whole load rejects
    // so the failure surfaces through the hook's error state rather than quietly
    // returning a short list.
    const fetch = routerFetch({
      [TRACKS_CONTAINER]: TRACKS_LISTING,
      [T1]: TRACK_1,
      // T2 is intentionally absent → 404 → ResourceNotFoundError.
    });
    const store = new MusicStore({ base: BASE, fetch });
    await expect(loadLibrary(store, "tracks")).rejects.toThrow();
  });

  it("rejects with a typed AccessDeniedError when a child read is 403", async () => {
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === TRACKS_CONTAINER) {
        return new Response(TRACKS_LISTING, {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      // Every child read is forbidden.
      return new Response(null, { status: 403 });
    }) as unknown as typeof globalThis.fetch;
    const store = new MusicStore({ base: BASE, fetch });
    await expect(loadLibrary(store, "tracks")).rejects.toSatisfy(isAccessDenied);
  });
});

describe("library helpers", () => {
  it("ensureTrailingSlash adds exactly one slash and is idempotent", () => {
    expect(ensureTrailingSlash("https://pod.example/music")).toBe("https://pod.example/music/");
    expect(ensureTrailingSlash("https://pod.example/music/")).toBe("https://pod.example/music/");
  });

  it("kindLabel maps every kind to a human label", () => {
    expect(LIBRARY_KINDS.map(kindLabel)).toEqual(["Tracks", "Albums", "Playlists"]);
  });

  it("containerForKind returns the store's derived per-class container", () => {
    const store = new MusicStore({ base: BASE, fetch: statusFetch(404) });
    expect(containerForKind(store.layout, "tracks")).toBe(`${BASE}tracks/`);
    expect(containerForKind(store.layout, "albums")).toBe(`${BASE}albums/`);
    expect(containerForKind(store.layout, "playlists")).toBe(`${BASE}playlists/`);
  });

  it("isAccessDenied is false for a non-access error", () => {
    expect(isAccessDenied(new Error("network"))).toBe(false);
  });
});

describe("iriTail", () => {
  it("returns the decoded last path segment", () => {
    expect(iriTail("https://pod.example/artists/debussy")).toBe("debussy");
  });

  it("decodes a percent-encoded segment", () => {
    expect(iriTail("https://pod.example/artists/Claude%20Debussy")).toBe("Claude Debussy");
  });

  it("trims a trailing slash before taking the last segment", () => {
    expect(iriTail("https://pod.example/artists/ravel/")).toBe("ravel");
  });

  it("falls back to the whole IRI when there is no path segment", () => {
    // A trailing-slash-only authority trims to "https://x" → empty last segment,
    // so the `|| iri` fallback returns the original IRI verbatim.
    expect(iriTail("https://host//")).toBe("https://host//");
  });

  it("keeps a malformed percent-encoding verbatim rather than throwing", () => {
    expect(iriTail("https://pod.example/artists/%E0%A4%A")).toBe("%E0%A4%A");
  });
});
