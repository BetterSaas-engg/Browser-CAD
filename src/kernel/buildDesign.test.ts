import { beforeAll, describe, expect, it } from "vitest";
import { measureVolume, setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { buildDesignShape } from "./build";
import { DESIGN_VERSION, newItem } from "../design";
import type { Design, DesignItem } from "../design";
import { shapeById } from "../shapes/shapeLibrary";

beforeAll(async () => {
  setOC(await initOpenCascade());
}, 120_000);

const design = (...items: DesignItem[]): Design => ({ version: DESIGN_VERSION, items });

const at = (item: DesignItem, x: number, y: number, z: number): DesignItem => ({
  ...item,
  position: { x, y, z },
});

const volumeOf = (d: Design) => measureVolume(buildDesignShape(d));

const boundsOf = (d: Design) => buildDesignShape(d).boundingBox.bounds;

const box = (width: number, depth: number, height: number, operation: "add" | "cut" = "add") =>
  newItem("box", { width, depth, height }, operation);

const cylinder = (diameter: number, height: number, operation: "add" | "cut" = "add") =>
  newItem("cylinder", { diameter, height }, operation);

describe("the four cases from the brief", () => {
  it("box minus a cylinder equals the plate-with-hole exactly", () => {
    // The cylinder is taller than the plate and starts below it, so it passes
    // cleanly through rather than leaving a coplanar face at either end.
    const combined = volumeOf(
      design(box(40, 30, 10), at(cylinder(10, 30, "cut"), 0, 0, -10)),
    );

    // The same part built the other way, as a 2D profile cut then extruded.
    const viaProfile = measureVolume(
      shapeById("plate-with-hole").build({
        width: 40,
        depth: 30,
        height: 10,
        holeDiameter: 10,
      }),
    );

    // D8 chose the 2D route partly out of doubt about 3D booleans. They agree
    // to the limit of double precision, which retires that doubt.
    expect(combined).toBeCloseTo(viaProfile, 9);
    expect(combined).toBeCloseTo(12000 - 250 * Math.PI, 9);
  });

  it("two separate boxes add up to the sum of their volumes", () => {
    // Each box is centred in XY, so 100 mm apart leaves a clear gap.
    const total = volumeOf(design(box(10, 10, 10), at(box(20, 20, 20), 100, 0, 0)));
    expect(total).toBeCloseTo(1000 + 8000, 6);
  });

  it("two overlapping boxes add up to the union, not the sum", () => {
    // Both are 10 mm cubes centred in XY spanning x -5..5, z 0..10. Offsetting
    // one by 4 in x leaves them overlapping over 6 mm of x.
    const total = volumeOf(design(box(10, 10, 10), at(box(10, 10, 10), 4, 0, 0)));

    const each = 10 * 10 * 10;
    const overlap = 6 * 10 * 10;
    expect(total).toBeCloseTo(2 * each - overlap, 6);
    // Worth stating plainly: a union is not a sum.
    expect(total).toBeLessThan(2 * each);
  });

  it("a cut that misses the part leaves the volume unchanged", () => {
    const alone = volumeOf(design(box(10, 10, 10)));
    const withMiss = volumeOf(design(box(10, 10, 10), at(box(5, 5, 5, "cut"), 100, 100, 0)));
    expect(withMiss).toBeCloseTo(alone, 9);
    expect(withMiss).toBeCloseTo(1000, 6);
  });
});

describe("ordering and operations", () => {
  it("applies items in list order, so cut-then-add differs from add-then-cut", () => {
    const base = box(20, 20, 20);
    const tool = at(box(10, 10, 10, "cut"), 0, 0, 10);
    const filler = at(box(10, 10, 10), 0, 0, 10);

    // Cut a notch, then fill it back in.
    const cutThenAdd = volumeOf(design(base, tool, { ...filler, operation: "add" }));
    // Add the block first, then cut it away again.
    const addThenCut = volumeOf(design(base, { ...filler, operation: "add" }, tool));

    expect(cutThenAdd).toBeCloseTo(8000, 6);
    expect(addThenCut).toBeCloseTo(8000 - 1000, 6);
    expect(cutThenAdd).not.toBeCloseTo(addThenCut, 3);
  });

  it("rotates about Z in degrees, before positioning", () => {
    const turned = design({ ...box(40, 10, 5), rotationZ: 90 });
    const [min, max] = boundsOf(turned);
    // A 40 x 10 footprint turned a quarter turn measures 10 x 40.
    expect(max[0] - min[0]).toBeCloseTo(10, 6);
    expect(max[1] - min[1]).toBeCloseTo(40, 6);
    // Turning does not change how much material there is.
    expect(volumeOf(turned)).toBeCloseTo(40 * 10 * 5, 6);
  });
});

describe("re-seating on the bed", () => {
  it("drops a design that floats above z = 0", () => {
    const [min] = boundsOf(design(at(box(10, 10, 10), 0, 0, 25)));
    expect(min[2]).toBeCloseTo(0, 9);
  });

  it("lifts a design that starts below z = 0", () => {
    const [min, max] = boundsOf(design(at(box(10, 10, 10), 0, 0, -40)));
    expect(min[2]).toBeCloseTo(0, 9);
    expect(max[2]).toBeCloseTo(10, 9);
  });

  it("re-seats only after combining, so relative placement survives", () => {
    // A 10 cube on the bed with a 6 cube stacked on top of it.
    const stacked = design(box(10, 10, 10), at(box(6, 6, 6), 0, 0, 10));
    const [min, max] = boundsOf(stacked);
    expect(min[2]).toBeCloseTo(0, 9);
    expect(max[2]).toBeCloseTo(16, 9);
    expect(volumeOf(stacked)).toBeCloseTo(1000 + 216, 6);
  });

  it("re-seats a design whose first item was cut away from below", () => {
    // Slice the bottom 3 mm off a 10 mm box; what is left should sit back down
    // on the bed rather than floating 3 mm up.
    const sliced = design(box(10, 10, 10), at(box(20, 20, 6, "cut"), 0, 0, -3));
    const [min, max] = boundsOf(sliced);
    expect(min[2]).toBeCloseTo(0, 9);
    expect(max[2]).toBeCloseTo(7, 9);
    expect(volumeOf(sliced)).toBeCloseTo(10 * 10 * 7, 6);
  });
});

describe("rejecting designs that cannot be built", () => {
  it("refuses an empty design", () => {
    expect(() => buildDesignShape({ version: DESIGN_VERSION, items: [] })).toThrow(/empty/i);
  });

  it("refuses a design that starts with a cut", () => {
    expect(() => buildDesignShape(design(box(10, 10, 10, "cut")))).toThrow(/first item/i);
  });

  it("refuses a cut that removes everything, naming the item", () => {
    expect(() =>
      buildDesignShape(design(box(10, 10, 10), at(box(50, 50, 50, "cut"), 0, 0, -20))),
    ).toThrow(/item 2.*removed everything/i);
  });
});
