/**
 * The shape library. Every shape is defined once, here: its parameters, their
 * defaults and limits, how to build it, what its volume and bounding box
 * should be, and what to call its exported file. Adding a shape means adding
 * one entry to SHAPES and nothing else.
 *
 * This module imports replicad, so the UI must not import it for anything but
 * types — see `catalog()`, which the worker sends across as plain data.
 *
 * Conventions every shape must honour: millimetres, Z up, sitting on z = 0,
 * and centred on the origin in X and Y.
 */
import { draw, drawCircle, drawPolysides, drawRectangle, isShape3D, makeSphere } from "replicad";
import type { Shape3D } from "replicad";

/** Bambu Lab A1 build volume. Nothing larger is worth modelling here. */
export const MAX_MM = 256;

/**
 * Smallest dimension we accept. Below one nozzle width there is nothing to
 * print, and OpenCascade gets unhappy with degenerate solids.
 */
const MIN_MM = 0.1;

export interface ParamSpec {
  key: string;
  label: string;
  default: number;
  /** Inclusive. Zero only where a shape genuinely allows it (a cone's tip). */
  min: number;
  max: number;
  /** For validation messages. Millimetres unless stated — angles say so. */
  unit?: string;
  /** Keys this value must stay strictly below, e.g. a hole inside a plate. */
  lessThan?: string[];
}

export type ParamValues = Record<string, number>;

export interface ShapeDef {
  id: string;
  label: string;
  params: ParamSpec[];
  build(v: ParamValues): Shape3D;
  /** The volume this shape should have, from arithmetic alone. */
  volumeMm3(v: ParamValues): number;
  /** The bounding box size this shape should have, from arithmetic alone. */
  boundingBoxMm(v: ParamValues): [number, number, number];
  /** Download name, without extension. */
  filename(v: ParamValues): string;
}

/** A plain, serialisable description of the library, for the UI. */
export interface ShapeCatalogEntry {
  id: string;
  label: string;
  params: ParamSpec[];
}

/** A linear dimension in millimetres, with the usual limits. */
const size = (key: string, label: string, def: number): ParamSpec => ({
  key,
  label,
  default: def,
  min: MIN_MM,
  max: MAX_MM,
});

/** Trim float noise so 20 reads as "20" and 20.5 as "20.5". */
const n = (x: number): string => String(Number(x.toFixed(3)));

/** Extrude a closed 2D drawing up from the XY plane. */
function extrude(drawing: ReturnType<typeof drawCircle>, height: number): Shape3D {
  const solid = drawing.sketchOnPlane("XY").extrude(height);
  if (!isShape3D(solid)) {
    throw new Error(`Extrusion produced ${solid.constructor.name}, not a solid`);
  }
  return solid;
}

/**
 * A cone or frustum, as a profile revolved about Z.
 *
 * Revolving rather than lofting between two circles, because it degenerates
 * cleanly: a zero top diameter just makes the profile a triangle instead of a
 * trapezium, so the pointed case needs no special handling in the kernel.
 */
function revolveCone(bottomRadius: number, topRadius: number, height: number): Shape3D {
  const profile =
    topRadius > 0
      ? draw([0, 0]).lineTo([bottomRadius, 0]).lineTo([topRadius, height]).lineTo([0, height]).close()
      : draw([0, 0]).lineTo([bottomRadius, 0]).lineTo([0, height]).close();

  const solid = profile.sketchOnPlane("XZ").revolve([0, 0, 1]);
  if (!isShape3D(solid)) {
    throw new Error(`Revolution produced ${solid.constructor.name}, not a solid`);
  }
  return solid;
}

const SQRT3 = Math.sqrt(3);

