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

## D25 — Rebuilding never moves the camera (2026-10-04)
- **What:** `showPart` draws the new geometry and leaves the camera exactly where it was. Only the very first part is framed automatically, because there is no view to preserve yet. A **Fit view** button re-frames on demand.
- **Why:** The whole point of a live parametric view is to line up on a detail and watch it change. Re-framing on every rebuild threw that away on every keystroke, which made the viewport unusable for the thing it is for.
- **What still follows the part:** the near and far clip planes, recomputed from the live camera distance on each rebuild and on each orbit. They have to track the part or a design that grows pokes through the far plane — and moving them moves no camera.
- **Consequence:** make a part far larger or smaller and it can leave the view entirely. Fit view is the way back, and it is in the header rather than buried in the sidebar for that reason.

## D26 — A reorder that would put a Cut first is refused, not corrected (2026-10-04, revises D22)
- **What:** Moving a Cut to the top, or removing the item that would leave a Cut first, is blocked and explained in the sidebar. D22 silently flipped the item to Add instead.
- **Why:** The coercion edited the user's design behind their back and could not be undone. It also meant the list could change meaning without them asking for anything. Refusing leaves them in control and says what to fix.
- **Consequence:** `normaliseDesign` is gone. Nothing silently repairs the order now; the UI prevents the two moves that could break it, and the kernel still rejects a leading cut outright, so there are two layers of defence and no silent third.
- **Note:** the same rule covers Remove, which D22 did not consider — removing item 1 above a Cut is the same hazard by a different route.

## D27 — The app is exactly the window; only the sidebar scrolls (2026-10-04)
- **What:** `html, body { overflow: hidden }`, a flex column of header / main / hint / error, and `#controls` as the single scrollable region. The viewport is never scrolled out of reach.
- **The bug this fixed:** `renderer.setSize(w, h, false)` writes the *backing store* resolution into the canvas's width and height attributes — `w × devicePixelRatio`. With no CSS size pinning it, the canvas laid itself out at that size. On a display at 150% scaling the canvas rendered 1.5× its container and pushed scrollbars onto the page in both directions. Measured at 1366 x 768 and 150%: 506 px of horizontal and 207 px of vertical overflow.
- **The fix:** the canvas is `position: absolute; inset: 0; width: 100%; height: 100%`, so it is out of flow entirely and can never affect layout, while `setSize(…, false)` keeps the backing store at full device resolution so it stays sharp. The pixel ratio is re-read on every resize, since dragging a window between monitors changes it.
- **Watch:** any future element in the viewport must also be taken out of flow, or it can reintroduce this.

## D28 — Designs carry a version, and an unknown one is refused (2026-10-04)
- **What:** Every design has `version: 1`. A file whose version is anything else is refused with a message naming both numbers, rather than being guessed at or coerced.
- **Why:** The format will change. A file written by a later version may use fields this build does not understand, or the same fields to mean something else — and silently opening it would produce a part that is subtly not what the author drew.
- **When to bump:** whenever a change would make an older file *wrong* rather than merely incomplete. Adding an optional field that defaults sensibly does not need a bump; changing what an existing field means does.
- **Not built yet:** upgrading an old file to the current version. The version field is what makes that possible later; nothing reads it except the equality check.

## D29 — Validation refuses; it never repairs (2026-10-04)
- **What:** `src/designFile.ts` accepts a design exactly as written or rejects it with one specific problem, naming the item. Unknown fields at either level are an error, not something to ignore.
- **Why:** A loader that quietly drops an item it does not understand, or substitutes a default for a value out of range, hands back something that is not what the file said. For a design that is about to be printed, a file that will not open is far better than one that opens wrong.
- **Why strict about unknown fields:** silently ignoring `"Items"` or `"colour"` is the same failure in a smaller coat — the user's data is discarded without being mentioned. The version field is the intended route for genuinely new fields.
- **Consequence:** hand-edited files are unforgiving. The message always says which item and which field, which is the thing that makes that tolerable.

## D30 — Autosave to localStorage, and a damaged entry is kept (2026-10-04)
- **What:** Every edit writes the design to `browser-cad:design:v1`. On load it is validated like any other input; a damaged entry produces a message and a default design.
- **Why the entry is not deleted:** it may be the only copy of the user's work. Throwing it away to stop a message recurring trades their data for our tidiness. It stays until a real edit replaces it, and until then it can be rescued by hand from devtools.
- **Why only edits autosave:** the build that runs on page load does not write, so merely opening the page cannot overwrite a damaged entry before the user has seen the message about it.
- **Storage failures are swallowed:** a full quota or a private window costs the convenience of autosave, not the ability to keep modelling. **Revised by D31** — the cost stands, the silence does not.
- **Not done:** multiple named slots, or any history. One slot, last state wins.

