// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Public barrel for the Pod Music React view layer (`@jeswr/pod-music/ui`).
//
// This is the OPTIONAL, React-only surface: a framework-agnostic music-library
// component + its data hook, sitting on top of the React-free data-layer core
// (`@jeswr/pod-music`). React is a *peer* dependency so a data-layer-only
// consumer never pulls it in. The view never touches RDF/fetch directly — it
// drives the data layer (MusicStore) through `useMusicLibrary`, and takes the
// authenticated fetch as an injected seam (post-#18 the create-solid-app shell
// patches the global fetch; until then a stub fetch makes it unit-testable
// today — see useMusicLibrary.ts).

export {
  errorMessage,
  formatDate,
  formatDuration,
  isSafeHref,
} from "./format.js";
export {
  containerForKind,
  ensureTrailingSlash,
  iriTail,
  isAccessDenied,
  isSafeContainedIri,
  kindLabel,
  LIBRARY_KINDS,
  type LibraryItem,
  type LibraryKind,
  loadLibrary,
} from "./library.js";
export { MusicLibrary, type MusicLibraryProps } from "./MusicLibrary.js";
export {
  type MusicLibraryState,
  type UseMusicLibraryOptions,
  useMusicLibrary,
} from "./useMusicLibrary.js";
