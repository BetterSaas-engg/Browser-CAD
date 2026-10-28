/**
 * Turning an `.svg` file into an {@link Outline}.
 *
 * This runs **once, at import, in the page**, and the result is what gets
 * stored in the design and sent to the kernel. The kernel never sees SVG.
 *
 * No DOM. Not `DOMParser`, which does not exist in a Web Worker or in Node, and
 * not the page's document either — an imported file is never inserted anywhere
 * it could execute. The XML comes apart with `txml` and the path data with
 * `svgpath`, both pure JavaScript, so exactly this code runs in the browser and
 * under Vitest. See D43.
 *
 * Everything it will not handle, it refuses by name. Nothing is dropped
 * quietly: a drawing that half-imports is worse than one that does not.
 */
import svgpath from "svgpath";
import { parse as parseXml } from "txml";
import type { TNode } from "txml";
import {
  MAX_OUTLINE_CHARACTERS,
  flattenLoop,
  outlineBounds,
  outlineCharacters,
  pointInPolygon,
  signedArea,
} from "./outline";
import type { Outline, OutlineLoop, Point } from "./outline";

/**
 * Largest `.svg` we will read, in characters.
 *
 * Generous for anything hand-drawn or traced — a detailed traced drawing is
 * tens of kilobytes — and small enough that a pathological file cannot stall
 * the page before the size is even checked.
 */
export const MAX_SVG_CHARACTERS = 1_000_000;

/** Elements whose filled area we can extrude. */
const FILLABLE = ["path", "rect", "circle", "ellipse", "polygon"] as const;

/** Elements that only group or describe, and so contribute no geometry. */
const CONTAINERS = ["svg", "g"];

/**
 * Elements we skip without complaint, because they genuinely hold no drawing:
 * metadata, stylesheets, and definitions that only matter to a `<use>` — which
 * is itself refused, so nothing referenced from `<defs>` can go missing
 * unnoticed.
 */
const IGNORED = ["defs", "style", "title", "desc", "metadata", "clippath", "mask", "filter"];

/** How much of a drawing to quote back in an error message. */
const quote = (text: string, limit = 60): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** A loop as it comes off one element, before holes have been worked out. */
interface RawLoop {
  d: string;
  /** Which filled element it came from, so fill rules stay per-element. */
  element: number;
  fillRule: "nonzero" | "evenodd";
}

export interface ImportedOutline {
  outline: Outline;
  /** For the UI: how many loops and how many are holes. */
  summary: { loops: number; holes: number };
}

/**
 * Read an SVG file into an outline, or throw saying why not.
 */
export function importSvgOutline(svgText: string): ImportedOutline {
  if (svgText.length > MAX_SVG_CHARACTERS) {
    throw new Error(
      `This SVG is ${svgText.length.toLocaleString()} characters; the limit is ` +
        `${MAX_SVG_CHARACTERS.toLocaleString()}. Simplify the drawing and try again.`,
    );
  }
  if (svgText.trim() === "") throw new Error("That file is empty.");

  let nodes: (TNode | string)[];
  try {
    nodes = parseXml(svgText);
  } catch (error) {
    throw new Error(`This file is not valid XML: ${error instanceof Error ? error.message : error}`);
  }

  const root = findSvgRoot(nodes);
  if (!root) {
    throw new Error("No <svg> element in this file, so there is nothing to import.");
  }

  const raw: RawLoop[] = [];
  const counter = { elements: 0 };
  walk(root, [], "nonzero", raw, counter);

  if (raw.length === 0) {
    throw new Error(
      "This SVG has no filled shapes to extrude. Outlines drawn as strokes have no " +
        "area — in a vector editor, use Path → Stroke to Path (or Object → Expand) " +
        "and export again.",
    );
  }

  const loops = resolveHoles(raw);
  const outline = normalise({ loops });

  const characters = outlineCharacters(outline);
  if (characters > MAX_OUTLINE_CHARACTERS) {
    throw new Error(
      `This outline needs ${characters.toLocaleString()} characters of path data; a design ` +
        `allows ${MAX_OUTLINE_CHARACTERS.toLocaleString()}. Simplify the drawing — in a vector ` +
        "editor, Path → Simplify — and import it again.",
    );
  }

  return {
    outline,
    summary: { loops: outline.loops.length, holes: outline.loops.filter((l) => l.hole).length },
  };
}

