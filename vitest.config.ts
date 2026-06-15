import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      include: ["src/**/*.ts"],
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
