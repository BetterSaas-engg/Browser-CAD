# browser-cad — Claude Code instructions

## What this is
A personal, browser-based, Fusion-style CAD tool, built bite by bite. The goal is to design parts and print them on a Bambu Lab A1 (via Bambu Studio). Not commercial.

## Who you're working with
AK is technical but not a seasoned software developer, and this is his first JavaScript/3D project. Explain the "why" briefly when introducing something new (a library, a pattern, a file). Keep explanations short.

## Stack (see DECISIONS.md for reasoning)
- Vite + TypeScript, static site, runs locally. No backend, no cloud.
- Geometry kernel: replicad (wrapper over OpenCascade, WebAssembly). Runs in a Web Worker so the UI never freezes.
- Viewport: three.js.
- Export: STL first; 3MF later.
- Sketch constraints (later bite): @salusoft89/planegcs.
- Tests: Vitest.

## Working rules
- One bite at a time. Build only what the current task asks. Don't add features, folders, or abstractions for future bites.
- Tracer bullets first: get it working end-to-end, then refine.
- Fail fast and visibly: if the kernel fails to load or a geometry operation fails, show a clear error in the UI and the console. Never swallow errors.
- Keep the geometry logic separate from the UI (orthogonality), so the kernel code can be tested without a browser.
- Small, focused functions. Comment why, not what.
- Unit-test geometry logic with Vitest where practical.
- Before finishing a task, run the build and tests, and report what you verified versus what you're assuming.

## Licensing
- Reference projects (JSketcher, Chili3D) may be read for ideas, but never copy code from them. Chili3D is AGPL.
- Only add dependencies with permissive licenses (MIT, Apache-2.0, BSD, LGPL as a library). Flag any other license before adding it.

## Environment
- Windows 11, old Windows PowerShell: it rejects `&&`. Give commands one per line.
- Node v24. Use npm.
- Windows Application Control is enforced on this laptop and can block compiled native binaries. If an install or tool fails with a DLL/load error, stop and report it rather than working around it silently.

## Decisions
Record any meaningful technical decision in DECISIONS.md (what, why, alternatives, how reversible). Don't change a recorded decision without flagging it.
