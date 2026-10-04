/**
 * Worker plumbing: pull the OpenCascade WebAssembly build off the main thread,
 * hand it to replicad, then build shapes on request. Nothing in here knows what
 * any shape is — that is the shape library.
 *
 * The worker also owns the library itself and sends the UI a plain-data
 * catalogue of it, so the UI never imports replicad.
 */
import { setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { buildShape } from "./build";
import { shapeStl } from "./stl";
import { catalog } from "../shapes/shapeLibrary";
import { meshBuffers } from "../mesh";
import type { ParamValues, ShapeCatalogEntry } from "../shapes/shapeLibrary";
import type { PartMesh } from "../mesh";

export type WorkerRequest =
  | { type: "build"; requestId: number; shapeId: string; params: ParamValues }
  | { type: "exportStl"; shapeId: string; params: ParamValues };

export type WorkerResponse =
  | { type: "ready"; catalog: ShapeCatalogEntry[] }
  | { type: "result"; requestId: number; volumeMm3: number; mesh: PartMesh }
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
  () => ctx.postMessage({ type: "ready", catalog: catalog() }),
  (error: unknown) => fail("Kernel failed to load", error),
);

ctx.onmessage = async (event) => {
  const request = event.data;
  try {
    await kernelReady;
    switch (request?.type) {
      case "build": {
        const { volumeMm3, mesh } = buildShape(request.shapeId, request.params);
        // Hand the mesh buffers over rather than cloning them; the worker has
        // no further use for them. The request id goes back out so the page can
        // drop results for edits the user has already typed past.
        ctx.postMessage(
          { type: "result", requestId: request.requestId, volumeMm3, mesh },
          meshBuffers(mesh),
        );
        break;
      }
      case "exportStl": {
        const { filename, bytes } = await shapeStl(request.shapeId, request.params);
        ctx.postMessage({ type: "stl", filename, bytes }, [bytes]);
        break;
      }
      default:
        throw new Error(`Unknown request ${JSON.stringify(request)}`);
    }
  } catch (error) {
    fail(request?.type === "exportStl" ? "STL export failed" : "Geometry failed", error);
  }
};
