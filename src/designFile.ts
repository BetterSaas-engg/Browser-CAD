/**
 * Reading and writing designs: validation, JSON, and the autosave slot.
 *
 * No DOM and no kernel. It validates against the plain-data shape catalogue the
 * worker hands over, so it can run in the page without pulling replicad in, and
 * in Vitest without a browser.
 *
 * The rule throughout is that a design is either accepted exactly as written or
 * refused with a reason. Nothing is repaired, defaulted, or dropped on the way
 * in — a file that loses an item silently is worse than one that will not load.
 */
import { DESIGN_VERSION, TRANSFORM_PARAMS } from "./design";
import type { Design, DesignItem, Operation, Vec3 } from "./design";
import type {
  ChoiceParamSpec,
  NumberParamSpec,
  ParamSpec,
  ParamValue,
  ParamValues,
  ShapeCatalogEntry,
  TextParamSpec,
} from "./shapes/shapeLibrary";

/** Where the autosave lives. Namespaced so it cannot collide on localhost. */
export const AUTOSAVE_KEY = "browser-cad:design:v1";

/** Just the part of the Storage API we use, so tests can pass a fake. */
export interface DesignStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LoadResult =
  | { ok: true; design: Design }
  | { ok: false; problem: string };

const fail = (problem: string): LoadResult => ({ ok: false, problem });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** List unexpected keys, so a typo is reported rather than quietly ignored. */
function unknownKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function checkNumber(value: unknown, spec: NumberParamSpec, where: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${where}: ${spec.label} must be a number, but it is ${JSON.stringify(value)}.`;
  }
  if (value < spec.min || value > spec.max) {
    const unit = spec.unit ?? " mm";
    return `${where}: ${spec.label} is ${value}${unit}, outside the allowed ${spec.min} to ${spec.max}${unit}.`;
  }
  return null;
}

function checkText(value: unknown, spec: TextParamSpec, where: string): string | null {
  if (typeof value !== "string") {
    return `${where}: ${spec.label} must be a string, but it is ${JSON.stringify(value)}.`;
  }
  // Blank is refused rather than quietly accepted. There is no geometry in an
  // empty string, and substituting something would be inventing content the
  // file did not ask for (D29).
  if (value.trim() === "") {
    return `${where}: ${spec.label} is blank, so there is nothing to build.`;
  }
  if (value.length > spec.maxLength) {
    return `${where}: ${spec.label} is ${value.length} characters, over the ${spec.maxLength} allowed.`;
  }
  // Deliberately not checked here: whether the chosen font can draw every
  // character. Only the kernel has the font — see fonts.ts, assertFontCanDraw.
  return null;
}

function checkChoice(value: unknown, spec: ChoiceParamSpec, where: string): string | null {
  if (typeof value !== "string") {
    return `${where}: ${spec.label} must be a string, but it is ${JSON.stringify(value)}.`;
  }
  if (!spec.options.some((option) => option.value === value)) {
    const known = spec.options.map((option) => option.value).join(", ");
    return `${where}: unknown ${spec.label.toLowerCase()} ${JSON.stringify(value)}. This app has: ${known}.`;
  }
  return null;
}

/** Check one value against its own spec, whatever kind of parameter it is. */
function checkParam(value: unknown, spec: ParamSpec, where: string): string | null {
  switch (spec.kind) {
    case "number":
      return checkNumber(value, spec, where);
    case "text":
      return checkText(value, spec, where);
    case "choice":
      return checkChoice(value, spec, where);
  }
}

const axisSpec = (key: "x" | "y" | "z"): NumberParamSpec => {
  const spec = TRANSFORM_PARAMS.find((p) => p.key === key);
  if (!spec) throw new Error(`TRANSFORM_PARAMS is missing "${key}"`);
  return spec;
};

/** Validate one item, returning either the item or the first problem with it. */
function readItem(
  raw: unknown,
  where: string,
  catalog: ShapeCatalogEntry[],
): { item: DesignItem } | { problem: string } {
  if (!isPlainObject(raw)) return { problem: `${where} is not an object.` };

  const extra = unknownKeys(raw, ["shapeId", "params", "position", "rotationZ", "operation"]);
  if (extra.length) return { problem: `${where} has unexpected fields: ${extra.join(", ")}.` };

  // --- shape ---
  if (typeof raw.shapeId !== "string") {
    return { problem: `${where}: shapeId must be a string.` };
  }
  const shape = catalog.find((s) => s.id === raw.shapeId);
  if (!shape) {
    const known = catalog.map((s) => s.id).join(", ");
    return { problem: `${where}: unknown shape "${raw.shapeId}". This app knows: ${known}.` };
  }

  // --- parameters ---
  if (!isPlainObject(raw.params)) return { problem: `${where}: params must be an object.` };
  const expected = shape.params.map((p) => p.key);
  const spurious = unknownKeys(raw.params, expected);
  if (spurious.length) {
    return { problem: `${where}: ${shape.label} has no parameter ${spurious.join(" or ")}.` };
  }
  const params: ParamValues = {};
  for (const spec of shape.params) {
    if (!(spec.key in raw.params)) {
      return { problem: `${where}: ${shape.label} is missing ${spec.label}.` };
    }
    const problem = checkParam(raw.params[spec.key], spec, where);
    if (problem) return { problem };
    params[spec.key] = raw.params[spec.key] as ParamValue;
  }

  // --- placement ---
  if (!isPlainObject(raw.position)) return { problem: `${where}: position must be an object.` };
  const axesExtra = unknownKeys(raw.position, ["x", "y", "z"]);
  if (axesExtra.length) {
    return { problem: `${where}: position has unexpected fields: ${axesExtra.join(", ")}.` };
  }
  const position = {} as Vec3;
  for (const axis of ["x", "y", "z"] as const) {
    const spec = axisSpec(axis);
    const problem = checkNumber(raw.position[axis], spec, where);
    if (problem) return { problem };
    position[axis] = raw.position[axis] as number;
  }

  const rotationSpec = TRANSFORM_PARAMS.find((p) => p.key === "rotationZ");
  if (!rotationSpec) throw new Error('TRANSFORM_PARAMS is missing "rotationZ"');
  const rotationProblem = checkNumber(raw.rotationZ, rotationSpec, where);
  if (rotationProblem) return { problem: rotationProblem };

  // --- operation ---
  if (raw.operation !== "add" && raw.operation !== "cut") {
    return { problem: `${where}: operation must be "add" or "cut", but it is ${JSON.stringify(raw.operation)}.` };
  }

  return {
    item: {
      shapeId: raw.shapeId,
      params,
      position,
      rotationZ: raw.rotationZ as number,
      operation: raw.operation as Operation,
    },
  };
}

/**
 * Check an unknown value really is a design this app can build, against the
 * live shape catalogue. Returns the design or the first thing wrong with it.
 */
export function validateDesign(value: unknown, catalog: ShapeCatalogEntry[]): LoadResult {
  if (!isPlainObject(value)) return fail("A design must be a JSON object.");

  const extra = unknownKeys(value, ["version", "items"]);
  if (extra.length) return fail(`Unexpected fields at the top level: ${extra.join(", ")}.`);

  if (!("version" in value)) {
    return fail(`No "version" field. This app writes version ${DESIGN_VERSION}.`);
  }
  if (value.version !== DESIGN_VERSION) {
    return fail(
      `This design is version ${JSON.stringify(value.version)}; ` +
        `this app reads version ${DESIGN_VERSION}.`,
    );
  }

  if (!Array.isArray(value.items)) return fail(`"items" must be an array.`);
  if (value.items.length === 0) return fail("A design needs at least one item.");

  const items: DesignItem[] = [];
  for (const [index, raw] of value.items.entries()) {
    const result = readItem(raw, `Item ${index + 1}`, catalog);
    if ("problem" in result) return fail(result.problem);
    items.push(result.item);
  }

  if (items[0].operation !== "add") {
    return fail("Item 1 is a Cut. The first item must be Add — there is nothing to cut from yet.");
  }

  return { ok: true, design: { version: DESIGN_VERSION, items } };
}

/** A design as the bytes that go in a file. Indented, because people read it. */
export function serialiseDesign(design: Design): string {
  return `${JSON.stringify(design, null, 2)}\n`;
}

/** Parse and validate in one step, distinguishing bad JSON from a bad design. */
export function parseDesign(text: string, catalog: ShapeCatalogEntry[]): LoadResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // Deliberately says nothing about where the text came from: the same
    // function reads files and the autosave slot, and the caller adds context.
    return fail(`Not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  return validateDesign(value, catalog);
}

