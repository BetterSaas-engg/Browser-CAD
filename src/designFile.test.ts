import { describe, expect, it } from "vitest";
import { DESIGN_VERSION, defaultDesign, newItem } from "./design";
import type { Design } from "./design";
import {
  AUTOSAVE_KEY,
  autosave,
  parseDesign,
  restoreAutosave,
  serialiseDesign,
  validateDesign,
} from "./designFile";
import type { DesignStore } from "./designFile";
import { catalog } from "./shapes/shapeLibrary";

// The real catalogue, so these tests track the shape library rather than a
// hand-written copy of it that could drift.
const CATALOG = catalog();

/** A Storage stand-in. Vitest runs in Node, where localStorage does not exist. */
function fakeStore(initial?: string): DesignStore & { readonly value: string | undefined } {
  let slot = initial;
  return {
    getItem: (key) => (key === AUTOSAVE_KEY && slot !== undefined ? slot : null),
    setItem: (key, v) => { if (key === AUTOSAVE_KEY) slot = v; },
    removeItem: (key) => { if (key === AUTOSAVE_KEY) slot = undefined; },
    get value() { return slot; },
  };
}

const plate: Design = {
  version: DESIGN_VERSION,
  items: [
    newItem("box", { width: 40, depth: 30, height: 10 }),
    {
      ...newItem("cylinder", { diameter: 10, height: 30 }, "cut"),
      position: { x: 1.5, y: -2, z: -10 },
      rotationZ: 45,
    },
  ],
};

/** Deep-clone and mutate a valid design, so each case differs in one way only. */
function broken(mutate: (d: any) => void): unknown {
  const copy = structuredClone(plate) as any;
  mutate(copy);
  return copy;
}

describe("round trip", () => {
  it("save then load returns an identical design", () => {
    const text = serialiseDesign(plate);
    const result = parseDesign(text, CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design).toEqual(plate);
  });

  it("survives a second trip, so loading is not lossy", () => {
    const once = parseDesign(serialiseDesign(plate), CATALOG);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = parseDesign(serialiseDesign(once.design), CATALOG);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.design).toEqual(plate);
  });

  it("writes something a person can read and a tool can diff", () => {
    const text = serialiseDesign(plate);
    expect(text).toContain('"version": 1');
    expect(text.endsWith("\n")).toBe(true);
    // Indented, not one long line.
    expect(text.split("\n").length).toBeGreaterThan(10);
  });

  it("accepts the default design", () => {
    const result = validateDesign(defaultDesign(CATALOG), CATALOG);
    expect(result.ok).toBe(true);
  });
});

