import { beforeAll, expect, it } from "vitest";
import { setOC } from "replicad";
import initOpenCascade from "replicad-opencascadejs";
import { BOX_WITH_HOLE, buildBoxWithHole, expectedVolumeMm3 } from "./shapes";

// Compiling 23 MB of WebAssembly is slow the first time; give it room.
beforeAll(async () => {
  setOC(await initOpenCascade());
}, 120_000);

it("measures the plate's volume as plate minus hole", () => {
  // OpenCascade integrates the volume analytically rather than from a mesh, and
  // the hole is an exact cylinder, so this can be checked tightly.
  expect(buildBoxWithHole().volumeMm3).toBeCloseTo(expectedVolumeMm3(), 6);
});

it("agrees with the hand calculation of 12000 - 250*pi", () => {
  expect(expectedVolumeMm3()).toBeCloseTo(12000 - 250 * Math.PI, 9);
});

it("produces a mesh that is well formed", () => {
  const { mesh } = buildBoxWithHole();

  expect(mesh.vertices.length).toBeGreaterThan(0);
  expect(mesh.vertices.length % 3).toBe(0);
  // One normal per vertex.
  expect(mesh.normals.length).toBe(mesh.vertices.length);
  // Three indices per triangle.
  expect(mesh.triangles.length % 3).toBe(0);
  // Line segments come in pairs of xyz points.
  expect(mesh.edges.length % 6).toBe(0);

  const vertexCount = mesh.vertices.length / 3;
  const maxIndex = mesh.triangles.reduce((a, b) => Math.max(a, b), 0);
  expect(maxIndex).toBeLessThan(vertexCount);
});

it("meshes the part at the dimensions it was asked for", () => {
  const { mesh } = buildBoxWithHole();
  const { width, depth, height } = BOX_WITH_HOLE;

  // Walk the vertex positions to get the mesh's real extent. This is what
  // catches a shape that is built on the wrong plane or at the wrong scale —
  // the volume check alone would not notice a part lying on its side.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], mesh.vertices[i + axis]);
      max[axis] = Math.max(max[axis], mesh.vertices[i + axis]);
    }
  }

  expect(max[0] - min[0]).toBeCloseTo(width, 3);
  expect(max[1] - min[1]).toBeCloseTo(depth, 3);
  expect(max[2] - min[2]).toBeCloseTo(height, 3);
  // Extruded up from the XY plane, so it sits on the grid rather than through it.
  expect(min[2]).toBeCloseTo(0, 3);
});
