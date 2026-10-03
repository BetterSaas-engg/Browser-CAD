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
const exportButton = requireElement("#export-stl") as HTMLButtonElement;
/** Export feedback, kept apart from the status line so the volume stays visible. */
const noteEl = requireElement("#note");

/** Surface failures on the page as well as in the console — never swallow. */
function showError(context: string, error: unknown): void {
  console.error(`[browser-cad] ${context}:`, error);
  statusEl.textContent = "Failed";
  statusEl.dataset.state = "error";
  errorEl.textContent = `${context}: ${
    error instanceof Error ? error.message : String(error)
  }`;
  errorEl.hidden = false;
}

/** Hand a generated file to the browser's downloader. */
function download(filename: string, bytes: ArrayBuffer, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    // Freed on a later tick: revoking synchronously can cancel the download
    // before the browser has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
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

// Nothing to export until the kernel has produced a part.
exportButton.disabled = true;
exportButton.addEventListener("click", () => {
  exportButton.disabled = true;
  noteEl.textContent = "Exporting…";
  worker.postMessage({ type: "exportStl" } satisfies WorkerRequest);
});

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
      exportButton.disabled = false;
      break;
    case "stl":
      try {
        download(message.filename, message.bytes, "model/stl");
      } catch (error) {
        noteEl.textContent = "";
        showError("Could not save the STL", error);
        exportButton.disabled = false;
        break;
      }
      noteEl.textContent = `Saved ${message.filename} · ${Math.round(
        message.bytes.byteLength / 1024,
      )} KB`;
      exportButton.disabled = false;
      break;
    case "error":
      noteEl.textContent = "";
      if (message.stack) console.error(message.stack);
      showError("Kernel error", new Error(message.message));
      // Let them try again — the kernel is still loaded.
      exportButton.disabled = false;
      break;
  }
};
