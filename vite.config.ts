import { defineConfig } from "vite";

export default defineConfig({
  // The OpenCascade glue is a large Emscripten bundle that ships its own .wasm
  // alongside it. Letting esbuild pre-bundle it breaks the relative path it
  // uses to find that file, so keep it out of dep optimisation.
  optimizeDeps: {
    exclude: ["replicad-opencascadejs"],
  },
});
