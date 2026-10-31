/**
 * The dev-server endpoint that holds the API key.
 *
 * **This file never reaches the browser.** It is imported by `vite.config.ts`
 * and runs in the dev server's Node process; nothing in `src/main.ts`'s import
 * graph touches it, and a test asserts the built bundle contains neither the
 * key's variable name nor any SDK code. The `.node.ts` suffix is the same
 * convention `bundledFonts.node.ts` uses for "runs in Node, needs Node types",
 * and the app's tsconfig excludes it for that reason (D40).
 *
 * The split is deliberate and narrow: this file knows the key and how to make
 * one HTTP call. It does not know what a design is. The instructions, reading
 * the answer, the validator and the retry decision all live in the page, where
 * the shape catalogue already is and where `designFile.ts` is the single
 * authority on what a design may be (D58).
 *
 * The key is read from the environment and never logged, echoed, or returned.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Plugin } from "vite";
import {
  GENERATE_PATH,
  MAX_ANSWER_CHARACTERS,
  MAX_DESCRIPTION_CHARACTERS,
} from "./aiTypes.ts";
import type { GenerateFailure, GenerateRequest, GenerateResponse } from "./aiTypes.ts";

/**
 * The model, overridable in `.env.local`.
 *
 * Sonnet is the right tier here: the task is writing a small, heavily-specified
 * JSON document, which it does well, and a design costs about a penny (D63).
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/**
 * Output cap.
 *
 * A design of a dozen items is a few hundred tokens. This is generous enough
 * not to truncate a complicated part and small enough to bound a runaway.
 */
const MAX_OUTPUT_TOKENS = 8_000;

/** How long the endpoint waits on the API before giving up. */
const API_TIMEOUT_MS = 75_000;

/** Everything the handler needs, injected so tests never touch the network. */
export interface GenerateDeps {
  /** The key, or undefined when it is not configured. Never logged. */
  apiKey: string | undefined;
  model: string;
  /** Makes the actual call. Replaced in tests. */
  callModel(args: CallModelArgs): Promise<string>;
}

export interface CallModelArgs {
  apiKey: string;
  model: string;
  system: string;
  /** The user turn, already assembled. */
  prompt: string;
}

/** A reply, with the status the endpoint should send it under. */
export interface HandlerResult {
  status: number;
  body: GenerateResponse;
}

const fail = (status: number, reason: GenerateFailure, error: string): HandlerResult => ({
  status,
  body: { error, reason },
});

/**
 * Turn the request into the user turn.
 *
 * On a retry this carries the validator's complaint **verbatim** along with the
 * JSON that produced it. A paraphrase would be a second chance to be wrong
 * about what was actually wrong, and the validator's messages already name the
 * item and the field — which is exactly what the model needs to fix it.
 */
export function buildPrompt(request: GenerateRequest): string {
  const parts = [`Design this part:\n\n${request.description.trim()}`];

  if (request.priorError) {
    parts.push(
      "Your previous answer was rejected by the app's validator. " +
        "This is the error, exactly as the validator reported it:\n\n" +
        request.priorError +
        "\n\nFix that specific problem and answer again. " +
        "Keep everything else about the design the same.",
    );
    if (request.priorAnswer) {
      parts.push(`This was the design it rejected:\n\n${request.priorAnswer}`);
    }
  }

  return parts.join("\n\n");
}

/** Read and check the request body. */
function readRequest(body: unknown): { ok: true; request: GenerateRequest } | HandlerResult {
  if (typeof body !== "object" || body === null) {
    return fail(400, "bad-request", "The request body was not an object.");
  }
  const record = body as Record<string, unknown>;

  if (typeof record.description !== "string" || record.description.trim() === "") {
    return fail(400, "bad-request", "Describe the part you want before generating.");
  }
  if (record.description.length > MAX_DESCRIPTION_CHARACTERS) {
    return fail(
      400,
      "too-large",
      `That description is ${record.description.length.toLocaleString()} characters; ` +
        `the limit is ${MAX_DESCRIPTION_CHARACTERS.toLocaleString()}.`,
    );
  }
  if (typeof record.system !== "string" || record.system === "") {
    return fail(400, "bad-request", "The request carried no instructions.");
  }

  return {
    ok: true,
    request: {
      description: record.description,
      system: record.system,
      priorError: typeof record.priorError === "string" ? record.priorError : undefined,
      priorAnswer: typeof record.priorAnswer === "string" ? record.priorAnswer : undefined,
    },
  };
}

/**
 * Handle one generate request.
 *
 * Exported separately from the plugin so the tests can drive it with a fake
 * `callModel` and never make a real API call.
 */