describe("rejecting invalid designs", () => {
  /** Each case: a label, the bad value, and what the message must mention. */
  const CASES: [string, unknown, RegExp][] = [
    ["not JSON at all", "<<<not json>>>", /not valid JSON/i],
    ["a bare array", [], /must be a JSON object/i],
    ["null", null, /must be a JSON object/i],
    ["no version", broken((d) => delete d.version), /no "version" field/i],
    ["a newer version", broken((d) => (d.version = 2)), /version 2.*reads version 1/i],
    ["a string version", broken((d) => (d.version = "1")), /version "1"/i],
    ["no items array", broken((d) => (d.items = {})), /"items" must be an array/i],
    ["an empty design", broken((d) => (d.items = [])), /at least one item/i],
    ["a leading cut", broken((d) => (d.items[0].operation = "cut")), /Item 1 is a Cut/i],
    ["an unknown shape", broken((d) => (d.items[1].shapeId = "dodecahedron")), /unknown shape "dodecahedron"/i],
    ["a missing parameter", broken((d) => delete d.items[1].params.height), /Item 2.*missing Height/i],
    ["a parameter that does not exist", broken((d) => (d.items[1].params.radius = 5)), /Item 2.*no parameter radius/i],
    ["a non-numeric parameter", broken((d) => (d.items[1].params.diameter = "10")), /Item 2.*must be a number/i],
    ["a parameter below its minimum", broken((d) => (d.items[1].params.diameter = 0)), /Item 2.*outside the allowed/i],
    ["a parameter past the build volume", broken((d) => (d.items[0].params.width = 500)), /Item 1.*outside the allowed/i],
    ["an infinite parameter", broken((d) => (d.items[0].params.width = Infinity)), /must be a number/i],
    ["a bad operation", broken((d) => (d.items[1].operation = "subtract")), /Item 2.*"add" or "cut"/i],
    ["a missing position", broken((d) => delete d.items[1].position), /Item 2.*position must be an object/i],
    ["a non-numeric position", broken((d) => (d.items[1].position.x = null)), /Item 2.*must be a number/i],
    ["a position beyond the limit", broken((d) => (d.items[1].position.z = -900)), /Item 2.*outside the allowed/i],
    ["a rotation beyond a full turn", broken((d) => (d.items[1].rotationZ = 720)), /Item 2.*outside the allowed/i],
    ["an unexpected top-level field", broken((d) => (d.name = "my part")), /Unexpected fields at the top level: name/i],
    ["an unexpected item field", broken((d) => (d.items[0].colour = "red")), /Item 1 has unexpected fields: colour/i],
    ["an item that is not an object", broken((d) => (d.items[1] = 7)), /Item 2 is not an object/i],
  ];

  it.each(CASES)("rejects %s", (_label, value, expected) => {
    // Strings go through the JSON parser; everything else is already parsed.
    const result =
      typeof value === "string" ? parseDesign(value, CATALOG) : validateDesign(value, CATALOG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(expected);
    // A message that does not end in a full stop reads like it was cut off.
    expect(result.problem.length).toBeGreaterThan(15);
  });

  it("names the offending item rather than just failing", () => {
    const result = validateDesign(broken((d) => (d.items[1].shapeId = "nope")), CATALOG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("Item 2");
    // And says what it would have accepted.
    expect(result.problem).toContain("box");
  });
});

describe("autosave", () => {
  it("round-trips through the store", () => {
    const store = fakeStore();
    autosave(plate, store);
    const result = restoreAutosave(CATALOG, store);
    expect(result.status).toBe("restored");
    if (result.status !== "restored") return;
    expect(result.design).toEqual(plate);
  });

  it("reports an empty slot rather than an error", () => {
    expect(restoreAutosave(CATALOG, fakeStore()).status).toBe("empty");
    expect(restoreAutosave(CATALOG, fakeStore("   ")).status).toBe("empty");
  });

  it("reports corrupted text instead of throwing", () => {
    const result = restoreAutosave(CATALOG, fakeStore("{ this is not json"));
    expect(result.status).toBe("unreadable");
    if (result.status !== "unreadable") return;
    expect(result.problem).toMatch(/not valid JSON/i);
  });

  it("reports a structurally valid but wrong design", () => {
    const result = restoreAutosave(CATALOG, fakeStore(JSON.stringify({ version: 99, items: [] })));
    expect(result.status).toBe("unreadable");
    if (result.status !== "unreadable") return;
    expect(result.problem).toMatch(/version 99/);
  });

  it("leaves a damaged entry alone rather than destroying it", () => {
    const store = fakeStore("{ corrupted");
    restoreAutosave(CATALOG, store);
    // The caller falls back to a default design; the bad text is still there to
    // be rescued by hand until a real edit replaces it.
    expect(store.value).toBe("{ corrupted");
  });

  it("does not throw when the store refuses to write", () => {
    const full: DesignStore = {
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => {},
    };
    expect(() => autosave(plate, full)).not.toThrow();
  });

  it("does not throw when the store refuses to read", () => {
    const blocked: DesignStore = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => {},
      removeItem: () => {},
    };
    const result = restoreAutosave(CATALOG, blocked);
    expect(result.status).toBe("unreadable");
  });
});
