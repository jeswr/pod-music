// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Pure presentation helpers for the music-library view. No React, no RDF — just
// the duration/name/error formatting the view renders. Kept separate so they are
// trivially unit-testable and reusable by any future view (a list AND a grid).

/**
 * Human-readable track duration from a seconds count (e.g. `3:05`, `1:02:09`).
 * Returns `"—"` when the duration is absent, and also when it is not a finite
 * non-negative number (a malformed `schema:duration` literal must never throw or
 * render `NaN:NaN` — it degrades to the same em-dash as an absent value).
 */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number) => n.toString().padStart(2, "0");
  if (hrs > 0) {
    return `${hrs}:${two(mins)}:${two(secs)}`;
  }
  return `${mins}:${two(secs)}`;
}

/**
 * ISO-date (`YYYY-MM-DD`) for a listen/published timestamp, or `"—"` when absent
 * or invalid. Guards an invalid `Date` (`new Date("nonsense")`) so a malformed
 * timestamp degrades to the em-dash rather than throwing on `toISOString`.
 * Deliberately locale-independent so the rendered value is stable + assertable.
 */
export function formatDate(date: Date | undefined): string {
  if (date === undefined || Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toISOString().slice(0, 10);
}

/**
 * A user-facing message for a thrown value. The data layer rejects with typed
 * errors (which extend `Error`), but a catch binds `unknown`; this normalises
 * both (an `Error`'s `.message`, else the stringified value) into one display
 * string — kept here as a pure, directly-testable helper.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether an href is safe to render as a clickable link. Only `http:`/`https:`
 * and `mailto:` are allowed; anything else (notably `javascript:`, `data:`) is
 * rejected so a hostile IRI in pod data can never become an executable link.
 * A malformed URL parses to nothing and is rejected.
 */
export function isSafeHref(href: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
  );
}
