// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// RDF I/O helpers for the data layer. We serialise with n3.Writer (callback API,
// promisified per the house rule) and parse with @jeswr/fetch-rdf's parseRdf —
// never a bespoke parser, never `new Parser().parse(...)` inline.

import { parseRdf } from "@jeswr/fetch-rdf";
import type { DatasetCore, Quad } from "@rdfjs/types";
import { DataFactory, Store, Writer } from "n3";

/**
 * The single DataFactory used everywhere in this package. Mixing factories
 * breaks term identity (`.equals`, Set membership), so all wrappers and stores
 * thread this one instance.
 */
export const factory = DataFactory;

/** A fresh, empty n3.Store (our concrete DatasetCore). */
export function emptyDataset(): Store {
  return new Store();
}

/**
 * Serialise a dataset to Turtle. The n3 Writer is callback-based; we promisify
 * it rather than awaiting it directly.
 */
export function serializeTurtle(dataset: DatasetCore): Promise<string> {
  const writer = new Writer({ format: "text/turtle" });
  for (const quad of dataset as Iterable<Quad>) {
    writer.addQuad(quad);
  }
  return new Promise<string>((resolve, reject) => {
    writer.end((error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Parse a Turtle/JSON-LD body into an n3.Store via @jeswr/fetch-rdf. `baseIRI`
 * MUST be the resource's own URL so relative IRIs resolve per the Solid spec.
 */
export async function parseTurtle(body: string, baseIRI: string): Promise<Store> {
  const parsed = await parseRdf(body, "text/turtle", { baseIRI });
  // parseRdf returns an n3.Store at runtime.
  return parsed as unknown as Store;
}
