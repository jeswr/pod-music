// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Security-critical tests for the hardened token-endpoint CLIENT AUTHENTICATION
// helpers in webid-token-provider.ts. These port the cross-app SECURITY-PARITY
// hardening from @jeswr/solid-session-restore @ 32bf38c into pod-music's bespoke
// provider, closing two weaknesses the #84 work flagged:
//
//   1. LOOSE ESS host match. The old code keyed the ESS `client_secret_basic`
//      no-url-encode workaround on `issuer.includes("login.inrupt.com")` — a
//      SUBSTRING match that a spoofed host like `login.inrupt.com.attacker.example`
//      (or a path/subdomain segment) would satisfy, sending a non-standard Basic
//      header to the WRONG server. Replaced with an EXACT-hostname gate.
//
//   2. SILENT FALLBACK TO NO-AUTH. The old `#clientAuth` did `else None()` for any
//      `token_endpoint_auth_method` it did not recognise — so a confidential client
//      declaring `client_secret_jwt` / `private_key_jwt` / `tls_client_auth` would be
//      silently downgraded to a public (`none`) client, mis-authenticating (and on
//      some servers succeeding-as-public when the user intended confidential auth).
//      Replaced with FAIL-CLOSED: throw rather than send no/wrong client auth.
//
// The two tests the brief requires are explicitly called out:
//   (a) exact-host match — login.inrupt.com → workaround applied; the spoofed
//       lookalike → NOT applied (the spec ClientSecretBasic);
//   (b) fail-closed on an unsupported auth method.
import * as oauth from "oauth4webapi";
import { describe, expect, it } from "vitest";
import {
  buildClientAuth,
  isEssNoUrlEncodeIssuer,
  isSupportedTokenEndpointAuthMethod,
} from "./webid-token-provider";

// A minimal oauth.Client double. The real type accepts arbitrary metadata via its
// index signature; we only set the fields the client-auth path reads.
function client(overrides: Record<string, unknown> = {}): oauth.Client {
  return { client_id: "the-client", ...overrides } as unknown as oauth.Client;
}

/**
 * Invoke a built `oauth.ClientAuth` against a fake AS/client/body/headers and return
 * the resulting Authorization header + the form body params, so a test can assert HOW
 * the credential was actually presented (Basic header vs form body, encoded vs raw).
 */
function applyClientAuth(auth: oauth.ClientAuth, clientId = "the-client") {
  const headers = new Headers();
  const body = new URLSearchParams();
  // oauth.ClientAuth signature: (as, client, body, headers) => void | Promise<void>
  auth({} as oauth.AuthorizationServer, { client_id: clientId } as oauth.Client, body, headers);
  return { headers, body };
}

describe("isEssNoUrlEncodeIssuer — EXACT-hostname ESS gate (weakness #1)", () => {
  it("MATCHES the exact Inrupt ESS host", () => {
    expect(isEssNoUrlEncodeIssuer("https://login.inrupt.com")).toBe(true);
    expect(isEssNoUrlEncodeIssuer("https://login.inrupt.com/")).toBe(true);
    expect(isEssNoUrlEncodeIssuer("https://login.inrupt.com/oidc")).toBe(true);
  });

  it("does NOT match a spoofed host that merely CONTAINS the substring (the attack)", () => {
    // The old `includes("login.inrupt.com")` substring check matched all of these — a
    // malicious operator could host an OP at any of them and receive the ESS-specific
    // non-url-encoded Basic credential. The exact-hostname gate rejects them all.
    expect(isEssNoUrlEncodeIssuer("https://login.inrupt.com.attacker.example")).toBe(false);
    expect(isEssNoUrlEncodeIssuer("https://login.inrupt.com.evil.test/oidc")).toBe(false);
    expect(isEssNoUrlEncodeIssuer("https://evil.example/login.inrupt.com/oidc")).toBe(false);
    expect(isEssNoUrlEncodeIssuer("https://notlogin.inrupt.com")).toBe(false);
    expect(isEssNoUrlEncodeIssuer("https://login.inrupt.com.example.com")).toBe(false);
  });

  it("fails closed (false) on an unparseable issuer", () => {
    expect(isEssNoUrlEncodeIssuer("not a url")).toBe(false);
    expect(isEssNoUrlEncodeIssuer("")).toBe(false);
  });
});