## D31 — An autosave that fails says so (2026-10-28, revises D30)
- **What:** `autosave` returns `{ ok }` instead of `void`, and the page shows a notice the first time a write fails, naming the likely cause. It says so once per failing spell, not once per keystroke, and announces recovery if a later write succeeds.
- **Why:** D30 was right that a failed write should not stop you modelling, and wrong to conclude that nothing needed saying. Autosave failing is silent *and* invisible: the design on screen looks exactly the same, and the loss only appears on the next refresh — by which time the one moment the user could have done something about it, by pressing Save, has passed.
- **Why once per spell:** a full quota fails on every write. A notice that reappears on every keystroke is one you learn to scroll past, which puts us back where D30 was.
- **Why a notice and not an error:** nothing has broken. The kernel is fine, the part is fine, and the status line should keep showing the volume. Same distinction the file loader already draws.
- **Reversibility:** High. One return type and one branch in `onDesignChanged`.

## D32 — Two fonts bundled, OFL-1.1, static instances (2026-10-28)
- **What:** `src/assets/fonts/` holds **Noto Sans Regular** (clear sans) and **Nunito Bold** (bold rounded), each beside its upstream `OFL.txt`. Both are SIL Open Font License 1.1, which permits bundling and redistribution — compatible with the permissive-only rule in CLAUDE.md.
- **Why these two:** the brief asked for one clear sans-serif and one bold rounded face. Both carry every character the Text shape promises, which was checked against the files rather than assumed — `fonts.test.ts` re-checks it on every run, so a font swap cannot quietly drop `×` or `÷`.
- **Static, not variable:** the canonical `google/fonts` copies are now variable fonts (`Nunito[wght].ttf`). opentype.js — which replicad uses for outlines — reads only a variable font's default instance, so a variable Nunito would come out Regular however bold it was asked to be. These are pre-instanced statics at 400 and 700, sourced from `fonts.gstatic.com`; the exact URLs are in `src/assets/fonts/README.md`.
- **Emitted as assets, not inlined:** imported with `?url` and fetched at worker start-up, the same arrangement as the OpenCascade `.wasm`. Inlining them as base64 would have added about 900 kB to the worker's JavaScript for the engine to parse on every load. Nothing is fetched from a font service, and the app still works offline.
- **Cost:** 682 kB of fonts, 556 kB of it Noto Sans's full Latin/Greek/Cyrillic coverage. Noise beside a 23 MB kernel, so not subset — subsetting would add a build step and a way for a character to silently vanish.
- **Reversibility:** High. A font is one entry in `FONTS` plus the file; the loaders find it by name.
- **Revised by D50** — Nunito Bold is gone. Choosing a font on licence, weight and coverage was not enough; its outlines also have to be something OpenCascade can build.

## D33 — Parameters have kinds (2026-10-28)
- **What:** `ParamSpec` is a union discriminated on `kind`: `number` as before, plus `text` and `choice`. `ParamValues` widens to `number | string`. The form, the file validator and the builders all narrow the same way.
- **Why a discriminated union:** adding a fourth kind becomes a compiler error everywhere it has not been handled, rather than a silent fall-through to the numeric path. That matters most in `designFile.ts`, where missing a kind would mean accepting a value nobody checked.
- **Why `choice` as well as `text`:** the font is one of two known values. Expressing it as free text would make the dropdown a UI convention rather than a rule, and leave the file validator with nothing to check against.
- **The cost, and where it is paid:** six of the seven shapes have only numeric parameters and want to destructure them as numbers. One helper, `numericShape`, carries a single cast so they still can. It is sound because nothing calls `build` with values that have not already been validated against that entry's own `params` — but it is a cast, and it is the only one in the library.
- **Rejected:** a numeric-only `ParamValues` with text smuggled through a side channel, which would have put the Text shape's most important parameter outside the one mechanism that validates, serialises and renders everything else.
- **Reversibility:** Medium. The union is easy to extend and awkward to remove.

## D34 — Letter height means cap height, measured off the drawn H (2026-10-28)
- **What:** The `letterHeight` parameter is the height of a capital letter in millimetres. It is converted to an em size by measuring the top of the font's own `H` glyph, not by trusting the font's declared `OS/2.sCapHeight`.
- **Why not em size:** that is what opentype's `fontSize` actually is, and it is taller than any letter and differs between faces — 10 pt of Noto Sans and 10 pt of Nunito do not measure the same. Nobody designing a part wants a dimension that only means something relative to an invisible square.
- **Why the drawn H and not the declared value:** the two disagree. Nunito Bold declares a cap height of 705 units and draws its H to 713. The drawn one is what ends up on the bed and what callipers will find.
- **Watch:** a font may round the foot of its H slightly below the baseline — Nunito does, by 8 units in 1000 — so the overall ink box can measure about 1% over the cap height. The tests derive that overshoot from the font's metrics and assert the exact figure for both faces, rather than allowing a tolerance wide enough to hide it.
- **Reversibility:** High. One function, `emSizeForCapHeight`.

