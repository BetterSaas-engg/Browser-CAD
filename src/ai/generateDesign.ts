/**
 * Asking for a design, and deciding whether to believe the answer.
 *
 * This runs in the page. It builds the instructions from the catalogue, posts
 * them to the dev-server endpoint, and runs whatever comes
 * back through `designFile.ts` — **unchanged, and exactly as strict as it is
 * for a file the user opened** (D58). A design the AI wrote gets no more
 * benefit of the doubt than one typed by hand.
 *
 * On a validation failure it retries **once**, carrying the validator's own
 * message. Two failures is a visible error and the current design untouched.
 *
 * No DOM: the caller does the talking. Vitest drives this with a fake fetch.
 */
import { validateDesign } from "../designFile";
import type { Design } from "../design";
import type { ShapeCatalogEntry } from "../shapes/shapeLibrary";
import { SYMBOLS } from "../shapes/symbols";
import { buildInstructions } from "./instructions";
import { readAnswer } from "./aiAnswer";
import {
  GENERATE_PATH,
  MAX_DESCRIPTION_CHARACTERS,
  REQUEST_TIMEOUT_MS,
} from "./aiTypes";
import type { GenerateRequest, GenerateResponse } from "./aiTypes";

/**
 * One attempt, kept for the page's "Show details" section.
 *
 * `raw` is the model's reply text exactly as the endpoint handed it over — the
 * endpoint returns only that text, never headers and never the key, so there is
 * nothing here to redact. A test pins that.
 */
export interface AttemptRecord {
  attempt: number;
  /** The reply text, or the transport failure if there was no reply. */
  raw: string;
  /** Why this attempt was rejected. Absent if it was accepted. */
  problem?: string;
}

export type GenerateOutcome =
  | {
      ok: true;
      design: Design;
      assumptions: string;
      attempts: number;
      transcript: AttemptRecord[];
    }
  | { ok: false; problem: string; attempts: number; transcript: AttemptRecord[] };

export interface GenerateOptions {
  description: string;
  catalog: ShapeCatalogEntry[];
  /**
   * Whether the dev-server endpoint can exist at all.
   *
   * Passed in rather than read from `import.meta.env` here so the tests can
   * exercise both paths without a build.
   */
  isDev: boolean;
  /** Replaced in tests. Defaults to the real one. */
  fetchImpl?: typeof fetch;
  /** Called before each attempt, so the UI can say what is happening. */
  onAttempt?(attempt: number): void;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Drop parameters that belong to some other shape, and say which.
 *
 * **A deliberate, visible exception to D29, and the only one.** It was added
 * when the flat schema of D60 was offering every shape's keys on every item, and
 * the model was filling in plausible-looking neighbours: a Cylinder arriving
 * with `topDiameter`, `holeDiameter` and `letterHeight` alongside its real
 * `diameter` and `height`. The validator refused it, correctly — and refusing
 * twice over parameters the app would simply ignore is a useless failure.
 *
 * The schema is gone (D66) and the instructions now state each shape's closed
 * key list, so this should rarely fire. It is kept because nothing stops a
 * free-writing model from adding a stray key, and because the cost of keeping it
 * is one pass over the items.
 *
 * So this runs at the AI boundary, before validation, and it does exactly one
 * thing: remove keys that are **not parameters of the shape the item names**.
 * It never adds a value, never changes one, and never touches anything else. A
 * missing parameter, an out-of-range number, a wrong type, an unknown shape,
 * a first item that cuts — all still fail, in the unchanged validator.
 *
 * **It is not silent repair.** Every dropped key is named in the assumptions
 * note the user reads, item by item, so a design that quietly lost a parameter
 * the user did ask for is visible rather than mysterious. That is the whole
 * difference between this and loosening the validator: the validator stays
 * strict for files and for hand editing (D29), and the one place something is
 * forgiven, it is also reported.
 *
 * Defensive throughout: anything not shaped as expected is passed through
 * untouched for the validator to complain about properly.
 */
export function dropForeignParams(
  design: unknown,
  catalog: ShapeCatalogEntry[],
): { design: unknown; notes: string[] } {
  if (!isPlainObject(design) || !Array.isArray(design.items)) return { design, notes: [] };

  const notes: string[] = [];
  const items = design.items.map((item, index) => {
    if (!isPlainObject(item) || typeof item.shapeId !== "string" || !isPlainObject(item.params)) {
      return item;
    }
    const shape = catalog.find((entry) => entry.id === item.shapeId);
    if (!shape) return item;

    const allowed = new Set(shape.params.map((spec) => spec.key));
    const dropped = Object.keys(item.params).filter((key) => !allowed.has(key));
    if (dropped.length === 0) return item;

    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item.params)) {
      if (allowed.has(key)) params[key] = value;
    }
    // Numbered as the validator numbers items, so a note and an error about the
    // same item can be read together.
    notes.push(`Item ${index + 1} (${shape.id}): ignored ${dropped.join(", ")}`);
    return { ...item, params };
  });

  // A copy: the raw reply is kept for the details section and must not change.
  return { design: { ...design, items }, notes };
}

