import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { measureVolume, setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { MAX_OUTLINE_CHARACTERS, outlineBounds } from "./outline";
import type { Outline } from "./outline";
import { MAX_SVG_CHARACTERS, importSvgOutline } from "./importSvg";
import { HEART_OUTLINE } from "./heart";
import { shapeById } from "../shapes/shapeLibrary";
import type { ParamValues } from "../shapes/shapeLibrary";
import { buildDesignShape } from "../kernel/build";
import { DESIGN_VERSION, newItem } from "../design";
import type { Design, DesignItem } from "../design";

beforeAll(async () => {
  setOC(await initOpenCascade());
}, 120_000);

const OUTLINE = shapeById("outline");

/** Wrap a bare `d` in the smallest SVG that will carry it. */
const svgWith = (body: string, attrs = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${attrs}>${body}</svg>`;

const pathSvg = (d: string, attrs = ""): string => svgWith(`<path d="${d}" ${attrs}/>`);

const outlineOf = (svg: string): Outline => importSvgOutline(svg).outline;

/** Build the Outline shape from an outline, at a size and depth. */
const build = (outline: Outline, size: number, depth: number) =>
  OUTLINE.build({ outline, size, depth } satisfies ParamValues);

const volumeOf = (outline: Outline, size: number, depth: number) =>
  measureVolume(build(outline, size, depth));

const sizeOf = (outline: Outline, size: number, depth: number) => {
  const [min, max] = build(outline, size, depth).boundingBox.bounds;
  return {
    width: max[0] - min[0],
    height: max[1] - min[1],
    depth: max[2] - min[2],
    minZ: min[2],
    centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] as const,
  };
};

// A 10 x 10 square, drawn clockwise in SVG's downward-Y coordinates.
const SQUARE = "M 10 10 L 20 10 L 20 20 L 10 20 Z";

describe("a square extrudes to exactly its own area", () => {
  it("is 100 mm² of material, however deep", () => {
    const square = outlineOf(pathSvg(SQUARE));
    // size 10 means the longer side is 10 mm, and for a square both are.
    expect(volumeOf(square, 10, 3)).toBeCloseTo(100 * 3, 6);
    expect(volumeOf(square, 10, 0.5)).toBeCloseTo(100 * 0.5, 6);
    expect(volumeOf(square, 10, 1)).toBeCloseTo(100, 6);
  });

  it("measures 10 x 10 x depth and sits on z = 0, centred", () => {
    const square = outlineOf(pathSvg(SQUARE));
    const measured = sizeOf(square, 10, 2);
    expect(measured.width).toBeCloseTo(10, 5);
    expect(measured.height).toBeCloseTo(10, 5);
    expect(measured.depth).toBeCloseTo(2, 5);
    // Like Text (D35): bottom on z = 0, centred on its own bounding box.
    expect(measured.minZ).toBeCloseTo(0, 5);
    expect(measured.centre[0]).toBeCloseTo(0, 5);
    expect(measured.centre[1]).toBeCloseTo(0, 5);
  });

  it("scales the same square to any size", () => {
    const square = outlineOf(pathSvg(SQUARE));
    expect(volumeOf(square, 40, 2)).toBeCloseTo(40 * 40 * 2, 5);
    expect(volumeOf(square, 2.5, 2)).toBeCloseTo(2.5 * 2.5 * 2, 6);
  });

  it("does not care how big the source drawing was", () => {
    // The same square at ten times the scale in the file must come out the
    // same part, because `size` is the only thing that sets millimetres.
    const small = outlineOf(pathSvg("M 1 1 L 2 1 L 2 2 L 1 2 Z"));
    const large = outlineOf(pathSvg("M 0 0 L 500 0 L 500 500 L 0 500 Z"));
    expect(volumeOf(small, 10, 2)).toBeCloseTo(volumeOf(large, 10, 2), 6);
    expect(volumeOf(small, 10, 2)).toBeCloseTo(200, 6);
  });
});

describe("holes", () => {
  // A 20-unit square with a 10-unit square hole in the middle. Even-odd makes
  // the inner loop a hole whichever way round it is drawn.
  const WITH_HOLE =
    "M 0 0 L 20 0 L 20 20 L 0 20 Z M 5 5 L 15 5 L 15 15 L 5 15 Z";

  it("removes the hole's volume, by hand calculation (evenodd)", () => {
    const outline = outlineOf(pathSvg(WITH_HOLE, 'fill-rule="evenodd"'));
    expect(outline.loops).toHaveLength(2);
    expect(outline.loops[0].hole).toBe(false);
    expect(outline.loops[1].hole).toBe(true);

    // Scaled so the outer square is 20 mm: the hole is then 10 mm, and at
    // 2 mm deep the part is (20² − 10²) × 2 = 600 mm³.
    expect(volumeOf(outline, 20, 2)).toBeCloseTo((20 * 20 - 10 * 10) * 2, 6);
    // Stated the other way round, so the arithmetic is visible: 800 − 200.
    expect(volumeOf(outline, 20, 2)).toBeCloseTo(800 - 200, 6);
  });

  it("keeps the hole with nonzero when the winding is opposite", () => {
    // Outer clockwise, inner counter-clockwise: nonzero makes the inner a hole.
    const outline = outlineOf(
      pathSvg("M 0 0 L 20 0 L 20 20 L 0 20 Z M 5 5 L 5 15 L 15 15 L 15 5 Z", 'fill-rule="nonzero"'),
    );
    expect(outline.loops.map((l) => l.hole)).toEqual([false, true]);
    expect(volumeOf(outline, 20, 2)).toBeCloseTo(600, 6);
  });

  it("fills the inner loop with nonzero when the winding is the same", () => {
    // Both wound the same way: nonzero fills straight through, so the inner
    // loop is not a hole and the part is solid.
    const outline = outlineOf(
      pathSvg("M 0 0 L 20 0 L 20 20 L 0 20 Z M 5 5 L 15 5 L 15 15 L 5 15 Z", 'fill-rule="nonzero"'),
    );
    expect(outline.loops.map((l) => l.hole)).toEqual([false, false]);
    expect(volumeOf(outline, 20, 2)).toBeCloseTo(800, 6);
  });

  it("is the one case where the two fill rules genuinely differ", () => {
    const same = "M 0 0 L 20 0 L 20 20 L 0 20 Z M 5 5 L 15 5 L 15 15 L 5 15 Z";
    const evenodd = volumeOf(outlineOf(pathSvg(same, 'fill-rule="evenodd"')), 20, 2);
    const nonzero = volumeOf(outlineOf(pathSvg(same, 'fill-rule="nonzero"')), 20, 2);
    expect(evenodd).toBeCloseTo(600, 6);
    expect(nonzero).toBeCloseTo(800, 6);
  });

  it("nests a third level, so an island inside a hole stays material", () => {
    const outline = outlineOf(
      pathSvg(
        "M 0 0 L 30 0 L 30 30 L 0 30 Z " +
          "M 5 5 L 25 5 L 25 25 L 5 25 Z " +
          "M 10 10 L 20 10 L 20 20 L 10 20 Z",
        'fill-rule="evenodd"',
      ),
    );
    expect(outline.loops.map((l) => l.hole)).toEqual([false, true, false]);
    // 30² − 20² + 10² = 900 − 400 + 100 = 600, at 1 mm deep.
    //
    // Relatively, not absolutely: a 30-unit drawing normalises to thirds, and
    // the stored path data is rounded to six decimals, so coordinates land
    // about 5e-7 of a unit out. On a 30 mm part that is 15 nanometres per edge
    // and about a thousandth of a cubic millimetre here. The squares earlier in
    // this file are exact only because 10ths and 20ths are exact in binary.
    expect(volumeOf(outline, 30, 1) / 600).toBeCloseTo(1, 5);
  });
});

describe("orientation", () => {
  /*
   * An L, which has no symmetry at all. In the file it is drawn with the long
   * arm down the left and the foot along the bottom — in SVG's coordinates,
   * where Y grows downward. Flipping Y wrongly, or not at all, turns it into
   * a Γ or mirrors it left-to-right, and the volume alone would not notice.
   */
  const L = "M 0 0 L 10 0 L 10 30 L 30 30 L 30 40 L 0 40 Z";

  const material = (outline: Outline, x: number, y: number): boolean => {
    // Probe by intersecting with a thin pillar at (x, y) and asking whether
    // anything is left. The part is 40 mm on its longer side, centred, so
    // model coordinates run -20..+20.
    const part = build(outline, 40, 2);
    const probe = shapeById("box")
      .build({ width: 2, depth: 2, height: 10 })
      .translate([x, y, -2]);
    return measureVolume(part.intersect(probe)) > 0;
  };

  /*
   * At size 40 the part runs x -15..15 and y -20..20: the upright occupies
   * x -15..-5 over the full height, and the foot y -20..-10 across to x +15.
   * The probes below sit inside those bands rather than on their edges.
   */
  it("puts the foot of the L at the bottom, not the top", () => {
    const outline = outlineOf(pathSvg(L));
    // SVG y = 40 is the bottom of the drawing, so in the part it is -Y.
    expect(material(outline, 10, -15)).toBe(true); // foot, bottom right
    expect(material(outline, 10, 15)).toBe(false); // nothing, top right
  });

  it("keeps the upright on the left, so it is not mirrored", () => {
    const outline = outlineOf(pathSvg(L));
    expect(material(outline, -10, 15)).toBe(true); // upright, top left
    expect(material(outline, 10, 15)).toBe(false); // nothing, top right
    // Both halves of the claim: material bottom-right, none top-right. A
    // left-right mirror would swap these, a Y flip would swap the rows, and
    // either way one of these four probes changes.
    expect(material(outline, -10, -15)).toBe(true); // upright meets foot
    expect(material(outline, 10, -15)).toBe(true); // foot reaches right
  });

  it("has the area an L has, and not that of its bounding box", () => {
    const outline = outlineOf(pathSvg(L));
    // 40 x 40 in the file: a 10 x 40 upright plus a 20 x 10 foot = 600 of
    // 1600. At 40 mm and 1 mm deep that is 600 mm³.
    expect(volumeOf(outline, 40, 1)).toBeCloseTo(600, 5);
  });
});

describe("size and aspect ratio", () => {
  // 40 wide, 20 tall in the file.
  const WIDE = "M 0 0 L 40 0 L 40 20 L 0 20 Z";
  // 20 wide, 40 tall.
  const TALL = "M 0 0 L 20 0 L 20 40 L 0 40 Z";

  it("sets the longer side exactly, whichever side that is", () => {
    const wide = sizeOf(outlineOf(pathSvg(WIDE)), 60, 2);
    expect(wide.width).toBeCloseTo(60, 5);
    expect(wide.height).toBeCloseTo(30, 5);

    const tall = sizeOf(outlineOf(pathSvg(TALL)), 60, 2);
    expect(tall.height).toBeCloseTo(60, 5);
    expect(tall.width).toBeCloseTo(30, 5);
  });

  it("preserves the aspect ratio at every size", () => {
    const outline = outlineOf(pathSvg(WIDE));
    for (const size of [5, 40, 200]) {
      const measured = sizeOf(outline, size, 1);
      expect(measured.width / measured.height).toBeCloseTo(2, 5);
    }
  });

  it("normalises the stored outline to a unit box, so size is the only scale", () => {
    const outline = outlineOf(pathSvg(WIDE));
    const bounds = outlineBounds(outline);
    expect(Math.max(bounds.width, bounds.height)).toBeCloseTo(1, 6);
    expect(bounds.height).toBeCloseTo(0.5, 6);
    // Centred, so `size` scales about the middle rather than a corner.
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(0, 6);
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(0, 6);
  });
});

describe("the transform attribute", () => {
  it("applies a translate, which cannot change the size", () => {
    const plain = outlineOf(pathSvg(SQUARE));
    const moved = outlineOf(svgWith(`<path d="${SQUARE}" transform="translate(37,-11)"/>`));
    // Normalisation re-centres, so a pure translate must leave no trace.
    expect(moved.loops[0].d).toBe(plain.loops[0].d);
  });

  it("applies a non-uniform scale, which does change the aspect ratio", () => {
    const stretched = outlineOf(svgWith(`<path d="${SQUARE}" transform="scale(3,1)"/>`));
    const measured = sizeOf(stretched, 30, 1);
    expect(measured.width).toBeCloseTo(30, 5);
    // Four decimals on the short side: a 3:1 box normalises to thirds, and the
    // stored data is rounded to six, which is 20 nanometres here.
    expect(measured.height).toBeCloseTo(10, 4);
    expect(volumeOf(stretched, 30, 1) / 300).toBeCloseTo(1, 5);
  });

  it("applies a rotate", () => {
    // A 40 x 20 rectangle turned 90° measures 20 x 40.
    const turned = outlineOf(
      svgWith(`<path d="M 0 0 L 40 0 L 40 20 L 0 20 Z" transform="rotate(90)"/>`),
    );
    const measured = sizeOf(turned, 40, 1);
    expect(measured.height).toBeCloseTo(40, 4);
    expect(measured.width).toBeCloseTo(20, 4);
  });

  it("composes transforms down nested groups, innermost first", () => {
    const nested = outlineOf(
      svgWith(
        `<g transform="scale(2,1)"><g transform="translate(5,5)">` +
          `<path d="${SQUARE}"/></g></g>`,
      ),
    );
    // The inner translate moves it; the outer scale doubles X only. A 10 x 10
    // square becomes 20 x 10, so the longer side is X.
    const measured = sizeOf(nested, 20, 1);
    expect(measured.width).toBeCloseTo(20, 5);
    expect(measured.height).toBeCloseTo(10, 5);
  });

  it("applies a matrix, including its flip, without double-flipping Y", () => {
    const L = "M 0 0 L 10 0 L 10 30 L 30 30 L 30 40 L 0 40 Z";
    const plain = outlineOf(pathSvg(L));
    // matrix(1 0 0 -1 0 40) mirrors vertically about y = 20, which is the same
    // as drawing the L upside down in the file.
    const mirrored = outlineOf(svgWith(`<path d="${L}" transform="matrix(1,0,0,-1,0,40)"/>`));
    expect(mirrored.loops[0].d).not.toBe(plain.loops[0].d);
    // Same area either way — only the orientation changed.
    expect(volumeOf(mirrored, 40, 1)).toBeCloseTo(volumeOf(plain, 40, 1), 5);
  });
});

describe("the simple shape elements", () => {
  it("imports a rect", () => {
    const outline = outlineOf(svgWith('<rect x="5" y="5" width="30" height="15"/>'));
    const measured = sizeOf(outline, 30, 1);
    expect(measured.width).toBeCloseTo(30, 5);
    expect(measured.height).toBeCloseTo(15, 5);
    expect(volumeOf(outline, 30, 1)).toBeCloseTo(450, 5);
  });

  it("imports a polygon", () => {
    // A right triangle, 20 x 20, so half of 400.
    const outline = outlineOf(svgWith('<polygon points="0,0 20,0 0,20"/>'));
    expect(volumeOf(outline, 20, 1)).toBeCloseTo(200, 5);
  });

  it("imports a circle, close enough that nothing printable could tell", () => {
    const outline = outlineOf(svgWith('<circle cx="50" cy="50" r="25"/>'));
    // Arcs become cubics at import, so this is an approximation. Assert the
    // error rather than pretend it is exact: a 90° cubic approximation of a
    // circle is good to a few parts in ten thousand.
    const measured = volumeOf(outline, 20, 1);
    const exact = Math.PI * 10 * 10;
    expect(Math.abs(measured - exact) / exact).toBeLessThan
      (0.0005);
  });

  it("imports an ellipse and keeps its aspect ratio", () => {
    const outline = outlineOf(svgWith('<ellipse cx="50" cy="50" rx="40" ry="20"/>'));
    const measured = sizeOf(outline, 40, 1);
    expect(measured.width).toBeCloseTo(40, 3);
    expect(measured.height).toBeCloseTo(20, 3);
  });

  it("imports a rounded rect", () => {
    const outline = outlineOf(svgWith('<rect x="0" y="0" width="40" height="40" rx="10"/>'));
    // A 40 mm square with 10 mm corners: 1600 less the four corner offcuts,
    // each (100 − 25π)/4 … i.e. 1600 − (400 − 100π).
    const expected = 1600 - (400 - 100 * Math.PI);
    expect(volumeOf(outline, 40, 1) / expected).toBeCloseTo(1, 3);
  });

  it("imports a lens: one curve and the line that closes it", () => {
    // Two edges, one of them curved, which does enclose area. An earlier
    // version of the area check demanded three edges and refused this.
    const lens = outlineOf(pathSvg("M 0 0 C 10 20 30 20 40 0 Z"));
    expect(lens.loops).toHaveLength(1);
    expect(volumeOf(lens, 40, 1)).toBeGreaterThan(0);
    // The curve peaks at three quarters of its control height, so the shape is
    // 40 x 15 and the stored box is 1 x 0.375.
    const bounds = outlineBounds(lens);
    expect(bounds.height / bounds.width).toBeCloseTo(0.375, 5);
  });

  it("handles quadratic curves, converted exactly to cubics", () => {
    // A quadratic and its exact cubic equivalent must produce the same area.
    const quad = outlineOf(pathSvg("M 0 0 Q 20 0 20 20 L 0 20 Z"));
    const cubic = outlineOf(
      pathSvg(
        `M 0 0 C ${(2 / 3) * 20} 0 20 ${20 - (2 / 3) * 20} 20 20 L 0 20 Z`,
      ),
    );
    expect(volumeOf(quad, 20, 1)).toBeCloseTo(volumeOf(cubic, 20, 1), 6);
  });
});

describe("refusing rather than guessing", () => {
  it("refuses a stroke-only shape, and says how to fix it", () => {
    const stroked = svgWith('<path d="M 0 0 L 40 0 L 40 40" fill="none" stroke="black"/>');
    expect(() => outlineOf(stroked)).toThrow(/no fill/i);
    expect(() => outlineOf(stroked)).toThrow(/Stroke to Path|Expand/i);
  });

  it("refuses fill:none written in a style attribute too", () => {
    expect(() =>
      outlineOf(svgWith('<path d="M 0 0 L 9 0 L 9 9 Z" style="fill:none;stroke:#000"/>')),
    ).toThrow(/no fill/i);
  });

  it("names an element it cannot import", () => {
    expect(() => outlineOf(svgWith('<text x="0" y="0">hello</text>'))).toThrow(/<text>/);
    expect(() => outlineOf(svgWith('<use href="#a"/>'))).toThrow(/<use>/);
    expect(() => outlineOf(svgWith('<image href="a.png"/>'))).toThrow(/<image>/);
    // And says what it does handle, so the message is actionable.
    expect(() => outlineOf(svgWith('<text x="0" y="0">hi</text>'))).toThrow(/<path>/);
  });

  it("refuses a line and a polyline, which have no area", () => {
    expect(() => outlineOf(svgWith('<line x1="0" y1="0" x2="9" y2="9"/>'))).toThrow(/<line>/);
    expect(() => outlineOf(svgWith('<polyline points="0,0 9,0 9,9"/>'))).toThrow(/<polyline>/);
  });

  it("refuses an SVG with nothing fillable in it", () => {
    expect(() => outlineOf(svgWith("<defs><style>.a{fill:red}</style></defs>"))).toThrow(
      /no filled shapes/i,
    );
    expect(() => outlineOf(svgWith("<g></g>"))).toThrow(/no filled shapes/i);
  });

  it("refuses a file that is not an SVG at all", () => {
    expect(() => outlineOf("<html><body>hi</body></html>")).toThrow(/No <svg> element/i);
    expect(() => outlineOf("")).toThrow(/empty/i);
  });

  it("refuses a subpath with no area, rather than dropping it", () => {
    // A filled square plus a stray two-point subpath: the stray part would
    // otherwise vanish without a word.
    expect(() => outlineOf(pathSvg("M 0 0 L 20 0 L 20 20 Z M 30 30 L 40 40 Z"))).toThrow(
      /no area/i,
    );
  });

  it("refuses a degenerate rect, circle and polygon by name", () => {
    expect(() => outlineOf(svgWith('<rect x="0" y="0" width="0" height="9"/>'))).toThrow(/<rect>/);
    expect(() => outlineOf(svgWith('<circle cx="0" cy="0" r="0"/>'))).toThrow(/<circle>/);
    expect(() => outlineOf(svgWith('<polygon points="0,0 9,9"/>'))).toThrow(/<polygon>/);
  });

  it("refuses a path with no d", () => {
    expect(() => outlineOf(svgWith("<path/>"))).toThrow(/no d attribute/i);
  });

  it("refuses a file past the size cap, naming both numbers", () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(MAX_SVG_CHARACTERS)}</svg>`;
    expect(() => outlineOf(huge)).toThrow(/characters; the limit is/);
  });

  it("refuses an outline too detailed to store in a design", () => {
    // A zigzag with enough segments to blow the path-data budget.
    const steps = 12_000;
    let d = "M 0 0";
    for (let i = 1; i <= steps; i++) d += ` L ${i} ${i % 2 === 0 ? 0.123456 : 9.876543}`;
    d += " L 0 10 Z";
    expect(() => outlineOf(pathSvg(d))).toThrow(/characters of path data/);
    expect(() => outlineOf(pathSvg(d))).toThrow(/Simplify/i);
  });

  it("caps the design at a size a browser will actually store", () => {
    // Sanity on the constants themselves rather than on a message.
    expect(MAX_OUTLINE_CHARACTERS).toBeLessThan(MAX_SVG_CHARACTERS);
    expect(MAX_OUTLINE_CHARACTERS).toBeGreaterThan(10_000);
  });
});

