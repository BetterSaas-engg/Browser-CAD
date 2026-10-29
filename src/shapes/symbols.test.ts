import { beforeAll, describe, expect, it } from "vitest";
import { measureVolume, setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { SYMBOLS, symbolFor } from "./symbols";
import { layOutText, measureText, splitRuns } from "./textLayout";
import { capHeightUnits, loadedFont, meanSideBearingUnits } from "./fonts";
import { FONTS } from "./fonts";
import { loadBundledFontsFromDisk } from "./bundledFonts.node";
import { shapeById } from "./shapeLibrary";
import { HEART_OUTLINE } from "../svg/heart";
import { STAR_OUTLINE, STAR_RADIUS_RATIO } from "../svg/star";
import { countSelfCrossings, flattenLoop, outlineBounds } from "../svg/outline";
import { findMeshProblem, findShapeProblem } from "../kernel/soundness";
import { toPartMesh } from "../kernel/build";

beforeAll(async () => {
  setOC(await initOpenCascade());
  await loadBundledFontsFromDisk();
}, 120_000);

const TEXT = shapeById("text");
const OUTLINE = shapeById("outline");
const HEART = "♥";
const STAR = "★";
const FONT_IDS = FONTS.map((f) => f.id);

const build = (text: string, letterHeight = 10, depth = 2, font = "sans") =>
  TEXT.build({ text, letterHeight, depth, font });
const volume = (...args: Parameters<typeof build>) => measureVolume(build(...args));
// Measured, not built: these ask how big a line comes out, and building the
// solid to find out would make the spacing tests take minutes.
const width = (text: string, letterHeight = 10, font = "sans") =>
  measureText(text, letterHeight, font).widthMm;
const height = (text: string, letterHeight = 10, font = "sans") =>
  measureText(text, letterHeight, font).heightMm;

/** The ink gap between two pieces, from measured widths alone. */
const gapBetween = (a: string, b: string, font: string, letterHeight = 10): number =>
  width(a + b, letterHeight, font) - width(a, letterHeight, font) - width(b, letterHeight, font);

describe("the library itself", () => {
  it("has two symbols, each one entry carrying everything about it", () => {
    expect(SYMBOLS.map((s) => s.character)).toEqual([HEART, STAR]);
    for (const symbol of SYMBOLS) {
      expect(symbol.label).toBeTruthy();
      expect(symbol.outline.loops.length).toBeGreaterThan(0);
      expect(symbol.capHeightRatio).toBeGreaterThan(0);
      expect(symbol.capHeightRatio).toBeLessThanOrEqual(1);
      expect(symbol.baselineRatio).toBeGreaterThanOrEqual(0);
      // Sized and placed so the symbol fits inside the capital band.
      expect(symbol.baselineRatio + symbol.capHeightRatio).toBeLessThanOrEqual(1);
    }
  });

  it("looks a symbol up by its character, and nothing else", () => {
    expect(symbolFor(HEART)?.label).toBe("Heart");
    expect(symbolFor(STAR)?.label).toBe("Star");
    expect(symbolFor("H")).toBeUndefined();
    expect(symbolFor("♡")).toBeUndefined(); // the hollow heart is a different character
  });

  it("uses the same heart as the Outline shape and the sample file", () => {
    // Not a copy: the identical object. Three hearts would be three things to
    // keep in step.
    expect(symbolFor(HEART)?.outline).toBe(HEART_OUTLINE);
  });

  it("centres both symbols in the capital band", () => {
    for (const symbol of SYMBOLS) {
      expect(symbol.baselineRatio).toBeCloseTo((1 - symbol.capHeightRatio) / 2, 12);
    }
  });
});

describe("the star's geometry, re-derived", () => {
  it("is the pentagram ratio", () => {
    expect(STAR_RADIUS_RATIO).toBeCloseTo(0.381966, 6);
  });

  it("matches ten vertices computed from scratch", () => {
    // The stored data is generated. This recomputes it, so the numbers cannot
    // drift from the geometry they claim to be.
    const points: [number, number][] = [];
    for (let i = 0; i < 5; i++) {
      const outer = ((90 + i * 72) * Math.PI) / 180;
      const inner = ((90 + i * 72 + 36) * Math.PI) / 180;
      points.push([Math.cos(outer), Math.sin(outer)]);
      points.push([STAR_RADIUS_RATIO * Math.cos(inner), STAR_RADIUS_RATIO * Math.sin(inner)]);
    }
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const longer = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

    const flat = flattenLoop(STAR_OUTLINE.loops[0].d);
    expect(flat).toHaveLength(10);
    for (const [index, [x, y]] of points.entries()) {
      expect(flat[index][0]).toBeCloseTo((x - cx) / longer, 5);
      expect(flat[index][1]).toBeCloseTo((y - cy) / longer, 5);
    }
  });

  it("is normalised to a unit box like any imported outline", () => {
    const bounds = outlineBounds(STAR_OUTLINE);
    expect(Math.max(bounds.width, bounds.height)).toBeCloseTo(1, 6);
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(0, 6);
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(0, 6);
    // A five-pointed star is a little wider than it is tall.
    expect(bounds.height).toBeCloseTo(0.951056, 5);
  });
});

describe("no symbol outline crosses itself", () => {
  /*
   * The same check the fonts get, for the same reason (D50): OpenCascade cannot
   * make a valid face from a self-crossing contour, and the result builds
   * anyway with faces missing. A star drawn as a pentagram stroke — the
   * five-line version — would fail this, which is exactly why the outline is
   * the ten-vertex filled version.
   */
  it.each(SYMBOLS.map((s) => [s.label, s] as const))("%s", (_label, symbol) => {
    for (const loop of symbol.outline.loops) {
      expect(countSelfCrossings(flattenLoop(loop.d))).toBe(0);
    }
  });
});

describe("splitting a line into runs", () => {
  it("keeps letters together so the font's kerning still applies", () => {
    expect(splitRuns("I ♥ MOM").map((r) => (r.kind === "font" ? r.text : r.symbol.character))).toEqual(
      ["I ", HEART, " MOM"],
    );
  });

  it("handles a symbol at either end, and two in a row", () => {
    expect(splitRuns("♥A").map((r) => r.kind)).toEqual(["symbol", "font"]);
    expect(splitRuns("A♥").map((r) => r.kind)).toEqual(["font", "symbol"]);
    expect(splitRuns("♥★").map((r) => r.kind)).toEqual(["symbol", "symbol"]);
    expect(splitRuns("ABC").map((r) => r.kind)).toEqual(["font"]);
  });
});

describe('"I ♥ MOM"', () => {
  it.each(FONT_IDS)("builds a valid solid in %s", (font) => {
    const solid = build("I ♥ MOM", 10, 2, font);
    expect(measureVolume(solid)).toBeGreaterThan(0);
    // The same soundness check every build gets (D51), asserted directly here
    // because a symbol is new geometry entering the same pipeline.
    expect(findShapeProblem(solid)).toBeNull();
    expect(findMeshProblem(toPartMesh(solid))).toBeNull();
  });

  it.each(FONT_IDS)("is wider with the heart than without, in %s", (font) => {
    expect(width("I ♥ MOM", 10, font)).toBeGreaterThan(width("I MOM", 10, font));
    // And the extra width is about a heart plus its two gaps, not a wild jump.
    const extra = width("I ♥ MOM", 10, font) - width("I MOM", 10, font);
    expect(extra).toBeGreaterThan(width(HEART, 10, font));
    expect(extra).toBeLessThan(width(HEART, 10, font) * 2);
  });

  it.each(FONT_IDS)("stays centred on its ink in %s, whatever the words", (font) => {
    /*
     * A thousandth of a millimetre, not a ten-thousandth, and the limit is the
     * measuring instrument rather than the layout. Sniglet's "A" has a very
     * flat curve at its widest point, where OpenCascade's bounding box of the
     * extrusion sits 3.5e-4 mm wider than opentype's solved extremum — measured
     * on a bare "A", with no symbol involved. D35 picked the analytic box
     * precisely because it is the more accurate of the two, so this asserts to
     * the accuracy the solid's own box can report.
     */
    for (const text of ["I ♥ MOM", "I ♥ MUM", "A ♥ B", "♥ MOM"]) {
      const [min, max] = build(text, 10, 2, font).boundingBox.bounds;
      expect((min[0] + max[0]) / 2).toBeCloseTo(0, 2);
      expect((min[1] + max[1]) / 2).toBeCloseTo(0, 2);
      expect(min[2]).toBeCloseTo(0, 5);
    }
  });

  it.each(FONT_IDS)("re-centres when a word is shortened, in %s", (font) => {
    // The complaint that started this bite: three items with hand-picked X
    // positions do not re-space when the words change. One item does.
    const long = build("I ♥ MOMMY", 10, 2, font).boundingBox.bounds;
    const short = build("I ♥ MOM", 10, 2, font).boundingBox.bounds;
    expect(long[1][0] - long[0][0]).toBeGreaterThan(short[1][0] - short[0][0]);
    for (const bounds of [long, short]) {
      expect((bounds[0][0] + bounds[1][0]) / 2).toBeCloseTo(0, 4);
    }
  });
});

describe("how big a symbol comes out", () => {
  /*
   * Each symbol is pinned to its *own* declared ratio rather than to a literal
   * number, and against a capital height that is measured rather than assumed.
   * The ratios are a visual judgement that has already changed once — the heart
   * went from 0.75 to 0.9 because it read like punctuation (D54) — so a test
   * that hard-coded them would have to be edited every time the look is tuned,
   * which is how a test stops being a check and becomes a chore.
   */
  it.each(
    SYMBOLS.flatMap((symbol) => FONT_IDS.map((font) => [symbol.label, symbol, font] as const)),
  )("draws the %s at its declared ratio of the capital height, in %s", (_label, symbol, font) => {
    for (const letterHeight of [6, 10, 25]) {
      expect(height(symbol.character, letterHeight, font)).toBeCloseTo(
        letterHeight * symbol.capHeightRatio,
        5,
      );
    }
  });

  it("gives each symbol its own size, rather than one shared ratio", () => {
    // The point of the field being per symbol. Which of the two is larger is
    // deliberately not asserted — that is a look, and it has already flipped.
    expect(symbolFor(HEART)!.capHeightRatio).not.toBeCloseTo(
      symbolFor(STAR)!.capHeightRatio,
      6,
    );
    expect(height(HEART, 10)).not.toBeCloseTo(height(STAR, 10), 3);
  });

  it("draws a symbol the same size in both fonts, since it is not the font's", () => {
    expect(height(HEART, 10, "sans")).toBeCloseTo(height(HEART, 10, "rounded"), 9);
    expect(width(HEART, 10, "sans")).toBeCloseTo(width(HEART, 10, "rounded"), 9);
  });

  it.each(FONT_IDS)("keeps every symbol within the capital band in %s", (font) => {
    // Nothing pokes above the capitals or below the baseline, so a symbol
    // cannot make the line taller than the letters do.
    const capTop = height("H", 10, font);
    for (const symbol of SYMBOLS) {
      const withCapital = layOutText(`H${symbol.character}`, 10, font);
      expect(withCapital.heightMm).toBeLessThanOrEqual(capTop + 1e-6);
      expect(height(symbol.character, 10, font)).toBeLessThanOrEqual(capTop + 1e-6);
    }
  });

  it.each(FONT_IDS)("draws the heart about as wide as a capital is tall, in %s", (font) => {
    // What 0.9 bought: a heart is wider than it is tall, so at 0.9 of the cap
    // height it comes out a shade wider than a capital is tall. That is the
    // difference between reading as an equal in the line and as punctuation.
    const capTop = height("H", 10, font);
    expect(width(HEART, 10, font)).toBeGreaterThan(capTop * 0.9);
    expect(width(HEART, 10, font)).toBeLessThan(capTop * 1.15);
  });
});

describe("a symbol never touches its neighbours", () => {
  /*
   * Two independent ways of saying it, because the heart got bigger without
   * its gaps changing and the gaps are what keep it clear of the letters.
   *
   *  - the measured ink gap either side is positive, so there is daylight;
   *  - fusing the pieces adds up to the sum of their volumes, which could not
   *    happen if they overlapped.
   */
  const NEIGHBOURS = ["I", "M", "O", "A", "H", "L", "T"];

  it.each(FONT_IDS)("leaves daylight on both sides, in %s", (font) => {
    for (const symbol of SYMBOLS) {
      for (const letter of NEIGHBOURS) {
        expect(gapBetween(letter, symbol.character, font)).toBeGreaterThan(0);
        expect(gapBetween(symbol.character, letter, font)).toBeGreaterThan(0);
      }
    }
  });

  it.each(FONT_IDS)("fuses to the sum of its parts, so nothing overlaps, in %s", (font) => {
    for (const pair of ["I♥", "♥M", "A♥", "♥★", "H★"]) {
      const together = volume(pair, 10, 2, font);
      const apart = [...pair].reduce((total, ch) => total + volume(ch, 10, 2, font), 0);
      expect(together / apart).toBeCloseTo(1, 6);
    }
  });

  it.each(FONT_IDS)("builds the full line as a sound solid, in %s", (font) => {
    // The heart at 0.9 is wider than it was; this is the line from the browser
    // check, rebuilt at the new size.
    const solid = build("I ♥ MOM", 6, 1, font);
    expect(findShapeProblem(solid)).toBeNull();
    expect(findMeshProblem(toPartMesh(solid))).toBeNull();
  });
});

describe("how a symbol is spaced", () => {
  /*
   * The gap either side of a symbol is the font's mean capital sidebearing, so
   * it sits in the line the way a letter does. These tests measure the gap the
   * way a reader would see it — from ink widths — and compare it against the
   * gaps the font itself puts between capitals.
   */
  const CAPITALS = "IMONAHKE";

  /** Sorted, and worked out once per font — every pair is a measurement. */
  const cache = new Map<string, number[]>();
  const letterGaps = (font: string): number[] => {
    const cached = cache.get(font);
    if (cached) return cached;
    const gaps: number[] = [];
    for (const a of CAPITALS) {
      for (const b of CAPITALS) {
        if (a !== b) gaps.push(gapBetween(a, b, font));
      }
    }
    gaps.sort((x, y) => x - y);
    cache.set(font, gaps);
    return gaps;
  };

  it.each(FONT_IDS)("puts the I-to-heart gap inside the font's normal range, in %s", (font) => {
    const gaps = letterGaps(font);
    const percentile = (p: number): number => gaps[Math.floor(gaps.length * p)];

    const gap = gapBetween("I", HEART, font);
    // Not merely between the extremes — those include kerned pairs that almost
    // touch. Inside the middle four fifths of what the font does.
    expect(gap).toBeGreaterThanOrEqual(percentile(0.1));
    expect(gap).toBeLessThanOrEqual(percentile(0.9));
  });

  it.each(FONT_IDS)("lands near the median letter gap, in %s", (font) => {
    const gaps = letterGaps(font);
    const median = gaps[Math.floor(gaps.length / 2)];
    const gap = gapBetween("I", HEART, font);
    expect(Math.abs(gap - median) / median).toBeLessThan(0.4);
  });

  it.each(FONT_IDS)("spaces the star the same way as the heart, in %s", (font) => {
    // Both get the font's sidebearing, so after the same letter the gap is the
    // same whichever symbol follows.
    expect(gapBetween("I", STAR, font)).toBeCloseTo(gapBetween("I", HEART, font), 9);
  });

  it("takes its spacing from the font, so a tighter font sets symbols tighter", () => {
    // Sniglet's capitals carry about two thirds of Noto Sans's sidebearing, so
    // the same two symbols side by side must come out narrower in Sniglet.
    const sansBearing = meanSideBearingUnits(loadedFont("sans")) / capHeightUnits(loadedFont("sans"));
    const roundedBearing =
      meanSideBearingUnits(loadedFont("rounded")) / capHeightUnits(loadedFont("rounded"));
    expect(roundedBearing).toBeLessThan(sansBearing);
    expect(width("♥★", 10, "rounded")).toBeLessThan(width("♥★", 10, "sans"));
  });
});

describe("cross-checks against the Outline shape", () => {
  it("engraves a heart identical to the Outline heart at the same size and depth", () => {
    /*
     * The strongest statement that there is one heart and not two: lay the
     * symbol out, take the width it came to, and build the Outline shape at
     * exactly that size. Same geometry, so the same volume.
     */
    for (const depth of [1, 2.5]) {
      for (const letterHeight of [8, 20]) {
        const laidOut = layOutText(HEART, letterHeight, "sans");
        const asSymbol = volume(HEART, letterHeight, depth, "sans");
        const asOutline = measureVolume(
          OUTLINE.build({ outline: HEART_OUTLINE, size: laidOut.widthMm, depth }),
        );
        expect(asSymbol / asOutline).toBeCloseTo(1, 9);
      }
    }
  });

  it("removes that volume when cut into a plate", () => {
    const plate = { width: 40, depth: 20, height: 5 };
    const plateVolume = plate.width * plate.depth * plate.height;
    const engraved = measureVolume(
      shapeById("box")
        .build(plate)
        .cut(build(HEART, 10, 1.5, "sans").translate([0, 0, plate.height - 1])),
    );
    const motif = volume(HEART, 10, 1.5, "sans");
    /*
     * A prism, so what went is the fraction of its height inside the plate.
     * Seven places rather than eight: subtracting a curved outline from a box
     * leaves about a part in 10^8 behind, and the heart at 0.9 of the cap
     * height has more curve to subtract than it did at 0.75. That is
     * OpenCascade's arithmetic — five hundredths of a cubic micrometre on a
     * 3,900 mm³ plate — not a disagreement about how much material moved.
     */
    expect(engraved / (plateVolume - motif * (1 / 1.5))).toBeCloseTo(1, 7);
  });
});

describe("the star builds and is star-shaped", () => {
  it("has material at its points and none between them", () => {
    // Probed the way the heart is in outline.test.ts. At size 40 the star spans
    // x -20..20, and its topmost point is at the top centre.
    const bounds = outlineBounds(STAR_OUTLINE);
    const solid = build(STAR, 40 / 0.8, 2, "sans"); // letterHeight so the star is 40 tall
    const [min, max] = solid.boundingBox.bounds;
    const probe = (fx: number, fy: number): boolean => {
      const x = min[0] + fx * (max[0] - min[0]);
      const y = min[1] + fy * (max[1] - min[1]);
      const pillar = shapeById("box")
        .build({ width: 1.2, depth: 1.2, height: 10 })
        .translate([x, y, -2]);
      return measureVolume(solid.intersect(pillar)) > 0;
    };

    expect(bounds.height / bounds.width).toBeCloseTo(0.951056, 5);

    // The top point and the body are material.
    expect(probe(0.5, 0.95)).toBe(true);
    expect(probe(0.5, 0.5)).toBe(true);
    // The two side points, which sit in a band about 60% of the way up.
    expect(probe(0.02, 0.6)).toBe(true);
    expect(probe(0.98, 0.6)).toBe(true);
    // Nothing in the corners either side of the top point.
    expect(probe(0.06, 0.95)).toBe(false);
    expect(probe(0.94, 0.95)).toBe(false);
    // Nothing above the side points, between them and the top point.
    expect(probe(0.1, 0.8)).toBe(false);
    expect(probe(0.9, 0.8)).toBe(false);
    // The two legs splay outward as they drop, and the notch between them is
    // empty all the way down.
    expect(probe(0.3, 0.1)).toBe(true);
    expect(probe(0.7, 0.1)).toBe(true);
    expect(probe(0.5, 0.2)).toBe(false);
    expect(probe(0.5, 0.03)).toBe(false);
  });

  it("builds a sound solid in both fonts", () => {
    for (const font of FONT_IDS) {
      const solid = build(`A${STAR}B`, 10, 2, font);
      expect(findShapeProblem(solid)).toBeNull();
      expect(findMeshProblem(toPartMesh(solid))).toBeNull();
    }
  });
});

describe("refusing what it cannot draw", () => {
  it("still names an unsupported character sitting next to a symbol", () => {
    expect(() => build("I ♥ 漢")).toThrow(/漢/);
    expect(() => build("I ♥ 漢")).toThrow(/U\+6F22/);
    expect(() => build("I ♥ 漢")).toThrow(/character 5 of 5/);
  });

  it("says that the symbols exist, so the fix is visible", () => {
    expect(() => build("♥ 漢")).toThrow(/not one of the symbols this app draws/);
    expect(() => build("♥ 漢")).toThrow(/♥ ★/);
  });

  it("refuses a hollow heart, which is a different character we do not draw", () => {
    expect(() => build("♡")).toThrow(/U\+2661/);
  });

  it("still refuses blank and overlong text", () => {
    expect(() => build("")).toThrow(/empty/i);
    expect(() => build("   ")).toThrow(/only spaces/i);
    expect(() => build("♥".repeat(81))).toThrow(/81 characters.*limit is 80/);
  });

  it("accepts a line made only of symbols", () => {
    expect(volume("♥★♥")).toBeGreaterThan(0);
  });

  it("accepts symbols with spaces around them", () => {
    expect(volume(" ♥ ")).toBeGreaterThan(0);
    // The spaces move the pen but add no material, so the ink is just a heart.
    expect(width(" ♥ ")).toBeCloseTo(width("♥"), 9);
  });
});

describe("the export filename", () => {
  it("slugs a symbol away rather than putting it in a filename", () => {
    const name = TEXT.filename({ text: "I ♥ MOM", letterHeight: 10, depth: 2, font: "sans" });
    expect(name).toMatch(/^[a-z0-9.-]+$/);
    expect(name).toContain("i-mom");
  });
});
