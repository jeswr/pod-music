// @vitest-environment jsdom
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// The music-library VIEW + its data hook, driven by a stubbed authenticated
// fetch (the auth seam). Proves the view renders a real pod listing (parsed by
// the data layer), switches sections, renders artist/album/duration, gates
// unsafe hrefs to plain text, and renders the empty / loading / error /
// access-denied states — all with NO real pod and NO login flow.

import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicLibrary } from "../../src/ui/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = "https://pod.example/music/";
const TRACKS = `${BASE}tracks/`;
const T_REVERIE = `${TRACKS}reverie`;
const T_UNSAFE = `${TRACKS}weird`;
const ARTIST = `${BASE}artists/debussy`;
const ALBUM = `${BASE}albums/suite`;
const T_BADENC = `${TRACKS}badenc`;
// A safe-scheme artist IRI whose last segment is malformed percent-encoding —
// the link still renders (https is safe) but the label decode throws and falls
// back to the raw segment.
const ARTIST_BADENC = `${BASE}artists/%E0%A4%A`;
const ALBUMS = `${BASE}albums/`;
const A_SUITE = `${ALBUMS}suite`;
const PLAYLISTS = `${BASE}playlists/`;
const P_FAVES = `${PLAYLISTS}faves`;

const MAP: Record<string, string> = {
  [TRACKS]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${TRACKS}> a ldp:Container ; ldp:contains <${T_REVERIE}>, <${T_UNSAFE}>, <${T_BADENC}> .
`,
  [T_BADENC]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${T_BADENC}> a mo:Track, schema:MusicRecording ;
  schema:name "ZZZ Badenc" ; schema:byArtist <${ARTIST_BADENC}> .
`,
  [T_REVERIE]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${T_REVERIE}> a mo:Track, schema:MusicRecording ;
  schema:name "Reverie" ; schema:byArtist <${ARTIST}> ; schema:inAlbum <${ALBUM}> ;
  schema:duration 270 .
`,
  // A track whose artist IRI is a hostile javascript: scheme — the ReferenceCell
  // must render it as plain text, never a link; and it has no album/duration, so
  // those cells render the em-dash.
  [T_UNSAFE]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${T_UNSAFE}> a mo:Track, schema:MusicRecording ;
  schema:name "AAA Unsafe" ; schema:byArtist <javascript:alert(1)> .
`,
  [ALBUMS]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${ALBUMS}> a ldp:Container ; ldp:contains <${A_SUITE}> .
`,
  [A_SUITE]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${A_SUITE}> a mo:Record, schema:MusicAlbum ; schema:name "Suite" ; schema:byArtist <${ARTIST}> .
`,
  [PLAYLISTS]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${PLAYLISTS}> a ldp:Container ; ldp:contains <${P_FAVES}> .
`,
  [P_FAVES]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${P_FAVES}> a mo:Playlist, schema:MusicPlaylist ; schema:name "Faves" .
`,
};

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

function statusFetch(status: number): typeof globalThis.fetch {
  return (async () => new Response(null, { status })) as unknown as typeof globalThis.fetch;
}

