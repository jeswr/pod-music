// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import type { DatasetCore } from "@rdfjs/types";
import { describe, expect, it } from "vitest";
import { InvalidModelError } from "../src/lib/errors.js";
import { Album, Artist, ListenAction, Playlist, Track } from "../src/lib/model.js";
import { emptyDataset, factory, parseTurtle, serializeTurtle } from "../src/lib/rdf.js";
import {
  MO_MUSIC_ARTIST,
  MO_PLAYLIST,
  MO_RECORD,
  MO_TRACK,
  SCHEMA_LISTEN_ACTION,
  SCHEMA_MUSIC_ALBUM,
  SCHEMA_MUSIC_GROUP,
  SCHEMA_MUSIC_PLAYLIST,
  SCHEMA_MUSIC_RECORDING,
} from "../src/vocab/iris.js";

const TRACK = "https://alice.example/music/tracks/t1";
const ARTIST = "https://alice.example/music/artists/a1";
const ALBUM = "https://alice.example/music/albums/al1";
const PLAYLIST = "https://alice.example/music/playlists/p1";
const LISTEN = "https://alice.example/music/listens/l1";

/** Round-trip a wrapper's dataset through Turtle and rebuild a fresh wrapper. */
async function roundTrip<T>(
  iri: string,
  dataset: DatasetCore,
  Ctor: { new (iri: string, dataset: DatasetCore, f: typeof factory): T },
): Promise<T> {
  const turtle = await serializeTurtle(dataset);
  const reparsed = await parseTurtle(turtle, iri);
  return new Ctor(iri, reparsed, factory);
}

describe("Track", () => {
  it("stamps mo:Track + schema:MusicRecording types (idempotently)", () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    track.stampType(); // second call is a no-op
    expect(track.types.has(MO_TRACK)).toBe(true);
    expect(track.types.has(SCHEMA_MUSIC_RECORDING)).toBe(true);
    expect(track.dataset.size).toBe(2);
  });

  it("round-trips all fields through Turtle", async () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    track.title = "Clair de Lune";
    track.artist = ARTIST;
    track.album = ALBUM;
    track.trackNumber = 3;
    track.durationSeconds = 300;

    const back = await roundTrip(TRACK, track.dataset, Track);
    expect(back.title).toBe("Clair de Lune");
    expect(back.artist).toBe(ARTIST);
    expect(back.album).toBe(ALBUM);
    expect(back.trackNumber).toBe(3);
    expect(back.durationSeconds).toBe(300);
    expect(back.types.has(MO_TRACK)).toBe(true);
  });

  it("writes duration to both schema:duration and mo:duration", async () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    track.title = "Track";
    track.durationSeconds = 123;
    const turtle = await serializeTurtle(track.dataset);
    expect(turtle).toContain("schema.org/duration");
    expect(turtle).toContain("ontology/mo/duration");
  });

  it("treats absent optional fields as undefined", () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    track.title = "Bare";
    expect(track.artist).toBeUndefined();
    expect(track.album).toBeUndefined();
    expect(track.trackNumber).toBeUndefined();
    expect(track.durationSeconds).toBeUndefined();
  });

  it("clears an optional field when set to undefined", () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    track.title = "X";
    track.artist = ARTIST;
    expect(track.artist).toBe(ARTIST);
    track.artist = undefined;
    expect(track.artist).toBeUndefined();
    track.trackNumber = 2;
    track.trackNumber = undefined;
    expect(track.trackNumber).toBeUndefined();
    track.durationSeconds = 100;
    expect(track.durationSeconds).toBe(100);
    track.durationSeconds = undefined;
    expect(track.durationSeconds).toBeUndefined();
  });

  it("rejects an empty title", () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    expect(() => {
      track.title = "";
    }).toThrow(InvalidModelError);
  });

  it("enforces a positive-integer trackNumber (rejects 0, negative, fractional, NaN)", () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        track.trackNumber = bad;
      }).toThrow(InvalidModelError);
    }
    track.trackNumber = 1; // a valid 1-based position
    expect(track.trackNumber).toBe(1);
  });

  it("enforces a non-negative-integer duration (rejects negative, fractional, NaN; allows 0)", () => {
    const track = new Track(TRACK, emptyDataset(), factory).stampType();
    for (const bad of [-5, 12.34, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        track.durationSeconds = bad;
      }).toThrow(InvalidModelError);
    }
    track.durationSeconds = 0; // zero-length is permitted
    expect(track.durationSeconds).toBe(0);
  });
});

