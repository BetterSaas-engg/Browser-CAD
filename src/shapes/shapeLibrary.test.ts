import { beforeAll, describe, expect, it } from "vitest";
import { measureVolume, setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { MAX_MM, SHAPES, defaultsFor } from "./shapeLibrary";
import type { ParamValues, ShapeDef } from "./shapeLibrary";

// Compiling 23 MB of WebAssembly is slow the first time; give it room.
beforeAll(async () => {
  setOC(await initOpenCascade());
}, 120_000);

interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

/**
 * The exact bounding box from the kernel, not one derived from the display
 * mesh. Tessellating a curve inscribes it, so a meshed cylinder measures a
 * chord tolerance narrower than its true diameter — which is a fact about the
 * mesh, not about the shape these tests are checking.
 */
function measureBounds(shape: ShapeDef, params: ParamValues): Bounds {
  const [min, max] = shape.build(params).boundingBox.bounds;
  return {
    min: [...min],
    max: [...max],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/**
 * A second set of values per shape, so the tests exercise more than the
 * defaults. Keyed by shape id; any shape without an entry is only checked at
 * its defaults.
 */
const EXTRA_CASES: Record<string, ParamValues[]> = {
  box: [{ width: 10, depth: 200, height: 1.5 }],
  cylinder: [{ diameter: 5, height: 120 }],
  sphere: [{ diameter: 7.5 }],
  cone: [
    // The frustum case, and the pointed case, which take different code paths.
    { bottomDiameter: 50, topDiameter: 20, height: 35 },
    { bottomDiameter: 30, topDiameter: 0, height: 60 },
    // Inverted: a top wider than the bottom should still be a valid solid.
    { bottomDiameter: 10, topDiameter: 40, height: 25 },
  ],
  "triangular-prism": [{ side: 12.5, height: 80 }],
  "hexagonal-prism": [{ acrossFlats: 25, height: 5 }],
  "plate-with-hole": [{ width: 60, depth: 60, height: 4, holeDiameter: 50 }],
};

describe.each(SHAPES.map((shape) => [shape.id, shape] as const))("%s", (_id, shape) => {
  const cases = [defaultsFor(shape), ...(EXTRA_CASES[shape.id] ?? [])];

  it.each(cases.map((params) => [JSON.stringify(params), params] as const))(
    "volume matches the hand formula at %s",
    (_label, params) => {
      const measured = measureVolume(shape.build(params));
      const expected = shape.volumeMm3(params);
      // Volumes span 4 orders of magnitude across these cases, so compare
      // relatively. OpenCascade integrates analytically rather than from a
      // mesh, so there is no faceting error to absorb — this is tight.
      expect(measured / expected).toBeCloseTo(1, 9);
    },
  );

  it.each(cases.map((params) => [JSON.stringify(params), params] as const))(
    "bounding box matches the parameters at %s",
    (_label, params) => {
      const { size } = measureBounds(shape, params);
      const expected = shape.boundingBoxMm(params);
      for (let axis = 0; axis < 3; axis++) {
        expect(size[axis]).toBeCloseTo(expected[axis], 3);
      }
    },
  );

  it("sits on z = 0 and is centred on the origin in X and Y", () => {
    const { min, max } = measureBounds(shape, defaultsFor(shape));
    expect(min[2]).toBeCloseTo(0, 4);

    // X is symmetric for every shape in the library. Y is too, except the
    // triangular prism: an equilateral triangle cannot have both its centroid
    // and its bounding box on the origin, and the centroid is the one that
    // matters for a datum. See D18.
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 3);
    if (shape.id !== "triangular-prism") {
      expect((min[1] + max[1]) / 2).toBeCloseTo(0, 3);
    }
  });

  it("names its export after its key dimensions", () => {
    const name = shape.filename(defaultsFor(shape));
    expect(name).toMatch(/^[a-z0-9.-]+$/);
    for (const param of shape.params) {
      // Every default should be traceable in the name, so two exports of the
      // same shape at different sizes never collide.
      expect(name).toContain(String(param.default));
    }
  });

  it("declares limits that are usable and within the build volume", () => {
    for (const param of shape.params) {
      expect(param.min).toBeLessThan(param.max);
      expect(param.max).toBeLessThanOrEqual(MAX_MM);
      expect(param.default).toBeGreaterThanOrEqual(param.min);
      expect(param.default).toBeLessThanOrEqual(param.max);
      expect(param.min).toBeGreaterThanOrEqual(0);
    }
  });
});

it("has unique shape ids and unique parameter keys within each shape", () => {
  const ids = SHAPES.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const shape of SHAPES) {
    const keys = shape.params.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  }
});

it("only lets a parameter reference sibling keys in lessThan", () => {
  for (const shape of SHAPES) {
    const keys = new Set(shape.params.map((p) => p.key));
    for (const param of shape.params) {
      for (const other of param.lessThan ?? []) {
        expect(keys).toContain(other);
      }
    }
  }
});

it("keeps the triangular prism's centroid on the origin", () => {
  // The bounding-box check above exempts this shape in Y, so pin down what it
  // is actually doing: the centroid sits on the origin, with the vertex toward
  // +Y and the opposite face at -1/3 of the height.
  const prism = SHAPES.find((s) => s.id === "triangular-prism");
  if (!prism) throw new Error("triangular-prism missing from the library");
  const { min, max } = measureBounds(prism, { side: 30, height: 10 });
  const circumradius = 30 / Math.sqrt(3);
  expect(max[1]).toBeCloseTo(circumradius, 3);
  expect(min[1]).toBeCloseTo(-circumradius / 2, 3);
});
