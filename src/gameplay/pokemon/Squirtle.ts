import * as THREE from 'three';
import { metaSurface, taperY, type Ball } from '../../fx/Sculpt';
import { creatureSkin } from '../../fx/CreatureMaterials';
import { clamp, smoothstep, lerp } from '../../core/Noise';
import { createRig, IdleAnimator, finishBody, taperTube, disposeCreature, type Creature } from './shared';

/**
 * Squirtle — a small upright turtle whose whole design rests on one idea:
 * a soft blue animal living inside a hard shell.
 *
 * The shell is ONE closed volume — a single sphere mesh that encloses the
 * torso — not two half-domes parked front and back. But it is not a ball
 * either: the front hemisphere is pressed flat into a PLATE, because the
 * plastron on a turtle is a flat bony floor, and the previous build's inflated
 * cream sphere swallowed the arms and owned the whole silhouette. A thick
 * raised pale-yellow marginal ridge runs the entire way around the join
 * between plate and dome — that ridge is the single most recognisable line in
 * the design and it was simply missing before.
 *
 * Head, arms, legs and tail leave through real openings cut into that surface:
 * the faces are deleted and the surrounding ring is rolled inward, so each
 * limb comes out of a socket instead of intersecting a wall.
 *
 * Because the shell is one mesh it is also one material. The small gloss
 * difference between carapace and plastron is recovered in the shader from the
 * vertex colour, which costs nothing and keeps the geometry seamless. Both are
 * kept low: this is keratin, not lacquer.
 */

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

/** Writes a flat vertex colour onto a geometry that shares a vertexColors material. */
function paint(geo: THREE.BufferGeometry, shade = 1): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  c.fill(shade);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Mirrors a ball list across X, for building a limb once and using it twice. */
function mirror(balls: Ball[]): Ball[] {
  return balls.map((b) => ({ ...b, x: -b.x }));
}

/** Uniformly rescales a ball list about the origin. */
function scaleBalls(balls: Ball[], k: number): Ball[] {
  return balls.map((b) => ({ ...b, x: b.x * k, y: b.y * k, z: b.z * k, r: b.r * k }));
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Points a Y-axis primitive (capsule, cone) along `dir`, starting at `from`.
 *
 * Fingers and toes are separate tapered capsules rather than metaballs: at this
 * scale a metaball chain fuses digits into a mitten no matter how the smoothing
 * is tuned, and a mitten is the single fastest way to make a character look
 * unfinished.
 */
function placeAlong(o: THREE.Object3D, from: THREE.Vector3, dir: THREE.Vector3, len: number): void {
  const d = dir.clone().normalize();
  o.position.copy(from).addScaledVector(d, len * 0.5);
  o.quaternion.setFromUnitVectors(UP, d);
}

/** A tapered capsule used for every finger and toe. */
function digit(len: number, radius: number, tipScale: number): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(radius, len, 3, 8);
  taperY(g, tipScale, 1.0);
  g.deleteAttribute('uv');
  return g;
}

/**
 * Finds where a ray leaving the head's interior along `dir` crosses the skull
 * surface.
 *
 * Every facial feature — eyes, mouth line, lip, nostrils — is placed by this
 * rather than by hand-tuned coordinates. The head is a marching-cubes
 * isosurface whose exact position moves whenever a ball is retuned, and the
 * previous build's mouth was authored as a fixed z: it ended up *inside* the
 * muzzle, which is why the model shipped with no mouth at all. Measuring the
 * real surface makes that class of mistake impossible.
 *
 * Cast inward from well outside so the first hit is the front face.
 */
const _ray = new THREE.Raycaster();
function onSkull(mesh: THREE.Mesh, dir: THREE.Vector3, fallback = 0.09): THREE.Vector3 {
  const d = dir.clone().normalize();
  _ray.set(d.clone().multiplyScalar(0.6), d.clone().negate());
  const hits = _ray.intersectObject(mesh, false);
  if (hits.length) return hits[0].point.clone();
  return d.multiplyScalar(fallback);
}

/**
 * The eyelid: a skin shell around the whole eyeball with an eye-shaped
 * aperture cut out of the front.
 *
 * A pair of lid caps leaves the sides of the sclera bare, which reads as a
 * white egg with a brown crescent from every angle but dead-on. A closed shell
 * with an elliptical opening cannot do that: the only white on screen is
 * inside the aperture, and the aperture edge is the hard lash line the eye
 * needs. The aperture is deliberately GENEROUS — Squirtle's huge open eyes are
 * the character, and the previous build's narrow slot turned them into two
 * black pinpricks.
 *
 * @param ax  half-width of the opening, in radians on the eyeball
 * @param ay  half-height of the opening
 * @param drop how far the opening sits below the pupil axis, which is what
 *             makes the upper lid heavier than the lower one
 */
function eyeAperture(radius: number, ax: number, ay: number, drop: number): THREE.BufferGeometry {
  // Densely tessellated: the aperture is cut along vertex boundaries, and at
  // 20x14 the jagged cut both showed as a dark saw-tooth line where the lid
  // rim crosses the iris and aliased into pinholes that leaked red speckles
  // onto the cheek.
  const geo = new THREE.SphereGeometry(radius, 40, 28);
  geo.deleteAttribute('uv');
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const axis = new THREE.Vector3(0, -Math.sin(drop), Math.cos(drop));
  const open = new Uint8Array(pos.count);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const t = Math.acos(clamp(p.dot(axis), -1, 1));
    // Azimuth around the aperture axis: x stays x, y is measured in the
    // plane tilted by `drop`.
    const py = p.y * Math.cos(drop) + p.z * Math.sin(drop);
    const phi = Math.atan2(py, p.x);
    const c = Math.cos(phi) / ax;
    const s = Math.sin(phi) / ay;
    const bound = 1 / Math.sqrt(c * c + s * s);
    if (t < bound) open[i] = 1;
  }

  const idx = geo.index!;
  const out: number[] = [];
  for (let f = 0; f < idx.count; f += 3) {
    const a = idx.getX(f);
    const b = idx.getX(f + 1);
    const c = idx.getX(f + 2);
    if (open[a] && open[b] && open[c]) continue;
    out.push(a, b, c);
  }
  geo.setIndex(out);
  return geo;
}

