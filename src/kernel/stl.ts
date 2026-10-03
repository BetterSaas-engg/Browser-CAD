/**
 * STL export. Like shapes.ts this is geometry only — no worker, no DOM — so
 * the exported bytes can be checked by Vitest in plain Node.
 */
import { makeBoxWithHole } from "./shapes";

/** What the downloaded file is called. */
export const STL_FILENAME = "plate-with-hole.stl";

/**
 * Tessellation for export, finer than the 0.01 mm / 0.1 rad used for display.
 *
 * The display mesh only has to look round on screen; these bytes are the part.
 * At 0.001 mm the facets of the 5 mm hole sit about 1 µm inside the true
 * cylinder — two orders of magnitude below anything an A1 can resolve with a
 * 0.4 mm nozzle, so slicing sees a circle. Going finer only grows the file.
 *
 * The angular limit is the looser of the two at this radius, so the linear
 * tolerance is what actually sets the facet count. It is kept as a guard for
 * small-radius features on future parts, where the linear limit alone would
 * allow very coarse angular steps.
 */
export const STL_EXPORT_OPTIONS = {
  tolerance: 0.001,
  angularTolerance: 0.05,
  /**
   * Binary rather than ASCII: same geometry, roughly a fifth of the size, and
   * no float-formatting round trip through text.
   */
  binary: true,
} as const;

/**
 * The part as STL bytes.
 *
 * Built from the exact kernel solid, not from the display mesh, so the export
 * does not inherit the viewport's coarser tolerance. Coordinates are the
 * kernel's own: millimetres, Z up, with the part's underside on z = 0 so it
 * lands flat on the bed. STL itself carries no unit or orientation metadata —
 * millimetres is the convention every slicer, Bambu Studio included, assumes.
 */
export async function boxWithHoleStl(): Promise<ArrayBuffer> {
  const blob = makeBoxWithHole().blobSTL(STL_EXPORT_OPTIONS);
  return blob.arrayBuffer();
}