function findSvgRoot(nodes: (TNode | string)[]): TNode | null {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (node.tagName.toLowerCase() === "svg") return node;
  }
  return null;
}

/** An element's tag, without any namespace prefix, lowercased. */
const tagOf = (node: TNode): string =>
  node.tagName.toLowerCase().replace(/^.*:/, "");

const attr = (node: TNode, name: string): string | null => {
  const value = node.attributes[name];
  return value === undefined || value === null ? null : value;
};

/** A length or coordinate attribute, defaulting when absent. */
function numberAttr(node: TNode, name: string, fallback: number): number {
  const raw = attr(node, name);
  if (raw === null || raw.trim() === "") return fallback;
  // Strip a unit suffix: `px` and friends are all the same user unit to us, and
  // a physical unit like `mm` is meaningless once `size` rescales the outline.
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`<${tagOf(node)}> has ${name}="${raw}", which is not a number.`);
  }
  return value;
}

/**
 * The effective `fill` and `fill-rule` for an element, from its own attributes
 * or its `style`, falling back to what it inherits.
 *
 * Deliberately shallow: `class` and a `<style>` sheet are not resolved, because
 * doing that properly means implementing CSS cascade and specificity. An
 * element whose fill arrives that way reads as unset, inherits, and so is
 * treated as filled — which is SVG's own default and the safe way to be wrong,
 * since the alternative is dropping a shape that should have been there.
 */
function styleOf(node: TNode): { fill: string | null; fillRule: string | null; stroke: string | null } {
  const style = attr(node, "style") ?? "";
  const declared = new Map<string, string>();
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    declared.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
  }
  // A `style` declaration beats a presentation attribute, as in CSS.
  return {
    fill: declared.get("fill") ?? attr(node, "fill"),
    fillRule: declared.get("fill-rule") ?? attr(node, "fill-rule"),
    stroke: declared.get("stroke") ?? attr(node, "stroke"),
  };
}

/**
 * Walk the tree, collecting the loops of every filled element.
 *
 * `transforms` holds the ancestors' `transform` attributes, innermost last.
 */
function walk(
  node: TNode,
  transforms: string[],
  inheritedFillRule: "nonzero" | "evenodd",
  out: RawLoop[],
  counter: { elements: number },
): void {
  const tag = tagOf(node);
  if (IGNORED.includes(tag)) return;

  const own = attr(node, "transform");
  const nested = own ? [...transforms, own] : transforms;

  const { fill, fillRule, stroke } = styleOf(node);
  const rule =
    fillRule === "evenodd" ? "evenodd" : fillRule === "nonzero" ? "nonzero" : inheritedFillRule;

  if (CONTAINERS.includes(tag)) {
    for (const child of node.children) {
      if (typeof child === "string") continue;
      // txml surfaces processing instructions and doctypes as nodes too.
      if (child.tagName.startsWith("?") || child.tagName.startsWith("!")) continue;
      walk(child, nested, rule, out, counter);
    }
    return;
  }

  if (!FILLABLE.includes(tag as (typeof FILLABLE)[number])) {
    throw new Error(
      `This SVG uses <${tag}>, which this app cannot import. It handles ` +
        `${FILLABLE.map((f) => `<${f}>`).join(", ")} and <g>. ` +
        (tag === "line" || tag === "polyline"
          ? "A line has no area to extrude — convert it to a filled outline first."
          : tag === "use" || tag === "text" || tag === "image"
            ? `In a vector editor, flatten or convert the <${tag}> to a path and export again.`
            : "Convert it to a path and export again."),
    );
  }

  // Fill `none` means there is no area, however the shape looks on screen.
  if (fill !== null && fill.trim().toLowerCase() === "none") {
    throw new Error(
      `A <${tag}> in this SVG is drawn as a stroke with no fill, so it has no area to ` +
        "extrude. Many icon sets are built this way. In a vector editor, use Path → " +
        "Stroke to Path (or Object → Expand), then export again." +
        (stroke ? "" : " (It has no stroke either, so it would not even be visible.)"),
    );
  }

  const element = counter.elements++;
  const d = pathDataFor(node, tag);

  // Curves and shorthands first, while the element is still in its own
  // coordinates, so transforms only ever apply to straight lines and cubics,
  // where they are exact. Then the ancestors' transforms innermost-first, and
  // finally the flip that turns SVG's downward Y into ours.
  let path = svgpath(d).abs().unshort().unarc();
  for (let i = nested.length - 1; i >= 0; i--) path = path.transform(nested[i]);
  path = path.matrix([1, 0, 0, -1, 0, 0]).abs();

  for (const loop of splitLoops(path.toString(), tag)) {
    out.push({ d: loop, element, fillRule: rule });
  }
}

