// From vitest rather than vite, so the `test` section below type-checks. It
// re-exports vite's own defineConfig, so the build is unaffected.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
     * Thirty seconds, not Vitest's five.
     *
     * Five is a sensible default for unit tests; these drive a CAD kernel.
     * Extruding the whole 76-character set takes about 380 ms on its own, and
     * the test files run in parallel, so a handful of heavy builds competing
     * for cores will pass five seconds while being perfectly healthy. A
     * timeout that fires on contention rather than on a hang teaches you to
     * re-run the suite instead of reading it.
     */
    testTimeout: 30_000,
  },
  server: {
    // Bind IPv4 loopback explicitly. Left to itself the dev server listens on
    // [::1] only, so anything that resolves localhost to 127.0.0.1 cannot
    // reach it. Still local-only — this does not expose the server to the
    // network, which D1 wants to keep true.
    host: "127.0.0.1",
    // Fail loudly rather than creeping to 5174, 5175… when something is
    // already on the port. A silently moved port is how you end up testing a
    // stale server.
    strictPort: true,
  },
  // The OpenCascade glue is a large Emscripten bundle that ships its own .wasm
  // alongside it. Letting esbuild pre-bundle it breaks the relative path it
  // uses to find that file, so keep it out of dep optimisation.
  optimizeDeps: {
    exclude: ["replicad-opencascadejs"],
  },
});
