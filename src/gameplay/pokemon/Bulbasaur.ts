import * as THREE from 'three';
import { metaSurface, noiseDisplace, bakeCavityAO, type Ball } from '../../fx/Sculpt';
import { creatureSkin } from '../../fx/CreatureMaterials';
import { clamp, smoothstep, Simplex } from '../../core/Noise';
import { createRig, IdleAnimator, finishBody, disposeCreature, type Creature } from './shared';

/**
 * Bulbasaur — a squat quadruped with a tall onion bulb rooted into its back.
 *
 * Proportions are matched against the Pokemon HOME 3D render: the animal is
 * LOW — belly slung close to the ground on stubby legs — with a head nearly as
 * wide as the ribcage, and the bulb is the tallest thing in the silhouette,
 * a pointed garlic-dome rising well above the head line.
 *
 * Three things carry the identity: the big red eyes (red iris filling the eye,
 * fat black pupil, white sclera at the inner corner), the crisp dark dapples,
 * and the bulb. Each is treated as a first-class modelling problem.
 */

/* ------------------------------------------------------------------ */
/* Local sculpting helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Vertex colours are the only channel a marching-cubes surface has — it comes
 * out of the mesher with no UVs, so markings have to be painted into the mesh
 * itself. Any geometry that shares the skin material therefore needs a colour
 * attribute, or the driver hands the shader an undefined attribute and the
 * part renders black.
 */
function ensureVertexColor(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geo.attributes.color) {
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  return geo;
}

function fbm3(s: Simplex, x: number, y: number, z: number, octaves = 3): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * s.noise3D(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

/**
 * One marking, defined as a *projected* ellipse rather than a solid.
 *
 * An ellipsoid of pigment in model space does not work on a metaball body:
 * the Wyvill iso crosses well outside the nominal ball radii, so a hand-placed
 * solid is usually buried entirely inside the skin and paints nothing.
 * Projecting removes the radial axis from the test: a flank spot is a disc in
 * (y, z) extended along x, gated by the surface normal so it lands only on the
 * side it belongs to.
 */
interface Spot {
  axis: 'x' | 'y' | 'z';
  /** Direction along that axis the marked surface faces: +1 or -1. */
  face: number;
  /** Centre in the two coordinates the ellipse is measured in. */
  u: number;
  v: number;
  ru: number;
  rv: number;
}

/**
 * Paints the spots. Bulbasaur's dapples are *drawn* shapes: a countable number
 * of large dark ellipses in specific places, with crisp edges — so they are
 * authored as an explicit list and only edge-warped slightly by noise.
 */
function paintSpots(
  geo: THREE.BufferGeometry,
  spots: Spot[],
  tint: [number, number, number],
  opts: { seed: number; warp?: number; feather?: number; belly?: [number, number, number] },
): void {
  ensureVertexColor(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const s = new Simplex(opts.seed);
  const warp = opts.warp ?? 0.005;
  // Where the falloff starts, as a fraction of the ellipse radius. High value
  // = crisp edge. The HOME model's patches are near-hard-edged.
  const feather = opts.feather ?? 0.88;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);

    const w0 = fbm3(s, x * 11 + 3.1, y * 11 - 1.7, z * 11 + 6.4, 2) * warp;
    const w1 = fbm3(s, x * 11 - 5.2, y * 11 + 2.3, z * 11 - 0.9, 2) * warp;

    let mask = 0;
    for (const sp of spots) {
      // Near-binary facing gate. A wide gradient here smears every patch into
      // a washy streak wherever the surface curves; the HOME patches are FLAT
      // stencils, so the gate is a cut, not a ramp.
      const facing = sp.axis === 'x'
        ? smoothstep(0.0, 0.14, nx * sp.face)
        : sp.axis === 'y'
          ? smoothstep(0.0, 0.16, ny * sp.face)
          : smoothstep(-0.06, 0.08, nz * sp.face);
      if (facing <= 0) continue;
      const du = ((sp.axis === 'x' ? y : x) + w0 - sp.u) / sp.ru;
      const dv = ((sp.axis === 'z' ? y : z) + w1 - sp.v) / sp.rv;
      const d = Math.sqrt(du * du + dv * dv);
      if (d >= 1) continue;
      mask = Math.max(mask, smoothstep(1.0, feather, d) * facing);
    }
    // Harden the combined mask: whatever gradient survives the gates becomes
    // a crisp edge instead of a fade.
    mask = smoothstep(0.14, 0.68, mask);
    // Nothing on the underside: the belly is the pale countershaded surface.
    mask *= smoothstep(-0.62, -0.20, ny);

    let r = col.getX(i);
    let g = col.getY(i);
    let b = col.getZ(i);
    if (opts.belly) {
      const belly = smoothstep(-0.18, -0.75, ny);
      r *= 1 + (opts.belly[0] - 1) * belly;
      g *= 1 + (opts.belly[1] - 1) * belly;
      b *= 1 + (opts.belly[2] - 1) * belly;
    }
    r *= 1 + (tint[0] - 1) * mask;
    g *= 1 + (tint[1] - 1) * mask;
    b *= 1 + (tint[2] - 1) * mask;
    col.setXYZ(i, r, g, b);
  }
  col.needsUpdate = true;
}

