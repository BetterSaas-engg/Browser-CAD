import { beforeAll, describe, expect, it } from "vitest";
import { measureVolume, setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { SHAPES, defaultsFor, shapeById } from "../shapes/shapeLibrary";
import { loadBundledFontsFromDisk } from "../shapes/bundledFonts.node";
import { buildDesign, buildDesignShape, toPartMesh } from "./build";
import { findMeshProblem, findShapeProblem } from "./soundness";
import { importSvgOutline } from "../svg/importSvg";
import { DESIGN_VERSION, newItem } from "../design";
import type { Design, DesignItem } from "../design";

beforeAll(async () => {
  setOC(await initOpenCascade());
  await loadBundledFontsFromDisk();
}, 120_000);

const design = (...items: DesignItem[]): Design => ({ version: DESIGN_VERSION, items });
const at = (item: DesignItem, x: number, y: number, z: number): DesignItem => ({
  ...item,
  position: { x, y, z },
});

/** An SVG path as an imported outline. */
const outlineOf = (d: string) =>
  importSvgOutline(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`).outline;

/*
 * Paths that cross themselves. OpenCascade cannot make a valid face from one,
 * and — this is the point — the result still has a plausible volume, so the
 * volume check that was already there sails straight past it.
 *
 * These stand in for the font that caused the bug. The font has been replaced
 * (D50), so the repro below now passes; these keep the *check* honest.
 */
const BOWTIE = "M 0 0 L 10 10 L 10 0 L 0 10 Z";
const PINCHED = "M 0 0 L 100 0 L 100 100 L 50 -20 L 0 100 Z";
const SPUR = "M 0 0 L 100 0 L 100 100 L 0 100 L 0 0 L 60 60 L 40 60 L 50 -30 Z";

describe("every shape in the library is sound at its defaults", () => {
  it.each(SHAPES.map((s) => [s.id, s] as const))("%s", (_id, shape) => {
    const built = shape.build(defaultsFor(shape));
    expect(findShapeProblem(built)).toBeNull();
    expect(findMeshProblem(toPartMesh(built))).toBeNull();
  });
});

describe("the repro from the browser", () => {
  /*
   * Box 80 x 30 x 20, with "MOMMY" at letter height 6 and depth 1 cut into the
   * top face at X = 9, Z = 19 — so the text's top is exactly level with the
   * box's top. In the rounded font this used to build a part whose top face was
   * missing, with no warning and nothing stopping an export.
   */
  const box = newItem("box", { width: 80, depth: 30, height: 20 });
  const mommy = (font: string): DesignItem =>
    at(newItem("text", { text: "MOMMY", letterHeight: 6, depth: 1, font }, "cut"), 9, 0, 19);

  it.each(["sans", "rounded"])("builds a sound solid in %s", (font) => {
    const built = buildDesignShape(design(box, mommy(font)));
    expect(findShapeProblem(built)).toBeNull();
    expect(findMeshProblem(toPartMesh(built))).toBeNull();
  });

  it.each(["sans", "rounded"])("goes through buildDesign without refusing, in %s", (font) => {
    const { volumeMm3, mesh } = buildDesign(design(box, mommy(font)));
    // Less than the solid box, because the lettering was cut out of it.
    expect(volumeMm3).toBeLessThan(80 * 30 * 20);
    expect(volumeMm3).toBeGreaterThan(80 * 30 * 20 - 200);
    expect(mesh.triangles.length).toBeGreaterThan(0);
  });

  it("engraves the same whichever font, to within the shapes of the letters", () => {
    const sans = measureVolume(buildDesignShape(design(box, mommy("sans"))));
    const rounded = measureVolume(buildDesignShape(design(box, mommy("rounded"))));
    // Both removed material, and the heavier face removed more of it.
    expect(sans).toBeLessThan(80 * 30 * 20);
    expect(rounded).toBeLessThan(sans);
  });

  it("still refuses a coplanar cut that removes everything", () => {
    // The pre-existing guard has not been weakened by the new one.
    expect(() =>
      buildDesignShape(design(box, at(newItem("box", { width: 200, depth: 200, height: 40 }, "cut"), 0, 0, -10))),
    ).toThrow(/removed everything/i);
  });
});

describe("catching geometry that is not a sound solid", () => {
  it.each([
    ["a bowtie", BOWTIE],
    ["a pinched polygon", PINCHED],
    ["a spur that doubles back", SPUR],
  ])("refuses %s, naming the item", (_label, d) => {
    const bad = at(newItem("outline", { outline: outlineOf(d), size: 40, depth: 2 }), 0, 0, 0);
    expect(() => buildDesignShape(design(bad))).toThrow(/Item 1/);
    expect(() => buildDesignShape(design(bad))).toThrow(/did not build a valid solid/);
    expect(() => buildDesignShape(design(bad))).toThrow(/not been shown or exported/);
  });

  it("catches what the volume check cannot", () => {
    /*
     * The heart of the bug. These two have substantial, entirely plausible
     * volumes — 889 mm³ and 1609 mm³ — so every check that existed before
     * passed them. Only asking whether the geometry is valid finds them.
     */
    for (const d of [PINCHED, SPUR]) {
      const shape = shapeById("outline").build({ outline: outlineOf(d), size: 40, depth: 2 });
      expect(measureVolume(shape)).toBeGreaterThan(100);
      expect(findShapeProblem(shape)).not.toBeNull();
      expect(findMeshProblem(toPartMesh(shape))).toMatch(/not closed/);
    }
  });

  it("blocks the export path as well as the display path", () => {
    // Both go through buildDesignShape, which is where the check lives, so an
    // unsound part cannot be exported even though nothing rendered it.
    const bad = design(newItem("outline", { outline: outlineOf(SPUR), size: 40, depth: 2 }));
    expect(() => buildDesignShape(bad)).toThrow(/did not build a valid solid/);
    expect(() => buildDesign(bad)).toThrow(/did not build a valid solid/);
  });

  it("names the item that is wrong, not just the design", () => {
    const good = newItem("box", { width: 50, depth: 50, height: 10 });
    const bad = at(newItem("outline", { outline: outlineOf(SPUR), size: 20, depth: 2 }, "cut"), 0, 0, 5);
    expect(() => buildDesignShape(design(good, bad))).toThrow(/Item 2 \(cut outline\)/);
  });
});

describe("the mesh check", () => {
  it("accepts a closed mesh", () => {
    expect(findMeshProblem(toPartMesh(shapeById("box").build({ width: 10, depth: 10, height: 10 })))).toBeNull();
  });

  it("refuses an empty mesh", () => {
    expect(
      findMeshProblem({
        vertices: new Float32Array(),
        triangles: new Uint32Array(),
        normals: new Float32Array(),
        edges: new Float32Array(),
      }),
    ).toMatch(/no surface/);
  });

  it("refuses a single triangle, which is a hole with three sides", () => {
    expect(
      findMeshProblem({
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        triangles: new Uint32Array([0, 1, 2]),
        normals: new Float32Array(9),
        edges: new Float32Array(),
      }),
    ).toMatch(/not closed.*3 edges/);
  });

  it("welds coincident vertices, so a shared edge is not read as two holes", () => {
    /*
     * replicad meshes face by face and repeats the vertices along every shared
     * edge. Without welding, a plain cube reads as 12 triangles with 36 unpaired
     * edges — the check would refuse every shape in the library.
     */
    const cube = toPartMesh(shapeById("box").build({ width: 10, depth: 10, height: 10 }));
    expect(cube.vertices.length / 3).toBeGreaterThan(8);
    expect(findMeshProblem(cube)).toBeNull();
  });
});
