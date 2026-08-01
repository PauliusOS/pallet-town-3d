import * as THREE from 'three';
import { metaSurface, type Ball } from '../../fx/Sculpt';
import { creatureSkin } from '../../fx/CreatureMaterials';
import { clamp, smoothstep, lerp } from '../../core/Noise';
import { createRig, IdleAnimator, finishBody, disposeCreature, type Creature } from './shared';

/**
 * Pidgey — a small plump songbird: one egg of a body with a big head grown
 * straight into it, no neck at all.
 *
 * The design is carried by four graphic reads and everything here serves them:
 *   1. the cream breast/face against the warm brown crown, back and wings;
 *   2. the black angular mask through each eye;
 *   3. the two-tone crest — brown spikes behind a cream fringe;
 *   4. the short pink hooked beak.
 *
 * Body and head are marching-cubes fields painted per-vertex (the cream/brown
 * split lives in vertex colour, with a jagged boundary so it reads as feather
 * fringe, not tape). The mask is real geometry draped onto the measured skull
 * surface, and every facial landmark is raycast onto the skull rather than
 * authored at fixed coordinates.
 */

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

const CREAM = new THREE.Color(0xe0c684);
const BROWN = new THREE.Color(0x7b3f12);
const DARK_BROWN = new THREE.Color(0x46240a);
const CREST_BROWN = new THREE.Color(0x773d12);
const MASK = 0x241610;

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

/** Mirrors a ball list across X. */
function mirror(balls: Ball[]): Ball[] {
  return balls.map((b) => ({ ...b, x: -b.x }));
}

/** Writes a flat RGB vertex colour so a mesh can share the vertex-colour skin. */
function paintRGB(geo: THREE.BufferGeometry, color: THREE.Color | number, shade = 1): THREE.BufferGeometry {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r * shade;
    arr[i * 3 + 1] = c.g * shade;
    arr[i * 3 + 2] = c.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Points a Y-axis primitive along `dir`, its base at `from`. */
function placeAlong(o: THREE.Object3D, from: THREE.Vector3, dir: THREE.Vector3, len: number): void {
  const d = dir.clone().normalize();
  o.position.copy(from).addScaledVector(d, len * 0.5);
  o.quaternion.setFromUnitVectors(UP, d);
}

/**
 * Finds where a ray toward the head's interior along `dir` crosses the skull.
 * The skull is a marching-cubes surface that moves whenever a ball is retuned,
 * so facial features are measured off the real mesh, never hand-placed.
 */
const _ray = new THREE.Raycaster();
function onSkull(mesh: THREE.Mesh, dir: THREE.Vector3, fallback = 0.08): THREE.Vector3 {
  const d = dir.clone().normalize();
  _ray.set(d.clone().multiplyScalar(0.6), d.clone().negate());
  const hits = _ray.intersectObject(mesh, false);
  if (hits.length) return hits[0].point.clone();
  return d.multiplyScalar(fallback);
}

/**
 * Drapes a filled polygon onto the skull surface — the black eye mask.
 *
 * The outline is given in tangent-space radians around `centerDir` (u toward
 * the beak, v up). Each vertex of a small radial grid is raycast onto the real
 * skull and lifted a hair along its ray, so the patch hugs the measured
 * surface however the sculpt underneath is retuned.
 */
function surfacePatch(
  mesh: THREE.Mesh,
  centerDir: THREE.Vector3,
  poly: [number, number][],
  lift = 0.002,
  rings = 3,
): THREE.BufferGeometry {
  const n = centerDir.clone().normalize();
  const v = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
  const u = new THREE.Vector3().crossVectors(v, n).normalize();
  if (u.z < 0) u.negate(); // u positive is always "toward the beak", both sides

  const verts: THREE.Vector3[] = [];
  const dirFor = (a: number, b: number): THREE.Vector3 =>
    n.clone().addScaledVector(u, Math.tan(a)).addScaledVector(v, Math.tan(b)).normalize();

  const c = onSkull(mesh, n).addScaledVector(n, lift);
  verts.push(c);
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    for (const [a, b] of poly) {
      const d = dirFor(a * t, b * t);
      verts.push(onSkull(mesh, d).addScaledVector(d, lift));
    }
  }

  const m = poly.length;
  const idx: number[] = [];
  for (let i = 0; i < m; i++) idx.push(0, 1 + i, 1 + ((i + 1) % m));
  for (let r = 0; r < rings - 1; r++) {
    const a0 = 1 + r * m;
    const b0 = 1 + (r + 1) * m;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      idx.push(a0 + i, b0 + i, b0 + j, a0 + i, b0 + j, a0 + j);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setFromPoints(verts);
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A skin shell around the eyeball with an almond aperture cut from the front —
 * the only sclera on screen is what shows through the opening, and the
 * aperture edge is the crisp lash line. Same construction as Squirtle's.
 */
function eyeAperture(radius: number, ax: number, ay: number, drop: number): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, 20, 14);
  geo.deleteAttribute('uv');
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const axis = new THREE.Vector3(0, -Math.sin(drop), Math.cos(drop));
  const open = new Uint8Array(pos.count);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const t = Math.acos(clamp(p.dot(axis), -1, 1));
    const py = p.y * Math.cos(drop) + p.z * Math.sin(drop);
    const phi = Math.atan2(py, p.x);
    const cc = Math.cos(phi) / ax;
    const ss = Math.sin(phi) / ay;
    const bound = 1 / Math.sqrt(cc * cc + ss * ss);
    if (t < bound) open[i] = 1;
  }

  const idx = geo.index!;
  const out: number[] = [];
  for (let f = 0; f < idx.count; f += 3) {
    const a = idx.getX(f);
    const b = idx.getX(f + 1);
    const cc = idx.getX(f + 2);
    if (open[a] && open[b] && open[cc]) continue;
    out.push(a, b, cc);
  }
  geo.setIndex(out);
  return geo;
}

