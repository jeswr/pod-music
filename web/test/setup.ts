// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Vitest setup for the jsdom-environment runs: jest-dom matchers + a jsdom
// `matchMedia` polyfill (jsdom ships none, and the @jeswr/app-shell ThemeProvider
// — mounted by the App under test — reads `prefers-color-scheme`). Mirrors the
// app-shell package's own setup so the component test behaves identically.
import "@testing-library/jest-dom/vitest";

// Install a matchMedia stub (default: light OS preference). The FeedbackButton
// render test does not depend on the scheme; this just stops the ThemeProvider
// from throwing on a missing matchMedia.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
