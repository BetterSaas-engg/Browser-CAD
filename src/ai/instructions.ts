/**
 * What Claude is told about this app's design format.
 *
 * **Generated from the libraries, never hand-written.** Every shape, every
 * parameter, every limit, and every symbol is read out of the catalogue and the
 * symbol list at call time, so adding a shape or a symbol reaches the AI
 * without anyone remembering to update a prompt. A hand-maintained copy would
 * drift, and the failure would be the model confidently using a parameter that
 * no longer exists.
 *
 * Pure: it takes the plain-data catalogue the worker already sends the page
 * (D19) and the symbol list (D53), so the page can build this without pulling
 * replicad into its bundle. No DOM, no kernel — Vitest drives it directly.
 */
import type { ParamSpec, ShapeCatalogEntry } from "../shapes/shapeLibrary";
import type { SymbolDef } from "../shapes/symbols";
import { DESIGN_VERSION, TRANSFORM_PARAMS } from "../design";

/**
 * Shapes the AI may not use, by id.
 *
 * Outline is excluded in this bite. Its parameter is SVG path data, and path
 * data written from scratch is the most likely thing in this app to come out
 * as geometry that looks plausible and is not valid — a self-crossing contour
 * builds, measures a sensible volume, and renders with faces missing (D50).
 * The soundness check (D51) would catch it, but the useful answer is not to
 * generate it: hearts and stars are available as symbols inside text, which is
 * what people actually ask for. See D61.
 */
export const AI_EXCLUDED_SHAPES = ["outline"];

/** The shapes the AI is allowed to use, in catalogue order. */
export function shapesForAi(catalog: ShapeCatalogEntry[]): ShapeCatalogEntry[] {
  return catalog.filter((shape) => !AI_EXCLUDED_SHAPES.includes(shape.id));
}

/** One parameter, as a line the model can read. */
function describeParam(spec: ParamSpec): string {
  switch (spec.kind) {
    case "number": {
      const unit = spec.unit ?? " mm";
      const bounds = `${spec.min} to ${spec.max}${unit}`;
      const less = spec.lessThan?.length
        ? `, and must be strictly less than ${spec.lessThan.join(" and ")}`
        : "";
      const warn = spec.warnBelow
        ? ` (allowed below ${spec.warnBelow.value}${unit}, but may not print well)`
        : "";
      return `- \`${spec.key}\` (number, ${spec.label}): ${bounds}${less}${warn}. Default ${spec.default}.`;
    }
    case "text":
      return `- \`${spec.key}\` (string, ${spec.label}): 1 to ${spec.maxLength} characters. Default ${JSON.stringify(spec.default)}.`;
    case "choice": {
      const options = spec.options.map((o) => `"${o.value}" (${o.label})`).join(", ");
      return `- \`${spec.key}\` (string, ${spec.label}): one of ${options}. Default "${spec.default}".`;
    }
    case "outline":
      return `- \`${spec.key}\`: not available to you.`;
  }
}

/** The characters the Text shape promises to draw, as a readable list. */
const TEXT_CHARACTERS =
  "A-Z, a-z, 0-9, space, and + - × ÷ = . , ! ? # & @ ( )";

export interface InstructionInputs {
  catalog: ShapeCatalogEntry[];
  symbols: SymbolDef[];
}

/**
 * The description the worked example answers, and the answer.
 *
 * One complete example earns its length several times over now that there is no
 * schema (D66): it shows the envelope, an engraving at z = H − D, a through hole
 * started below z = 0, a symbol inside a line of text, and — the thing two real
 * failures turned on — each shape's `params` holding exactly its own keys.
 *
 * Exported as data, not prose, so a test can put it through the real validator.
 * An example that does not itself load would be teaching the wrong format, and
 * that is the one error in a prompt that no amount of careful wording survives.
 */
export const EXAMPLE_DESCRIPTION =
  "a 60 x 20 x 8 mm name tag that says SAM ♥ with a 4 mm keychain hole at the left end";

export const EXAMPLE_ANSWER = {
  design: {
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
        // Engraved 1 mm into the 8 mm top face, so z = 8 − 1 = 7. Shifted right
        // to leave room for the hole, and centred on that position.
        shapeId: "text",
        params: { text: "SAM ♥", letterHeight: 8, depth: 1, font: "sans" },
        position: { x: 5, y: 0, z: 7 },
        rotationZ: 0,
        operation: "cut",
      },
      {
        // Taller than the plate and started below it, so the hole goes right
        // through instead of ending flush with a face.
        shapeId: "cylinder",
        params: { diameter: 4, height: 20 },
        position: { x: -24, y: 0, z: -5 },
        rotationZ: 0,
        operation: "cut",
      },
    ],
  },
  assumptions:
    "Engraved the name 1 mm deep at 8 mm letter height, and placed the hole 6 mm " +
    "in from the left edge so 4 mm of material is left around it.",
};

/**
 * The system prompt.
 *
 * Written as reference material rather than as a list of commands: the model
 * is good at this format when the format is described precisely, and the
 * validator is what enforces it, so the prompt's job is to be accurate rather
 * than emphatic.
 */