describe("Artist", () => {
  it("stamps types and round-trips its name", async () => {
    const artist = new Artist(ARTIST, emptyDataset(), factory).stampType();
    artist.stampType();
    artist.name = "Claude Debussy";
    expect(artist.types.has(MO_MUSIC_ARTIST)).toBe(true);
    expect(artist.types.has(SCHEMA_MUSIC_GROUP)).toBe(true);
    const back = await roundTrip(ARTIST, artist.dataset, Artist);
    expect(back.name).toBe("Claude Debussy");
  });

  it("rejects an empty name", () => {
    const artist = new Artist(ARTIST, emptyDataset(), factory).stampType();
    expect(() => {
      artist.name = "";
    }).toThrow(InvalidModelError);
  });
});

describe("Album", () => {
  it("stamps types, sets fields, lists/adds tracks idempotently", async () => {
    const album = new Album(ALBUM, emptyDataset(), factory).stampType();
    album.stampType();
    album.title = "Suite bergamasque";
    album.artist = ARTIST;
    album.numTracks = 4;
    album.addTrack(TRACK);
    album.addTrack(TRACK); // idempotent
    expect(album.types.has(MO_RECORD)).toBe(true);
    expect(album.types.has(SCHEMA_MUSIC_ALBUM)).toBe(true);
    expect([...album.trackIris]).toEqual([TRACK]);

    const back = await roundTrip(ALBUM, album.dataset, Album);
    expect(back.title).toBe("Suite bergamasque");
    expect(back.artist).toBe(ARTIST);
    expect(back.numTracks).toBe(4);
    expect(back.trackIris.has(TRACK)).toBe(true);
  });

  it("treats absent artist/numTracks as undefined and supports clearing", () => {
    const album = new Album(ALBUM, emptyDataset(), factory).stampType();
    album.title = "X";
    expect(album.artist).toBeUndefined();
    expect(album.numTracks).toBeUndefined();
    album.numTracks = 3;
    album.numTracks = undefined;
    expect(album.numTracks).toBeUndefined();
  });

  it("rejects an empty title, empty track IRI, and a non-integer/negative numTracks", () => {
    const album = new Album(ALBUM, emptyDataset(), factory).stampType();
    expect(() => {
      album.title = "";
    }).toThrow(InvalidModelError);
    expect(() => album.addTrack("")).toThrow(InvalidModelError);
    for (const bad of [-2, 3.5, Number.NaN]) {
      expect(() => {
        album.numTracks = bad;
      }).toThrow(InvalidModelError);
    }
    album.numTracks = 0; // a non-negative integer is fine
    expect(album.numTracks).toBe(0);
  });
});

