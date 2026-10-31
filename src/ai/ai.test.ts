/*
 * No real API calls anywhere in this file.
 *
 * The endpoint handler takes its `callModel` as a dependency and the client
 * takes its `fetch`, so both halves are driven with fakes. If a test here ever
 * needs a key to pass, something has been wired wrong.
 */
import { describe, expect, it, vi } from "vitest";
import { catalog } from "../shapes/shapeLibrary";
import { SYMBOLS } from "../shapes/symbols";
import { DESIGN_VERSION } from "../design";
import { validateDesign } from "../designFile";
import {
  AI_EXCLUDED_SHAPES,
  EXAMPLE_ANSWER,
  EXAMPLE_DESCRIPTION,
  buildInstructions,
  shapesForAi,
} from "./instructions";
import { readAnswer } from "./aiAnswer";
import { dropForeignParams, generateDesign } from "./generateDesign";
import { DEFAULT_MODEL, buildPrompt, handleGenerate } from "./aiEndpoint.node";
import type { CallModelArgs, GenerateDeps } from "./aiEndpoint.node";
import { GENERATE_PATH, MAX_DESCRIPTION_CHARACTERS } from "./aiTypes";

const CATALOG = catalog();

/** A design the real validator accepts, as Claude would return it. */
const GOOD_DESIGN = {
  version: DESIGN_VERSION,
  items: [
    {
      shapeId: "box",
      params: { width: 60, depth: 20, height: 8 },
      position: { x: 0, y: 0, z: 0 },
      rotationZ: 0,
      operation: "add",
    },
    {
      shapeId: "cylinder",
      params: { diameter: 4, height: 20 },
      position: { x: -24, y: 0, z: -5 },
      rotationZ: 0,
      operation: "cut",
    },
  ],
};

/** A design the validator refuses: the cylinder has no height. */
const BAD_DESIGN = {
  version: DESIGN_VERSION,
  items: [
    {
      shapeId: "cylinder",
      params: { diameter: 10 },
      position: { x: 0, y: 0, z: 0 },
      rotationZ: 0,
      operation: "add",
    },
  ],
};

const answer = (design: unknown, assumptions = "Assumed a 2 mm deep hole.") =>
  JSON.stringify({ design, assumptions });

