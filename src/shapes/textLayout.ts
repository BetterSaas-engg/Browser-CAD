/**
 * Laying out a line of text that may contain symbols.
 *
 * `"I ♥ MOM"` is one line, not three items with hand-placed X positions. The
 * font draws the letters, the symbol library draws the ♥, and this walks a pen
 * across the line so the pieces sit at the right distance from each other —
 * which means shortening a word still leaves the whole thing evenly spaced and
 * centred.
 *
 * Spacing is taken from the font's own metrics rather than chosen: each run of
 * letters advances by its advance width, and a symbol takes its ink width plus
 * the font's mean capital sidebearing on each side (D54).
 */
import { drawText } from "replicad";
import type { Drawing } from "replicad";
import {
  describe,
  emSizeForCapHeight,
  fontDef,
  fontHasGlyph,
  loadedFont,
  meanSideBearingUnits,
} from "./fonts";
import { SYMBOLS, symbolFor } from "./symbols";
import type { SymbolDef } from "./symbols";
import { drawOutline, placedByHeight } from "./drawOutline";
import { outlineBounds } from "../svg/outline";

/**
 * Longest string the Text shape accepts.
 *
 * Every glyph becomes its own closed outline, and the booleans that combine
 * them are the expensive part of a build. Eighty characters is far more than
 * fits on an A1 bed at a readable size, and keeps one runaway paste from
 * locking the kernel up for a minute.
 */
export const TEXT_MAX_LENGTH = 80;

/**
 * Refuse text that cannot be drawn, naming the character.
 *
 * A character is drawable if the symbol library claims it or the font has a
 * glyph for it — in that order, so ♥ is always this app's heart whatever a font
 * happens to contain (D53).
 *
 * This matters more than it looks. opentype does not fail on a character it
 * lacks: it substitutes `.notdef`, which in both bundled fonts is a filled
 * rectangle. The silent outcome is not a missing letter but a printed block,
 * and the first place you would notice is the bed.
 */
export function assertTextIsDrawable(text: string, fontId: string): void {
  const def = fontDef(fontId);
  const font = loadedFont(fontId);

  // Code points, not UTF-16 units, so an emoji is reported as one character
  // rather than as two meaningless halves.
  const characters = [...text];
  for (const [index, character] of characters.entries()) {
    if (symbolFor(character) || fontHasGlyph(font, character)) continue;
    throw new Error(
      `${def.label} has no glyph for ${describe(character)}, ` +
        `character ${index + 1} of ${characters.length}, ` +
        `and it is not one of the symbols this app draws (${SYMBOLS.map((s) => s.character).join(" ")}). ` +
        "Remove it or choose another font — it would otherwise print as a solid block.",
    );
  }
}

/** A stretch of the line: either letters for the font, or one symbol. */
type Run = { kind: "font"; text: string } | { kind: "symbol"; symbol: SymbolDef };

/**
 * Split text into runs.
 *
 * Letters stay in the longest runs possible so the font's own kerning still
 * applies within them. Kerning across a symbol is lost, which costs nothing:
 * a symbol is not in the font, so the font has no kerning pair for it anyway.
 */
export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  let letters = "";

  const flush = (): void => {
    if (letters !== "") runs.push({ kind: "font", text: letters });
    letters = "";
  };

  for (const character of text) {
    const symbol = symbolFor(character);
    if (symbol) {
      flush();
      runs.push({ kind: "symbol", symbol });
    } else {
      letters += character;
    }
  }
  flush();
  return runs;
}

export interface TextMeasurement {
  widthMm: number;
  heightMm: number;
}

export interface TextLayout extends TextMeasurement {
  /** Centred on its ink, baseline-relative geometry already applied. */
  drawing: Drawing;
}

/** One run, with where the pen had got to and the ink it contributes. */
interface Placed {
  run: Run;
  /** Null for a run of spaces, which moves the pen but draws nothing. */
  ink: { x1: number; y1: number; x2: number; y2: number } | null;
  /** How to draw it, for a symbol run. */
  symbol?: { heightMm: number; left: number; bottom: number };
  /** For a font run: where its own origin sits along the line. */
  penX: number;
}

/** A growing rectangle around everything placed so far. */
class InkBox {
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  add(x1: number, y1: number, x2: number, y2: number): void {
    if (x1 < this.minX) this.minX = x1;
    if (y1 < this.minY) this.minY = y1;
    if (x2 > this.maxX) this.maxX = x2;
    if (y2 > this.maxY) this.maxY = y2;
  }

  get isEmpty(): boolean {
    return !Number.isFinite(this.minX) || !Number.isFinite(this.minY);
  }
}

