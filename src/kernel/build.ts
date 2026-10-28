/**
 * Builds whatever the shape library describes, and tessellates it for display.
 * No worker, no DOM — so Vitest can drive it in plain Node once the caller has
 * handed replicad an OpenCascade instance via `setOC`.
 */
import { measureVolume } from "replicad";
import type { Shape3D } from "replicad";
import { shapeById } from "../shapes/shapeLibrary";
import type { ParamValues } from "../shapes/shapeLibrary";
import type { Design, DesignItem } from "../design";
import type { PartMesh } from "../mesh";
import { assertShapeIsSound, findMeshProblem } from "./soundness";

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

/** Build one item from the library and put it where the design says. */
function placeItem(item: DesignItem, index: number): Shape3D {
  const shape = shapeById(item.shapeId).build(item.params);
  // Checked before it is combined with anything, so the message can name the
  // item that is wrong rather than the design that contains it. A boolean
  // against invalid geometry produces nonsense without complaining.
  assertShapeIsSound(shape, `Item ${index + 1} (${item.operation} ${item.shapeId})`);
  // Rotate about the origin first, then translate — so position means "where
  // the shape's own origin ends up", regardless of how it is turned.
  const rotated = item.rotationZ ? shape.rotate(item.rotationZ, [0, 0, 0], [0, 0, 1]) : shape;
  const { x, y, z } = item.position;
  return x || y || z ? rotated.translate([x, y, z]) : rotated;
}

/**
 * Combine a design into a single solid.
 *
 * Items apply strictly in list order, each fused onto or subtracted from the
 * result so far, and the finished solid is dropped so its lowest point is on
 * z = 0 (D21).
 */
export function buildDesignShape(design: Design): Shape3D {
  const items = design.items;
  if (items.length === 0) {
    throw new Error("The design is empty. Add a shape to start.");
  }
  if (items[0].operation !== "add") {
    throw new Error("The first item must be added, not cut — there is nothing to cut from yet.");
  }

  let result = placeItem(items[0], 0);
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const piece = placeItem(item, i);
    result = item.operation === "add" ? result.fuse(piece) : result.cut(piece);

    // Check as we go rather than only at the end, so the message can name the
    // item that emptied the part. An empty result is a Compound whose
    // boundingBox throws, so this has to happen before anything measures it.
    if (measureVolume(result) <= 0) {
      throw new Error(
        `Item ${i + 1} (${item.operation} ${item.shapeId}) removed everything. ` +
          "Nothing is left to show.",
      );
    }
  }

  if (measureVolume(result) <= 0) {
    throw new Error("The design came out empty.");
  }

  // Re-seat on the bed. Items are positioned relative to each other; where the
  // combined result lands in Z is not something the user should have to manage.
  const lowestZ = result.boundingBox.bounds[0][2];
  const seated = lowestZ === 0 ? result : result.translate([0, 0, -lowestZ]);

  // And once more on the finished part. Every item can be a sound solid and the
  // combination still not be — a boolean between two valid shapes can leave a
  // zero-thickness wall or a face that touches itself.
  assertShapeIsSound(seated, "This design");
  return seated;
}

/** A whole design, ready for the viewport. */
export function buildDesign(design: Design): PartData {
  const shape = buildDesignShape(design);
  const mesh = toPartMesh(shape);

  // The last check, on the actual triangles. Free here, because the mesh had to
  // be made anyway, and it is the only one that speaks for what a slicer will
  // see rather than for what the kernel believes.
  const problem = findMeshProblem(mesh);
  if (problem) {
    throw new Error(
      `This design built a solid, but its surface is not sound: ${problem}. ` +
        "It has not been shown or exported.",
    );
  }

  return { volumeMm3: measureVolume(shape), mesh };
}
