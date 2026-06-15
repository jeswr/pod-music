// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// The IRI table for Pod Music's RDF model. Two complementary vocabularies:
//
//   * Music Ontology (mo:)  — http://purl.org/ontology/mo/  — the domain-native
//     vocabulary for tracks / records / artists / playlists.
//   * schema.org (schema:)  — http://schema.org/            — cross-app
//     interop terms, esp. schema:MusicRecording and schema:ListenAction (the
//     listen-history model, mirroring the Activity-Streams "consume" pattern).
//
// Plus the standard support vocabularies (rdf:, rdfs:, xsd:, dcterms:, foaf:,
// ldp:, solid:) and the federation vocabulary (fedapp:) for the Client-ID doc.
//
// This file is a flat data table — no executable logic — so it is excluded from
// the coverage gate. Every IRI is referenced by the typed wrappers, which ARE
// fully covered; we never hand-concatenate these strings into triples.

export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#" as const;
export const RDFS = "http://www.w3.org/2000/01/rdf-schema#" as const;
export const XSD = "http://www.w3.org/2001/XMLSchema#" as const;
export const DCTERMS = "http://purl.org/dc/terms/" as const;
export const FOAF = "http://xmlns.com/foaf/0.1/" as const;
export const LDP = "http://www.w3.org/ns/ldp#" as const;
export const SOLID = "http://www.w3.org/ns/solid/terms#" as const;
export const ACL = "http://www.w3.org/ns/auth/acl#" as const;
export const MO = "http://purl.org/ontology/mo/" as const;
export const SCHEMA = "http://schema.org/" as const;
export const FEDAPP = "https://w3id.org/jeswr/fed#" as const;
export const SECTORS = "https://w3id.org/jeswr/sectors/" as const;

// --- rdf / rdfs / dcterms ---
export const RDF_TYPE = `${RDF}type` as const;
export const RDFS_LABEL = `${RDFS}label` as const;
export const DCTERMS_TITLE = `${DCTERMS}title` as const;
export const DCTERMS_CREATED = `${DCTERMS}created` as const;
export const DCTERMS_DATE = `${DCTERMS}date` as const;

// --- Music Ontology classes ---
export const MO_TRACK = `${MO}Track` as const;
export const MO_RECORD = `${MO}Record` as const;
export const MO_MUSIC_ARTIST = `${MO}MusicArtist` as const;
export const MO_PLAYLIST = `${MO}Playlist` as const;

// --- Music Ontology properties ---
export const MO_TRACK_NUMBER = `${MO}track_number` as const;
export const MO_TRACK_PROP = `${MO}track` as const;
export const MO_DURATION = `${MO}duration` as const;

// --- schema.org classes ---
export const SCHEMA_MUSIC_RECORDING = `${SCHEMA}MusicRecording` as const;
export const SCHEMA_MUSIC_ALBUM = `${SCHEMA}MusicAlbum` as const;
export const SCHEMA_MUSIC_GROUP = `${SCHEMA}MusicGroup` as const;
export const SCHEMA_MUSIC_PLAYLIST = `${SCHEMA}MusicPlaylist` as const;
export const SCHEMA_LISTEN_ACTION = `${SCHEMA}ListenAction` as const;

// --- schema.org properties ---
export const SCHEMA_NAME = `${SCHEMA}name` as const;
export const SCHEMA_BY_ARTIST = `${SCHEMA}byArtist` as const;
export const SCHEMA_IN_ALBUM = `${SCHEMA}inAlbum` as const;
export const SCHEMA_DURATION = `${SCHEMA}duration` as const;
export const SCHEMA_TRACK = `${SCHEMA}track` as const;
export const SCHEMA_NUM_TRACKS = `${SCHEMA}numTracks` as const;
export const SCHEMA_ITEM_LIST_ELEMENT = `${SCHEMA}itemListElement` as const;
export const SCHEMA_LIST_ITEM = `${SCHEMA}ListItem` as const;
export const SCHEMA_POSITION = `${SCHEMA}position` as const;
export const SCHEMA_ITEM = `${SCHEMA}item` as const;
export const SCHEMA_OBJECT = `${SCHEMA}object` as const;
export const SCHEMA_AGENT = `${SCHEMA}agent` as const;
export const SCHEMA_START_TIME = `${SCHEMA}startTime` as const;
export const SCHEMA_END_TIME = `${SCHEMA}endTime` as const;
export const SCHEMA_DATE_PUBLISHED = `${SCHEMA}datePublished` as const;

// --- Solid type-index ---
export const SOLID_PUBLIC_TYPE_INDEX = `${SOLID}publicTypeIndex` as const;
export const SOLID_PRIVATE_TYPE_INDEX = `${SOLID}privateTypeIndex` as const;
export const SOLID_TYPE_INDEX = `${SOLID}TypeIndex` as const;
export const SOLID_LISTED_DOCUMENT = `${SOLID}ListedDocument` as const;
export const SOLID_UNLISTED_DOCUMENT = `${SOLID}UnlistedDocument` as const;
export const SOLID_TYPE_REGISTRATION = `${SOLID}TypeRegistration` as const;
export const SOLID_FOR_CLASS = `${SOLID}forClass` as const;
export const SOLID_INSTANCE = `${SOLID}instance` as const;
export const SOLID_INSTANCE_CONTAINER = `${SOLID}instanceContainer` as const;

// --- LDP container listing ---
export const LDP_CONTAINS = `${LDP}contains` as const;

// --- federation ---
export const FEDAPP_APP = `${FEDAPP}App` as const;
export const FEDAPP_SECTOR = `${FEDAPP}sector` as const;
export const FEDAPP_ACCESS = `${FEDAPP}access` as const;
export const FEDAPP_CONSUMES = `${FEDAPP}consumes` as const;
export const FEDAPP_PRODUCES = `${FEDAPP}produces` as const;
export const SECTOR_MEDIA = `${SECTORS}media#sector` as const;
export const ACL_READ = `${ACL}Read` as const;
export const ACL_WRITE = `${ACL}Write` as const;
export const ACL_APPEND = `${ACL}Append` as const;
