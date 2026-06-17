// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Playwright config for the Pod Music static host's e2e layer. The first (and
// currently only) suite is the task #123 401-BUDGET test: it proves the @jeswr/
// solid-elements proactive auth-fetch (which REPLACED the raw ReactiveFetchManager)
// attaches the DPoP token UP FRONT — so a library of N track resources pays ZERO
// wasted 401s, never the per-resource 401-dance. (pod-music's MusicLibrary reads
// EACH track resource individually after listing the container, so N tracks =>
// N+1 reads — a stronger regression surface than a flat container listing.)
//
// TWO webServers (the solid-test-infrastructure harness pattern):
//   • CSS@7 on :3000 — it MUST own :3000 (the Solid issuer is keyed to that origin),
//     in-memory + WAC. ~13s to boot, so ONE instance per suite (never per test).
//   • the Vite host on :5173 — vite's default port, which is ALSO the dev clientid
//     origin (`scripts/gen-clientid.mjs` DEV_DEFAULT = http://localhost:5173), so the
//     generated `clientid.jsonld` / `callback.html` match the served origin with no
//     APP_ORIGIN override needed.
//
// LOCAL-ONLY: this NEVER targets the live deploy (solid-test.jeswr.org). All auth +
// reads run against the local CSS — per the suite rule that app e2e runs against a
// LOCAL Solid server.
//
// HOW TO RUN (documented for the orchestrator / a sibling-app port):
//   cd web
//   npx playwright install chromium   # one-time: fetch the browser
//   npx playwright test               # boots CSS + vite, seeds the pod, runs the spec
// The webServers boot on demand; `reuseExistingServer` (non-CI) reuses an already-running
// CSS/vite so local iteration skips the ~13s CSS boot.
import { defineConfig, devices } from "@playwright/test";

const CSS_PORT = 3000;
// The Vite dev server default port — and the dev clientid origin
// (scripts/gen-clientid.mjs DEV_DEFAULT), so the served origin matches its clientid.
const APP_PORT = 5173;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  // The 401-budget spec drives a real OIDC popup login + a library listing, so it
  // needs a generous ceiling (CSS round-trips + the popup dance).
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  globalSetup: "./tests/e2e/global-setup.ts",
  webServer: [
    {
      // In-memory WAC CSS, pinned to an EXACT 7.x patch (the suite-standard local Solid
      // server). Pinning the exact version — not the floating `@7` major — makes the e2e
      // REPRODUCIBLE: a new CSS patch release can't silently change behaviour without a
      // repo change (the roborev LOW finding). We deliberately keep `npx` (not a declared
      // devDependency): CSS pulls ~635 packages, so vendoring it into every pod-app's
      // node_modules would balloon disk for an e2e-only, ephemeral server — the suite's
      // disk-hygiene rule. `npx` caches it in the shared npm cache after first fetch.
      // reuseExistingServer:false ALWAYS — global-setup seeds a FIXED `alice` account/pod,
      // so a reused (stateful) CSS from a prior run would make the second pod-create 4xx.
      // A fresh in-memory CSS per run guarantees clean state locally AND in CI; the ~13s
      // boot is paid once per `playwright test` invocation.
      command: `npx -y @solid/community-server@7.1.9 -p ${CSS_PORT}`,
      url: `http://localhost:${CSS_PORT}/`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // The Vite host. `npm run dev` runs gen-clientid (dev default origin = :5173)
      // then `vite`. `--strictPort` so a port clash fails loudly rather than silently
      // moving the app off the clientid origin.
      command: `npm run dev -- --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
