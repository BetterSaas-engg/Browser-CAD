import { beforeAll, expect, it } from "vitest";
import { setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { BOX_WITH_HOLE, expectedVolumeMm3 } from "./shapes";
import { boxWithHoleStl } from "./stl";

beforeAll(async () => {
  setOC(await initOpenCascade());
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
 * Parse a binary STL. Written out rather than pulled from a library so the
 * test checks the bytes we actually produced, not a shared interpretation of
 * them.
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
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
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

it("writes a well formed binary STL", async () => {
  const parsed = parseBinaryStl(await boxWithHoleStl());
  // parseBinaryStl already asserts the byte length matches the triangle count,
  // which is what would fail first if this were ASCII.
  expect(parsed.triangles).toBeGreaterThan(100);
});

it("exports at millimetre scale, Z up, sitting on z = 0", async () => {
  const { min, max } = bounds(parseBinaryStl(await boxWithHoleStl()));
  const { width, depth, height } = BOX_WITH_HOLE;

  expect(max[0] - min[0]).toBeCloseTo(width, 3);
  expect(max[1] - min[1]).toBeCloseTo(depth, 3);
  expect(max[2] - min[2]).toBeCloseTo(height, 3);
  // Flat on the bed rather than sunk into it or floating above it.
  expect(min[2]).toBeCloseTo(0, 4);
});

it("encloses the exact kernel volume to within 1 mm³", async () => {
  const exact = expectedVolumeMm3();
  const mesh = meshVolumeMm3(parseBinaryStl(await boxWithHoleStl()));

  // The STL approximates the hole's cylinder with flat facets whose corners sit
  // on the true surface, so the hole it describes is a polygon inscribed in the
  // real circle. That removes slightly less material than the exact cylinder,
  // which puts the mesh volume a little ABOVE the exact one — a signed check,
  // not just a magnitude one.
  expect(mesh).toBeGreaterThan(exact);

  // 1 mm³ is 0.009% of the part. It sits well above the faceting error this
  // tolerance actually produces, so it will not go off when replicad changes
  // its tessellator slightly, and far below the 785 mm³ a missing hole would
  // cost or the 1000x a metre/millimetre units mix-up would.
  expect(mesh - exact).toBeLessThan(1);
  expect(mesh).toBeCloseTo(exact, 0);
});
