/**
 * Page UI: owns the status line and talks to the kernel worker. Deliberately
 * knows nothing about geometry.
 */
import type { WorkerRequest, WorkerResponse } from "./kernel/worker";

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`index.html is missing ${selector}`);
  return element;
}

const statusEl = requireElement("#status");
const errorEl = requireElement("#error");

/** Surface failures on the page as well as in the console — never swallow. */
function showError(context: string, error: unknown): void {
  console.error(`[browser-cad] ${context}:`, error);
  statusEl.textContent = "Failed";
  statusEl.dataset.state = "error";
  errorEl.textContent = error instanceof Error ? error.message : String(error);
  errorEl.hidden = false;
}

statusEl.textContent = "Loading kernel...";

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
      statusEl.textContent = `Volume: ${message.volumeMm3.toFixed(3)} mm³`;
      statusEl.dataset.state = "done";
      break;
    case "error":
      if (message.stack) console.error(message.stack);
      showError("Kernel error", new Error(message.message));
      break;
  }
};
