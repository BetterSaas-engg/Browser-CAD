import { beforeAll, expect, it } from "vitest";
import { setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { expectedVolumeMm3, measureBoxWithHoleVolumeMm3 } from "./shapes";

// Compiling 23 MB of WebAssembly is slow the first time; give it room.
beforeAll(async () => {
  setOC(await initOpenCascade());
}, 120_000);

it("measures the plate's volume as plate minus hole", () => {
  // OpenCascade integrates the volume analytically rather than from a mesh, and
  // the hole is an exact cylinder, so this can be checked tightly.
  expect(measureBoxWithHoleVolumeMm3()).toBeCloseTo(expectedVolumeMm3(), 6);
});

it("agrees with the hand calculation of 12000 - 250*pi", () => {
  expect(expectedVolumeMm3()).toBeCloseTo(12000 - 250 * Math.PI, 9);
});
