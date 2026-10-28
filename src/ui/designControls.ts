/**
 * The design sidebar: the item list, and an editor for whichever item is
 * selected.
 *
 * Built entirely from the catalogue the worker sends, so adding a shape to the
 * library needs no change here. Imports only types from the library, which are
 * erased at build time — this module never pulls replicad into the page bundle.
 */
import { OPERATIONS, TRANSFORM_PARAMS, defaultDesign, defaultParams, newItem } from "../design";
import type { Design, DesignItem, Operation } from "../design";
import type {
  NumberParamSpec,
  ParamSpec,
  ParamValue,
  ParamValues,
  ShapeCatalogEntry,
} from "../shapes/shapeLibrary";

/** How long to wait after the last keystroke before rebuilding. */
const DEBOUNCE_MS = 350;

export interface DesignControlsOptions {
  catalog: ShapeCatalogEntry[];
  /** What to open with — a restored autosave, or the default. */
  initialDesign: Design;
  /** Called with a valid design, debounced. */
  onChange(design: Design): void;
  /** Called when validity changes, so the page can disable export. */
  onValidityChange(valid: boolean): void;
}

interface Field {
  spec: ParamSpec;
  /** A number box, a text box or a dropdown, depending on the spec's kind. */
  control: HTMLInputElement | HTMLSelectElement;
  error: HTMLElement;
  /** Advice about printing. Never blocks anything — see `warningFor`. */
  warning: HTMLElement;
}

/** Narrow a field to the numeric case, for rules that only numbers have. */
function asNumber(field: Field): (Field & { spec: NumberParamSpec }) | null {
  return field.spec.kind === "number" ? { ...field, spec: field.spec } : null;
}

/** What a field currently holds, in the type its spec calls for. */
function valueOf({ spec, control }: Field): ParamValue {
  return spec.kind === "number" ? Number(control.value) : control.value;
}

/**
 * Check one field against its own spec. Cross-field rules are handled
 * separately, since they need every value at once.
 */
function checkOwn(spec: ParamSpec, control: HTMLInputElement | HTMLSelectElement): string | null {
  if (spec.kind === "choice") {
    // A dropdown cannot really be wrong, but a design loaded from a file could
    // name a font this build does not have, and silently showing the first
    // option would misrepresent what is about to be built.
    return spec.options.some((option) => option.value === control.value)
      ? null
      : `Unknown ${spec.label.toLowerCase()} "${control.value}"`;
  }

  if (spec.kind === "text") {
    if (control.value.trim() === "") return "Required";
    if (control.value.length > spec.maxLength) return `At most ${spec.maxLength} characters`;
    return null;
  }

  // A number input blanks its value when the text cannot be parsed, so "abc"
  // and "" look identical from `value` alone. badInput tells them apart, which
  // is the difference between "Must be a number" and "Required".
  if (control instanceof HTMLInputElement && control.validity.badInput) return "Must be a number";

  const raw = control.value;
  if (raw.trim() === "") return "Required";
  // Number(" ") is 0, hence the blank check above.
  const value = Number(raw);
  if (!Number.isFinite(value)) return "Must be a number";
  const unit = spec.unit ?? " mm";
  if (value < spec.min) {
    return spec.min === 0 ? "Cannot be negative" : `Must be at least ${spec.min}${unit}`;
  }
  if (value > spec.max) return `Must be at most ${spec.max}${unit}`;
  return null;
}

/**
 * Printability advice for a value that is perfectly valid.
 *
 * Kept apart from `checkOwn` on purpose: this never makes a field invalid, so
 * it can never stop a build or an export. Small text does print — just not
 * always legibly — and which side of that line a part falls on is the user's
 * call, not ours.
 */
function warningFor(spec: ParamSpec, value: ParamValue): string | null {
  if (spec.kind !== "number" || !spec.warnBelow) return null;
  return typeof value === "number" && value < spec.warnBelow.value ? spec.warnBelow.message : null;
}

/**
 * Validate a group of fields together, paint the messages, and return the
 * values if they all pass.
 */
