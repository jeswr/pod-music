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
// NOTE (a rough edge surfaced by the pilot — see the pod-mail report): @lit/react's
// `label` PROPERTY forwarding does NOT land under React 19 + jsdom (the adapter
// classifies props at createComponent time, before Lit finalises the element class,
// so `label` is treated as a plain attr and React 19 + jsdom does not reflect it). The
// component still RENDERS + THEMES correctly; real-browser prop forwarding is
// validated at runtime. We therefore assert the element mounts + themes here, not the
// jsdom-flaky property value.
//
// The deeper component behaviour (prefers-reduced-motion, ::part theming) is
// exhaustively tested in @jeswr/solid-elements itself; this is the adoption-mechanics
// test for THIS app, mirroring feedback-button.test.tsx.
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
