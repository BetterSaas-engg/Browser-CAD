/**
 * The fonts the Text shape can use.
 *
 * This module is pure: it knows which fonts exist, how to measure them, and
 * which characters they can draw. It never reads a file — the bytes arrive from
 * somewhere different in a browser than in Node, so loading lives in
 * `bundledFonts.ts` and `bundledFonts.node.ts`.
 *
 * Both fonts are bundled with the app and licensed OFL-1.1. Nothing is fetched
 * from a font service at runtime; see `src/assets/fonts/README.md`.
 */
import { getFont, loadFont } from "replicad";

/** The opentype.js font object replicad hands back. */
type Font = ReturnType<typeof getFont>;

export interface FontDef {
  /** Stored in saved designs, so it must stay stable. */
  id: string;
  label: string;
  /** The file under src/assets/fonts, named here once for both loaders. */
  file: string;
}

/**
 * One clear sans-serif and one bold rounded face.
 *
 * The ids are what a design file records, so renaming one would invalidate
 * saved work. The labels name the real typeface, because "Sans" alone tells you
 * nothing about what you are going to get on the bed.
 */
export const FONTS: FontDef[] = [
  { id: "sans", label: "Sans — Noto Sans", file: "NotoSans-Regular.ttf" },
  { id: "rounded", label: "Rounded bold — Nunito Bold", file: "Nunito-Bold.ttf" },
];

export const DEFAULT_FONT_ID = FONTS[0].id;

export function fontDef(id: string): FontDef {
  const def = FONTS.find((f) => f.id === id);
  if (!def) {
    throw new Error(`Unknown font "${id}". This app has: ${FONTS.map((f) => f.id).join(", ")}.`);
  }
  return def;
}

/**
 * Hand one font's bytes to replicad, under its own id.
 *
 * `force` is on because replicad's registry is module-global and silently keeps
 * the first font registered under a family name. In Vitest that registry is
 * shared across a file's tests, so without it a reload would be a no-op and we
 * could end up measuring a stale font.
 */
export async function registerFont(id: string, bytes: ArrayBuffer): Promise<void> {
  await loadFont(bytes, fontDef(id).id, true);
}

/**
 * The font, or a clear error.
 *
 * replicad's own `textBlueprints` quietly falls back to whatever was registered
 * first when a family is missing, which would build the right text in the wrong
 * typeface. Looking it up here instead turns that into a failure.
 */
export function loadedFont(id: string): Font {
  const def = fontDef(id);
  const font = getFont(def.id);
  if (!font) {
    throw new Error(
      `The font "${def.label}" is not loaded. Fonts must be registered before building text.`,
    );
  }
  return font;
}

/**
 * The em size that makes a capital letter exactly `capHeightMm` tall.
 *
 * opentype sizes text by the em square, which is taller than any letter and
 * differs between fonts — 10 pt of Noto Sans and 10 pt of Nunito do not measure
 * the same. Callipers measure the capital, so that is what the parameter means.
 *
 * Cap height comes from the top of a drawn "H" rather than the font's declared
 * `OS/2.sCapHeight`, because the two disagree: Nunito Bold declares 705 units
 * and draws its H to 713. The drawn height is the one that ends up on the bed.
 */
export function emSizeForCapHeight(font: Font, capHeightMm: number): number {
  const capHeightUnits = font.charToGlyph("H").getBoundingBox().y2;
  if (!(capHeightUnits > 0)) {
    throw new Error("This font has no usable capital H, so cap height cannot be measured.");
  }
  return (capHeightMm * font.unitsPerEm) / capHeightUnits;
}

/** Name a character the way a person would recognise it in a message. */
function describe(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const hex = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  // Control characters have no glyph to show, so show the escape instead.
  const shown = codePoint < 0x20 || codePoint === 0x7f ? JSON.stringify(character) : `"${character}"`;
  return `${shown} (${hex})`;
}

/**
 * Refuse text the font cannot draw, naming the character.
 *
 * This matters more than it looks. opentype does not fail on a character it
 * lacks — it substitutes `.notdef`, which in both bundled fonts is a filled
 * rectangle. So the silent outcome is not a missing letter but a printed block,
 * and the first time you would notice is on the bed.
 *
 * The check runs against the real font, not a fixed list of allowed characters.
 * A list would have to be duplicated into the page, where there is no font to
 * consult, and would then reject "é" and "€" — which both fonts actually have.
 */
export function assertFontCanDraw(text: string, fontId: string): void {
  const def = fontDef(fontId);
  const font = loadedFont(fontId);

  // Iterate code points, not UTF-16 units, so an emoji is reported as one
  // character rather than as two meaningless halves.
  const characters = [...text];
  for (const [index, character] of characters.entries()) {
    if (font.charToGlyphIndex(character) > 0) continue;
    throw new Error(
      `${def.label} has no glyph for ${describe(character)}, ` +
        `character ${index + 1} of ${characters.length}. ` +
        "Remove it or choose another font — it would otherwise print as a solid block.",
    );
  }
}
