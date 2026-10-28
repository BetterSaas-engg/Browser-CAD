import { beforeAll, describe, expect, it } from "vitest";
import { getFont, measureVolume, setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { SHAPES, defaultsFor, shapeById } from "./shapeLibrary";
import type { ParamValue, ParamValues } from "./shapeLibrary";
import { FONTS } from "./fonts";
import { loadBundledFontsFromDisk } from "./bundledFonts.node";
import { buildDesignShape } from "../kernel/build";
import { DESIGN_VERSION, newItem } from "../design";
import type { Design, DesignItem } from "../design";

beforeAll(async () => {
  setOC(await initOpenCascade());
  await loadBundledFontsFromDisk();
}, 120_000);

const TEXT = shapeById("text");

/** The Text shape's parameters, with anything not named left at its default. */
const params = (over: Record<string, ParamValue> = {}): ParamValues => ({
  ...defaultsFor(TEXT),
  ...over,
});

const build = (over?: Parameters<typeof params>[0]) => TEXT.build(params(over));
const volume = (over?: Parameters<typeof params>[0]) => measureVolume(build(over));
const size = (over?: Parameters<typeof params>[0]) => {
  const [min, max] = build(over).boundingBox.bounds;
  return { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] };
};

/**
 * Everything the Text shape promises to draw, minus the space — a space is
 * supported but deliberately has no outline, so it is checked separately.
 */
const REQUIRED_SYMBOLS = [..."+-×÷=.,!?#&@()"];
const LETTERS = [..."ABCXYZabcxyz"];
const DIGITS = [..."0123456789"];

describe("the characters the shape promises", () => {
  const cases = FONTS.flatMap((font) =>
    [...REQUIRED_SYMBOLS, ...LETTERS, ...DIGITS].map(
      (character) => [font.id, character] as const,
    ),
  );

  it.each(cases)("%s draws %s as real geometry", (font, character) => {
    // Not merely "does not throw": a character the font lacked would still
    // build, as a .notdef rectangle. This asserts there is material, and the
    // unsupported-character tests below assert the rectangle never happens.
    expect(volume({ text: character, font })).toBeGreaterThan(0);
  });

  it.each(FONTS.map((f) => f.id))("%s treats a space as width without ink", (font) => {
    const tight = volume({ text: "AK", font });
    const spaced = volume({ text: "A K", font });
    // A space adds no material...
    expect(spaced).toBeCloseTo(tight, 6);
    // ...but it does push the letters apart.
    expect(size({ text: "A K", font }).width).toBeGreaterThan(size({ text: "AK", font }).width);
  });

  it.each(FONTS.map((f) => f.id))("%s draws the whole promised set at once", (font) => {
    const everything =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 +-×÷=.,!?#&@()";
    expect(everything.length).toBeLessThanOrEqual(80);
    expect(volume({ text: everything, letterHeight: 6, depth: 1, font })).toBeGreaterThan(0);
  });
});

describe("refusing what it cannot draw", () => {
  it("names the character the font does not have", () => {
    // A Han character is in neither bundled font. Without the check it would
    // build as a filled rectangle and only be noticed on the bed.
    expect(() => build({ text: "AK 漢" })).toThrow(/漢/);
    expect(() => build({ text: "AK 漢" })).toThrow(/U\+6F22/);
    // And says where it is, and what would otherwise have happened.
    expect(() => build({ text: "AK 漢" })).toThrow(/character 4 of 4/);
    expect(() => build({ text: "AK 漢" })).toThrow(/solid block/i);
  });

  it("names the font, so switching fonts is an obvious fix", () => {
    expect(() => build({ text: "😀", font: "sans" })).toThrow(/Noto Sans/);
    expect(() => build({ text: "😀", font: "rounded" })).toThrow(/Sniglet/);
  });

  it("counts an emoji as one character rather than two halves", () => {
    expect(() => build({ text: "😀" })).toThrow(/character 1 of 1/);
  });

  it("rejects a newline and a tab rather than drawing a block for them", () => {
    expect(() => build({ text: "A\nB" })).toThrow(/U\+000A/);
    expect(() => build({ text: "A\tB" })).toThrow(/U\+0009/);
  });

  it("accepts characters the font does have, even outside the promised set", () => {
    // The check consults the real font rather than a fixed list, so an accent
    // both fonts carry is not refused just because the brief did not name it.
    expect(volume({ text: "café" })).toBeGreaterThan(0);
  });

  it("refuses an empty or blank string with a reason", () => {
    expect(() => build({ text: "" })).toThrow(/empty/i);
    expect(() => build({ text: "   " })).toThrow(/only spaces/i);
  });

  it("refuses a string past the length limit", () => {
    expect(() => build({ text: "A".repeat(81) })).toThrow(/81 characters.*limit is 80/);
  });

  it("refuses an unknown font instead of quietly using the other one", () => {
    // replicad's own text builder falls back to whatever was registered first,
    // which would silently build the right letters in the wrong typeface.
    expect(() => build({ font: "comic-sans" })).toThrow(/Unknown font "comic-sans"/);
  });
});

