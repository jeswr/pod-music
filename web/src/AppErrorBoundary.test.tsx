// AUTHORED-BY Claude Fable 5
//
// Pins the crash-resilience boundary adoption (#72/#73): the AppErrorBoundary
// main.tsx wraps around <App/> catches a render error in its subtree and shows
// the shared themed <ErrorState> fallback instead of white-screening, never
// leaks error internals into the UI, and RESETS when the session WebID changes
// (this router-free app's pathname-analogue — see AppErrorBoundary.tsx).
//
// useSession is mocked (the boundary reads ONLY webId from it); the boundary /
// fallback mechanics themselves are exhaustively tested in @jeswr/app-shell —
// this is the thin adoption test for the parity rollout.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";
import type { SessionContextValue } from "./auth/SessionProvider";

// Mutable session double — only webId is read by AppErrorBoundary.
const sessionState = { webId: null as string | null };
vi.mock("./auth/SessionProvider", () => ({
  useSession: (): Pick<SessionContextValue, "webId"> => ({ webId: sessionState.webId }),
}));

/** A child that throws during render while `shouldThrow` is true. */
function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("secret internal detail");
  return <p>content alive</p>;
}

afterEach(() => {
  sessionState.webId = null;
});

describe("AppErrorBoundary (pod-music adoption)", () => {
  it("renders children when nothing throws", () => {
    render(
      <AppErrorBoundary>
        <Bomb shouldThrow={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByText("content alive")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("catches a render error and shows the themed ErrorState — without leaking internals", () => {
    // React logs caught boundary errors to console.error — expected here.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <AppErrorBoundary>
          <Bomb shouldThrow />
        </AppErrorBoundary>,
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(/something went wrong/i);
      // The default fallback offers in-place recovery…
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      // …and NEVER renders the raw error message/stack.
      expect(alert).not.toHaveTextContent(/secret internal detail/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("resets when the session WebID changes (the router-free resetKey)", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { rerender } = render(
        <AppErrorBoundary>
          <Bomb shouldThrow />
        </AppErrorBoundary>,
      );
      expect(screen.getByRole("alert")).toBeInTheDocument();
      // The user logs in: webId flips → the boundary must clear the caught
      // error and re-render the (now healthy) children.
      sessionState.webId = "https://alice.example/profile/card#me";
      rerender(
        <AppErrorBoundary>
          <Bomb shouldThrow={false} />
        </AppErrorBoundary>,
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText("content alive")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
