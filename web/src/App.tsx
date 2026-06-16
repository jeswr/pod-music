// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// App — the host shell's router-free root: logged out → <LoginScreen>; logged in
// → a thin header (WebID + logout) over the LOCAL @jeswr/pod-music <MusicLibrary>
// pointed at the user's music library container. The library receives NO `fetch`
// prop — it uses the ambient global fetch, which the SessionProvider patched via
// reactive-auth's registerGlobally(), so every read carries the DPoP token.
//
// MUSIC-BASE RESOLUTION: <MusicLibrary base /> needs the music library CONTAINER
// (the data layer derives `tracks/`/`albums/`/`playlists/` under it), not a bare
// pod root. So after login we resolve `base` via the data layer's Type-Index
// discovery (`MusicStore.findTrackContainers` → the parent of a registered
// `tracks/` container), falling back to the conventional `${podRoot}music/` and
// surfacing a banner when no registration is found (see session-derivation.ts).

import { MusicStore } from "@jeswr/pod-music";
import { MusicLibrary } from "@jeswr/pod-music/ui";
import { useEffect, useState } from "react";
import { useSession } from "./auth/SessionProvider";
import { discoverMusicBase, type MusicBase } from "./auth/session-derivation";
import { LoginScreen } from "./LoginScreen";

export function App() {
  const { webId, session, logout } = useSession();
  // The resolved music base + how it was discovered; null while resolving.
  const [musicBase, setMusicBase] = useState<MusicBase | null>(null);

  // Resolve the music library container once we have a session. The store's
  // `fetch` defaults to the global fetch (now auth-patched), so discovery reads
  // carry the DPoP token. Re-runs if the session changes (logout → re-login).
  useEffect(() => {
    if (!session) {
      setMusicBase(null);
      return;
    }
    let cancelled = false;
    // The store's own `base` is irrelevant to discovery (findTrackContainers reads
    // the type index off the WebID); seed it with the conventional path so the
    // constructor's container assertion passes.
    const store = new MusicStore({ base: `${session.podRoot}music/` });
    discoverMusicBase(store, session)
      .then((resolved) => {
        if (!cancelled) setMusicBase(resolved);
      })
      .catch(() => {
        // discoverMusicBase already falls back internally; this is belt-and-braces
        // so a thrown rejection can never strand the view with no base.
        if (!cancelled) {
          setMusicBase({ base: `${session.podRoot}music/`, isFallback: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!webId || !session) {
    return <LoginScreen />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-brand">Pod Music</span>
        <span className="app-webid" title={webId}>
          {webId}
        </span>
        <button type="button" className="app-logout" onClick={logout}>
          Log out
        </button>
      </header>
      {session.podRootIsFallback ? (
        <p className="app-note" role="note">
          Your profile advertises no <code>pim:storage</code>; using your WebID origin (
          <code>{session.podRoot}</code>) as the pod root.
        </p>
      ) : null}
      {musicBase?.isFallback ? (
        <p className="app-note" role="note">
          No <code>mo:Track</code> registration was found in your Type Index; using the conventional{" "}
          <code>{musicBase.base}</code> container.
        </p>
      ) : null}
      <main className="app-main">
        {musicBase ? (
          // base only — the data layer derives the per-class containers under it.
          // No fetch prop: the global fetch is auth-patched.
          <MusicLibrary base={musicBase.base} title="Your music library" />
        ) : (
          <p className="app-loading" role="status">
            Finding your music library…
          </p>
        )}
      </main>
    </div>
  );
}