/** A fetch that returns whatever the queue says, one reply per call. */
function fakeFetch(replies: { status?: number; body: unknown }[]) {
  const calls: unknown[] = [];
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (!reply) throw new Error("fakeFetch ran out of replies");
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const run = (description: string, replies: { status?: number; body: unknown }[], isDev = true) => {
  const { impl, calls } = fakeFetch(replies);
  return generateDesign({ description, catalog: CATALOG, isDev, fetchImpl: impl }).then((outcome) => ({
    outcome,
    calls,
  }));
};

describe("the instructions, generated from the libraries", () => {
  const instructions = buildInstructions({ catalog: CATALOG, symbols: SYMBOLS });

  it("names every shape the AI may use, with its id", () => {
    for (const shape of shapesForAi(CATALOG)) {
      expect(instructions).toContain(`"shapeId": "${shape.id}"`);
      expect(instructions).toContain(shape.label);
    }
  });

  it("states every parameter and its limits", () => {
    for (const shape of shapesForAi(CATALOG)) {
      for (const spec of shape.params) {
        expect(instructions).toContain(`\`${spec.key}\``);
        if (spec.kind === "number") {
          // The actual numbers, not a hand-written approximation of them.
          expect(instructions).toContain(`${spec.min} to ${spec.max}`);
        }
        if (spec.kind === "choice") {
          for (const option of spec.options) expect(instructions).toContain(`"${option.value}"`);
        }
        if (spec.kind === "text") {
          expect(instructions).toContain(`1 to ${spec.maxLength} characters`);
        }
      }
    }
  });

  it("names every symbol, with its character", () => {
    for (const symbol of SYMBOLS) {
      expect(instructions).toContain(symbol.character);
      expect(instructions).toContain(symbol.label);
    }
  });

  it("leaves Outline out, and says so", () => {
    expect(AI_EXCLUDED_SHAPES).toEqual(["outline"]);
    expect(shapesForAi(CATALOG).map((s) => s.id)).not.toContain("outline");
    // Not merely absent — named as forbidden, so the model does not invent it
    // from the word "outline" appearing in a description.
    expect(instructions).toContain("must NOT use");
    expect(instructions).toContain("`outline`");
    // And none of its parameters leak in as something to fill.
    expect(instructions).not.toContain("`size`");
  });

  it("covers the text rules and the conventions", () => {
    expect(instructions).toContain("capital letter");
    expect(instructions).toContain("× ÷");
    for (const font of ["sans", "rounded"]) expect(instructions).toContain(`"${font}"`);
    expect(instructions).toContain("Millimetres throughout");
    expect(instructions).toContain("Z is up");
    expect(instructions).toContain('first item must be `"add"`');
    expect(instructions).toContain("lowest point is z = 0");
    expect(instructions).toContain("H − D");
    expect(instructions).toContain("centred on their position");
  });

  it("grows when a shape is added, so nothing has to be remembered", () => {
    const fewer = buildInstructions({ catalog: CATALOG.slice(0, 2), symbols: SYMBOLS });
    expect(instructions.length).toBeGreaterThan(fewer.length);
  });

  it("refuses to build instructions with no usable shapes", () => {
    expect(() => buildInstructions({ catalog: [], symbols: SYMBOLS })).toThrow(/No shapes/);
  });
});

/*
 * There is no schema any more (D66). What replaced it is the worked example and
 * the per-shape key lists in the instructions, so that is what gets tested — and
 * the one thing an example must never be is wrong.
 */
describe("the worked example in the instructions", () => {
  it("is itself a design the real validator accepts", () => {
    // The whole point. An example that does not load teaches the wrong format,
    // and no amount of careful wording around it would survive that.
    const checked = validateDesign(EXAMPLE_ANSWER.design, CATALOG);
    expect(checked.ok).toBe(true);
  });

  it("survives dropForeignParams untouched, so it models the rule it teaches", () => {
    const { notes } = dropForeignParams(EXAMPLE_ANSWER.design, CATALOG);
    expect(notes).toEqual([]);
  });

  it("uses only parameters its shapes actually declare", () => {
    for (const item of EXAMPLE_ANSWER.design.items) {
      const shape = shapesForAi(CATALOG).find((entry) => entry.id === item.shapeId);
      expect(shape, `example uses unknown shape ${item.shapeId}`).toBeDefined();
      expect(Object.keys(item.params).sort()).toEqual(shape!.params.map((p) => p.key).sort());
    }
  });

  it("appears in the instructions, with its description and a real note", () => {
    const instructions = buildInstructions({ catalog: CATALOG, symbols: SYMBOLS });
    expect(instructions).toContain(EXAMPLE_DESCRIPTION);
    expect(instructions).toContain(JSON.stringify(EXAMPLE_ANSWER, null, 2));
    // Not a placeholder: the note is read by a person and two real replies came
    // back with `"assumptions": "x"` under the old schema.
    expect(EXAMPLE_ANSWER.assumptions.length).toBeGreaterThan(40);
  });

  it("demonstrates the two placement rules that need demonstrating", () => {
    // Items share a `params` type across shapes, so each key reads as optional.
    const [plate, text, hole] = EXAMPLE_ANSWER.design.items.map(
      (item) => item as unknown as { params: Record<string, number>; position: { z: number } },
    );
    // Engraving sits at z = H − D.
    expect(text.position.z).toBe(plate.params.height - text.params.depth);
    // A through hole is taller than the plate and starts below it.
    expect(hole.params.height).toBeGreaterThan(plate.params.height);
    expect(hole.position.z).toBeLessThan(0);
  });

  it("asks for bare JSON, since nothing enforces the format now", () => {
    const instructions = buildInstructions({ catalog: CATALOG, symbols: SYMBOLS });
    expect(instructions).toContain("one JSON object and nothing else");
    expect(instructions).toContain("no code fence");
    // Both halves of the failure that killed the schema, stated explicitly.
    expect(instructions).toContain("Leaving out one of the shape's own parameters");
    expect(instructions).toContain("Adding a parameter from a different shape");
    expect(instructions).toContain("Do not pad");
  });
});

describe("reading the envelope", () => {
  it("passes the assumptions note through", () => {
    const read = readAnswer(answer(GOOD_DESIGN, "Assumed 2 mm."));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.answer.assumptions).toBe("Assumed 2 mm.");
  });

  it("refuses something that is not JSON, or not a design", () => {
    expect(readAnswer("sorry, I can't").ok).toBe(false);
    expect(readAnswer("[1,2,3]").ok).toBe(false);
    expect(readAnswer('{"assumptions":"x"}').ok).toBe(false);
  });

  it("tolerates a missing note rather than failing over it", () => {
    // The note is nice to have; the design is the point.
    const read = readAnswer(JSON.stringify({ design: GOOD_DESIGN }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.answer.assumptions).toBe("");
  });

  /*
   * Without a grammar forcing bare JSON (D66), the two things that actually turn
   * up are a code fence and a sentence of preamble. Spending the single retry on
   * a stray "Here you go:" would be absurd, so both are read rather than
   * refused. Anything genuinely malformed still fails.
   */
  it("reads a fenced code block", () => {
    for (const fence of ["```json\n", "```\n"]) {
      const read = readAnswer(`${fence}${answer(GOOD_DESIGN, "Assumed 2 mm.")}\n\`\`\``);
      expect(read.ok, fence).toBe(true);
      if (!read.ok) return;
      expect(read.answer.assumptions).toBe("Assumed 2 mm.");
    }
  });

  it("reads JSON with prose either side of it", () => {
    const read = readAnswer(
      `Here is the design you asked for:\n\n${answer(GOOD_DESIGN)}\n\nHope that helps!`,
    );
    expect(read.ok).toBe(true);
  });

  it("still refuses a reply that only looks like JSON", () => {
    const read = readAnswer("Here you go: {design: not actually json}");
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // The message tells the model what to do differently, since it is what
    // comes back on the retry.
    expect(read.problem).toContain("no code fence");
  });

  it("names the missing field, so the retry knows what to fix", () => {
    const read = readAnswer('{"items":[]}');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problem).toContain('"design"');
  });
});

