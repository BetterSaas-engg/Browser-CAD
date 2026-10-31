/**
 * Reading the model's reply, without trusting any of it.
 *
 * This file used to generate a JSON schema and constrain the answer to it.
 * Both attempts at that failed against the real API — the per-shape version was
 * refused outright as too large a grammar, and the flat version that replaced it
 * made some valid designs **unreachable**, because a compiled optional-property
 * grammar appears to admit keys only in declaration order. A Cylinder that had
 * written `diameter` could no longer write `height`. See D66.
 *
 * So the answer now arrives as ordinary JSON, described in the instructions and
 * shown there as a worked example, and this module reads it. The strict
 * validator in `designFile.ts` is the gate it was always going to be, and a
 * reply that will not parse spends the same single retry a rejected design does
 * (D62) — a parse failure is just another way of being wrong.
 *
 * Pure: a string in, a design and a note out. No DOM, no kernel.
 */

/** What a valid answer parses into, before the validator has had its say. */
export interface AiAnswer {
  design: unknown;
  assumptions: string;
}

/**
 * Find the JSON in a reply that may not be only JSON.
 *
 * The instructions ask for bare JSON and nothing else. Without a grammar
 * enforcing that, the two things that actually turn up are a fenced code block
 * and a sentence of preamble, so both are handled rather than counted as
 * failures — spending a retry on a stray "Here you go:" would be absurd.
 *
 * Anything else is left alone for `JSON.parse` to reject, and its message is
 * what the model gets told.
 */
function extractJson(text: string): string {
  const trimmed = text.trim();

  // A fenced block, with or without a language tag.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenced) return fenced[1].trim();

  // Prose either side of an object: take the outermost braces. Not a parser —
  // if the result is not valid JSON, `JSON.parse` says so in the usual way.
  if (!trimmed.startsWith("{")) {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) return trimmed.slice(first, last + 1);
  }

  return trimmed;
}

/**
 * Pull the answer apart.
 *
 * Checks the envelope only — that there is a `design` field at all — and hands
 * the design itself, untouched, to the validator. Anything about *what* a design
 * may contain is the validator's to say, so that there is one place it is said.
 */
export function readAnswer(text: string): { ok: true; answer: AiAnswer } | { ok: false; problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch (error) {
    return {
      ok: false,
      problem:
        `The reply was not valid JSON: ${error instanceof Error ? error.message : error} ` +
        "Reply with the JSON object only — no explanation around it, no code fence.",
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, problem: "The reply was not a JSON object." };
  }
  const record = value as Record<string, unknown>;

  if (!("design" in record)) {
    return {
      ok: false,
      problem: 'The reply had no "design" field. It must be {"design": …, "assumptions": "…"}.',
    };
  }
  const assumptions = typeof record.assumptions === "string" ? record.assumptions : "";
  return { ok: true, answer: { design: record.design, assumptions } };
}
