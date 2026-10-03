/**
 * The 3D viewport. Knows three.js and the PartMesh format, and nothing else —
 * no replicad, no worker, no status line.
 *
 * Conventions: millimetres, Z up. three.js defaults to Y up, so the camera's up
 * vector and the grid are both rotated to match the kernel's axes instead of
 * rotating the part, which would make every coordinate on screen a lie.
 */
import {
  AmbientLight,
  AxesHelper,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { PartMesh } from "../mesh";

/** One grid square is 10 mm, so the part's 40 x 30 footprint is countable. */
const GRID_EXTENT_MM = 200;
const GRID_STEP_MM = 10;

export interface Viewport {
  /** Draw a part, replacing whatever was shown before, and frame it. */
  showPart(mesh: PartMesh): void;
}

export function createViewport(container: HTMLElement): Viewport {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0x1e2228);

  const camera = new PerspectiveCamera(45, 1, 0.1, 10_000);
  camera.up.set(0, 0, 1);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  // Left drag orbits, wheel zooms, right drag pans — OrbitControls' defaults.
  controls.screenSpacePanning = true;

  scene.add(new AmbientLight(0xffffff, 1.4));

  // Two directional lights from opposite sides: one alone leaves the faces
  // turned away from it flat black, which hides the hole's inner wall.
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(1, -1.4, 2);
  scene.add(key);
  const fill = new DirectionalLight(0xffffff, 0.8);
  fill.position.set(-1.2, 1, -0.6);
  scene.add(fill);

  // Grid lies in XY (three.js builds it in XZ), so it reads as the ground
  // plane the part is extruded up from.
  const grid = new GridHelper(
    GRID_EXTENT_MM,
    GRID_EXTENT_MM / GRID_STEP_MM,
    0x4a5560,
    0x30373f,
  );
  grid.rotation.x = Math.PI / 2;
  // A hair below z = 0. The part's bottom face sits exactly on that plane, and
  // two coplanar surfaces flicker against each other wherever they overlap.
  grid.position.z = -0.05;
  scene.add(grid);

  // X red, Y green, Z blue — three.js' convention, and Fusion's.
  scene.add(new AxesHelper(GRID_EXTENT_MM / 4));

  const partMaterial = new MeshStandardMaterial({
    color: 0xb4b8bd,
    metalness: 0.1,
    roughness: 0.55,
    // Push the surface a touch away from the camera so the edge lines sitting
    // exactly on it win the depth test instead of breaking up into dashes. The
    // slope factor matters here: edges on faces seen at a shallow angle are
    // exactly the ones that flicker without it.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const edgeMaterial = new LineBasicMaterial({ color: 0x14181c });

  let part: Mesh | null = null;
  let edges: LineSegments | null = null;

  function clearPart(): void {
    for (const object of [part, edges]) {
      if (!object) continue;
      scene.remove(object);
      object.geometry.dispose();
    }
    part = null;
    edges = null;
  }

  function showPart(mesh: PartMesh): void {
    clearPart();

    const surface = new BufferGeometry();
    surface.setAttribute("position", new BufferAttribute(mesh.vertices, 3));
    surface.setAttribute("normal", new BufferAttribute(mesh.normals, 3));
    surface.setIndex(new BufferAttribute(mesh.triangles, 1));
    part = new Mesh(surface, partMaterial);
    scene.add(part);

    const wire = new BufferGeometry();
    wire.setAttribute("position", new BufferAttribute(mesh.edges, 3));
    edges = new LineSegments(wire, edgeMaterial);
    scene.add(edges);

    surface.computeBoundingBox();
    frame(surface.boundingBox);
  }

  /** Pull the camera back far enough to fit the part, looking down from a corner. */
  function frame(box: Box3 | null): void {
    if (!box) return;
    const center = box.getCenter(new Vector3());
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1);
    const distance = radius / Math.sin((camera.fov * Math.PI) / 360);

    const direction = new Vector3(1, -1, 0.75).normalize();
    camera.position.copy(center).addScaledVector(direction, distance * 1.2);

    // Fit the clip planes to the part. The depth buffer's precision is spent
    // across the near-to-far range, so leaving a default 0.1-to-10000 span
    // starves the part of resolution and lets the grid and axis lines draw
    // straight through solid material.
    camera.near = Math.max(radius / 100, 0.01);
    camera.far = Math.max(distance * 10, GRID_EXTENT_MM * 4);
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
  }

  function resize(): void {
    const { clientWidth, clientHeight } = container;
    if (clientWidth === 0 || clientHeight === 0) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }

  new ResizeObserver(resize).observe(container);
  resize();

  // Damping keeps moving for a few frames after the mouse stops, so the loop
  // runs continuously rather than rendering only on input.
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return { showPart };
}