## D35 — Text is centred on its ink and extruded from its own base (2026-10-28)
- **What:** The glyph outlines are centred on the origin by their bounding box, in X and Y, then extruded up from the XY plane — so like every other shape, Text sits on z = 0 and is centred on its position.
- **Why the ink box and not the baseline:** placing text on a face is a visual act. Centring on the baseline would make "AK" and "ak" sit at different heights for the same position, which is not what "centred" means to anyone placing a label.
- **Why opentype's box and not replicad's:** OpenCascade's 2D bounding box is generous around a Bézier — measured 0.03 mm wide on "AK + 2 = ?" in Nunito, which would push the text half that far off centre. opentype solves the curve extrema instead, and agrees with the extruded solid to about 1e-4 mm.
- **Consequence:** a string with a descender is centred including the descender, so "?" shifts the block slightly against a string without one. That is the ink being centred, which is the intent.
- **Nothing special for engraving:** the geometry is the same either way. Add raises the letters, Cut sinks them. D21's re-seating then puts the finished part back on the bed, so cutting into a top face does not lift anything.

## D36 — Text declares no volume formula (2026-10-28)
- **What:** `ShapeDef.volumeMm3` becomes `((v) => number) | null`, and Text is the one entry that sets it to `null`.
- **Why:** D18 has each entry carry its own specification, and the generic test compares the kernel's measured volume against it. A string of glyph outlines has no closed-form area, so any formula here would have to be derived from the same outlines the kernel uses — a tautology dressed as a check.
- **Why `null` rather than an optional field:** omitting a formula should be a decision, not an oversight. A deliberate `null` reads as one, and a separate test asserts that `text` is the *only* shape allowed to do it, so a formula cannot go missing elsewhere without failing.
- **What replaces it:** Text is pinned down by properties instead — raised lettering increases a plate's volume by exactly the lettering's own volume, engraving removes exactly the fraction that was inside, more characters are wider, every promised character produces material. Its bounding box still has a formula, and it is a real cross-check: expected from opentype's curve arithmetic, measured from OpenCascade's extrusion, two independent routes.

## D37 — The design format stays at version 1 (2026-10-28)
- **What:** Adding the Text shape does not bump `DESIGN_VERSION`.
- **Why:** D28's rule is to bump when a change would make an older file *wrong* rather than merely incomplete. Nothing about an existing field changes meaning: every version-1 file written before this bite still validates and still builds the identical part. `params` can now hold a string as well as a number, but only for a shape that did not exist before, so no older file can be read differently.
- **The other direction is safe too:** a file written now, containing a text item, fed to a build from before this bite is refused by the unknown-shape check — `unknown shape "text". This app knows: box, cylinder…` — which is exactly the clear refusal D28 wanted, rather than a part that is subtly not what was drawn.
- **Watch:** this reasoning only holds while new shapes are additive. Changing what `letterHeight` means, or what a font id refers to, would need the bump.

## D38 — The kernel refuses characters the font cannot draw (2026-10-28)
- **What:** Before any text is drawn, every character is looked up in the chosen font's character map. A character with no glyph is an error naming it, its code point, its position in the string, and what would otherwise have happened.
- **Why this is not cosmetic:** opentype does not fail on a character it lacks — it substitutes `.notdef`, which in both bundled fonts is a filled rectangle. So the silent outcome is not a missing letter but a printed block, and the first place you would notice is the bed.
- **Why the check is in the kernel and not the page:** it consults the real font, and only the worker has one. A hard-coded list of allowed characters in the page would be a duplicate of the truth, and a wrong one — both fonts carry `é` and `€`, which such a list would reject. The consequence is accepted deliberately: a file holding an undrawable character loads cleanly and then fails to build, with a clear message, because loading it is the only way to get it in front of someone who can fix it.
- **Also refused here:** an empty or all-space string, and anything past 80 characters. `drawText` on empty text produces an inverted bounding box and then throws with `undefined` as its message, which is no use to anyone.
- **Why replicad's own fallback is bypassed:** `textBlueprints` warns to the console and silently uses whichever font was registered first when a family is missing — the right letters in the wrong typeface. `loadedFont` turns that into a failure.

## D39 — Printability warnings advise; they never block (2026-10-28)
- **What:** A numeric parameter may declare `warnBelow`. Text warns under 5 mm of letter height and under 0.6 mm of depth. The form shows the message in amber, leaves the field valid, and nothing stops building or exporting.
- **Why not a limit:** small text does print, just not always legibly, and which side of that line a part falls on depends on the nozzle, the material and what the text is for. Refusing it would be us deciding; saying so is the user deciding.
- **Why it lives in the spec:** the warning has to cross `postMessage` to reach the form, like every other rule, so it is declarative data rather than a function — the same constraint D19 put on `lessThan`.
- **Watch:** a threshold the default already trips would fire on every new item, which is how a warning stops being read. A test asserts every default sits at or above its own warning.

