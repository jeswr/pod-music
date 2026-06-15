// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Typed errors for the Pod Music data layer. Branch on `instanceof`, never on
// message strings.

/** Base class for all Pod Music data-layer errors. */
export class PodMusicError extends Error {
  override readonly name: string = "PodMusicError";
}

/**
 * A resource that was required (e.g. an existing track to update) could not be
 * found in the pod. Carries the URL that 404'd.
 */
export class ResourceNotFoundError extends PodMusicError {
  override readonly name = "ResourceNotFoundError";
  readonly url: string;
  constructor(url: string) {
    super(`Resource not found in pod: ${url}`);
    this.url = url;
  }
}

/**
 * The pod refused a read or write (a WAC/ACP 401 or 403). Discovery is a hint,
 * not a grant — callers must surface this rather than silently swallow it.
 */
export class AccessDeniedError extends PodMusicError {
  override readonly name = "AccessDeniedError";
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(`Access denied (${status}) for: ${url}`);
    this.url = url;
    this.status = status;
  }
}

/**
 * A value violated the model's invariants (e.g. a negative duration, an empty
 * title, or a container URL missing its trailing slash) before it could be
 * written.
 */
export class InvalidModelError extends PodMusicError {
  override readonly name = "InvalidModelError";
}
