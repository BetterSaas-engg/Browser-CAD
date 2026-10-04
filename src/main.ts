/**
 * Page UI: owns the status line, the controls and the worker conversation.
 * Deliberately knows nothing about geometry — the shape library lives in the
 * worker, and arrives here as plain data.
 */
import type { WorkerRequest, WorkerResponse } from "./kernel/worker";
import type { Design } from "./design";
import { createViewport } from "./viewport/viewport";
import { createDesignControls } from "./ui/designControls";

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`index.html is missing ${selector}`);
  return element;
}

const statusEl = requireElement("#status");
const errorEl = requireElement("#error");
const viewportEl = requireElement("#viewport");
const controlsEl = requireElement("#controls");
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

function clearError(): void {
  errorEl.hidden = true;
  errorEl.textContent = "";
  delete statusEl.dataset.state;
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

/**
 * Rebuilds are debounced, so several can be in flight at once and they are not
 * guaranteed to come back in order. Each carries an id, and anything older than
 * the newest result is dropped.
 */
let nextRequestId = 1;
let newestShown = 0;
let controls: ReturnType<typeof createDesignControls> | null = null;
let formValid = true;
/** Cleared when the kernel rejects a design, so export cannot run ahead of it. */
let lastBuildSucceeded = false;

function requestBuild(design: Design): void {
  clearError();
  statusEl.textContent = "Building…";
  worker.postMessage({
    type: "build",
    requestId: nextRequestId++,
    design,
  } satisfies WorkerRequest);
}

exportButton.disabled = true;
exportButton.addEventListener("click", () => {
  const design = controls?.current();
  if (!design) return;
  exportButton.disabled = true;
  noteEl.textContent = "Exporting…";
  worker.postMessage({ type: "exportStl", design } satisfies WorkerRequest);
});

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;
  switch (message.type) {
    case "ready": {
      statusEl.textContent = "Kernel ready";
      controls = createDesignControls(controlsEl, {
        catalog: message.catalog,
        onChange: requestBuild,
        onValidityChange: (valid) => {
          formValid = valid;
          // Never export something the viewport is not showing.
          exportButton.disabled = !valid || !lastBuildSucceeded;
          if (!valid) noteEl.textContent = "";
        },
      });
      const design = controls.current();
      if (design) requestBuild(design);
      break;
    }
    case "result":
      // A slower earlier build landing after a newer one would show stale
      // geometry; ignore anything we have already been overtaken by.
      if (message.requestId < newestShown) break;
      newestShown = message.requestId;
      try {
        viewport.showPart(message.mesh);
      } catch (error) {
        showError("Could not render the shape", error);
        break;
      }
      statusEl.textContent = `Volume: ${message.volumeMm3.toFixed(3)} mm³`;
      statusEl.dataset.state = "done";
      lastBuildSucceeded = true;
      exportButton.disabled = !formValid;
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
      // The viewport is deliberately left alone: the last design that did
      // build stays on screen, so the error has something to be read against.
      lastBuildSucceeded = false;
      exportButton.disabled = true;
      break;
  }
};
