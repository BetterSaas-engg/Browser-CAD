/**
 * STL export. Like build.ts this is geometry only — no worker, no DOM — so the
 * exported bytes can be checked by Vitest in plain Node.
 */
import { shapeById } from "../shapes/shapeLibrary";
import type { ParamValues } from "../shapes/shapeLibrary";
import { buildDesignShape } from "./build";
import type { Design } from "../design";

/**
 * Tessellation for export, twice as fine as the 0.01 mm / 0.1 rad used for
 * display.
 *
 * The display mesh only has to look round; these bytes are the part. At
 * 0.005 mm the facets sit 5 µm inside the true surface — about one eightieth of
 * a 0.4 mm nozzle, so slicing sees a smooth curve.
 *
 * This was 0.001 mm until a doubly-curved surface showed what that costs: a
 * 40 mm sphere came out at 201,198 triangles, 9.6 MB and 6.7 s, against 40,352
 * triangles, 1.9 MB and 0.5 s at 0.005 mm. Five times the chord error is still
 * far below anything printable; five times the triangles is not free. Singly
 * curved shapes barely notice either way, and flat-faced ones are exact
 * regardless. See D17, which revises D14.
 *
 * The angular limit binds on large-radius curves where the linear tolerance
 * alone would allow very coarse angular steps.
 */
export const STL_EXPORT_OPTIONS = {
  tolerance: 0.005,
  angularTolerance: 0.05,
  /**
   * Binary rather than ASCII: same geometry, roughly a fifth of the size, and
   * no float-formatting round trip through text.
   */
  binary: true,
} as const;

export interface StlExport {
  filename: string;
  bytes: ArrayBuffer;
}

/**
 * A shape as STL bytes, named after itself.
 *
 * Built from the exact kernel solid rather than the display mesh, so the export
 * does not inherit the viewport's coarser tolerance. Coordinates are the
 * kernel's own: millimetres, Z up, underside on z = 0 so it lands flat on the
 * bed. STL itself carries no unit or orientation metadata — millimetres is the
 * convention every slicer, Bambu Studio included, assumes.
 */
export async function shapeStl(shapeId: string, params: ParamValues): Promise<StlExport> {
  const shape = shapeById(shapeId);
  const blob = shape.build(params).blobSTL(STL_EXPORT_OPTIONS);
  return { filename: `${shape.filename(params)}.stl`, bytes: await blob.arrayBuffer() };
}

/**
 * A whole design as STL bytes.
 *
 * Flat-named for now: a combined part has no single key dimension to name it
 * after the way one primitive does.
 */
export async function designStl(design: Design): Promise<StlExport> {
  const blob = buildDesignShape(design).blobSTL(STL_EXPORT_OPTIONS);
  return { filename: "design.stl", bytes: await blob.arrayBuffer() };
}
