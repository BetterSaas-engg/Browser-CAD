/**
 * Page UI: owns the status line and talks to the kernel worker. Deliberately
 * knows nothing about geometry.
 */
import type { WorkerRequest, WorkerResponse } from "./kernel/worker";
import { createViewport } from "./viewport/viewport";

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`index.html is missing ${selector}`);
  return element;
}

const statusEl = requireElement("#status");
const errorEl = requireElement("#error");
const viewportEl = requireElement("#viewport");

/** Surface failures on the page as well as in the console — never swallow. */
function showError(context: string, error: unknown): void {
  console.error(`[browser-cad] ${context}:`, error);
  statusEl.textContent = "Failed";
  statusEl.dataset.state = "error";
  errorEl.textContent = error instanceof Error ? error.message : String(error);
  errorEl.hidden = false;
}

statusEl.textContent = "Loading kernel...";

// Built before the kernel is requested, so a machine without WebGL says so
// immediately instead of after a 23 MB download.
let viewport;
try {
  viewport = createViewport(viewportEl);
} catch (error) {
  showError("Could not start the 3D viewport", error);
  throw error;
}

const worker = new Worker(new URL("./kernel/worker.ts", import.meta.url), {
  type: "module",
});

// Fires for worker-level failures (e.g. the module itself fails to parse or
// load), which never reach our own onmessage error path.
worker.onerror = (event) => {
  event.preventDefault();
  showError("Kernel worker crashed", event.message || "see console");
};

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  switch (message.type) {
    case "ready":
      statusEl.textContent = "Kernel ready";
      worker.postMessage({ type: "build" } satisfies WorkerRequest);
      break;
    case "result":
      try {
        viewport.showPart(message.mesh);
      } catch (error) {
        showError("Could not render the part", error);
        break;
      }
      statusEl.textContent = `Volume: ${message.volumeMm3.toFixed(3)} mm³`;
      statusEl.dataset.state = "done";
      break;
    case "error":
      if (message.stack) console.error(message.stack);
      showError("Kernel error", new Error(message.message));
      break;
  }
};
