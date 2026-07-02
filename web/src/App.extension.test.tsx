// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Header behaviour for the extension duplicate-chrome fix (cross-app rollout of the
// pod-drive pattern, bead suite-tracker-lpo):
//   - extension ABSENT  → the full <AccountMenu/> (avatar + display name + WebID + Sign out).
//   - extension PRESENT → the duplicated profile display is dropped, BUT a Sign-out control is
//     kept so a logged-in user (the app still owns its OWN session until it consumes the
//     extension's identity) is NEVER stranded without a logout affordance.
import { ThemeProvider } from "@jeswr/app-shell";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mutable mock state, defined via vi.hoisted so it is safely available inside the
// hoisted vi.mock factories (avoids the top-level-closure hoisting footgun). The
// toggle is flipped per test; logout is asserted on.
const mocks = vi.hoisted(() => ({ extensionPresent: false, logout: vi.fn() }));

// The extension-presence hook lives in @jeswr/app-shell (useSolidExtensionPresent).
// Keep the real app-shell chrome components; override only the presence hook per test.
vi.mock("@jeswr/app-shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@jeswr/app-shell")>()),
  useSolidExtensionPresent: () => mocks.extensionPresent,
}));

vi.mock("./auth/SessionProvider", () => ({
  useSession: () => ({
    webId: "https://alice.example/profile/card#me",
    session: {
      podRoot: "https://alice.example/",
      podRootIsFallback: false,
      displayName: "Alice Music",
      avatarUrl: undefined,
    },
    logout: mocks.logout,
    autologinPending: false,
    restoring: false,
  }),
}));

// Stub the music base discovery so the header test resolves a base immediately
// without driving a live pod fetch.
vi.mock("./auth/session-derivation", () => ({
  discoverMusicBase: () =>
    Promise.resolve({ base: "https://alice.example/music/", isFallback: false }),
}));

// Stub the data layer + UI so mounting the App does not reach a live pod.
vi.mock("@jeswr/pod-music", () => ({
  MusicStore: class {},
}));
vi.mock("@jeswr/pod-music/ui", () => ({
  MusicLibrary: () => <div data-testid="music-library" />,
}));

import { App } from "./App";

function renderApp() {
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
}

afterEach(() => {
  mocks.extensionPresent = false;
  mocks.logout.mockReset();
});

describe("App header — extension duplicate-chrome fix (pod-music)", () => {
  it("extension ABSENT: renders the full AccountMenu", () => {
    mocks.extensionPresent = false;
    renderApp();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    // No lone Sign-out button — sign-out lives inside the AccountMenu dropdown.
    expect(screen.queryByRole("button", { name: /^sign out$/i })).not.toBeInTheDocument();
  });

  it("extension PRESENT: hides the AccountMenu but keeps a working Sign-out (no stranded logout)", () => {
    mocks.extensionPresent = true;
    renderApp();
    // The duplicated profile menu is gone…
    expect(screen.queryByRole("button", { name: "Account menu" })).not.toBeInTheDocument();
    // …but a Sign-out control remains and calls the app's own logout.
    const signOut = screen.getByRole("button", { name: /^sign out$/i });
    fireEvent.click(signOut);
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    // The rest of the header chrome (not duplicated by the extension) stays.
    expect(screen.getByRole("button", { name: /feedback/i })).toBeInTheDocument();
  });
});
