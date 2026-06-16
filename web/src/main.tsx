// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Client entry. Wraps the app in the SessionProvider (the one auth seam) and
// mounts into #root. There is NO SSR/prerender here — this is a pure static SPA —
// and the reactive-auth runtime is still loaded via a dynamic import inside the
// provider so the bundle has no top-level reactive-auth evaluation.
import { ThemeProvider } from "@jeswr/app-shell";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionProvider } from "./auth/SessionProvider";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    {/* ThemeProvider wraps everything (theme is session-independent, so it sits
        OUTSIDE the SessionProvider). It defaults to "system" and persists to
        localStorage key "app-shell-theme" — the SAME key the no-flash <script> in
        index.html reads, so the pre-paint class and the React state always agree.
        The `.dark` class it toggles on <html> drives both the app-shell components'
        `dark:` utilities and the host chrome (whose --bg/--ink/… aliases map onto
        the OKLCH tokens in styles.css). */}
    <ThemeProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </ThemeProvider>
  </StrictMode>,
);
