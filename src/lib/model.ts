// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// The typed RDF model for Pod Music — TermWrapper subclasses that read and write
// the music domain (tracks, albums, artists, playlists, listen-history) as quads
// over a DatasetCore. House rule (AGENTS.md §RDF): the graph is ALWAYS built and
// read through @rdfjs/wrapper typed accessors, never hand-built DataFactory.quad
// triples. Each class is dual-typed (Music Ontology + schema.org) so the data is
// legible to both mo:- and schema:-aware consumers.
//
// These are pure in-memory wrappers over a dataset; the pod I/O (fetch / PUT /
// list) lives in store.ts, which composes them with @jeswr/fetch-rdf + n3.Writer.

import type { Term } from "@rdfjs/types";
import {
  LiteralAs,
  LiteralFrom,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  RequiredAs,
  RequiredFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import {
  MO_DURATION,
  MO_MUSIC_ARTIST,
  MO_PLAYLIST,
  MO_RECORD,
  MO_TRACK,
  MO_TRACK_NUMBER,
  MO_TRACK_PROP,
  RDF_TYPE,
  SCHEMA_AGENT,
  SCHEMA_BY_ARTIST,
  SCHEMA_DURATION,
  SCHEMA_END_TIME,
  SCHEMA_IN_ALBUM,
  SCHEMA_ITEM,
  SCHEMA_ITEM_LIST_ELEMENT,
  SCHEMA_LIST_ITEM,
  SCHEMA_LISTEN_ACTION,
  SCHEMA_MUSIC_ALBUM,
  SCHEMA_MUSIC_GROUP,
  SCHEMA_MUSIC_PLAYLIST,
  SCHEMA_MUSIC_RECORDING,
  SCHEMA_NAME,
  SCHEMA_NUM_TRACKS,
  SCHEMA_OBJECT,
  SCHEMA_POSITION,
  SCHEMA_START_TIME,
  SCHEMA_TRACK,
} from "../vocab/iris.js";
import { InvalidModelError } from "./errors.js";

/**
 * Read a multi-valued IRI predicate into a PLAIN Set<string>. We deliberately
 * copy out of the live WrappingSet returned by SetFrom: a WrappingSet's `.add`
 * writes back to the dataset, so returning it from a getter would make a read
 * mutate the pod. Callers get a detached snapshot.
 */
function iriSet(self: TermWrapper, predicate: string): Set<string> {
  return new Set<string>(
    SetFrom.subjectPredicate(self, predicate, NamedNodeAs.string, NamedNodeFrom.string),
  );
}

/** rdf:type as a typed Set<string> (IRI values). */
function types(self: TermWrapper): Set<string> {
  return iriSet(self, RDF_TYPE);
}

/** Add an rdf:type IRI to a subject if not already present. */
function addType(self: TermWrapper, klass: string): void {
  const current = types(self);
  if (!current.has(klass)) {
    self.dataset.add(
      self.factory.quad(
        self as never,
        self.factory.namedNode(RDF_TYPE),
        self.factory.namedNode(klass),
      ),
    );
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new InvalidModelError(`${field} must not be empty`);
  }
  return value;
}

/** A non-negative integer (counts, durations-in-seconds). */
function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidModelError(`${field} must be a non-negative integer (got ${value})`);
  }
  return value;
}

/** A positive integer (1-based positions such as a track number). */
function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidModelError(`${field} must be a positive (1-based) integer (got ${value})`);
  }
  return value;
}

/**
 * A musician or band — mo:MusicArtist + schema:MusicGroup. Identified by its own
 * IRI in the pod (a resource or a #fragment).
 */
export class Artist extends TermWrapper {
  /** rdf:type IRIs on this subject. */
  get types(): Set<string> {
    return types(this);
  }

