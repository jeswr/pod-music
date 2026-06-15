# Pod Music

> ⚠️ Experimental — AI-agent-generated (Claude Opus 4.8, @jeswr PSS agent); under active development, not production-hardened.

A [Solid](https://solidproject.org/) app for your music library — tracks, albums,
artists, playlists and listen-history — stored entirely in **your own pod**. Pod
Music owns no data: it reads and writes RDF in the pod you point it at, so your
library is yours, portable, and legible to any other Solid app that speaks the
same vocabularies.

This repository currently contains the **data layer** — the non-throwaway core
that every later surface (UI, sync, recommendations) is built on. The full
Next.js UI is a deliberate, tracked follow-up (see below).

## The data model

Pod Music models the music domain over two complementary, widely-deployed
vocabularies, so the data is legible to both music-native and general-purpose
consumers:

- **Music Ontology** (`mo:`, <http://purl.org/ontology/mo/>) — `mo:Track`,
  `mo:Record`, `mo:MusicArtist`, `mo:Playlist`, `mo:duration`, `mo:track_number`.
- **schema.org** (`schema:`, <http://schema.org/>) — `schema:MusicRecording`,
  `schema:MusicAlbum`, `schema:MusicGroup`, `schema:MusicPlaylist`, and crucially
  `schema:ListenAction` for the **listen-history** record (who listened to what,
  when).

Every entity is dual-typed (e.g. a track is both `mo:Track` and
`schema:MusicRecording`). The model is a set of **typed accessors over quads** —
read, write, and list — pod-shaped: resources live in per-class containers
(`tracks/`, `albums/`, `artists/`, `playlists/`, `listens/`) under a pod base,
and the app registers its primary class (`mo:Track`) in the Solid **type index**
so other apps can discover your library.

### How it is built (the house RDF stack)

This package never ships a bespoke RDF parser. It uses the
[`jeswr/solid-ai-coding`](https://github.com/jeswr/solid-ai-coding) library stack:

- [`@jeswr/fetch-rdf`](https://www.npmjs.com/package/@jeswr/fetch-rdf) — fetch +
  parse RDF from the pod (one GET, content-type-dispatched parse, ETag for
  conditional writes).
- [`@rdfjs/wrapper`](https://www.npmjs.com/package/@rdfjs/wrapper) — typed
  accessors over the dataset. **Triples are never hand-built**; cardinality and
  datatype coercion go through the typed mappers.
- [`@solid/object`](https://www.npmjs.com/package/@solid/object) — the reference
  typed wrappers for Solid data (profiles, containers, ACLs).
- [`n3`](https://www.npmjs.com/package/n3) `Writer` — serialise back to Turtle.

## Usage sketch

```ts
import { MusicStore } from "@jeswr/pod-music";

const store = new MusicStore({ base: "https://alice.example/music/" });
//                     ^ pass an authenticated `fetch` (e.g. from
//                       @solid/reactive-authentication) for protected pods.

// write a track
const track = store.newTrack(`${store.layout.tracks}arabesque`);
track.title = "Arabesque No. 1";
track.artist = `${store.layout.artists}debussy`;
track.durationSeconds = 270;
await store.putTrack(track);

// record a listen
const listen = store.newListen(`${store.layout.listens}${crypto.randomUUID()}`);
listen.trackIri = track.value;
listen.startTime = new Date();
await store.putListen(listen);

// list the library
const trackIris = await store.listTracks();

// register mo:Track in the public type index (create-and-link is the caller's job)
const index = store.buildTrackRegistration(`${store.layout.tracks}../settings/publicTypeIndex.ttl`);
```

Reads map WAC outcomes to typed errors — a `401`/`403` becomes `AccessDeniedError`
(a discovery hint is never silently swallowed), a `404` becomes
`ResourceNotFoundError`. Writes are conditional `PUT`s with `If-Match` when you
pass the resource's ETag.

## Federation

Pod Music ships a Client Identifier Document at
[`public/clientid.jsonld`](./public/clientid.jsonld) that publishes the
`fedapp:` block from <https://w3id.org/jeswr/fed> — declaring it as a **media**-sector
`fedapp:App` that produces/consumes the music classes above and requests
`acl:Read` / `acl:Write` / `acl:Append`. This makes the app
**federation-registry-ready**: once the federation registry runs a signed
challenge, Pod Music can be enrolled without re-describing itself. (Membership is
the registry's job — the document only describes intent.)

## Gate

```bash
npm run gate   # lint (biome) + typecheck (tsc) + test (vitest, 100% coverage) + build (tsc)
```

The data layer carries **100% unit-test coverage** (round-trip RDF, edge cases,
the type-index registration, WAC-aware reads + error mapping), enforced by a
coverage threshold gate.

## Tracked follow-ups

These are deliberate next steps, tracked outside this README:

- **UI + app scaffold** — the full Next.js UI, built via `create-solid-app`
  once that bootstrap command lands (it will bake in the suite new-repo
  checklist). This repo deliberately ships the data layer that survives, not a
  throwaway hand-rolled app shell.
- **Cross-server E2E matrix** — Playwright end-to-end against the well-known
  Solid servers, including **prod-solid-server** with both **passkey** and
  **username/password** login, plus CSS / ESS.
- **Coverage ratchet** — a CI ratchet that keeps coverage at 100% against every
  well-known server target as the matrix grows.
- **Sector-vocab ADR** — if the `media` sector definition under
  <https://w3id.org/jeswr/sectors/> needs to be frozen/extended for Pod Music's
  shapes, that is a federation-vocab ADR.

## Provenance

Authored by **Claude Opus 4.8** (the @jeswr PSS agent) while Fable is
unavailable — every source file carries an `AUTHORED-BY` marker and commits carry
the Opus-4.8 provenance trailers, so this code can be targeted for re-review /
upgrade when Fable returns.

## License

MIT.
