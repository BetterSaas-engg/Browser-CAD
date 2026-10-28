/**
 * The heart that a new Outline item starts as.
 *
 * This is `samples/heart.svg` after the importer has been over it: one closed
 * loop, six cubics, bounding box centred on the origin with its longer side 1,
 * Y up. It is written out here rather than parsed at start-up so the worker
 * never needs the XML parser, and so adding an Outline item cannot fail.
 *
 * It is *generated*, not hand-written — `outline.test.ts` imports the sample
 * file and asserts it still produces exactly this, so the two cannot drift.
 *
 * Why a default at all: an empty outline has no geometry, so a new item would
 * break the design the instant the button was pressed. D24 learned that the
 * hard way with a default-sized cut.
 */
import type { Outline } from "./outline";

export const HEART_OUTLINE: Outline = {
  loops: [
    {
      hole: false,
      d:
        "M 0 -0.447917 " +
        "C -0.3125 -0.21875 -0.5 -0.03125 -0.5 0.177083 " +
        "C -0.5 0.34375 -0.375 0.447917 -0.239583 0.447917 " +
        "C -0.135417 0.447917 -0.052083 0.385417 0 0.302083 " +
        "C 0.052083 0.385417 0.135417 0.447917 0.239583 0.447917 " +
        "C 0.375 0.447917 0.5 0.34375 0.5 0.177083 " +
        "C 0.5 -0.03125 0.3125 -0.21875 0 -0.447917 " +
        "Z",
    },
  ],
};
