// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Vitest setup: register @testing-library/jest-dom matchers and auto-unmount
// React trees between tests. This file runs for every suite, but its DOM work
// is a no-op for the node-environment data-layer tests (no `document`), so the
// pure-RDF suite is unaffected.

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  // Only the jsdom (component) suites have a document to clean up; guard so the
  // node suites — which never render — skip it.
  if (typeof document !== "undefined") {
    cleanup();
  }
});
