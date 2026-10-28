/**
 * Loading the bundled fonts in a browser. Imported by the worker only.
 *
 * The TTFs are bundled assets, so Vite emits them next to the app and this
 * fetches them from our own origin — the same arrangement as the OpenCascade
 * `.wasm`. Nothing talks to a font service, and the app still works offline.
 *
 * Node cannot fetch an emitted asset path, so the tests use the sibling
 * `bundledFonts.node.ts` instead. Both drive `registerFont` from the same
 * `FONTS` list, so the two routes cannot load different fonts.
 */
import { FONTS, registerFont } from "./fonts";

/**
 * Every TTF in the assets folder, as a URL, keyed by its path.
 *
 * A glob rather than two named imports: a font is then one entry in `FONTS`
 * plus the file itself, with nothing here to keep in step.
 */
const FONT_URLS = import.meta.glob<string>("../assets/fonts/*.ttf", {
  query: "?url",
  import: "default",
  eager: true,
});

function urlFor(file: string): string {
  const match = Object.entries(FONT_URLS).find(([path]) => path.endsWith(`/${file}`));
  if (!match) {
    const found = Object.keys(FONT_URLS).join(", ") || "none";
    throw new Error(`No bundled font file "${file}". The assets folder has: ${found}.`);
  }
  return match[1];
}

/**
 * Register every bundled font. The worker awaits this before it says it is
 * ready, so a build can never race a font that is still arriving.
 */
export async function loadBundledFonts(): Promise<void> {
  await Promise.all(
    FONTS.map(async ({ id, file }) => {
      const url = urlFor(file);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load font ${file} from ${url}: ${response.status}.`);
      }
      await registerFont(id, await response.arrayBuffer());
    }),
  );
}
