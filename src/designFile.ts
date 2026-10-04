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
import type { ParamSpec, ParamValues, ShapeCatalogEntry } from "./shapes/shapeLibrary";

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

function checkNumber(value: unknown, spec: ParamSpec, where: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${where}: ${spec.label} must be a number, but it is ${JSON.stringify(value)}.`;
  }
  if (value < spec.min || value > spec.max) {
    const unit = spec.unit ?? " mm";
    return `${where}: ${spec.label} is ${value}${unit}, outside the allowed ${spec.min} to ${spec.max}${unit}.`;
  }
  return null;
}

const axisSpec = (key: "x" | "y" | "z"): ParamSpec => {
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
    const problem = checkNumber(raw.params[spec.key], spec, where);
    if (problem) return { problem };
    params[spec.key] = raw.params[spec.key] as number;
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

/**
 * Write the autosave slot.
 *
 * Swallows storage failures on purpose: a full quota or a private window should
 * cost you the convenience of autosave, not the ability to keep modelling.
 */
export function autosave(design: Design, store: DesignStore): void {
  try {
    store.setItem(AUTOSAVE_KEY, serialiseDesign(design));
  } catch {
    /* no autosave this time; the design in front of the user is unaffected */
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