describe("the bounds solver, which is the bounding box's oracle", () => {
  const loop = (d: string): Outline => ({ loops: [{ d, hole: false }] });

  it("finds where a curve actually bulges, not where its controls are", () => {
    // A symmetric cubic from (0,0) to (1,0) with both controls at height 1.
    // The curve only reaches 3/4 of the way up; the control hull would say 1.
    // Getting this wrong scales every imported drawing slightly too small.
    const bounds = outlineBounds(loop("M 0 0 C 0 1 1 1 1 0 Z"));
    expect(bounds.maxY).toBeCloseTo(0.75, 12);
    expect(bounds.minY).toBeCloseTo(0, 12);
    expect(bounds.width).toBeCloseTo(1, 12);
  });

  it("measures a straight loop exactly", () => {
    const bounds = outlineBounds(loop("M -2 -3 L 5 -3 L 5 4 L -2 4 Z"));
    expect([bounds.minX, bounds.maxX, bounds.minY, bounds.maxY]).toEqual([-2, 5, -3, 4]);
    expect([bounds.width, bounds.height]).toEqual([7, 7]);
  });

  it("includes a curve's endpoints even when it never turns", () => {
    const bounds = outlineBounds(loop("M 0 0 C 1 1 2 2 3 3 L 0 3 Z"));
    expect(bounds.maxX).toBeCloseTo(3, 12);
    expect(bounds.maxY).toBeCloseTo(3, 12);
  });

  it("refuses path data it cannot draw, rather than ignoring it", () => {
    // An arc should never reach storage — the importer converts them — so if
    // one appears it is a hand-edited design or a bug, and either way silence
    // would lose a curve.
    expect(() => outlineBounds(loop("M 0 0 A 5 5 0 0 1 10 0 Z"))).toThrow(/only use M, L, C and Z/);
    expect(() => outlineBounds(loop("M 0 0 Q 5 5 10 0 Z"))).toThrow(/only use M, L, C and Z/);
  });

  it("refuses a loop holding more than one subpath", () => {
    expect(() => outlineBounds(loop("M 0 0 L 9 0 L 9 9 Z M 1 1 L 2 1 L 2 2 Z"))).toThrow(
      /one subpath/,
    );
  });

  it("refuses a loop that is really a point or a line", () => {
    expect(() => outlineBounds(loop("M 0 0 L 9 9 Z"))).toThrow(/no area/i);
  });
});

