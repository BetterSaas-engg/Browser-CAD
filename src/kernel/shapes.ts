/**
 * Geometry only. No worker, no DOM — so this module can be exercised by Vitest
 * in plain Node, as long as the caller has already handed replicad an
 * OpenCascade instance via `setOC`.
 */
import { drawCircle, drawRectangle, isShape3D, measureVolume } from "replicad";
import type { Shape3D } from "replicad";

/** Nominal dimensions of the bite-1 tracer-bullet part, in millimetres. */
export const BOX_WITH_HOLE = {
  width: 40,
  depth: 30,
  height: 10,
  holeDiameter: 10,
} as const;

/**
 * The tracer-bullet part: a rectangular plate with one hole through its centre.
 *
 * Built as a 2D profile that is cut and then extruded, rather than as a
 * box-minus-cylinder boolean in 3D. Going via the profile makes the hole's
 * position follow from the drawing itself, so the result does not depend on
 * where replicad's 3D primitives happen to sit relative to the origin.
 */
export function makeBoxWithHole(): Shape3D {
  const { width, depth, height, holeDiameter } = BOX_WITH_HOLE;
  const profile = drawRectangle(width, depth).cut(drawCircle(holeDiameter / 2));
  const extruded = profile.sketchOnPlane("XY").extrude(height);

  // `extrude` is typed as "any shape": a degenerate profile could hand back a
  // wire or a vertex, which has no volume. Refuse it here rather than letting a
  // nonsense measurement through.
  if (!isShape3D(extruded)) {
    throw new Error(`Extrusion produced ${extruded.constructor.name}, not a solid`);
  }
  return extruded;
}

/**
 * What the volume should be from arithmetic alone: plate minus the cylindrical
 * hole. Kept here so the kernel's answer can be checked against a number we
 * derived independently of it.
 */
export function expectedVolumeMm3(): number {
  const { width, depth, height, holeDiameter } = BOX_WITH_HOLE;
  const plate = width * depth * height;
  const hole = Math.PI * (holeDiameter / 2) ** 2 * height;
  return plate - hole;
}

/** The part's volume as measured by the kernel, in mm³. */
export function measureBoxWithHoleVolumeMm3(): number {
  return measureVolume(makeBoxWithHole());
}