  /** schema:name — required for an artist record. */
  get name(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA_NAME, LiteralAs.string);
  }
  set name(value: string) {
    RequiredAs.object(this, SCHEMA_NAME, requireNonEmpty(value, "Artist.name"), LiteralFrom.string);
  }

  /** Stamp the mo:MusicArtist + schema:MusicGroup types. Idempotent. */
  stampType(): this {
    addType(this, MO_MUSIC_ARTIST);
    addType(this, SCHEMA_MUSIC_GROUP);
    return this;
  }
}

/**
 * A single recording — mo:Track + schema:MusicRecording. The primary class Pod
 * Music registers in the type index.
 */
export class Track extends TermWrapper {
  get types(): Set<string> {
    return types(this);
  }

  /** schema:name — the track title. Required. */
  get title(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA_NAME, LiteralAs.string);
  }
  set title(value: string) {
    RequiredAs.object(this, SCHEMA_NAME, requireNonEmpty(value, "Track.title"), LiteralFrom.string);
  }

  /** schema:byArtist — IRI of the performing Artist, if known. */
  get artist(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SCHEMA_BY_ARTIST, NamedNodeAs.string);
  }
  set artist(value: string | undefined) {
    OptionalAs.object(this, SCHEMA_BY_ARTIST, value, NamedNodeFrom.string);
  }

  /** schema:inAlbum — IRI of the containing Album, if any. */
  get album(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SCHEMA_IN_ALBUM, NamedNodeAs.string);
  }
  set album(value: string | undefined) {
    OptionalAs.object(this, SCHEMA_IN_ALBUM, value, NamedNodeFrom.string);
  }

  /** mo:track_number — 1-based position within its album, if any. */
  get trackNumber(): number | undefined {
    return OptionalFrom.subjectPredicate(this, MO_TRACK_NUMBER, LiteralAs.number);
  }
  set trackNumber(value: number | undefined) {
    OptionalAs.object(
      this,
      MO_TRACK_NUMBER,
      value === undefined ? undefined : requirePositiveInteger(value, "Track.trackNumber"),
      LiteralFrom.integer,
    );
  }

  /** Duration in seconds (schema:duration + mo:duration, written as integers). */
  get durationSeconds(): number | undefined {
    return OptionalFrom.subjectPredicate(this, SCHEMA_DURATION, LiteralAs.number);
  }
  set durationSeconds(value: number | undefined) {
    const checked =
      value === undefined ? undefined : requireNonNegativeInteger(value, "Track.durationSeconds");
    OptionalAs.object(this, SCHEMA_DURATION, checked, LiteralFrom.integer);
    OptionalAs.object(this, MO_DURATION, checked, LiteralFrom.integer);
  }

  stampType(): this {
    addType(this, MO_TRACK);
    addType(this, SCHEMA_MUSIC_RECORDING);
    return this;
  }
}

/**
 * An album / release — mo:Record + schema:MusicAlbum. Tracks reference it via
 * schema:inAlbum; it lists them via schema:track.
 */
export class Album extends TermWrapper {
  get types(): Set<string> {
    return types(this);
  }

  get title(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA_NAME, LiteralAs.string);
  }
  set title(value: string) {
    RequiredAs.object(this, SCHEMA_NAME, requireNonEmpty(value, "Album.title"), LiteralFrom.string);
  }

  get artist(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SCHEMA_BY_ARTIST, NamedNodeAs.string);
  }
  set artist(value: string | undefined) {
    OptionalAs.object(this, SCHEMA_BY_ARTIST, value, NamedNodeFrom.string);
  }

  /** schema:track — the set of Track IRIs on this album (detached snapshot). */
  get trackIris(): Set<string> {
    return iriSet(this, SCHEMA_TRACK);
  }

  /** Add a track IRI to schema:track. Idempotent. */
  addTrack(trackIri: string): this {
    requireNonEmpty(trackIri, "Album.addTrack(trackIri)");
    if (!this.trackIris.has(trackIri)) {
      this.dataset.add(
        this.factory.quad(
          this as never,
          this.factory.namedNode(SCHEMA_TRACK),
          this.factory.namedNode(trackIri),
        ),
      );
    }
    return this;
  }

  /** schema:numTracks — explicit count, if asserted. */
  get numTracks(): number | undefined {
    return OptionalFrom.subjectPredicate(this, SCHEMA_NUM_TRACKS, LiteralAs.number);
  }
  set numTracks(value: number | undefined) {
    OptionalAs.object(
      this,
      SCHEMA_NUM_TRACKS,
      value === undefined ? undefined : requireNonNegativeInteger(value, "Album.numTracks"),
      LiteralFrom.integer,
    );
  }

  stampType(): this {
    addType(this, MO_RECORD);
    addType(this, SCHEMA_MUSIC_ALBUM);
    return this;
  }
}

