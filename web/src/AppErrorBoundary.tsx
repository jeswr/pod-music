// AUTHORED-BY Claude Fable 5
//
// AppErrorBoundary — the app's ONE crash-resilience boundary (cross-app parity
// #72/#73), wrapping the routed root in the shared @jeswr/app-shell
// <ErrorBoundary>: a render/lifecycle error anywhere in the App subtree renders
// the themed default <ErrorState> (role="alert", "Try again" reset) instead of
// white-screening, and error internals go nowhere near the UI.
//
// RESET KEY: the sibling apps pass the router pathname so navigating away
// recovers a caught error. Pod Music is ROUTER-FREE — its only "navigation" is
// the session lifecycle (logged-out ⇄ logged-in) — so the WebID is the
// pathname-analogue: a login or logout while the fallback is showing clears the
// error and re-renders the fresh view. The "Try again" button covers in-place
// recovery.
//
// PLACEMENT (main.tsx): INSIDE ThemeProvider (the fallback stays themed) and
// INSIDE SessionProvider (this component reads useSession, and the auth seam's
// own invariants stay outside the guarded subtree), around <App/>.
import { ErrorBoundary } from "@jeswr/app-shell";
import type { ReactNode } from "react";
import { useSession } from "./auth/SessionProvider";

export function AppErrorBoundary({ children }: { children?: ReactNode }) {
  const { webId } = useSession();
  return <ErrorBoundary resetKey={webId}>{children}</ErrorBoundary>;
}
