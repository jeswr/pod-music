// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// MusicStore — the pod I/O layer for Pod Music. Composes the typed model
// (model.ts) + the type-index model (typeIndex.ts) with @jeswr/fetch-rdf for
// reads and n3.Writer for serialisation, behind a conditional-PUT write path.
//
// Pod-shaped: tracks/albums/artists/playlists/listens are resources inside
// per-class containers under a pod base; the app's primary class (mo:Track) is
// registered in the public type index for cross-app discovery.
//
// WAC-aware: a 401/403 read becomes an AccessDeniedError (a hint is not a grant
// — never silently swallow it); a 404 on a required GET becomes
// ResourceNotFoundError. Auth is ambient — pass an authenticated `fetch`
// (e.g. patched by @solid/reactive-authentication) via the constructor; default
// is globalThis.fetch.

import { fetchRdf, RdfFetchError } from "@jeswr/fetch-rdf";
import {
  DCTERMS_TITLE,
  LDP_CONTAINS,
  MO_TRACK,
  RDFS_LABEL,
  SCHEMA_NAME,
  SOLID_PUBLIC_TYPE_INDEX,
} from "../vocab/iris.js";
import { AccessDeniedError, InvalidModelError, ResourceNotFoundError } from "./errors.js";
import { Album, Artist, ListenAction, Playlist, Track } from "./model.js";
import { emptyDataset, factory, serializeTurtle } from "./rdf.js";
import { TypeIndexDataset } from "./typeIndex.js";

/** The per-class container layout under a pod base, all trailing-slashed. */
export interface MusicLayout {
  tracks: string;
  albums: string;
  artists: string;
  playlists: string;
  listens: string;
}

export interface MusicStoreOptions {
  /**
   * The pod base IRI (MUST end with `/`), e.g. `https://alice.example/music/`.
   * The default per-class container layout is derived from it.
   */
  base: string;
  /** Authenticated fetch. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

function assertContainer(iri: string, field: string): string {
  if (!iri.endsWith("/")) {
    throw new InvalidModelError(`${field} must be a container IRI ending in '/' (got ${iri})`);
  }
  return iri;
}

/**
 * Map a fetch-rdf error to the data layer's typed errors. 401/403 → access
 * denied; 404 → not found; anything else re-thrown.
 */
function mapFetchError(error: unknown, url: string): never {
  if (error instanceof RdfFetchError) {
    if (error.status === 401 || error.status === 403) {
      throw new AccessDeniedError(url, error.status);
    }
    if (error.status === 404) {
      throw new ResourceNotFoundError(url);
    }
  }
  throw error;
}

/**
 * The pod-backed music store. Construct with a pod base; read/write/list the
 * music domain through typed wrappers.
 */
export class MusicStore {
  readonly layout: MusicLayout;
  private readonly fetchFn: typeof fetch;

  constructor(options: MusicStoreOptions) {
    const base = assertContainer(options.base, "MusicStore.base");
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.layout = {
      tracks: `${base}tracks/`,
      albums: `${base}albums/`,
      artists: `${base}artists/`,
      playlists: `${base}playlists/`,
      listens: `${base}listens/`,
    };
  }

  /** GET + parse an RDF resource; maps WAC/404 errors. Returns dataset + etag. */
  private async read(url: string): Promise<{ dataset: import("n3").Store; etag: string | null }> {
    try {
      const { dataset, etag } = await fetchRdf(url, { fetch: this.fetchFn });
      return { dataset: dataset as unknown as import("n3").Store, etag };
    } catch (error) {
      return mapFetchError(error, url);
    }
  }

  /**
   * Conditional PUT of a Turtle body. When `etag` is provided we send
   * `If-Match`; on a fresh create pass `null` for an unconditional create (the
   * caller is responsible for the create-vs-update decision). A 401/403/404 is
   * mapped to a typed error.
   */
  private async write(url: string, body: string, etag: string | null): Promise<void> {
    const headers: Record<string, string> = { "content-type": "text/turtle" };
    if (etag !== null) {
      headers["if-match"] = etag;
    }
    const res = await this.fetchFn(url, { method: "PUT", headers, body });
    if (res.ok) {
      return;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AccessDeniedError(url, res.status);
    }
    if (res.status === 404) {
      throw new ResourceNotFoundError(url);
    }
    throw new Error(`PUT ${url} failed: ${res.status} ${res.statusText}`);
  }

  // --- Track ---

  /** Build (in memory) a Track at `iri` wrapping a fresh dataset. */
  newTrack(iri: string): Track {
    return new Track(iri, emptyDataset(), factory).stampType();
  }

  /** Persist a Track (its whole dataset) to the pod via conditional PUT. */
  async putTrack(track: Track, etag: string | null = null): Promise<void> {
    const body = await serializeTurtle(track.dataset);
    await this.write(track.value, body, etag);
  }

  /** Read a Track resource from the pod. */
  async getTrack(iri: string): Promise<{ track: Track; etag: string | null }> {
    const { dataset, etag } = await this.read(iri);
    return { track: new Track(iri, dataset, factory), etag };
  }

  // --- Album ---

