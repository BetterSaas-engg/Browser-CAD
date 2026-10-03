/**
 * Worker plumbing: pull the OpenCascade WebAssembly build off the main thread,
 * hand it to replicad, then run geometry on request. Nothing in here knows the
 * shape's dimensions — that is shapes.ts.
 */
import { setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { measureBoxWithHoleVolumeMm3 } from "./shapes";

export type WorkerRequest = { type: "build" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "result"; volumeMm3: number }
  | { type: "error"; message: string; stack?: string };

/**
 * Vite's tsconfig uses the DOM lib, which types the global `self` as a Window.
 * Narrowing it here is cheaper than adding the webworker lib, which collides
 * with DOM.
 */
const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void;
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
  try {
    if (event.data?.type !== "build") {
      throw new Error(`Unknown request ${JSON.stringify(event.data)}`);
    }
    await kernelReady;
    ctx.postMessage({ type: "result", volumeMm3: measureBoxWithHoleVolumeMm3() });
  } catch (error) {
    fail("Geometry failed", error);
  }
};
