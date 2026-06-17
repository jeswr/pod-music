// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Pins the @jeswr/solid-elements adoption (#67/#68/#70 D-parity rollout): the host
// shell consumes the framework-agnostic W3C Web Components through the `./react`
// (@lit/react) adapter. This is the thin "the integration mechanics work" test for
// the adoption — it proves the @lit/react wrapper:
//   1. is importable + typed from `@jeswr/solid-elements/react`;
//   2. mounts in a DOM (the Lit custom element upgrades + renders a shadow root);
//   3. carries the app-shell theming-token-inheritance chain in its shadow styles
//      (`--jeswr-*` → app-shell `--primary` / `--border` / `--muted-foreground`),
//      so it follows the host's light/dark theme with no extra wiring.
//
// LABEL RENDERING (FIXED in solid-elements df0fbe4 / #122): the host shell renders
// the contextual wait text via `<Loading label="Finding your music library…">`. At
// the earlier pin (#67/#68/#70, 6267458) `label` was a non-reflected reactive property,
// and @lit/react's wrapper classifies props at createComponent time (before Lit
// finalises the class) — so under React 19 the `label` could be dropped and the generic
// "Loading" fallback rendered instead of the contextual text. df0fbe4 makes `label`
// `reflect: true`: setting the property (what @lit/react does in a real browser) now
// REFLECTS to the host `label` attribute as well as rendering the shadow `part="label"`
// text, so the wrapper reliably forwards it.
//
// jsdom caveat (why we exercise the custom element directly here): @lit/react's adapter
// still does not set the `label` property through the React wrapper under React 19 +
// jsdom (it stays null — the createComponent-before-finalise classification is the same
// jsdom-only gap noted before), so we cannot assert the contextual label via
// `<Loading label>` in jsdom. We instead drive the underlying <jeswr-loading> element
// the way the adapter drives it IN A REAL BROWSER — set `label` as a property — and
// assert df0fbe4's reflection contract: the property reflects to the `label` ATTRIBUTE
// (null at 6267458, so this assertion genuinely FAILS without the fix) and renders as
// the contextual `part="label"` text + the status region's accessible label.
//
// The deeper component behaviour (prefers-reduced-motion, ::part theming) is
// exhaustively tested in @jeswr/solid-elements itself; this is the adoption-mechanics
// test for THIS app, mirroring feedback-button.test.tsx.
import "@jeswr/solid-elements";
import { Loading } from "@jeswr/solid-elements/react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("@jeswr/solid-elements <Loading> (pod-music adoption)", () => {
  it("is a real React component exported from the ./react adapter", () => {
    // The @lit/react createComponent wrapper is a truthy component.
    expect(Loading).toBeTruthy();
  });

  it("mounts the jeswr-loading custom element via the @lit/react adapter", async () => {
    const { container } = render(<Loading label="Finding your music library…" />);
    // The @lit/react adapter renders the registered custom element tag.
    const el = container.querySelector("jeswr-loading");
    expect(el).not.toBeNull();
    // The element upgrades: its class is registered + instantiated.
    await customElements.whenDefined("jeswr-loading");
    expect(customElements.get("jeswr-loading")).toBeTruthy();
    expect(el?.constructor.name).toBe("JeswrLoading");
  });

  it("reflects + renders the contextual `label` (df0fbe4 #122 reflection fix)", async () => {
    await customElements.whenDefined("jeswr-loading");
    // Drive <jeswr-loading> the way @lit/react drives it in a real browser: set the
    // `label` as a PROPERTY. (The React wrapper itself drops this under jsdom — see
    // the file header — so we exercise the element directly.)
    const el = document.createElement("jeswr-loading") as HTMLElement & { label?: string };
    el.label = "Finding your music library…";
    document.body.appendChild(el);
    // Let Lit's reactive update + reflection commit.
    await (el as unknown as { updateComplete?: Promise<unknown> }).updateComplete;
    try {
      // df0fbe4's `reflect: true` reflects the property to the host `label` ATTRIBUTE.
      // At the old pin (6267458, no `reflect`) this attribute stays null, so this
      // assertion genuinely fails without the fix.
      expect(el.getAttribute("label")).toBe("Finding your music library…");
      // The contextual text renders into the shadow `part="label"` span (not the
      // generic "Loading" fallback) AND becomes the status region's accessible label.
      const labelPart = el.shadowRoot?.querySelector('[part="label"]');
      expect(labelPart?.textContent).toBe("Finding your music library…");
      const status = el.shadowRoot?.querySelector('[role="status"]');
      expect(status?.getAttribute("aria-label")).toBe("Finding your music library…");
    } finally {
      el.remove();
    }
  });

  it("renders a themed shadow root that inherits the app-shell tokens", async () => {
    const { container } = render(<Loading label="Loading…" />);
    const el = container.querySelector("jeswr-loading") as HTMLElement | null;
    await customElements.whenDefined("jeswr-loading");
    // Let Lit's first async render commit.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The component renders into a shadow root (shadow-DOM encapsulation — this is
    // why a host's light-DOM `button {}` rule cannot leak into it).
    expect(el?.shadowRoot).toBeTruthy();
    const shadowCss = el?.shadowRoot?.textContent ?? "";
    // THE THEMING CONTRACT: the component's shadow styles read `--jeswr-*`, each of
    // which falls back through the shadow boundary to the app-shell shadcn token
    // (`--primary` / `--border` / `--muted-foreground`), then to an OKLCH literal.
    // So the host's `.dark`-flipped app-shell tokens reach the component for free.
    expect(shadowCss).toContain("--jeswr-primary: var(--primary");
    expect(shadowCss).toContain("--jeswr-border: var(--border");
    expect(shadowCss).toContain("--jeswr-muted-fg: var(--muted-foreground");
    // The spinner reads those inherited tokens for its colours.
    expect(shadowCss).toContain("var(--jeswr-primary)");
  });
});
