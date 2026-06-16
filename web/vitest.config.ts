// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Vitest config for the Pod Music static host. It MERGES the Vite build config
// (vite.config.ts) so the test run inherits the same resolve.alias (the local
// @jeswr/pod-music source + the single-React dedupe) and the `__APP_VERSION__`
// `define` the App reads — then layers the test-only settings on top.
//
// The environment is `jsdom` because the suite now has a COMPONENT test (the
// header FeedbackButton render) alongside the pure-logic tests. jsdom is a
// superset for the pure tests (they touch no conflicting DOM globals), so a
// single environment covers both. The setup file installs the jest-dom matchers
// + the `matchMedia` polyfill jsdom lacks (the app-shell ThemeProvider reads
// `prefers-color-scheme`).
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    },
  }),
);
