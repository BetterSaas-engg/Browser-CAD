/**
 * The shape picker and its parameter fields.
 *
 * Built entirely from the catalogue the worker sends, so adding a shape to the
 * library needs no change here. Imports only types from the library, which are
 * erased at build time — this module never pulls replicad into the page bundle.
 */
import type { ParamSpec, ParamValues, ShapeCatalogEntry } from "../shapes/shapeLibrary";

/** How long to wait after the last keystroke before rebuilding. */
const DEBOUNCE_MS = 350;

export interface ShapeControlsOptions {
  catalog: ShapeCatalogEntry[];
  /** Called with a valid shape and parameters, debounced. */
  onChange(shapeId: string, params: ParamValues): void;
  /** Called when validity changes, so the page can disable export. */
  onValidityChange(valid: boolean): void;
}

interface Field {
  spec: ParamSpec;
  input: HTMLInputElement;
  error: HTMLElement;
}

/**
 * Check one field against its own limits. Cross-field rules are handled
 * separately, since they need every value at once.
 */
function checkOwn(spec: ParamSpec, input: HTMLInputElement): string | null {
  // A number input blanks its value when the text cannot be parsed, so "abc"
  // and "" look identical from `value` alone. badInput tells them apart, which
  // is the difference between "Must be a number" and "Required".
  if (input.validity.badInput) return "Must be a number";

  const raw = input.value;
  if (raw.trim() === "") return "Required";
  // Number(" ") is 0, hence the blank check above.
  const value = Number(raw);
  if (!Number.isFinite(value)) return "Must be a number";
  if (value < spec.min) {
    return spec.min === 0 ? "Cannot be negative" : `Must be at least ${spec.min} mm`;
  }
  if (value > spec.max) return `Must be at most ${spec.max} mm (A1 build volume)`;
  return null;
}

export function createShapeControls(
  container: HTMLElement,
  { catalog, onChange, onValidityChange }: ShapeControlsOptions,
) {
  const picker = document.createElement("select");
  picker.id = "shape-picker";
  for (const shape of catalog) {
    const option = document.createElement("option");
    option.value = shape.id;
    option.textContent = shape.label;
    picker.append(option);
  }

  const pickerLabel = document.createElement("label");
  pickerLabel.className = "field";
  pickerLabel.append(Object.assign(document.createElement("span"), { textContent: "Shape" }), picker);

  const fieldsEl = document.createElement("div");
  fieldsEl.className = "fields";

  container.append(pickerLabel, fieldsEl);

  let fields: Field[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastValid = false;

  function currentShape(): ShapeCatalogEntry {
    const shape = catalog.find((s) => s.id === picker.value);
    if (!shape) throw new Error(`Catalogue has no shape "${picker.value}"`);
    return shape;
  }

  /**
   * Validate everything, paint the messages, and return the values if they all
   * pass. Returns null if anything is wrong.
   */
  function validate(): ParamValues | null {
    const values: ParamValues = {};
    let ok = true;

    // Own-limit pass first, so cross-field rules only see usable numbers.
    for (const { spec, input, error } of fields) {
      const message = checkOwn(spec, input);
      error.textContent = message ?? "";
      input.classList.toggle("invalid", message !== null);
      if (message) ok = false;
      else values[spec.key] = Number(input.value);
    }

    if (ok) {
      for (const { spec, input, error } of fields) {
        const violated = (spec.lessThan ?? [])
          .map((key) => fields.find((f) => f.spec.key === key))
          .filter((f): f is Field => f !== undefined && values[spec.key] >= values[f.spec.key])
          // Name the tightest bound; fixing that one fixes the rest.
          .sort((a, b) => values[a.spec.key] - values[b.spec.key]);

        const tightest = violated[0];
        if (!tightest) continue;
        error.textContent = `Must be less than ${tightest.spec.label.toLowerCase()} (${values[tightest.spec.key]} mm)`;
        input.classList.add("invalid");
        ok = false;
      }
    }

    if (ok !== lastValid) {
      lastValid = ok;
      onValidityChange(ok);
    }
    return ok ? values : null;
  }

  /** Validate now; rebuild only after the user stops typing. */
  function scheduleRebuild(): void {
    const values = validate();
    clearTimeout(timer);
    if (!values) return;
    timer = setTimeout(() => onChange(picker.value, values), DEBOUNCE_MS);
  }

  /** Rebuild the parameter fields for whichever shape is selected. */
  function renderFields(): void {
    fieldsEl.replaceChildren();
    fields = currentShape().params.map((spec) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.value = String(spec.default);
      input.id = `param-${spec.key}`;
      input.addEventListener("input", scheduleRebuild);

      const error = document.createElement("span");
      error.className = "field-error";

      const label = document.createElement("label");
      label.className = "field";
      label.append(
        Object.assign(document.createElement("span"), { textContent: spec.label }),
        input,
        error,
      );
      fieldsEl.append(label);
      return { spec, input, error };
    });
  }

  picker.addEventListener("change", () => {
    renderFields();
    // A different shape is a deliberate choice, not mid-typing: build at once.
    clearTimeout(timer);
    const values = validate();
    if (values) onChange(picker.value, values);
  });

  renderFields();

  return {
    /** The current selection, if it is valid. */
    current(): { shapeId: string; params: ParamValues } | null {
      const params = validate();
      return params ? { shapeId: picker.value, params } : null;
    },
  };
}