describe("a valid answer loads", () => {
  it("returns the design and the assumptions, in one attempt", async () => {
    const { outcome, calls } = await run("a name tag", [
      { body: { text: answer(GOOD_DESIGN, "Assumed a 2 mm deep hole.") } },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.assumptions).toBe("Assumed a 2 mm deep hole.");
    expect(outcome.design.items).toHaveLength(2);
    expect(outcome.design.items[0].shapeId).toBe("box");
    expect(calls).toHaveLength(1);
  });

  it("sends the generated instructions and schema, not a hand-written prompt", async () => {
    const { calls } = await run("a name tag", [{ body: { text: answer(GOOD_DESIGN) } }]);
    const sent = calls[0] as any;
    expect(sent.description).toBe("a name tag");
    expect(sent.system).toBe(buildInstructions({ catalog: CATALOG, symbols: SYMBOLS }));
    // No schema on the wire at all: the instructions are the only description
    // of the format now (D66).
    expect(sent.schema).toBeUndefined();
    expect(sent.priorError).toBeUndefined();
  });
});

/*
 * The failure that prompted this: the flat schema of D60 cannot say which
 * parameters belong to which shape, so the model filled a Cylinder with
 * plausible neighbours and the validator refused it twice over.
 */
describe("parameters belonging to other shapes", () => {
  /** A cylinder carrying three keys from three other shapes. */
  const WITH_STRAYS = {
    version: DESIGN_VERSION,
    items: [
      {
        shapeId: "box",
        params: { width: 60, depth: 20, height: 8 },
        position: { x: 0, y: 0, z: 0 },
        rotationZ: 0,
        operation: "add",
      },
      {
        shapeId: "cylinder",
        params: { diameter: 4, height: 20, topDiameter: 0, holeDiameter: 4, letterHeight: 10 },
        position: { x: -24, y: 0, z: -5 },
        rotationZ: 0,
        operation: "cut",
      },
    ],
  };

  it("drops them and names every one in the assumptions note", async () => {
    const { outcome, calls } = await run("a name tag", [
      { body: { text: answer(WITH_STRAYS, "Assumed a 4 mm hole.") } },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // One attempt: no retry spent on something the app can simply ignore.
    expect(outcome.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(outcome.assumptions).toBe(
      "Assumed a 4 mm hole.\nItem 2 (cylinder): ignored topDiameter, holeDiameter, letterHeight",
    );
    // The real parameters survive untouched.
    expect(outcome.design.items[1].params).toEqual({ diameter: 4, height: 20 });
  });

  it("reports the drop even when the model wrote no note of its own", async () => {
    const { outcome } = await run("a name tag", [
      { body: { text: JSON.stringify({ design: WITH_STRAYS, assumptions: "" }) } },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Never silent: the note is the whole justification for forgiving this.
    expect(outcome.assumptions).toBe(
      "Item 2 (cylinder): ignored topDiameter, holeDiameter, letterHeight",
    );
  });

  it("is a pure function that leaves the original alone", () => {
    const before = JSON.stringify(WITH_STRAYS);
    const { design, notes } = dropForeignParams(WITH_STRAYS, CATALOG);
    expect(JSON.stringify(WITH_STRAYS)).toBe(before);
    expect(notes).toHaveLength(1);
    expect((design as any).items[1].params).toEqual({ diameter: 4, height: 20 });
  });

  it("says nothing when there is nothing to drop", () => {
    expect(dropForeignParams(GOOD_DESIGN, CATALOG).notes).toEqual([]);
  });

  it("passes anything oddly shaped straight to the validator", () => {
    // Not its job to judge these — the validator has proper messages for them.
    for (const odd of [null, 42, {}, { items: "no" }, { items: [null, 7] }]) {
      expect(() => dropForeignParams(odd, CATALOG)).not.toThrow();
    }
    expect(dropForeignParams({ items: [{ shapeId: "nope", params: { x: 1 } }] }, CATALOG).notes)
      .toEqual([]);
  });

  it("still fails a missing parameter — only strays are forgiven", async () => {
    const missingHeight = {
      version: DESIGN_VERSION,
      items: [
        {
          shapeId: "cylinder",
          // Its own `height` is absent; the strays cannot stand in for it.
          params: { diameter: 4, topDiameter: 2, letterHeight: 10 },
          position: { x: 0, y: 0, z: 0 },
          rotationZ: 0,
          operation: "add",
        },
      ],
    };
    const { outcome, calls } = await run("a peg", [
      { body: { text: answer(missingHeight) } },
      { body: { text: answer(missingHeight) } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain("Cylinder is missing Height");
    expect(outcome.problem).toContain("has not been touched");
    expect(calls).toHaveLength(2);
  });

  it("still fails an out-of-range parameter", async () => {
    const tooBig = {
      version: DESIGN_VERSION,
      items: [
        {
          shapeId: "cylinder",
          params: { diameter: 9_000, height: 20, holeDiameter: 3 },
          position: { x: 0, y: 0, z: 0 },
          rotationZ: 0,
          operation: "add",
        },
      ],
    };
    const { outcome } = await run("a peg", [
      { body: { text: answer(tooBig) } },
      { body: { text: answer(tooBig) } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain("Diameter");
  });

  it("tells the model the exact keys each shape takes", () => {
    const instructions = buildInstructions({ catalog: CATALOG, symbols: SYMBOLS });
    for (const shape of shapesForAi(CATALOG)) {
      const keys = shape.params.map((spec) => `\`${spec.key}\``).join(", ");
      expect(instructions).toContain(
        `holds exactly these ${shape.params.length} keys and no others: ${keys}.`,
      );
    }
    expect(instructions).toContain("Parameter names are not shared between shapes");
  });
});

describe("the raw replies, for diagnosing a failure", () => {
  it("keeps every attempt, with the reason each was rejected", async () => {
    const { outcome } = await run("a peg", [
      { body: { text: answer(BAD_DESIGN) } },
      { body: { text: answer(BAD_DESIGN) } },
    ]);
    expect(outcome.transcript).toHaveLength(2);
    expect(outcome.transcript[0].attempt).toBe(1);
    expect(outcome.transcript[0].raw).toContain("cylinder");
    expect(outcome.transcript[0].problem).toContain("missing Height");
    expect(outcome.transcript[1].attempt).toBe(2);
  });

  it("keeps the accepted attempt too, with no problem recorded", async () => {
    const { outcome } = await run("a name tag", [{ body: { text: answer(GOOD_DESIGN) } }]);
    expect(outcome.transcript).toHaveLength(1);
    expect(outcome.transcript[0].problem).toBeUndefined();
  });

  it("records a transport failure without a reply to show", async () => {
    const failing = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const outcome = await generateDesign({
      description: "a peg",
      catalog: CATALOG,
      isDev: true,
      fetchImpl: failing,
    });
    expect(outcome.transcript).toHaveLength(1);
    expect(outcome.transcript[0].raw).toBe("");
    expect(outcome.transcript[0].problem).toContain("dev server");
  });

  it("never carries the key, a header, or anything but the reply text", async () => {
    /*
     * The endpoint returns `{text}` and nothing else, so there is structurally
     * nothing to leak — this pins that, because the details section is now
     * shown to the user and would be the one place a leak would surface.
     */
    const { outcome } = await run("a peg", [
      { body: { text: answer(BAD_DESIGN) } },
      {
        status: 401,
        body: { error: "The Anthropic API rejected the key in .env.local.", reason: "no-key" },
      },
    ]);
    const dump = JSON.stringify(outcome.transcript);
    expect(dump).not.toMatch(/sk-ant-/);
    expect(dump).not.toContain("x-api-key");
    expect(dump).not.toContain("authorization");
    expect(dump).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("one retry, carrying the validator's exact error", () => {
  /*
   * The design below is wrong in a way only the real validator catches: a
   * cylinder with no `height`. The schema would have refused it too, but a
   * model can still produce one if the API declines the schema or truncates —
   * which is the case this retry exists for.
   */
  const MISSING_PARAM = {
    version: DESIGN_VERSION,
    items: [
      {
        shapeId: "cylinder",
        params: { diameter: 10 },
        position: { x: 0, y: 0, z: 0 },
        rotationZ: 0,
        operation: "add",
      },
    ],
  };

  it("retries exactly once and loads the corrected design", async () => {
    const { outcome, calls } = await run("a peg", [
      { body: { text: answer(MISSING_PARAM) } },
      { body: { text: answer(GOOD_DESIGN, "Assumed 8 mm thick.") } },
    ]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.assumptions).toBe("Assumed 8 mm thick.");
    // Exactly two calls: one try, one retry. Not three.
    expect(calls).toHaveLength(2);
  });

  it("sends the validator's message verbatim, not a paraphrase", async () => {
    const { calls } = await run("a peg", [
      { body: { text: answer(MISSING_PARAM) } },
      { body: { text: answer(GOOD_DESIGN) } },
    ]);

    const retry = calls[1] as any;
    // The exact string designFile.ts produces for this mistake.
    expect(retry.priorError).toBe("Item 1: Cylinder is missing Height.");
    // And the JSON that caused it, so the model can see its own mistake.
    expect(retry.priorAnswer).toContain('"shapeId": "cylinder"');
    expect(retry.description).toBe("a peg");
  });

  it("puts that error into the prompt the endpoint builds", () => {
    const prompt = buildPrompt({
      description: "a peg",
      system: "…",
      priorError: "Item 1: Cylinder is missing Height.",
      priorAnswer: '{"shapeId":"cylinder"}',
    });
    expect(prompt).toContain("a peg");
    expect(prompt).toContain("Item 1: Cylinder is missing Height.");
    expect(prompt).toContain("exactly as the validator reported it");
    expect(prompt).toContain('{"shapeId":"cylinder"}');
  });

  it("does not retry a transport failure, which a validation error cannot fix", async () => {
    const { outcome, calls } = await run("a peg", [
      { status: 429, body: { error: "The API is rate-limiting this key.", reason: "rate-limited" } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toMatch(/rate-limiting/);
    expect(calls).toHaveLength(1);
  });
});

describe("two invalid answers give up visibly", () => {
  const BAD = {
    version: DESIGN_VERSION,
    items: [
      {
        shapeId: "box",
        params: { width: 9000, depth: 20, height: 8 },
        position: { x: 0, y: 0, z: 0 },
        rotationZ: 0,
        operation: "add",
      },
    ],
  };

  it("reports the second failure and leaves the design alone", async () => {
    const { outcome, calls } = await run("a huge slab", [
      { body: { text: answer(BAD) } },
      { body: { text: answer(BAD) } },
    ]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.problem).toMatch(/twice/);
    // Names the actual problem rather than just saying it failed.
    expect(outcome.problem).toMatch(/outside the allowed/);
    // And says plainly that nothing was touched, because that is the thing the
    // user most needs to know at that moment.
    expect(outcome.problem).toMatch(/has not been touched/);
    expect(calls).toHaveLength(2);
    // No design comes back at all, so there is nothing a caller could load.
    expect("design" in outcome).toBe(false);
  });

  it("gives up the same way on two unreadable replies", async () => {
    const { outcome, calls } = await run("a slab", [
      { body: { text: "I'm sorry, I can't do that." } },
      { body: { text: "Still no." } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toMatch(/could not be read, twice/);
    expect(calls).toHaveLength(2);
  });
});

describe("the endpoint, with no network", () => {
  const deps = (over: Partial<GenerateDeps> = {}): GenerateDeps => ({
    apiKey: "sk-ant-test-not-a-real-key",
    model: DEFAULT_MODEL,
    callModel: async () => answer(GOOD_DESIGN),
    ...over,
  });

  const body = {
    description: "a name tag",
    system: "instructions",
  };

  it("says clearly that no key is configured, and how to fix it", async () => {
    const result = await handleGenerate(body, deps({ apiKey: undefined }));
    expect(result.status).toBe(503);
    expect(result.body.reason).toBe("no-key");
    expect(result.body.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(result.body.error).toMatch(/\.env\.local/);
    expect(result.body.error).toMatch(/restart/i);
  });

  it("checks for the key before anything else, so no call is attempted", async () => {
    const callModel = vi.fn();
    await handleGenerate(body, deps({ apiKey: "", callModel }));
    expect(callModel).not.toHaveBeenCalled();
  });

  it("never puts the key in the reply", async () => {
    const key = "sk-ant-secret-value-12345";
    const result = await handleGenerate(body, deps({ apiKey: key, callModel: async () => { throw new Error("boom"); } }));
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("passes the key to the model call and nowhere else", async () => {
    let seen: CallModelArgs | undefined;
    await handleGenerate(body, deps({ callModel: async (args) => { seen = args; return answer(GOOD_DESIGN); } }));
    expect(seen?.apiKey).toBe("sk-ant-test-not-a-real-key");
    expect(seen?.model).toBe(DEFAULT_MODEL);
  });

  it("defaults to the current Sonnet", () => {
    // Pinned so a stale id cannot drift in unnoticed — a wrong model id fails
    // as a 404 on the first real request, which no mocked test would catch.
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5-5");
  });

  it("refuses an empty or overlong description", async () => {
    const empty = await handleGenerate({ ...body, description: "   " }, deps());
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/Describe the part/);

    const huge = await handleGenerate(
      { ...body, description: "x".repeat(MAX_DESCRIPTION_CHARACTERS + 1) },
      deps(),
    );
    expect(huge.status).toBe(400);
    expect(huge.body.reason).toBe("too-large");
  });

  it("refuses a body with no instructions, or no body at all", async () => {
    expect((await handleGenerate({ description: "x" }, deps())).status).toBe(400);
    expect((await handleGenerate({ ...body, system: "" }, deps())).status).toBe(400);
    expect((await handleGenerate("not an object", deps())).status).toBe(400);
  });

  it("caps an oversized reply rather than handing it on", async () => {
    const result = await handleGenerate(
      body,
      deps({ callModel: async () => "x".repeat(70_000) }),
    );
    expect(result.status).toBe(502);
    expect(result.body.reason).toBe("too-large");
  });

  it("passes a good reply straight through, unparsed", async () => {
    const text = answer(GOOD_DESIGN);
    const result = await handleGenerate(body, deps({ callModel: async () => text }));
    expect(result.status).toBe(200);
    // The endpoint does not know what a design is — it returns the raw text and
    // lets the page's validator be the authority (D58).
    expect(result.body.text).toBe(text);
  });
});

describe("dev mode only", () => {
  it("says so, and makes no request at all", async () => {
    const { outcome, calls } = await run("a name tag", [], false);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toMatch(/only available in dev mode/i);
    expect(outcome.problem).toMatch(/npm run dev/);
    expect(calls).toHaveLength(0);
  });

  it("explains a missing endpoint as a dev server that needs restarting", async () => {
    const { impl } = fakeFetch([]);
    const notFound = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    void impl;

    const outcome = await generateDesign({
      description: "a tag",
      catalog: CATALOG,
      isDev: true,
      fetchImpl: notFound,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toMatch(/no AI endpoint/);
    expect(outcome.problem).toMatch(/Restart/);
  });

  it("explains an unreachable dev server", async () => {
    const dead = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const outcome = await generateDesign({
      description: "a tag",
      catalog: CATALOG,
      isDev: true,
      fetchImpl: dead,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toMatch(/Could not reach the dev server/);
    expect(outcome.problem).toMatch(/npm run dev/);
  });

  it("posts to the endpoint path the plugin serves", async () => {
    const seen: (string | URL | Request)[] = [];
    const spy = vi.fn(async (url: string | URL | Request) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ text: answer(GOOD_DESIGN) }) } as Response;
    }) as unknown as typeof fetch;

    await generateDesign({ description: "a tag", catalog: CATALOG, isDev: true, fetchImpl: spy });
    expect(seen[0]).toBe(GENERATE_PATH);
  });

  it("refuses a blank or overlong description before any request", async () => {
    const blank = await run("   ", [], true);
    expect(blank.outcome.ok).toBe(false);
    expect(blank.calls).toHaveLength(0);

    const huge = await run("x".repeat(MAX_DESCRIPTION_CHARACTERS + 1), [], true);
    expect(huge.outcome.ok).toBe(false);
    expect(huge.calls).toHaveLength(0);
  });
});
