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
import {
  draw,
  drawCircle,
  drawPolysides,
  drawRectangle,
  drawText,
  isShape3D,
  makeSphere,
} from "replicad";
import type { Shape3D } from "replicad";
import {
  DEFAULT_FONT_ID,
  FONTS,
  assertFontCanDraw,
  emSizeForCapHeight,
  loadedFont,
} from "./fonts";

/** Bambu Lab A1 build volume. Nothing larger is worth modelling here. */
export const MAX_MM = 256;

/**
 * Smallest dimension we accept. Below one nozzle width there is nothing to
 * print, and OpenCascade gets unhappy with degenerate solids.
 */
const MIN_MM = 0.1;

/**
 * A parameter is a number, a line of text, or a choice from a fixed list.
 *
 * Discriminated on `kind` so the form, the file validator and the builders all
 * narrow the same way, and adding a fourth kind is a compiler error everywhere
 * it has not been handled rather than a silent fall-through.
 */
interface ParamSpecBase {
  key: string;
  label: string;
}

export interface NumberParamSpec extends ParamSpecBase {
  kind: "number";
  default: number;
  /** Inclusive. Zero only where a shape genuinely allows it (a cone's tip). */
  min: number;
  max: number;
  /** For validation messages. Millimetres unless stated — angles say so. */
  unit?: string;
  /** Keys this value must stay strictly below, e.g. a hole inside a plate. */
  lessThan?: string[];
  /**
   * A value this low still builds and still exports — it is just unlikely to
   * come out of the printer looking like what is on screen. The form says so
   * and gets out of the way; nothing is blocked.
   */
  warnBelow?: { value: number; message: string };
}

export interface TextParamSpec extends ParamSpecBase {
  kind: "text";
  default: string;
  /** A cap on length, so one runaway paste cannot stall the kernel. */
  maxLength: number;
}

export interface ChoiceParamSpec extends ParamSpecBase {
  kind: "choice";
  default: string;
  /** The only accepted values. Serialisable, so the UI can build a dropdown. */
  options: { value: string; label: string }[];
}

export type ParamSpec = NumberParamSpec | TextParamSpec | ChoiceParamSpec;

export type ParamValue = number | string;
export type ParamValues = Record<string, ParamValue>;

/** Values for a shape whose parameters are all numbers — every shape but Text. */
export type NumericValues = Record<string, number>;

export interface ShapeDef<V extends ParamValues = ParamValues> {
  id: string;
  label: string;
  params: ParamSpec[];
  build(v: V): Shape3D;
  /**
   * The volume this shape should have, from arithmetic alone, or `null` where
   * there is no closed form to compare against. The tests use it as each
   * shape's own specification, so it is a deliberate `null` rather than an
   * optional field — a missing formula should be a choice, not an oversight.
   */
  volumeMm3: ((v: V) => number) | null;
  /** The bounding box size this shape should have, from arithmetic alone. */
  boundingBoxMm(v: V): [number, number, number];
  /** Download name, without extension. */
  filename(v: V): string;
}

/** A plain, serialisable description of the library, for the UI. */
export interface ShapeCatalogEntry {
  id: string;
  label: string;
  params: ParamSpec[];
}

/** A linear dimension in millimetres, with the usual limits. */
const size = (key: string, label: string, def: number): NumberParamSpec => ({
  kind: "number",
  key,
  label,
  default: def,
  min: MIN_MM,
  max: MAX_MM,
});

/**
 * Declare a shape whose parameters are all numbers, which is every shape except
 * Text.
 *
 * The cast is the one place in the library where the type system is taken at
 * its word. It is sound because the only thing that ever calls `build` is a set
 * of values already validated against this entry's own `params` — by the form
 * in the sidebar, or by the file loader — so a numeric parameter cannot arrive
 * holding a string. Writing it once here keeps every entry able to destructure
 * its parameters by name instead of unwrapping each one.
 */
const numericShape = (def: ShapeDef<NumericValues>): ShapeDef => def as ShapeDef;

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

// --- text ------------------------------------------------------------------

/**
 * Longest string the Text shape accepts.
 *
 * Every glyph becomes its own closed outline, and the booleans that combine
 * them are the expensive part of a build. Eighty characters is far more than
 * fits on an A1 bed at a readable size, and keeps one runaway paste from
 * locking the kernel up for a minute.
 */
const TEXT_MAX_LENGTH = 80;

/** The Text shape's parameters, which are not all numbers. */
type TextValues = ParamValues & {
  text: string;
  letterHeight: number;
  depth: number;
  font: string;
};

/** As `numericShape`, for the one entry whose parameters are mixed. */
const textShape = (def: ShapeDef<TextValues>): ShapeDef => def as ShapeDef;

/**
 * Lay a string out as a drawing centred on the origin, and say how big the ink
 * is.
 *
 * Both the builder and the bounding-box formula need this, and it is where
 * every refusal lives, so a bad string fails the same way whichever asks.
 */
