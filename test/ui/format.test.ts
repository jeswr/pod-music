// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { describe, expect, it } from "vitest";
import { errorMessage, formatDate, formatDuration, isSafeHref } from "../../src/ui/format.js";

describe("formatDuration", () => {
  it("returns an em-dash when the duration is absent", () => {
    expect(formatDuration(undefined)).toBe("—");
  });

  it("returns an em-dash for a negative or non-finite duration (never NaN:NaN)", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats sub-hour durations as m:ss with a zero-padded seconds field", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(185)).toBe("3:05");
    expect(formatDuration(599)).toBe("9:59");
  });

  it("formats hour-plus durations as h:mm:ss", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3729)).toBe("1:02:09");
  });

  it("floors a fractional seconds value rather than rounding up", () => {
    expect(formatDuration(65.9)).toBe("1:05");
  });
});

describe("formatDate", () => {
  it("returns an em-dash when the date is absent", () => {
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns an em-dash for an invalid Date rather than throwing", () => {
    expect(formatDate(new Date("not-a-date"))).toBe("—");
  });

  it("formats a valid date as YYYY-MM-DD (UTC)", () => {
    expect(formatDate(new Date("2026-06-15T12:34:56Z"))).toBe("2026-06-15");
  });
});

describe("errorMessage", () => {
  it("uses an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error thrown value", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("isSafeHref", () => {
  it("allows http(s) and mailto URLs", () => {
    expect(isSafeHref("https://pod.example/music/tracks/t1")).toBe(true);
    expect(isSafeHref("http://pod.example/x")).toBe(true);
    expect(isSafeHref("mailto:alice@example.com")).toBe(true);
  });

  it("rejects javascript: and data: URLs", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects a malformed (unparseable) URL", () => {
    expect(isSafeHref("not a url")).toBe(false);
    expect(isSafeHref("/relative/path")).toBe(false);
  });
});
