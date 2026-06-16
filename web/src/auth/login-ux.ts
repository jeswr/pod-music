// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// login-ux.ts — WebID validation + issuer resolution for the standalone Solid
// login. Ported from create-solid-app's reference implementation; trimmed to the
// pieces the host shell needs (validateWebId, resolveIssuers, NoSolidIssuerError,
// InvalidWebIdError). RDF is read through @solid/object typed accessors — never a
// bespoke parser, never hand-built triples.
import type { DatasetCore } from "@rdfjs/types";
import { Agent } from "@solid/object";
import { DataFactory } from "n3";

/** The WebID's profile advertises no solid:oidcIssuer — not usable for Solid login. */
export class NoSolidIssuerError extends Error {
  readonly webId: string;
  constructor(webId: string) {
    super(
      `This WebID can't be used for Solid login — its profile has no solid:oidcIssuer (${webId}).`,
    );
    this.name = "NoSolidIssuerError";
    this.webId = webId;
  }
}

/** The input is not a usable WebID. */
export class InvalidWebIdError extends Error {
  constructor(input: string, reason: string) {
    super(`Not a valid WebID (${reason}): ${input}`);
    this.name = "InvalidWebIdError";
  }
}

/** Validate user input as a WebID: must parse as a URL, scheme http(s) only. */
export function validateWebId(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidWebIdError(input, "not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidWebIdError(input, "scheme must be http(s)");
  }
  return url.toString();
}

/**
 * Pure resolution from an already-fetched profile dataset: every
 * solid:oidcIssuer on the WebID subject. Throws NoSolidIssuerError when none.
 * One issuer → log straight in; several → the provider's chooseIssuer decides.
 */
export function resolveIssuers(webId: string, dataset: DatasetCore): string[] {
  const agent = new Agent(webId, dataset, DataFactory);
  const issuers = [...agent.oidcIssuer];
  if (issuers.length === 0) throw new NoSolidIssuerError(webId);
  return issuers;
}