function layOutText({ text, letterHeight, font: fontId }: TextValues): {
  drawing: ReturnType<typeof drawText>;
  widthMm: number;
  heightMm: number;
} {
  if (text.length === 0) throw new Error("The text is empty. Type something to build.");
  if (text.trim().length === 0) {
    throw new Error("The text is only spaces, so there is no geometry to build.");
  }
  if (text.length > TEXT_MAX_LENGTH) {
    throw new Error(
      `The text is ${text.length} characters long; the limit is ${TEXT_MAX_LENGTH}.`,
    );
  }
  // Before anything is drawn: a character the font lacks would otherwise come
  // out as a solid rectangle rather than as an error. See fonts.ts.
  assertFontCanDraw(text, fontId);

  const font = loadedFont(fontId);
  const fontSize = emSizeForCapHeight(font, letterHeight);

  /*
   * The ink box comes from opentype, not from `drawing.boundingBox`.
   * OpenCascade's 2D box is generous around a Bézier — measured 0.03 mm wide on
   * "AK + 2 = ?" in Nunito — which would push the text off centre by half that.
   * opentype solves the curve extrema instead, and agrees with the extruded
   * solid to about 1e-4 mm.
   *
   * opentype measures y downward from the baseline while replicad's drawing
   * measures it upward, so the vertical centre changes sign on the way across.
   */
  const ink = font.getPath(text, 0, 0, fontSize).getBoundingBox();
  const drawing = drawText(text, { fontSize, fontFamily: fontId }).translate(
    -(ink.x1 + ink.x2) / 2,
    (ink.y1 + ink.y2) / 2,
  );

  return { drawing, widthMm: ink.x2 - ink.x1, heightMm: ink.y2 - ink.y1 };
}

/** A text value reduced to something that is safe in a filename. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "");
}

export const SHAPES: ShapeDef[] = [
  numericShape({
    id: "box",
    label: "Box",
    params: [size("width", "Width", 40), size("depth", "Depth", 30), size("height", "Height", 20)],
    build: ({ width, depth, height }) => extrude(drawRectangle(width, depth), height),
    volumeMm3: ({ width, depth, height }) => width * depth * height,
    boundingBoxMm: ({ width, depth, height }) => [width, depth, height],
    filename: ({ width, depth, height }) => `box-w${n(width)}-d${n(depth)}-h${n(height)}`,
  }),

  numericShape({
    id: "cylinder",
    label: "Cylinder",
    params: [size("diameter", "Diameter", 30), size("height", "Height", 40)],
    build: ({ diameter, height }) => extrude(drawCircle(diameter / 2), height),
    volumeMm3: ({ diameter, height }) => Math.PI * (diameter / 2) ** 2 * height,
    boundingBoxMm: ({ diameter, height }) => [diameter, diameter, height],
    filename: ({ diameter, height }) => `cylinder-d${n(diameter)}-h${n(height)}`,
  }),

  numericShape({
    id: "sphere",
    label: "Sphere",
    params: [size("diameter", "Diameter", 40)],
    // makeSphere centres on the origin, so lift it by a radius to rest on z = 0.
    build: ({ diameter }) => makeSphere(diameter / 2).translate([0, 0, diameter / 2]),
    volumeMm3: ({ diameter }) => (4 / 3) * Math.PI * (diameter / 2) ** 3,
    boundingBoxMm: ({ diameter }) => [diameter, diameter, diameter],
    filename: ({ diameter }) => `sphere-d${n(diameter)}`,
  }),

  numericShape({
    id: "cone",
    label: "Cone / frustum",
    params: [
      size("bottomDiameter", "Bottom diameter", 40),
      // The one parameter allowed to be zero: that is a pointed cone.
      {
        kind: "number",
        key: "topDiameter",
        label: "Top diameter (0 = pointed)",
        default: 0,
        min: 0,
        max: MAX_MM,
      },
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
  }),

  numericShape({
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
  }),

  numericShape({
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
  }),

  numericShape({
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
  }),

  textShape({
    id: "text",
    label: "Text",
    params: [
      { kind: "text", key: "text", label: "Text", default: "TEXT", maxLength: TEXT_MAX_LENGTH },
      {
        ...size("letterHeight", "Letter height (capital)", 10),
        warnBelow: {
          value: 5,
          message:
            "Under 5 mm, strokes get close to a single 0.4 mm extrusion — fine detail may not survive.",
        },
      },
      {
        ...size("depth", "Depth", 2),
        warnBelow: {
          value: 0.6,
          message: "Under 0.6 mm this is only two or three layers, so the text may barely show.",
        },
      },
      {
        kind: "choice",
        key: "font",
        label: "Font",
        default: DEFAULT_FONT_ID,
        options: FONTS.map(({ id, label }) => ({ value: id, label })),
      },
    ],

    /*
     * Extruded up from the XY plane, so the underside is on z = 0 like every
     * other shape and the letters stand proud of it. Cutting the same item into
     * a face engraves it instead, which is the whole point of letting text be
     * either operation — the geometry does not change, only what is done with
     * it.
     */
    build: (v) => extrude(layOutText(v).drawing, v.depth),

    /*
     * No formula. The area of a string of outlines has no closed form, so
     * instead of inventing one that the kernel would only be compared against,
     * text is tested on the properties that actually matter: adding it to a
     * plate increases the volume, cutting it decreases it, and more characters
     * take more room. See text.test.ts.
     */
    volumeMm3: null,

    /*
     * From the font's outlines rather than from the solid, so the test compares
     * two independent routes to the same number: opentype's curve arithmetic
     * against OpenCascade's extrusion.
     */
    boundingBoxMm: (v) => {
      const { widthMm, heightMm } = layOutText(v);
      return [widthMm, heightMm, v.depth];
    },

    /*
     * The text itself is in the name, because that is what distinguishes two
     * exports far more than the size does — but slugged, since the text may
     * hold spaces, punctuation, or nothing a filesystem will take.
     */
    filename: ({ text, letterHeight, depth, font }) => {
      const words = slug(text);
      return ["text", words, `h${n(letterHeight)}`, `d${n(depth)}`, font]
        .filter((part) => part !== "")
        .join("-");
    },
  }),
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