export async function handleGenerate(body: unknown, deps: GenerateDeps): Promise<HandlerResult> {
  if (!deps.apiKey) {
    return fail(
      503,
      "no-key",
      "No Anthropic API key is configured. Add ANTHROPIC_API_KEY to .env.local " +
        "in the project root and restart the dev server.",
    );
  }

  const read = readRequest(body);
  if (!("ok" in read)) return read;

  let text: string;
  try {
    text = await deps.callModel({
      apiKey: deps.apiKey,
      model: deps.model,
      system: read.request.system,
      prompt: buildPrompt(read.request),
    });
  } catch (error) {
    return describeCallFailure(error, deps.model);
  }

  if (text.length > MAX_ANSWER_CHARACTERS) {
    return fail(
      502,
      "too-large",
      `The reply was ${text.length.toLocaleString()} characters, past the ` +
        `${MAX_ANSWER_CHARACTERS.toLocaleString()} limit. Try a simpler description.`,
    );
  }

  return { status: 200, body: { text } };
}

/**
 * Turn an SDK error into something a user can act on.
 *
 * Uses the SDK's typed error classes rather than matching on message text,
 * which is what they exist for. The key is never included in any of these.
 */
function describeCallFailure(error: unknown, model: string): HandlerResult {
  if (error instanceof Anthropic.RateLimitError) {
    return fail(
      429,
      "rate-limited",
      "The API is rate-limiting this key. Wait a moment and generate again.",
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return fail(
      401,
      "no-key",
      "The Anthropic API rejected the key in .env.local. Check it is current and complete.",
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return fail(403, "api-error", `This key is not allowed to use ${model}.`);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return fail(
      404,
      "api-error",
      `The API does not know a model called "${model}". Check ANTHROPIC_MODEL in .env.local.`,
    );
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return fail(504, "timeout", "The API did not answer in time. Try again.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return fail(502, "network", "Could not reach the Anthropic API. Check your connection.");
  }
  if (error instanceof Anthropic.APIError) {
    return fail(502, "api-error", `The Anthropic API returned an error: ${error.message}`);
  }
  return fail(
    500,
    "api-error",
    `Something went wrong calling the API: ${error instanceof Error ? error.message : error}`,
  );
}

/**
 * The real call.
 *
 * **No `output_config`, deliberately.** Constraining the answer to a generated
 * schema was tried twice and failed twice against the real API: once refused as
 * too large a grammar, once by making valid designs unreachable (D66). The
 * format is described in the instructions instead, and the page parses the reply
 * and runs it through the strict validator — which was always the real gate.
 *
 * Thinking is left at the model's default, which on Sonnet 5.5 is adaptive and
 * is what this task wants: a little reasoning about proportions, then a small
 * JSON document. There is no `temperature`: Sonnet 5.5 rejects it.
 */
export async function callAnthropic({
  apiKey,
  model,
  system,
  prompt,
}: CallModelArgs): Promise<string> {
  const client = new Anthropic({ apiKey, timeout: API_TIMEOUT_MS, maxRetries: 1 });

  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      "The model declined this request. Try describing the part differently.",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "The reply was cut off at the token limit. Try a simpler description.",
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (text.trim() === "") throw new Error("The model returned an empty reply.");
  return text;
}

/** Read a request body as text, with a cap so a huge POST cannot exhaust memory. */
async function readBody(request: { on: Function }): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooBig = false;
    request.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      body += chunk;
      // Generous against the description cap, so the handler's own message
      // explains the problem rather than the stream dying first.
      if (body.length > MAX_DESCRIPTION_CHARACTERS * 20) tooBig = true;
    });
    request.on("end", () => (tooBig ? reject(new Error("Request body too large")) : resolve(body)));
    request.on("error", reject);
  });
}

/**
 * The Vite plugin.
 *
 * `apply: "serve"` so it is not even constructed for a build — the endpoint is
 * a dev-server affordance and does not exist in a static build, which is why
 * the page has to say so rather than appear to work (D59).
 */
export function aiDesignPlugin(env: Record<string, string>): Plugin {
  return {
    name: "browser-cad:ai-design",
    apply: "serve",

    configureServer(server) {
      const deps: GenerateDeps = {
        // Read once at start-up. Editing .env.local therefore needs a restart,
        // which is worth saying out loud because the alternative — re-reading
        // per request — would make it unclear which key a request used.
        apiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        callModel: callAnthropic,
      };

      // Said once at start-up rather than only on first use, so the setup step
      // is visible before anyone types a description and waits.
      if (!deps.apiKey) {
        server.config.logger.warn(
          "[ai-design] No ANTHROPIC_API_KEY in .env.local — Generate will report that it is missing.",
        );
      } else {
        server.config.logger.info(`[ai-design] ready, model ${deps.model}`);
      }

      server.middlewares.use(GENERATE_PATH, async (request, response, next) => {
        if (request.method !== "POST") {
          next();
          return;
        }

        const send = ({ status, body }: HandlerResult): void => {
          response.statusCode = status;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(body));
        };

        try {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            send(fail(400, "bad-request", "The request body was not valid JSON."));
            return;
          }
          send(await handleGenerate(parsed, deps));
        } catch (error) {
          // Nothing here may surface the key, so the message is ours, not the
          // error's, for anything that is not already a handled SDK failure.
          server.config.logger.error(
            `[ai-design] request failed: ${error instanceof Error ? error.message : error}`,
          );
          send(fail(500, "api-error", "The dev-server endpoint failed. See the terminal."));
        }
      });
    },
  };
}