export const SHAPES: ShapeDef[] = [
  {
    id: "box",
    label: "Box",
    params: [size("width", "Width", 40), size("depth", "Depth", 30), size("height", "Height", 20)],
    build: ({ width, depth, height }) => extrude(drawRectangle(width, depth), height),
    volumeMm3: ({ width, depth, height }) => width * depth * height,
    boundingBoxMm: ({ width, depth, height }) => [width, depth, height],
    filename: ({ width, depth, height }) => `box-w${n(width)}-d${n(depth)}-h${n(height)}`,
  },

  {
    id: "cylinder",
    label: "Cylinder",
    params: [size("diameter", "Diameter", 30), size("height", "Height", 40)],
    build: ({ diameter, height }) => extrude(drawCircle(diameter / 2), height),
    volumeMm3: ({ diameter, height }) => Math.PI * (diameter / 2) ** 2 * height,
    boundingBoxMm: ({ diameter, height }) => [diameter, diameter, height],
    filename: ({ diameter, height }) => `cylinder-d${n(diameter)}-h${n(height)}`,
  },

  {
    id: "sphere",
    label: "Sphere",
    params: [size("diameter", "Diameter", 40)],
    // makeSphere centres on the origin, so lift it by a radius to rest on z = 0.
    build: ({ diameter }) => makeSphere(diameter / 2).translate([0, 0, diameter / 2]),
    volumeMm3: ({ diameter }) => (4 / 3) * Math.PI * (diameter / 2) ** 3,
    boundingBoxMm: ({ diameter }) => [diameter, diameter, diameter],
    filename: ({ diameter }) => `sphere-d${n(diameter)}`,
  },

  {
    id: "cone",
    label: "Cone / frustum",
    params: [
      size("bottomDiameter", "Bottom diameter", 40),
      // The one parameter allowed to be zero: that is a pointed cone.
      { key: "topDiameter", label: "Top diameter (0 = pointed)", default: 0, min: 0, max: MAX_MM },
      size("height", "Height", 50),
    ],
    build: ({ bottomDiameter, topDiameter, height }) =>
      revolveCone(bottomDiameter / 2, topDiameter / 2, height),
    volumeMm3: ({ bottomDiameter, topDiameter, height }) => {
      const R = bottomDiameter / 2;
      const r = topDiameter / 2;
      return ((Math.PI * height) / 3) * (R * R + R * r + r * r);
    },
    boundingBoxMm: ({ bottomDiameter, topDiameter, height }) => {
      const across = Math.max(bottomDiameter, topDiameter);
      return [across, across, height];
    },
    filename: ({ bottomDiameter, topDiameter, height }) =>
      `cone-d${n(bottomDiameter)}-t${n(topDiameter)}-h${n(height)}`,
  },

  {
    id: "triangular-prism",
    label: "Triangular prism",
    params: [size("side", "Side length", 40), size("height", "Height", 30)],
    // drawPolysides takes a circumradius; for an equilateral triangle that is
    // side / sqrt(3). It points its vertex toward +Y, which leaves the centroid
    // on the origin but the bounding box off-centre in Y — see boundingBoxMm.
    build: ({ side, height }) => extrude(drawPolysides(side / SQRT3, 3), height),
    volumeMm3: ({ side, height }) => (SQRT3 / 4) * side * side * height,
    boundingBoxMm: ({ side, height }) => [side, (side * SQRT3) / 2, height],
    filename: ({ side, height }) => `triangular-prism-s${n(side)}-h${n(height)}`,
  },

  {
    id: "hexagonal-prism",
    label: "Hexagonal prism",
    params: [size("acrossFlats", "Width across flats", 40), size("height", "Height", 30)],
    // Across-flats is twice the apothem, so the circumradius is AF / sqrt(3).
    // replicad orients the hexagon with its flats facing X, so across-flats is
    // the X extent and across-corners (2 x circumradius) is the Y extent.
    build: ({ acrossFlats, height }) => extrude(drawPolysides(acrossFlats / SQRT3, 6), height),
    volumeMm3: ({ acrossFlats, height }) => (SQRT3 / 2) * acrossFlats * acrossFlats * height,
    boundingBoxMm: ({ acrossFlats, height }) => [acrossFlats, (2 * acrossFlats) / SQRT3, height],
    filename: ({ acrossFlats, height }) => `hex-prism-af${n(acrossFlats)}-h${n(height)}`,
  },

  {
    id: "plate-with-hole",
    label: "Plate with hole",
    params: [
      size("width", "Width", 40),
      size("depth", "Depth", 30),
      size("height", "Height", 10),
      { ...size("holeDiameter", "Hole diameter", 10), lessThan: ["width", "depth"] },
    ],
    build: ({ width, depth, height, holeDiameter }) =>
      extrude(drawRectangle(width, depth).cut(drawCircle(holeDiameter / 2)), height),
    volumeMm3: ({ width, depth, height, holeDiameter }) =>
      width * depth * height - Math.PI * (holeDiameter / 2) ** 2 * height,
    boundingBoxMm: ({ width, depth, height }) => [width, depth, height],
    filename: ({ width, depth, height, holeDiameter }) =>
      `plate-w${n(width)}-d${n(depth)}-h${n(height)}-hole${n(holeDiameter)}`,
  },
];

export function shapeById(id: string): ShapeDef {
  const shape = SHAPES.find((s) => s.id === id);
  if (!shape) throw new Error(`Unknown shape "${id}"`);
  return shape;
}

/** The library as plain data the UI can be handed over postMessage. */
export function catalog(): ShapeCatalogEntry[] {
  return SHAPES.map(({ id, label, params }) => ({ id, label, params }));
}

/** Every parameter at its default, for one shape. */
export function defaultsFor(shape: ShapeCatalogEntry | ShapeDef): ParamValues {
  return Object.fromEntries(shape.params.map((p) => [p.key, p.default]));
}
