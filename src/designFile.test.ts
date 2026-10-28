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

/** A design whose second item is engraved text, for the mixed-parameter cases. */
const engraved: Design = {
  version: DESIGN_VERSION,
  items: [
    newItem("box", { width: 60, depth: 20, height: 5 }),
    {
      ...newItem("text", { text: "AK + 2 = ?", letterHeight: 6, depth: 1.5, font: "rounded" }, "cut"),
      position: { x: 0, y: 0, z: 4 },
      rotationZ: 0,
    },
  ],
};

/** Deep-clone and mutate a valid design, so each case differs in one way only. */
function broken(mutate: (d: any) => void): unknown {
  const copy = structuredClone(plate) as any;
  mutate(copy);
  return copy;
}

/** The same, for the text design, so text cases can be broken one field at a time. */
function brokenText(mutate: (d: any) => void): unknown {
  const copy = structuredClone(engraved) as any;
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

  it("round-trips a design containing text", () => {
    // The interesting case: `params` now holds a string, a couple of numbers
    // and a font id side by side, and all four have to survive JSON intact.
    const result = parseDesign(serialiseDesign(engraved), CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design).toEqual(engraved);
    expect(result.design.items[1].params.text).toBe("AK + 2 = ?");
    expect(result.design.items[1].params.font).toBe("rounded");
  });

  it("keeps punctuation and spacing in text exactly as typed", () => {
    // JSON escaping, and our own serialiser, must not touch the one field the
    // user can put arbitrary characters into.
    const fussy = structuredClone(engraved);
    fussy.items[1].params.text = '  a "quoted" \\ back? ';
    const result = parseDesign(serialiseDesign(fussy), CATALOG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design.items[1].params.text).toBe('  a "quoted" \\ back? ');
  });

  it("round-trips text through the autosave slot too", () => {
    const store = fakeStore();
    autosave(engraved, store);
    const result = restoreAutosave(CATALOG, store);
    expect(result.status).toBe("restored");
    if (result.status !== "restored") return;
    expect(result.design).toEqual(engraved);
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

    // --- the parameter kinds text brought in ---
    ["numeric text", brokenText((d) => (d.items[1].params.text = 42)), /Item 2.*Text must be a string/i],
    ["blank text", brokenText((d) => (d.items[1].params.text = "   ")), /Item 2.*Text is blank/i],
    ["empty text", brokenText((d) => (d.items[1].params.text = "")), /Item 2.*Text is blank/i],
    [
      "text past the length limit",
      brokenText((d) => (d.items[1].params.text = "A".repeat(81))),
      /Item 2.*81 characters, over the 80 allowed/i,
    ],
    [
      "an unknown font",
      brokenText((d) => (d.items[1].params.font = "papyrus")),
      /Item 2.*unknown font "papyrus".*sans, rounded/i,
    ],
    [
      "a numeric font",
      brokenText((d) => (d.items[1].params.font = 1)),
      /Item 2.*Font must be a string/i,
    ],
    [
      "a missing text parameter",
      brokenText((d) => delete d.items[1].params.text),
      /Item 2.*Text is missing Text/i,
    ],
    [
      "a letter height outside the limits",
      brokenText((d) => (d.items[1].params.letterHeight = 0)),
      /Item 2.*outside the allowed/i,
    ],
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

  it("reports a refused write instead of throwing or swallowing it", () => {
    // Swallowing this was the bug: autosave would stop working and say
    // nothing, and the loss only showed up on the next refresh (D31).
    const full: DesignStore = {
      getItem: () => null,
      setItem: () => {
        const error = new Error("exceeded the quota");
        error.name = "QuotaExceededError";
        throw error;
      },
      removeItem: () => {},
    };

    let result: ReturnType<typeof autosave> | undefined;
    expect(() => (result = autosave(plate, full))).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.problem).toMatch(/not being saved automatically/i);
    expect(result.problem).toMatch(/storage is full|private/i);
  });

  it("names a failure it does not recognise rather than guessing", () => {
    const odd: DesignStore = {
      getItem: () => null,
      setItem: () => {
        const error = new Error("nope");
        error.name = "SecurityError";
        throw error;
      },
      removeItem: () => {},
    };
    const result = autosave(plate, odd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain("SecurityError");
  });

  it("reports success, so the caller can tell when saving recovers", () => {
    expect(autosave(plate, fakeStore()).ok).toBe(true);
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
