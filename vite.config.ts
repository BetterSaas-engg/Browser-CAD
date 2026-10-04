import { defineConfig } from "vite";

export default defineConfig({
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
