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

## D11 — Kernel and viewport meet at a plain mesh (2026-10-03)
- **What:** `PartMesh` in `src/mesh.ts` — four typed arrays (vertices, triangles, normals, edges) and nothing else. The kernel produces it; the viewport draws it. Neither imports the other.
- **Why:** Keeps D2's "swap the kernel later" option open, and lets the mesh buffers be transferred across the worker boundary instead of copied. It is also the only thing three.js actually needs.
- **Note:** Edges come from the kernel's own curve tessellation (`meshEdges`), not from three.js rediscovering them from the triangles, so a circular hole stays circular.
- **Reversibility:** High while the format stays this small.

## D12 — Viewport is Z up, matching the kernel (2026-10-03)
- **What:** The camera's up vector is Z and the grid is rotated into XY. three.js defaults to Y up.
- **Why:** The alternative is rotating the part on load, which would make every coordinate on screen disagree with the coordinates the kernel and any future STL export use.
- **Reversibility:** High now, low later — sketch planes and export orientation will both assume it.

## D13 — Camera clip planes are fitted to the part (2026-10-03)
- **What:** `near` and `far` are recomputed from the part's bounding sphere each time one is framed, rather than left at a fixed 0.1 to 10000.
- **Why:** The depth buffer's precision is spread across the near-to-far range. A 100,000:1 span leaves very little of it where the part actually is, which is how coplanar surfaces and overlaid lines start to flicker.
- **Watch:** `near` is the closest you can zoom. It is tied to part size, so a very small part keeps a correspondingly small `near`.

## D14 — STL export tolerance: 0.001 mm / 0.05 rad, binary (2026-10-03)
- **What:** `STL_EXPORT_OPTIONS` in `src/kernel/stl.ts`. Ten times finer than the 0.01 mm / 0.1 rad used for the viewport, and generated from the exact kernel solid rather than from the display mesh.
- **Why:** The display mesh only has to look round; these bytes are the part. At 0.001 mm the facets of the 5 mm hole sit about 1 µm inside the true cylinder, two orders of magnitude below what an A1 resolves through a 0.4 mm nozzle. Measured cost on this part: 1024 triangles, 50 KB, and a mesh volume 0.081 mm³ above exact (7.3e-4 %).
- **Why not finer:** The error is already far below both printer resolution and slicer arithmetic. Halving the tolerance roughly doubles the file for no change to anything printed.
- **Angular tolerance:** The looser of the two at a 5 mm radius, so the linear limit sets the facet count here. Kept as a guard for small-radius features on future parts, where the linear limit alone would permit very coarse angular steps.
- **Binary over ASCII:** Same geometry, about a fifth the size, and no float formatting round trip through text.
- **Reversibility:** High. One constant, consumed in one place.

## D15 — STL volume is checked against the exact volume, bound 1 mm³ (2026-10-03)
- **What:** `src/kernel/stl.test.ts` parses the exported binary STL, sums the signed tetrahedra volumes, and requires the result to be above the exact volume by less than 1 mm³.
- **Why a signed check:** Facet corners sit on the true surface, so the hole the mesh describes is a polygon inscribed in the real circle. That removes slightly less material than the exact cylinder, so the error has a known direction, not just a known size. Checking the direction catches a class of mistakes a magnitude check would not.
- **Why 1 mm³:** 0.009% of the part. Roughly twelve times the deviation this tolerance actually produces, so it will not break when replicad adjusts its tessellator, and far below the 785 mm³ a missing hole would cost or the 1000x of a metre/millimetre mix-up.
- **Also checks:** that the mesh is watertight and consistently wound (otherwise the sum is meaningless), the bounding box is 40 x 30 x 10, and the underside sits on z = 0.

## D16 — AI-assisted design via generated replicad code (2026-10-03)
- **Status:** Planned, not started.
- **What:** The user describes a part in plain language, an LLM writes replicad code, our worker runs it, and the user sees, tweaks and exports the result.
- **Why:** Our kernel is code-driven, which is what LLMs are good at. The output is exact, editable, parametric geometry — not the uneditable mesh most AI 3D generators hand back.
- **Order:** Comes after the parameters bite, so the AI has named parameters to target.
- **Guardrails:** Generated code runs only in the worker. The checks we already have — volume and bounding box — catch obvious errors before anything is exported.
- **Rejected for now:** AI in slicing or printer control, since Bambu Studio covers both. Also AI for printability checks: deterministic geometry rules are more reliable for deciding, though AI may later explain what those rules found.