describe("Playlist", () => {
  const t2 = "https://alice.example/music/tracks/t2";
  const t3 = "https://alice.example/music/tracks/t3";

  it("preserves order, allows duplicates, and round-trips losslessly", async () => {
    const playlist = new Playlist(PLAYLIST, emptyDataset(), factory).stampType();
    playlist.stampType();
    playlist.title = "Evening";
    playlist.addTrack(TRACK);
    playlist.addTrack(t2);
    playlist.addTrack(TRACK); // duplicate is allowed and kept
    expect(playlist.types.has(MO_PLAYLIST)).toBe(true);
    expect(playlist.types.has(SCHEMA_MUSIC_PLAYLIST)).toBe(true);
    expect(playlist.tracks()).toEqual([TRACK, t2, TRACK]);

    const back = await roundTrip(PLAYLIST, playlist.dataset, Playlist);
    expect(back.title).toBe("Evening");
    expect(back.tracks()).toEqual([TRACK, t2, TRACK]); // order + duplicates survive
  });

  it("removeAt removes the entry at an index and re-densifies positions", () => {
    const playlist = new Playlist(PLAYLIST, emptyDataset(), factory).stampType();
    playlist.title = "L";
    playlist.setTracks([TRACK, t2, t3]);
    playlist.removeAt(1);
    expect(playlist.tracks()).toEqual([TRACK, t3]);
    // positions stay contiguous 1..n after removal — appending lands at the end
    playlist.addTrack(t2);
    expect(playlist.tracks()).toEqual([TRACK, t3, t2]);
  });

  it("removeAt is a no-op for an out-of-range index", () => {
    const playlist = new Playlist(PLAYLIST, emptyDataset(), factory).stampType();
    playlist.title = "L";
    playlist.setTracks([TRACK, t2]);
    playlist.removeAt(-1);
    playlist.removeAt(5);
    expect(playlist.tracks()).toEqual([TRACK, t2]);
  });

  it("setTracks replaces the entire list (and clears prior entries)", () => {
    const playlist = new Playlist(PLAYLIST, emptyDataset(), factory).stampType();
    playlist.title = "L";
    playlist.setTracks([TRACK, t2, t3]);
    playlist.setTracks([t3]);
    expect(playlist.tracks()).toEqual([t3]);
    playlist.setTracks([]);
    expect(playlist.tracks()).toEqual([]);
  });

  it("reads order from schema:position regardless of triple emission order", async () => {
    const turtle = `
      @prefix mo: <http://purl.org/ontology/mo/> .
      @prefix schema: <http://schema.org/> .
      <${PLAYLIST}> a mo:Playlist ; schema:name "Mixed" ;
        schema:itemListElement
          [ a schema:ListItem ; schema:position 2 ; schema:item <${t2}> ],
          [ a schema:ListItem ; schema:position 1 ; schema:item <${TRACK}> ] .
    `;
    const dataset = await parseTurtle(turtle, PLAYLIST);
    const playlist = new Playlist(PLAYLIST, dataset, factory);
    expect(playlist.tracks()).toEqual([TRACK, t2]); // sorted by position, not source order
  });

  it("rejects an empty title and empty track IRI (addTrack + setTracks)", () => {
    const playlist = new Playlist(PLAYLIST, emptyDataset(), factory).stampType();
    expect(() => {
      playlist.title = "";
    }).toThrow(InvalidModelError);
    expect(() => playlist.addTrack("")).toThrow(InvalidModelError);
    expect(() => playlist.setTracks([TRACK, ""])).toThrow(InvalidModelError);
  });
});

describe("ListenAction", () => {
  it("stamps schema:ListenAction and round-trips a full listen event", async () => {
    const listen = new ListenAction(LISTEN, emptyDataset(), factory).stampType();
    listen.stampType();
    const start = new Date("2026-06-15T10:00:00.000Z");
    const end = new Date("2026-06-15T10:05:00.000Z");
    listen.trackIri = TRACK;
    listen.agent = "https://alice.example/profile/card#me";
    listen.startTime = start;
    listen.endTime = end;
    expect(listen.types.has(SCHEMA_LISTEN_ACTION)).toBe(true);

    const back = await roundTrip(LISTEN, listen.dataset, ListenAction);
    expect(back.trackIri).toBe(TRACK);
    expect(back.agent).toBe("https://alice.example/profile/card#me");
    expect(back.startTime.toISOString()).toBe(start.toISOString());
    expect(back.endTime?.toISOString()).toBe(end.toISOString());
  });

  it("treats absent agent/endTime as undefined and supports clearing", () => {
    const listen = new ListenAction(LISTEN, emptyDataset(), factory).stampType();
    listen.trackIri = TRACK;
    listen.startTime = new Date("2026-06-15T10:00:00.000Z");
    expect(listen.agent).toBeUndefined();
    expect(listen.endTime).toBeUndefined();
    listen.endTime = new Date("2026-06-15T10:01:00.000Z");
    listen.endTime = undefined;
    expect(listen.endTime).toBeUndefined();
  });

  it("rejects an empty trackIri", () => {
    const listen = new ListenAction(LISTEN, emptyDataset(), factory).stampType();
    expect(() => {
      listen.trackIri = "";
    }).toThrow(InvalidModelError);
  });
});