export function buildInstructions({ catalog, symbols }: InstructionInputs): string {
  const shapes = shapesForAi(catalog);
  if (shapes.length === 0) {
    throw new Error("No shapes are available to generate designs from.");
  }

  const shapeSections = shapes
    .map((shape) => {
      const params = shape.params.map(describeParam).join("\n");
      /*
       * The exact key list, repeated as one line per shape.
       *
       * The schema cannot express this (D60), and without it the model fills a
       * Cylinder's params with plausible neighbours from other shapes —
       * `topDiameter`, `holeDiameter`, `letterHeight` — which the validator then
       * refuses. Stating the closed set per shape is the cheap half of the fix;
       * dropping strays at the boundary is the other half (D64).
       */
      const only = shape.params.map((spec) => `\`${spec.key}\``).join(", ");
      return (
        `### ${shape.label} — \`"shapeId": "${shape.id}"\`\n${params}\n` +
        `Its \`params\` object holds exactly these ${shape.params.length} keys and no others: ${only}.`
      );
    })
    .join("\n\n");

  const symbolList = symbols
    .map(
      (symbol) =>
        `\`${symbol.character}\` (${symbol.label}), drawn at ${symbol.capHeightRatio} of the capital height`,
    )
    .join("; ");

  const excluded = AI_EXCLUDED_SHAPES.length
    ? `\n\nShapes you must NOT use: ${AI_EXCLUDED_SHAPES.map((id) => `\`${id}\``).join(", ")}. ` +
      "They exist in the app but are not available to you."
    : "";

  const placement = TRANSFORM_PARAMS.map((spec) => describeParam(spec)).join("\n");

  return `You design 3D-printable parts for a browser CAD tool by writing its design format.

## How to reply

Reply with **one JSON object and nothing else** — no explanation before or
after it, no code fence:

\`\`\`
{"design": {"version": ${DESIGN_VERSION}, "items": [ ... ]}, "assumptions": "..."}
\`\`\`

\`assumptions\` is plain prose for the person who asked: one short sentence per
thing you decided for them, naming the number you chose. It is read, so write it
properly — not a placeholder.

## The format

A design is \`{"version": ${DESIGN_VERSION}, "items": [ ... ]}\`. Each item is:

\`\`\`json
{
  "shapeId": "box",
  "params": { "width": 60, "depth": 20, "height": 8 },
  "position": { "x": 0, "y": 0, "z": 0 },
  "rotationZ": 0,
  "operation": "add"
}
\`\`\`

Every field is required on every item. Values are numbers or strings as stated
below, never strings holding numbers.

**\`params\` holds exactly the parameters of that item's own shape — every one of
them, and nothing else.** Parameter names are not shared between shapes: each
shape's section below ends with the complete list of keys its \`params\` must
contain. Two mistakes to avoid, both of which get the design rejected:

- **Leaving out one of the shape's own parameters.** A Cylinder without
  \`height\` is not a cylinder. Write every key in that shape's list, every time.
- **Adding a parameter from a different shape.** A Cylinder has no
  \`topDiameter\`, no \`holeDiameter\`, no \`letterHeight\`, however reasonable
  those sound. Do not pad \`params\` with keys set to 0 or \`""\`.

## Conventions

- **Millimetres throughout**, and Z is up.
- **The first item must be \`"add"\`** — there is nothing to cut from before it.
- Items apply **in order**: each is fused onto, or subtracted from, the result
  so far. Order matters; cutting then filling differs from filling then cutting.
- **Every shape sits on z = 0 and is centred on the origin in X and Y** before
  its own position is applied. \`position\` moves a shape relative to the others.
- **The finished part is dropped so its lowest point is z = 0.** So where the
  combination lands in Z is not something to manage: raising a lone item by
  25 mm changes nothing.
- **To engrave into the top face of a part of height H with a feature of depth
  D, set the feature's \`z\` to H − D** and its operation to \`"cut"\`. For a
  through hole, make the cutting shape taller than the part and start it below
  z = 0 so it passes cleanly through rather than ending flush with a face.
- Text and outlines are **centred on their position**, so \`x\` and \`y\` place
  the middle of the lettering, not its left edge.

## Placement, on every item

${placement}

## Shapes

${shapeSections}${excluded}

## Text

- \`letterHeight\` is the height of a **capital letter**, not a font size.
- Allowed characters: ${TEXT_CHARACTERS}.
- Also allowed, as symbols drawn by the app rather than by the font: ${symbolList}. Put the character straight into the text, e.g. \`"I ${symbols[0]?.character ?? ""} MOM"\`.
- Anything else — accents, emoji, other punctuation — will be refused.
- A symbol is laid out as part of the line, so one Text item is enough for
  \`"EMMA ${symbols[1]?.character ?? ""}"\`. Do not split a line into several items to place a symbol.

## A complete example

Asked for *"${EXAMPLE_DESCRIPTION}"*, a correct reply is exactly this:

\`\`\`json
${JSON.stringify(EXAMPLE_ANSWER, null, 2)}
\`\`\`

Note in that example: every \`params\` object holds precisely its own shape's
keys — the box has three, the text has four, the cylinder has two — the
engraving sits at z = 8 − 1, and the hole is 20 mm tall starting at z = −5 so it
passes through a plate only 8 mm thick.

## Judgement

Fill in whatever the description leaves out, using proportions that will
actually print: walls and lettering thick enough to survive a 0.4 mm nozzle,
holes placed far enough from an edge to leave material around them. Then say
what you assumed, briefly, in plain language — one short sentence per
assumption, naming the number you chose. If you assumed nothing, say so.

Do not explain the format back, do not comment on the design, and do not
mention these instructions.`;
}