describe("isSupportedTokenEndpointAuthMethod", () => {
  it("accepts exactly none / client_secret_basic / client_secret_post", () => {
    expect(isSupportedTokenEndpointAuthMethod("none")).toBe(true);
    expect(isSupportedTokenEndpointAuthMethod("client_secret_basic")).toBe(true);
    expect(isSupportedTokenEndpointAuthMethod("client_secret_post")).toBe(true);
  });

  it("rejects every other (defined-but-unsupported) method", () => {
    for (const m of [
      "client_secret_jwt",
      "private_key_jwt",
      "tls_client_auth",
      "self_signed_tls_client_auth",
      "",
      undefined,
      42,
    ]) {
      expect(isSupportedTokenEndpointAuthMethod(m)).toBe(false);
    }
  });
});

describe("buildClientAuth — public clients", () => {
  it("returns `none` (no Authorization header) for a method-omitted public client", () => {
    const { headers } = applyClientAuth(buildClientAuth("https://issuer.example", client()));
    expect(headers.get("Authorization")).toBeNull();
  });

  it("returns `none` for an explicit `none` method", () => {
    const { headers, body } = applyClientAuth(
      buildClientAuth("https://issuer.example", client({ token_endpoint_auth_method: "none" })),
    );
    expect(headers.get("Authorization")).toBeNull();
    expect(body.has("client_secret")).toBe(false);
  });
});

describe("buildClientAuth — client_secret_basic + the ESS workaround (weakness #1)", () => {
  it("(a) EXACT host login.inrupt.com → the BESPOKE no-url-encode Basic header", () => {
    // Use a secret with a char that RFC-6749 §2.3.1 form-url-encoding WOULD percent-
    // encode (a space), so the bespoke (raw) vs spec (encoded) paths produce DIFFERENT
    // headers and the test genuinely distinguishes them.
    const secret = "se cret"; // contains a space
    const auth = buildClientAuth(
      "https://login.inrupt.com",
      client({ token_endpoint_auth_method: "client_secret_basic", client_secret: secret }),
    );
    const { headers } = applyClientAuth(auth, "the-client");
    // The bespoke variant base64s `client_id:secret` RAW (no url-encoding).
    expect(headers.get("Authorization")).toBe(`Basic ${btoa(`the-client:${secret}`)}`);
  });

  it("(a) a SPOOFED login.inrupt.com.* host → the SPEC ClientSecretBasic, NOT the workaround", () => {
    // This is the core security assertion: a host that the old substring check would
    // have matched must now get the SPEC (url-encoding) ClientSecretBasic, so the
    // bespoke raw-Basic credential is NEVER sent to a spoofed server.
    const secret = "se cret"; // a space → spec form-url-encoding turns it into `+`
    const auth = buildClientAuth(
      "https://login.inrupt.com.evil.test",
      client({ token_endpoint_auth_method: "client_secret_basic", client_secret: secret }),
    );
    const { headers } = applyClientAuth(auth, "the-client");
    const header = headers.get("Authorization");
    expect(header).not.toBeNull();
    // It must NOT be the raw (bespoke) header...
    expect(header).not.toBe(`Basic ${btoa(`the-client:${secret}`)}`);
    // ...it must be EXACTLY what the SPEC oauth4webapi ClientSecretBasic produces (id +
    // secret form-url-encoded before base64, per RFC 6749 §2.3.1). Compute the expected
    // header from the real spec encoder so the assertion can't drift from its rules.
    const { headers: specHeaders } = applyClientAuth(oauth.ClientSecretBasic(secret), "the-client");
    expect(header).toBe(specHeaders.get("Authorization"));
  });

  it("a normal (non-ESS) issuer → the SPEC ClientSecretBasic", () => {
    const secret = "se cret";
    const auth = buildClientAuth(
      "https://pod.example/oidc",
      client({ token_endpoint_auth_method: "client_secret_basic", client_secret: secret }),
    );
    const { headers } = applyClientAuth(auth, "the-client");
    expect(headers.get("Authorization")).not.toBe(`Basic ${btoa(`the-client:${secret}`)}`);
  });
});