## D17 — STL export tolerance relaxed to 0.005 mm (2026-10-04, revises D14)
- **What:** `STL_EXPORT_OPTIONS.tolerance` goes from 0.001 mm to 0.005 mm. The angular tolerance and binary format are unchanged.
- **Why:** D14 set 0.001 mm on a part whose only curve was a single hole, where it cost almost nothing. A doubly-curved surface shows the real price. Measured on a 40 mm sphere: **201,198 triangles, 9.6 MB, 6.7 s** at 0.001 mm against **40,352 triangles, 1.9 MB, 0.5 s** at 0.005 mm. A cylinder barely notices (1,540 vs 1,004 triangles) and flat-faced shapes are exact either way.
- **Why this is still far more than enough:** 5 µm of chord deviation is about one eightieth of a 0.4 mm nozzle. Nothing downstream can see it.
- **What it changed:** the exported plate's volume error grows from 0.081 mm³ to roughly 0.4 mm³, still under 0.004%. D15's test bound is now expressed as a relative 0.1% across all shapes rather than an absolute 1 mm³, since volumes now span four orders of magnitude.
- **Reversibility:** High. One constant.

## D18 — A shape library, with each shape defined once (2026-10-04)
- **What:** `src/shapes/shapeLibrary.ts` holds every shape as a single entry: parameters, defaults, limits, build function, volume formula, bounding-box formula and export filename. Adding a shape is one entry and no other edit.
- **Why the formulas live beside the builder:** the tests compare the kernel's measured volume and bounding box against them, so each entry carries its own specification. A new shape arrives with its own test coverage.
- **Reversibility:** High for now. It gets harder once shapes stop being single primitives and need feature history.

## D19 — The worker owns the library; the UI gets plain data (2026-10-04)
- **What:** The shape library imports replicad, so the page must not import it. The worker sends a serialisable catalogue — ids, labels and parameter specs — in its `ready` message, and the UI builds the form from that. The UI imports only *types* from the library, which TypeScript erases.
- **Why:** Keeps D11's separation intact. Measured: the page bundle grew 2.4 kB for the whole shape picker, against roughly 300 kB had replicad followed the import in.
- **Cost:** The form cannot render until the kernel is ready. Acceptable — there is nothing to build before then anyway.
- **Consequence:** Cross-field rules must be serialisable too, hence the declarative `lessThan` on a parameter rather than a validation function.

## D20 — The triangular prism is centred on its centroid, not its bounding box (2026-10-04)
- **What:** Every shape sits on z = 0 and is centred on the origin in X and Y, except that an equilateral triangle cannot do both at once. Its centroid is on the origin; its bounding box therefore is not, extending to +R in Y and −R/2 in the other direction.
- **Why:** The origin is a datum. The centroid is the shape's actual centre, and the one that will matter when shapes are combined or rotated. A bounding-box-centred triangle would put the datum somewhere with no geometric meaning.
- **Watch:** The bounding-box test exempts this shape in Y and pins the centroid behaviour separately, so the exemption cannot silently widen.

## D21 — The combined result is re-seated on z = 0 (2026-10-04)
- **What:** After every item has been applied, the finished solid is translated so its lowest point sits on z = 0. Items are positioned relative to one another; where the combination lands in Z is not something to manage by hand.
- **Why:** The part has to arrive in the slicer sitting on the bed. Doing it once at the end, rather than constraining each item, means a cut can take material off the underside and what remains still lands flat.
- **Consequence:** An item's Z position is relative, not absolute. Lifting the only item in a design by 25 mm changes nothing on screen. That is the intended behaviour, but it does surprise people.
- **Rejected:** Forbidding negative Z, which would have made "slice the bottom off" impossible to express.
- **Reversibility:** High. One translate at the end of `buildDesignShape`.

## D22 — The first item is always an addition (2026-10-04)
- **What:** `design.items[0].operation` is forced to `"add"`. The kernel refuses a design that starts with a cut, and the UI disables the operation control for item 1 and coerces any item moved to the top.
- **Why:** There is nothing to cut from before the first item exists. The alternative — treating a leading cut as an error the user has to resolve — makes reordering needlessly sharp-edged.
- **Watch:** Moving a cut to the top silently changes it to an addition, and moving it back down does not restore it. The operation is visible on every row in the list, so the change is not hidden, but it is not undoable either.

## D23 — A design is plain JSON (2026-10-04)
- **What:** `src/design.ts` defines a design as a list of items, each a shape id, its parameters, a position, a rotation about Z, and an operation. No classes, no ids, no functions, no back-references.
- **Why:** The same structure has to survive being saved to a file, pasted into a prompt, and written by a model (D16). Anything that only makes sense in memory would have to be stripped at each of those boundaries.
- **Why no item ids:** The UI tracks the selected item by index and moves the selection when the list is reordered. An id would be state the format does not otherwise need, and would have to be invented by anything generating a design.
- **Cost:** The UI holds the one mutable copy and sends a `structuredClone` to the worker, so a build in flight cannot be changed underneath by further typing.

## D24 — A new item is added, not cut (2026-10-04)
- **What:** The "+ Add" button creates an item with operation `"add"`.
- **Why:** Cutting is the more common next step, and that was the first implementation — but a default-sized cut at the origin swallows a default-sized base whole, so the design broke the instant the button was pressed. Found in a browser, not in the tests.
- **Consequence:** Switching to Cut is a deliberate act, normally after the shape has been sized and placed. That ordering is also the one that avoids a transient empty result mid-edit.
