import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildCreature, buildPokeBall, STARTERS, type Creature, type SpeciesId } from './gameplay/Pokemon';

/**
 * Creature turntable.
 *
 * An isolated rig for reviewing the starters and the Poke Ball on a neutral
 * studio set. Judging a character inside the town is hopeless — the town's
 * own lighting, colour grade and background clutter hide exactly the modelling
 * and shading faults this page exists to expose.
 *
 * Query params:
 *   ?subject=bulbasaur|charmander|squirtle|pokeball|all   (default: all)
 *   ?angle=front|three_quarter|side|back|top              (default: three_quarter)
 *   ?bg=studio|dark|white                                 (default: studio)
 */

const params = new URLSearchParams(location.search);
const subject = params.get('subject') ?? 'all';
const angleName = params.get('angle') ?? 'three_quarter';
const bg = params.get('bg') ?? 'studio';

const container = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const BG = { studio: 0x2a3038, dark: 0x0d0f12, white: 0xe8e4dd }[bg] ?? 0x2a3038;
scene.background = new THREE.Color(BG);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.85;

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.01, 50);

/* ---- Three-point studio lighting -------------------------------------
 * Key from camera-left and above, cool fill opposite to keep the shadow
 * side readable, and a hot rim behind to separate the silhouette from the
 * background. This is the standard character-review setup; it flatters
 * nothing and hides nothing.
 */
const key = new THREE.DirectionalLight(0xfff2dd, 3.4);
key.position.set(-1.4, 2.2, 1.9);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 8;
key.shadow.camera.left = -1;
key.shadow.camera.right = 1;
key.shadow.camera.top = 1;
key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0008;
key.shadow.normalBias = 0.012;
scene.add(key);

const fill = new THREE.DirectionalLight(0xbcd4f0, 0.85);
fill.position.set(2.2, 0.7, 1.2);
scene.add(fill);

const rimLight = new THREE.DirectionalLight(0xffe9c8, 2.1);
rimLight.position.set(0.6, 1.1, -2.4);
scene.add(rimLight);

scene.add(new THREE.HemisphereLight(0x9fc4e8, 0x4a4238, 0.5));

/* ---- Ground ---------------------------------------------------------- */
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(3, 64),
  new THREE.MeshStandardMaterial({ color: 0x3a4149, roughness: 0.92, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* ---- Subjects -------------------------------------------------------- */
const creatures: Creature[] = [];
const balls: ReturnType<typeof buildPokeBall>[] = [];
const root = new THREE.Group();
scene.add(root);

function addCreature(id: SpeciesId, x: number): void {
  const c = buildCreature(id);
  c.group.position.x = x;
  c.attention = 0.5;
  root.add(c.group);
  creatures.push(c);
}

let frameRadius = 0.55;

if (subject === 'all') {
  addCreature('bulbasaur', -0.62);
  addCreature('charmander', 0);
  addCreature('squirtle', 0.62);
  frameRadius = 1.25;
} else if (subject === 'pokeball') {
  const b = buildPokeBall(1);
  b.group.position.y = 0.037;
  root.add(b.group);
  balls.push(b);
  frameRadius = 0.075;
} else if (subject === 'pokeball_open') {
  const b = buildPokeBall(1);
  b.group.position.y = 0.037;
  b.setOpen(1);
  root.add(b.group);
  balls.push(b);
  frameRadius = 0.09;
} else {
  addCreature(subject as SpeciesId, 0);
  // Frame each creature to its own measured height.
  const box = new THREE.Box3().setFromObject(creatures[0].group);
  frameRadius = Math.max(box.max.y - box.min.y, box.max.x - box.min.x) * 0.72;
}

/* ---- Camera framing -------------------------------------------------- */
const ANGLES: Record<string, [number, number]> = {
  // [azimuth radians, elevation radians]
  front: [0, 0.12],
  three_quarter: [0.62, 0.2],
  side: [Math.PI / 2, 0.12],
  back: [Math.PI, 0.18],
  top: [0.6, 0.85],
  low: [0.5, -0.05],
};
const [az, el] = ANGLES[angleName] ?? ANGLES.three_quarter;

function frame(): void {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.62 || frameRadius;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360) + radius * 0.6;
  camera.position.set(
    center.x + Math.sin(az) * Math.cos(el) * dist,
    center.y + Math.sin(el) * dist + size.y * 0.06,
    center.z + Math.cos(az) * Math.cos(el) * dist,
  );
  camera.lookAt(center.x, center.y, center.z);
  camera.updateProjectionMatrix();

  // Point the key light at the subject so shadows land under it.
  key.target.position.copy(center);
  scene.add(key.target);
}
frame();

/* ---- Post ------------------------------------------------------------ */
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: 4,
  }),
);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new OutputPass());
composer.addPass(new SMAAPass());

const clock = new THREE.Clock();
let spin = false;

/**
 * Scene-pass render stats, sampled before the composer's fullscreen passes.
 *
 * `renderer.info` resets at the start of every `render()` call, and a composer
 * frame ends with a fullscreen quad — so reading it after `composer.render()`
 * reports one draw call and zero triangles no matter how dense the model is,
 * which is exactly what made the poly-budget telemetry read 0.0k.
 */
const stats = { triangles: 0, calls: 0 };

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  const t = clock.elapsedTime;
  for (const c of creatures) c.update(dt, t);
  for (const b of balls) b.update(dt, t);
  if (spin) root.rotation.y = t * 0.4;

  renderer.info.reset();
  renderer.info.autoReset = false;
  composer.render();
  // The scene pass runs first, so the counters have already accumulated it by
  // the time the grade/SMAA quads add their own single-triangle draws.
  stats.triangles = renderer.info.render.triangles;
  stats.calls = renderer.info.render.calls;
  renderer.info.autoReset = true;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  frame();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') spin = !spin;
});

// Handle for the capture harness.
Object.assign(window, {
  __VIEWER__: {
    scene, camera, renderer, creatures, balls, root, frame,
    setAngle(a: string) {
      const v = ANGLES[a];
      if (v) {
        frameFrom(v[0], v[1]);
      }
    },
    celebrate() { for (const c of creatures) c.celebrate(); },
    triangles: () => stats.triangles,
    drawCalls: () => stats.calls,
  },
});

function frameFrom(a: number, e: number): void {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.62 || frameRadius;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360) + radius * 0.6;
  camera.position.set(
    center.x + Math.sin(a) * Math.cos(e) * dist,
    center.y + Math.sin(e) * dist + size.y * 0.06,
    center.z + Math.cos(a) * Math.cos(e) * dist,
  );
  camera.lookAt(center.x, center.y, center.z);
}

window.dispatchEvent(new CustomEvent('viewer:ready'));
// Triangle count is only meaningful after the first frame, so it is read from
// the sampled stats rather than from renderer.info at module scope.
requestAnimationFrame(() =>
  console.info(`[viewer] ${subject} ${angleName} — ${(stats.triangles / 1000).toFixed(1)}k tris`),
);