describe("size and placement", () => {
  it("makes a flat-footed capital exactly as tall as the letter height asks", () => {
    // Cap height is baseline-to-top of a capital, which is what callipers
    // measure. Noto Sans sits its H on the baseline with no overshoot at all,
    // so there is nothing to allow for: ask for 10 mm, measure 10 mm off the
    // built solid.
    expect(size({ text: "H", letterHeight: 10, font: "sans" }).height).toBeCloseTo(10, 6);
    expect(size({ text: "H", letterHeight: 3.5, font: "sans" }).height).toBeCloseTo(3.5, 6);
    expect(size({ text: "H", letterHeight: 25, font: "sans" }).height).toBeCloseTo(25, 6);
  });

  it.each(FONTS.map((f) => f.id))(
    "%s measures a capital at the letter height asked for, to the micron",
    (font) => {
      // Some fonts round the foot of their H a little below the baseline —
      // Sniglet does, by 4 units in 718 — and that overshoot lands in the ink
      // box too. Scaling the expectation from the font's own metrics pins both
      // fonts exactly, rather than hiding the difference under a tolerance
      // wide enough to cover it.
      const metrics = getFont(font).charToGlyph("H").getBoundingBox();
      const overshoot = -metrics.y1 / metrics.y2;

      for (const letterHeight of [10, 3.5, 25]) {
        const measured = size({ text: "H", letterHeight, font }).height;
        expect(measured).toBeCloseTo(letterHeight * (1 + overshoot), 5);
      }
    },
  );

  it("keeps every font within 2% of the letter height asked for", () => {
    // The guarantee stated plainly, in case the arithmetic above ever drifts:
    // whichever font is chosen, a capital comes out the height the field says.
    for (const { id } of FONTS) {
      const measured = size({ text: "H", letterHeight: 10, font: id }).height;
      expect(measured).toBeGreaterThanOrEqual(10);
      expect(measured).toBeLessThan(10.2);
    }
  });

  it("is wider with two characters than with one", () => {
    expect(size({ text: "AK" }).width).toBeGreaterThan(size({ text: "A" }).width);
    // And keeps getting wider, rather than just differing once.
    expect(size({ text: "AKA" }).width).toBeGreaterThan(size({ text: "AK" }).width);
  });

  it("scales with letter height but not with depth", () => {
    const small = size({ text: "AK", letterHeight: 5 });
    const large = size({ text: "AK", letterHeight: 10 });
    expect(large.width / small.width).toBeCloseTo(2, 6);
    expect(large.height / small.height).toBeCloseTo(2, 6);

    // 6 decimals, not 9: OpenCascade pads a bounding box by about 1e-7 mm, so
    // a 3 mm extrusion measures 3.0000002. That is the box being careful, not
    // the solid being wrong.
    expect(size({ text: "AK", depth: 3 }).depth).toBeCloseTo(3, 6);
    expect(size({ text: "AK", depth: 3 }).width).toBeCloseTo(size({ text: "AK" }).width, 9);
  });

  it("sits on its own base, centred on the origin", () => {
    const [min, max] = build({ text: "AK + 2 = ?" }).boundingBox.bounds;
    // Same 1e-7 padding as above: the underside reads as -1e-7, not 0.
    expect(min[2]).toBeCloseTo(0, 6);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 6);
    expect((min[1] + max[1]) / 2).toBeCloseTo(0, 6);
  });

  it("builds visibly different geometry in each font", () => {
    // Otherwise the font parameter could be doing nothing and every test above
    // would still pass.
    const sans = volume({ text: "AK + 2 = ?", font: "sans" });
    const rounded = volume({ text: "AK + 2 = ?", font: "rounded" });
    expect(rounded).toBeGreaterThan(sans * 1.1);
  });
});

describe("naming the export", () => {
  const nameFor = (over?: Parameters<typeof params>[0]) => TEXT.filename(params(over));

  it("puts the text in the filename", () => {
    expect(nameFor({ text: "lid" })).toBe("text-lid-h10-d2-sans");
  });

  it("slugs punctuation and spaces away", () => {
    const name = nameFor({ text: "AK + 2 = ?" });
    expect(name).toBe("text-ak-2-h10-d2-sans");
    // Still something a filesystem will take.
    expect(name).toMatch(/^[a-z0-9.-]+$/);
  });

  it("drops the text segment rather than leaving a gap when nothing survives", () => {
    expect(nameFor({ text: "+-=" })).toBe("text-h10-d2-sans");
  });

  it("keeps a very long string from becoming the whole filename", () => {
    expect(nameFor({ text: "A".repeat(80) }).length).toBeLessThan(50);
  });

  it("names the font, so two exports of the same text do not collide", () => {
    expect(nameFor({ font: "rounded" })).toContain("rounded");
    expect(nameFor({ font: "rounded" })).not.toBe(nameFor({ font: "sans" }));
  });
});

