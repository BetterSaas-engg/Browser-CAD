/**
 * Proof that the API key and the Anthropic SDK never reach the browser.
 *
 * This is the test that matters most in this bite. The argument for putting the
 * key in the dev server is only worth anything if the client bundle genuinely
 * cannot contain it — and "genuinely" has to mean *checked against a real
 * build*, not reasoned about from the import graph. An accidental import in
 * `main.ts`, or a `VITE_`-prefixed rename of the variable, would both be caught
 * here and nowhere else.
 *
 * It runs a real `vite build` into a scratch directory, then reads every byte
 * of emitted JavaScript.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
/** Its own output directory, so a run of this never disturbs `dist/`. */
const outDir = join(projectRoot, "dist-bundle-check");

/** Every emitted .js file, recursively. */
function scripts(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...scripts(path));
    else if (entry.endsWith(".js")) found.push(path);
  }
  return found;
}

let bundles: { path: string; source: string }[] = [];

beforeAll(() => {
  /*
   * `vite build` only — not `npm run build`, which also runs both tsc passes.
   * Those are checked separately; here the question is purely what ends up in
   * the emitted JavaScript.
   */
  /*
   * Vite's JS entry run under this same Node, rather than the `npx` shim.
   * Node 24 on Windows refuses to spawn a `.cmd` without `shell: true`, and
   * handing a shell a constructed command line is worth avoiding for its own
   * sake — this needs no shell at all.
   */
  execFileSync(
    process.execPath,
    [
      join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--outDir",
      "dist-bundle-check",
      "--emptyOutDir",
      "--logLevel",
      "warn",
    ],
    { cwd: projectRoot, stdio: "pipe", timeout: 180_000 },
  );

  expect(existsSync(outDir)).toBe(true);
  bundles = scripts(outDir).map((path) => ({ path, source: readFileSync(path, "utf8") }));
}, 240_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("the built client bundle", () => {
  it("emits JavaScript to inspect", () => {
    // Guards the rest of this file: assertions over an empty list pass silently.
    expect(bundles.length).toBeGreaterThan(0);
    const total = bundles.reduce((sum, bundle) => sum + bundle.source.length, 0);
    expect(total).toBeGreaterThan(100_000);
  });

  it("contains no reference to the key's variable name", () => {
    /*
     * The name, not a value. Vite only inlines env variables into client code
     * when they begin with `VITE_`, so an unprefixed `ANTHROPIC_API_KEY` cannot
     * be substituted — but a future rename to `VITE_ANTHROPIC_API_KEY` would
     * silently start baking the key into every build, and this is what would
     * fail if it did.
     */
    for (const bundle of bundles) {
      expect(bundle.source, bundle.path).not.toContain("ANTHROPIC_API_KEY");
      expect(bundle.source, bundle.path).not.toContain("ANTHROPIC_MODEL");
    }
  });

  it("contains no key-shaped string at all", () => {
    // Belt and braces: catches a key pasted into source rather than read from
    // the environment.
    for (const bundle of bundles) {
      expect(bundle.source, bundle.path).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8}/);
    }
  });

  it("contains no Anthropic SDK code", () => {
    // Markers the SDK cannot be present without: its package name, the API
    // host, and the two headers every request it builds carries.
    for (const marker of [
      "@anthropic-ai/sdk",
      "api.anthropic.com",
      "anthropic-version",
      "x-api-key",
    ]) {
      for (const bundle of bundles) {
        expect(bundle.source, `${marker} in ${bundle.path}`).not.toContain(marker);
      }
    }
  });

  it("contains none of the endpoint module's own code", () => {
    // If `aiEndpoint.node.ts` were ever imported from client code, these
    // strings would travel with it.
    for (const marker of ["callAnthropic", "browser-cad:ai-design", "configureServer"]) {
      for (const bundle of bundles) {
        expect(bundle.source, `${marker} in ${bundle.path}`).not.toContain(marker);
      }
    }
  });

  it("does contain the client half, so the check is looking at the right build", () => {
    /*
     * The negative assertions above would all pass against a bundle that
     * somehow omitted the feature entirely. This pins that the AI client *is*
     * shipped — the endpoint path it posts to, and the dev-only message.
     */
    const all = bundles.map((bundle) => bundle.source).join("");
    expect(all).toContain("/__ai/generate-design");
    expect(all).toContain("only available in dev mode");
  });
});
