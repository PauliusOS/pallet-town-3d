import * as THREE from 'three';
import { metaSurface, roundedBox, type Ball } from '../../fx/Sculpt';
import { creatureSkin } from '../../fx/CreatureMaterials';
import { clamp, smoothstep } from '../../core/Noise';
import { createRig, IdleAnimator, finishBody, taperTube, disposeCreature, type Creature } from './shared';

/**
 * Rattata — a small crouched rat, low and forward-leaning, haunches heavier
 * than shoulders, built to read at a glance from three signals: the huge
 * slanted red eyes, the two white incisors overhanging the jaw, and the long
 * tail curling up into a spiral. Purple over the top, cream underneath, cream
 * whisker-spikes sweeping back off the muzzle.
 *
 * Everything follows the house method: metaball bodies finished with cavity
 * shading, facial features seated by raycast onto the meshed skull rather
 * than by trusted coordinates, layered eyeballs sunk into carved sockets, and
 * tapered tubes for tail and whiskers.
 */

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

/** Ensures any geometry sharing the vertex-coloured skin has a colour. */
function ensureVertexColor(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geo.attributes.color) {
    const n = geo.attributes.position.count;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  return geo;
}

/** Writes a flat vertex colour, for parts that share the skin material. */
function paintFlat(geo: THREE.BufferGeometry, shade = 1): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  c.fill(shade);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Mirrors a ball list across X. */
function mirror(balls: Ball[]): Ball[] {
  return balls.map((b) => ({ ...b, x: -b.x }));
}

/**
 * Multiplies a tint into the vertex colour wherever `mask` returns > 0.
 *
 * The skin material's base colour is the purple; the cream underside is a
 * multiplicative tint with per-channel factors > 1 (the same trick as
 * Bulbasaur's belly). Vertex colour is the only channel a marching-cubes
 * surface has, so all two-tone work happens here.
 */
function paintMask(
  geo: THREE.BufferGeometry,
  tint: [number, number, number],
  mask: (p: THREE.Vector3, n: THREE.Vector3) => number,
): void {
  ensureVertexColor(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const m = clamp(mask(p, n), 0, 1);
    if (m <= 0) continue;
    col.setXYZ(
      i,
      col.getX(i) * (1 + (tint[0] - 1) * m),
      col.getY(i) * (1 + (tint[1] - 1) * m),
      col.getZ(i) * (1 + (tint[2] - 1) * m),
    );
  }
  col.needsUpdate = true;
}

/**
 * Finds where a ray from outside toward the head's interior first crosses the
 * skull surface — the onSkull pattern. Facial features are seated on the
 * *meshed* isosurface, never on authored coordinates, because the Wyvill iso
 * crosses far outside the nominal ball radii wherever several balls blend.
 */
const _ray = new THREE.Raycaster();
function onSkull(mesh: THREE.Mesh, dir: THREE.Vector3, fallback = 0.08): THREE.Vector3 {
  const d = dir.clone().normalize();
  _ray.set(d.clone().multiplyScalar(0.6), d.clone().negate());
  const hits = _ray.intersectObject(mesh, false);
  if (hits.length) return hits[0].point.clone();
  return d.multiplyScalar(fallback);
}

/** A tapered whisker spike along a gentle curve. */
function whiskerGeometry(pts: THREE.Vector3[], r: number, tipScale: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  const rings = 12;
  const radial = 6;
  const geo = new THREE.TubeGeometry(curve, rings, r, radial, false);
  taperTube(geo, curve, rings + 1, radial + 1, 1.0, tipScale, (t) => t);
  geo.deleteAttribute('uv');
  return geo;
}

/**
 * One ear: a flattened, rounded-triangular plate with a soft point.
 * Built from a sphere so the margin stays thick and rounded — a card-thin
 * ear reads as paper from every grazing angle.
 */