describe("raised and engraved on a plate", () => {
  const PLATE = { width: 60, depth: 20, height: 5 };
  const LETTERING = { text: "AK + 2 = ?", letterHeight: 6, depth: 1.5, font: "sans" };

  const design = (...items: DesignItem[]): Design => ({ version: DESIGN_VERSION, items });
  const plate = newItem("box", PLATE);
  const lettering = (operation: "add" | "cut", z: number): DesignItem => ({
    ...newItem("text", LETTERING, operation),
    position: { x: 0, y: 0, z },
  });

  const plateVolume = PLATE.width * PLATE.depth * PLATE.height;
  // Lazily, not at collection time: the fonts are not loaded until beforeAll.
  const letteringVolume = () => measureVolume(TEXT.build(LETTERING));

  it("adds volume when the text stands on the face", () => {
    // Sitting exactly on the top face, so the two solids meet on a plane and
    // the fused volume is the sum rather than a union of overlapping material.
    const raised = measureVolume(buildDesignShape(design(plate, lettering("add", PLATE.height))));

    expect(raised).toBeGreaterThan(plateVolume);
    expect(raised).toBeCloseTo(plateVolume + letteringVolume(), 6);
  });

  it("removes volume when the text is cut into the face", () => {
    // Sunk 1 mm into a 5 mm plate, with the other 0.5 mm poking out above it,
    // so no face of the cutting tool is coplanar with a face of the plate.
    const engraved = measureVolume(
      buildDesignShape(design(plate, lettering("cut", PLATE.height - 1))),
    );

    expect(engraved).toBeLessThan(plateVolume);
    // The text is a prism, so the material taken out is exactly the fraction of
    // its height that was inside the plate. Compared as a ratio, to 8 places
    // rather than 9: subtracting ten glyph outlines from a box leaves about a
    // part per billion behind, which is OpenCascade's arithmetic rather than a
    // disagreement about how much material went.
    const expected = plateVolume - letteringVolume() * (1 / LETTERING.depth);
    expect(engraved / expected).toBeCloseTo(1, 8);
  });

  it("leaves the plate's outline alone when engraving", () => {
    const [min, max] = buildDesignShape(
      design(plate, lettering("cut", PLATE.height - 1)),
    ).boundingBox.bounds;

    expect(max[0] - min[0]).toBeCloseTo(PLATE.width, 6);
    expect(max[1] - min[1]).toBeCloseTo(PLATE.depth, 6);
    expect(max[2] - min[2]).toBeCloseTo(PLATE.height, 6);
    expect(min[2]).toBeCloseTo(0, 9);
  });

  it("engraves and raises the same lettering, differing only in operation", () => {
    const raised = measureVolume(buildDesignShape(design(plate, lettering("add", PLATE.height))));
    const engraved = measureVolume(
      buildDesignShape(design(plate, lettering("cut", PLATE.height - 1))),
    );
    expect(raised).toBeGreaterThan(plateVolume);
    expect(engraved).toBeLessThan(plateVolume);
  });
});

describe("the printability warnings", () => {
  const spec = (key: string) => {
    const found = TEXT.params.find((p) => p.key === key);
    if (!found || found.kind !== "number") throw new Error(`No number parameter "${key}"`);
    return found;
  };

  it("warns below 5 mm of letter height and below 0.6 mm of depth", () => {
    expect(spec("letterHeight").warnBelow?.value).toBe(5);
    expect(spec("depth").warnBelow?.value).toBe(0.6);
  });

  it("still builds what it warns about, because a warning is not a limit", () => {
    expect(volume({ letterHeight: 2, depth: 0.3 })).toBeGreaterThan(0);
  });
});

it("is in the catalogue the UI builds its form from", () => {
  // The UI never imports the shape library's code, only the plain data the
  // worker sends. If Text were missing from it, the shape would exist and be
  // unreachable.
  const entry = SHAPES.find((s) => s.id === "text");
  expect(entry).toBeDefined();
  expect(entry?.params.map((p) => `${p.key}:${p.kind}`)).toEqual([
    "text:text",
    "letterHeight:number",
    "depth:number",
    "font:choice",
  ]);
});