function validateGroup(fields: Field[]): ParamValues | null {
  const values: ParamValues = {};
  let ok = true;

  // Own-spec pass first, so cross-field rules only see usable numbers.
  for (const field of fields) {
    const { spec, control, error, warning } = field;
    const message = checkOwn(spec, control);
    error.textContent = message ?? "";
    control.classList.toggle("invalid", message !== null);
    if (message) {
      // The error is the more urgent thing to read, and advice about a value
      // the user is still typing is noise.
      warning.textContent = "";
      ok = false;
      continue;
    }
    const value = valueOf(field);
    values[spec.key] = value;
    warning.textContent = warningFor(spec, value) ?? "";
  }
  if (!ok) return null;

  for (const field of fields) {
    const numeric = asNumber(field);
    if (!numeric) continue;
    const { spec, control, error } = numeric;

    const violated = (spec.lessThan ?? [])
      .map((key) => fields.find((f) => f.spec.key === key))
      .filter((f): f is Field => f !== undefined && values[spec.key] >= values[f.spec.key])
      // Name the tightest bound; fixing that one fixes the rest.
      .sort((a, b) => Number(values[a.spec.key]) - Number(values[b.spec.key]));

    const tightest = violated[0];
    if (!tightest) continue;
    error.textContent = `Must be less than ${tightest.spec.label.toLowerCase()} (${values[tightest.spec.key]} mm)`;
    control.classList.add("invalid");
    ok = false;
  }
  return ok ? values : null;
}

function labelled(
  text: string,
  control: HTMLElement,
  ...messages: HTMLElement[]
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "field";
  label.append(Object.assign(document.createElement("span"), { textContent: text }), control);
  label.append(...messages);
  return label;
}