describe("raised and engraved on a plate", () => {
  const PLATE = { width: 60, depth: 40, height: 5 };
  const design = (...items: DesignItem[]): Design => ({ version: DESIGN_VERSION, items });
  const plate = newItem("box", PLATE);
  const plateVolume = PLATE.width * PLATE.depth * PLATE.height;

  const motif = { outline: HEART_OUTLINE, size: 20, depth: 1.5 };
  const placed = (operation: "add" | "cut", z: number): DesignItem => ({
    ...newItem("outline", motif, operation),
    position: { x: 0, y: 0, z },
  });

  it("adds volume when the outline stands on the face", () => {
    const raised = measureVolume(buildDesignShape(design(plate, placed("add", PLATE.height))));
    const alone = measureVolume(OUTLINE.build(motif));
    expect(raised).toBeGreaterThan(plateVolume);
    // Meeting on a plane, so the fused volume is the sum.
    expect(raised).toBeCloseTo(plateVolume + alone, 5);
  });

  it("removes volume when the outline is cut into the face", () => {
    // Sunk 1 mm in, the other 0.5 mm poking out, so no faces are coplanar.
    const engraved = measureVolume(buildDesignShape(design(plate, placed("cut", PLATE.height - 1))));
    const alone = measureVolume(OUTLINE.build(motif));
    expect(engraved).toBeLessThan(plateVolume);
    // A prism, so what went is the fraction of its height that was inside.
    expect(engraved / (plateVolume - alone * (1 / motif.depth))).toBeCloseTo(1, 8);
  });

  it("leaves the plate's outline alone when engraving", () => {
    const [min, max] = buildDesignShape(
      design(plate, placed("cut", PLATE.height - 1)),
    ).boundingBox.bounds;
    expect(max[0] - min[0]).toBeCloseTo(PLATE.width, 5);
    expect(max[1] - min[1]).toBeCloseTo(PLATE.depth, 5);
    expect(max[2] - min[2]).toBeCloseTo(PLATE.height, 5);
    expect(min[2]).toBeCloseTo(0, 5);
  });
});

