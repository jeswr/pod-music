// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Focused tests for the data hook's race + lifecycle handling that the
// component test can't deterministically force: a slow load superseded by a
// newer section switch must NOT overwrite the newer state, an aborted/late
// rejection must not surface an error, and a base-prop change must reset ALL
// state (incl. the loading flag) to the new pod.

import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMusicLibrary } from "../../src/ui/useMusicLibrary.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = "https://alice.example/music/";
const OTHER = "https://bob.example/music/";

function containerListing(container: string, child: string): string {
  return `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${container}> a ldp:Container ; ldp:contains <${child}> .
`;
}

function trackDoc(iri: string, name: string): string {
  return `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${iri}> a mo:Track, schema:MusicRecording ; schema:name "${name}" .
`;
}

/** Maps a URL to a 200 Turtle body; anything else 404s. */
function routerFetch(map: Record<string, string>): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = map[url];
    if (body === undefined) {
      return new Response(null, { status: 404 });
    }
    return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
  }) as unknown as typeof globalThis.fetch;
}

/** A router for the per-base tracks library: container + a single named track. */
function libraryFetch(base: string, trackName: string): typeof globalThis.fetch {
  const container = `${base}tracks/`;
  const track = `${container}t1`;
  return routerFetch({
    [container]: containerListing(container, track),
    [track]: trackDoc(track, trackName),
  });
}