/** The `d` of any fillable element, with the simple shapes written out. */
function pathDataFor(node: TNode, tag: string): string {
  switch (tag) {
    case "path": {
      const d = attr(node, "d");
      if (d === null || d.trim() === "") throw new Error("A <path> in this SVG has no d attribute.");
      return d;
    }

    case "rect": {
      const x = numberAttr(node, "x", 0);
      const y = numberAttr(node, "y", 0);
      const width = numberAttr(node, "width", 0);
      const height = numberAttr(node, "height", 0);
      if (width <= 0 || height <= 0) {
        throw new Error(`A <rect> in this SVG is ${width} x ${height}, so it has no area.`);
      }
      // Rounded corners are arcs; unarc turns them into curves later.
      const rx = Math.min(numberAttr(node, "rx", numberAttr(node, "ry", 0)), width / 2);
      const ry = Math.min(numberAttr(node, "ry", numberAttr(node, "rx", 0)), height / 2);
      if (rx > 0 && ry > 0) {
        return (
          `M${x + rx} ${y}H${x + width - rx}A${rx} ${ry} 0 0 1 ${x + width} ${y + ry}` +
          `V${y + height - ry}A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}` +
          `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + height - ry}` +
          `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
        );
      }
      return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
    }

    case "circle": {
      const r = numberAttr(node, "r", 0);
      if (r <= 0) throw new Error(`A <circle> in this SVG has r="${r}", so it has no area.`);
      return ellipsePath(numberAttr(node, "cx", 0), numberAttr(node, "cy", 0), r, r);
    }

    case "ellipse": {
      const rx = numberAttr(node, "rx", 0);
      const ry = numberAttr(node, "ry", 0);
      if (rx <= 0 || ry <= 0) {
        throw new Error(`An <ellipse> in this SVG has rx="${rx}" ry="${ry}", so it has no area.`);
      }
      return ellipsePath(numberAttr(node, "cx", 0), numberAttr(node, "cy", 0), rx, ry);
    }

    case "polygon": {
      const points = parsePoints(attr(node, "points"), tag);
      if (points.length < 3) {
        throw new Error(`A <polygon> in this SVG has ${points.length} points, so it has no area.`);
      }
      const [first, ...rest] = points;
      return `M${first[0]} ${first[1]}${rest.map(([x, y]) => `L${x} ${y}`).join("")}Z`;
    }

    default:
      throw new Error(`No path conversion for <${tag}>.`);
  }
}

/** An ellipse as two half arcs, which `unarc` then turns into curves. */
const ellipsePath = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}Z`;

function parsePoints(raw: string | null, tag: string): Point[] {
  if (raw === null || raw.trim() === "") throw new Error(`A <${tag}> in this SVG has no points.`);
  const numbers = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) {
    throw new Error(`A <${tag}> in this SVG has points that are not numbers: ${quote(raw)}`);
  }
  if (numbers.length % 2 !== 0) {
    throw new Error(`A <${tag}> in this SVG has an odd number of coordinates.`);
  }
  const points: Point[] = [];
  for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  return points;
}

/** Points closer together than this are the same point, in SVG user units. */
const SAME_POINT = 1e-9;

/**
 * Split normalised path data into closed loops, one string each.
 *
 * Also where H and V become L and Q becomes C, so what comes out uses only the
 * three commands {@link readLoop} accepts. The quadratic conversion is exact —
 * every quadratic is a cubic whose controls sit two-thirds of the way out.
 *
 * Subpaths left open are closed, which is what SVG does when it fills them.
 */
function splitLoops(d: string, tag: string): string[] {
  const loops: string[] = [];
  let parts: string[] = [];
  /** Edges drawn since the last M; Z adds one more, closing the loop. */
  let edges = 0;
  let curved = false;
  let current: Point = [0, 0];
  let start: Point = [0, 0];

  const finish = (): void => {
    if (parts.length === 0) return;
    // Three straight edges are the fewest that enclose anything, but a single
    // curve plus the chord that closes it is a perfectly good lens.
    const enough = curved ? edges + 1 >= 2 : edges + 1 >= 3;
    if (!enough) {
      throw new Error(
        `A <${tag}> in this SVG has a subpath of ${edges + 1} edge${edges === 0 ? "" : "s"}, ` +
          "so part of it has no area. This usually means the drawing is strokes rather " +
          "than filled outlines.",
      );
    }
    loops.push(`${parts.join(" ")} Z`);
    parts = [];
    edges = 0;
    curved = false;
  };

  const same = (a: Point, b: Point): boolean =>
    Math.abs(a[0] - b[0]) < SAME_POINT && Math.abs(a[1] - b[1]) < SAME_POINT;

  // Full precision here. Rounding happens once, in `normalise`, after the
  // outline has been scaled into its unit box — rounding first would throw away
  // real detail on a drawing whose source units happen to be small.
  const pair = ([x, y]: Point): string => `${x} ${y}`;

  svgpath(d).iterate((segment, _index, x, y) => {
    current = [x, y];
    switch (segment[0]) {
      case "M": {
        finish();
        start = [segment[1], segment[2]];
        parts.push(`M ${pair(start)}`);
        edges = 0;
        curved = false;
        return;
      }
      case "L":
      case "H":
      case "V": {
        const to: Point =
          segment[0] === "L"
            ? [segment[1], segment[2]]
            : segment[0] === "H"
              ? [segment[1], y]
              : [x, segment[1]];
        // A zero-length step is a no-op that OpenCascade would choke on.
        if (same(to, current)) return;
        parts.push(`L ${pair(to)}`);
        edges++;
        return;
      }
      case "C": {
        parts.push(`C ${pair([segment[1], segment[2]])} ${pair([segment[3], segment[4]])} ${pair([segment[5], segment[6]])}`);
        edges++;
        curved = true;
        return;
      }
      case "Q": {
        // Exact: c1 = p0 + 2/3 (q - p0), c2 = p2 + 2/3 (q - p2).
        const q: Point = [segment[1], segment[2]];
        const end: Point = [segment[3], segment[4]];
        const c1: Point = [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)];
        const c2: Point = [end[0] + (2 / 3) * (q[0] - end[0]), end[1] + (2 / 3) * (q[1] - end[1])];
        parts.push(`C ${pair(c1)} ${pair(c2)} ${pair(end)}`);
        edges++;
        curved = true;
        return;
      }
      case "Z":
      case "z": {
        finish();
        current = start;
        return;
      }
      default:
        // `abs().unshort().unarc()` should have removed everything else. If a
        // library update changes that, fail rather than lose a curve.
        throw new Error(
          `Could not normalise a <${tag}>: unexpected path command "${segment[0]}". ` +
            "This is a bug in browser-cad, not in your file.",
        );
    }
  });
  finish();

  if (loops.length === 0) {
    throw new Error(`A <${tag}> in this SVG produced no closed outline.`);
  }
  return loops;
}

/**
 * Work out which loops are holes.
 *
 * Done here, once, so the kernel receives an answer rather than a rule to
 * apply — requirement of keeping parsing at import. Nesting is computed per
 * element, because SVG fills each shape independently with its own fill rule
 * and then paints them over one another; mixing loops from two elements into
 * one parity count would be wrong whenever they overlap.
 *
 * - **evenodd**: a loop nested an odd number of deep is a hole.
 * - **nonzero**: a loop is a hole when it winds the opposite way to the loop
 *   immediately containing it.
 *
 * Both are exact for loops that do not cross themselves, which is what vector
 * editors and tracers produce. A self-intersecting subpath is the known gap:
 * its fill would need a real winding-number integration, and it is refused
 * nowhere — it simply may fill differently than a browser would draw it.
 */
function resolveHoles(raw: RawLoop[]): OutlineLoop[] {
  const measured = raw.map((loop) => {
    const polygon = flattenLoop(loop.d);
    return { ...loop, polygon, area: signedArea(polygon), size: Math.abs(signedArea(polygon)) };
  });

  const resolved: { loop: OutlineLoop; element: number; depth: number }[] = [];

  for (const candidate of measured) {
    // Only loops from the same element can nest, for the reason above.
    const siblings = measured.filter(
      (other) => other !== candidate && other.element === candidate.element,
    );
    const containing = siblings.filter(
      (other) => other.size > candidate.size && pointInPolygon(candidate.polygon[0], other.polygon),
    );

    const depth = containing.length;
    // The immediate parent is the smallest loop that still contains this one.
    const parent = containing.sort((a, b) => a.size - b.size)[0];

    const hole =
      candidate.fillRule === "evenodd"
        ? depth % 2 === 1
        : parent !== undefined && Math.sign(candidate.area) !== Math.sign(parent.area);

    resolved.push({ loop: { d: candidate.d, hole }, element: candidate.element, depth });
  }

  // Element by element in paint order, and shallowest first within each, so a
  // hole is never cut before the material it belongs to has been placed.
  resolved.sort((a, b) => a.element - b.element || a.depth - b.depth);
  return resolved.map((entry) => entry.loop);
}

/**
 * Move and scale an outline so its bounding box is centred on the origin with
 * its longer side exactly 1.
 *
 * This is what makes the stored data say nothing about size: the shape's `size`
 * parameter is the only thing that decides how many millimetres across the
 * result is, and the aspect ratio is carried by the shorter side being less
 * than 1.
 */
function normalise(outline: Outline): Outline {
  const bounds = outlineBounds(outline);
  const longer = Math.max(bounds.width, bounds.height);
  if (!(longer > 0)) {
    throw new Error("This outline has no width or height, so there is nothing to extrude.");
  }

  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  const scale = 1 / longer;

  const loops = outline.loops.map((loop) => ({
    hole: loop.hole,
    d: formatLoop(svgpath(loop.d).translate(-centreX, -centreY).scale(scale).toString()),
  }));

  return { loops };
}

/**
 * Write path data out with every command named and every number rounded.
 *
 * svgpath's own `toString` leans on SVG's implicit repetition and packs numbers
 * against each other — `C-10-5.52-5.52-10 0-10` is valid and unreadable. A
 * design file is meant to be opened and diffed (D23), so each command gets its
 * letter and each number a space.
 *
 * Six decimals on a box whose longer side is 1 resolves to 40 nanometres on a
 * 40 mm part, which is four orders of magnitude below anything printable.
 */
function formatLoop(d: string): string {
  const parts: string[] = [];
  const n = (value: number): string => {
    const rounded = Number(value.toFixed(6));
    return String(Object.is(rounded, -0) ? 0 : rounded);
  };
  const pair = (x: number, y: number): string => `${n(x)} ${n(y)}`;

  svgpath(d)
    .abs()
    .iterate((segment) => {
      switch (segment[0]) {
        case "M":
          parts.push(`M ${pair(segment[1], segment[2])}`);
          return;
        case "L":
          parts.push(`L ${pair(segment[1], segment[2])}`);
          return;
        case "C":
          parts.push(
            `C ${pair(segment[1], segment[2])} ${pair(segment[3], segment[4])} ` +
              `${pair(segment[5], segment[6])}`,
          );
          return;
        case "Z":
        case "z":
          return;
        default:
          throw new Error(
            `Cannot write path command "${segment[0]}" into a design. ` +
              "This is a bug in browser-cad, not in your file.",
          );
      }
    });

  return `${parts.join(" ")} Z`;
}