/** Mirrors a set of side spots onto both flanks. */
function bothSides(spots: Omit<Spot, 'axis' | 'face'>[]): Spot[] {
  return spots.flatMap((s) => [
    { ...s, axis: 'x' as const, face: 1 },
    { ...s, axis: 'x' as const, face: -1 },
  ]);
}

/**
 * Darkens a collar of skin around the bulb's foot — the ring of shadow in the
 * seam is what the eye reads as "this grows out of there".
 */
function paintCollar(
  geo: THREE.BufferGeometry,
  cx: number,
  cz: number,
  inner: number,
  outer: number,
  amount: number,
): void {
  ensureVertexColor(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx;
    const dz = pos.getZ(i) - cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > outer) continue;
    const up = smoothstep(0.05, 0.55, nor.getY(i));
    const k = 1 - amount * smoothstep(outer, inner, d) * up;
    if (k < 1) col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
}

/**
 * The bulb: a tall onion/garlic dome built as a lathe.
 *
 * This is the signature element and the previous metaball/scale approach kept
 * collapsing into either a cabbage or a helmet. A lathe profile gives direct
 * authorship of the silhouette: fat shoulders low down, a long concave ogee
 * up to a distinct pointed tip. Garlic-clove character comes from four soft
 * crease valleys converging on the tip, and a slight sideways lean at the very
 * top so the point reads organic rather than machined.
 */
function onionBulbGeometry(R: number, H: number): THREE.BufferGeometry {
  // Silhouette profile, foot (t=0) to tip (t=1).
  const profile = (t: number): number => {
    // Rounded belly that peaks around a third of the way up. The foot pulls
    // IN — a flared foot leaves the bulb's widest edge hovering above the
    // back with a shadow slot underneath, and it reads as a dollop.
    const belly = Math.sin(Math.PI * (0.28 + t * 0.72)) ** 0.9;
    // ...crossfaded into a concave taper that pulls in to the point.
    const taper = Math.pow(1 - t, 1.55);
    const k = smoothstep(0.30, 0.85, t);
    let r = belly * (1 - k) + taper * 1.05 * k;
    // Keep a slender neck just under the tip so the point is a point.
    return Math.max(r, 0.02);
  };

  const SEG_U = 48; // around
  const SEG_V = 40; // along
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= SEG_V; i++) {
    const t = i / SEG_V;
    pts.push(new THREE.Vector2(Math.max(0.001, R * profile(t)), t * H));
  }
  const geo = new THREE.LatheGeometry(pts, SEG_U);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const colors = new Float32Array(n * 3);

  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const t = clamp(v.y / H, 0, 1);
    const theta = Math.atan2(v.z, v.x);
    // Three distinct clove creases: narrow Gaussian valleys pinched into the
    // surface, converging toward the tip. A uniform lobed pinch reads as a
    // smooth kiss; a few separated valleys read as garlic.
    const creaseWindow = smoothstep(0.04, 0.20, t) * (1 - smoothstep(0.62, 0.86, t));
    let valley = 0;
    for (const ca of [0.9, 3.0, 5.1]) {
      let d = Math.abs(theta - ca);
      d = Math.min(d, Math.PI * 2 - d);
      valley = Math.max(valley, Math.exp(-((d / 0.24) ** 2)));
    }
    const pinch = 1 - 0.095 * valley * creaseWindow;
    v.x *= pinch;
    v.z *= pinch;
    // Lean the top of the dome slightly so the tip curls off-axis.
    const lean = smoothstep(0.55, 1.0, t);
    v.x += R * 0.09 * lean * lean;
    v.z -= R * 0.06 * lean * lean;
    pos.setXYZ(i, v.x, v.y, v.z);

    // Vertex colour: crease valleys darker, tip slightly lighter, foot darker.
    let c = 1 - 0.20 * valley * creaseWindow;
    c *= 0.92 + 0.08 * smoothstep(0.0, 0.5, t);
    colors[i * 3] = c;
    colors[i * 3 + 1] = c;
    colors[i * 3 + 2] = c;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  noiseDisplace(geo, 0.0010, 9, 47, 2);
  geo.computeVertexNormals();
  return geo;
}

/**
 * One base wrap leaf: a FLAT, wide, gently-curved triangular blade. It hugs
 * the bulb's lower flank (cupped across its width to wrap the dome, bowed
 * along its length to follow the dome's taper) and its tip peels slightly
 * outward. Built as a squashed lens so the edge has a whisper of thickness —
 * but the thickness stays a fraction of the width everywhere, so no view can
 * read it as a tube or a pipe.
 * Local space: length along +y from root, width on x, outward on +z.
 */
function wrapLeafGeometry(halfW: number, len: number, thick: number, domeR: number): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 20, 12);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const u = clamp((v.y + 1) / 2, 0, 1); // 0 root, 1 tip
    // Normalise the sphere's circular cross-section to a unit square so the
    // plan shape is authored directly.
    const s = Math.max(1e-3, Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)));
    const ux = v.x / s; // -1..1 across the width
    const uz = v.z / s; // -1..1 through the thickness
    // Triangular plan: full width across the root third, tapering to a point.
    const w = halfW * (1 - 0.96 * smoothstep(0.16, 0.98, u));
    // Thin. Fades to a soft edge at the rim and tapers toward the tip.
    const th = thick * (1 - 0.55 * u) * (1 - 0.72 * ux * ux) * s;
    const x = ux * w;
    // Cup across the width so the blade wraps the dome's circumference...
    const cup = -(x * x) / (2 * domeR);
    // ...bow gently inward along the length to sit against the dome...
    const hug = -0.12 * len * u * u;
    // ...and ease the tip outward-down, a droop rather than a flick.
    const peel = 0.20 * len * smoothstep(0.35, 1.0, u) ** 2;
    pos.setXYZ(i, x, u * len, uz * th + cup + hug + peel);
  }
  geo.computeVertexNormals();
  return ensureVertexColor(geo);
}