function statusFetch(status: number): typeof globalThis.fetch {
  return (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
}

describe("useMusicLibrary", () => {
  it("loads the tracks section on mount", async () => {
    const fetch = libraryFetch(BASE, "Reverie");
    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.kind).toBe("tracks");
    expect(result.current.error).toBeNull();
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.title).toBe("Reverie");
  });

  it("honours an initialKind option", async () => {
    const albumsContainer = `${BASE}albums/`;
    const a1 = `${albumsContainer}a1`;
    const fetch = routerFetch({
      [albumsContainer]: containerListing(albumsContainer, a1),
      [a1]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${a1}> a mo:Record, schema:MusicAlbum ; schema:name "Suite" .
`,
    });
    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch, initialKind: "albums" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.kind).toBe("albums");
    expect(result.current.items[0]?.title).toBe("Suite");
  });

  it("switches section and re-loads", async () => {
    const tracksContainer = `${BASE}tracks/`;
    const t1 = `${tracksContainer}t1`;
    const playlistsContainer = `${BASE}playlists/`;
    const p1 = `${playlistsContainer}p1`;
    const fetch = routerFetch({
      [tracksContainer]: containerListing(tracksContainer, t1),
      [t1]: trackDoc(t1, "Reverie"),
      [playlistsContainer]: containerListing(playlistsContainer, p1),
      [p1]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${p1}> a mo:Playlist, schema:MusicPlaylist ; schema:name "Faves" .
`,
    });
    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch }));
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Reverie"));

    act(() => result.current.selectKind("playlists"));
    await waitFor(() => expect(result.current.kind).toBe("playlists"));
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Faves"));
  });

  it("does not let a slow superseded load overwrite a newer section switch", async () => {
    // The first (tracks) container read hangs; switching to playlists resolves
    // immediately. When tracks finally resolves it must be discarded as stale.
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const tracksContainer = `${BASE}tracks/`;
    const playlistsContainer = `${BASE}playlists/`;
    const p1 = `${playlistsContainer}p1`;
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === tracksContainer) {
        await slow;
        return new Response(containerListing(tracksContainer, `${tracksContainer}t1`), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (url === `${tracksContainer}t1`) {
        // Resolves AFTER the container so the whole slow tracks load completes
        // and its `.then` runs with a now-stale requestId (the staleness guard).
        return new Response(trackDoc(`${tracksContainer}t1`, "Stale Reverie"), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (url === playlistsContainer) {
        return new Response(containerListing(playlistsContainer, p1), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (url === p1) {
        return new Response(
          `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${p1}> a mo:Playlist, schema:MusicPlaylist ; schema:name "Faves" .
`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch }));
    act(() => result.current.selectKind("playlists"));
    await waitFor(() => expect(result.current.kind).toBe("playlists"));
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Faves"));

    await act(async () => {
      releaseSlow();
      await slow;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The stale tracks load did NOT replace the playlists items.
    expect(result.current.kind).toBe("playlists");
    expect(result.current.items[0]?.title).toBe("Faves");
  });

  it("discards a superseded load that RESOLVES after a newer switch (then stale-guard)", async () => {
    // Two gated loads: the FIRST (tracks) container read resolves only when we
    // release it; the SECOND (albums) resolves immediately. We release the first
    // AFTER the second has committed, so the first load (which is NOT cancelled —
    // the store has no abort) runs to completion and its `.then` fires with a
    // now-stale requestId, and must be discarded WITHOUT overwriting albums —
    // exercising the success-path staleness guard specifically.
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const tracksContainer = `${BASE}tracks/`;
    const t1 = `${tracksContainer}t1`;
    const albumsContainer = `${BASE}albums/`;
    const a1 = `${albumsContainer}a1`;
    let containerHits = 0;
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === tracksContainer) {
        containerHits += 1;
        // Only the FIRST tracks container read is gated; ignore the abort signal.
        await firstGate;
        return new Response(containerListing(tracksContainer, t1), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (url === t1) {
        return new Response(trackDoc(t1, "Stale"), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (url === albumsContainer) {
        return new Response(containerListing(albumsContainer, a1), {
          status: 200,
          headers: { "content-type": "text/turtle" },
        });
      }
      if (url === a1) {
        return new Response(
          `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${a1}> a mo:Record, schema:MusicAlbum ; schema:name "Album One" .
`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch }));
    // The tracks load is gated (in flight). Switch to albums, which resolves.
    act(() => result.current.selectKind("albums"));
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Album One"));
    expect(containerHits).toBe(1);

    // Now release the stale tracks load; its `.then` must NOT overwrite albums.
    await act(async () => {
      releaseFirst();
      await firstGate;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.kind).toBe("albums");
    expect(result.current.items[0]?.title).toBe("Album One");
  });

  it("discards a superseded load that REJECTS after a newer switch", async () => {
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const tracksContainer = `${BASE}tracks/`;
    const playlistsContainer = `${BASE}playlists/`;
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === tracksContainer) {
        await slow;
        throw new TypeError("tracks load failed late");
      }
      if (url === playlistsContainer) {
        return new Response(
          `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${playlistsContainer}> a ldp:Container .
`,
          { status: 200, headers: { "content-type": "text/turtle" } },
        );
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch }));
    act(() => result.current.selectKind("playlists"));
    await waitFor(() => expect(result.current.kind).toBe("playlists"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      releaseSlow();
      await slow.catch(() => {});
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // The late rejection of the stale tracks load did NOT set an error.
    expect(result.current.error).toBeNull();
    expect(result.current.kind).toBe("playlists");
  });

  it("surfaces a login-flavoured access error (401) with the access flag set", async () => {
    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch: statusFetch(401) }));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.isAccessError).toBe(true);
    expect(result.current.error).toContain("log in");
  });

  it("surfaces a permission access error (403)", async () => {
    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch: statusFetch(403) }));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.isAccessError).toBe(true);
    expect(result.current.error).toContain("permission");
  });

  it("surfaces a generic error for a non-access failure and recovers via refresh", async () => {
    let present = false;
    const tracksContainer = `${BASE}tracks/`;
    const t1 = `${tracksContainer}t1`;
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!present) {
        return new Response(null, { status: 404 });
      }
      const body =
        url === tracksContainer ? containerListing(tracksContainer, t1) : trackDoc(t1, "Reverie");
      return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useMusicLibrary(BASE, { fetch }));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.isAccessError).toBe(false);

    present = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBeNull());
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Reverie"));
  });

  it("falls back to the global fetch when no fetch option is given", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(libraryFetch(BASE, "Global") as typeof fetch);
    const { result } = renderHook(() => useMusicLibrary(BASE));
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Global"));
  });

  it("resets ALL state to the new pod when the base prop changes", async () => {
    const { result, rerender } = renderHook(
      ({ base }: { base: string }) => useMusicLibrary(base, { fetch: makeMultiBaseFetch() }),
      { initialProps: { base: BASE } },
    );
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Alice track"));

    // Switch to playlists in the first pod, then change base.
    act(() => result.current.selectKind("playlists"));
    await waitFor(() => expect(result.current.kind).toBe("playlists"));

    rerender({ base: OTHER });
    // The reset returns to the initial section (tracks) for the NEW pod.
    await waitFor(() => expect(result.current.kind).toBe("tracks"));
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Bob track"));
    expect(result.current.error).toBeNull();
  });

  it("resets cleanly under StrictMode's double render across two base changes", async () => {
    const { result, rerender } = renderHook(
      ({ base }: { base: string }) => useMusicLibrary(base, { fetch: makeMultiBaseFetch() }),
      { initialProps: { base: BASE }, wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Alice track"));

    rerender({ base: OTHER });
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Bob track"));

    rerender({ base: BASE });
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Alice track"));
    expect(result.current.error).toBeNull();
  });

  it("does NOT reset when the base prop is unchanged (incl. a slashless spelling) across a re-render", async () => {
    const fetch = libraryFetch(BASE, "Reverie");
    const { result, rerender } = renderHook(
      ({ base }: { base: string }) => useMusicLibrary(base, { fetch }),
      { initialProps: { base: BASE } },
    );
    await waitFor(() => expect(result.current.items[0]?.title).toBe("Reverie"));

    act(() => result.current.selectKind("albums"));
    await waitFor(() => expect(result.current.kind).toBe("albums"));

    // Re-render with an unchanged base (and a slashless spelling that normalises
    // identically) — neither is treated as a change, so the section is kept.
    rerender({ base: BASE });
    rerender({ base: "https://alice.example/music" });
    expect(result.current.kind).toBe("albums");
  });
});

/** A fetch routing both pods' tracks containers (for the base-change tests). */
function makeMultiBaseFetch(): typeof globalThis.fetch {
  const aliceContainer = `${BASE}tracks/`;
  const aliceTrack = `${aliceContainer}t1`;
  const alicePlaylists = `${BASE}playlists/`;
  const bobContainer = `${OTHER}tracks/`;
  const bobTrack = `${bobContainer}t1`;
  return routerFetch({
    [aliceContainer]: containerListing(aliceContainer, aliceTrack),
    [aliceTrack]: trackDoc(aliceTrack, "Alice track"),
    [alicePlaylists]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${alicePlaylists}> a ldp:Container .
`,
    [bobContainer]: containerListing(bobContainer, bobTrack),
    [bobTrack]: trackDoc(bobTrack, "Bob track"),
  });
}
