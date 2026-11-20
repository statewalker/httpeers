/** Where an example writes what it does: the page shows it, the browser check reads it. */
export interface Output {
  /** A line of the transcript. `kind` colours it: "ok" for an expected success, "refused" for an expected refusal. */
  log(text: string, kind?: "info" | "ok" | "refused"): void;
  /** Markup to show under the transcript (a QR code, for instance). */
  html(markup: string): void;
}

/** Stops the example with an error when what it shows did not happen: the browser check fails on it. */
export function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`unexpected: ${message}`);
}