describe("the sample heart", () => {
  const sample = readFileSync(
    fileURLToPath(new URL("../../samples/heart.svg", import.meta.url)),
    "utf8",
  );

  it("imports as one solid loop", () => {
    const { outline, summary } = importSvgOutline(sample);
    expect(summary).toEqual({ loops: 1, holes: 0 });
    expect(outline.loops[0].hole).toBe(false);
  });

  it("is exactly what the shape ships as its default, so the two cannot drift", () => {
    // HEART_OUTLINE is generated from this file. If someone edits the sample,
    // this is what tells them the built-in default no longer matches it.
    expect(importSvgOutline(sample).outline).toEqual(HEART_OUTLINE);
  });

  it("builds, with its point at the bottom", () => {
    const outline = outlineOf(sample);
    expect(volumeOf(outline, 40, 2)).toBeGreaterThan(0);

    const measured = sizeOf(outline, 40, 2);
    expect(measured.width).toBeCloseTo(40, 4);
    // Slightly less tall than wide, as a heart is.
    expect(measured.height).toBeLessThan(40);
    expect(measured.height).toBeGreaterThan(30);
    expect(measured.minZ).toBeCloseTo(0, 5);
  });

  it("is symmetric left to right, and a heart rather than a blob", () => {
    const part = build(outlineOf(sample), 40, 2);
    const probe = (x: number, y: number): boolean => {
      const pillar = shapeById("box")
        .build({ width: 1.5, depth: 1.5, height: 10 })
        .translate([x, y, -2]);
      return measureVolume(part.intersect(pillar)) > 0;
    };

    // Material in both lobes, and in neither top corner.
    expect(probe(-9, 12)).toBe(true);
    expect(probe(9, 12)).toBe(true);
    expect(probe(-19, 17)).toBe(false);
    expect(probe(19, 17)).toBe(false);
    // The notch between the lobes is empty, and the point at the bottom is not.
    expect(probe(0, 17)).toBe(false);
    expect(probe(0, -16)).toBe(true);
  });
});
