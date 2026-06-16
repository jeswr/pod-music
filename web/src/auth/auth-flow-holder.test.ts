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
import type { AuthorizationCodeFlow } from "@solid/reactive-authentication";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_FLOW_ELEMENT,
  authFlowHolder,
  getCodeThroughHolder,
  lazyElementGetCode,
} from "./auth-flow-holder";

afterEach(() => {
  authFlowHolder.current = null;
  // Tests stub the global `customElements` registry; reset it between tests.
  (globalThis as { customElements?: unknown }).customElements = undefined;
});

/**
 * A minimal stand-in for the custom-element registry used by tests that run in the
 * node (DOM-less) vitest environment. `whenDefined` is a spy so we can assert the
 * lazy accessor waited for the element upgrade on a very-early call.
 */
function stubCustomElements(): { whenDefined: ReturnType<typeof vi.fn> } {
  const whenDefined = vi.fn(async () => undefined);
  (globalThis as { customElements?: unknown }).customElements = { whenDefined };
  return { whenDefined };
}

/**
 * A fake <authorization-code-flow> element. It starts NOT upgraded (`getCode`
 * absent — the cold-start state), and `upgrade()` installs the real method, exactly
 * as the reactive-auth chunk's `customElements.define` would when its dynamic import
 * resolves. Cast to `AuthorizationCodeFlow` for the accessor's typed param — the
 * whole point of the test is the runtime where `getCode` is absent.
 */
function makeFakeFlowElement(): {
  element: AuthorizationCodeFlow;
  upgrade: (impl: AuthorizationCodeFlow["getCode"]) => void;
} {
  const element = {} as { getCode?: AuthorizationCodeFlow["getCode"] };
  return {
    element: element as AuthorizationCodeFlow,
    upgrade(impl) {
      element.getCode = impl;
    },
  };
}

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

/**
 * COLD-START REGRESSION (roborev HIGH) — the mount effect must be able to publish
 * the element's `getCode` to the holder on the VERY FIRST synchronous mount, BEFORE
 * the dynamically-imported reactive-auth chunk has upgraded the element (so
 * `getCode` is still `undefined`). The old code did `ui.getCode.bind(ui)` at mount
 * time, which THROWS on a cold mount (reading `.bind` of `undefined`) and breaks
 * first-load login. `lazyElementGetCode` reads `getCode` only at CALL (login) time.
 */
describe("lazyElementGetCode — cold-start safe (getCode read at call time)", () => {
  it("publishing the accessor for a NOT-yet-upgraded element does NOT throw (the cold-mount bug)", () => {
    const { element } = makeFakeFlowElement(); // getCode is undefined (cold).
    // This is exactly what the mount effect does on a cold first mount. The old
    // `ui.getCode.bind(ui)` threw here; building + publishing the lazy accessor must not.
    expect(() => {
      authFlowHolder.current = lazyElementGetCode(element);
    }).not.toThrow();
    expect(authFlowHolder.current).toBeTypeOf("function");
  });

  it("a later invocation (after the element is upgraded) calls through to the element's getCode with the right args + this", async () => {
    stubCustomElements();
    const { element, upgrade } = makeFakeFlowElement();
    // Mount publishes the lazy accessor while the element is still cold.
    const accessor = lazyElementGetCode(element);

    // The dynamic import resolves → the element is upgraded with a real getCode that
    // closes over `this` (proving the accessor calls it with the correct receiver).
    const getCodeImpl = vi.fn(async function (
      this: unknown,
      _uri: URL,
      _signal: AbortSignal,
    ): Promise<string> {
      // `this` must be the element, not undefined / the module.
      return this === element ? "https://app.example/callback.html?code=ok" : "WRONG-THIS";
    });
    upgrade(getCodeImpl as unknown as AuthorizationCodeFlow["getCode"]);

    const uri = new URL("https://issuer.example/auth");
    const signal = new AbortController().signal;
    const code = await accessor(uri, signal);

    expect(code).toBe("https://app.example/callback.html?code=ok");
    expect(getCodeImpl).toHaveBeenCalledTimes(1);
    expect(getCodeImpl).toHaveBeenCalledWith(uri, signal);
  });

  it("a very-early call (element still un-upgraded) awaits whenDefined, then calls through — never throws", async () => {
    const { whenDefined } = stubCustomElements();
    const { element, upgrade } = makeFakeFlowElement();
    const accessor = lazyElementGetCode(element);

    // Simulate the reactive-auth chunk upgrading the element when `whenDefined`
    // resolves (i.e. its `customElements.define` ran during the dynamic import).
    const getCodeImpl = vi.fn(async () => "https://app.example/callback.html?code=early");
    whenDefined.mockImplementation(async (name: string) => {
      expect(name).toBe(AUTH_FLOW_ELEMENT);
      upgrade(getCodeImpl as unknown as AuthorizationCodeFlow["getCode"]);
    });

    const uri = new URL("https://issuer.example/auth");
    const signal = new AbortController().signal;
    // Must NOT throw despite getCode being undefined when the call started.
    const code = await accessor(uri, signal);

    expect(whenDefined).toHaveBeenCalledWith(AUTH_FLOW_ELEMENT);
    expect(code).toBe("https://app.example/callback.html?code=early");
    expect(getCodeImpl).toHaveBeenCalledWith(uri, signal);
  });

  it("does NOT wait on whenDefined when the element is already upgraded (fast path)", async () => {
    const { whenDefined } = stubCustomElements();
    const { element, upgrade } = makeFakeFlowElement();
    upgrade(vi.fn(async () => "code") as unknown as AuthorizationCodeFlow["getCode"]);
    const accessor = lazyElementGetCode(element);

    await accessor(new URL("https://i/x"), new AbortController().signal);
    // Already a function → the belt-and-braces wait must be skipped entirely.
    expect(whenDefined).not.toHaveBeenCalled();
  });
});