/** Triangle wave, used to serrate the cream/brown boundary into feather points. */
function tri(x: number): number {
  const f = x - Math.floor(x);
  return Math.abs(f - 0.5) * 2;
}

/**
 * A crest / fringe spike: a flattened cone whose base is buried in the skull.
 */
function spike(
  parent: THREE.Object3D,
  material: THREE.Material,
  color: THREE.Color,
  root: THREE.Vector3,
  dir: THREE.Vector3,
  len: number,
  radius: number,
  flat = 0.42,
): THREE.Mesh {
  const geo = new THREE.ConeGeometry(radius, len, 8);
  geo.deleteAttribute('uv');
  geo.translate(0, len / 2, 0);
  geo.scale(1, 1, flat);
  paintRGB(geo, color);
  const m = new THREE.Mesh(geo, material);
  m.position.copy(root);
  m.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
  m.castShadow = true;
  parent.add(m);
  return m;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildPidgey(): Creature {
  const rig = createRig();
  rig.root.name = 'Pidgey';

  /* ---- Materials ---------------------------------------------------- */
  // One vertex-coloured skin shared by body, head, wings, crest and tail, so
  // the whole bird sits in a single lighting response. The cream/brown split
  // is entirely vertex paint.
  const skin = creatureSkin({
    color: 0xffffff,
    subsurface: 0xd98d54,
    wrap: 0.22,
    rim: 0.06,
    roughness: 0.88,
    detail: 'pores',
    detailScale: 10,
  });
  skin.clearcoat = 0.06;
  skin.sheen = 0.25;
  skin.normalScale = new THREE.Vector2(0.4, 0.4);
  skin.vertexColors = true;

  const maskMat = new THREE.MeshStandardMaterial({
    color: MASK,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const beakTopMat = new THREE.MeshStandardMaterial({ color: 0xc07f8d, roughness: 0.55 });
  const beakBotMat = new THREE.MeshStandardMaterial({ color: 0xd79ca7, roughness: 0.6 });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x481f1e, roughness: 0.8 });
  const footMat = new THREE.MeshStandardMaterial({ color: 0xb96d7c, roughness: 0.6 });
  const clawMat = new THREE.MeshStandardMaterial({ color: 0xf0ece2, roughness: 0.4 });

  /* ---- Body ---------------------------------------------------------- */
  // One horizontal egg: deep chest low in front, rump tapering up and back
  // into the tail root. The bird is 90% this volume.
  const bodyGeo = metaSurface(
    [
      { x: 0, y: 0.142, z: 0.050, r: 0.078, sx: 1.16, sy: 0.92 },
      { x: 0, y: 0.118, z: 0.012, r: 0.066, sx: 1.22, sy: 0.80 },
      { x: 0, y: 0.162, z: -0.018, r: 0.060, sx: 1.05 },
      // Neck fill: bridges into the head so the two fields read as one form.
      { x: 0, y: 0.190, z: 0.038, r: 0.050, sx: 1.0, sy: 0.85 },
      { x: 0, y: 0.156, z: -0.075, r: 0.052, sy: 0.90 },
      { x: 0, y: 0.168, z: -0.112, r: 0.034, sy: 0.75 },
    ],
    { resolution: 44, smooth: 0.92 },
  );
  const bodyMesh = finishBody(new THREE.Mesh(bodyGeo, skin), new THREE.Vector3(0, 0.15, -0.01), 0.24);
  paintBird(bodyGeo, new THREE.Vector3(0, 0.15, -0.01));
  rig.body.add(bodyMesh);

  /* ---- Head ----------------------------------------------------------- */
  // Grown straight out of the body's front-top. The pivot sits low so the
  // idle sway reads as the whole head tipping on the chest, not a bobblehead.
  rig.head.position.set(0, 0.216, 0.055);

  const headBalls: Ball[] = [
    { x: 0, y: 0.020, z: -0.005, r: 0.060, sx: 1.06, sy: 0.96 },
    { x: 0, y: 0.006, z: 0.030, r: 0.054, sy: 0.92, sz: 0.88 },
    { x: 0, y: 0.038, z: 0.016, r: 0.044, sx: 1.08, sy: 0.82 },
    { x: 0, y: 0.010, z: -0.035, r: 0.046 },
    // Throat, blending down toward the chest so there is no neck.
    { x: 0, y: -0.030, z: 0.014, r: 0.042, sy: 0.85 },
  ];
  for (const s of [1, -1]) {
    headBalls.push({ x: s * 0.040, y: -0.002, z: 0.010, r: 0.042 });
    // Eye sockets, so the eyeballs sit into the skull.
    headBalls.push({ x: s * 0.040, y: 0.020, z: 0.044, r: 0.028, sy: 0.9, sz: 0.7, strength: -0.35 });
  }
  const headGeo = metaSurface(headBalls, { resolution: 52, smooth: 0.9 });
  const headMesh = new THREE.Mesh(headGeo, skin);

  /* ---- Facial landmarks off the measured skull ------------------------ */
  const SPLAY = 0.60;
  const EYE_R = 0.0142;
  const eyeDir = (s: number): THREE.Vector3 =>
    new THREE.Vector3(Math.sin(s * SPLAY), 0.30, Math.cos(s * SPLAY)).normalize();
  const eyeSeat = [1, -1].map((s) => onSkull(headMesh, eyeDir(s)));

  const beakHit = onSkull(headMesh, new THREE.Vector3(0, -0.02, 1));

  // The mask is measured and draped BEFORE the head is painted/parented.
  // Compact angular patch hugging the eye — sits mostly around and behind it,
  // with a short point toward the beak and a deeper point dropping below.
  const maskPoly: [number, number][] = [
    [0.18, 0.06],
    [-0.08, 0.13],
    [-0.34, 0.08],
    [-0.45, -0.05],
    [-0.18, -0.12],
    [0.02, -0.22],
    [0.16, -0.08],
  ];
  for (const s of [1, -1]) {
    const patch = new THREE.Mesh(surfacePatch(headMesh, eyeDir(s), maskPoly), maskMat);
    patch.castShadow = false;
    rig.head.add(patch);
  }

  finishBody(headMesh, new THREE.Vector3(0, 0.015, 0), 0.22);
  paintHead(headGeo);
  rig.head.add(headMesh);

  // Skull plug: backs the surface where the socket carves run deep.
  const plugGeo = new THREE.SphereGeometry(0.052, 18, 12);
  plugGeo.scale(1.1, 0.95, 1.0);
  plugGeo.deleteAttribute('uv');
  paintRGB(plugGeo, CREAM, 0.9);
  const plug = new THREE.Mesh(plugGeo, skin);
  plug.position.set(0, 0.014, -0.002);
  plug.castShadow = false;
  plug.receiveShadow = false;
  rig.head.add(plug);

  /* ---- Eyes ----------------------------------------------------------- */
  // Black beady eyes: a big near-black iris over a white sclera, a crisp
  // catchlight, all inside a mask-dark aperture shell so the eye and the black
  // marking read as one graphic, exactly as on the model.
  const scleraMat = new THREE.MeshStandardMaterial({ color: 0xf6f2ea, roughness: 0.4 });
  const irisMat = new THREE.MeshBasicMaterial({ color: 0x1c120c });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x060404 });
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  for (const s of [1, -1]) {
    const d = eyeDir(s);
    const seat = eyeSeat[s > 0 ? 0 : 1];

    const holder = new THREE.Group();
    holder.position.copy(seat.clone().addScaledVector(d, -EYE_R * 0.55));
    holder.rotation.y = s * SPLAY;
    holder.scale.y = 0.94;
    rig.head.add(holder);

    const eye = new THREE.Group();
    eye.name = 'Eye';
    holder.add(eye);

    eye.add(new THREE.Mesh(new THREE.SphereGeometry(EYE_R, 20, 14), scleraMat));

    const iris = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.006, 22, 14, 0, Math.PI * 2, 0, Math.asin(0.78)),
      irisMat,
    );
    iris.rotation.x = Math.PI / 2;
    eye.add(iris);

    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.012, 18, 12, 0, Math.PI * 2, 0, Math.asin(0.78 * 0.6)),
      pupilMat,
    );
    pupil.rotation.x = Math.PI / 2;
    eye.add(pupil);

    const glint = new THREE.Mesh(new THREE.SphereGeometry(EYE_R * 0.17, 10, 8), glintMat);
    glint.position.set(-EYE_R * 0.30, EYE_R * 0.36, EYE_R * 0.90);
    eye.add(glint);

    eye.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });

    // Aperture shell in mask black — the lash line and the marking are one.
    const lid = new THREE.Mesh(eyeAperture(EYE_R * 1.05, 1.05, 0.92, 0.10), maskMat);
    lid.castShadow = false;
    holder.add(lid);

    // Blink lid, mask-dark so a blink reads as the eye going out.
    const blinkGeo = new THREE.SphereGeometry(EYE_R * 0.99, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    blinkGeo.scale(1.0, 1.22, 1.0);
    blinkGeo.deleteAttribute('uv');
    const blink = new THREE.Mesh(blinkGeo, new THREE.MeshStandardMaterial({ color: MASK, roughness: 0.85 }));
    blink.scale.y = 0;
    blink.castShadow = false;
    holder.add(blink);

    rig.eyes.push(eye);
    rig.eyelids.push(blink);
  }

  /* ---- Beak ----------------------------------------------------------- */
  // A clean short cone, pink. The upper half is the cone itself, slightly
  // flattened, its tip drooped into a downward hook so it overhangs the lower
  // half; a thin dark seam between them is the closed mouth line.
  const beakRoot = new THREE.Vector3(0, beakHit.y + 0.006, beakHit.z - 0.006);

  const upperGeo = new THREE.ConeGeometry(0.0185, 0.054, 16);
  upperGeo.translate(0, 0.027, 0);
  upperGeo.rotateX(Math.PI / 2); // now pointing +Z, base at the origin
  upperGeo.scale(1.0, 0.78, 1.0);
  hookTip(upperGeo, 0.054, 0.016);
  const upper = new THREE.Mesh(upperGeo, beakTopMat);
  upper.position.copy(beakRoot);
  upper.rotation.x = -0.06;
  upper.castShadow = true;
  rig.head.add(upper);

  const lowerGeo = new THREE.ConeGeometry(0.0150, 0.036, 14);
  lowerGeo.translate(0, 0.018, 0);
  lowerGeo.rotateX(Math.PI / 2);
  lowerGeo.scale(0.92, 0.55, 1.0);
  const lower = new THREE.Mesh(lowerGeo, beakBotMat);
  lower.position.set(beakRoot.x, beakRoot.y - 0.010, beakRoot.z);
  lower.rotation.x = 0.10;
  lower.castShadow = true;
  rig.head.add(lower);

  // Narrow dark mouth line pinched between the two halves.
  const mouthGeo = new THREE.SphereGeometry(0.0155, 14, 8);
  mouthGeo.scale(0.72, 0.14, 1.0);
  const mouth = new THREE.Mesh(mouthGeo, mouthMat);
  mouth.position.set(beakRoot.x, beakRoot.y - 0.008, beakRoot.z + 0.013);
  mouth.rotation.x = 0.2;
  mouth.castShadow = false;
  rig.head.add(mouth);

  /* ---- Crest ----------------------------------------------------------- */
  // One solid brown tuft rising from the forehead and flowing backward off the
  // crown — a merged marching-cubes mound, not separate spikes — finished with
  // two flattened points continuing the sweep so the silhouette ends in the
  // model's 2-3 back-swept tips.
  const crestGeo = metaSurface(
    [
      { x: 0, y: 0.048, z: 0.032, r: 0.033, sx: 0.92, sy: 1.0, sz: 1.05 },
      { x: 0, y: 0.074, z: 0.004, r: 0.029, sx: 0.64, sz: 1.12 },
      { x: 0, y: 0.088, z: -0.026, r: 0.023, sx: 0.52, sz: 1.28 },
      { x: 0, y: 0.096, z: -0.054, r: 0.016, sx: 0.42, sz: 1.38 },
    ],
    { resolution: 40, smooth: 0.9 },
  );
  paintRGB(crestGeo, CREST_BROWN);
  const crest = new THREE.Mesh(crestGeo, skin);
  crest.castShadow = true;
  rig.head.add(crest);

  // Back-swept tips growing out of the tuft (bases buried in the mound).
  spike(rig.head, skin, CREST_BROWN, new THREE.Vector3(0, 0.080, 0.002), new THREE.Vector3(0, 0.55, -0.83), 0.078, 0.019, 0.55);
  spike(rig.head, skin, CREST_BROWN, new THREE.Vector3(0, 0.090, -0.036), new THREE.Vector3(0, 0.32, -0.95), 0.068, 0.016, 0.55);

  // Two small cream points above the brow, angling out over the eyes.
  spike(rig.head, skin, CREAM, new THREE.Vector3(0.024, 0.044, 0.036), new THREE.Vector3(0.74, 0.34, 0.36), 0.052, 0.013, 0.4);
  spike(rig.head, skin, CREAM, new THREE.Vector3(-0.024, 0.044, 0.036), new THREE.Vector3(-0.74, 0.34, 0.36), 0.052, 0.013, 0.4);

  /* ---- Wings ----------------------------------------------------------- */
  // Folded flat against the flanks, brown darkening toward the trailing edge,
  // with three separate feather tips laid over the rump.
  const wingBalls: Ball[] = [
    { x: 0.002, y: 0.020, z: 0.044, r: 0.044, sx: 0.36, sy: 0.98 },
    { x: 0.004, y: 0.006, z: 0.000, r: 0.047, sx: 0.34, sy: 1.02 },
    { x: 0.007, y: -0.008, z: -0.048, r: 0.041, sx: 0.32, sy: 0.94 },
    { x: 0.010, y: -0.020, z: -0.100, r: 0.026, sx: 0.30, sz: 1.55 },
  ];
  const wings: THREE.Group[] = [];
  const featherTipGeo = new THREE.CapsuleGeometry(0.008, 0.030, 3, 8);
  featherTipGeo.scale(1, 1, 0.35);
  featherTipGeo.deleteAttribute('uv');
  paintRGB(featherTipGeo, DARK_BROWN, 1.0);

  for (const s of [1, -1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.079, 0.168, 0.004);
    g.rotation.z = s * -0.14;
    g.rotation.y = s * 0.06;
    const balls = s > 0 ? wingBalls : mirror(wingBalls);
    const geo = metaSurface(balls, { resolution: 38, smooth: 0.9 });
    const m = finishBody(new THREE.Mesh(geo, skin), new THREE.Vector3(0, 0.0, -0.01), 0.2);
    paintWing(geo, s);
    g.add(m);

    for (const j of [0, 1, 2]) {
      const f = new THREE.Mesh(featherTipGeo, skin);
      const root = new THREE.Vector3(s * (0.010 - j * 0.003), -0.014 - j * 0.005, -0.100 - j * 0.004);
      placeAlong(f, root, new THREE.Vector3(s * 0.05, -0.14 - j * 0.05, -1), 0.030);
      f.castShadow = true;
      g.add(f);
    }

    rig.body.add(g);
    wings.push(g);
  }

  /* ---- Tail ------------------------------------------------------------ */
  // A fan of flattened feathers pointing back and a little up, brown with a
  // darker band toward the tips.
  const tail = new THREE.Group();
  tail.position.set(0, 0.176, -0.115);
  tail.rotation.x = 0.30;
  rig.body.add(tail);
  rig.tail = tail;

  const featherSpecs: [number, number, number][] = [
    // [yaw, length, lift]
    [0, 0.115, 0.006],
    [0.19, 0.098, 0.002],
    [-0.19, 0.098, 0.002],
    [0.37, 0.080, -0.003],
    [-0.37, 0.080, -0.003],
  ];
  for (const [yaw, len, liftY] of featherSpecs) {
    const geo = new THREE.CapsuleGeometry(0.017, len, 4, 10);
    geo.translate(0, len / 2, 0);
    geo.scale(1, 1, 0.3);
    geo.deleteAttribute('uv');
    paintFeather(geo, len);
    const f = new THREE.Mesh(geo, skin);
    const dir = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
    f.position.set(0, liftY, 0);
    f.quaternion.setFromUnitVectors(UP, dir);
    f.castShadow = true;
    tail.add(f);
  }
  const tailCapGeo = new THREE.SphereGeometry(0.026, 12, 8);
  tailCapGeo.deleteAttribute('uv');
  paintRGB(tailCapGeo, BROWN, 0.9);
  const tailCap = new THREE.Mesh(tailCapGeo, skin);
  tailCap.scale.set(1.1, 0.8, 1.0);
  tailCap.castShadow = true;
  tail.add(tailCap);

  /* ---- Legs and feet ---------------------------------------------------- */
  const toeGeo = new THREE.CapsuleGeometry(0.0068, 0.026, 3, 8);
  toeGeo.scale(1, 1, 0.85);
  const clawGeo = new THREE.ConeGeometry(0.0042, 0.011, 8);

  for (const s of [1, -1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.0095, 0.016, 4, 10), footMat);
    leg.position.set(s * 0.034, 0.038, 0.014);
    leg.castShadow = true;
    rig.body.add(leg);

    // Feathered thigh: a cream tuft over the top of the leg so only a short
    // pink ankle shows, the way the model wears its legs.
    const thighGeo = new THREE.SphereGeometry(0.015, 14, 10);
    thighGeo.scale(1.0, 1.25, 0.95);
    thighGeo.deleteAttribute('uv');
    paintRGB(thighGeo, CREAM, 0.92);
    const thigh = new THREE.Mesh(thighGeo, skin);
    thigh.position.set(s * 0.034, 0.057, 0.014);
    thigh.castShadow = true;
    rig.body.add(thigh);

    const foot = new THREE.Group();
    foot.position.set(s * 0.034, 0.010, 0.016);
    rig.body.add(foot);

    for (const yaw of [-0.42, 0, 0.42]) {
      const dir = new THREE.Vector3(Math.sin(yaw) + s * 0.06, -0.06, Math.cos(yaw)).normalize();
      const toe = new THREE.Mesh(toeGeo, footMat);
      placeAlong(toe, new THREE.Vector3(0, 0, 0), dir, 0.026);
      toe.castShadow = true;
      foot.add(toe);

      const claw = new THREE.Mesh(clawGeo, clawMat);
      const cd = dir.clone().add(new THREE.Vector3(0, -0.18, 0)).normalize();
      placeAlong(claw, dir.clone().multiplyScalar(0.030), cd, 0.010);
      claw.castShadow = true;
      foot.add(claw);
    }
    // Hind toe.
    const back = new THREE.Mesh(toeGeo, footMat);
    placeAlong(back, new THREE.Vector3(0, 0.002, -0.002), new THREE.Vector3(s * 0.1, -0.05, -1).normalize(), 0.016);
    back.scale.set(0.85, 0.6, 0.85);
    back.castShadow = true;
    foot.add(back);
  }

  /* ---- Performance ------------------------------------------------------ */
  const anim = new IdleAnimator(rig, 16);
  let attention = 0;

  // Deterministic per-segment hash for the head-tick: birds re-aim their head
  // in quick snaps, not sways. (Seeded elsewhere; Math.random is banned.)
  const hash = (n: number): number => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  return {
    id: 'pidgey',
    name: 'Pidgey',
    group: rig.root,
    get attention() {
      return attention;
    },
    set attention(v: number) {
      attention = clamp(v, 0, 1);
    },
    update(dt, elapsed) {
      anim.update(dt, elapsed, attention);

      // Head tick: snap to a new yaw/tilt every couple of seconds.
      const period = 1.9;
      const seg = Math.floor(elapsed / period);
      const f = elapsed / period - seg;
      const k = smoothstep(0, 0.12, f);
      const yaw = lerp((hash(seg - 1) - 0.5) * 0.5, (hash(seg) - 0.5) * 0.5, k);
      const tilt = lerp((hash(seg + 17.3) - 0.5) * 0.22, (hash(seg + 18.3) - 0.5) * 0.22, k);
      rig.head.rotation.y += yaw;
      rig.head.rotation.z += tilt;

      // Wing settle and tail bob.
      for (let i = 0; i < wings.length; i++) {
        const s = i === 0 ? 1 : -1;
        wings[i].rotation.z = s * (-0.14 + Math.sin(elapsed * 1.2 + i * 2.1) * 0.02);
      }
      tail.rotation.x = 0.34 + Math.sin(elapsed * 1.05 + 0.7) * 0.05;
    },
    celebrate: () => anim.celebrate(),
    dispose: () => disposeCreature(rig.root),
  };
}