/**
 * A user-curated playlist — mo:Playlist + schema:MusicPlaylist.
 *
 * Order matters and duplicate tracks are allowed, so the playlist is a genuine
 * ORDERED list: each entry is a `schema:ListItem` linked from the playlist via
 * `schema:itemListElement`, carrying a 1-based `schema:position` and a
 * `schema:item` IRI pointing at the track. This round-trips losslessly through
 * Turtle (order is encoded in positions, not in triple emission order) and
 * permits the same track to appear more than once.
 *
 * The whole entry list is rewritten on every mutation (read positions → mutate
 * the array → re-write contiguous 1..n positions), which keeps positions dense
 * and the model trivially correct.
 */
export class Playlist extends TermWrapper {
  get types(): Set<string> {
    return types(this);
  }

  get title(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA_NAME, LiteralAs.string);
  }
  set title(value: string) {
    RequiredAs.object(
      this,
      SCHEMA_NAME,
      requireNonEmpty(value, "Playlist.title"),
      LiteralFrom.string,
    );
  }

  /**
   * The ordered track IRIs on the playlist, read from the `schema:ListItem`
   * entries sorted by `schema:position`. Returns a detached array — mutating it
   * never writes back to the dataset (use addTrack / removeAt / setTracks).
   */
  tracks(): string[] {
    const entries: { position: number; item: string }[] = [];
    for (const listItem of this.matchObjects(SCHEMA_ITEM_LIST_ELEMENT)) {
      const wrapped = new TermWrapper(listItem, this.dataset, this.factory);
      const position = RequiredFrom.subjectPredicate(wrapped, SCHEMA_POSITION, LiteralAs.number);
      const item = RequiredFrom.subjectPredicate(wrapped, SCHEMA_ITEM, NamedNodeAs.string);
      entries.push({ position, item });
    }
    entries.sort((a, b) => a.position - b.position);
    return entries.map((e) => e.item);
  }

  /** The objects of a predicate on this subject, as raw terms. */
  private matchObjects(predicate: string): Term[] {
    const out: Term[] = [];
    for (const quad of this.dataset.match(
      this as never,
      this.factory.namedNode(predicate),
      undefined,
      undefined,
    )) {
      out.push(quad.object);
    }
    return out;
  }

  /**
   * Replace the entire ordered track list (positions are re-densified 1..n).
   *
   * Also strips any flat `schema:track` / `mo:track` triples on the playlist
   * subject, so a playlist is never left in a mixed flat-plus-ordered state
   * (the ordered `schema:itemListElement` form is the single source of truth).
   */
  setTracks(trackIris: readonly string[]): this {
    for (const iri of trackIris) {
      requireNonEmpty(iri, "Playlist.setTracks(trackIris)");
    }
    // delete every existing list item + its link, then re-emit contiguously.
    for (const listItem of this.matchObjects(SCHEMA_ITEM_LIST_ELEMENT)) {
      for (const quad of [...this.dataset.match(listItem, undefined, undefined, undefined)]) {
        this.dataset.delete(quad);
      }
      this.dataset.delete(
        this.factory.quad(
          this as never,
          this.factory.namedNode(SCHEMA_ITEM_LIST_ELEMENT),
          listItem as never,
        ),
      );
    }
    // strip any flat track predicates so the ordered form is authoritative.
    for (const predicate of [SCHEMA_TRACK, MO_TRACK_PROP]) {
      for (const quad of [
        ...this.dataset.match(
          this as never,
          this.factory.namedNode(predicate),
          undefined,
          undefined,
        ),
      ]) {
        this.dataset.delete(quad);
      }
    }
    trackIris.forEach((iri, index) => {
      const listItem = this.factory.blankNode();
      this.dataset.add(
        this.factory.quad(
          this as never,
          this.factory.namedNode(SCHEMA_ITEM_LIST_ELEMENT),
          listItem,
        ),
      );
      const entry = new TermWrapper(listItem, this.dataset, this.factory);
      this.dataset.add(
        this.factory.quad(
          listItem,
          this.factory.namedNode(RDF_TYPE),
          this.factory.namedNode(SCHEMA_LIST_ITEM),
        ),
      );
      RequiredAs.object(entry, SCHEMA_POSITION, index + 1, LiteralFrom.integer);
      RequiredAs.object(entry, SCHEMA_ITEM, iri, NamedNodeFrom.string);
    });
    return this;
  }

  /** Append a track IRI to the end of the playlist (duplicates allowed). */
  addTrack(trackIri: string): this {
    requireNonEmpty(trackIri, "Playlist.addTrack(trackIri)");
    return this.setTracks([...this.tracks(), trackIri]);
  }

  /**
   * Remove the entry at the given 0-based index. A non-integer or out-of-range
   * index is a no-op (never a coerced removal of the wrong entry).
   */
  removeAt(index: number): this {
    const current = this.tracks();
    if (!Number.isInteger(index) || index < 0 || index >= current.length) {
      return this;
    }
    current.splice(index, 1);
    return this.setTracks(current);
  }

  stampType(): this {
    addType(this, MO_PLAYLIST);
    addType(this, SCHEMA_MUSIC_PLAYLIST);
    return this;
  }
}