  newAlbum(iri: string): Album {
    return new Album(iri, emptyDataset(), factory).stampType();
  }
  async putAlbum(album: Album, etag: string | null = null): Promise<void> {
    await this.write(album.value, await serializeTurtle(album.dataset), etag);
  }
  async getAlbum(iri: string): Promise<{ album: Album; etag: string | null }> {
    const { dataset, etag } = await this.read(iri);
    return { album: new Album(iri, dataset, factory), etag };
  }

  // --- Artist ---

  newArtist(iri: string): Artist {
    return new Artist(iri, emptyDataset(), factory).stampType();
  }
  async putArtist(artist: Artist, etag: string | null = null): Promise<void> {
    await this.write(artist.value, await serializeTurtle(artist.dataset), etag);
  }
  async getArtist(iri: string): Promise<{ artist: Artist; etag: string | null }> {
    const { dataset, etag } = await this.read(iri);
    return { artist: new Artist(iri, dataset, factory), etag };
  }

  // --- Playlist ---

  newPlaylist(iri: string): Playlist {
    return new Playlist(iri, emptyDataset(), factory).stampType();
  }
  async putPlaylist(playlist: Playlist, etag: string | null = null): Promise<void> {
    await this.write(playlist.value, await serializeTurtle(playlist.dataset), etag);
  }
  async getPlaylist(iri: string): Promise<{ playlist: Playlist; etag: string | null }> {
    const { dataset, etag } = await this.read(iri);
    return { playlist: new Playlist(iri, dataset, factory), etag };
  }

  // --- ListenAction (listen-history) ---

  newListen(iri: string): ListenAction {
    return new ListenAction(iri, emptyDataset(), factory).stampType();
  }
  async putListen(listen: ListenAction, etag: string | null = null): Promise<void> {
    await this.write(listen.value, await serializeTurtle(listen.dataset), etag);
  }
  async getListen(iri: string): Promise<{ listen: ListenAction; etag: string | null }> {
    const { dataset, etag } = await this.read(iri);
    return { listen: new ListenAction(iri, dataset, factory), etag };
  }

  // --- Listing ---

  /**
   * List the direct child resource IRIs of a container via its `ldp:contains`
   * graph. QLever/CSS both serve the container as RDF; we read it through the
   * same RDF path (no S3 LIST, no HEAD-walking).
   */
  async listContainer(containerIri: string): Promise<string[]> {
    assertContainer(containerIri, "MusicStore.listContainer(containerIri)");
    const { dataset } = await this.read(containerIri);
    const out: string[] = [];
    for (const quad of dataset.match(
      factory.namedNode(containerIri),
      factory.namedNode(LDP_CONTAINS),
      null,
      null,
    )) {
      out.push(quad.object.value);
    }
    return out;
  }

  /** List the track resource IRIs in the tracks container. */
  listTracks(): Promise<string[]> {
    return this.listContainer(this.layout.tracks);
  }

  // --- Type index ---

  /**
   * Read the public type index off a WebID profile and return the container IRIs
   * registered for mo:Track (the app's primary class). Empty when no profile
   * link or no registration exists — the caller then create-and-links.
   */
  async findTrackContainers(webId: string): Promise<string[]> {
    const { dataset } = await this.read(webId);
    const indexes: string[] = [];
    for (const quad of dataset.match(
      factory.namedNode(webId),
      factory.namedNode(SOLID_PUBLIC_TYPE_INDEX),
      null,
      null,
    )) {
      indexes.push(quad.object.value);
    }
    const containers: string[] = [];
    for (const indexIri of indexes) {
      const { dataset: idxData } = await this.read(indexIri);
      const idx = new TypeIndexDataset(idxData, factory);
      for (const c of idx.containersForClass(MO_TRACK)) {
        containers.push(c);
      }
    }
    return containers;
  }

  /**
   * Build (in memory) a public type-index document that registers Pod Music's
   * tracks container for mo:Track. Returns the dataset to PUT; linking it from
   * the profile (the solid:publicTypeIndex triple) is the caller's conditional
   * profile-write step. `documentIri` is the index doc URL.
   */
  buildTrackRegistration(documentIri: string): TypeIndexDataset {
    const idx = new TypeIndexDataset(emptyDataset(), factory);
    idx.stampPublicIndex(documentIri);
    idx.registerContainer(`${documentIri}#registration-track`, MO_TRACK, this.layout.tracks);
    return idx;
  }

  /** Serialise a type-index document to Turtle for PUT. */
  serializeIndex(index: TypeIndexDataset): Promise<string> {
    return serializeTurtle(index);
  }

  /**
   * A friendly display label for a listed resource, read from its own RDF:
   * schema:name → dcterms:title → rdfs:label → the IRI tail. Used by the UI/CLI
   * for listings without re-fetching each resource's full model.
   */
  static labelFromDataset(dataset: import("n3").Store, iri: string): string {
    const subject = factory.namedNode(iri);
    for (const predicate of [SCHEMA_NAME, DCTERMS_TITLE, RDFS_LABEL]) {
      for (const quad of dataset.match(subject, factory.namedNode(predicate), null, null)) {
        if (quad.object.termType === "Literal" && quad.object.value.length > 0) {
          return quad.object.value;
        }
      }
    }
    const trimmed = iri.endsWith("/") ? iri.slice(0, -1) : iri;
    const tail = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    return tail.length > 0 ? tail : iri;
  }
}