/* ------------------------------------------------------------------ */
/* Painters                                                            */
/* ------------------------------------------------------------------ */

/**
 * Droops the tip of a +Z-pointing cone downward — quadratic in length so the
 * base stays put and the hook sharpens toward the tip. Symmetric in X, so the
 * beak stays clean from the front.
 */
function hookTip(geo: THREE.BufferGeometry, len: number, drop: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const t = clamp(pos.getZ(i) / len, 0, 1);
    pos.setY(i, pos.getY(i) - drop * t * t);
  }
  geo.computeVertexNormals();
}

/**
 * Paints the body: cream breast/belly/throat, warm brown saddle over the back,
 * their boundary serrated into feather points. Multiplies the cavity AO that
 * finishBody already baked into the colour attribute.
 */
function paintBird(geo: THREE.BufferGeometry, center: THREE.Vector3): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).sub(center);
    const n = p.clone().normalize();
    const az = Math.atan2(n.x, n.z);
    const jag = (tri(az * 2.4) - 0.5) * 0.22;
    // Brown saddle over the whole back and down the flanks to roughly the
    // horizontal midline; the chest and belly stay cream. The -z bias keeps
    // the breast cream while letting the rump and nape go fully brown.
    const t = smoothstep(0.02, 0.28, n.y * 0.95 - n.z * 0.45 + jag);
    c.copy(CREAM).lerp(BROWN, t);

    // Faint vertical striations on the cream breast: drawn feathers.
    const streak = 1 - 0.07 * Math.max(0, Math.sin(az * 16)) * (1 - t) * smoothstep(-0.2, 0.4, n.z);

    const ao = col.getX(i); // greyscale AO from finishBody
    col.setXYZ(i, c.r * ao * streak, c.g * ao * streak, c.b * ao * streak);
  }
}

