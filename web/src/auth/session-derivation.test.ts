// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Tests for the music-specific session derivation: the pod-root derivation
// (verbatim from the host-shell template) plus the music-base resolution that is
// UNIQUE to pod-music (its <MusicLibrary base> wants the music CONTAINER, not a
// bare pod root, so the host resolves it via the data layer's Type-Index helper
// with a conventional `${podRoot}music/` fallback + a banner flag).
import { describe, expect, it } from "vitest";
import type { Profile } from "./profile";
import {
  deriveSession,
  discoverMusicBase,
  musicBaseFromTracksContainer,
} from "./session-derivation";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    webId: "https://alice.example/profile/card#me",
    name: "Alice",
    storages: [],
    oidcIssuers: ["https://idp.example/"],
    ...overrides,
  };
}

describe("deriveSession — pod-root derivation", () => {
  it("uses the first pim:storage when advertised", () => {
    const s = deriveSession(profile({ storages: ["https://alice.example/storage/"] }));
    expect(s.podRoot).toBe("https://alice.example/storage/");
    expect(s.podRootIsFallback).toBe(false);
    expect(s.webId).toBe("https://alice.example/profile/card#me");
  });

  it("adds a trailing slash to a slashless storage", () => {
    const s = deriveSession(profile({ storages: ["https://alice.example/storage"] }));
    expect(s.podRoot).toBe("https://alice.example/storage/");
  });

  it("falls back to the WebID origin when no pim:storage is advertised", () => {
    const s = deriveSession(profile({ storages: [] }));
    expect(s.podRoot).toBe("https://alice.example/");
    expect(s.podRootIsFallback).toBe(true);
  });
});

describe("musicBaseFromTracksContainer — parent of a registered tracks/ container", () => {
  it("strips a trailing tracks/ segment to yield the music base", () => {
    expect(musicBaseFromTracksContainer("https://alice.example/music/tracks/")).toBe(
      "https://alice.example/music/",
    );
  });

  it("tolerates a missing trailing slash on the registered container", () => {
    expect(musicBaseFromTracksContainer("https://alice.example/music/tracks")).toBe(
      "https://alice.example/music/",
    );
  });

  it("handles a non-conventional parent path", () => {
    expect(musicBaseFromTracksContainer("https://alice.example/my-media/tracks/")).toBe(
      "https://alice.example/my-media/",
    );
  });

  it("returns undefined when the container does not end in tracks/", () => {
    expect(musicBaseFromTracksContainer("https://alice.example/music/albums/")).toBeUndefined();
    expect(musicBaseFromTracksContainer("https://alice.example/music/")).toBeUndefined();
  });
});

describe("discoverMusicBase — Type Index first, conventional fallback", () => {
  const session = deriveSession(profile({ storages: ["https://alice.example/storage/"] }));

  it("resolves the music base from a Type-Index tracks registration", async () => {
    const store = {
      findTrackContainers: async () => ["https://alice.example/storage/music/tracks/"],
    };
    const result = await discoverMusicBase(store, session);
    expect(result.base).toBe("https://alice.example/storage/music/");
    expect(result.isFallback).toBe(false);
  });

  it("falls back to the conventional podRoot + music/ when no registration exists (and flags it)", async () => {
    const store = { findTrackContainers: async () => [] };
    const result = await discoverMusicBase(store, session);
    expect(result.base).toBe("https://alice.example/storage/music/");
    expect(result.isFallback).toBe(true);
  });

  it("falls back when the registered container is not a recognisable tracks/ container", async () => {
    const store = {
      findTrackContainers: async () => ["https://alice.example/storage/music/"],
    };
    const result = await discoverMusicBase(store, session);
    expect(result.base).toBe("https://alice.example/storage/music/");
    expect(result.isFallback).toBe(true);
  });

  it("falls back (does not throw) when discovery rejects — e.g. no profile link / 401 / parse error", async () => {
    const store = {
      findTrackContainers: async () => {
        throw new Error("no public type index linked from the profile");
      },
    };
    const result = await discoverMusicBase(store, session);
    expect(result.base).toBe("https://alice.example/storage/music/");
    expect(result.isFallback).toBe(true);
  });

  it("takes the FIRST usable tracks registration when several are returned", async () => {
    const store = {
      findTrackContainers: async () => [
        "https://alice.example/storage/not-tracks/",
        "https://alice.example/storage/library/tracks/",
      ],
    };
    const result = await discoverMusicBase(store, session);
    expect(result.base).toBe("https://alice.example/storage/library/");
    expect(result.isFallback).toBe(false);
  });
});
