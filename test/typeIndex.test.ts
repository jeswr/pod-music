// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import { describe, expect, it } from "vitest";
import { emptyDataset, factory, parseTurtle, serializeTurtle } from "../src/lib/rdf.js";
import { TypeIndexDataset, TypeRegistration } from "../src/lib/typeIndex.js";
import {
  MO_TRACK,
  SCHEMA_MUSIC_RECORDING,
  SOLID_INSTANCE,
  SOLID_LISTED_DOCUMENT,
  SOLID_TYPE_INDEX,
  SOLID_TYPE_REGISTRATION,
} from "../src/vocab/iris.js";

const DOC = "https://alice.example/settings/publicTypeIndex.ttl";
const TRACKS = "https://alice.example/music/tracks/";

describe("TypeRegistration", () => {
  it("stamps its type and round-trips forClass + instanceContainer", () => {
    const reg = new TypeRegistration(`${DOC}#r1`, emptyDataset(), factory);
    reg.stampType();
    reg.stampType(); // idempotent
    reg.forClass = MO_TRACK;
    reg.instanceContainer = TRACKS;
    expect(reg.types.has(SOLID_TYPE_REGISTRATION)).toBe(true);
    expect(reg.forClass).toBe(MO_TRACK);
    expect(reg.instanceContainer).toBe(TRACKS);
    expect(reg.instance).toBeUndefined();
  });

  it("supports the solid:instance (single resource) form and clearing", () => {
    const reg = new TypeRegistration(`${DOC}#r2`, emptyDataset(), factory);
    reg.stampType();
    reg.forClass = SCHEMA_MUSIC_RECORDING;
    reg.instance = "https://alice.example/music/tracks/t1";
    expect(reg.instance).toBe("https://alice.example/music/tracks/t1");
    reg.instance = undefined;
    expect(reg.instance).toBeUndefined();
    reg.forClass = undefined;
    expect(reg.forClass).toBeUndefined();
    reg.instanceContainer = TRACKS;
    reg.instanceContainer = undefined;
    expect(reg.instanceContainer).toBeUndefined();
  });
});

describe("TypeIndexDataset", () => {
  it("builds a public index registering a container, idempotently", async () => {
    const idx = new TypeIndexDataset(emptyDataset(), factory);
    idx.stampPublicIndex(DOC);
    idx.stampPublicIndex(DOC); // idempotent
    const reg = idx.registerContainer(`${DOC}#registration-track`, MO_TRACK, TRACKS);
    const reg2 = idx.registerContainer(`${DOC}#other`, MO_TRACK, TRACKS); // dedup by (class, container)
    expect(reg.value).toBe(reg2.value);

    expect(idx.registrations()).toHaveLength(1);
    expect(idx.registrationsForClass(MO_TRACK)).toHaveLength(1);
    expect(idx.containersForClass(MO_TRACK)).toEqual([TRACKS]);
    expect(idx.instancesForClass(MO_TRACK)).toEqual([]);

    const turtle = await serializeTurtle(idx);
    expect(turtle).toContain("TypeIndex");
    expect(turtle).toContain("ListedDocument");
    expect(turtle).toContain("TypeRegistration");
  });

  it("re-registering a class for a different container creates a second entry", () => {
    const idx = new TypeIndexDataset(emptyDataset(), factory);
    idx.stampPublicIndex(DOC);
    idx.registerContainer(`${DOC}#a`, MO_TRACK, TRACKS);
    idx.registerContainer(`${DOC}#b`, MO_TRACK, "https://alice.example/music/extra-tracks/");
    expect(idx.registrationsForClass(MO_TRACK)).toHaveLength(2);
    expect(new Set(idx.containersForClass(MO_TRACK))).toEqual(
      new Set([TRACKS, "https://alice.example/music/extra-tracks/"]),
    );
  });

  it("reads registrations parsed from an existing index document", async () => {
    const turtle = `
      @prefix solid: <http://www.w3.org/ns/solid/terms#> .
      @prefix mo: <http://purl.org/ontology/mo/> .
      <${DOC}> a solid:TypeIndex, solid:ListedDocument .
      <${DOC}#reg> a solid:TypeRegistration ;
        solid:forClass mo:Track ;
        solid:instanceContainer <${TRACKS}> .
      <${DOC}#reg-inst> a solid:TypeRegistration ;
        solid:forClass mo:Track ;
        solid:instance <${TRACKS}t9> .
    `;
    const dataset = await parseTurtle(turtle, DOC);
    const idx = new TypeIndexDataset(dataset, factory);
    expect(idx.registrations()).toHaveLength(2);
    expect(idx.containersForClass(MO_TRACK)).toEqual([TRACKS]);
    expect(idx.instancesForClass(MO_TRACK)).toEqual([`${TRACKS}t9`]);
    expect(idx.containersForClass("http://purl.org/ontology/mo/Other")).toEqual([]);
  });

  it("emits the document types via stampPublicIndex", async () => {
    const idx = new TypeIndexDataset(emptyDataset(), factory);
    idx.stampPublicIndex(DOC);
    const docTypes = [...idx.match(factory.namedNode(DOC))].map((q) => q.object.value);
    expect(docTypes).toContain(SOLID_TYPE_INDEX);
    expect(docTypes).toContain(SOLID_LISTED_DOCUMENT);
    // the registration predicates are absent until a container is registered
    expect([...idx.match(undefined, factory.namedNode(SOLID_INSTANCE))]).toHaveLength(0);
  });
});