/**
 * Walk the pen along the line, working out where everything goes.
 *
 * No geometry is built here, which is what lets {@link measureText} answer the
 * bounding-box question without constructing a solid and throwing it away.
 *
 * The ink box is accumulated analytically rather than read back off a finished
 * drawing, for the reason D35 gives: OpenCascade's box is generous around a
 * Bézier, which would push the line off centre.
 */
function walkLine(
  text: string,
  letterHeightMm: number,
  fontId: string,
): { placed: Placed[]; ink: InkBox; emSize: number } {
  if (text.length === 0) throw new Error("The text is empty. Type something to build.");
  if (text.trim().length === 0) {
    throw new Error("The text is only spaces, so there is no geometry to build.");
  }
  if (text.length > TEXT_MAX_LENGTH) {
    throw new Error(`The text is ${text.length} characters long; the limit is ${TEXT_MAX_LENGTH}.`);
  }
  assertTextIsDrawable(text, fontId);

  const font = loadedFont(fontId);
  const emSize = emSizeForCapHeight(font, letterHeightMm);
  // Font units to millimetres, at this size.
  const perUnit = emSize / font.unitsPerEm;
  const sideBearingMm = meanSideBearingUnits(font) * perUnit;

  const placed: Placed[] = [];
  const ink = new InkBox();
  let penX = 0;

  for (const run of splitRuns(text)) {
    if (run.kind === "font") {
      /*
       * opentype measures Y downward from the baseline and replicad's drawing
       * measures it upward, so the box flips sign on the way across — the same
       * crossing D35 describes.
       */
      const box = font.getPath(run.text, 0, 0, emSize).getBoundingBox();
      const hasInk = Number.isFinite(box.x1) && box.x2 > box.x1;
      if (hasInk) {
        ink.add(penX + box.x1, -box.y2, penX + box.x2, -box.y1);
      }
      placed.push({
        run,
        penX,
        // A run of spaces has no ink but still moves the pen, which is the
        // whole point of it. Drawing one would make an empty shape that cannot
        // be fused onto anything.
        ink: hasInk ? { x1: penX + box.x1, y1: -box.y2, x2: penX + box.x2, y2: -box.y1 } : null,
      });
      penX += font.getAdvanceWidth(run.text, emSize);
      continue;
    }

    const { symbol } = run;
    const bounds = outlineBounds(symbol.outline);
    if (!(bounds.height > 0 && bounds.width > 0)) {
      throw new Error(`The ${symbol.label.toLowerCase()} symbol has no size to draw.`);
    }

    const heightMm = letterHeightMm * symbol.capHeightRatio;
    const widthMm = (bounds.width / bounds.height) * heightMm;
    const left = penX + sideBearingMm;
    const bottom = letterHeightMm * symbol.baselineRatio;

    ink.add(left, bottom, left + widthMm, bottom + heightMm);
    placed.push({
      run,
      penX,
      ink: { x1: left, y1: bottom, x2: left + widthMm, y2: bottom + heightMm },
      symbol: { heightMm, left, bottom },
    });
    penX += widthMm + 2 * sideBearingMm;
  }

  if (ink.isEmpty) throw new Error("This text has nothing to draw.");
  return { placed, ink, emSize };
}

/**
 * How big a line comes out, without building it.
 *
 * This is what the shape's bounding-box formula wants: the answer, not the
 * solid. Building the geometry to measure it and then discarding it was both
 * slow and a second chance to disagree with the layout that will actually run.
 */
export function measureText(
  text: string,
  letterHeightMm: number,
  fontId: string,
): TextMeasurement {
  const { ink } = walkLine(text, letterHeightMm, fontId);
  return { widthMm: ink.maxX - ink.minX, heightMm: ink.maxY - ink.minY };
}

/** Lay a line out, centred on its ink, ready to extrude. */
export function layOutText(text: string, letterHeightMm: number, fontId: string): TextLayout {
  const { placed, ink, emSize } = walkLine(text, letterHeightMm, fontId);

  const pieces: Drawing[] = [];
  for (const entry of placed) {
    if (entry.ink === null) continue;
    if (entry.run.kind === "font") {
      pieces.push(
        drawText(entry.run.text, { fontSize: emSize, fontFamily: fontId }).translate(entry.penX, 0),
      );
    } else {
      const { outline } = entry.run.symbol;
      const { heightMm, left, bottom } = entry.symbol!;
      pieces.push(drawOutline(outline, placedByHeight(outline, heightMm, left, bottom)));
    }
  }

  if (pieces.length === 0) throw new Error("This text has nothing to draw.");

  let drawing = pieces[0];
  for (const piece of pieces.slice(1)) drawing = drawing.fuse(piece);

  const centreX = (ink.minX + ink.maxX) / 2;
  const centreY = (ink.minY + ink.maxY) / 2;
  return {
    drawing: drawing.translate(-centreX, -centreY),
    widthMm: ink.maxX - ink.minX,
    heightMm: ink.maxY - ink.minY,
  };
}
