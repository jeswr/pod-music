// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Isolated test for the store's defensive non-RdfFetchError branch. fetch-rdf's
// contract is to wrap every failure in RdfFetchError, so a plain Error escaping
// it is a regression scenario — but the store must still re-throw it untouched
// (never mis-map it to AccessDenied/NotFound). We mock the module to drive it.
import { describe, expect, it, vi } from "vitest";

vi.mock("@jeswr/fetch-rdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jeswr/fetch-rdf")>();
  return {
    ...actual,
    fetchRdf: vi.fn(() => {
      throw new Error("plain non-fetch error");
    }),
  };
});

const { MusicStore } = await import("../src/lib/store.js");
const { AccessDeniedError, ResourceNotFoundError } = await import("../src/lib/errors.js");

describe("MusicStore non-RdfFetchError defence", () => {
  it("re-throws a plain Error from fetchRdf unchanged", async () => {
    const store = new MusicStore({ base: "https://alice.example/music/" });
    const promise = store.getTrack("https://alice.example/music/tracks/t1");
    await expect(promise).rejects.toThrow("plain non-fetch error");
    await expect(promise).rejects.not.toBeInstanceOf(AccessDeniedError);
    await expect(promise).rejects.not.toBeInstanceOf(ResourceNotFoundError);
  });
});
