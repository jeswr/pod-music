// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// App — the host shell's router-free root: logged out → <LoginScreen>; logged in
// → a thin header (WebID + logout) over the LOCAL @jeswr/pod-music <MusicLibrary>
// pointed at the user's music library container. The library receives NO `fetch`
// prop — it uses the ambient global fetch, which the SessionProvider patched via
// the @jeswr/solid-elements PROACTIVE auth-fetch (task #123), so every read carries
// the DPoP token automatically AND up front (the token is attached on the FIRST
// request to the pod origin — no per-resource 401-dance; the library reads N track
// resources, which previously paid N+1 wasted 401s. See auth/SessionProvider.tsx).
//
// MUSIC-BASE RESOLUTION: <MusicLibrary base /> needs the music library CONTAINER
// (the data layer derives `tracks/`/`albums/`/`playlists/` under it), not a bare
// pod root. So after login we resolve `base` via the data layer's Type-Index
// discovery (`MusicStore.findTrackContainers` → the parent of a registered
// `tracks/` container), falling back to the conventional `${podRoot}music/` and
// surfacing a banner when no registration is found (see session-derivation.ts).

import { AccountMenu, FeedbackButton, ThemeToggle } from "@jeswr/app-shell";
import { MusicStore } from "@jeswr/pod-music";
import { MusicLibrary } from "@jeswr/pod-music/ui";
// SOLID-ELEMENTS (#67/#68/#70 D-parity rollout): the framework-agnostic W3C Web
// Components consumed through the `./react` (@lit/react) adapter. <Loading> is a Lit
// custom element (spinner + polite-live label, prefers-reduced-motion aware) wrapped
// by @lit/react's createComponent. It themes itself from the SAME app-shell OKLCH
// tokens as the rest of the chrome: its shadow-DOM styles read `--jeswr-*`, which fall
// back through the shadow boundary to app-shell's `--primary` / `--border` /
// `--muted-foreground` (set by styles.css and flipped by the `.dark` class), so it
// follows light/dark for free with no extra wiring. (COMPLEMENTS app-shell — it does
// not replace the React chrome components above.) Plain Vite/CSR React has no SSR step,
// so the client-only custom elements need no mount-gating here.
import { Loading } from "@jeswr/solid-elements/react";
import { useEffect, useState } from "react";
import { useSession } from "./auth/SessionProvider";
import { discoverMusicBase, type MusicBase } from "./auth/session-derivation";
import { LoginScreen } from "./LoginScreen";

export function App() {
  const { webId, session, logout, autologinPending, restoring } = useSession();
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
    // Autologin (a Pod-Manager deep-link or a redirect return) is silently signing
    // the user in via a full-page redirect — show a brief restoring state rather than
    // the interactive login form, since there is no gesture to prompt for.
    if (autologinPending) {
      return (
        <main className="login-screen" aria-busy="true">
          <section className="login-card">
            <h1>Pod Music</h1>
            {/* SOLID-ELEMENTS: the <jeswr-loading> spinner + label (via @lit/react).
                It carries its own role="status" + aria-live, so the label is
                announced; we keep the .login-sub wrapper only for the existing
                spacing/typography. */}
            <p className="login-sub">
              <Loading label="Signing you in…" />
            </p>
          </section>
        </main>
      );
    }
    // SILENT SESSION RESTORE in flight (cross-app UX invariant #1): a returning user's
    // persisted DPoP-bound refresh token is being redeemed (no popup). Show a brief
    // "Restoring…" state rather than flashing the login form; we fall through to
    // <LoginScreen/> only once the restore resolves (and finds nothing to restore).
    if (restoring) {
      return (
        <main className="login-screen" aria-busy="true">
          <section className="login-card">
            <h1>Pod Music</h1>
            <p className="login-sub">
              <Loading label="Restoring your session…" />
            </p>
          </section>
        </main>
      );
    }
    return <LoginScreen />;
  }

  return (
    <div className="app-shell">
      {/* The header uses the shared @jeswr/app-shell chrome: a header-level
          <FeedbackButton/> (opens a themed dialog that files a GitHub issue against
          THIS app's own repo), a light/dark/system <ThemeToggle/>, and a real
          top-right <AccountMenu/> (avatar + display name, dropdown showing the WebID
          + Sign out) — replacing the old raw-WebID span + bare logout button. The
          session's WebID / profile name / avatar / logout wire straight into the
          props (the components are fully decoupled — everything is a prop).
          `app-header-actions` right-aligns the trio.

          FEEDBACK: `repo` is the only app-specific value — pod-music files against
          `jeswr/pod-music`. `appVersion` is the build SHA injected by Vite
          (`__APP_VERSION__`), so a filed issue pins the deployed commit. `webId` is
          attached to diagnostics ONLY if the reporter ticks the consent box. `submit`
          is intentionally UNSET → the dialog uses the GitHub prefill page; the
          feedback-proxy hook is wired suite-wide later. */}
      <header className="app-header">
        <span className="app-brand">Pod Music</span>
        <div className="app-header-actions">
          <FeedbackButton
            repo="jeswr/pod-music"
            appName="Pod Music"
            appVersion={__APP_VERSION__}
            webId={webId}
          />
          <ThemeToggle />
          <AccountMenu
            webId={webId}
            displayName={session.displayName}
            avatarUrl={session.avatarUrl}
            onSignOut={logout}
          />
        </div>
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
          // SOLID-ELEMENTS: the host-level "finding your library" wait, now the themed
          // <jeswr-loading> spinner (via @lit/react) instead of a bare <p>. It owns
          // role="status" + aria-live; .app-loading keeps the muted colour wrapper for
          // layout parity.
          <p className="app-loading">
            <Loading label="Finding your music library…" />
          </p>
        )}
      </main>
    </div>
  );
}
