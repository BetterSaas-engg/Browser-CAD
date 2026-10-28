/**
 * What an imported outline is, once it has been through the importer.
 *
 * Deliberately small and dull: closed loops of straight lines and cubic curves,
 * as plain strings, plus a flag saying which ones are holes. No SVG, no markup,
 * no elements, no styling — nothing that could carry a script into a design
 * file (D23). The kernel reads this and never sees an `.svg`.
 *
 * Coordinates are **unit-normalised**: the outline's bounding box is centred on
 * the origin with its longer side exactly 1, and Y points up as it does
 * everywhere else in this app. The shape's `size` parameter then scales it to
 * millimetres, so the stored data says nothing about how big the part is.
 *
 * No DOM and no kernel here, so Vitest can drive all of it in plain Node.
 */
import svgpath from "svgpath";

export type Point = [number, number];

/**
 * Largest outline we will put *in a design*, in characters of path data.
 *
 * A design has to fit in `localStorage` alongside everything else, where the
 * usual budget is about 5 MB for the whole origin, and D23 wants it to stay
 * something you can paste into a prompt. 128,000 characters is roughly 4,000
 * curve segments — far more detail than a 0.4 mm nozzle can resolve — and
 * leaves room for a design holding several of them.
 */
export const MAX_OUTLINE_CHARACTERS = 128_000;

/**
 * One closed loop, normalised to the three commands the kernel can draw:
 * `M` once at the start, then `L` and `C`, then `Z`.
 */
export interface OutlineLoop {
  d: string;
  /** True where this loop takes material out of the loop containing it. */
  hole: boolean;
}

export interface Outline {
  /**
   * Loops in the order they must be applied: within each filled element,
   * outermost first, so a hole is cut only after the material it sits in has
   * been placed.
   */
  loops: OutlineLoop[];
}

/** A straight or curved step along a loop, with absolute coordinates. */
export type OutlineSegment =
  | { kind: "move"; to: Point }
  | { kind: "line"; to: Point }
  | { kind: "cubic"; c1: Point; c2: Point; to: Point };

/**
 * Read a normalised loop back into segments.
 *
 * Strict on purpose: anything beyond `M`, `L`, `C` and `Z` is a bug in the
 * importer or a hand-edited design, and either way the kernel should say so
 * rather than quietly drop a curve.
 */
export function readLoop(d: string): OutlineSegment[] {
  const segments: OutlineSegment[] = [];
  let sawMove = false;

  svgpath(d).iterate((segment) => {
    const [command] = segment;
    switch (command) {
      case "M": {
        if (sawMove) {
          throw new Error(`A loop must hold one subpath, but "${abbreviate(d)}" has several.`);
        }
        sawMove = true;
        segments.push({ kind: "move", to: [segment[1], segment[2]] });
        return;
      }
      case "L":
        segments.push({ kind: "line", to: [segment[1], segment[2]] });
        return;
      case "C":
        segments.push({
          kind: "cubic",
          c1: [segment[1], segment[2]],
          c2: [segment[3], segment[4]],
          to: [segment[5], segment[6]],
        });
        return;
      case "Z":
      case "z":
        return;
      default:
        throw new Error(
          `Outline data may only use M, L, C and Z, but "${abbreviate(d)}" uses ${command}.`,
        );
    }
  });

  if (!sawMove) throw new Error(`Outline loop "${abbreviate(d)}" does not start with M.`);
  if (!enclosesArea(segments)) {
    throw new Error(`Outline loop "${abbreviate(d)}" has no area — it is a point or a line.`);
  }
  return segments;
}

/**
 * Whether a closed loop can enclose anything.
 *
 * The boundary is the segments drawn plus the straight line Z adds back to the
 * start. Three straight edges are the fewest that can enclose area — but only
 * two are needed if one of them bends, since a single curve and the chord
 * closing it make a perfectly good lens. Demanding three either way rejects
 * shapes that are entirely legitimate.
 */
function enclosesArea(segments: OutlineSegment[]): boolean {
  const drawn = segments.filter((segment) => segment.kind !== "move");
  const edges = drawn.length + 1; // + the closing line
  return drawn.some((segment) => segment.kind === "cubic") ? edges >= 2 : edges >= 3;
}

const abbreviate = (d: string): string => (d.length > 40 ? `${d.slice(0, 40)}…` : d);

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * The exact bounding box of an outline.
 *
 * Exact rather than sampled: a cubic's extremes are found by solving its
 * derivative, so a curve that bulges between its control points is measured
 * where it actually bulges. The control-point hull would be too generous, which
 * would show up as the shape being scaled slightly too small.
 */
export function outlineBounds(outline: Outline): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = ([x, y]: Point): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  for (const loop of outline.loops) {
    let current: Point = [0, 0];
    for (const segment of readLoop(loop.d)) {
      if (segment.kind === "cubic") {
        include(current);
        include(segment.to);
        for (const axis of [0, 1] as const) {
          for (const t of cubicExtrema(current[axis], segment.c1[axis], segment.c2[axis], segment.to[axis])) {
            const point: Point = [
              cubicAt(t, current[0], segment.c1[0], segment.c2[0], segment.to[0]),
              cubicAt(t, current[1], segment.c1[1], segment.c2[1], segment.to[1]),
            ];
            include(point);
          }
        }
      } else {
        include(segment.to);
      }
      current = segment.to;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    throw new Error("This outline has no points, so it has no size.");
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** A cubic Bézier evaluated at t. */
export function cubicAt(t: number, p0: number, c1: number, c2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3;
}

/**
 * Where a cubic turns back on itself, on one axis: the roots of its derivative
 * that lie strictly inside the segment. The endpoints are handled by the
 * caller, so they are deliberately not returned here.
 */
function cubicExtrema(p0: number, c1: number, c2: number, p3: number): number[] {
  // B'(t)/3 = a t² + b t + c
  const a = p3 - 3 * c2 + 3 * c1 - p0;
  const b = 2 * (c2 - 2 * c1 + p0);
  const c = c1 - p0;

  const inside = (t: number): boolean => t > 0 && t < 1;

  // Nearly linear in this axis: one root, if any.
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return [];
    return [-c / b].filter(inside);
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)].filter(inside);
}

/**
 * Flatten a loop into a polyline.
 *
 * Only ever used for questions about *topology* — which loop sits inside which,
 * and which way round a loop runs. Never for geometry: the loops that reach the
 * kernel keep their exact curves.
 */
export function flattenLoop(d: string, perCurve = 16): Point[] {
  const points: Point[] = [];
  let current: Point = [0, 0];

  for (const segment of readLoop(d)) {
    if (segment.kind === "cubic") {
      for (let step = 1; step <= perCurve; step++) {
        const t = step / perCurve;
        points.push([
          cubicAt(t, current[0], segment.c1[0], segment.c2[0], segment.to[0]),
          cubicAt(t, current[1], segment.c1[1], segment.c2[1], segment.to[1]),
        ]);
      }
    } else {
      points.push(segment.to);
    }
    current = segment.to;
  }
  return points;
}

/**
 * Twice the signed area of a polyline, by the shoelace formula. The sign is the
 * winding direction, which is what the nonzero fill rule turns on; the
 * magnitude only gets used to decide which of two nested loops is the outer.
 */
export function signedArea(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

/** Whether a point is inside a polyline, by casting a ray and counting crossings. */
export function pointInPolygon([x, y]: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Total characters of path data, which is what the size cap is measured in. */
export function outlineCharacters(outline: Outline): number {
  return outline.loops.reduce((total, loop) => total + loop.d.length, 0);
}
