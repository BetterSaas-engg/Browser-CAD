/**
 * The handover format between the kernel and the viewport.
 *
 * Deliberately plain: typed arrays and nothing else. The kernel side knows how
 * to produce this from a replicad solid; the viewport side knows how to draw
 * it. Neither needs to know the other exists, and these buffers can be handed
 * across the worker boundary without being copied.
 *
 * All coordinates are millimetres, Z up, matching the kernel.
 */
export interface PartMesh {
  /** Triangle corner positions, as flat x, y, z triples. */
  vertices: Float32Array;
  /** Indices into `vertices`, three per triangle. */
  triangles: Uint32Array;
  /** Surface normals, as flat x, y, z triples — one per vertex. */
  normals: Float32Array;
  /**
   * The shape's real edges, as flat x, y, z triples where each consecutive
   * pair is one line segment. These come from the kernel's own tessellation of
   * the underlying curves, so a circular hole stays circular instead of being
   * rediscovered from the triangles.
   */
  edges: Float32Array;
}

/** The buffers in a {@link PartMesh}, for postMessage's transfer list. */
export function meshBuffers(mesh: PartMesh): ArrayBuffer[] {
  return [
    mesh.vertices.buffer as ArrayBuffer,
    mesh.triangles.buffer as ArrayBuffer,
    mesh.normals.buffer as ArrayBuffer,
    mesh.edges.buffer as ArrayBuffer,
  ];
}
