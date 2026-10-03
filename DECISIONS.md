# Decisions

Format: what we decided, why, what we rejected, and how reversible it is.

## D1 — Browser-based static app, no cloud (2026-10-03)
- **Why:** CAD math runs on the user's machine. A static site needs no server and runs locally or on any free static host.
- **Rejected:** AWS/GCP backend (not needed until save, share, or accounts), and a Python desktop app (harder to share).
- **Reversibility:** High. Cloud can be added later for storage without touching the core.

## D2 — Geometry kernel: replicad (OpenCascade) (2026-10-03)
- **Why:** Exact curves and real fillets, which Fusion-style modeling needs. MIT licensed and actively released (1.1.0, Sep 2026). STL and STEP export.
- **Rejected:** Manifold (mesh-only, no exact fillets), raw opencascade.js (original is dormant), CADmium/truck (archived).
- **Cost:** About a 23 MB WebAssembly download, so the first load is slow. Acceptable for a personal local tool.
- **Reversibility:** Medium. Keep kernel calls behind our own module so it could be swapped.

## D3 — Sketch constraints via planegcs, later (2026-10-03)
- **Why:** FreeCAD's production solver, ported to WebAssembly, actively maintained.
- **Status:** Not in scope until the sketch bite.

## D4 — Stack: Vite + TypeScript + three.js, Vitest for tests (2026-10-03)
- **Why:** Vite gives a zero-config local dev server. TypeScript catches mistakes before runtime. three.js is the standard 3D viewport and is used by every reference project.
- **Trade-off:** TypeScript adds a little syntax to learn compared with plain JavaScript.
- **Reversibility:** High.

## D5 — Kernel runs in a Web Worker (2026-10-03)
- **Why:** OpenCascade is heavy. Running it off the main thread keeps the UI responsive, as replicad's docs recommend.

## D6 — Reference projects: read, never copy (2026-10-03)
- **Why:** JSketcher (constraints, feature history) and Chili3D (closest living implementation) are the best learning sources. Chili3D is AGPL, so copying its code would force our license.

## D7 — First bite: tracer bullet (2026-10-03)
- **Scope:** A hard-coded shape (box with a hole) built by replicad, shown in a three.js viewport, exported as STL, then sliced in Bambu Studio and printed on the A1.
- **Why:** Proves the whole pipeline end to end before building any real features.

## D8 — Build the part as a 2D profile, cut, then extrude (2026-10-03)
- **What:** `drawRectangle(40, 30).cut(drawCircle(5)).sketchOnPlane("XY").extrude(10)`.
- **Why:** The hole's position follows from the drawing itself, so the result does not depend on where replicad's 3D primitives sit relative to the origin. The 2D route is also what replicad's own docs use for plate-like parts.
- **Rejected:** `makeBaseBox(40,30,10).cut(makeCylinder(5,10))`. It exercises 3D booleans, which real modelling will need, but it relies on the primitives' default placement — if `makeBaseBox` is centred in Z and the cylinder is not, the hole silently becomes a pocket and the volume is wrong rather than an error.
- **Reversibility:** High. The shape lives in one function, `makeBoxWithHole` in `src/kernel/shapes.ts`.

## D9 — replicad-opencascadejs is LGPL-2.1-only (2026-10-03)
- **What:** Accepted as a dependency. replicad itself is MIT; its OpenCascade WASM build is LGPL-2.1-only.
- **Why:** CLAUDE.md permits LGPL when used as a library, which is how it is used here — consumed unmodified through its public API, not linked into our source.
- **Watch:** Modifying the OpenCascade build, rather than just calling it, would pull LGPL obligations onto that modified copy.

## D10 — TypeScript `strict` turned on (2026-10-03)
- **What:** Added `"strict": true` to the tsconfig that `create-vite` generated, which omits it.
- **Why:** D4 chose TypeScript to catch mistakes before runtime; without `strict`, null and `any` slip through and most of that value is lost.
- **Reversibility:** High, but gets more expensive the more code is written against it.
