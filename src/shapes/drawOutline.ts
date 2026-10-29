/**
 * Turning an {@link Outline} into a replicad drawing.
 *
 * Two things need this and they want different placements: the Outline shape
 * scales by its longer side and centres on the origin, while a symbol inside a
 * line of text scales by its *height* and sits at a pen position on a baseline.
 * Both come down to the same loop-by-loop fold, so the placement is a transform
 * the caller supplies.
 */
import { draw } from "replicad";
import type { Drawing } from "replicad";
import { outlineBounds, readLoop } from "../svg/outline";
import type { Outline, Point } from "../svg/outline";

/** Where a point in outline coordinates ends up, in millimetres. */
export type Placement = (point: Point) => Point;

/**
 * Scale by the longer side and centre on the origin — what the Outline shape
 * wants, and what makes `size` mean the longer side in millimetres.
 *
 * The bounds are measured rather than assumed. The importer already normalises
 * an outline to a unit box, so for anything this app wrote this would be
 * `size` and the origin; but a hand-edited design, or one written by a model
 * (D16), has not been through the importer.
 */
export function centredBySize(outline: Outline, size: number): Placement {
  const bounds = outlineBounds(outline);
  const longer = Math.max(bounds.width, bounds.height);
  if (!(longer > 0)) {
    throw new Error("This outline has no width or height, so there is nothing to extrude.");
  }
  const scale = size / longer;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return ([x, y]) => [(x - cx) * scale, (y - cy) * scale];
}

/**
 * Scale by height, and put the outline's bottom-left corner at a given point —
 * what a symbol sitting in a line of text wants.
 */
export function placedByHeight(
  outline: Outline,
  heightMm: number,
  left: number,
  bottom: number,
): Placement {
  const bounds = outlineBounds(outline);
  if (!(bounds.height > 0)) {
    throw new Error("This outline has no height, so it cannot be sized by height.");
  }
  const scale = heightMm / bounds.height;
  return ([x, y]) => [left + (x - bounds.minX) * scale, bottom + (y - bounds.minY) * scale];
}

/** One closed loop as a replicad drawing. */
function drawLoop(d: string, at: Placement): Drawing {
  const segments = readLoop(d);
  const [first, ...rest] = segments;
  if (first.kind !== "move") throw new Error("An outline loop must begin with M.");

  let pen = draw(at(first.to));
  for (const segment of rest) {
    if (segment.kind === "cubic") {
      pen = pen.cubicBezierCurveTo(at(segment.to), at(segment.c1), at(segment.c2));
    } else if (segment.kind === "line") {
      pen = pen.lineTo(at(segment.to));
    } else {
      throw new Error("An outline loop may hold only one M.");
    }
  }
  // Closed rather than `done()`: a fill needs a closed wire, and SVG closes an
  // open subpath when it fills it too.
  return pen.close();
}

/**
 * Fold an outline's loops into one 2D drawing.
 *
 * The loops arrive in the order the importer worked out: within each filled
 * element, outermost first, so a hole is only ever cut from material that is
 * already there. The fill rule was resolved at import — by the time the kernel
 * sees it, a loop is simply material or a hole.
 */
export function drawOutline(outline: Outline, at: Placement): Drawing {
  if (outline.loops.length === 0) {
    throw new Error("This outline has no loops, so there is nothing to extrude.");
  }

  let result: Drawing | null = null;
  for (const [index, loop] of outline.loops.entries()) {
    const drawing = drawLoop(loop.d, at);
    if (result === null) {
      if (loop.hole) {
        throw new Error(
          "The first loop of an outline is marked as a hole, so there is nothing for it " +
            "to be a hole in.",
        );
      }
      result = drawing;
      continue;
    }
    try {
      result = loop.hole ? result.cut(drawing) : result.fuse(drawing);
    } catch (error) {
      throw new Error(
        `Could not ${loop.hole ? "cut" : "add"} loop ${index + 1} of this outline: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (result === null) throw new Error("This outline produced no geometry.");
  return result;
}
