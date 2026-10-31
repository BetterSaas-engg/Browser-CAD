/**
 * The contract between the page and the dev-server endpoint.
 *
 * Deliberately tiny. The endpoint's only job is to hold the API key and make
 * one HTTP call; everything else — the instructions, reading the answer,
 * validating it, deciding whether to retry — stays in the page, where the shape
 * catalogue already lives and where `designFile.ts` is the single authority on
 * what a design may be.
 *
 * No DOM, no replicad, no Node. Both sides import this.
 */

/** What the page sends to the endpoint. */
export interface GenerateRequest {
  /** What the user typed. */
  description: string;
  /**
   * The system prompt, generated from the libraries (see instructions.ts).
   *
   * This now carries the format description and the worked example too. There
   * is no schema on the wire: structured outputs were removed in D66, and the
   * instructions are the only thing that describes the format to the model.
   */
  system: string;
  /**
   * The validator's complaint about the previous attempt, if this is the
   * retry. Sent verbatim — a paraphrase would be a second chance to be wrong
   * about what is actually wrong.
   */
  priorError?: string;
  /** The JSON the previous attempt produced, so the model can see its mistake. */
  priorAnswer?: string;
}

/** What the endpoint sends back. Exactly one of `text` or `error`. */
export interface GenerateResponse {
  /** The model's raw answer, still to be parsed and validated by the page. */
  text?: string;
  /** Why it could not be done, in words meant for the user. */
  error?: string;
  /** Machine-readable reason, so the page can phrase its own message. */
  reason?: GenerateFailure;
}

export type GenerateFailure =
  | "no-key"
  | "bad-request"
  | "rate-limited"
  | "timeout"
  | "api-error"
  | "too-large"
  | "network"
  | "dev-only";

/**
 * Where the endpoint lives.
 *
 * Under `/__ai/` rather than `/api/` so it cannot collide with anything the
 * app might serve later, and so it is obvious in a network log that this is
 * the dev server's own route and not part of the built app.
 */
export const GENERATE_PATH = "/__ai/generate-design";

/**
 * Longest description we will send.
 *
 * A part description is a sentence or two. The cap is here so a pasted
 * document cannot quietly turn into a large bill.
 */
export const MAX_DESCRIPTION_CHARACTERS = 2_000;

/**
 * Largest answer we will accept back, in characters.
 *
 * A design of a dozen items is a few kilobytes. Anything far past that is a
 * runaway generation, and reading it into the page would be the first thing to
 * go wrong rather than the last.
 */
export const MAX_ANSWER_CHARACTERS = 64_000;

/** How long the page waits before giving up on a request. */
export const REQUEST_TIMEOUT_MS = 90_000;