function earGeometry(halfW: number, height: number, thick: number): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 22, 16);
  geo.deleteAttribute('uv');
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = clamp((v.y + 1) / 2, 0, 1); // 0 root, 1 tip
    // Draw the top in toward a soft point, keep the base broad and round.
    const pinch = 1 - 0.62 * Math.pow(smoothstep(0.45, 1.0, t), 1.25);
    pos.setXYZ(
      i,
      v.x * halfW * pinch,
      v.y * height * 0.5 + height * 0.5,
      v.z * thick * pinch,
    );
  }
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildRattata(): Creature {
  const rig = createRig();
  rig.root.name = 'Rattata';

  /* ---- Materials ---------------------------------------------------- */
  // Authored deep and saturated: wrap lighting, the sky fill and the studio
  // probe lift the render well above the albedo, so the purple has to start
  // darker than the target read (the Bulbasaur lesson).
  // 0x5e3079 rendered as pastel lilac — the lighting stack lifts everything by
  // roughly a third, so the albedo starts a full step deeper and more
  // saturated than the target read.
  const PURPLE = 0x582268;
  const skin = creatureSkin({
    color: PURPLE,
    subsurface: 0x36184a,
    wrap: 0.10,
    rim: 0.04,
    roughness: 0.9,
    detail: 'pores',
    detailScale: 8,
  });
  skin.clearcoat = 0.04;
  skin.clearcoatRoughness = 0.7;
  skin.sheen = 0.04;
  skin.sheenColor = new THREE.Color(0x36184a).multiplyScalar(0.3);
  skin.normalScale.set(0.25, 0.25);
  skin.envMapIntensity = 0.18;
  skin.roughnessMap = null;
  skin.roughness = 0.88;
  skin.vertexColors = true;

  // Cream, as a multiplicative tint over the purple base. The factors apply in
  // LINEAR space (three.js converts the material colour to linear, vertex
  // colours pass through raw), where the purple is (0.098, 0.016, 0.139).
  // Factors computed in sRGB space made every cream zone render lavender-pink
  // because linear green was starved. These land the tint on ~#d9c48c linear
  // (0.69, 0.55, 0.26) — a warm butter cream.
  const CREAM: [number, number, number] = [6.2, 29.5, 1.28];

  const creamMat = new THREE.MeshStandardMaterial({ color: 0xdfcb84, roughness: 0.72 });
  const toothMat = new THREE.MeshPhysicalMaterial({
    color: 0xf3efe2, roughness: 0.35, clearcoat: 0.25, clearcoatRoughness: 0.4,
  });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x571523, roughness: 0.8 });
  const noseMat = new THREE.MeshStandardMaterial({ color: 0x8f4a72, roughness: 0.6 });

  /* ---- Body ---------------------------------------------------------- */
  // Low, long, forward-leaning: haunches taller and wider than the shoulders,
  // chest dropped, daylight under the belly. Hind feet plant under the
  // haunches, forefeet ahead of the chest.
  const bodyBalls: Ball[] = [
    // Barrel, long on Z, leaning downhill toward the chest. Slimmer than the
    // first pass, which read as a hamster.
    { x: 0, y: 0.124, z: -0.030, r: 0.086, sx: 0.86, sy: 0.78, sz: 1.5 },
    // Chest, lower and narrower.
    { x: 0, y: 0.108, z: 0.088, r: 0.068, sx: 0.8, sy: 0.82, sz: 0.94 },
    // Neck rising to meet the head.
    { x: 0, y: 0.158, z: 0.124, r: 0.043, sx: 0.84, sy: 0.85 },
    // Haunches — the biggest masses on the animal.
    { x: 0.078, y: 0.146, z: -0.140, r: 0.078, sx: 0.90, sy: 1.02, sz: 1.0 },
    { x: -0.078, y: 0.146, z: -0.140, r: 0.078, sx: 0.90, sy: 1.02, sz: 1.0 },
    // Rump filler between the haunches.
    { x: 0, y: 0.148, z: -0.165, r: 0.058, sy: 0.95 },
    // Shoulders, small.
    { x: 0.050, y: 0.112, z: 0.072, r: 0.044, sy: 0.92 },
    { x: -0.050, y: 0.112, z: 0.072, r: 0.044, sy: 0.92 },
    // Belly tucked up.
    { x: 0, y: 0.098, z: -0.030, r: 0.056, sx: 0.8, sy: 0.5, sz: 1.28 },
  ];
  // Legs.
  for (const s of [1, -1]) {
    // Hind: shank dropping from the haunch, long flat foot planted forward.
    bodyBalls.push({ x: s * 0.085, y: 0.072, z: -0.140, r: 0.042, sy: 0.95 });
    bodyBalls.push({ x: s * 0.084, y: 0.032, z: -0.118, r: 0.034, sx: 0.74, sy: 0.6, sz: 1.35 });
    bodyBalls.push({ x: s * 0.084, y: 0.026, z: -0.078, r: 0.028, sx: 0.72, sy: 0.55, sz: 1.25 });
    // Fore: short straight posts ahead of the chest.
    bodyBalls.push({ x: s * 0.050, y: 0.070, z: 0.100, r: 0.032, sy: 1.1 });
    bodyBalls.push({ x: s * 0.050, y: 0.030, z: 0.108, r: 0.028, sy: 0.85 });
    bodyBalls.push({ x: s * 0.050, y: 0.022, z: 0.128, r: 0.026, sx: 0.85, sy: 0.55, sz: 1.3 });
    // Toe masses.
    for (const tx of [-0.014, 0.014]) {
      bodyBalls.push({ x: s * 0.050 + tx, y: 0.018, z: 0.148, r: 0.014, sx: 0.8, sy: 0.55 });
      bodyBalls.push({ x: s * 0.086 + tx * 1.2, y: 0.020, z: -0.052, r: 0.015, sx: 0.8, sy: 0.55 });
    }
  }
  // Carves: open daylight between the leg pairs and lift the belly line.
  bodyBalls.push({ x: 0, y: 0.055, z: -0.125, r: 0.058, sx: 1.1, sy: 1.15, sz: 0.9, strength: -0.85 });
  bodyBalls.push({ x: 0, y: 0.045, z: 0.110, r: 0.042, sx: 1.0, sy: 1.15, sz: 0.85, strength: -0.8 });
  bodyBalls.push({ x: 0, y: 0.085, z: -0.030, r: 0.048, sx: 1.05, sy: 0.85, sz: 1.1, strength: -0.3 });

  const bodyGeo = metaSurface(bodyBalls, { resolution: 38, smooth: 0.98, padding: 0.04 });
  const body = finishBody(new THREE.Mesh(bodyGeo, skin), new THREE.Vector3(0, 0.13, -0.03), 0.3);

  // Cream underside: a band along the belly midline and the chest between the
  // forelegs, plus all four feet. Kept tight — the first pass let it climb the
  // flanks and the whole lower body went pink.
  paintMask(bodyGeo, CREAM, (p, n) => {
    const belly =
      smoothstep(-0.12, -0.6, n.y) *
      smoothstep(0.114, 0.094, p.y) *
      smoothstep(0.072, 0.054, Math.abs(p.x));
    // Chest patch between the forelegs.
    const chest =
      smoothstep(0.35, 0.7, n.z) *
      smoothstep(0.126, 0.098, p.y) *
      smoothstep(0.048, 0.08, p.z) *
      smoothstep(0.066, 0.044, Math.abs(p.x));
    // Feet.
    const hind =
      smoothstep(0.046, 0.036, p.y) *
      smoothstep(0.058, 0.072, Math.abs(p.x)) *
      smoothstep(-0.155, -0.135, p.z) * smoothstep(-0.022, -0.042, p.z);
    const fore = smoothstep(0.044, 0.034, p.y) * smoothstep(0.098, 0.112, p.z);
    return Math.max(Math.max(belly, chest), Math.max(hind, fore));
  });
  rig.body.add(body);

  /* ---- Head ----------------------------------------------------------- */
  rig.head.position.set(0, 0.205, 0.150);
  // The head must read big against the body — it carries the character.
  rig.head.scale.setScalar(1.06);

  const headBalls: Ball[] = [
    // Skull, slightly wider than tall.
    { x: 0, y: 0.004, z: -0.006, r: 0.068, sx: 1.06, sy: 0.92, sz: 1.0 },
    // Back of skull.
    { x: 0, y: 0.006, z: -0.030, r: 0.056, sx: 1.0, sy: 0.9 },
    // Cheek masses.
    { x: 0.046, y: -0.020, z: 0.012, r: 0.046, sy: 0.86 },
    { x: -0.046, y: -0.020, z: 0.012, r: 0.046, sy: 0.86 },
    // Muzzle: forward, blunt, barely dropped — the first passes drooped and
    // the profile read as a snipe nose.
    { x: 0, y: -0.010, z: 0.050, r: 0.050, sx: 0.92, sy: 0.78, sz: 0.95 },
    { x: 0, y: -0.016, z: 0.084, r: 0.038, sx: 0.78, sy: 0.68, sz: 0.9 },
    // Brow ridges — subtle; the big ones read as a lumpy forehead.
    { x: 0.030, y: 0.032, z: 0.050, r: 0.015, sx: 1.05, sy: 0.45, sz: 0.8 },
    { x: -0.030, y: 0.032, z: 0.050, r: 0.015, sx: 1.05, sy: 0.45, sz: 0.8 },
    // Lower jaw, receded so the incisors overhang it.
    { x: 0, y: -0.058, z: 0.038, r: 0.028, sx: 0.85, sy: 0.55, sz: 1.05 },
  ];
  // Eye sockets: wide, moderate carves so the big eyes seat into the skull.
  for (const s of [1, -1]) {
    headBalls.push({
      x: s * 0.040, y: 0.012, z: 0.048, r: 0.040, sx: 1.05, sy: 0.92, sz: 1.35,
      strength: -0.30,
    });
  }
  // The open mouth: a wedge bitten out of the muzzle's underside, wide enough
  // to read as an open mouth rather than a puncture.
  headBalls.push({ x: 0, y: -0.054, z: 0.088, r: 0.050, sx: 1.25, sy: 0.95, sz: 1.05, strength: -1.0 });

  const headGeo = metaSurface(headBalls, { resolution: 52, smooth: 0.94, padding: 0.035 });
  const headMesh = new THREE.Mesh(headGeo, skin);
  finishBody(headMesh, new THREE.Vector3(0, 0, -0.005), 0.14);

  // Cream lower face: one continuous field over the muzzle sides, chin, jaw
  // and lower cheeks. The purple/cream boundary starts just under the nose at
  // the front and climbs across the cheek with a three-lobed scallop — the
  // signature cheek line.
  paintMask(headGeo, CREAM, (p) => {
    const theta = Math.atan2(p.x, p.z); // 0 dead ahead, ± toward the cheeks
    const a = Math.abs(theta);
    // Throat and underside of the jaw are always cream.
    if (p.y < -0.050) return 1;
    if (a > 2.1) return 0; // back of skull stays purple
    const cheek = smoothstep(0.30, 0.85, a) * (1 - smoothstep(1.5, 2.05, a));
    const scallop = 0.010 * Math.cos((a - 0.55) * 5.5) * cheek;
    const yb = -0.008 + 0.014 * cheek + scallop;
    return smoothstep(yb + 0.003, yb - 0.005, p.y);
  });
  rig.head.add(headMesh);

  // Skull plug so the socket carves can never open a see-through tunnel.
  const plugGeo = new THREE.SphereGeometry(0.052, 16, 12);
  plugGeo.scale(1.1, 0.95, 1.05);
  plugGeo.deleteAttribute('uv');
  const plug = new THREE.Mesh(paintFlat(plugGeo, 0.9), skin);
  plug.position.set(0, 0.0, -0.005);
  plug.castShadow = false;
  plug.receiveShadow = false;
  rig.head.add(plug);

  /* ---- Eyes ----------------------------------------------------------- */
  // Huge, slanted, red. Sclera stays a thin white margin; the red iris owns
  // the eye, with a fat dark pupil and one crisp catchlight. Unlit materials
  // for iris and pupil so the colour reads as drawn rather than as glass.
  const EYE_R = 0.0305;
  const SPLAY = 0.58;
  const scleraMat = new THREE.MeshStandardMaterial({ color: 0xf2ede4, roughness: 0.45 });
  const irisMat = new THREE.MeshBasicMaterial({ color: 0xc32330 });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x1a0d10 });
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const eyeDir = (s: number): THREE.Vector3 =>
    new THREE.Vector3(Math.sin(s * SPLAY), 0.10, Math.cos(s * SPLAY)).normalize();

  for (const s of [1, -1]) {
    const d = eyeDir(s);
    const seat = onSkull(headMesh, d);

    const holder = new THREE.Group();
    holder.position.copy(seat.clone().addScaledVector(d, -EYE_R * 0.58));
    holder.rotation.y = s * SPLAY;
    // The angry slant: outer corner up, inner corner down.
    holder.rotation.z = s * -0.28;
    holder.scale.y = 0.94;
    rig.head.add(holder);

    const eye = new THREE.Group();
    eye.name = 'Eye';
    holder.add(eye);

    const sclera = new THREE.Mesh(new THREE.SphereGeometry(EYE_R, 20, 14), scleraMat);
    eye.add(sclera);

    const iris = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.006, 22, 14, 0, Math.PI * 2, 0, Math.asin(0.995)),
      irisMat,
    );
    iris.rotation.x = Math.PI / 2;
    eye.add(iris);

    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.014, 18, 12, 0, Math.PI * 2, 0, Math.asin(0.4)),
      pupilMat,
    );
    pupil.rotation.x = Math.PI / 2;
    eye.add(pupil);

    const glint = new THREE.Mesh(new THREE.SphereGeometry(EYE_R * 0.16, 10, 8), glintMat);
    glint.position.set(-EYE_R * 0.3, EYE_R * 0.34, EYE_R * 0.9);
    eye.add(glint);

    eye.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });

    // Static angry upper lid: a skin cap rolled forward so it cuts the top of
    // the eye on a slant toward the nose.
    const lidGeo = new THREE.SphereGeometry(EYE_R * 1.06, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.24);
    lidGeo.deleteAttribute('uv');
    const angryLid = new THREE.Mesh(paintFlat(lidGeo, 0.92), skin);
    angryLid.rotation.x = -0.26;
    angryLid.rotation.z = s * 0.46;
    angryLid.castShadow = false;
    holder.add(angryLid);

    // Blink lid, just inside the sclera.
    const blinkGeo = new THREE.SphereGeometry(EYE_R * 0.995, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    blinkGeo.scale(1.0, 1.2, 1.0);
    blinkGeo.deleteAttribute('uv');
    const blink = new THREE.Mesh(paintFlat(blinkGeo, 1.0), skin);
    blink.scale.y = 0;
    blink.castShadow = false;
    holder.add(blink);

    rig.eyes.push(eye);
    rig.eyelids.push(blink);
  }

  /* ---- Mouth interior, teeth, nose ------------------------------------ */
  // Dark interior behind the carved opening.
  const interior = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mouthMat);
  interior.scale.set(0.022, 0.023, 0.026);
  interior.position.set(0, -0.048, 0.056);
  interior.castShadow = false;
  rig.head.add(interior);

  // Tongue: a pink pad low in the opening.
  const tongueMat = new THREE.MeshStandardMaterial({ color: 0xc0566a, roughness: 0.55 });
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), tongueMat);
  tongue.scale.set(0.013, 0.006, 0.016);
  tongue.position.set(0, -0.065, 0.070);
  tongue.castShadow = false;
  rig.head.add(tongue);

  // The incisors: two big square white teeth hanging from the upper lip,
  // overhanging the receded lower jaw. They sit flush against each other so
  // the pair reads as one notched white block — separated they read as fangs.
  const toothGeo = roundedBox(0.019, 0.034, 0.012, 0.0038, 3);
  const lipDir = new THREE.Vector3(0, -0.45, 1).normalize();
  const lip = onSkull(headMesh, lipDir);
  for (const s of [1, -1]) {
    const tooth = new THREE.Mesh(toothGeo, toothMat);
    tooth.position.set(s * 0.0093, lip.y - 0.012, lip.z - 0.0015);
    tooth.rotation.x = 0.10;
    tooth.castShadow = true;
    rig.head.add(tooth);
  }

  // Nose: small pink-mauve bead at the muzzle tip.
  const noseDir = new THREE.Vector3(0, -0.12, 1).normalize();
  const noseSeat = onSkull(headMesh, noseDir);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.0098, 12, 9), noseMat);
  nose.scale.set(1.3, 0.85, 0.7);
  nose.position.copy(noseSeat).addScaledVector(noseDir, -0.001);
  nose.castShadow = false;
  rig.head.add(nose);

  /* ---- Whiskers -------------------------------------------------------- */
  // Cream spikes: one long sweep back past the shoulder per side, one short
  // spike angled up-forward above the nose per side.
  for (const s of [1, -1]) {
    // Long sweep: rooted low on the muzzle side, at whisker height, curving
    // back past the shoulder with a slight droop.
    const rootDir = new THREE.Vector3(s * 0.62, -0.42, 0.66).normalize();
    const root = onSkull(headMesh, rootDir).addScaledVector(rootDir, -0.004);
    const long = new THREE.Mesh(
      whiskerGeometry(
        [
          root,
          root.clone().add(new THREE.Vector3(s * 0.075, 0.004, -0.035)),
          root.clone().add(new THREE.Vector3(s * 0.14, -0.010, -0.10)),
          root.clone().add(new THREE.Vector3(s * 0.185, -0.042, -0.175)),
        ],
        0.0021,
        0.1,
      ),
      creamMat,
    );
    long.castShadow = false;
    rig.head.add(long);

    // Short spike above the nose, angled outward and up so it clears the
    // muzzle instead of crossing it.
    const upDir = new THREE.Vector3(s * 0.34, 0.10, 1).normalize();
    const upRoot = onSkull(headMesh, upDir).addScaledVector(upDir, -0.003);
    const short = new THREE.Mesh(
      whiskerGeometry(
        [
          upRoot,
          upRoot.clone().add(new THREE.Vector3(s * 0.024, 0.016, 0.022)),
          upRoot.clone().add(new THREE.Vector3(s * 0.052, 0.034, 0.036)),
        ],
        0.0016,
        0.1,
      ),
      creamMat,
    );
    short.castShadow = false;
    rig.head.add(short);
  }

  /* ---- Ears ------------------------------------------------------------ */
  // Big, round-based, softly pointed, standing up and slightly back. Inner
  // ear is a cream dish set just proud of the front face.
  // Inner ear is PAINTED onto the shell's front face rather than built as a
  // separate dish — a dish always finds an angle to poke through the shell.
  const earGeo = paintFlat(earGeometry(0.047, 0.115, 0.015), 1.0);
  paintMask(earGeo, CREAM, (p, n) => {
    if (n.z < 0.25) return 0;
    const du = p.x / 0.030;
    const dv = (p.y - 0.052) / 0.048;
    const d = Math.sqrt(du * du + dv * dv);
    return smoothstep(1.0, 0.82, d);
  });
  const ears: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.047, 0.046, -0.010);
    // Standing up, tipped only slightly back and out — the first pass flopped
    // them sideways like leaves.
    g.rotation.set(-0.14, s * 0.40, s * -0.14);
    const outer = new THREE.Mesh(earGeo, skin);
    outer.castShadow = true;
    g.add(outer);
    rig.head.add(g);
    ears.push(g);
  }

  /* ---- Tail ------------------------------------------------------------ */
  // Long, thin, rising in a wave and curling into a spiral at the tip.
  const tail = new THREE.Group();
  tail.position.set(0, 0.150, -0.195);
  tail.rotation.y = 0.22;
  rig.body.add(tail);
  rig.tail = tail;

  const tailPts: THREE.Vector3[] = [];
  // Rising sweep with a slight S.
  const sweep = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0.050, -0.055),
    new THREE.Vector3(0, 0.090, -0.125),
    new THREE.Vector3(0, 0.175, -0.150),
    new THREE.Vector3(0, 0.235, -0.135),
  ];
  tailPts.push(...sweep);
  // Spiral tip, in the sagittal plane, curling forward like a 6.
  const cy = 0.280;
  const cz = -0.105;
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const a = -Math.PI * 0.5 + t * Math.PI * 1.75;
    const R = 0.060 * (1 - 0.5 * t);
    tailPts.push(new THREE.Vector3(0, cy + R * Math.sin(a), cz + R * Math.cos(a)));
  }
  const tailCurve = new THREE.CatmullRomCurve3(tailPts);
  const tailGeo = new THREE.TubeGeometry(tailCurve, 44, 0.016, 8, false);
  taperTube(tailGeo, tailCurve, 45, 9, 1.0, 0.4, (t) => t * t * (3 - 2 * t));
  tailGeo.deleteAttribute('uv');
  const tailMesh = finishBody(new THREE.Mesh(tailGeo, skin), new THREE.Vector3(0, 0.1, -0.08), 0.16);
  tail.add(tailMesh);

  // Root cap so the open tube end never shows.
  const tailCap = new THREE.Mesh(paintFlat(new THREE.SphereGeometry(0.015, 12, 9), 0.96), skin);
  tailCap.castShadow = true;
  tail.add(tailCap);
  // Tip cap.
  const tipCap = new THREE.Mesh(paintFlat(new THREE.SphereGeometry(0.0062, 10, 8), 1.0), skin);
  tipCap.position.copy(tailPts[tailPts.length - 1]);
  tipCap.castShadow = false;
  tail.add(tipCap);

  /* ---- Performance ----------------------------------------------------- */
  const anim = new IdleAnimator(rig, 19);
  let attention = 0;

  return {
    id: 'rattata',
    name: 'Rattata',
    group: rig.root,
    get attention() {
      return attention;
    },
    set attention(v: number) {
      attention = clamp(v, 0, 1);
    },
    update(dt, elapsed) {
      anim.update(dt, elapsed, attention);
      for (const lid of rig.eyelids) lid.visible = lid.scale.y > 0.02;
      // Tail sway, and a nervous quiver at the tip frequency.
      tail.rotation.y = 0.22 + Math.sin(elapsed * 1.1) * (0.10 + attention * 0.1);
      tail.rotation.x = Math.sin(elapsed * 1.7 + 0.8) * 0.05;
      // Ear micro-twitches.
      for (let i = 0; i < ears.length; i++) {
        const s = i === 0 ? 1 : -1;
        ears[i].rotation.z = s * -0.30 + Math.sin(elapsed * 2.3 + i * 2.1) * 0.03;
      }
    },
    celebrate: () => anim.celebrate(),
    dispose: () => disposeCreature(rig.root),
  };
}