## D40 — Node types are scoped to the tests (2026-10-28)
- **What:** `tsconfig.json` keeps `types: ["vite/client"]` and excludes the test files; `tsconfig.test.json` extends it, adds `node`, and includes everything. `npm run build` runs both.
- **Why:** the tests need `node:fs` — they load the bundled fonts off disk, because Node has no server to fetch a Vite-emitted asset URL from. Putting `node` in the one shared config would also put `process` and `Buffer` in scope for application code that runs in a tab, where reaching for them would type-check and then fail only once the page was open. Verified by adding `process.env` to `src/mesh.ts` and watching the app pass reject it.
- **Known gap:** `exclude` filters the initial file set, not module resolution, so an explicit `import … from "node:fs"` inside application code would still type-check. That is a far more deliberate act than a bare global, and closing it would cost more config than it is worth.
- **Reversibility:** High. Two small files and one line of `package.json`.

## D41 — An outline is stored as normalised path data, never as SVG (2026-10-28)
- **What:** `src/svg/outline.ts` defines an outline as a list of closed loops, each a string using only `M`, `L`, `C` and `Z`, plus a boolean saying whether it is a hole. That is what goes in the design and what the kernel receives. The `.svg` file is read once, at import, and then forgotten.
- **Why not the SVG text:** a design has to be plain JSON that survives being saved, pasted into a prompt and written by a model (D23). SVG is a document format with scripting, external references, stylesheets and namespaces in it; storing it would put all of that inside a design file, when the only thing wanted is the geometry. Keeping path data means a design cannot carry anything executable.
- **Why unit-normalised:** the stored box is centred on the origin with its longer side exactly 1, so the data says nothing about size and the `size` parameter is the only thing that decides millimetres. The shorter side carries the aspect ratio, which is therefore impossible to lose.
- **Why `hole` rather than a fill rule:** the kernel is told the answer, not the rule. Resolving even-odd and nonzero needs nesting and winding, which is parsing work, and parsing happens once. It also makes a hand-written or model-written outline far easier to get right — `hole: true` is obvious in a way a winding number is not.
- **Why six decimals:** on a box whose longer side is 1, that resolves to 40 nanometres on a 40 mm part. It shows up in the tests as a few parts per million on shapes whose coordinates land on thirds — four orders of magnitude below anything a 0.4 mm nozzle can place.
- **Reversibility:** Medium. The format is small, but it is in saved files.

## D42 — svgpath and txml, both MIT and dependency-free (2026-10-28)
- **What:** two new runtime dependencies. **svgpath** 2.6.0 (MIT) parses and transforms path data; **txml** 6.0.3 (MIT) takes the XML apart. Both are permissive per CLAUDE.md, and both have **zero transitive dependencies**.
- **Checked first:** replicad has no SVG import. It has `toSVG`, `toSVGPaths` and `toSVGPathD` — all export — so there was nothing to reuse.
- **Why svgpath rather than hand-rolling:** `abs`, `unshort`, `unarc` and `transform` are the whole job, and the job is a minefield — implicit command repetition, shorthand curve reflection, arc radius correction, and flag packing like `a1 1 0 011 1` where the flags have no separator. It also parses an SVG `transform` attribute string directly, so there is no matrix code here at all.
- **Why txml over fast-xml-parser:** fast-xml-parser is also MIT but now pulls six or more transitive packages. For code whose whole job is reading a file from outside, a smaller surface to trust is worth more than popularity. `@xmldom/xmldom` was the other zero-dependency option and is a full DOM — more than is needed to read tags and attributes.
- **Watch:** svgpath's `unarc` and `toString` are relied on. If either changes, the normaliser throws naming the unexpected command rather than dropping a curve, which is what its "this is a bug in browser-cad" message is for.

## D43 — A pure parser, so no DOMParser anywhere (2026-10-28)
- **What:** the importer never touches a DOM. Not `DOMParser`, and not the page's document.
- **Why not DOMParser:** it does not exist in a Web Worker or in Node, so the tests would have needed a DOM environment — jsdom or happy-dom. That buys a dev dependency and a worse guarantee: the tests would exercise *that* implementation's XML parsing rather than the browser's, and a difference between them is the kind of bug where the suite is green and the app is wrong.
- **What the pure route buys:** exactly one code path, running identically in the page and under Vitest, with no environment configuration. It also makes "never insert an imported SVG into the page's DOM" structurally true rather than a rule someone has to remember.
- **Where it runs:** in the page, at import. Not in the worker — not because it could not, since it has no DOM dependency, but because the kernel's input should stay path data. The worker therefore never needs the XML parser at all.
- **Deliberately not implemented:** CSS. A `fill` arriving through `class` and a `<style>` sheet would need cascade and specificity to resolve properly. Such an element reads as having no `fill` set, inherits, and is treated as filled — which is SVG's own default, and the safe direction to be wrong in, since the alternative is dropping a shape that should have been there.