export function createDesignControls(
  container: HTMLElement,
  { catalog, initialDesign, onChange, onValidityChange }: DesignControlsOptions,
) {
  if (catalog.length === 0) throw new Error("The shape catalogue is empty");

  // Owned outright: the caller hands one over and never touches it again. Every
  // design that leaves here is a clone, so a build in flight cannot be changed
  // underneath by further typing.
  let design: Design = structuredClone(initialDesign);
  let selected = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastValid = true;

  // --- item list -----------------------------------------------------------
  const list = document.createElement("ol");
  list.id = "item-list";

  const addButton = button("item-add", "+ Add", () => {
    const shape = catalog[0];
    // New items are additions. Cutting would be the more common next step, but
    // a default-sized cut at the origin swallows a default-sized base whole:
    // the design would break the instant you clicked Add. Switching to Cut
    // should be a deliberate act, after the shape has been sized and placed.
    design.items.splice(selected + 1, 0, newItem(shape.id, defaultParams(shape.params), "add"));
    selected += 1;
    afterStructuralChange();
  });
  const removeButton = button("item-remove", "Remove", () => {
    if (design.items.length <= 1) return;
    const remaining = design.items.filter((_, i) => i !== selected);
    if (refuseIfCutWouldLead(remaining, "Removing this would leave a Cut first.")) return;
    design.items = remaining;
    selected = Math.min(selected, design.items.length - 1);
    afterStructuralChange();
  });
  const upButton = button("item-up", "↑", () => move(-1));
  const downButton = button("item-down", "↓", () => move(1));

  function button(id: string, text: string, onClick: () => void): HTMLButtonElement {
    const el = document.createElement("button");
    el.type = "button";
    el.id = id;
    el.textContent = text;
    el.addEventListener("click", onClick);
    return el;
  }

  /**
   * Refuse a reorder or removal that would put a Cut at the top, and say why.
   *
   * The first item has nothing to cut from. Silently flipping it to Add — which
   * is what this used to do — edits the design behind the user's back and
   * cannot be undone. Refusing and explaining leaves them in control (D26).
   */
  function refuseIfCutWouldLead(next: DesignItem[], lead: string): boolean {
    if (next[0]?.operation !== "cut") return false;
    showMessage(`${lead} The first item must be Add, since there is nothing to cut from yet.`);
    return true;
  }

  function move(delta: number): void {
    const target = selected + delta;
    if (target < 0 || target >= design.items.length) return;

    const next = [...design.items];
    const [item] = next.splice(selected, 1);
    next.splice(target, 0, item);
    if (refuseIfCutWouldLead(next, "That would move a Cut to the top.")) return;

    design.items = next;
    selected = target;
    afterStructuralChange();
  }

  const listButtons = document.createElement("div");
  listButtons.className = "item-buttons";
  listButtons.append(addButton, removeButton, upButton, downButton);

  const messageEl = document.createElement("p");
  messageEl.id = "controls-message";
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  /** Explain a refused action, then get out of the way. */
  function showMessage(text: string): void {
    messageEl.textContent = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (messageEl.textContent = ""), 6000);
  }

  function clearMessage(): void {
    clearTimeout(messageTimer);
    messageEl.textContent = "";
  }

  // --- item editor ---------------------------------------------------------
  const editorTitle = document.createElement("h2");

  const shapePicker = document.createElement("select");
  shapePicker.id = "shape-picker";
  for (const shape of catalog) {
    shapePicker.append(new Option(shape.label, shape.id));
  }
  shapePicker.addEventListener("change", () => {
    const shape = shapeFor(shapePicker.value);
    const item = design.items[selected];
    item.shapeId = shape.id;
    item.params = defaultParams(shape.params);
    renderEditor();
    commit(true);
  });

  const operationPicker = document.createElement("select");
  operationPicker.id = "operation-picker";
  for (const op of OPERATIONS) operationPicker.append(new Option(op.label, op.value));
  operationPicker.addEventListener("change", () => {
    design.items[selected].operation = operationPicker.value as Operation;
    renderList();
    commit(true);
  });

  const operationNote = document.createElement("p");
  operationNote.className = "note-inline";
  operationNote.textContent = "The first item is always added.";

  const paramsEl = document.createElement("div");
  const transformEl = document.createElement("div");
  /** Names the X/Y/Z row, whose own labels are a single letter each. */
  const placementHeading = document.createElement("h2");
  placementHeading.textContent = "Position (mm)";

  const editor = document.createElement("div");
  editor.id = "item-editor";
  editor.append(
    editorTitle,
    labelled("Shape", shapePicker),
    labelled("Operation", operationPicker),
    operationNote,
    paramsEl,
    transformEl,
  );

  const itemsHeading = document.createElement("h2");
  itemsHeading.textContent = "Items";
  container.append(itemsHeading, list, listButtons, messageEl, editor);

  let paramFields: Field[] = [];
  let transformFields: Field[] = [];

  function shapeFor(id: string): ShapeCatalogEntry {
    const shape = catalog.find((s) => s.id === id);
    if (!shape) throw new Error(`Catalogue has no shape "${id}"`);
    return shape;
  }

  /** The control a spec asks for, filled in with the item's current value. */
  function makeControl(spec: ParamSpec, value: ParamValue): HTMLInputElement | HTMLSelectElement {
    if (spec.kind === "choice") {
      const select = document.createElement("select");
      for (const option of spec.options) select.append(new Option(option.label, option.value));
      // Assigned after the options exist, or the browser drops the value.
      select.value = String(value);
      // A dropdown has no intermediate state worth debouncing.
      select.addEventListener("change", () => commit(true));
      return select;
    }

    const input = document.createElement("input");
    if (spec.kind === "text") {
      input.type = "text";
      // Stops the overlong case at the keyboard as well as in validation.
      input.maxLength = spec.maxLength;
      input.autocomplete = "off";
      input.spellcheck = false;
    } else {
      input.type = "number";
      input.step = "any";
    }
    input.value = String(value);
    input.addEventListener("input", () => commit(false));
    return input;
  }

  function makeField(
    spec: ParamSpec,
    value: ParamValue,
    shortLabel?: string,
  ): Field & { element: HTMLElement } {
    const control = makeControl(spec, value);
    control.id = `param-${spec.key}`;
    control.title = spec.label;

    const error = document.createElement("span");
    error.className = "field-error";
    const warning = document.createElement("span");
    warning.className = "field-warning";

    return {
      spec,
      control,
      error,
      warning,
      element: labelled(shortLabel ?? spec.label, control, error, warning),
    };
  }

  /** Put short fields side by side rather than stacking them. */
  function row(columns: "cols-2" | "cols-3", fields: HTMLElement[]): HTMLElement {
    const el = document.createElement("div");
    el.className = `field-row ${columns}`;
    el.append(...fields);
    return el;
  }

  function renderList(): void {
    list.replaceChildren();
    design.items.forEach((item, index) => {
      const entry = document.createElement("li");
      const el = document.createElement("button");
      el.type = "button";
      el.className = "item";
      el.dataset.index = String(index);
      el.setAttribute("aria-current", String(index === selected));
      el.textContent = `${index + 1}. ${shapeFor(item.shapeId).label}`;
      const op = document.createElement("span");
      op.className = `op op-${item.operation}`;
      op.textContent = item.operation;
      el.append(op);
      el.addEventListener("click", () => {
        selected = index;
        renderList();
        renderEditor();
      });
      entry.append(el);
      list.append(entry);
    });

    removeButton.disabled = design.items.length <= 1;
    upButton.disabled = selected === 0;
    downButton.disabled = selected === design.items.length - 1;
  }

  function renderEditor(): void {
    const item = design.items[selected];
    editorTitle.textContent = `Item ${selected + 1}`;
    shapePicker.value = item.shapeId;
    operationPicker.value = item.operation;
    // Nothing exists yet for the first item to cut from, so the choice is moot.
    operationPicker.disabled = selected === 0;
    operationNote.hidden = selected !== 0;

    const specs = shapeFor(item.shapeId).params;
    const made = specs.map((spec) => makeField(spec, item.params[spec.key] ?? spec.default));
    paramFields = made;
    paramsEl.replaceChildren(...made.map((f) => f.element));

    const isAxis = (key: string) => key === "x" || key === "y" || key === "z";
    const placement = TRANSFORM_PARAMS.map((spec) =>
      makeField(
        spec,
        isAxis(spec.key) ? item.position[spec.key as "x" | "y" | "z"] : item.rotationZ,
        // X, Y and Z are one character each; spelling out "Position X" three
        // times down the sidebar wastes three rows to say almost nothing. The
        // full label stays as the input's tooltip.
        isAxis(spec.key) ? spec.key.toUpperCase() : undefined,
      ),
    );
    transformFields = placement;

    // Partitioned by key rather than by index, so reordering TRANSFORM_PARAMS
    // cannot silently put the wrong field in the three-column row.
    const axes = placement.filter((f) => isAxis(f.spec.key)).map((f) => f.element);
    const rest = placement.filter((f) => !isAxis(f.spec.key)).map((f) => f.element);
    transformEl.replaceChildren(placementHeading, row("cols-3", axes), ...rest);

    // Paint the messages for the fields just built, so selecting an item shows
    // its printability warnings straight away rather than on the next keystroke.
    validateGroup(paramFields);
    validateGroup(transformFields);
  }

  /**
   * The placement, as the four numbers a design item needs.
   *
   * TRANSFORM_PARAMS is declared as numbers only, so each value is a number by
   * construction once `validateGroup` has accepted it.
   */
  function readPlacement(): { x: number; y: number; z: number; rotationZ: number } | null {
    const values = validateGroup(transformFields);
    if (!values) return null;
    const num = (key: string): number => values[key] as number;
    return { x: num("x"), y: num("y"), z: num("z"), rotationZ: num("rotationZ") };
  }

  /** Read the form into the selected item, and schedule a rebuild. */
  function commit(immediate: boolean): void {
    const params = validateGroup(paramFields);
    const placement = readPlacement();
    const valid = params !== null && placement !== null;

    if (valid !== lastValid) {
      lastValid = valid;
      onValidityChange(valid);
    }

    clearTimeout(timer);
    if (!params || !placement) return;

    const item = design.items[selected];
    item.params = params;
    item.position = { x: placement.x, y: placement.y, z: placement.z };
    item.rotationZ = placement.rotationZ;

    const snapshot = structuredClone(design);
    if (immediate) onChange(snapshot);
    else timer = setTimeout(() => onChange(snapshot), DEBOUNCE_MS);
  }

  /** After adding, removing or reordering: repaint everything and rebuild. */
  function afterStructuralChange(): void {
    // Nothing silently repairs the order any more: the moves that could break
    // it are refused up front, and the kernel rejects a leading cut outright.
    clearMessage();
    renderList();
    renderEditor();
    commit(true);
  }

  renderList();
  renderEditor();

  return {
    /** The current design, if the form is valid. */
    current(): Design | null {
      const params = validateGroup(paramFields);
      const placement = validateGroup(transformFields);
      if (!params || !placement) return null;
      return structuredClone(design);
    },

    /**
     * Swap in a whole design — a loaded file, or a fresh start. Already
     * validated by the caller; this only has to show it.
     */
    replace(next: Design): void {
      design = structuredClone(next);
      selected = 0;
      clearMessage();
      renderList();
      renderEditor();
      commit(true);
    },

    /** Back to a single default shape. */
    reset(): void {
      this.replace(defaultDesign(catalog));
    },

    /** Tell the user why something was refused, in the sidebar. */
    notify(text: string): void {
      showMessage(text);
    },
  };
}
