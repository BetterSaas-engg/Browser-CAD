/**
 * Worker plumbing: pull the OpenCascade WebAssembly build off the main thread,
 * hand it to replicad, then run geometry on request. Nothing in here knows the
 * shape's dimensions — that is shapes.ts.
 */
import { setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { buildBoxWithHole } from "./shapes";
import { boxWithHoleStl, STL_FILENAME } from "./stl";
import { meshBuffers } from "../mesh";
import type { PartMesh } from "../mesh";

export type WorkerRequest = { type: "build" } | { type: "exportStl" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; volumeMm3: number; mesh: PartMesh }
  | { type: "stl"; filename: string; bytes: ArrayBuffer }
  | { type: "error"; message: string; stack?: string };

/**
 * Vite's tsconfig uses the DOM lib, which types the global `self` as a Window.
 * Narrowing it here is cheaper than adding the webworker lib, which collides
 * with DOM.
 */
const ctx = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: ArrayBuffer[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

/** Errors lose their prototype crossing postMessage, so flatten to strings. */
function flatten(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function fail(context: string, error: unknown): void {
  console.error(`[kernel worker] ${context}:`, error);
  const { message, stack } = flatten(error);
  ctx.postMessage({ type: "error", message: `${context}: ${message}`, stack });
}

// Start loading the 23 MB WASM build immediately; the page is already showing
// "Loading kernel..." by the time this worker spins up.
const kernelReady: Promise<void> = initOpenCascade({
  locateFile: () => wasmUrl,
}).then((oc) => {
  setOC(oc);
});

kernelReady.then(
  () => ctx.postMessage({ type: "ready" }),
  (error: unknown) => fail("Kernel failed to load", error),
);

ctx.onmessage = async (event) => {
  const request = event.data;
  try {
    await kernelReady;
    switch (request?.type) {
      case "build": {
        const { volumeMm3, mesh } = buildBoxWithHole();
        // Hand the mesh buffers over rather than cloning them; the worker has
        // no further use for them.
        ctx.postMessage({ type: "result", volumeMm3, mesh }, meshBuffers(mesh));
        break;
      }
      case "exportStl": {
        const bytes = await boxWithHoleStl();
        ctx.postMessage({ type: "stl", filename: STL_FILENAME, bytes }, [bytes]);
        break;
      }
      default:
        throw new Error(`Unknown request ${JSON.stringify(request)}`);
    }
  } catch (error) {
    fail(request?.type === "exportStl" ? "STL export failed" : "Geometry failed", error);
  }
};
