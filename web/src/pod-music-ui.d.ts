// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Ambient typing for the @jeswr/pod-music modules the host consumes. Vite bundles
// the library's TS SOURCE directly (see vite.config.ts's alias), but tsc must NOT
// type-check the out-of-root library source (it is type-checked in its own
// package, against its own node_modules). So we declare ONLY the public surface
// the host imports — kept in lock-step with the real exports in
// ../src/ui/index.ts (`MusicLibrary` / `MusicLibraryProps`) and ../src/index.ts
// (`MusicStore`). If those signatures change, update this declaration in the same
// change (the skill/maintenance rule).

declare module "@jeswr/pod-music/ui" {
  import type { JSX } from "react";

  /** Props for {@link MusicLibrary} — mirrors ../src/ui/MusicLibrary.tsx. */
  export interface MusicLibraryProps {
    /**
     * The pod-music container base (MUST be the music base, e.g.
     * `https://alice.example/music/`). The per-class containers
     * (`tracks/`, `albums/`, `playlists/`) are derived from it.
     */
    base: string;
    /**
     * The authenticated fetch for pod reads. Omit to use the ambient global fetch
     * (patched by @solid/reactive-authentication in a real session).
     */
    fetch?: typeof fetch;
    /** The section to open first. Defaults to `"tracks"`. */
    initialKind?: "tracks" | "albums" | "playlists";
    /** Optional heading rendered above the listing. */
    title?: string;
  }

  export function MusicLibrary(props: MusicLibraryProps): JSX.Element;
}

declare module "@jeswr/pod-music" {
  /**
   * The pod I/O layer for Pod Music. The host uses ONLY its Type-Index discovery
   * helper (`findTrackContainers`) + the constructor; the full surface is declared
   * in the library's own package. Mirrors ../src/lib/store.ts.
   */
  export class MusicStore {
    constructor(options: { base: string; fetch?: typeof fetch });
    /**
     * Read the public type index off a WebID profile and return the container
     * IRIs registered for mo:Track. Empty when no profile link or no registration.
     */
    findTrackContainers(webId: string): Promise<string[]>;
  }
}