## D44 — Arcs become cubics at import; everything else is exact (2026-10-28)
- **What:** `unarc` converts every elliptical arc to cubic Béziers before anything is stored. `<circle>`, `<ellipse>` and a rounded `<rect>` are written as arcs first and so go the same way. Quadratics are converted too, but that conversion is *exact*, so arcs are the only approximation.
- **Why, when replicad could do arcs exactly:** its sketcher has `ellipseTo(end, rx, ry, rotation, longAxis, sweep)`, which maps straight onto SVG's `A`. The problem is the `transform` attribute: a general affine transform of an elliptical arc is still an elliptical arc, but recovering its radii and rotation needs an eigen-decomposition, and composing that down nested groups compounds it. Converting first means transforms only ever apply to control points, where they are exact and trivial.
- **What it costs:** a 90° cubic approximation of a circular arc is good to about 2.7 parts in ten thousand of the radius. Measured as area, the test asserts an imported circle lands within 0.05% of πr². On a 20 mm circle that is roughly 3 µm of radius — about one hundredth of a 0.4 mm nozzle, and the same order as the 5 µm chord tolerance D17 already settled as far more than enough.
- **Reversibility:** Medium. Storing arcs would mean a fourth command in the format and arc handling in the bounds solver.

## D45 — The format version does not change (2026-10-28, compare D37)
- **What:** the Outline shape does not bump `DESIGN_VERSION`.
- **Why, by the same reasoning as D37:** no existing field changes meaning. Every file written before this bite still validates and builds the identical part. `params` values widen from `number | string` to include an outline object, but only for a shape that did not previously exist, so no older file can be read differently.
- **The other direction stays safe:** a design holding an outline, opened by a build from before this bite, is refused by the unknown-shape check — `unknown shape "outline"` — rather than opening as something subtly wrong.
- **Where the comparison with D37 matters:** D37 could lean on text being a string, which JSON already carried. This bite puts a *structured* value into `params`, and that is the thing worth noticing: what keeps it safe is the shape id, not the value's shape. A change that put an object into an *existing* shape's parameters would need the bump, because an older build would then mis-read a file it thought it understood.

## D46 — Refusals name the element, and nothing imports by halves (2026-10-28)
- **What:** the importer refuses, with the element named and usually with the fix: a shape with `fill="none"`, an element it does not handle, a subpath with no area, a file with nothing fillable, a file over 1,000,000 characters, and an outline over 128,000 characters of path data.
- **Why so strict about stroke-only shapes:** most icon sets are drawn as strokes, and a stroked path has no area at all. Extruding it would produce nothing, or a sliver. The message says to run Stroke to Path, because that is the actual fix and it is not obvious.
- **Why no partial import:** the alternative is a drawing that arrives with pieces missing and nobody told. That is the failure D29 refuses in the file loader, and it is worse here, because the missing piece is visual and might only be noticed after printing.
- **The two caps, and why those numbers:** 1,000,000 characters of input is generous for anything hand-drawn or traced while still bounding the parse. 128,000 characters of stored path data is roughly 4,000 curve segments — far more detail than a nozzle can resolve — and leaves a design room for several outlines inside the roughly 5 MB a browser gives `localStorage`.
- **Known gap, deliberately not refused:** a self-intersecting subpath. Filling one exactly needs real winding-number integration; nesting and winding are exact for every loop that does not cross itself, which is what editors and tracers produce. Such a path imports, and may fill differently than a browser would draw it.
- **Watch:** loops are applied in one flat order — within each element, outermost first. If one element is painted *before* another whose hole overlaps it, that hole will also cut the earlier element, where SVG would have left it visible. Fixing it properly means grouping loops per element in the stored format; nothing in scope needs that.

## D47 — A heart ships as the sample and as the default (2026-10-28)
- **What:** `samples/heart.svg` is drawn from scratch — my own path, six cubics — so there are no licence questions about it. `src/svg/heart.ts` holds the same heart after the importer, as the Outline shape's default.
- **Why a default at all:** an empty outline has no geometry, so a new Outline item would break the design the instant the button was pressed. D24 learned exactly that lesson with a default-sized cut, in a browser rather than in the tests.
- **Why written out rather than parsed at start-up:** the worker then never needs the XML parser, and adding an item cannot fail. The cost is generated data sitting in source, which a test covers — `outline.test.ts` imports the sample and asserts it still produces precisely `HEART_OUTLINE`, so the two cannot drift.

## D48 — The thin-depth warning is shared, not copied (2026-10-28)
- **What:** `thinDepth(feature)` in the shape library produces the `warnBelow` that both Text and Outline use — one threshold of 0.6 mm and one phrasing, named once.
- **Why:** both shapes raise or engrave a flat feature a millimetre or two proud, and the advice is identical. Two copies of a number and a sentence is how the two drift apart, and D39's point was that a warning only works if it is worth reading.
- **Reversibility:** High. A shape wanting different advice passes its own `warnBelow` instead.

## D49 — A loop with one curve encloses area (2026-10-28)
- **What:** the check for whether a loop encloses anything counts boundary edges, including the straight line `Z` adds. Three edges are needed if all of them are straight; two will do if one bends.
- **Why:** the first version demanded three segments outright, which refused a perfectly ordinary lens — one cubic out and the chord closing it. Found by a test written to pin down the bounds solver, not by one looking for this.
- **Why it matters beyond the one shape:** the refusal would have been indistinguishable, from the outside, from the stroke-only refusal it sits beside — "part of it has no area", on a drawing that had plenty. An over-strict refusal is a quieter bug than a missing one, because the message looks deliberate.

