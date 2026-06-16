// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// LoginScreen — the logged-out entry. WebID-first (the reactive-auth UX spec):
// ONE input, the user's WebID URL. No identity-provider dropdown — the issuer is
// resolved from the WebID profile. Errors bubble up from the session layer.
import { type FormEvent, useState } from "react";
import { useSession } from "./auth/SessionProvider";

const HOME_IDP = import.meta.env.VITE_HOME_IDP ?? "https://idp.solid-test.jeswr.org";

export function LoginScreen() {
  const { login, loggingIn, error, ready } = useSession();
  const [webIdInput, setWebIdInput] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const id = webIdInput.trim();
    if (!id) return;
    try {
      await login(id);
    } catch {
      // The error is already surfaced via the session context's `error`.
    }
  }

  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <h1 id="login-title">Pod Music</h1>
        <p className="login-sub">
          Browse the music library in your Solid pod — tracks, albums and playlists. Enter your
          WebID — the URL that identifies you across Solid.
        </p>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="webid-input">WebID</label>
          <input
            id="webid-input"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://you.solid-test.jeswr.org/profile/card#me"
            value={webIdInput}
            onChange={(ev) => setWebIdInput(ev.target.value)}
            disabled={loggingIn}
          />
          <button type="submit" disabled={loggingIn || !ready || !webIdInput.trim()}>
            {loggingIn ? "Logging in…" : ready ? "Log in" : "Loading…"}
          </button>
        </form>
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="login-hint">
          New to Solid? Get a pod and WebID from{" "}
          <a href={HOME_IDP} target="_blank" rel="noopener noreferrer">
            {new URL(HOME_IDP).host}
          </a>
          .
        </p>
      </section>
    </main>
  );
}
