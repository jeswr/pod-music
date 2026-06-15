// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import * as n3 from "n3";
import { DataFactory } from "n3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDataset, factory, parseTurtle, serializeTurtle } from "../src/lib/rdf.js";

const { namedNode, quad, literal } = DataFactory;

describe("rdf helpers", () => {
  it("exposes the n3 DataFactory as the shared factory", () => {
    expect(factory).toBe(DataFactory);
  });

  it("emptyDataset returns a fresh, empty store each call", () => {
    const a = emptyDataset();
    const b = emptyDataset();
    expect(a.size).toBe(0);
    a.add(quad(namedNode("https://x/s"), namedNode("https://x/p"), literal("o")));
    expect(a.size).toBe(1);
    expect(b.size).toBe(0); // independent
  });

  it("serializeTurtle emits Turtle for a populated dataset", async () => {
    const ds = emptyDataset();
    ds.add(quad(namedNode("https://x/s"), namedNode("https://x/p"), literal("hello")));
    const turtle = await serializeTurtle(ds);
    expect(turtle).toContain("https://x/s");
    expect(turtle).toContain("hello");
  });

  it("round-trips a dataset losslessly through Turtle", async () => {
    const ds = emptyDataset();
    ds.add(quad(namedNode("https://x/s"), namedNode("https://x/p"), literal("v")));
    const turtle = await serializeTurtle(ds);
    const back = await parseTurtle(turtle, "https://x/");
    expect(back.size).toBe(1);
    expect(back.has(quad(namedNode("https://x/s"), namedNode("https://x/p"), literal("v")))).toBe(
      true,
    );
  });

  it("parseTurtle resolves relative IRIs against the baseIRI", async () => {
    const turtle = "<#me> <https://x/knows> <other> .";
    const ds = await parseTurtle(turtle, "https://alice.example/card");
    const subjects = [...ds].map((q) => q.subject.value);
    expect(subjects).toContain("https://alice.example/card#me");
  });

  it("serializeTurtle rejects when the n3 Writer reports an error", async () => {
    // The Writer is permissive and rarely errors on real data; the promisified
    // reject branch is defensive. Drive it deterministically by making the
    // Writer's end() callback report an error.
    const boom = new Error("writer exploded");
    const endSpy = vi
      .spyOn(n3.Writer.prototype, "end")
      // biome-ignore lint/suspicious/noExplicitAny: matching n3's overloaded end() signature
      .mockImplementation(function (this: unknown, cb: any): string {
        cb(boom, "");
        return "";
      });
    const ds = emptyDataset();
    ds.add(quad(namedNode("https://x/s"), namedNode("https://x/p"), literal("o")));
    await expect(serializeTurtle(ds)).rejects.toBe(boom);
    expect(endSpy).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