/* ------------------------------------------------------------------ */
/* Shell surface                                                       */
/* ------------------------------------------------------------------ */

/**
 * Angle from the shell's forward axis at which the marginal ridge runs.
 *
 * At the equator, so the plastron is exactly the front hemisphere and the
 * ridge draws the full outline of the character from every angle. The previous
 * value put the boundary 33 degrees forward of the equator, which is why the
 * cream plate read as a separate balloon stuck on the front.
 */
const RIM = 0.94;

/**
 * How far the ridge swings forward at the flanks relative to the top and
 * bottom. This is what makes the boundary an ellipse: A = RIM - RIM_ELL·cos2φ,
 * so 0.74 rad at the flanks and 1.14 at top and bottom.
 */
const RIM_ELL = 0.37;

/**
 * Depth of the plastron plate, and how much it domes.
 *
 * The plate is pressed back to a near-flat disc whose centre sits a hair proud
 * of the marginal ridge, so from the front you read: brown carapace at the
 * outer edge, a bright pale-yellow lip inboard of it, then a flat banded plate.
 * A hemispherical plastron — what this was — reads as a cushion and swallows
 * the arms, which is the single loudest fault in the previous build.
 */
const PLATE_Z = 0.70;
const PLATE_GROOVE = 0.022;

/**
 * Sculpts and paints the whole shell in one pass over a unit sphere.
 *
 * Everything is keyed off `a`, the angle from the shell's forward axis:
 * a < RIM is plastron, a > RIM is carapace, and a thick raised marginal ridge
 * straddles the boundary. Doing all three on one mesh is the point — a brown
 * dome and a cream egg with daylight between them cannot be shaded into one
 * object.
 *
 * The carapace scute layout is a spherical Voronoi seeded in concentric rings
 * around the carapace pole, which is what yields hexagons instead of the
 * irregular blotches a random Voronoi gives.
 */
function shellSurface(geo: THREE.BufferGeometry): void {
  const pole = new THREE.Vector3(0, 0.26, -0.97).normalize();
  const u = new THREE.Vector3(0, 1, 0).cross(pole).normalize();
  const v = pole.clone().cross(u).normalize();

  const centers: THREE.Vector3[] = [];
  const rings: [number, number, number][] = [
    [0, 1, 0],
    [0.66, 6, 0],
    [1.24, 12, Math.PI / 12],
  ];
  for (const [polar, count, off] of rings) {
    for (let i = 0; i < count; i++) {
      const az = (i / count) * Math.PI * 2 + off;
      centers.push(
        pole.clone().multiplyScalar(Math.cos(polar))
          .addScaledVector(u, Math.cos(az) * Math.sin(polar))
          .addScaledVector(v, Math.sin(az) * Math.sin(polar))
          .normalize(),
      );
    }
  }

  // Warm reddish-brown carapace, not the near-black chocolate of the last
  // pass, and a genuinely pale-yellow ridge that separates it from the cream
  // plate rather than letting the two just abut.
  const brown = new THREE.Color(0xb5651e);
  const cream = new THREE.Color(0xe8ce8a);
  const ridge = new THREE.Color(0xf4e5ab);
  const c = new THREE.Color();

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    const a = Math.acos(clamp(p.z, -1, 1));

    /* ---- Marginal ridge --------------------------------------------- */
    // Thick and tall — this is a structural lip you could hook a finger
    // under, not a pinstripe. Twelve marginal scutes scallop the crest so it
    // reads as grown horn rather than a moulded hoop.
    const phi = Math.atan2(p.y, p.x);
    const scallop = 1 - 0.10 * (0.5 - 0.5 * Math.cos(12 * phi));
    // The ridge dies away near the neck opening: without this the raised crest
    // continues right up over the shoulders and reads as a white shirt collar
    // standing off the shell.
    const neckFade = smoothstep(0.30, 0.62, Math.acos(clamp(p.y, -1, 1)));
    // The boundary is an ELLIPSE, not a circle of latitude: it runs well
    // forward of the equator at the flanks and close to it above and below.
    // That is the whole trick for reading the shell from the front — the
    // carapace wraps forward around the plate's left and right edges, so brown
    // frames the plastron instead of hiding in a five-pixel band at the
    // silhouette where it was completely invisible.
    const A = RIM - RIM_ELL * Math.cos(2 * phi);
    // Narrow gaussian: the marginal band is a thin, clean hoop in the HOME
    // render, and the previous 0.185 sigma smeared pale ridge colour a third
    // of the way across the carapace.
    const k = (a - A) / 0.14;
    const raw = Math.exp(-k * k) * neckFade;
    const bump = raw * scallop;

    // Where the brown carapace begins. The pale marginal band runs from the
    // ridge nearly to the silhouette at the FLANKS, so a front view shows
    // cream plate, cream band, and only a thin crisp orange trim at the
    // shell's edge — the HOME read. At top and bottom the boundary ellipse
    // already sits near the equator, so the band stays narrow there and the
    // carapace still owns the whole dome in side view.
    const B = A + 0.10 + 0.40 * (0.5 + 0.5 * Math.cos(2 * phi));

    /* ---- Plastron segment grooves ----------------------------------- */
    const inPlastron = smoothstep(A - 0.04, A - 0.52, a);
    let seg = 1;
    for (const y of [0.46, 0.15, -0.17, -0.48]) {
      seg = Math.min(seg, smoothstep(0.0035, 0.010, Math.abs(p.y - y)));
    }

    /* ---- Carapace scutes -------------------------------------------- */
    const inCarapace = smoothstep(B - 0.02, B + 0.30, a);
    let d1 = 4;
    let d2 = 4;
    let win = 0;
    for (let n = 0; n < centers.length; n++) {
      const d = 1 - p.dot(centers[n]);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        win = n;
      } else if (d < d2) d2 = d;
    }
    const edge = smoothstep(0.004, 0.050, d2 - d1);
    const bevel = edge * edge * (3 - 2 * edge);

    /* ---- Radius ------------------------------------------------------ */
    // A narrow groove seats the ridge against the plate. Without it the two
    // pale yellows sit at the same height and the ridge simply disappears
    // into the plastron under a broad key light.
    const gk = (a - (A - 0.20)) / 0.07;
    const seat = Math.exp(-gk * gk);

    const r =
      1
      + bump * 0.125
      - seat * 0.026
      + inCarapace * 0.045 * bevel;

    let X = p.x * r;
    let Y = p.y * r;
    let Z = p.z * r;

    /* ---- Press the plastron into a plate ----------------------------- */
    // The plate is driven to a plane rather than scaled, because scaling a
    // sphere's front leaves the raised marginal ridge standing proud of the
    // middle — which is exactly how the last attempt turned the belly into a
    // crater with a lip round it.
    //
    // `u` runs 0 at the marginal ridge to 1 at the plate's centre. The target
    // depth leaves the boundary alone and ramps to a single flat plane, so the
    // ridge keeps its own shape and the belly is a flat banded plate.
    if (a < A) {
      const u = 1 - Math.sin(a) / Math.sin(A);
      const zBoundary = Math.cos(A) * 1.105;
      const flat = zBoundary + (PLATE_Z - zBoundary) * Math.pow(u, 0.5);
      Z = lerp(Z, flat, smoothstep(0, 0.42, u));
      // Crisp horizontal segment grooves, cut into the finished plane so they
      // read as steps in a hard plate rather than as soft dents in a balloon.
      Z -= inPlastron * (1 - seg) * PLATE_GROOVE;
    }
    pos.setXYZ(i, X, Y, Z);

    /* ---- Colour ------------------------------------------------------ */
    // CRISP band boundaries. The band-to-orange transition happens in seven
    // hundredths of a radian — the previous 0.15 rad ramp is what read as a
    // diffuse orange smear around the plate's edge.
    const brownMix = smoothstep(B - 0.02, B + 0.05, a);
    const bandMask = smoothstep(A - 0.03, A + 0.07, a) * (1 - brownMix);
    c.copy(cream).lerp(ridge, bandMask);
    c.lerp(brown, brownMix);
    // Segment lines are grown horn, not ink: they darken toward the carapace
    // hue rather than toward black.
    c.lerp(brown, (1 - seg) * inPlastron * 0.34);

    const vary = 1 + (((win * 37) % 11) / 11 - 0.5) * 0.09;
    const carapaceShade = lerp(0.56, 1.04, bevel) * vary;
    // Lines darken gently — a thin clean groove, not a wide dark trench.
    const plastronShade = lerp(0.58, 0.92, seg);
    // Crest of the ridge catches light; the scallop notches sit in shadow.
    const rimShade = 1.05 + bump * 0.10 - (1 - scallop) * raw * 0.6;

    let shade = lerp(1, plastronShade, inPlastron);
    shade = lerp(shade, carapaceShade, inCarapace);
    shade = lerp(shade, rimShade, Math.min(1, raw * 1.3));
    shade *= 1 - seat * 0.22;

    col[i * 3] = c.r * shade;
    col[i * 3 + 1] = c.g * shade;
    col[i * 3 + 2] = c.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/**
 * Cuts a genuine opening in the shell.
 *
 * Faces inside `inner` are removed outright and the ring out to `outer` is
 * rolled inward, so the limb enters a socket with a lip around it. Vertices in
 * the funnel are darkened, which is what makes the opening read as depth rather
 * than as a hole punched in a decal.
 */
