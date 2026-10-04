/**
 * Page UI: owns the status line, the controls and the worker conversation.
 * Deliberately knows nothing about geometry — the shape library lives in the
 * worker, and arrives here as plain data.
 */
import type { WorkerRequest, WorkerResponse } from "./kernel/worker";
import type { Design } from "./design";
import type { ShapeCatalogEntry } from "./shapes/shapeLibrary";
import { defaultDesign } from "./design";
import { autosave, parseDesign, restoreAutosave, serialiseDesign } from "./designFile";
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
const fitButton = requireElement("#fit-view") as HTMLButtonElement;
const newButton = requireElement("#design-new") as HTMLButtonElement;
const openButton = requireElement("#design-open") as HTMLButtonElement;
const saveButton = requireElement("#design-save") as HTMLButtonElement;
const fileInput = requireElement("#design-file") as HTMLInputElement;
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
  errorEl.dataset.kind = "error";
  errorEl.hidden = false;
}

/**
 * Say why something was refused, without claiming the app has failed.
 *
 * A rejected file leaves the current design untouched and still buildable, so
 * the status line keeps showing its volume. Only the panel speaks up.
 */
function showNotice(text: string): void {
  console.warn(`[browser-cad] ${text}`);
  errorEl.textContent = text;
  errorEl.dataset.kind = "notice";
  errorEl.hidden = false;
}

function clearError(): void {
  errorEl.hidden = true;
  errorEl.textContent = "";
  delete errorEl.dataset.kind;
  delete statusEl.dataset.state;
}

/** Hand a generated file to the browser's downloader. */
function download(filename: string, bytes: ArrayBuffer | string, type: string): void {
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
let shapeCatalog: ShapeCatalogEntry[] = [];
let formValid = true;
/** Cleared when the kernel rejects a design, so export cannot run ahead of it. */
let lastBuildSucceeded = false;

function requestBuild(design: Design): void {
  // Only clear a previous build failure. A notice about a file or an autosave
  // refers to something the user still needs to read.
  if (errorEl.dataset.kind !== "notice") clearError();
  statusEl.textContent = "Building…";
  worker.postMessage({
    type: "build",
    requestId: nextRequestId++,
    design,
  } satisfies WorkerRequest);
}

// Re-framing is now the only thing that moves the camera, so it needs a button.
fitButton.addEventListener("click", () => viewport.fitView());

/**
 * Every edit goes through here: autosave first, then rebuild.
 *
 * Only edits autosave. The build that happens on page load does not, so a
 * damaged autosave entry survives being read and reported — it is replaced the
 * first time the user actually changes something, not the moment they look at
 * the page. See D29.
 */
function onDesignChanged(design: Design): void {
  autosave(design, window.localStorage);
  requestBuild(design);
}

saveButton.addEventListener("click", () => {
  const design = controls?.current();
  if (!design) {
    showNotice("Fix the highlighted field before saving.");
    return;
  }
  download("design.json", serialiseDesign(design), "application/json");
  noteEl.textContent = "Saved design.json";
});

// The button is the visible control; the file input is a hidden mechanism.
openButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  // Reset immediately, or choosing the same file twice fires no second change.
  fileInput.value = "";
  if (!file || !controls) return;

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    showNotice(`Could not read ${file.name}: ${error}`);
    return;
  }

  const result = parseDesign(text, shapeCatalog);
  if (!result.ok) {
    // The design on screen is untouched, which is why this is a notice and not
    // an error: nothing has broken, the file was simply not usable.
    showNotice(`${file.name} was not loaded. ${result.problem}`);
    return;
  }
  clearError();
  noteEl.textContent = `Opened ${file.name}`;
  controls.replace(result.design);
});

newButton.addEventListener("click", () => {
  if (!controls) return;
  if (!window.confirm("Start a new design? The current one will be replaced.")) return;
  clearError();
  noteEl.textContent = "";
  controls.reset();
});

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
      shapeCatalog = message.catalog;

      // Pick up where they left off, unless the slot is empty or damaged.
      const restored = restoreAutosave(shapeCatalog, window.localStorage);
      if (restored.status === "unreadable") {
        showNotice(
          `Your last design could not be restored, so this is a fresh one. ${restored.problem}`,
        );
      }
      const initialDesign =
        restored.status === "restored" ? restored.design : defaultDesign(shapeCatalog);

      controls = createDesignControls(controlsEl, {
        catalog: shapeCatalog,
        initialDesign,
        onChange: onDesignChanged,
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
