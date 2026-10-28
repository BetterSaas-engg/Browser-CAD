import { beforeAll, describe, expect, it } from "vitest";
import { measureVolume, setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { SHAPES, defaultsFor } from "../shapes/shapeLibrary";
import { loadBundledFontsFromDisk } from "../shapes/bundledFonts.node";
import { STL_EXPORT_OPTIONS, shapeStl } from "./stl";

// The Text shape is in SHAPES like any other, so the fonts have to be in place
// before anything here builds.
beforeAll(async () => {
  setOC(await initOpenCascade());
  await loadBundledFontsFromDisk();
}, 120_000);

const HEADER_BYTES = 80;
const COUNT_BYTES = 4;
/** 12 floats of geometry plus the 2-byte attribute word. */
const TRIANGLE_BYTES = 50;

interface ParsedStl {
  triangles: number;
  /** Flat x, y, z triples: three corners per triangle, in order. */
  corners: Float64Array;
}

/**
 * Parse a binary STL. Written out rather than pulled from a library so the test
 * checks the bytes we actually produced, not a shared interpretation of them.
 */
function parseBinaryStl(bytes: ArrayBuffer): ParsedStl {
  const view = new DataView(bytes);
  const triangles = view.getUint32(HEADER_BYTES, true);

  const expectedBytes = HEADER_BYTES + COUNT_BYTES + triangles * TRIANGLE_BYTES;
  expect(bytes.byteLength).toBe(expectedBytes);

  const corners = new Float64Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    // Skip the 3 floats of face normal at the start of each record.
    const base = HEADER_BYTES + COUNT_BYTES + t * TRIANGLE_BYTES + 12;
    for (let i = 0; i < 9; i++) {
      corners[t * 9 + i] = view.getFloat32(base + i * 4, true);
    }
  }
  return { triangles, corners };
}

/**
 * Signed volume of a closed triangle mesh, by the divergence theorem: sum the
 * signed volumes of the tetrahedra formed by each face and the origin. Only
 * meaningful if the mesh is watertight and consistently wound, which is itself
 * part of what we want to know about the file.
 */
function meshVolumeMm3({ corners }: ParsedStl): number {
  let six = 0;
  for (let i = 0; i < corners.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = corners.subarray(i, i + 9);
    six +=
      ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

function bounds({ corners }: ParsedStl) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < corners.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], corners[i + axis]);
      max[axis] = Math.max(max[axis], corners[i + axis]);
    }
  }
  return { min, max };
}

describe.each(SHAPES.map((shape) => [shape.id, shape] as const))("%s", (_id, shape) => {
  const params = defaultsFor(shape);

  // Export once and share it. Tessellating a sphere finely is the slowest thing
  // in the suite, and doing it per assertion was enough to blow the timeout.
  let filename: string;
  let parsed: ParsedStl;
  beforeAll(async () => {
    const result = await shapeStl(shape.id, params);
    filename = result.filename;
    parsed = parseBinaryStl(result.bytes);
  }, 60_000);

  it("writes a well formed binary STL named after the shape", () => {
    expect(filename).toBe(`${shape.filename(params)}.stl`);
    // parseBinaryStl asserts the byte length matches the triangle count, which
    // is what would fail first if this were ASCII.
    expect(parsed.triangles).toBeGreaterThan(3);
  });

  it("exports at millimetre scale sitting on z = 0", () => {
    const { min, max } = bounds(parsed);
    const expected = shape.boundingBoxMm(params);

    // Facets are inscribed in the true surface, so each end of a diameter can
    // sit up to one chord tolerance inside it — a sphere's STL really is a few
    // microns smaller than the sphere. Allow that much under, and nothing over:
    // an exported shape must never come out larger than it was asked to be.
    const slack = 2 * STL_EXPORT_OPTIONS.tolerance;
    for (let axis = 0; axis < 3; axis++) {
      const measured = max[axis] - min[axis];
      expect(measured).toBeLessThanOrEqual(expected[axis] + 1e-5);
      expect(measured).toBeGreaterThan(expected[axis] - slack);
    }
    // Flat on the bed rather than sunk into it or floating above it.
    expect(min[2]).toBeCloseTo(0, 3);
  });

  it("matches the exact volume within 0.1%", () => {
    // Text has no closed-form volume, so it is compared against the kernel's
    // own measurement instead. This test is about what the exporter did to the
    // geometry on the way out, not about the formula.
    const exact = shape.volumeMm3 ? shape.volumeMm3(params) : measureVolume(shape.build(params));
    const mesh = meshVolumeMm3(parsed);

    // Facet corners sit on the true surface, so curves are approximated by
    // inscribed polyhedra: a convex solid comes out slightly under its exact
    // volume, a subtracted cylinder slightly over. Flat-faced shapes are exact.
    // The direction varies by shape, so only the magnitude is asserted here.
    expect(Math.abs(mesh - exact) / exact).toBeLessThan(0.001);
  });
});
