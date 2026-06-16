// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Vite config for the Pod Music static host shell. It bundles the LOCAL
// `@jeswr/pod-music/ui` React source directly (no pre-built dist/ui needed —
// Vite/esbuild compile the TS source on the fly), wraps it in a standalone Solid
// login, and emits a fully static `dist/` (index.html + clientid.jsonld +
// callback.html + hashed assets) servable by any file server (Caddy file_server).
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// BUILD VERSION for the header FeedbackButton's diagnostics block. Prefer the
// short git SHA (so a filed issue pins the exact deployed commit); fall back to
// the package version when git is unavailable (e.g. a tarball build). Resolved at
// CONFIG-eval time and injected via `define` as a string literal, so the bundle
// carries it with no runtime git/process access. `git` failures are swallowed —
// the version is diagnostic-only and must never break the build.
const buildVersion = (() => {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.npm_package_version ?? "dev";
  }
})();

// Resolve the @jeswr/pod-music library to its LOCAL TypeScript SOURCE, so Vite
// compiles `../src/ui` (and the data-layer core) directly — no pre-built dist/ui
// is needed, and the host always tracks the library's current source. The source
// uses NodeNext-style `.js` extension imports (e.g. `./format.js`); Vite's
// resolver maps those to the sibling `.ts` files when bundling.
const podMusicSrc = (rel: string) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));

// The library SOURCE lives OUTSIDE web/ (in ../src), so when Rollup bundles it,
// its bare imports (@jeswr/fetch-rdf, @solid/object, n3, …) would resolve against
// ../src's nearest node_modules — which doesn't exist. Pin those runtime deps to
// THIS host's node_modules so the out-of-root source resolves them.
const hostModule = (pkg: string) =>
  fileURLToPath(new URL(`./node_modules/${pkg}`, import.meta.url));

export default defineConfig({
  // tailwindcss() compiles the `@import "tailwindcss"` + the app-shell `@theme`
  // mapping in src/styles.css; react() compiles JSX (host + bundled library).
  plugins: [tailwindcss(), react()],
  // Inject the build version as a compile-time string literal for the header
  // FeedbackButton (see App.tsx — read via `__APP_VERSION__`, declared in
  // src/vite-env.d.ts). A bare JSON.stringify makes it a literal in the bundle.
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
  resolve: {
    // Order matters: the more specific "/ui" subpath alias must precede the
    // bare-package alias so it is matched first. The trailing-slash forms pin the
    // library's runtime deps (imported from the out-of-root source) to web/.
    alias: [
      { find: "@jeswr/pod-music/ui", replacement: podMusicSrc("ui/index.ts") },
      { find: "@jeswr/pod-music", replacement: podMusicSrc("index.ts") },
      { find: "@jeswr/fetch-rdf", replacement: hostModule("@jeswr/fetch-rdf") },
      { find: "@solid/object", replacement: hostModule("@solid/object") },
      { find: "@rdfjs/wrapper", replacement: hostModule("@rdfjs/wrapper") },
      { find: "n3", replacement: hostModule("n3") },
      // The library declares React as an OPTIONAL peer dep; bundling its source
      // from out-of-root, Vite would otherwise stub React out. Pin react/react-dom
      // (and their subpaths, e.g. react/jsx-runtime) to the host's single copy.
      { find: /^react$/, replacement: hostModule("react") },
      { find: /^react\//, replacement: `${hostModule("react")}/` },
      { find: /^react-dom$/, replacement: hostModule("react-dom") },
      { find: /^react-dom\//, replacement: `${hostModule("react-dom")}/` },
    ],
    // Guarantee a single React instance across the host + the bundled library +
    // the @jeswr/app-shell package. app-shell is a PUBLISHED dep
    // (github:jeswr/app-shell#main, committed dist/) — but a package can still
    // resolve react/react-dom + Radix/lucide against its OWN nested node_modules,
    // pulling a SECOND copy (invalid-hook-call). Deduping these forces ONE copy
    // from the host's node_modules (where they are installed as direct deps).
    // react/react-dom are also alias-pinned above for the bundled library.
    dedupe: [
      "react",
      "react-dom",
      "@radix-ui/react-avatar",
      "@radix-ui/react-dropdown-menu",
      "lucide-react",
    ],
  },
  // Let Vite read the library source one directory up from the host root. The
  // @jeswr/app-shell package is a normal node_modules install (published github
  // dep) so it is inside the default fs allow-list; the parent-dir allowance
  // below remains for the out-of-root pod-music source.
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  // `base: "./"` makes the built asset URLs relative, so the static bundle works
  // when served from a domain root (the per-subdomain deploy) without rewriting.
  base: "./",
  build: {
    outDir: "dist",
    // Surface oversized bundles in CI without failing the build.
    chunkSizeWarningLimit: 1500,
  },
});
