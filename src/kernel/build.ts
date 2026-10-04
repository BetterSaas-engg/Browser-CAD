/**
 * Builds whatever the shape library describes, and tessellates it for display.
 * No worker, no DOM — so Vitest can drive it in plain Node once the caller has
 * handed replicad an OpenCascade instance via `setOC`.
 */
import { measureVolume } from "replicad";
import type { Shape3D } from "replicad";
import { shapeById } from "../shapes/shapeLibrary";
import type { ParamValues } from "../shapes/shapeLibrary";
import type { PartMesh } from "../mesh";

/**
 * How finely to tessellate for display. Fine enough that a 5 mm hole reads as
 * round. Display only — the kernel keeps the exact geometry, and STL export
 * tessellates separately and more finely.
 */
const MESH_OPTIONS = { tolerance: 0.01, angularTolerance: 0.1 } as const;

/** Tessellate a solid into the plain mesh format the viewport consumes. */
export function toPartMesh(shape: Shape3D): PartMesh {
  const { vertices, triangles, normals } = shape.mesh(MESH_OPTIONS);
  const { lines } = shape.meshEdges(MESH_OPTIONS);
  return {
    vertices: new Float32Array(vertices),
    triangles: new Uint32Array(triangles),
    normals: new Float32Array(normals),
    edges: new Float32Array(lines),
  };
}

/** Everything the page needs from a shape. */
export interface PartData {
  volumeMm3: number;
  mesh: PartMesh;
}

/**
 * Build a shape and derive both its volume and its display mesh. One function
 * rather than two so the solid is only constructed once — by far the expensive
 * step.
 */
export function buildShape(shapeId: string, params: ParamValues): PartData {
  const shape = shapeById(shapeId).build(params);
  return { volumeMm3: measureVolume(shape), mesh: toPartMesh(shape) };
}
