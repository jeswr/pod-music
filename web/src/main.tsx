// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Client entry. Wraps the app in the SessionProvider (the one auth seam) and
// mounts into #root. There is NO SSR/prerender here — this is a pure static SPA —
// and the reactive-auth runtime is still loaded via a dynamic import inside the
// provider so the bundle has no top-level reactive-auth evaluation.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionProvider } from "./auth/SessionProvider";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