/** Paints the head: cream face and throat, brown crown running down the nape. */
function paintHead(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  const center = new THREE.Vector3(0, 0.015, -0.002);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).sub(center);
    const n = p.clone().normalize();
    const az = Math.atan2(n.x, n.z);
    const jag = (tri(az * 2.8) - 0.5) * 0.18;
    const t = smoothstep(-0.02, 0.16, n.y * 0.95 - n.z * 0.34 + jag * 0.4);
    c.copy(CREAM).lerp(BROWN, t);
    const ao = col.getX(i);
    col.setXYZ(i, c.r * ao, c.g * ao, c.b * ao);
  }
}

/**
 * Paints a wing: brown shoulder deepening to dark brown at the trailing tip,
 * with a serrated cream fringe along the lower edge so the wing-over-breast
 * boundary reads as soft feather points, matching the model.
 */
function paintWing(geo: THREE.BufferGeometry, _side: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const jag = (tri(z * 26) - 0.5) * 0.018;
    const fringe = smoothstep(-0.040 + jag, -0.020 + jag, y);
    const dark = smoothstep(-0.06, -0.115, z) * 0.55;
    c.copy(CREAM).lerp(BROWN, fringe).lerp(DARK_BROWN, dark * fringe);
    const ao = col.getX(i);
    col.setXYZ(i, c.r * ao, c.g * ao, c.b * ao);
  }
}

/** Paints a tail feather (pre-orientation, +Y along the vane): banded brown. */
function paintFeather(geo: THREE.BufferGeometry, len: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const t = clamp(pos.getY(i) / len, 0, 1);
    const band = smoothstep(0.60, 0.70, t) * (1 - smoothstep(0.87, 0.96, t));
    c.copy(BROWN).lerp(DARK_BROWN, band);
    const shade = 0.92 + t * 0.1;
    arr[i * 3] = c.r * shade;
    arr[i * 3 + 1] = c.g * shade;
    arr[i * 3 + 2] = c.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}
