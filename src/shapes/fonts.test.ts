import { beforeAll, describe, expect, it } from "vitest";
import { getFont } from "replicad";
import { DEFAULT_FONT_ID, FONTS, assertFontCanDraw, emSizeForCapHeight, fontDef } from "./fonts";
import { loadBundledFontsFromDisk } from "./bundledFonts.node";
import type { Point } from "../svg/outline";

/** The opentype font object replicad hands back. */
type Font = ReturnType<typeof getFont>;

// No OpenCascade here: parsing a font and reading its tables is opentype's
// work, and none of it needs the kernel.
beforeAll(async () => {
  await loadBundledFontsFromDisk();
}, 60_000);

/**
 * What the Text shape promises to draw. If a font swap ever drops one of these
 * the app would still build — as a row of .notdef rectangles — so this is
 * checked against the font files themselves rather than against the geometry.
 */
const PROMISED =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 +-×÷=.,!?#&@()";

describe.each(FONTS.map((f) => [f.id, f] as const))("%s", (id, def) => {
  it("loads from the bundled file", () => {
    expect(getFont(id)).toBeTruthy();
  });

  it("has a glyph for every character the shape promises", () => {
    const font = getFont(id);
    const missing = [...PROMISED].filter((c) => !(font.charToGlyphIndex(c) > 0));
    expect(missing).toEqual([]);
  });

  it("is a static instance rather than a variable font", () => {
    // opentype reads only a variable font's default instance, so a variable
    // file would silently come out Regular however bold it claimed to be.
    expect(getFont(id).tables.fvar).toBeUndefined();
  });

  it("is as heavy as its label claims", () => {
    const weight = getFont(id).tables.os2.usWeightClass;
    if (def.label.toLowerCase().includes("bold")) expect(weight).toBeGreaterThanOrEqual(700);
    else expect(weight).toBe(400);
  });

  /*
   * The check that would have caught the bug this file now guards against.
   *
   * Nunito Bold shipped here until 44 of these 76 characters turned out to
   * have outlines that cross themselves. A browser renders those perfectly —
   * overlapping strokes are ordinary font construction, resolved by the
   * nonzero winding rule — but OpenCascade cannot make a valid face from one,
   * and the result built, measured the right volume and rendered with faces
   * missing. See D50.
   */
  it("has no glyph whose outline crosses itself", () => {
    const font = getFont(id);
    const offenders = [...PROMISED].filter(
      (character) => countSelfIntersections(font, character) > 0,
    );
    expect(offenders).toEqual([]);
  });

  it("scales so a capital is exactly the height asked for", () => {
    const font = getFont(id);
    const emSize = emSizeForCapHeight(font, 10);
    const capTop = font.charToGlyph("H").getBoundingBox().y2 * (emSize / font.unitsPerEm);
    expect(capTop).toBeCloseTo(10, 9);
  });
});

/** Flatten a glyph's contours densely enough to find crossings. */
function glyphContours(font: Font, character: string, perCurve = 24): Point[][] {
  const path = font.charToGlyph(character).getPath(0, 0, font.unitsPerEm);
  const contours: Point[][] = [];
  let current: Point[] | null = null;
  let at: Point = [0, 0];

  const cubic = (p0: Point, c1: Point, c2: Point, p3: Point): void => {
    for (let step = 1; step <= perCurve; step++) {
      const t = step / perCurve;
      const u = 1 - t;
      current?.push([
        u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0],
        u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1],
      ]);
    }
  };

  for (const command of path.commands) {
    if (command.type === "M") {
      if (current) contours.push(current);
      current = [[command.x, command.y]];
      at = [command.x, command.y];
    } else if (command.type === "L") {
      current?.push([command.x, command.y]);
      at = [command.x, command.y];
    } else if (command.type === "C") {
      cubic(at, [command.x1, command.y1], [command.x2, command.y2], [command.x, command.y]);
      at = [command.x, command.y];
    } else if (command.type === "Q") {
      const c1: Point = [at[0] + (2 / 3) * (command.x1 - at[0]), at[1] + (2 / 3) * (command.y1 - at[1])];
      const c2: Point = [
        command.x + (2 / 3) * (command.x1 - command.x),
        command.y + (2 / 3) * (command.y1 - command.y),
      ];
      cubic(at, c1, c2, [command.x, command.y]);
      at = [command.x, command.y];
    } else if (command.type === "Z") {
      if (current) contours.push(current);
      current = null;
    }
  }
  if (current) contours.push(current);
  return contours;
}

/** Proper crossings within each contour. Shared endpoints do not count. */
function countSelfIntersections(font: Font, character: string): number {
  const side = (a: Point, b: Point, c: Point): number =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const crosses = (p1: Point, p2: Point, p3: Point, p4: Point): boolean => {
    const d1 = side(p3, p4, p1);
    const d2 = side(p3, p4, p2);
    const d3 = side(p1, p2, p3);
    const d4 = side(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };

  let hits = 0;
  for (const contour of glyphContours(font, character)) {
    const n = contour.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        // The first and last edges meet at the closing point.
        if (i === 0 && j === n - 1) continue;
        if (crosses(contour[i], contour[(i + 1) % n], contour[j], contour[(j + 1) % n])) hits++;
      }
    }
  }
  return hits;
}

describe("the font list itself", () => {
  it("offers one clear sans and one bold rounded face", () => {
    expect(FONTS.map((f) => f.id)).toEqual(["sans", "rounded"]);
    expect(FONTS[1].label).toMatch(/bold/i);
  });

  it("has unique ids and defaults to one of them", () => {
    expect(new Set(FONTS.map((f) => f.id)).size).toBe(FONTS.length);
    expect(FONTS.map((f) => f.id)).toContain(DEFAULT_FONT_ID);
  });

  it("refuses an id it does not have, listing what it does", () => {
    expect(() => fontDef("helvetica")).toThrow(/Unknown font "helvetica".*sans, rounded/);
  });
});

describe("assertFontCanDraw", () => {
  it("passes everything the shape promises, in both fonts", () => {
    for (const { id } of FONTS) {
      expect(() => assertFontCanDraw(PROMISED, id)).not.toThrow();
    }
  });

  it("names the character, its code point and its position", () => {
    expect(() => assertFontCanDraw("ok 漢 no", "sans")).toThrow(/"漢" \(U\+6F22\)/);
    expect(() => assertFontCanDraw("ok 漢 no", "sans")).toThrow(/character 4 of 7/);
  });

  it("shows a control character as an escape rather than as nothing", () => {
    // "has no glyph for  (U+000A)" would read as a bug in the message itself.
    expect(() => assertFontCanDraw("a\nb", "sans")).toThrow(/"\\n" \(U\+000A\)/);
  });
});