/**
 * One listen event — schema:ListenAction. The pod-native listen-history record:
 * who (schema:agent) listened to what (schema:object → a Track IRI) and when
 * (schema:startTime / schema:endTime).
 */
export class ListenAction extends TermWrapper {
  get types(): Set<string> {
    return types(this);
  }

  /** schema:object — the IRI of the Track listened to. Required. */
  get trackIri(): string {
    return RequiredFrom.subjectPredicate(this, SCHEMA_OBJECT, NamedNodeAs.string);
  }
  set trackIri(value: string) {
    RequiredAs.object(
      this,
      SCHEMA_OBJECT,
      requireNonEmpty(value, "ListenAction.trackIri"),
      NamedNodeFrom.string,
    );
  }

  /** schema:agent — the WebID of the listener, if recorded. */
  get agent(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SCHEMA_AGENT, NamedNodeAs.string);
  }
  set agent(value: string | undefined) {
    OptionalAs.object(this, SCHEMA_AGENT, value, NamedNodeFrom.string);
  }

  /** schema:startTime — when the listen began. Required. */
  get startTime(): Date {
    return RequiredFrom.subjectPredicate(this, SCHEMA_START_TIME, LiteralAs.date);
  }
  set startTime(value: Date) {
    RequiredAs.object(this, SCHEMA_START_TIME, value, LiteralFrom.dateTime);
  }

  /** schema:endTime — when the listen finished, if known. */
  get endTime(): Date | undefined {
    return OptionalFrom.subjectPredicate(this, SCHEMA_END_TIME, LiteralAs.date);
  }
  set endTime(value: Date | undefined) {
    OptionalAs.object(this, SCHEMA_END_TIME, value, LiteralFrom.dateTime);
  }

  stampType(): this {
    addType(this, SCHEMA_LISTEN_ACTION);
    return this;
  }
}