## D50 — The rounded font is Sniglet, because Nunito's outlines cross themselves (2026-10-28, revises D32)
- **The bug:** a box with "MOMMY" engraved into its top face in the rounded font came out with the top face missing — the viewport's grid showed through it. The volume was right, the bounding box was right, and nothing stopped an export. Switching to Noto Sans fixed it; a single "I" in the rounded font was fine.
- **The cause, measured rather than guessed:** `BRepCheck_Analyzer` reports the extrusion of Nunito Bold's "M" as invalid with **two bad faces** — the end caps — while every one of its 33 wires and 186 edges passes. A cap whose wires are individually fine but whose face is not is OpenCascade saying the outline crosses itself inside the plane. Flattening the glyph and counting proper segment crossings confirms it directly: Nunito Bold's M has 3, Y has 3, and **44 of the 76 characters the Text shape promises self-intersect**, for 93 crossings in total. Noto Sans has none. "I" and "O" have none, which is why "I" looked fine.
- **It is not a scale or tolerance problem:** invalid at every letter height from 1 mm to 120 mm.
- **Whose fault it is:** not Nunito's. Overlapping strokes at a diagonal junction are ordinary font construction, and a text renderer resolves them with the nonzero winding rule. Browsers draw Nunito perfectly. The defect is in *our* pipeline, which hands a glyph contour to OpenCascade as a face boundary — correct only for fonts whose contours happen not to overlap. Screening confirms how common this is: Quicksand 41 characters, Mulish 43, Nunito Sans 43, Asap 17, Comfortaa 10, Fredoka 10, Baloo 2 nine, Signika nine.
- **What was tried and did not work:** a 2D self-union of the drawing, a 3D self-fuse of the solid, `ShapeUpgrade_UnifySameDomain`, and `ShapeFix_Face` on both the profile face and every face of the extrusion. All four left the volume bit-identical and the shape still invalid; `ShapeFix_Face` reports `changed=false`, declining to repair a self-intersecting wire. OpenCascade's booleans require valid input, so they pass the fault through rather than resolving it.
- **The fix:** ship a font whose outlines are clean. **Sniglet ExtraBold** — OFL-1.1, static, weight 800, 51 kB, rounded — has zero crossings across the whole promised set. Of the clean candidates it was the best fit: M PLUS Rounded 1c Bold is also clean, bold and rounded but 3.5 MB; Varela Round is clean and rounded but only weight 400; Dosis and Rubik are clean but thin-stroked and barely rounded respectively.
- **The font id stays `rounded`:** only the file and the label changed, so designs saved with the old font still load and still build — in the new face. D32's promise that ids are stable is kept.
- **What stops a repeat:** `fonts.test.ts` now asserts that **no glyph in the promised set, in any bundled font, has a self-intersecting outline**. That is the check that would have caught this before a browser ever saw it, and it runs on every test run.
- **What is deliberately not fixed:** the underlying limitation. Honouring the nonzero winding rule properly means splitting a contour at its self-intersections and unioning the pieces — a planar boolean with exact predicates, or flattening glyphs to polygons and using a polygon-clipping library. That is a real piece of work, it would replace exact Béziers with line segments for affected glyphs, and it is not needed while every bundled font is clean. D51 is what makes leaving it safe.

## D51 — Every build is checked for soundness, and an unsound one is refused (2026-10-28)
- **What:** `src/kernel/soundness.ts`. After each item is built, and again on the finished part, the shape must contain a solid and pass OpenCascade's `BRepCheck_Analyzer`. The display path additionally requires the tessellated mesh to be closed — every triangle edge shared by exactly two triangles. A failure throws, which the page already turns into a visible error and which already disables export.
- **Why this is the important half of the fix:** D50 removed one cause. This removes the *class*. The app showed a broken part with no warning and would have exported it; the next cause — another font, a self-intersecting SVG, a boolean that leaves a zero-thickness wall — would have done exactly the same thing. Swapping a font without this would have been luck dressed as a fix.
- **Why volume was not enough:** the whole trap is that an invalid solid integrates to a plausible number. Nunito's "M" measured 18.5498 mm³ both before and after every repair attempt. The test fixtures make the same point without a font: a self-intersecting outline that comes out at 889 mm³ and another at 1609 mm³, both invalid, both of which every earlier check accepted.
- **Why two checks and not one:** they fail independently. `BRepCheck_Analyzer` is the kernel's opinion of its own geometry; the mesh check is the question a slicer asks, of the very triangles the viewport draws. A tessellation can fail on geometry OpenCascade is happy with.
- **Why the mesh has to be welded first:** replicad meshes face by face and repeats the vertices along every shared edge, so the triangles arrive unwelded. Without merging coincident positions a plain cube reads as 36 unpaired edges and the check would refuse everything. Five decimals — 10 nanometres — is far below the 0.01 mm tolerance that generated the points and far above the float noise between two copies of a corner.
- **Why per item as well as per design:** so the message can say *which* item. "Item 2 (cut outline) did not build a valid solid" is actionable; "this design is broken" is not.
- **Cost:** one validity call per item per build, plus one pass over the mesh edges. The mesh pass is free — the mesh had to be built anyway. Measured across the suite the whole run went from 4.2 s to 8.6 s, which is the validity calls on 392 tests, not on one keystroke.
- **A side effect worth knowing:** this closes D46's known gap by refusing it. A self-intersecting imported SVG used to import and fill unpredictably; now it builds nothing and says so.

