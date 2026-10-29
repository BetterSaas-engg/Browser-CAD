/**
 * A five-pointed star, for the ★ symbol.
 *
 * Computed rather than traced, so there is no licence question about it: ten
 * vertices alternating between an outer and an inner radius, at 36° apart.
 * `r / R = cos 72° / cos 36°` — about 0.381966 — is the ratio at which the
 * edges of a regular pentagram cross, which is what makes the points look
 * right rather than fat or spindly.
 *
 * Normalised exactly as an imported outline is (D41): bounding box centred on
 * the origin, longer side 1, Y up. A star is slightly wider than it is tall, so
 * the longer side here is the width and the height comes out at 0.951056.
 *
 * `symbols.test.ts` re-derives the vertices and asserts this data still matches,
 * so the numbers cannot drift from the geometry they claim to be.
 */
import type { Outline } from "./outline";

/** cos 72° / cos 36°, the pentagram ratio. */
export const STAR_RADIUS_RATIO = Math.cos((72 * Math.PI) / 180) / Math.cos((36 * Math.PI) / 180);

export const STAR_OUTLINE: Outline = {
  loops: [
    {
      hole: false,
      d:
        "M 0 0.475528 " +
        "L -0.118034 0.112257 " +
        "L -0.5 0.112257 " +
        "L -0.190983 -0.112257 " +
        "L -0.309017 -0.475528 " +
        "L 0 -0.251014 " +
        "L 0.309017 -0.475528 " +
        "L 0.190983 -0.112257 " +
        "L 0.5 0.112257 " +
        "L 0.118034 0.112257 " +
        "Z",
    },
  ],
};