/** One round trip to the endpoint. Network and HTTP shape only — no judgement. */
async function askOnce(
  request: GenerateRequest,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; text: string } | { ok: false; problem: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(GENERATE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch (error) {
    // An abort is our own timeout firing, which is worth distinguishing from
    // the dev server being gone.
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        problem: `No answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds. The request was given up on.`,
      };
    }
    return {
      ok: false,
      problem:
        "Could not reach the dev server. Is `npm run dev` still running? " +
        `(${error instanceof Error ? error.message : error})`,
    };
  } finally {
    clearTimeout(timer);
  }

  let body: GenerateResponse;
  try {
    body = (await response.json()) as GenerateResponse;
  } catch {
    // A 404 with an HTML body is what you get from a build served statically,
    // or from a dev server started before this plugin existed.
    return {
      ok: false,
      problem:
        response.status === 404
          ? "The dev server has no AI endpoint. Restart `npm run dev` to pick it up."
          : `The dev server replied with ${response.status} and nothing readable.`,
    };
  }

  if (!response.ok || body.error) {
    return { ok: false, problem: body.error ?? `The dev server replied with ${response.status}.` };
  }
  if (typeof body.text !== "string" || body.text.trim() === "") {
    return { ok: false, problem: "The dev server returned an empty answer." };
  }
  return { ok: true, text: body.text };
}

/**
 * Ask for a design, validate it, and retry once if it was wrong.
 *
 * Returns the design and the assumptions note, or the reason it could not be
 * had. It never partially applies anything — the caller holds the current
 * design and only replaces it on success.
 */
export async function generateDesign({
  description,
  catalog,
  isDev,
  fetchImpl = fetch,
  onAttempt,
}: GenerateOptions): Promise<GenerateOutcome> {
  if (!isDev) {
    return {
      ok: false,
      attempts: 0,
      transcript: [],
      problem:
        "Generating a design is only available in dev mode, because it needs the " +
        "local endpoint that holds the API key. Run `npm run dev` and use that page.",
    };
  }
  if (description.trim() === "") {
    return { ok: false, attempts: 0, transcript: [], problem: "Describe the part you want first." };
  }
  if (description.length > MAX_DESCRIPTION_CHARACTERS) {
    return {
      ok: false,
      attempts: 0,
      transcript: [],
      problem:
        `That description is ${description.length.toLocaleString()} characters; ` +
        `the limit is ${MAX_DESCRIPTION_CHARACTERS.toLocaleString()}.`,
    };
  }

  const system = buildInstructions({ catalog, symbols: SYMBOLS });

  let priorError: string | undefined;
  let priorAnswer: string | undefined;
  /** Every attempt, for the page's details section. */
  const transcript: AttemptRecord[] = [];

  // Two attempts at most: the first, and one retry carrying the exact
  // validation error. A third would mostly buy a third variation on the same
  // misunderstanding, and each one costs the user real money and real time.
  for (let attempt = 1; attempt <= 2; attempt++) {
    onAttempt?.(attempt);

    const reply = await askOnce({ description, system, priorError, priorAnswer }, fetchImpl);
    if (!reply.ok) {
      // A transport or API failure is not something a retry with a validation
      // error would fix, so it stops here.
      transcript.push({ attempt, raw: "", problem: reply.problem });
      return { ok: false, attempts: attempt, transcript, problem: reply.problem };
    }

    const envelope = readAnswer(reply.text);
    if (!envelope.ok) {
      transcript.push({ attempt, raw: reply.text, problem: envelope.problem });
      priorError = envelope.problem;
      priorAnswer = reply.text.slice(0, 4_000);
      if (attempt === 2) {
        return {
          ok: false,
          attempts: attempt,
          transcript,
          problem: `The AI's reply could not be read, twice. ${envelope.problem}`,
        };
      }
      continue;
    }

    // Parameters belonging to other shapes come off here, and are reported.
    const pruned = dropForeignParams(envelope.answer.design, catalog);

    // The existing validator, unchanged. Its message is what goes back.
    const checked = validateDesign(pruned.design, catalog);
    if (checked.ok) {
      transcript.push({ attempt, raw: reply.text });
      // The note the model wrote, then what the app quietly could not use —
      // in that order, because the first is about the design and the second is
      // about the request that produced it.
      const assumptions = [envelope.answer.assumptions.trim(), ...pruned.notes]
        .filter((line) => line !== "")
        .join("\n");
      return { ok: true, design: checked.design, assumptions, attempts: attempt, transcript };
    }

    transcript.push({ attempt, raw: reply.text, problem: checked.problem });
    priorError = checked.problem;
    // The design as the validator saw it, so the item numbers and fields in the
    // error line up with what the model is being shown.
    priorAnswer = JSON.stringify(pruned.design, null, 2).slice(0, 4_000);

    if (attempt === 2) {
      return {
        ok: false,
        attempts: attempt,
        transcript,
        problem:
          "The AI produced a design this app will not accept, twice. " +
          `The second attempt failed with: ${checked.problem} ` +
          "Your current design has not been touched.",
      };
    }
  }

  // Unreachable: both branches above return on attempt 2.
  return { ok: false, attempts: 2, transcript, problem: "Could not generate a design." };
}
