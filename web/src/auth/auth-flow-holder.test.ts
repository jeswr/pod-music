// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * FIX 1 — the page-lifetime auth singleton must drive the CURRENT mounted
 * <authorization-code-flow> element, never a first-mount element a StrictMode
 * remount removed.
 *
 * The bug: the singleton captures `getCode` from the FIRST element. StrictMode
 * unmounts that element immediately but the singleton survives, so later logins
 * call a `getCode` bound to a detached popup and never resolve.
 *
 * The fix (this module): `getCodeThroughHolder` reads the LATEST element's
 * `getCode` from a module-level `authFlowHolder` at call time. The mount effect
 * writes the holder on every mount. This test simulates that double-mount: the
 * singleton's stable `getCode` (captured once) must end up calling element-2's
 * `getCode`, not the removed element-1's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { authFlowHolder, getCodeThroughHolder } from "./auth-flow-holder";

afterEach(() => {
  authFlowHolder.current = null;
});

describe("getCodeThroughHolder — drives the latest mounted element (StrictMode-safe)", () => {
  it("throws when no element is mounted", async () => {
    authFlowHolder.current = null;
    await expect(
      getCodeThroughHolder(new URL("https://issuer.example/auth"), new AbortController().signal),
    ).rejects.toThrow(/No <authorization-code-flow> element is mounted/);
  });

  it("after a StrictMode remount, the singleton's getCode calls the SECOND element, not the first", async () => {
    // The singleton captures `getCodeThroughHolder` ONCE, at construction — modelled
    // here by grabbing a stable reference up front (never re-reading it later).
    const singletonGetCode = getCodeThroughHolder;

    // --- First mount: element-1 publishes its getCode to the holder. ---
    const element1 = vi.fn(async () => "https://app.example/callback.html?code=one");
    authFlowHolder.current = element1;

    // --- StrictMode unmounts element-1, then mounts element-2, which overwrites
    //     the holder. (The element-1 unmount cleanup only nulls the holder if it
    //     still points at element-1 — element-2 already replaced it, so it stays.) ---
    const element2 = vi.fn(async () => "https://app.example/callback.html?code=two");
    authFlowHolder.current = element2;
    // Simulate element-1's late unmount cleanup: it must NOT clobber element-2.
    if (authFlowHolder.current === element1) authFlowHolder.current = null;

    // The singleton (captured before the remount) now runs a login: it must drive
    // element-2 (the LIVE element), never the removed element-1.
    const uri = new URL("https://issuer.example/auth");
    const signal = new AbortController().signal;
    const code = await singletonGetCode(uri, signal);

    expect(code).toBe("https://app.example/callback.html?code=two");
    expect(element2).toHaveBeenCalledTimes(1);
    expect(element2).toHaveBeenCalledWith(uri, signal);
    expect(element1).not.toHaveBeenCalled();
  });

  it("each subsequent mount re-points the holder; the singleton always uses the latest", async () => {
    const singletonGetCode = getCodeThroughHolder;
    const elementA = vi.fn(async () => "code-A");
    const elementB = vi.fn(async () => "code-B");

    authFlowHolder.current = elementA;
    expect(await singletonGetCode(new URL("https://i/a"), new AbortController().signal)).toBe(
      "code-A",
    );

    authFlowHolder.current = elementB;
    expect(await singletonGetCode(new URL("https://i/b"), new AbortController().signal)).toBe(
      "code-B",
    );
  });
});