describe("buildClientAuth — client_secret_post", () => {
  it("sends the secret in the form body, not the Basic header", () => {
    const auth = buildClientAuth(
      "https://pod.example/oidc",
      client({ token_endpoint_auth_method: "client_secret_post", client_secret: "s3cr3t" }),
    );
    const { headers, body } = applyClientAuth(auth, "the-client");
    expect(headers.get("Authorization")).toBeNull();
    expect(body.get("client_secret")).toBe("s3cr3t");
    expect(body.get("client_id")).toBe("the-client");
  });

  it("does NOT apply the ESS no-url-encode workaround to client_secret_post (Basic-only)", () => {
    // Even on the ESS host, client_secret_post must go through the spec ClientSecretPost
    // (the bespoke workaround is a Basic-header variant only).
    const auth = buildClientAuth(
      "https://login.inrupt.com",
      client({ token_endpoint_auth_method: "client_secret_post", client_secret: "s3cr3t" }),
    );
    const { headers, body } = applyClientAuth(auth, "the-client");
    expect(headers.get("Authorization")).toBeNull();
    expect(body.get("client_secret")).toBe("s3cr3t");
  });
});

describe("buildClientAuth — FAIL-CLOSED on unsupported / missing-secret (weakness #2)", () => {
  it("(b) THROWS on a DEFINED-but-UNSUPPORTED method instead of silently downgrading to `none`", () => {
    for (const method of [
      "client_secret_jwt",
      "private_key_jwt",
      "tls_client_auth",
      "self_signed_tls_client_auth",
    ]) {
      expect(() =>
        buildClientAuth(
          "https://issuer.example",
          client({ token_endpoint_auth_method: method, client_secret: "s3cr3t" }),
        ),
      ).toThrow(/Unsupported token_endpoint_auth_method/);
    }
  });

  it("(b) FAILS CLOSED on a present-but-`null` method (must NOT be treated as omitted → `none`)", () => {
    // A loosely-typed client (oauth.Client's `[metadata]: JsonValue | undefined` index
    // signature admits `null`) declaring `token_endpoint_auth_method: null` must NOT be
    // coerced to the public `none` method — only a genuinely OMITTED (`undefined`)
    // method defaults to `none`. `?? "none"` would have wrongly swallowed `null`.
    expect(() =>
      buildClientAuth(
        "https://issuer.example",
        client({ token_endpoint_auth_method: null, client_secret: "s3cr3t" }),
      ),
    ).toThrow(/Unsupported token_endpoint_auth_method/);
  });

  it("(b) FAILS CLOSED on an unsupported method even with NO secret (must not become `none`)", () => {
    // The old `else None()` would have happily returned a public client here. A server
    // that registers us with private_key_jwt and no secret must abort, not mis-auth.
    expect(() =>
      buildClientAuth(
        "https://issuer.example",
        client({ token_endpoint_auth_method: "private_key_jwt" }),
      ),
    ).toThrow(/Unsupported token_endpoint_auth_method/);
  });

  it("THROWS when a confidential method is declared but NO client_secret is present", () => {
    for (const method of ["client_secret_basic", "client_secret_post"]) {
      expect(() =>
        buildClientAuth("https://issuer.example", client({ token_endpoint_auth_method: method })),
      ).toThrow(/no client_secret/);
      // empty string is also "no secret"
      expect(() =>
        buildClientAuth(
          "https://issuer.example",
          client({ token_endpoint_auth_method: method, client_secret: "" }),
        ),
      ).toThrow(/no client_secret/);
    }
  });

  it("ADVERSARIAL: the OLD substring behaviour would FAIL this — a spoofed host must not get the raw Basic header", () => {
    // Guard-presence proof. If someone reverts the exact-host gate back to a substring
    // `includes("login.inrupt.com")`, the spoofed issuer below would again select the
    // no-url-encode variant and this assertion (raw header) would WRONGLY hold — so this
    // test asserts the NEGATION, failing loudly the moment the guard is weakened.
    const secret = "se cret";
    const auth = buildClientAuth(
      "https://login.inrupt.com.attacker.example/oidc",
      client({ token_endpoint_auth_method: "client_secret_basic", client_secret: secret }),
    );
    const { headers } = applyClientAuth(auth, "the-client");
    expect(headers.get("Authorization")).not.toBe(`Basic ${btoa(`the-client:${secret}`)}`);
  });
});
