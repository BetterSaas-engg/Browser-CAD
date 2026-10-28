/**
 * Loading the bundled fonts in Node, for Vitest.
 *
 * The browser route (`bundledFonts.ts`) fetches the URLs Vite emits for the
 * bundled assets, which Node has no server to fetch from. This reads the same
 * files off disk instead. Both drive `registerFont` from the same `FONTS` list,
 * so neither route can load a font the other does not.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FONTS, registerFont } from "./fonts";

/** Register every bundled font. Call it in `beforeAll`, beside `setOC`. */
export async function loadBundledFontsFromDisk(): Promise<void> {
  await Promise.all(
    FONTS.map(async ({ id, file }) => {
      const path = fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url));
      const bytes = await readFile(path);
      // Node may hand back a view into a larger pooled buffer, so slice to
      // exactly this file's bytes before opentype parses it.
      await registerFont(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }),
  );
}