describe("MusicLibrary", () => {
  it("renders the tracks section with title / artist / album / duration and a safe Open link", async () => {
    render(<MusicLibrary base={BASE} fetch={routerFetch(MAP)} title="My Music" />);

    expect(screen.getByRole("heading", { name: "My Music" })).toBeInTheDocument();

    const reverieCell = await screen.findByText("Reverie");
    const row = reverieCell.closest("tr");
    expect(row).not.toBeNull();
    // Artist + album render as safe links to their IRIs; duration as m:ss.
    expect(row).toHaveTextContent("debussy");
    expect(row).toHaveTextContent("suite");
    expect(row).toHaveTextContent("4:30");
    // The Open link inside Reverie's row points at its own resource IRI.
    const openLinks = row?.querySelectorAll("a") ?? [];
    const open = [...openLinks].find((a) => a.textContent === "Open");
    expect(open).toBeDefined();
    expect(open).toHaveAttribute("href", T_REVERIE);
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders an unsafe artist IRI as plain text (no link) and em-dashes for absent fields", async () => {
    render(<MusicLibrary base={BASE} fetch={routerFetch(MAP)} />);
    // The unsafe track sorts first ("AAA Unsafe").
    const cell = await screen.findByText("AAA Unsafe");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    // The javascript: artist became plain escaped text, not an anchor.
    expect(screen.queryByRole("link", { name: "alert(1)" })).not.toBeInTheDocument();
    if (row) {
      // No link to the javascript: scheme anywhere in the row.
      const anchors = row.querySelectorAll("a");
      for (const a of anchors) {
        expect(a.getAttribute("href")).not.toContain("javascript:");
      }
    }
  });

  it("renders a malformed-percent-encoding artist IRI as a safe link with the raw segment label", async () => {
    render(<MusicLibrary base={BASE} fetch={routerFetch(MAP)} />);
    // "ZZZ Badenc" sorts last.
    const cell = await screen.findByText("ZZZ Badenc");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    // The decode of "%E0%A4%A" throws → the label falls back to the raw segment.
    const link = [...(row?.querySelectorAll("a") ?? [])].find(
      (a) => a.getAttribute("href") === ARTIST_BADENC,
    );
    expect(link).toBeDefined();
    expect(link?.textContent).toBe("%E0%A4%A");
  });

  it("switches to the albums section via its tab", async () => {
    render(<MusicLibrary base={BASE} fetch={routerFetch(MAP)} />);
    await screen.findByText("Reverie");

    const albumsTab = screen.getByRole("button", { name: "Albums" });
    await act(async () => {
      albumsTab.click();
    });
    expect(await screen.findByText("Suite")).toBeInTheDocument();
    expect(screen.queryByText("Reverie")).not.toBeInTheDocument();
  });

  it("switches to the playlists section (title-only rows)", async () => {
    render(<MusicLibrary base={BASE} fetch={routerFetch(MAP)} initialKind="playlists" />);
    expect(await screen.findByText("Faves")).toBeInTheDocument();
    // Playlists have only Title + the action column — no Artist/Album/Duration headers.
    expect(screen.queryByRole("columnheader", { name: "Duration" })).not.toBeInTheDocument();
  });

  it("shows the empty state for a section with no children", async () => {
    const fetch = routerFetch({
      [TRACKS]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${TRACKS}> a ldp:Container .
`,
    });
    render(<MusicLibrary base={BASE} fetch={fetch} />);
    expect(await screen.findByText("This section is empty.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders a login-flavoured access error (401) with NO retry button", async () => {
    render(<MusicLibrary base={BASE} fetch={statusFetch(401)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("log in");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("renders a permission access error (403) with NO retry button", async () => {
    render(<MusicLibrary base={BASE} fetch={statusFetch(403)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("permission");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("renders a generic error (404) WITH a working retry that re-fetches", async () => {
    let present = false;
    const fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!present) {
        return new Response(null, { status: 404 });
      }
      const body = MAP[url];
      if (body === undefined) {
        return new Response(null, { status: 404 });
      }
      return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
    }) as unknown as typeof globalThis.fetch;

    render(<MusicLibrary base={BASE} fetch={fetch} />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    present = true;
    await act(async () => {
      retry.click();
    });
    expect(await screen.findByText("Reverie")).toBeInTheDocument();
  });

  it("shows a loading status while the first request is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = (async (input: string | URL | Request) => {
      await gate;
      const url = typeof input === "string" ? input : input.toString();
      const body =
        MAP[url] ??
        `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${url}> a ldp:Container .
`;
      return new Response(body, { status: 200, headers: { "content-type": "text/turtle" } });
    }) as unknown as typeof globalThis.fetch;

    render(<MusicLibrary base={BASE} fetch={fetch} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");

    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(await screen.findByText("Reverie")).toBeInTheDocument();
  });

  it("falls back to the global fetch when no fetch prop is given", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(routerFetch(MAP) as typeof fetch);
    render(<MusicLibrary base={BASE} />);
    expect(await screen.findByText("Reverie")).toBeInTheDocument();
  });

  it("renders without a title heading when none is given", async () => {
    render(<MusicLibrary base={BASE} fetch={routerFetch(MAP)} />);
    await screen.findByText("Reverie");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("disables Open for a hostile non-http(s) resource IRI, and labels a slash-suffixed artist by its last segment", async () => {
    // Defensive against hostile pod data: a container that lists a child under a
    // non-http(s) scheme (here a `urn:`) must NOT become a clickable Open link —
    // it renders the disabled em-dash. The artist IRI ends in a slash, which the
    // label helper trims before taking the last segment.
    const urnTrack = "urn:track:hostile";
    const slashArtist = `${BASE}artists/ravel/`;
    const fetch = routerFetch({
      [TRACKS]: `
@prefix ldp: <http://www.w3.org/ns/ldp#> .
<${TRACKS}> a ldp:Container ; ldp:contains <${urnTrack}> .
`,
      [urnTrack]: `
@prefix mo: <http://purl.org/ontology/mo/> .
@prefix schema: <http://schema.org/> .
<${urnTrack}> a mo:Track, schema:MusicRecording ;
  schema:name "Hostile" ; schema:byArtist <${slashArtist}> .
`,
    });
    render(<MusicLibrary base={BASE} fetch={fetch} />);
    const cell = await screen.findByText("Hostile");
    const row = cell.closest("tr");
    expect(row).not.toBeNull();
    // No Open link (the urn: scheme is not safe); the disabled em-dash is shown.
    expect([...(row?.querySelectorAll("a") ?? [])].some((a) => a.textContent === "Open")).toBe(
      false,
    );
    // The slash-suffixed artist IRI is labelled by its trimmed last segment.
    const artistLink = [...(row?.querySelectorAll("a") ?? [])].find(
      (a) => a.getAttribute("href") === slashArtist,
    );
    expect(artistLink?.textContent).toBe("ravel");
  });
});
