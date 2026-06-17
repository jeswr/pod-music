// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// CSS-ISOLATION REGRESSION GUARD (#80 / solid-elements rollout #67/#68/#70).
//
// pod-music's host chrome uses a BARE global `button {}` filled rule + a direct
// re-alias of the host's `--accent` / `--muted` onto the app-shell tokens — the SIMPLE
// form, safe because @jeswr/app-shell #80 made the shell SELF-ISOLATING. (Unlike the
// pod-mail pilot, pod-music never carried the hand-scoped early-adopter workaround, so
// there was nothing to relax — this test pins WHY the simple form is safe so a future
// app-shell bump that regressed the isolation would be caught here, not in production.)
//
//   1. Every app-shell control the host renders (the FeedbackButton trigger + every
//      control in its portaled dialog) carries `data-app-shell-control`. That is the
//      hook the package's UNLAYERED reset uses to out-rank a host's bare `button {}`
//      (an attribute selector beats a bare element selector), so the host's filled
//      look can no longer leak onto them.
//   2. The dialog is portaled to <body> (outside `.app-shell` / `.login-form`), which
//      is exactly the surface the old hand-scoping was needed to protect.
//
// (We assert the data-attribute contract rather than computed styles because jsdom
// does not run the cascade; the contract is what the unlayered reset keys off, and
// app-shell's own suite tests the cascade math. The real-browser render is verified
// at runtime in the rollout.)
import { AccountMenu, FeedbackButton, ThemeProvider, ThemeToggle } from "@jeswr/app-shell";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("app-shell CSS isolation survives pod-music's bare button {} (#80)", () => {
  it("every header control App renders is isolation-tagged", () => {
    // Render the SAME app-shell header trio App.tsx mounts (FeedbackButton +
    // ThemeToggle + AccountMenu), so the guard covers ALL the chrome the bare
    // `button {}` could leak onto — not just the FeedbackButton. A future app-shell
    // bump that dropped `data-app-shell-control` from ANY of these would fail here.
    const { container } = render(
      // ThemeProvider wraps the trio exactly as main.tsx does (ThemeToggle reads
      // the theme context). matchMedia is polyfilled in test/setup.ts.
      <ThemeProvider>
        <FeedbackButton repo="jeswr/pod-music" appName="Pod Music" appVersion="testsha" />
        <ThemeToggle />
        <AccountMenu
          webId="https://alice.example/profile/card#me"
          displayName="Alice"
          onSignOut={() => {}}
        />
      </ThemeProvider>,
    );
    const buttons = container.querySelectorAll("button");
    // The trio renders at least three trigger buttons.
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    // EVERY app-shell button in the header must opt into the unlayered reset, so a
    // host `button {}` cannot repaint any of them.
    for (const btn of buttons) {
      expect(btn).toHaveAttribute("data-app-shell-control");
    }
    // And specifically the FeedbackButton trigger (the one whose dialog we open below).
    expect(screen.getByRole("button", { name: /feedback/i })).toHaveAttribute(
      "data-app-shell-control",
    );
  });

  it("every control in the portaled feedback dialog is isolation-tagged", async () => {
    render(<FeedbackButton repo="jeswr/pod-music" appName="Pod Music" />);
    fireEvent.click(screen.getByRole("button", { name: /feedback/i }));
    const dialog = await screen.findByRole("dialog");
    // Collect the dialog's interactive controls — the surface the bare `button {}`
    // historically leaked onto (the dialog is portaled to <body>, outside .app-shell).
    const controls = within(dialog).getAllByRole("button");
    expect(controls.length).toBeGreaterThan(0);
    // EVERY button in the dialog must be isolation-tagged, so none can be repainted
    // by the host's unlayered filled `button {}` rule.
    for (const btn of controls) {
      expect(btn).toHaveAttribute("data-app-shell-control");
    }
  });
});