## D52 — Changing an item's shape resets its parameters (2026-10-28)
- **What:** picking a different shape for an item replaces its parameters with the new shape's defaults, rather than carrying over the ones whose keys match. The item list is repainted at the same time.
- **Why not carry them over:** the same key means different things on different shapes. A box's `depth` is how far it reaches in Y; a text's or an outline's `depth` is how thick it is in Z. Keeping the number would silently change what it meant, which is worse than losing it.
- **Consequence, and the thing that looked like a bug:** turning a box into an outline sets `depth` to the outline default of 2 mm, whatever the box's depth was. That is this rule working, not an import resetting anything — importing an SVG writes the outline and nothing else.
- **The actual bug fixed here:** the shape picker repainted the editor but not the item list, so a row went on reading "3. Box" for an item that had become an Outline until some later edit happened to repaint it. The operation picker had always repainted both; the shape picker was simply missing the call.
- **Also fixed:** `defaultParams` now clones object defaults. Every new outline item was being handed a reference to the library's own heart, so anything that edited one in place would have reached back into the catalogue and into every other item that had taken the default. Nothing did edit it in place, which is why it had not bitten yet.
## D53 — A symbol library, consulted before the font (2026-10-29)
- **What:** `src/shapes/symbols.ts` holds one entry per symbol — the character it answers to, a label, an outline, and the two numbers that size and place it. Two entries to start: **♥** (U+2665) and **★** (U+2605). `"I ♥ MOM"` is now one Text item rather than three items with hand-picked X positions.
- **Why a library and not a special case for the heart:** two entries is the smallest number that proves adding a symbol really is one entry. The star needed no change anywhere else — not in the layout, not in validation, not in the UI, which builds its insert buttons from this list.
- **Symbols beat the font:** `symbolFor` is consulted before `fontHasGlyph`, so ♥ is always this app's heart. A font's own dingbat would be a different shape at a different size, and which part you got would depend on the typeface — the opposite of what a symbol is for. Neither bundled font happens to contain either character today, so the precedence is not yet load-bearing; it is coded that way so it does not become a surprise if a font is ever swapped for one that does.
- **One heart, not three:** the entry imports `HEART_OUTLINE`, the same object the Outline shape defaults to and the same geometry `samples/heart.svg` produces. A test asserts the symbol's outline *is* that object, and another builds the heart both ways — as a symbol inside text, and as an Outline shape at the width the symbol came to — and compares volumes. They agree to twelve decimal places.
- **Pure data, so the page imports it directly:** no replicad, no kernel, no DOM. D19 routes the *shape* catalogue through the worker because the shape library pulls replicad in; this one does not, so the sidebar imports it and gets the buttons without a second plain-data channel to keep in step.
- **Reversibility:** High for adding and removing symbols. Lower for *redrawing* one — see D56.

## D54 — A symbol is sized against the capitals and spaced by the font's own metrics (2026-10-29)
- **Height:** a fraction of the *measured* capital height, per symbol — **♥ at 0.9, ★ at 0.80**.
- **Why not 1:** nothing stops it, but a symbol centred in the cap band at 1.0 fills the band exactly and leaves the line looking crowded. Both ratios keep a little air above and below.
- **Why the heart is 0.9, revised from 0.75 (2026-10-29):** both symbols started at 0.75, on the theory that a solid mass reads bigger than a capital's mostly-vertical stems and so should be drawn smaller. Checked in a browser on a real design — "I ♥ MOM" engraved into a box — the heart did not read as part of the line at all; **it read like punctuation**, a mark between words rather than a word in its own right, and most obviously so in Sniglet, whose heavy letters overpower it. At 0.9 it sits as an equal. A heart is wider than it is tall, so 0.9 of the cap height comes out a shade *wider* than a capital is tall, and that width is what does the work.
- **What that says about the theory:** it was wrong, or at least it was not the thing that mattered. The heart is now the *taller* of the two symbols, which the original reasoning would have forbidden. Optical sizing is a judgement about how something looks, and the only way to make it was to look — so the ratios are per-symbol values set by eye, not numbers derived from the geometry. The star was left at 0.80 because it still looked right there; it was not adjusted for symmetry with a rule that has been retired.
- **What the tests do about it:** they pin each symbol to its *own declared* ratio against a measured capital height, and deliberately do **not** assert which symbol is larger. A test that hard-coded 0.9 would need editing every time the look is tuned, which turns a check into a chore; one that asserted "the star is the bigger one" would have had to be inverted by this very change.
- **Watch:** the gaps either side of a symbol come from the font and do not scale with the symbol, so making one taller eats into its clearance. At 0.9 the heart still has daylight on both sides in both fonts — asserted two ways, by measured ink gap and by fusing a pair and checking the volumes add up.
- **Vertical placement:** centred in the band between the baseline and the cap height, which is `(1 - capHeightRatio) / 2`. Neither symbol has a feature that wants to sit on the baseline — no flat foot like H, no overshoot like O — so centring in the cap band is what makes them read as part of the line in any font. The field is per symbol so a future mark that *does* want the baseline can have it.
- **Spacing, and why it is not by eye:** a glyph's advance is wider than its ink, and the gap you see between two letters is the right-hand sidebearing of the first plus the left-hand bearing of the second. `meanSideBearingUnits` averages that over A–Z, and a symbol gets exactly that much clear space on each side. So the font decides: Noto Sans carries 50.5 units of bearing against Sniglet's 32.3, and the same two symbols side by side come out measurably tighter in Sniglet.
- **Checked by measurement, not by assertion:** the tests derive the font's own letter gaps the way a reader sees them — `width(ab) − width(a) − width(b)` over 56 capital pairs — and require the I-to-♥ gap to fall inside the middle four fifths of that distribution. It lands within a few percent of the median in both faces: 1.281 mm against a 1.359 mm median in Noto Sans, 0.877 against 0.854 in Sniglet.
- **What is lost:** kerning across a symbol. Letters stay in the longest runs possible so the font's kerning still applies within them, and a symbol is not in the font, so there was no kerning pair for it to lose.

