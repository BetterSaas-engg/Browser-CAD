/**
 * Geometry only. No worker, no DOM — so this module can be exercised by Vitest
 * in plain Node, as long as the caller has already handed replicad an
 * OpenCascade instance via `setOC`.
 */
import { drawCircle, drawRectangle, isShape3D, measureVolume } from "replicad";
import type { Shape3D } from "replicad";
import type { PartMesh } from "../mesh";

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

/**
 * How finely to tessellate for display, in millimetres and radians. The hole's
 * 5 mm radius is the tightest curve on the part, so these are set fine enough
 * that it reads as round rather than faceted. Display only — the kernel keeps
 * the exact geometry, so nothing downstream inherits this approximation.
 */
const MESH_OPTIONS = { tolerance: 0.01, angularTolerance: 0.1 } as const;

/** Tessellate a solid into the plain mesh format the viewport consumes. */
function toPartMesh(shape: Shape3D): PartMesh {
  const { vertices, triangles, normals } = shape.mesh(MESH_OPTIONS);
  const { lines } = shape.meshEdges(MESH_OPTIONS);
  return {
    vertices: new Float32Array(vertices),
    triangles: new Uint32Array(triangles),
    normals: new Float32Array(normals),
    edges: new Float32Array(lines),
  };
}

/** Everything the page needs from the part. */
export interface PartData {
  volumeMm3: number;
  mesh: PartMesh;
}

/**
 * Build the part and derive both its volume and its display mesh.
 *
 * One function rather than two so the solid is only constructed once — it is
 * by far the expensive step.
 */
export function buildBoxWithHole(): PartData {
  const shape = makeBoxWithHole();
  return { volumeMm3: measureVolume(shape), mesh: toPartMesh(shape) };
}
