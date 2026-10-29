/**
 * Symbols that can be typed inside a Text item.
 *
 * `"I ♥ MOM"` is one Text item, not three items with hand-placed X positions:
 * the ♥ is laid out as part of the line, so shortening a word still leaves the
 * whole thing evenly spaced and centred.
 *
 * One entry per symbol, the same arrangement the shape library uses — a new
 * symbol is one entry here and nothing else, including its insert button, which
 * the sidebar builds from this list.
 *
 * Pure data: no replicad, no kernel, no DOM. That is what lets the page import
 * it directly for the buttons rather than waiting for the worker to send a
 * catalogue the way D19 has it do for shapes.
 */
import type { Outline } from "../svg/outline";
import { HEART_OUTLINE } from "../svg/heart";
import { STAR_OUTLINE } from "../svg/star";

export interface SymbolDef {
  /** The character that stands for this symbol in the text. */
  character: string;
  /** Names it on its insert button and in a refusal. */
  label: string;
  /**
   * The outline, normalised exactly as an imported one is (D41): box centred
   * on the origin, longer side 1, Y up.
   */
  outline: Outline;
  /**
   * How tall to draw it, as a fraction of the font's capital height.
   *
   * Per symbol, and set by eye in a real design rather than derived — how big
   * a shape needs to be to read as part of a line is a judgement about how it
   * looks, not something the geometry can tell you. Both started at 0.75 on
   * the reasoning that a solid mass reads bigger than a capital's stems; the
   * heart then turned out to read like punctuation at that size and went to
   * 0.9, while the star still looked right. So the heart is now the taller of
   * the two, which no tidy theory would have predicted. See D54.
   */
  capHeightRatio: number;
  /**
   * Where its bottom edge sits, as a fraction of the capital height above the
   * baseline.
   *
   * Both symbols are centred in the band the capitals occupy, which is
   * `(1 - capHeightRatio) / 2`. Neither has a feature that wants to sit on the
   * baseline — no flat foot like H, no overshoot like O — so centring in the
   * cap band is what makes them read as part of the line, in any font.
   */
  baselineRatio: number;
}

/** Centre a symbol in the band between the baseline and the cap height. */
const centredInCaps = (capHeightRatio: number): number => (1 - capHeightRatio) / 2;

export const SYMBOLS: SymbolDef[] = [
  {
    character: "♥",
    label: "Heart",
    // The same heart as samples/heart.svg and the Outline shape's default —
    // one source, imported here rather than copied.
    outline: HEART_OUTLINE,
    // 0.9, not the 0.75 this started at: at 0.75 it read like punctuation
    // beside the letters, most obviously in Sniglet. A heart is wider than it
    // is tall, so at 0.9 of the cap height it comes out very slightly wider
    // than a capital is tall — which is what makes it sit as an equal in the
    // line rather than as a mark between words.
    capHeightRatio: 0.9,
    baselineRatio: centredInCaps(0.9),
  },
  {
    character: "★",
    label: "Star",
    outline: STAR_OUTLINE,
    capHeightRatio: 0.8,
    baselineRatio: centredInCaps(0.8),
  },
];

/**
 * The symbol a character stands for, or undefined.
 *
 * Consulted *before* the font, so ♥ means this heart whatever a font happens to
 * contain. A font's own dingbat would be a different shape at a different size,
 * and which part you got would depend on the typeface — the opposite of what a
 * symbol is for.
 */
export function symbolFor(character: string): SymbolDef | undefined {
  return SYMBOLS.find((symbol) => symbol.character === character);
}

/** The characters every symbol claims, for messages and for the UI. */
export const SYMBOL_CHARACTERS = SYMBOLS.map((symbol) => symbol.character);
