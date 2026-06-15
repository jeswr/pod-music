// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  InvalidModelError,
  PodMusicError,
  ResourceNotFoundError,
} from "../src/lib/errors.js";

describe("errors", () => {
  it("PodMusicError is an Error with a stable name", () => {
    const e = new PodMusicError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PodMusicError");
    expect(e.message).toBe("boom");
  });

  it("ResourceNotFoundError carries the URL and the right name", () => {
    const e = new ResourceNotFoundError("https://x/r");
    expect(e).toBeInstanceOf(PodMusicError);
    expect(e.name).toBe("ResourceNotFoundError");
    expect(e.url).toBe("https://x/r");
    expect(e.message).toContain("https://x/r");
  });

  it("AccessDeniedError carries the URL and status", () => {
    const e = new AccessDeniedError("https://x/r", 403);
    expect(e).toBeInstanceOf(PodMusicError);
    expect(e.name).toBe("AccessDeniedError");
    expect(e.url).toBe("https://x/r");
    expect(e.status).toBe(403);
    expect(e.message).toContain("403");
  });

  it("InvalidModelError carries its message", () => {
    const e = new InvalidModelError("bad value");
    expect(e).toBeInstanceOf(PodMusicError);
    expect(e.name).toBe("InvalidModelError");
    expect(e.message).toBe("bad value");
  });
});