## D55 — Measuring a line is separate from building it (2026-10-29)
- **What:** `walkLine` works out where every run goes and accumulates the ink box, building no geometry. `measureText` returns just the box; `layOutText` goes on to build and fuse the pieces. The Text shape's `boundingBoxMm` now measures.
- **Why:** it used to build the whole solid, read its size, and throw the solid away — on every bounding-box question. That was slow, and it was a second chance for the measurement to disagree with the layout that would actually run. The spacing tests made the cost obvious: they ask for hundreds of widths, and at a full build each that is minutes rather than seconds.
- **The ink box is still analytic**, for the reason D35 gives: OpenCascade's box is generous around a Bézier, which would push the line off centre.
- **Measured while doing this, and worth recording:** the two disagree by more than D35's stated 1e-4 mm on some glyphs. A bare "A" in Sniglet measures 3.5e-4 mm wider as a built solid than opentype's solved extremum says, and the vertical box differs by up to 5.2e-4 mm. The analytic figure is the more accurate of the two — this is the solid's bounding box being imprecise about a flat curve, not the layout being wrong — but it sets the floor on what a centring test can assert, which is why those assert to 5 µm rather than to a tenth of that.

## D56 — Symbols are referred to by character, and redrawing one changes old designs (2026-10-29)
- **The format does not change.** The text stays a plain string; `DESIGN_VERSION` stays 1. The only thing that has changed is which characters that string may contain, and no existing field means anything different from what it meant before.
- **Why that is safe in both directions:** neither bundled font contains U+2665 or U+2605 — checked, both report glyph index 0 — so a design holding `"I ♥ MOM"` opened by a build from before this bite is *refused*, by the existing unsupported-character error naming the character and its code point. That is exactly the clear refusal D28 wants, rather than a part that is subtly not what was drawn. Had a font happened to contain ♥, an older build would have quietly drawn the font's own dingbat instead, and that **would** have argued for a bump.
- **The trade-off, stated plainly:** a saved design refers to a symbol by its character, not by its geometry. The heart lives in this app, not in the file. So **redrawing a symbol changes every design that already uses it** — reopen an old file after the heart has been reshaped and you get the new heart, at the new proportions.
- **Why that is the right bargain anyway:** it is the same one as referring to a font by name rather than embedding it. The alternative — inlining the outline into every item that uses it — would balloon a design file, would stop a corrected symbol from ever reaching old work, and would leave two different hearts inside a design that used both a symbol and an imported outline.
- **What follows from it:** a symbol's character is as much a stable identifier as a font id is (D32). Changing which character an entry answers to would silently repoint every saved design that used it.
- **Where to look if this ever bites:** the symbol's geometry is one object, `HEART_OUTLINE` or `STAR_OUTLINE`. Pinning a design to a particular drawing would mean copying that object into the item, which is the inlining this rejects.

## D57 — The test timeout is thirty seconds (2026-10-29)
- **What:** `testTimeout: 30_000` in `vite.config.ts`, which now imports `defineConfig` from `vitest/config` so the section type-checks. That re-exports vite's own, so the build is unaffected.
- **Why:** Vitest's default is five seconds, which is right for unit tests and wrong for a CAD kernel. Extruding the whole 76-character set takes about 380 ms on its own, and Vitest runs the test files in parallel — so adding a ninth file pushed several perfectly healthy builds past five seconds purely through competing for cores. Verified by running the offending file alone, where all 104 of its tests pass in 11 seconds.
- **Why not per-test timeouts:** the slow ones are not special, they are just the big builds. A timeout that fires on contention teaches you to re-run the suite rather than read it, which is the opposite of what a failing test should do.
