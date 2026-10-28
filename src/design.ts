/**
 * What a design is: a plain list of placed shapes, each added to or cut from
 * the result so far.
 *
 * Deliberately JSON and nothing else — no classes, no ids, no functions. It can
 * be saved to a file, pasted into a prompt, or written by an AI, and it means
 * the same thing in all three cases. The UI holds one of these; the worker
 * receives a copy over postMessage.
 *
 * Coordinates are millimetres, Z up, matching the kernel.
 */
import type { NumberParamSpec, ParamSpec, ParamValues } from "./shapes/shapeLibrary";

export type Operation = "add" | "cut";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface DesignItem {
  /** An id from the shape library. */
  shapeId: string;
  /** That shape's own parameters, keyed as the library declares them. */
  params: ParamValues;
  /** Where to put it, before the design is re-seated on z = 0. */
  position: Vec3;
  /** Degrees counter-clockwise about Z, applied before the translation. */
  rotationZ: number;
  /** What to do with it. The first item is always "add" — see D22. */
  operation: Operation;
}

export interface Design {
  /** Always {@link DESIGN_VERSION} on anything this app writes. */
  version: number;
  items: DesignItem[];
}

/**
 * The format number carried by every saved design.
 *
 * Bump it whenever the meaning of the fields changes in a way that would make
 * an older file wrong rather than merely incomplete. A file whose version this
 * app does not recognise is refused outright rather than guessed at — see D28.
 */
export const DESIGN_VERSION = 1;

/**
 * How far from the origin an item may be placed. The build volume in each
 * direction, so a shape can sit anywhere on the bed — the design is re-seated
 * afterwards anyway, and the envelope is not checked as a whole.
 */
export const POSITION_LIMIT_MM = 256;

/**
 * The placement fields, described the same way the shape library describes its
 * parameters, so the form and its validation treat them identically.
 *
 * Typed as numbers specifically, not as the general `ParamSpec`: where an item
 * sits is always four numbers, whatever kinds of parameter its shape has.
 */
export const TRANSFORM_PARAMS: NumberParamSpec[] = [
  { kind: "number", key: "x", label: "Position X", default: 0, min: -POSITION_LIMIT_MM, max: POSITION_LIMIT_MM },
  { kind: "number", key: "y", label: "Position Y", default: 0, min: -POSITION_LIMIT_MM, max: POSITION_LIMIT_MM },
  { kind: "number", key: "z", label: "Position Z", default: 0, min: -POSITION_LIMIT_MM, max: POSITION_LIMIT_MM },
  { kind: "number", key: "rotationZ", label: "Rotation about Z", default: 0, min: -360, max: 360, unit: "°" },
];

export const OPERATIONS: { value: Operation; label: string }[] = [
  { value: "add", label: "Add" },
  { value: "cut", label: "Cut" },
];

/** An item at a shape's defaults, sitting on the origin, unrotated. */
export function newItem(shapeId: string, params: ParamValues, operation: Operation = "add"): DesignItem {
  return { shapeId, params, position: { x: 0, y: 0, z: 0 }, rotationZ: 0, operation };
}

/** Every parameter of a shape at its declared default. */
export function defaultParams(params: ParamSpec[]): ParamValues {
  return Object.fromEntries(params.map((p) => [p.key, p.default]));
}

/**
 * What you get on a first visit, and what New goes back to: one of the first
 * shape in the catalogue, at its defaults.
 */
export function defaultDesign(catalog: { id: string; params: ParamSpec[] }[]): Design {
  const [first] = catalog;
  if (!first) throw new Error("The shape catalogue is empty");
  return { version: DESIGN_VERSION, items: [newItem(first.id, defaultParams(first.params))] };
}

