// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// profile.ts — the host shell's profile DATA LAYER.
//
// HOUSE-RULE CONTRACT: all RDF is read through @jeswr/fetch-rdf (fetch + parse)
// and the @solid/object typed accessors. Never parse Turtle by hand, never build
// triples by string concatenation.
//
// `fetch` is an OPTIONAL injected parameter. In the browser you omit it and the
// call uses the global fetch patched by reactive-authentication (so protected
// reads carry the DPoP token). The login probe passes the ORIGINAL, un-upgrading
// fetch for the pre-popup public read (see SessionProvider).
import { fetchRdf } from "@jeswr/fetch-rdf";
import { Agent, WebIdDataset } from "@solid/object";
import { DataFactory } from "n3";

/** The shape the host UI renders. Plain data — no RDF terms leak out. */
export interface Profile {
  webId: string;
  name: string;
  avatarUrl?: string;
  /** Every advertised `pim:storage` — present all; never pick one silently. */
  storages: string[];
  oidcIssuers: string[];
}

/**
 * Read a Solid WebID profile into a plain {@link Profile}.
 *
 * @throws {import("@jeswr/fetch-rdf").RdfFetchError} on transport / non-2xx / parse failure.
 * @throws {Error} when the document has no Solid-OIDC subject (the WebID has no
 *   solid:oidcIssuer — it cannot be used for Solid login).
 */
export async function readProfile(webId: string, fetchImpl?: typeof fetch): Promise<Profile> {
  const { dataset } = await fetchRdf(webId, fetchImpl ? { fetch: fetchImpl } : undefined);
  const me = new WebIdDataset(dataset, DataFactory).mainSubject;
  if (!me) {
    throw new Error(
      `No Solid-OIDC subject found in profile (${webId}). The WebID's profile has no ` +
        `solid:oidcIssuer — it cannot be used for Solid login.`,
    );
  }
  const agent = new Agent(webId, dataset, DataFactory);
  return {
    webId,
    name: me.name ?? webId,
    avatarUrl: me.photoUrl ?? undefined,
    storages: [...agent.storageUrls],
    oidcIssuers: [...agent.oidcIssuer],
  };
}
