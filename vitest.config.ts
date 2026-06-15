// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @vitejs/plugin-react transpiles the .tsx view + its tests (JSX, the
  // react-jsx runtime). The data-layer tests are plain .ts and unaffected.
  plugins: [react()],
  test: {
    // Both the data-layer (.test.ts) and the React view (.test.tsx) suites.
    include: ["test/**/*.test.{ts,tsx}"],
    // Default to node (the data-layer tests need nothing else); the component
    // tests opt into jsdom per-file via a `// @vitest-environment jsdom`
    // docblock, so we never pay the jsdom cost for the pure-RDF suite.
    environment: "node",
    // Loaded once before the suite: @testing-library/jest-dom matchers
    // (toBeInTheDocument, …) + automatic React cleanup between tests.
    setupFiles: ["./test/setup-dom.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      // The federation Client-ID document and the public-vocab IRI table are
      // declarative data, not executable logic — they carry no branches to cover.
      exclude: ["src/index.ts", "src/vocab/iris.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
