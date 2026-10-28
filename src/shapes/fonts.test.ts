import { beforeAll, describe, expect, it } from "vitest";
import { getFont } from "replicad";
import { DEFAULT_FONT_ID, FONTS, assertFontCanDraw, emSizeForCapHeight, fontDef } from "./fonts";
import { loadBundledFontsFromDisk } from "./bundledFonts.node";

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
    // Nunito would silently come out Regular however bold it claimed to be.
    expect(getFont(id).tables.fvar).toBeUndefined();
  });

  it("is the weight its label claims", () => {
    const expected = def.label.toLowerCase().includes("bold") ? 700 : 400;
    expect(getFont(id).tables.os2.usWeightClass).toBe(expected);
  });

  it("scales so a capital is exactly the height asked for", () => {
    const font = getFont(id);
    const emSize = emSizeForCapHeight(font, 10);
    const capTop = font.charToGlyph("H").getBoundingBox().y2 * (emSize / font.unitsPerEm);
    expect(capTop).toBeCloseTo(10, 9);
  });
});

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
