/**
 * Is what we just built actually a solid?
 *
 * This exists because of a bug that got all the way to the bed: text in a font
 * whose glyph outlines cross themselves produced a shape with the right volume,
 * the right bounding box and two invalid faces. The viewport drew the grid
 * straight through the top of the part, and nothing stopped an export. Volume
 * alone cannot see that, so something had to actually ask.
 *
 * Two questions get asked, because they fail independently:
 *
 *  - **Is the geometry valid?** OpenCascade's own `BRepCheck_Analyzer`. Catches
 *    self-intersecting outlines, unorientable faces, bad wires — the class of
 *    fault that makes a boolean produce nonsense while still integrating to a
 *    plausible number.
 *  - **Is the mesh closed?** Every triangle edge must be shared by exactly two
 *    triangles. This is the question a slicer asks, and it is asked of the very
 *    triangles the viewport draws, so a tessellation that fails on geometry
 *    OpenCascade is happy with still gets caught.
 *
 * No DOM, so Vitest drives it directly.
 */
import { getOC } from "replicad";
import type { Shape3D } from "replicad";
import type { PartMesh } from "../mesh";

/**
 * How finely to match vertices when welding the mesh.
 *
 * replicad meshes face by face and repeats the vertices along every shared
 * edge, so the triangles arrive unwelded and *every* edge looks unshared until
 * coincident positions are merged. Five decimals is 10 nanometres — far below
 * the 0.01 mm display tolerance that generated the points, and far above the
 * float noise between two copies of the same corner.
 */
const WELD_PLACES = 5;

/** What is wrong with a built shape, or null when nothing is. */
export function findShapeProblem(shape: Shape3D): string | null {
  const oc = getOC();

  let solids = 0;
  const explorer = new oc.TopExp_Explorer(
    shape.wrapped,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  try {
    for (; explorer.More(); explorer.Next()) solids++;
  } finally {
    explorer.delete?.();
  }

  if (solids === 0) {
    return "the result is not a solid — it came out as a surface or an empty shape";
  }

  const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
  try {
    if (!analyzer.IsValid()) {
      return "the geometry is not valid — most often an outline that crosses itself";
    }
  } finally {
    // Emscripten objects are not garbage collected. The worker is long-lived
    // and this runs on every keystroke, so leaking one per build adds up.
    analyzer.delete?.();
  }

  return null;
}

/** What is wrong with a tessellated mesh, or null when nothing is. */
export function findMeshProblem(mesh: PartMesh): string | null {
  const { vertices, triangles } = mesh;
  if (triangles.length === 0) return "the result has no surface to show";

  // Weld coincident vertices, so a shared edge is one edge and not two.
  const welded = new Map<string, number>();
  const identity = new Int32Array(vertices.length / 3);
  for (let v = 0; v < vertices.length / 3; v++) {
    const key =
      `${vertices[v * 3].toFixed(WELD_PLACES)},` +
      `${vertices[v * 3 + 1].toFixed(WELD_PLACES)},` +
      `${vertices[v * 3 + 2].toFixed(WELD_PLACES)}`;
    let id = welded.get(key);
    if (id === undefined) {
      id = welded.size;
      welded.set(key, id);
    }
    identity[v] = id;
  }

  const uses = new Map<number, number>();
  const bump = (p: number, q: number): void => {
    // One integer key rather than a string: this runs over every edge of every
    // triangle, and a 20,000-triangle sphere is 60,000 of them per build.
    const key = p < q ? p * welded.size + q : q * welded.size + p;
    uses.set(key, (uses.get(key) ?? 0) + 1);
  };

  for (let i = 0; i < triangles.length; i += 3) {
    const a = identity[triangles[i]];
    const b = identity[triangles[i + 1]];
    const c = identity[triangles[i + 2]];
    // A triangle whose corners weld together has no area and no edges worth
    // counting; tessellators emit these at the tips of narrow features.
    if (a === b || b === c || c === a) continue;
    bump(a, b);
    bump(b, c);
    bump(c, a);
  }

  let open = 0;
  let overused = 0;
  for (const count of uses.values()) {
    if (count === 1) open++;
    else if (count > 2) overused++;
  }

  if (open > 0) {
    return (
      `the surface is not closed — ${open} edge${open === 1 ? "" : "s"} ` +
      "border a hole, so it would not slice as a solid"
    );
  }
  if (overused > 0) {
    return (
      `the surface folds back on itself — ${overused} edge${overused === 1 ? "" : "s"} ` +
      "join more than two faces"
    );
  }
  return null;
}

/**
 * Refuse a shape that is not a sound solid, saying what is wrong and where.
 *
 * `where` names the item when there is one to name, because "item 2" is the
 * difference between a message you can act on and one you can only stare at.
 */
export function assertShapeIsSound(shape: Shape3D, where: string): void {
  const problem = findShapeProblem(shape);
  if (problem) {
    throw new Error(
      `${where} did not build a valid solid: ${problem}. ` +
        "It has not been shown or exported, because the result would not be printable.",
    );
  }
}
