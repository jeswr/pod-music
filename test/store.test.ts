// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { describe, expect, it, vi } from "vitest";
import { AccessDeniedError, InvalidModelError, ResourceNotFoundError } from "../src/lib/errors.js";
import { emptyDataset, factory } from "../src/lib/rdf.js";
import { MusicStore } from "../src/lib/store.js";
import { LDP_CONTAINS, MO_TRACK, SCHEMA_NAME, SOLID_PUBLIC_TYPE_INDEX } from "../src/vocab/iris.js";

const BASE = "https://alice.example/music/";
const WEBID = "https://alice.example/profile/card#me";

/** Build a Response for a Turtle body with a given status + ETag. */
function turtleResponse(body: string, init: { status?: number; etag?: string } = {}): Response {
  const headers = new Headers({ "content-type": "text/turtle" });
  if (init.etag) {
    headers.set("etag", init.etag);
  }
  return new Response(body, { status: init.status ?? 200, headers });
}

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
  headers: Headers;
}

/** A fetch stub backed by a route table (URL+method → Response or thrown). */
function stubFetch(routes: Record<string, () => Response>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body as string | undefined,
      headers: new Headers(init?.headers),
    });
    const key = `${method} ${url}`;
    const route = routes[key];
    if (!route) {
      return new Response("not routed", { status: 404 });
    }
    return route();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe("MusicStore construction", () => {
  it("derives the per-class container layout from the base", () => {
    const store = new MusicStore({ base: BASE, fetch: stubFetch({}).fetch });
    expect(store.layout.tracks).toBe(`${BASE}tracks/`);
    expect(store.layout.albums).toBe(`${BASE}albums/`);
    expect(store.layout.artists).toBe(`${BASE}artists/`);
    expect(store.layout.playlists).toBe(`${BASE}playlists/`);
    expect(store.layout.listens).toBe(`${BASE}listens/`);
  });

  it("rejects a base without a trailing slash", () => {
    expect(() => new MusicStore({ base: "https://alice.example/music" })).toThrow(
      InvalidModelError,
    );
  });

  it("defaults to globalThis.fetch when none is supplied", () => {
    const original = globalThis.fetch;
    const sentinel = vi.fn();
    globalThis.fetch = sentinel as unknown as typeof fetch;
    try {
      const store = new MusicStore({ base: BASE });
      expect(store.layout.tracks).toBe(`${BASE}tracks/`);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("MusicStore read/write round-trips", () => {
  it("writes a new track (unconditional) then reads it back", async () => {
    const trackIri = `${BASE}tracks/t1`;
    let stored = "";
    const { fetch, calls } = stubFetch({
      [`PUT ${trackIri}`]: () => {
        return new Response(null, { status: 201 });
      },
      [`GET ${trackIri}`]: () => turtleResponse(stored, { etag: '"v1"' }),
    });
    const store = new MusicStore({ base: BASE, fetch });

    const track = store.newTrack(trackIri);
    track.title = "Arabesque";
    track.durationSeconds = 240;
    await store.putTrack(track);

    // capture what was PUT and feed it to the GET route
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect(put?.headers.get("content-type")).toBe("text/turtle");
    expect(put?.headers.has("if-match")).toBe(false); // unconditional create
    stored = put?.body ?? "";

    const { track: back, etag } = await store.getTrack(trackIri);
    expect(back.title).toBe("Arabesque");
    expect(back.durationSeconds).toBe(240);
    expect(back.types.has(MO_TRACK)).toBe(true);
    expect(etag).toBe('"v1"');
  });

  it("sends If-Match on a conditional update", async () => {
    const trackIri = `${BASE}tracks/t1`;
    const { fetch, calls } = stubFetch({
      [`PUT ${trackIri}`]: () => new Response(null, { status: 205 }),
    });
    const store = new MusicStore({ base: BASE, fetch });
    const track = store.newTrack(trackIri);
    track.title = "Reverie";
    await store.putTrack(track, '"etag-7"');
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers.get("if-match")).toBe('"etag-7"');
  });

  it("round-trips album, artist, playlist and listen via the store", async () => {
    const albumIri = `${BASE}albums/al1`;
    const artistIri = `${BASE}artists/a1`;
    const playlistIri = `${BASE}playlists/p1`;
    const listenIri = `${BASE}listens/l1`;
    const bodies: Record<string, string> = {};
    const { fetch, calls } = stubFetch({
      [`PUT ${albumIri}`]: () => new Response(null, { status: 201 }),
      [`PUT ${artistIri}`]: () => new Response(null, { status: 201 }),
      [`PUT ${playlistIri}`]: () => new Response(null, { status: 201 }),
      [`PUT ${listenIri}`]: () => new Response(null, { status: 201 }),
      [`GET ${albumIri}`]: () => turtleResponse(bodies[albumIri] ?? ""),
      [`GET ${artistIri}`]: () => turtleResponse(bodies[artistIri] ?? ""),
      [`GET ${playlistIri}`]: () => turtleResponse(bodies[playlistIri] ?? ""),
      [`GET ${listenIri}`]: () => turtleResponse(bodies[listenIri] ?? ""),
    });
    const store = new MusicStore({ base: BASE, fetch });

    const album = store.newAlbum(albumIri);
    album.title = "Préludes";
    album.artist = artistIri;
    album.addTrack(`${BASE}tracks/t1`);
    await store.putAlbum(album);

    const artist = store.newArtist(artistIri);
    artist.name = "Debussy";
    await store.putArtist(artist);

    const playlist = store.newPlaylist(playlistIri);
    playlist.title = "Focus";
    playlist.addTrack(`${BASE}tracks/t1`);
    await store.putPlaylist(playlist);

    const listen = store.newListen(listenIri);
    listen.trackIri = `${BASE}tracks/t1`;
    listen.startTime = new Date("2026-06-15T09:00:00.000Z");
    await store.putListen(listen);

    for (const c of calls.filter((x) => x.method === "PUT")) {
      bodies[c.url] = c.body ?? "";
    }

    expect((await store.getAlbum(albumIri)).album.title).toBe("Préludes");
    expect((await store.getArtist(artistIri)).artist.name).toBe("Debussy");
    expect((await store.getPlaylist(playlistIri)).playlist.title).toBe("Focus");
    const { listen: backListen } = await store.getListen(listenIri);
    expect(backListen.trackIri).toBe(`${BASE}tracks/t1`);
    expect(backListen.startTime.toISOString()).toBe("2026-06-15T09:00:00.000Z");
  });
});

describe("MusicStore WAC + error mapping", () => {
  it("maps a 403 GET to AccessDeniedError", async () => {
    const trackIri = `${BASE}tracks/locked`;
    const { fetch } = stubFetch({
      [`GET ${trackIri}`]: () => turtleResponse("denied", { status: 403 }),
    });
    const store = new MusicStore({ base: BASE, fetch });
    await expect(store.getTrack(trackIri)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("maps a 401 GET to AccessDeniedError", async () => {
    const trackIri = `${BASE}tracks/auth`;
    const { fetch } = stubFetch({
      [`GET ${trackIri}`]: () => turtleResponse("unauth", { status: 401 }),
    });
    const store = new MusicStore({ base: BASE, fetch });
    await expect(store.getTrack(trackIri)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("maps a 404 GET to ResourceNotFoundError", async () => {
    const trackIri = `${BASE}tracks/missing`;
    const { fetch } = stubFetch({
      [`GET ${trackIri}`]: () => turtleResponse("gone", { status: 404 }),
    });
    const store = new MusicStore({ base: BASE, fetch });
    await expect(store.getTrack(trackIri)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("re-throws an unexpected GET status (e.g. 500)", async () => {
    const trackIri = `${BASE}tracks/boom`;
    const { fetch } = stubFetch({
      [`GET ${trackIri}`]: () => turtleResponse("server error", { status: 500 }),
    });
    const store = new MusicStore({ base: BASE, fetch });
    await expect(store.getTrack(trackIri)).rejects.toBeTruthy();
    await expect(store.getTrack(trackIri)).rejects.not.toBeInstanceOf(AccessDeniedError);
  });

  it("maps PUT 403/401/404 and re-throws other PUT failures", async () => {
    const iri = `${BASE}tracks/t1`;
    const make = (status: number) => {
      const { fetch } = stubFetch({
        [`PUT ${iri}`]: () => new Response("x", { status, statusText: "nope" }),
      });
      const store = new MusicStore({ base: BASE, fetch });
      const track = store.newTrack(iri);
      track.title = "T";
      return store.putTrack(track);
    };
    await expect(make(403)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(make(401)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(make(404)).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(make(500)).rejects.toThrow(/PUT .* failed: 500/);
  });
});

describe("MusicStore listing", () => {
  it("lists ldp:contains children of a container", async () => {
    const container = `${BASE}tracks/`;
    const body = `
      @prefix ldp: <http://www.w3.org/ns/ldp#> .
      <${container}> ldp:contains <${container}t1>, <${container}t2> .
    `;
    const { fetch } = stubFetch({ [`GET ${container}`]: () => turtleResponse(body) });
    const store = new MusicStore({ base: BASE, fetch });
    const listed = await store.listContainer(container);
    expect(new Set(listed)).toEqual(new Set([`${container}t1`, `${container}t2`]));
  });

  it("listTracks lists the tracks container", async () => {
    const container = `${BASE}tracks/`;
    const body = `<${container}> <${LDP_CONTAINS}> <${container}only> .`;
    const { fetch } = stubFetch({ [`GET ${container}`]: () => turtleResponse(body) });
    const store = new MusicStore({ base: BASE, fetch });
    expect(await store.listTracks()).toEqual([`${container}only`]);
  });

  it("rejects a non-container IRI passed to listContainer", async () => {
    const store = new MusicStore({ base: BASE, fetch: stubFetch({}).fetch });
    await expect(store.listContainer(`${BASE}tracks/t1`)).rejects.toBeInstanceOf(InvalidModelError);
  });
});

describe("MusicStore type index", () => {
  it("finds the registered track containers via the public type index", async () => {
    const indexIri = `${BASE.replace("music/", "")}settings/publicTypeIndex.ttl`;
    const profile = `<${WEBID}> <${SOLID_PUBLIC_TYPE_INDEX}> <${indexIri}> .`;
    const index = `
      @prefix solid: <http://www.w3.org/ns/solid/terms#> .
      @prefix mo: <http://purl.org/ontology/mo/> .
      <${indexIri}> a solid:TypeIndex, solid:ListedDocument .
      <${indexIri}#r> a solid:TypeRegistration ;
        solid:forClass mo:Track ;
        solid:instanceContainer <${BASE}tracks/> .
    `;
    const { fetch } = stubFetch({
      [`GET ${WEBID}`]: () => turtleResponse(profile),
      [`GET ${indexIri}`]: () => turtleResponse(index),
    });
    const store = new MusicStore({ base: BASE, fetch });
    expect(await store.findTrackContainers(WEBID)).toEqual([`${BASE}tracks/`]);
  });

  it("returns empty when the profile has no public type index", async () => {
    const profile = `<${WEBID}> <http://xmlns.com/foaf/0.1/name> "Alice" .`;
    const { fetch } = stubFetch({ [`GET ${WEBID}`]: () => turtleResponse(profile) });
    const store = new MusicStore({ base: BASE, fetch });
    expect(await store.findTrackContainers(WEBID)).toEqual([]);
  });

  it("builds and serialises a track registration document", async () => {
    const docIri = `${BASE}settings/publicTypeIndex.ttl`;
    const store = new MusicStore({ base: BASE, fetch: stubFetch({}).fetch });
    const idx = store.buildTrackRegistration(docIri);
    expect(idx.containersForClass(MO_TRACK)).toEqual([`${BASE}tracks/`]);
    const turtle = await store.serializeIndex(idx);
    expect(turtle).toContain("TypeRegistration");
    expect(turtle).toContain("tracks/");
  });
});

describe("MusicStore.labelFromDataset", () => {
  it("prefers schema:name, then dcterms:title, then rdfs:label, then the IRI tail", () => {
    const iri = `${BASE}tracks/t1`;
    const withName = emptyDataset();
    withName.add(
      factory.quad(factory.namedNode(iri), factory.namedNode(SCHEMA_NAME), factory.literal("Name")),
    );
    expect(MusicStore.labelFromDataset(withName, iri)).toBe("Name");

    const withTitle = emptyDataset();
    withTitle.add(
      factory.quad(
        factory.namedNode(iri),
        factory.namedNode("http://purl.org/dc/terms/title"),
        factory.literal("Title"),
      ),
    );
    expect(MusicStore.labelFromDataset(withTitle, iri)).toBe("Title");

    const withLabel = emptyDataset();
    withLabel.add(
      factory.quad(
        factory.namedNode(iri),
        factory.namedNode("http://www.w3.org/2000/01/rdf-schema#label"),
        factory.literal("Label"),
      ),
    );
    expect(MusicStore.labelFromDataset(withLabel, iri)).toBe("Label");
  });

  it("falls back to the IRI tail and skips non-literal/empty values", () => {
    const iri = `${BASE}tracks/the-tail`;
    const ds = emptyDataset();
    // a non-literal object for schema:name must be skipped
    ds.add(
      factory.quad(
        factory.namedNode(iri),
        factory.namedNode(SCHEMA_NAME),
        factory.namedNode("https://x/not-a-label"),
      ),
    );
    expect(MusicStore.labelFromDataset(ds, iri)).toBe("the-tail");

    // empty-literal also skipped → IRI tail
    const ds2 = emptyDataset();
    ds2.add(
      factory.quad(factory.namedNode(iri), factory.namedNode(SCHEMA_NAME), factory.literal("")),
    );
    expect(MusicStore.labelFromDataset(ds2, iri)).toBe("the-tail");
  });

  it("strips a trailing slash from a container IRI for the tail", () => {
    const ds = emptyDataset();
    expect(MusicStore.labelFromDataset(ds, `${BASE}tracks/`)).toBe("tracks");
  });

  it("returns the whole IRI when there is no usable tail", () => {
    const ds = emptyDataset();
    expect(MusicStore.labelFromDataset(ds, "/")).toBe("/");
  });
});