/**
 * Bulbasaur's eye, built as a layered 3D eyeball.
 *
 * The official design: a tall rounded-triangle eye, dark outline, red iris
 * filling most of the aperture, a fat black pupil, one white catchlight, and
 * a sliver of white sclera at the INNER corner. Layered spherical caps give
 * exactly that: dark base sphere (reads as the drawn outline ring), white
 * sclera cap, red iris cap tilted toward the outer corner (which uncovers the
 * white on the inner side), black pupil cap concentric with the iris.
 *
 * Everything is MeshBasic: a lit iris at this scale speckles under the normal
 * map + env probe and reads bloodshot. Unlit flats are how the character is
 * drawn, and how the HOME model is toon-shaded.
 */
function bulbaEye(r: number, sgn: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'Eye';

  const cap = (radius: number, theta: number, color: number, tiltX: number, tiltY: number) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 28, 16, 0, Math.PI * 2, 0, theta),
      new THREE.MeshBasicMaterial({ color }),
    );
    m.rotation.order = 'YXZ';
    m.rotation.x = Math.PI / 2 + tiltX;
    m.rotation.y = tiltY;
    return m;
  };

  // Base: the dark outline. Whatever the socket rim doesn't cover of this
  // sphere reads as the drawn contour around the eye.
  const outline = new THREE.Mesh(
    new THREE.SphereGeometry(r, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x10262a }),
  );
  g.add(outline);

  // Sclera: white, kept BARELY wider than the iris. Off-axis views (the
  // three-quarter camera, the idle head yaw) parallax the layers apart, and
  // whatever margin the sclera has beyond the iris smears into a white band
  // on the near edge; a tight sclera means those angles reveal the dark
  // outline instead, which is how the character is drawn.
  g.add(cap(r * 1.012, 1.17, 0xf4fbfa, 0.06, -sgn * 0.10));
  // Iris: red, filling most of the aperture, shifted a touch toward the OUTER
  // corner so the white peeks through only as a wedge at the INNER corner.
  // Tilt signs are EMPIRICAL, verified against renders: with this cap setup a
  // negative tiltX raises the iris and -sgn*tiltY pushes it outward. (Two
  // earlier rounds argued the algebra both ways and shipped a sleepy eye and
  // an outer-white eye; trust the screenshots, not the rotation-order proof.)
  // The iris is nearly as wide as the sclera: the visible white margin is
  // what off-axis views smear into a white band, so it is kept to a sliver
  // everywhere except the inner corner, where the tilt overshoot opens it
  // into the drawn white wedge.
  g.add(cap(r * 1.026, 1.15, 0xb0202c, 0.06, -sgn * 0.28));
  // Pupil: fat and black, concentric with the iris.
  g.add(cap(r * 1.040, 0.62, 0x0d0a10, 0.06, -sgn * 0.28));

  // One catchlight, on the upper edge of the pupil. Crisp and small.
  const hi = new THREE.Mesh(
    new THREE.SphereGeometry(r * 0.14, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  const hiDir = new THREE.Vector3(sgn * 0.20, 0.36, 0.91).normalize().multiplyScalar(r * 1.055);
  hi.position.copy(hiDir);
  g.add(hi);

  g.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });
  return g;
}

/**
 * The mouth line: a tube that tapers to nothing at both ends, so the corners
 * tuck into the cheeks instead of ending in beads.
 */
function mouthLineGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  radius: number,
  rings = 26,
  radial = 6,
): THREE.BufferGeometry {
  const geo = new THREE.TubeGeometry(curve, rings, radius, radial, false);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const perRing = radial + 1;
  const c = new THREE.Vector3();
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const s = Math.pow(Math.sin(Math.PI * t), 0.42);
    curve.getPoint(t, c);
    for (let j = 0; j < perRing; j++) {
      const k = i * perRing + j;
      if (k >= pos.count) break;
      pos.setXYZ(
        k,
        c.x + (pos.getX(k) - c.x) * s,
        c.y + (pos.getY(k) - c.y) * s,
        c.z + (pos.getZ(k) - c.z) * s,
      );
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * The open mouth: a shallow pink interior hung below the smile line.
 *
 * Built as a grid strip. Columns follow the smile curve; rows drop from the
 * upper lip toward the chin, widest mid-mouth so the opening is a smiling
 * lens, not a letterbox. Every vertex is re-seated against the sculpted skin
 * (frontSurfaceZ) and bowed slightly INTO the head, so the pink reads as a
 * cavity and the lower edge tucks under the surface instead of floating.
 */
function mouthInteriorGeometry(
  upper: THREE.Vector3[],
  headGeo: THREE.BufferGeometry,
  drop: number,
  recess: number,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(upper, false, 'catmullrom', 0.5);
  const COLS = 28;
  const ROWS = 6;
  const positions = new Float32Array((COLS + 1) * (ROWS + 1) * 3);
  const colors = new Float32Array((COLS + 1) * (ROWS + 1) * 3);
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (let c = 0; c <= COLS; c++) {
    const t = c / COLS;
    curve.getPoint(t, p);
    // How far this column opens: a thin CRESCENT. Height peaks mid-mouth and
    // tapers to zero well BEFORE the corners (pink spans ~72% of the smile),
    // and the peak is small, so the lower edge stays a near-parallel curve to
    // the smile line instead of a bulging tongue-like blob.
    const u = Math.min(Math.max((t - 0.12) / 0.76, 0), 1);
    const span = Math.pow(Math.sin(Math.PI * u), 0.7);
    for (let r = 0; r <= ROWS; r++) {
      const f = r / ROWS;
      const k = (c * (ROWS + 1) + r) * 3;
      const x = p.x * (1 - 0.05 * f);
      // Top row starts a hair BELOW the lip-line centre: the strip is
      // recessed, and a slightly raised camera projects recessed points
      // upward — without this bias the bright rows peek above the dark line.
      const y = p.y - 0.0028 - drop * span * f;
      // Small eps: a wide search ring reads the frontmost vertex of the
      // UNCARVED rim and re-floats the strip proud of the pocket.
      const zs = frontSurfaceZ(headGeo, x, y, 0.012);
      const zSurf = Number.isFinite(zs) ? zs : p.z;
      // The skin under the opening is CARVED (negative pocket balls below the
      // lip line). The strip takes whichever is deeper: a floor recessed
      // behind the LIP LINE (never proud of it), or a skim just above the
      // local carved skin — and tucks under the skin at its own boundary
      // (lower edge, corners) so no pink leaks past the ends of the lip line.
      const edge = smoothstep(0.78, 1.0, f);
      const pocket = (0.0030 + 0.0055 * Math.sin(Math.PI * f)) * (0.35 + 0.65 * span);
      const zRecessed = p.z - pocket;
      const zSkim = zSurf + recess * (1 - edge);
      positions[k] = x;
      positions[k + 1] = y;
      positions[k + 2] = Math.min(zRecessed, zSkim)
        - edge * 0.0040
        - (1 - span) * 0.003;
      // Cavity shading baked into vertex colour: a dark shadowed sliver just
      // under the upper lip, opening out to the lit mouth floor below, and
      // fading back to dark where the opening closes at the corners.
      const lit = smoothstep(0.03, 0.28, f);
      const cornerFade = smoothstep(0.05, 0.30, span);
      const shade = 1 - Math.max(0.10 + 0.58 * (1 - lit), 0.60 * (1 - cornerFade));
      colors[k] = shade;
      colors[k + 1] = shade;
      colors[k + 2] = shade;
    }
  }
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const a = c * (ROWS + 1) + r;
      const b = a + ROWS + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Finds the frontmost point of a sculpted surface near a given (x, y), so face
 * details land on the *meshed* skin rather than on guessed coordinates (the
 * Wyvill iso crosses far outside the nominal ball radii wherever balls blend).
 */
function frontSurfaceZ(geo: THREE.BufferGeometry, x: number, y: number, eps: number): number {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  let best = -Infinity;
  const e2 = eps * eps;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - x;
    const dy = pos.getY(i) - y;
    if (dx * dx + dy * dy > e2) continue;
    const z = pos.getZ(i);
    if (z > best) best = z;
  }
  return best;
}

/** A small smooth claw: a teardrop with a rounded root and a real point. */
function clawGeometry(radius: number, length: number): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, 8, 6);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / radius; // -1..1
    const t = clamp((y + 1) / 2, 0, 1);
    const s = Math.pow(1 - t, 0.62);
    pos.setXYZ(i, pos.getX(i) * s, (y * 0.5 + 0.5) * length, pos.getZ(i) * s);
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildBulbasaur(): Creature {
  const rig = createRig();
  rig.root.name = 'Bulbasaur';

  // Pastel-leaning blue-green turquoise. The wrapped-diffuse term, sky fill
  // and env probe lift the render above the albedo, but the HOME body is a
  // genuinely LIGHT pastel — so the albedo starts brighter and a touch less
  // saturated than a pure teal.
  const SKIN = 0x26897b;
  const SKIN_SUB = 0x186a5f;

  const skin = creatureSkin({
    color: SKIN,
    subsurface: SKIN_SUB,
    wrap: 0.11,
    rim: 0.05,
    roughness: 1.0,
    detail: 'pores',
    detailScale: 5,
  });
  skin.clearcoat = 0.03;
  skin.clearcoatRoughness = 0.75;
  skin.sheen = 0.04;
  skin.sheenColor = new THREE.Color(SKIN_SUB).multiplyScalar(0.3);
  skin.normalScale.set(0.2, 0.2);
  skin.envMapIntensity = 0.22;
  skin.roughnessMap = null;
  skin.roughness = 0.88;

  // The spot tint: flat grey-green patches, clearly darker than the hide but
  // not black — the HOME patches sit about half a stop down from the skin.
  const SPOT: [number, number, number] = [0.42, 0.57, 0.60];
  const BELLY: [number, number, number] = [1.18, 1.10, 1.02];

  /* --- Body ---------------------------------------------------------- */
  // SQUAT. The HOME model's belly is slung close to the ground; leg length is
  // maybe a fifth of body height and the ribcage is wide.
  const LEGS = [
    { x: 0.128, z: 0.128 }, // fore
    { x: 0.142, z: -0.175 }, // hind
  ];
  const bodyBalls: Ball[] = [
    // Barrel: long on Z, wide, low.
    { x: 0, y: 0.196, z: -0.030, r: 0.148, sx: 1.02, sy: 0.82, sz: 1.32 },
    { x: 0, y: 0.198, z: 0.125, r: 0.112, sx: 1.00, sy: 0.90, sz: 0.94 },
    { x: 0, y: 0.212, z: 0.192, r: 0.080, sx: 0.92, sy: 0.86 },
    { x: 0, y: 0.192, z: -0.205, r: 0.126, sx: 1.00, sy: 0.96, sz: 0.94 },
    // Belly: low-slung.
    { x: 0, y: 0.150, z: -0.020, r: 0.088, sx: 0.96, sy: 0.52, sz: 1.16 },
    // Shoulders and haunches.
    { x: 0.122, y: 0.200, z: 0.110, r: 0.084, sx: 0.94, sy: 0.92, sz: 1.02 },
    { x: -0.122, y: 0.200, z: 0.110, r: 0.084, sx: 0.94, sy: 0.92, sz: 1.02 },
    { x: 0.138, y: 0.182, z: -0.172, r: 0.100, sx: 0.94, sy: 1.00, sz: 1.02 },
    { x: -0.138, y: 0.182, z: -0.172, r: 0.100, sx: 0.94, sy: 1.00, sz: 1.02 },
    // Back collar that swells up around the bulb's foot.
    { x: 0, y: 0.248, z: -0.075, r: 0.104, sx: 1.22, sy: 0.55, sz: 1.10 },
    { x: 0.058, y: 0.236, z: -0.070, r: 0.066 },
    { x: -0.058, y: 0.236, z: -0.070, r: 0.066 },
  ];
  for (const sgn of [1, -1]) {
    for (const leg of LEGS) {
      const x = sgn * leg.x;
      const lz = leg.z;
      // Stubby: upper leg, then a wide flat foot pad right at the ground.
      bodyBalls.push({ x, y: 0.118, z: lz, r: 0.072, sx: 0.94, sy: 0.92, sz: 0.98 });
      bodyBalls.push({ x, y: 0.066, z: lz, r: 0.062, sy: 0.90, sz: 0.98 });
      bodyBalls.push({ x, y: 0.040, z: lz + 0.010, r: 0.060, sx: 1.08, sy: 0.58, sz: 1.14 });
      // Three toes, splayed forward.
      for (const tx of [-0.034, 0, 0.034]) {
        bodyBalls.push({ x: x + tx, y: 0.036, z: lz + 0.052, r: 0.029, sx: 0.86, sy: 0.56, sz: 1.0 });
      }
      // Grooves between the toes.
      for (const gx of [-0.017, 0.017]) {
        bodyBalls.push({
          x: x + gx, y: 0.042, z: lz + 0.046, r: 0.026, sx: 0.50, sz: 2.2,
          strength: -0.92,
        });
      }
      // Carve the web between the pair of legs so the gap opens.
      bodyBalls.push({
        x: 0, y: 0.070, z: lz, r: 0.068, sx: 1.28, sy: 1.10, sz: 0.85,
        strength: -0.78,
      });
      bodyBalls.push({ x: 0, y: 0.105, z: lz, r: 0.054, sx: 1.05, sy: 0.9, sz: 0.9, strength: -0.30 });
    }
    // Waist hollow between shoulder and haunch — wide and weak.
    bodyBalls.push({ x: sgn * 0.140, y: 0.176, z: -0.026, r: 0.084, sx: 0.9, sz: 1.35, strength: -0.28 });
  }

  const bodyGeo = metaSurface(bodyBalls, { resolution: 54, smooth: 1.02, padding: 0.04 });
  const body = finishBody(new THREE.Mesh(bodyGeo, skin), new THREE.Vector3(0, 0.18, -0.01), 0.30);

  // The markings: countable, crisp, mirrored.
  // FEW and LARGE. A dozen small dots reads as polka-dot camouflage; the HOME
  // model has a handful of big irregular patches.
  const bodySpots: Spot[] = [
    ...bothSides([
      // Shoulder.
      { u: 0.230, v: 0.118, ru: 0.046, rv: 0.052 },
      // Mid flank, low.
      { u: 0.198, v: -0.040, ru: 0.044, rv: 0.054 },
      // Haunch — the big one.
      { u: 0.194, v: -0.194, ru: 0.054, rv: 0.062 },
    ]),
    // One mark per foreleg so the dead-ahead view isn't blank.
    { axis: 'z', face: 1, u: 0.130, v: 0.100, ru: 0.036, rv: 0.044 },
    { axis: 'z', face: 1, u: -0.130, v: 0.100, ru: 0.036, rv: 0.044 },
    // Back, flanking the bulb's collar, read from above.
    { axis: 'y', face: 1, u: 0.110, v: 0.005, ru: 0.042, rv: 0.052 },
    { axis: 'y', face: 1, u: -0.110, v: 0.005, ru: 0.042, rv: 0.052 },
    // Rump.
    { axis: 'y', face: 1, u: 0.060, v: -0.266, ru: 0.044, rv: 0.042 },
    { axis: 'y', face: 1, u: -0.060, v: -0.266, ru: 0.044, rv: 0.042 },
  ];
  paintSpots(bodyGeo, bodySpots, SPOT, { seed: 71, belly: BELLY, warp: 0.003, feather: 0.87 });
  paintCollar(bodyGeo, 0, -0.075, 0.108, 0.180, 0.28);
  rig.body.add(body);

  // Claws — three per foot, small, warm bone.
  const clawMat = new THREE.MeshPhysicalMaterial({
    color: 0xcfc8b4, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4,
  });
  const clawGeo = clawGeometry(0.0078, 0.021);
  for (const sgn of [1, -1]) {
    for (const leg of LEGS) {
      for (const tx of [-0.034, 0, 0.034]) {
        const claw = new THREE.Mesh(clawGeo, clawMat);
        claw.position.set(sgn * leg.x + tx, 0.026, leg.z + 0.076);
        claw.rotation.set(Math.PI * 0.62, 0, -tx * 5.0);
        claw.castShadow = true;
        rig.body.add(claw);
      }
    }
  }

  /* --- Head ---------------------------------------------------------- */
  // BIG. The HOME head is nearly as wide as the ribcage, wide-cheeked and
  // flat-topped, carried high so the crown clears the back line.
  rig.head.position.set(0, 0.292, 0.225);
  rig.head.scale.setScalar(1.0);

  // Eyes: large, high on the face, WIDE-SET — near the outer edges of the
  // wide skull, the way the HOME model places them.
  const eyeX = 0.064;
  const eyeY = 0.028;
  const eyeZ = 0.098;
  const headBalls: Ball[] = [
    // Skull: wide and flattened.
    { x: 0, y: 0.005, z: -0.005, r: 0.142, sx: 1.22, sy: 0.86, sz: 0.98 },
    // Broad smooth muzzle mass — wide and shallow, NO protruding snout.
    { x: 0, y: -0.040, z: 0.058, r: 0.088, sx: 1.24, sy: 0.66, sz: 0.78 },
    { x: 0, y: -0.068, z: 0.020, r: 0.072, sx: 1.10, sy: 0.56, sz: 0.95 },
    // Cheeks packed out under the eyes.
    { x: 0.098, y: -0.036, z: 0.045, r: 0.062, sx: 0.94, sy: 0.82, sz: 0.90 },
    { x: -0.098, y: -0.036, z: 0.045, r: 0.062, sx: 0.94, sy: 0.82, sz: 0.90 },
    { x: 0.062, y: -0.048, z: 0.082, r: 0.056, sx: 0.92, sy: 0.74, sz: 0.82 },
    { x: -0.062, y: -0.048, z: 0.082, r: 0.056, sx: 0.92, sy: 0.74, sz: 0.82 },
  ];

  // Ears: broad triangular flaps pointing up and slightly outward from the
  // top corners of the skull.
  for (const sgn of [1, -1]) {
    headBalls.push({ x: sgn * 0.082, y: 0.058, z: -0.018, r: 0.056, sx: 0.44, sy: 0.95, sz: 0.95 });
    headBalls.push({ x: sgn * 0.096, y: 0.108, z: -0.026, r: 0.042, sx: 0.36, sy: 0.95, sz: 0.72 });
    headBalls.push({ x: sgn * 0.107, y: 0.150, z: -0.032, r: 0.026, sx: 0.30, sy: 0.85, sz: 0.52 });
  }
  // Eye sockets: wide, tall, moderate strength — the eyeball sits down in
  // here so only a cap shows, flush with the skin.
  for (const sgn of [1, -1]) {
    headBalls.push({
      x: sgn * eyeX, y: eyeY + 0.002, z: eyeZ - 0.006, r: 0.056, sx: 1.02, sy: 1.10, sz: 1.50,
      strength: -0.32,
    });
  }
  // Mouth: one wide, shallow upcurve spanning most of the muzzle width.
  const smile: THREE.Vector3[] = [
    new THREE.Vector3(-0.108, 0.004, 0.066),
    new THREE.Vector3(-0.062, -0.030, 0.118),
    new THREE.Vector3(0, -0.044, 0.146),
    new THREE.Vector3(0.062, -0.030, 0.118),
    new THREE.Vector3(0.108, 0.004, 0.066),
  ];
  const smileCurve = new THREE.CatmullRomCurve3(smile, false, 'catmullrom', 0.5);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const p = smileCurve.getPoint(t);
    const taper = Math.pow(Math.sin(Math.PI * t), 0.4);
    headBalls.push({
      x: p.x, y: p.y, z: p.z, r: 0.026, sx: 0.9, sy: 0.30, sz: 0.9,
      strength: -0.18 * taper,
    });
  }
  // Carve the mouth POCKET: a second row of negative balls hung just below
  // the lip line, so the skin itself dips inward across the opening and the
  // pink interior can sit recessed BEHIND the lip instead of riding proud of
  // the muzzle like a pout.
  for (let i = 1; i < 10; i++) {
    const t = i / 10;
    const p = smileCurve.getPoint(t);
    const taper = Math.pow(Math.sin(Math.PI * t), 0.9);
    headBalls.push({
      x: p.x * 0.94, y: p.y - 0.020, z: p.z, r: 0.026, sx: 0.9, sy: 0.60, sz: 0.9,
      strength: -0.30 * taper,
    });
  }

  const headGeo = metaSurface(headBalls, { resolution: 46, smooth: 0.96, padding: 0.035 });
  const head = finishBody(new THREE.Mesh(headGeo, skin), new THREE.Vector3(0, 0, 0), 0.12);
  // Markings: forehead patch (a Bulbasaur signature), ear-inner shading, and
  // marks on the back of the skull.
  const headSpots: Spot[] = [
    // ONE forehead patch, offset like the artwork. A single z-projection with
    // its near-binary gate covers both the brow and the forward-curving crown
    // (their normals all carry +z); the old y-projected twin only smeared it.
    { axis: 'z', face: 1, u: 0.042, v: 0.072, ru: 0.034, rv: 0.032 },
    // Inner-ear shading: small, high on the flap so it stays off the skull.
    { axis: 'z', face: 1, u: 0.097, v: 0.132, ru: 0.020, rv: 0.030 },
    { axis: 'z', face: 1, u: -0.097, v: 0.132, ru: 0.020, rv: 0.030 },
    ...bothSides([
      { u: 0.028, v: -0.072, ru: 0.038, rv: 0.044 },
    ]),
  ];
  paintSpots(headGeo, headSpots, SPOT, { seed: 23, warp: 0.003, feather: 0.87 });
  rig.head.add(head);

  /* --- Mouth line ---------------------------------------------------- */
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x142521, roughness: 0.7 });
  const mouthCurve = new THREE.CatmullRomCurve3(
    smile.map((p) => {
      const zs = frontSurfaceZ(headGeo, p.x, p.y, 0.017);
      return new THREE.Vector3(p.x, p.y, Number.isFinite(zs) ? zs + 0.0015 : p.z);
    }),
    false, 'catmullrom', 0.5,
  );
  const mouth = new THREE.Mesh(mouthLineGeometry(mouthCurve, 0.0052, 24, 5), mouthMat);
  mouth.renderOrder = 1;
  rig.head.add(mouth);

  // The open smile: shallow pink interior hung below the lip line, as in the
  // HOME render. Kept subtle — a lens of pink, not a gaping jaw.
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0xb5666e,
    roughness: 0.85,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const inner = new THREE.Mesh(
    mouthInteriorGeometry(
      smile.map((p) => {
        const zs = frontSurfaceZ(headGeo, p.x, p.y, 0.017);
        return new THREE.Vector3(p.x, p.y, Number.isFinite(zs) ? zs : p.z);
      }),
      headGeo,
      0.016,
      0.0012,
    ),
    innerMat,
  );
  inner.castShadow = false;
  inner.receiveShadow = false;
  rig.head.add(inner);

  // Nostrils: two tiny dark SLITS, high above the mouth, well apart. A value,
  // not a form — no raised geometry anywhere near them.
  const nostrilMat = new THREE.MeshStandardMaterial({ color: 0x0e3a35, roughness: 0.9 });
  for (const sgn of [1, -1]) {
    const n = new THREE.Mesh(new THREE.SphereGeometry(0.0058, 8, 6), nostrilMat);
    const nx = sgn * 0.030;
    const ny = 0.070;
    const nzs = frontSurfaceZ(headGeo, nx, -0.005, 0.014);
    n.position.set(nx, -0.005, (Number.isFinite(nzs) ? nzs : 0.135) - 0.0010);
    n.scale.set(0.55, 1.5, 0.35);
    n.rotation.z = sgn * -0.45;
    void ny;
    rig.head.add(n);
  }

  /* --- Eyes ---------------------------------------------------------- */
  // Large — the eyes carry the character. Tall almond via holder scale, a
  // slight outward tilt of the long axis, seated in the sockets so the rim
  // overlaps the eyeball and the dark base sphere reads as the outline.
  const EYE_R = 0.0375;
  for (const sgn of [1, -1]) {
    const holder = new THREE.Group();
    // Seated shallow: a deeply recessed ball turns the socket into a porthole
    // and the visible cap slides around with view parallax (the capture runs
    // mid-idle-animation, so the head is rarely dead square to the camera).
    holder.position.set(sgn * eyeX, eyeY, eyeZ - EYE_R * 0.26);
    holder.rotation.y = sgn * 0.05;
    // Pitched up a touch: the vertical stretch plus the cheek cropping the
    // eye's lower half otherwise concentrates the white margin at the top.
    holder.rotation.x = -0.10;
    // Tall almond, top tilted slightly outward.
    holder.rotation.z = -sgn * 0.12;
    holder.scale.set(0.92, 1.22, 1);

    const eye = bulbaEye(EYE_R, sgn);
    holder.add(eye);

    // Blink lid in the skin material.
    const lid = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.10, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      skin,
    );
    ensureVertexColor(lid.geometry);
    lid.scale.y = 0;
    lid.castShadow = false;
    holder.add(lid);

    rig.head.add(holder);
    rig.eyes.push(eye);
    rig.eyelids.push(lid);
  }

  /* --- Bulb ---------------------------------------------------------- */
  const bulbGroup = new THREE.Group();
  // On the BACK, behind the shoulders, foot buried in the collar so the seam
  // eats the base. The tip is the highest point of the whole silhouette.
  // Sunk into the back so the foot is buried in the collar swell — the seam
  // must eat the bulb's bottom edge or it reads as resting on the spine.
  bulbGroup.position.set(0, 0.250, -0.082);
  rig.body.add(bulbGroup);

  // Leaf green — a clearly different, warmer green than the turquoise hide.
  const bulbMat = creatureSkin({
    color: 0x287612,
    subsurface: 0x4f9c26,
    wrap: 0.20,
    rim: 0.06,
    roughness: 0.95,
    detail: 'pores',
    detailScale: 3,
  });
  bulbMat.clearcoat = 0.22;
  bulbMat.clearcoatRoughness = 0.45;
  bulbMat.sheen = 0.08;
  bulbMat.normalScale.set(0.06, 0.06);
  bulbMat.envMapIntensity = 0.25;
  bulbMat.roughnessMap = null;
  bulbMat.roughness = 0.72;
  bulbMat.vertexColors = true;

  // Base wraps: darker green.
  const wrapMat = bulbMat.clone();
  // A deeply SATURATED leaf green. The blades' tops face the cyan sky fill,
  // which lifts and desaturates whatever it hits (a diagnostic render showed
  // pure red surviving where a muted green washed out to pale grey-cyan) —
  // so the albedo leans hard into green to still read as leaf up top.
  wrapMat.color.setHex(0x156e04);
  wrapMat.vertexColors = true;
  // Matte: clearcoat or env reflection also washes the tops out.
  wrapMat.clearcoat = 0.04;
  wrapMat.envMapIntensity = 0.12;
  wrapMat.sheen = 0.03;
  wrapMat.roughness = 0.85;

  // Fat: the HOME bulb is about as wide as it is tall — a garlic dome with a
  // short point, not a soft-serve cone.
  const BULB_R = 0.168;
  const BULB_H = 0.320;
  const bulb = new THREE.Mesh(onionBulbGeometry(BULB_R, BULB_H), bulbMat);
  bulb.castShadow = true;
  // No receiveShadow on the bulb or its wraps: the leaf ring casting onto the
  // dome (and the dome onto the leaves) printed acorn-shaped acne blobs.
  bulb.receiveShadow = false;
  bulbGroup.add(bulb);

  // Ring of darker triangular wrap blades hugging the bulb's base all the
  // way around. Each blade lies flat against the dome's lower flank — cupped
  // to its circumference, bowed to its taper — with only the tip easing
  // outward. Nothing tubular: the blades are an order of magnitude wider
  // than they are thick from every angle.
  const wrapGeo = wrapLeafGeometry(BULB_R * 0.74, BULB_R * 0.98, BULB_R * 0.06, BULB_R * 1.6);
  const WRAPS = 6;
  for (let i = 0; i < WRAPS; i++) {
    const a = (i / WRAPS) * Math.PI * 2 + 0.42;
    const pivot = new THREE.Group();
    pivot.rotation.y = a;
    const leaf = new THREE.Mesh(wrapGeo, wrapMat);
    // A low calyx of wide blades: roots buried below the seam, blades leaning
    // against the bulb's fat lower bulge, tips easing outward around the
    // widest point — high enough to show as leaves, low enough not to spike.
    // Side-facing blades sit lower, droop harder and run shorter, so their
    // tips never peek past the body silhouette beside the ears in the
    // dead-front view.
    // `side` is ~1 only for blades facing straight sideways — the ones whose
    // tips clear the torso silhouette beside the cheeks in the front view.
    // The sixth power leaves the diagonal blades (the ones that dress the
    // bulb in the three-quarter view) almost untouched.
    // More tilt swings a sideways tip OUT past the torso; less keeps it
    // hugging the dome. So the pure-side pair hugs tighter, runs shorter and
    // roots deeper in the collar instead of drooping further.
    const side = Math.abs(Math.sin(a));
    const pure = Math.pow(side, 12);
    leaf.position.set(0, -0.024 - 0.028 * pure, BULB_R * 0.68);
    leaf.rotation.x = 0.62 - 0.12 * pure;
    leaf.scale.setScalar(1 - 0.24 * pure);
    leaf.castShadow = true;
    leaf.receiveShadow = false;
    pivot.add(leaf);
    bulbGroup.add(pivot);
  }

  rig.extras.push(bulbGroup);

  const anim = new IdleAnimator(rig, 11);
  let attention = 0;

  return {
    id: 'bulbasaur',
    name: 'Bulbasaur',
    group: rig.root,
    get attention() { return attention; },
    set attention(v: number) { attention = clamp(v, 0, 1); },
    update(dt, elapsed) {
      anim.update(dt, elapsed, attention);
      // Hide the coplanar lid disc while the eye is fully open.
      for (const lid of rig.eyelids) lid.visible = lid.scale.y > 0.02;
      // The bulb is heavy — it lags the body's motion.
      bulbGroup.rotation.z = Math.sin(elapsed * 0.44 - 0.5) * 0.04;
      bulbGroup.rotation.x = Math.sin(elapsed * 1.55 - 0.7) * 0.025;
    },
    celebrate: () => anim.celebrate(),
    dispose: () => disposeCreature(rig.root),
  };
}