function shellOpening(
  geo: THREE.BufferGeometry,
  dir: THREE.Vector3,
  inner: number,
  outer: number,
  depth: number,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const n = dir.clone().normalize();
  const p = new THREE.Vector3();
  const cut = new Uint8Array(pos.count);

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const len = p.length() || 1;
    const a = Math.acos(clamp(p.dot(n) / len, -1, 1));
    if (a > outer) continue;
    const t = 1 - smoothstep(inner, outer, a);
    const s = 1 - depth * t;
    pos.setXYZ(i, p.x * s, p.y * s, p.z * s);
    const shade = lerp(1, 0.50, t);
    col.setXYZ(i, col.getX(i) * shade, col.getY(i) * shade, col.getZ(i) * shade);
    if (a < inner) cut[i] = 1;
  }

  const idx = geo.index;
  if (!idx) return;
  const out: number[] = [];
  for (let f = 0; f < idx.count; f += 3) {
    const a = idx.getX(f);
    const b = idx.getX(f + 1);
    const c = idx.getX(f + 2);
    if (cut[a] && cut[b] && cut[c]) continue;
    out.push(a, b, c);
  }
  geo.setIndex(out);
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildSquirtle(): Creature {
  const rig = createRig();
  rig.root.name = 'Squirtle';

  /* ---- Materials ---------------------------------------------------- */
  // Matte. The shell is the only remotely hard thing on this character; when
  // the skin is glossy too the whole model reads as one inflatable pool toy.
  const skin = creatureSkin({
    color: 0x3da6e3,
    subsurface: 0x287bbc,
    wrap: 0.16,
    rim: 0.05,
    roughness: 0.90,
    detail: 'pores',
    detailScale: 14,
  });
  skin.clearcoat = 0;
  skin.sheen = 0;
  skin.roughnessMap = null;
  skin.normalScale = new THREE.Vector2(0.5, 0.5);
  skin.vertexColors = true;

  // One shell, one material. Carapace and plastron are separated in the shader
  // from the vertex colour — but only slightly, and both sit low. The previous
  // clearcoat of 0.7 turned the carapace into glazed ceramic; hard keratin is
  // broad and dull, and the darkness that made it read as lacquer has been
  // taken out of the base colour instead.
  const shellMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.45,
    vertexColors: true,
  });
  shellMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      /* glsl */ `
      #include <lights_physical_fragment>
      {
        float creamMask = smoothstep(0.40, 0.62, vColor.b / max(vColor.r, 0.001));
        material.roughness          = mix(0.50, 0.66, creamMask);
        material.clearcoat          = mix(0.16, 0.04, creamMask);
        material.clearcoatRoughness = mix(0.42, 0.60, creamMask);
      }
      `,
    );
  };
  shellMat.customProgramCacheKey = () => 'squirtle-shell';

  const clawMat = new THREE.MeshPhysicalMaterial({
    color: 0xe0cd9c,
    roughness: 0.42,
    clearcoat: 0.3,
    vertexColors: true,
  });
  // Nostrils only. Near-black warm brown — the old grey-blue read as two
  // painted dots of a different material sitting on the muzzle.
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x1d1410,
    roughness: 0.7,
    vertexColors: true,
  });
  // Dark BROWN, not reddish — the HOME mouth line is the colour of dark
  // chocolate, and the previous maroon read as lipstick.
  const mouthMat = new THREE.MeshStandardMaterial({
    color: 0x2c1b10,
    roughness: 0.75,
    vertexColors: true,
  });

  /* ---- Shell -------------------------------------------------------- */
  // Wide, but no longer the tallest thing in the room. The whole character is
  // half a metre top to toe, which puts it level with Charmander instead of
  // looming over both of its stablemates.
  // Shrunk relative to the head: in the HOME render the shell is only ~1.3x
  // the head's width, and the previous 0.34 m shell against a 0.16 m head made
  // the character read as 70% shell.
  const SX = 0.142;
  const SY = 0.124;
  const SZ = 0.148;
  const TILT = 0.16;

  const shell = new THREE.Group();
  shell.position.set(0, 0.224, -0.014);
  shell.rotation.x = TILT;
  rig.body.add(shell);

  // 96x60 rather than 168x104: at 0.34 m across, viewed from a metre, the
  // extra 25k triangles bought nothing a normal could not.
  const shellGeo = new THREE.SphereGeometry(1, 72, 44);
  shellGeo.deleteAttribute('uv');
  shellSurface(shellGeo);

  // Openings, in shell-local space. Each direction is the world direction the
  // limb leaves along, rotated back through the shell's forward tilt.
  const toLocal = (x: number, y: number, z: number): THREE.Vector3 =>
    new THREE.Vector3(
      x,
      y * Math.cos(TILT) + z * Math.sin(TILT),
      -y * Math.sin(TILT) + z * Math.cos(TILT),
    ).normalize();

  // The neck leaves nearly straight up now: with the marginal ridge pulled
  // inboard to RIM the lip passes close under the collar, and a forward-raked
  // neck hole would eat a bite out of it right where it matters most.
  const neckDir = toLocal(0, 0.985, 0.17);
  const armDir = (s: number) => toLocal(s * 0.99, 0.15, -0.10);
  const legDir = (s: number) => toLocal(s * 0.46, -0.90, 0.02);
  // Swung well out to the side so the tail can clear the shell's own
  // silhouette; when the socket was at the centre-rear the whole curl lived
  // inside the shell's footprint and could not be seen from any front angle.
  const tailDir = toLocal(0.52, -0.30, -0.80);

  shellOpening(shellGeo, neckDir, 0.17, 0.30, 0.11);
  shellOpening(shellGeo, armDir(1), 0.14, 0.26, 0.07);
  shellOpening(shellGeo, armDir(-1), 0.14, 0.26, 0.07);
  shellOpening(shellGeo, legDir(1), 0.14, 0.26, 0.08);
  shellOpening(shellGeo, legDir(-1), 0.14, 0.26, 0.08);
  shellOpening(shellGeo, tailDir, 0.11, 0.21, 0.09);

  shellGeo.scale(SX, SY, SZ);
  shellGeo.computeVertexNormals();
  const shellMesh = new THREE.Mesh(shellGeo, shellMat);
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  shell.add(shellMesh);

  /* ---- Torso, neck and collar --------------------------------------- */
  // One mesh, not two. The head used to sit on a bare cylinder that met the
  // shell in a hard crease — a bobblehead peg. Here the neck is the top of the
  // torso field: a column that swells into a collar wider than the shell's
  // neck hole, so what you see through the opening is a soft fold of skin
  // bulging out of the shell, and the metaball blend does the fillet for free.
  const body = finishBody(
    new THREE.Mesh(
      metaSurface(
        [
          { x: 0, y: 0.224, z: -0.018, r: 0.064, sx: 1.30, sy: 1.10, sz: 0.66 },
          { x: 0, y: 0.276, z: -0.014, r: 0.052, sx: 1.14, sy: 0.86, sz: 0.66 },
          { x: 0, y: 0.170, z: -0.014, r: 0.054, sx: 1.14, sy: 0.80, sz: 0.66 },
          // Collar: proud of the shell's neck lip, so the fold reads as a roll
          // of skin bulging out of the opening rather than a peg in a hole.
          // SHORT — the head sits close over the shell; the previous column
          // read as a giraffe neck.
          { x: 0, y: 0.322, z: 0.018, r: 0.044, sx: 1.10, sy: 0.66, sz: 0.98 },
          { x: 0, y: 0.352, z: 0.022, r: 0.038, sx: 1.00, sy: 0.88 },
          // Blends into the jaw mass of the head, which overlaps this.
          { x: 0, y: 0.384, z: 0.024, r: 0.035 },
        ],
        { resolution: 44, smooth: 0.92 },
      ),
      skin,
    ),
    new THREE.Vector3(0, 0.24, 0),
    0.30,
  );
  rig.body.add(body);

  /* ---- Head --------------------------------------------------------- */
  // Narrower than the shell at every angle, with a real muzzle and jaw line
  // instead of a beach ball. Squirtle has no ear flaps — the pointed nubs an
  // earlier build carried were Wartortle's.
  // Lifted clear of the shell collar so there is a neck to see. The previous
  // build seated the jaw below the top of the carapace, which is why the head
  // read as a ball resting on the shell.
  rig.head.position.set(0, 0.450, 0.026);

  // Enlarged ~35% over the previous build: the head is the character. In the
  // HOME render it is a third of the standing height and nearly as wide as the
  // shell.
  const HS = 0.95;
  const rawHead: Ball[] = [
    // Slightly wider than tall — the official head is a squashed dome.
    { x: 0, y: 0, z: 0, r: 0.095, sx: 1.24, sy: 1.0, sz: 1.0 },
    { x: 0, y: 0.016, z: -0.026, r: 0.066, sx: 1.14, sz: 0.94 },
    // Core mass behind the eyes. Without it the two socket carves meet in the
    // middle of the skull and open a tunnel you can see the sclera through.
    { x: 0, y: 0.008, z: 0.020, r: 0.072, sx: 1.32, sy: 1.0, sz: 0.88 },
    { x: 0, y: -0.004, z: 0.062, r: 0.056, sx: 1.30, sy: 0.92, sz: 0.78 },
    // Muzzle and the jaw beneath it: the two masses that give a profile, and
    // the platform the mouth line is cut across. Pushed further forward and
    // given a squarer section than before, because a mouth drawn on a round
    // cheek reads as a scratch rather than a jaw.
    { x: 0, y: -0.030, z: 0.106, r: 0.048, sx: 1.02, sy: 0.78, sz: 0.98 },
    { x: 0, y: -0.062, z: 0.062, r: 0.054, sx: 1.04, sy: 0.62, sz: 1.10 },
    { x: 0, y: -0.064, z: -0.004, r: 0.052, sx: 1.02, sy: 0.60 },
    // Cranial ridge: a low crown running front to back so the skull is not a
    // sphere from above.
    { x: 0, y: 0.060, z: 0.010, r: 0.038, sx: 0.66, sy: 0.50, sz: 1.6 },
  ];
  for (const s of [1, -1]) {
    // Cheek mass. No brow-ridge balls: at this resolution they read as horn
    // nubs on the crown, and the official head is one smooth dome.
    rawHead.push({ x: s * 0.062, y: -0.030, z: 0.014, r: 0.052, sy: 0.94 });
    // Eye socket. The eyeball has to sit INTO the skull, so this carve is what
    // makes the difference between an inset eye and a bug eye. Moved up and
    // inboard to follow the new eye axis, and kept shallow and small so it is a
    // socket rather than a dent.
    rawHead.push({ x: s * 0.038, y: 0.040, z: 0.132, r: 0.058, sy: 1.02, sz: 0.72, strength: -0.30 });
  }
  // Mouth trench and the crease under the nose. A shallow negative here gives
  // the lip something to sit in, so the mouth is a feature of the form rather
  // than a wire lying on it. Kept subtle — a deep trench reads as an open jaw
  // from the side.
  rawHead.push({ x: 0, y: -0.046, z: 0.146, r: 0.036, sx: 1.9, sy: 0.36, strength: -0.18 });

  const headMesh = new THREE.Mesh(metaSurface(scaleBalls(rawHead, HS), { resolution: 56, smooth: 0.9 }), skin);

  /* ---- Facial landmarks, measured off the real surface ---------------- */
  // 23.5 mm across rather than 33.5, brought in from a 0.36 rad splay to 0.27
  // and lifted from 0.16 to 0.34 on the head's own axis. Small, close-set and
  // high is what reads as a friendly animal; big, wide and low is a startled
  // Muppet, which is precisely what this was.
  // LARGE and wide open — the eyes are what make it Squirtle. The eyeball is a
  // third of the head's height, the aperture is taller than it is wide, and
  // the iris fills nearly all of it.
  // Enlarged 12% (0.0345 -> 0.0386): in the HOME render the eyes nearly reach
  // the head's side silhouette, and at the old size they read a notch too
  // small. Everything on the eye — iris, pupil, catchlight, lid aperture,
  // fold, blink shell, seat depth — is derived from EYE_R, so the hard-won
  // internal proportions scale together untouched.
  const EYE_R = 0.0386;
  // Splayed a touch wider (0.31 -> 0.33) with the bigger eyes: at 0.31 the
  // enlarged fold shells met over the nose bridge and pinched a faint knitted
  // crease between the inner corners.
  const SPLAY = 0.33;
  const SQUASH = 1.06;

  const eyeDir = (s: number): THREE.Vector3 =>
    new THREE.Vector3(Math.sin(s * SPLAY), 0.28, Math.cos(SPLAY)).normalize();

  const eyeSeat = [1, -1].map((s) => onSkull(headMesh, eyeDir(s)));

  const mouthDir = (u: number): THREE.Vector3 => {
    const yaw = u * 0.43;
    // Corners lift: a plain arc reads as a frown at this scale, and the small
    // upcurve is most of what makes the face friendly.
    const pitch = -0.34 + u * u * 0.16;
    return new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    );
  };

  const MOUTH_N = 22;
  const mouthPts: THREE.Vector3[] = [];
  for (let i = 0; i <= MOUTH_N; i++) {
    const u = (i / MOUTH_N) * 2 - 1;
    const d = mouthDir(u).normalize();
    const hit = onSkull(headMesh, d);
    // Stand the line just proud of the skin so nothing can bury it, but low
    // enough that it cannot float off the profile in side view.
    mouthPts.push(hit.clone().addScaledVector(d, 0.0022));
  }

  finishBody(headMesh, new THREE.Vector3(0, 0, 0), 0.26);
  rig.head.add(headMesh);

  // Skull plug. Deep negative carves for the sockets and the mouth can leave
  // the marching-cubes surface locally thin, and any gap means the eye
  // assembly is visible from the back of the head. A solid interior ellipsoid
  // makes that impossible: invisible when the skull is closed, and it backs
  // the surface when it is not.
  const plugGeo = new THREE.SphereGeometry(0.084 * HS, 18, 12);
  plugGeo.scale(1.14, 0.98, 1.02);
  plugGeo.deleteAttribute('uv');
  const plug = new THREE.Mesh(paint(plugGeo, 1.0), skin);
  plug.position.set(0, 0.004, -0.004);
  plug.castShadow = false;
  plug.receiveShadow = false;
  rig.head.add(plug);

  /* ---- Eyes --------------------------------------------------------- */
  // The element that carries the character, and the one the previous pass got
  // most wrong: two 6 mm dots with a floating white speck. These are 8 mm
  // across with a full white sclera, a big warm-brown iris, a black pupil and
  // one strong catchlight, seated into carved sockets so they read as set into
  // the skull rather than glued on.
  const scleraMat = new THREE.MeshStandardMaterial({ color: 0xf8f5ef, roughness: 0.38, metalness: 0 });
  // Maroon red, matching the HOME render's iris. Brightened again and given a
  // touch of emissive lift: under scene lighting 0x7c241c shaded down to
  // near-black over most of the ball, so the eye read as a red RING around a
  // huge black pupil — a glare. The emissive floor keeps the lower half of
  // the iris reading maroon instead of collapsing into the pupil.
  const irisMat = new THREE.MeshStandardMaterial({
    color: 0x8e2c1f,
    emissive: 0x220a07,
    roughness: 0.32,
    metalness: 0,
  });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x0d0a0b });
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  for (const s of [1, -1]) {
    const d = eyeDir(s);
    const seat = eyeSeat[s > 0 ? 0 : 1];

    const holder = new THREE.Group();
    // The ball's centre sits just over half a radius behind the socket floor:
    // deep enough to read as set into the skull, proud enough that the big
    // aperture stays fully open.
    holder.position.copy(seat.clone().addScaledVector(d, -EYE_R * 0.68));
    holder.rotation.y = s * SPLAY;
    // Roll the WHOLE eye (ball + lid together) so the outer corner sits a
    // touch higher than the inner one — the wide-awake cat-eye lift. Rolling
    // only the lid aperture instead made its rim disagree with the iris and
    // chip a skin-coloured bite out of the iris's inner-top corner.
    holder.rotation.z = s * 0.055;
    holder.scale.y = SQUASH;
    rig.head.add(holder);

    const eye = new THREE.Group();
    eye.name = 'Eye';
    // The iris cap looks slightly UP into the aperture. Without this the cap
    // faces dead level, white shows above the iris, and the character reads
    // as gazing at the floor half-asleep.
    eye.rotation.x = -0.24;
    holder.add(eye);

    const sclera = new THREE.Mesh(new THREE.SphereGeometry(EYE_R, 22, 15), scleraMat);
    eye.add(sclera);

    // Iris and pupil are shallow caps on the eyeball so they curve with it.
    // The iris is HUGE — it owns nearly the whole aperture, leaving white only
    // at the corners, which is exactly how the reference eye reads.
    const iris = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.006, 24, 16, 0, Math.PI * 2, 0, Math.asin(0.93)),
      irisMat,
    );
    iris.rotation.x = Math.PI / 2;
    eye.add(iris);

    // The pupil is CLEARLY smaller than the iris — ~37% of the visible eye
    // width, centred. Any bigger and the black owns the aperture, the iris
    // survives only as a thin red rim, and the eye turns into a donut glare.
    // The HOME balance is a big maroon disc with a modest black centre.
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(EYE_R * 1.014, 20, 13, 0, Math.PI * 2, 0, Math.asin(0.285)),
      pupilMat,
    );
    pupil.rotation.x = Math.PI / 2;
    eye.add(pupil);

    // ONE small crisp catchlight, upper-outer. A flattened disc oriented along
    // its own surface normal so it reads as a round dot from the front — the
    // previous half-buried sphere intersected the curved pupil at a grazing
    // angle and smeared into a white streak across the top of the eye.
    // Pulled DOWN off the aperture's top rim: at the old height the lid edge
    // clipped it into a white smear along the top of the eye. Sitting clear of
    // the rim it reads as the round glossy dot that carries the friendly look.
    const glintDir = new THREE.Vector3(s * 0.34, 0.42, 0.85).normalize();
    const glint = new THREE.Mesh(new THREE.SphereGeometry(EYE_R * 0.155, 12, 8), glintMat);
    glint.scale.z = 0.45;
    glint.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), glintDir);
    glint.position.copy(glintDir).multiplyScalar(EYE_R * 1.02);
    eye.add(glint);

    eye.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });

    // Lid shell: skin-coloured, closed all round the eyeball with an eye-shaped
    // aperture so no sclera escapes at the sides. The aperture is WIDE OPEN
    // and taller than it is wide, with zero droop. The shell hugs the eyeball
    // TIGHTLY — at the old 1.04 radius there was a visible gap between lid
    // edge and eye, and looking under the top edge showed the shell's dark
    // backside as an angular chip on the iris.
    // Negative drop tilts the aperture UP so its rim follows the up-tilted
    // iris; with a level aperture the lid clipped a dark bite out of the
    // iris's inner-top corner.
    // Opened wider and rounder than before — wide-awake eyes — and the whole
    // aperture is rolled a few degrees so the OUTER corner sits slightly
    // higher than the inner one. Nothing about the lid presses down on the
    // iris top: a level or drooping upper rim is exactly what created the
    // glare in the last pass.
    // Width capped at 0.90: at 0.94 the two apertures reached across the nose
    // bridge, the inner corners almost touched, and the folds pinched a dark
    // vertical crease between the eyes — an instant knitted-brow scowl.
    const lid = new THREE.Mesh(paint(eyeAperture(EYE_R * 1.022, 0.90, 1.12, -0.145), 1.0), skin);
    lid.castShadow = false;
    holder.add(lid);

    // A soft fold just outboard of it: barely shaded, so the eye's edge is a
    // crease in skin rather than eyeliner.
    const fold = new THREE.Mesh(paint(eyeAperture(EYE_R * 1.13, 1.02, 1.30, -0.07), 0.96), skin);
    fold.castShadow = false;
    holder.add(fold);

    // Blink lid, just inside the sclera so its rim cannot show when open.
    const blinkGeo = new THREE.SphereGeometry(EYE_R * 0.99, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    blinkGeo.scale(1.0, 1.22, 1.0);
    blinkGeo.deleteAttribute('uv');
    const blink = new THREE.Mesh(paint(blinkGeo, 1.0), skin);
    blink.scale.y = 0;
    blink.castShadow = false;
    holder.add(blink);

    rig.eyes.push(eye);
    rig.eyelids.push(blink);
  }

  /* ---- Mouth and nose ----------------------------------------------- */
  // THIN. The mouth is a wide simple smile line, not a lip — the previous
  // 5 mm tube read as a clown grin.
  const mouthGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(mouthPts), 24, 0.0026, 6, false);
  mouthGeo.deleteAttribute('uv');
  const mouth = new THREE.Mesh(paint(mouthGeo, 1), mouthMat);
  mouth.castShadow = false;
  rig.head.add(mouth);

  // Brow marks: HOME carries only the faintest short line above each eye —
  // barely-there, nearly horizontal. The previous bold near-black dashes,
  // slanted hard down toward the nose, were villain brows and single-handedly
  // made the face read ANGRY. These are much thinner, shorter, almost flat,
  // and tinted a dark blue-grey close to the skin so they read as a soft
  // crease rather than drawn-on eyebrows. Friendly beats faithful here.
  const browMat = new THREE.MeshStandardMaterial({
    color: 0x2b5e85,
    roughness: 0.85,
    vertexColors: true,
  });
  for (const s of [1, -1]) {
    const browEnd = (yaw: number, pitch: number): THREE.Vector3 => {
      const d = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      ).normalize();
      // Stood WELL clear of the skin: the soft fold shell around the eye
      // protrudes above the skull surface here, and a brow that grazes it gets
      // partially buried and breaks into dark wedges on the eye's top rim.
      return onSkull(headMesh, d).addScaledVector(d, 0.0042);
    };
    // Nearly flat: only a whisper of tilt (outer end a touch higher), and a
    // shorter span than before so it never reads as a full drawn brow.
    const inner = browEnd(s * (SPLAY + 0.012), 0.578);
    const outer = browEnd(s * (SPLAY + 0.098), 0.590);
    const len = inner.distanceTo(outer);
    const browGeo = new THREE.CapsuleGeometry(0.0007, len, 3, 8);
    browGeo.deleteAttribute('uv');
    const brow = new THREE.Mesh(paint(browGeo, 1), browMat);
    brow.position.copy(inner).add(outer).multiplyScalar(0.5);
    brow.quaternion.setFromUnitVectors(UP, outer.clone().sub(inner).normalize());
    brow.castShadow = false;
    rig.head.add(brow);
  }

  // Nostrils: two TINY dark dots. In the HOME render they are barely there —
  // the previous 5.5 mm grey-blue ovals were the third most prominent feature
  // on the face.
  for (const s of [1, -1]) {
    const nd = new THREE.Vector3(s * 0.115, -0.055, 1).normalize();
    const n = new THREE.Mesh(paint(new THREE.SphereGeometry(0.0026, 10, 8), 1), darkMat);
    n.scale.set(1.2, 0.75, 0.5);
    n.position.copy(onSkull(headMesh, nd).addScaledVector(nd, 0.0008));
    n.castShadow = false;
    rig.head.add(n);
  }

  /* ---- Arms --------------------------------------------------------- */
  // Tapered, with a shoulder mass and a narrowing at the elbow and wrist. A
  // uniform-diameter tube has no rhythm and reads as a sausage. They now
  // attach to a torso you can see, because the plastron no longer bulges out
  // past the shoulder.
  // The first three balls are a SHOULDER: a mass wide enough to fill the
  // shell's arm socket and bulge back out of it, so the blend runs continuously
  // from shell lip to upper arm. Previously the arm started at the socket mouth
  // and the two surfaces merely touched, which is why the limbs read as
  // detached. Then a genuine direction change at the elbow — upper arm down and
  // out, forearm down and forward — with a knob on the outside of the joint.
  const armBalls: Ball[] = scaleBalls([
    { x: -0.048, y: 0.010, z: -0.004, r: 0.048, sx: 0.90 },
    { x: -0.024, y: 0.006, z: 0.000, r: 0.050 },
    { x: 0.000, y: -0.010, z: 0.002, r: 0.046 },
    { x: 0.022, y: -0.038, z: 0.004, r: 0.042 },
    // Elbow: narrow just above it, then a proud knob, so the joint has a shape.
    { x: 0.036, y: -0.064, z: 0.006, r: 0.031 },
    { x: 0.044, y: -0.086, z: 0.016, r: 0.036, sz: 0.94 },
    { x: 0.046, y: -0.112, z: 0.036, r: 0.031 },
    { x: 0.048, y: -0.136, z: 0.062, r: 0.046, sy: 0.82, sz: 1.06 },
  ], 0.80);
  const palm = new THREE.Vector3(0.048, -0.136, 0.062).multiplyScalar(0.80);
  const fingerGeo = digit(0.036, 0.0155, 0.56);
  paint(fingerGeo, 1.02);
  const fingerClaw = paint(new THREE.ConeGeometry(0.0095, 0.026, 8), 1);

  const arms: THREE.Group[] = [];
  for (const s of [1, -1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.126, 0.252, 0.004);
    g.rotation.z = s * -0.20;
    const balls = s > 0 ? armBalls : mirror(armBalls);
    const m = finishBody(
      new THREE.Mesh(metaSurface(balls, { resolution: 46, smooth: 0.80 }), skin),
      new THREE.Vector3(s * 0.035, -0.06, 0.018),
      0.28,
    );
    g.add(m);

    for (const j of [-1, 0, 1]) {
      const dir = new THREE.Vector3(s * (0.22 + 0.30 * j), -0.62, 0.74).normalize();
      const root = palm.clone();
      root.x *= s;
      root.addScaledVector(dir, 0.014);

      const f = new THREE.Mesh(fingerGeo, skin);
      placeAlong(f, root, dir, 0.037);
      f.castShadow = true;
      g.add(f);

      const cl = new THREE.Mesh(fingerClaw, clawMat);
      placeAlong(cl, root.clone().addScaledVector(dir, 0.035), dir, 0.023);
      cl.castShadow = true;
      g.add(cl);
    }

    rig.body.add(g);
    arms.push(g);
  }

  /* ---- Legs and feet ------------------------------------------------ */
  // Chunky: the thigh has to bulge visibly below the shell's rim.
  const legBalls: Ball[] = scaleBalls([
    { x: -0.004, y: 0.012, z: 0.002, r: 0.052 },
    { x: 0.004, y: -0.026, z: 0.004, r: 0.049 },
    { x: 0.007, y: -0.048, z: 0.012, r: 0.039 },
    { x: 0.009, y: -0.066, z: 0.026, r: 0.042 },
    { x: 0.010, y: -0.080, z: 0.054, r: 0.041, sy: 0.56, sz: 1.24 },
  ], 0.80);
  const pad = new THREE.Vector3(0.010, -0.080, 0.054).multiplyScalar(0.80);
  const toeGeo = digit(0.026, 0.0155, 0.62);
  paint(toeGeo, 1.02);
  const toeClaw = paint(new THREE.ConeGeometry(0.0098, 0.022, 8), 1);

  for (const s of [1, -1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.078, 0.092, 0.020);
    g.rotation.y = s * 0.14;
    const balls = s > 0 ? legBalls : mirror(legBalls);
    const m = finishBody(
      new THREE.Mesh(metaSurface(balls, { resolution: 46, smooth: 0.86 }), skin),
      new THREE.Vector3(0, -0.045, 0.018),
      0.28,
    );
    g.add(m);

    for (const j of [-1, 0, 1]) {
      const dir = new THREE.Vector3(s * 0.30 * j, -0.10, 0.95).normalize();
      const root = pad.clone();
      root.x *= s;
      root.y += 0.004;
      root.addScaledVector(dir, 0.012);

      const t = new THREE.Mesh(toeGeo, skin);
      placeAlong(t, root, dir, 0.026);
      t.castShadow = true;
      g.add(t);

      const cl = new THREE.Mesh(toeClaw, clawMat);
      const cd = dir.clone().add(new THREE.Vector3(0, 0.22, 0)).normalize();
      placeAlong(cl, root.clone().addScaledVector(dir, 0.024), cd, 0.022);
      cl.castShadow = true;
      g.add(cl);
    }

    rig.body.add(g);
  }

  /* ---- Tail --------------------------------------------------------- */
  // A signature silhouette element, and it has to be legible from more than
  // the pure side view: swung well out to one side and standing away from the
  // carapace so it clears the shell in three-quarter, where it previously
  // vanished behind the dome entirely.
  const tail = new THREE.Group();
  // Out at the hip, not tucked behind the carapace: the shell is 0.17 half-wide
  // and the whole curl used to live inside that footprint, which is why it was
  // invisible from every angle but the pure side. The base now sits at the
  // side-rear socket and the spiral swings outboard past the shell's own
  // silhouette, so it reads in three-quarter and peeks out in front.
  tail.position.set(0.082, 0.190, -0.122);
  tail.rotation.x = -0.10;
  tail.rotation.y = 0.70;
  tail.rotation.z = -0.40;
  rig.body.add(tail);
  rig.tail = tail;

  const curlPts: THREE.Vector3[] = [];
  const base = new THREE.Vector3();
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    const a = 2.30 + t * Math.PI * 1.80;
    const R = 0.088 * (1 - 0.62 * t);
    const p = new THREE.Vector3(t * 0.034, 0.042 + R * Math.cos(a), -0.026 + R * Math.sin(a));
    if (i === 0) base.copy(p);
    curlPts.push(p.sub(base));
  }
  const curl = new THREE.CatmullRomCurve3(curlPts);
  // TubeGeometry places its rings at ARC-LENGTH-uniform points
  // (curve.getPointAt), but taperTube recentres each ring with plain
  // curve.getPoint. On a spiral, where parameter speed varies along the
  // curve, the two disagree — every ring is scaled toward a point that is not
  // its centre, which squashed the tube into the flat ribbon the old tail
  // showed on its inner curl. Wrapping the curve so getPoint IS getPointAt
  // makes the centres line up exactly.
  class ArcLengthCurve extends THREE.Curve<THREE.Vector3> {
    constructor(private readonly inner: THREE.CatmullRomCurve3) { super(); }
    override getPoint(t: number): THREE.Vector3 { return this.inner.getPointAt(t); }
  }
  // THICK: the tail is a signature element and has to read as a chunky spiral,
  // not a wire.
  const tailGeo = new THREE.TubeGeometry(curl, 30, 0.064, 12, false);
  taperTube(tailGeo, new ArcLengthCurve(curl), 31, 13, 1.0, 0.45, (t) => t * t * (3 - 2 * t));
  tailGeo.deleteAttribute('uv');
  const tailMesh = finishBody(new THREE.Mesh(tailGeo, skin), new THREE.Vector3(0, 0.03, -0.03), 0.24);
  tail.add(tailMesh);

  // TubeGeometry is open at both ends. The root end sits at the shell's tail
  // socket, and an open tube there shows as a hollow ring from behind, so it
  // gets a cap that also reads as the fleshy base of the tail.
  const tailCap = new THREE.Mesh(paint(new THREE.SphereGeometry(0.040, 14, 10), 0.98), skin);
  tailCap.position
    .copy(tail.position)
    .addScaledVector(
      new THREE.Vector3(0, 0.224, -0.014).sub(tail.position).normalize(),
      0.040,
    );
  tailCap.scale.set(1.0, 0.94, 1.0);
  tailCap.castShadow = true;
  rig.body.add(tailCap);

  /* ---- Performance -------------------------------------------------- */
  const anim = new IdleAnimator(rig, 33);
  let attention = 0;

  return {
    id: 'squirtle',
    name: 'Squirtle',
    group: rig.root,
    get attention() {
      return attention;
    },
    set attention(v: number) {
      attention = clamp(v, 0, 1);
    },
    update(dt, elapsed) {
      anim.update(dt, elapsed, attention);
      tail.rotation.y = 0.70 + Math.sin(elapsed * 0.9 + 1.2) * (0.08 + attention * 0.10);
      tail.rotation.x = -0.10 + Math.sin(elapsed * 1.3) * 0.04;
      for (let i = 0; i < arms.length; i++) {
        const s = i === 0 ? 1 : -1;
        arms[i].rotation.z = s * (Math.sin(elapsed * 1.05 + i * 1.9) * 0.07 - 0.05);
        arms[i].rotation.x = Math.sin(elapsed * 0.83 + i) * 0.05;
      }
    },
    celebrate: () => anim.celebrate(),
    dispose: () => disposeCreature(rig.root),
  };
}