export type SaveResult = { ok: true } | { ok: false; problem: string };

/**
 * Write the autosave slot, and say whether it worked.
 *
 * A failure is not fatal — a full quota or a private window costs you the
 * convenience of autosave, not the ability to keep modelling — so this returns
 * rather than throwing. But it does not swallow it either: silently stopping
 * saving is how an afternoon's work disappears on the next refresh, and the one
 * moment the user could have acted on it is while they are still in the tab.
 * The caller shows the notice (D31, revising D30).
 */
export function autosave(design: Design, store: DesignStore): SaveResult {
  try {
    store.setItem(AUTOSAVE_KEY, serialiseDesign(design));
    return { ok: true };
  } catch (error) {
    // Name the usual suspect. Browsers raise QuotaExceededError both when
    // storage is genuinely full and when a private window refuses to persist
    // at all, which are the two cases worth telling apart in the message.
    const name = error instanceof Error ? error.name : "";
    const cause =
      name === "QuotaExceededError"
        ? "browser storage is full, or this window does not allow it"
        : `the browser refused (${name || error})`;
    return { ok: false, problem: `Your work is not being saved automatically: ${cause}.` };
  }
}

export type RestoreResult =
  | { status: "restored"; design: Design }
  | { status: "empty" }
  | { status: "unreadable"; problem: string };

/**
 * Read the autosave slot back.
 *
 * A damaged entry is reported, not deleted: the caller falls back to a default
 * design, and the bad text stays where it is until the next real edit replaces
 * it. Throwing it away would destroy the only copy of whatever was in there.
 */
export function restoreAutosave(catalog: ShapeCatalogEntry[], store: DesignStore): RestoreResult {
  let text: string | null;
  try {
    text = store.getItem(AUTOSAVE_KEY);
  } catch (error) {
    return { status: "unreadable", problem: `Could not read saved work: ${error}` };
  }
  if (text === null || text.trim() === "") return { status: "empty" };

  const result = parseDesign(text, catalog);
  if (!result.ok) return { status: "unreadable", problem: result.problem };
  return { status: "restored", design: result.design };
}
