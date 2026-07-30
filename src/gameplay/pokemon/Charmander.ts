import * as THREE from 'three';
import { metaSurface, bendY, boxProjectedUV, type Ball } from '../../fx/Sculpt';
import { creatureSkin } from '../../fx/CreatureMaterials';
import { makeRng, lerp, clamp } from '../../core/Noise';
import { createRig, IdleAnimator, taperTube, disposeCreature, type Creature } from './shared';

/**
 * Charmander — an upright little lizard whose whole design points at one thing:
 * the fire on its tail.
 *
 * Five decisions drive this build.
 *
 * 1. THE FLAME IS A LIGHT. It is the only light source this character brings to
 *    the scene and it is the reason to look at him, so it gets a real
 *    `PointLight` pair — a bright near field that warms the tail's underside and
 *    the backs of the legs, and a wider, dimmer one that throws a warm pool onto
 *    the ground. Both flicker on exactly the same scalar that drives the
 *    flame's shape, so brightness and silhouette move together. A fire creature
 *    that emits no light is a decal.
 *
 * 2. THE FLAME IS ADDITIVE-ONLY AND HAS NO SPRITE. Every layer writes
 *    `vec4(colour, alpha)` through plain `AdditiveBlending` with `depthWrite`
 *    off, so no layer can ever darken what is behind it and no layer can leave
 *    an alpha rectangle for a later pass to find. The atmospheric bloom that
 *    used to be a camera-facing billboard is now a wide, soft lathe shell — a
 *    quad can show its corners, a Fresnel-dissolved shell cannot. Shell
 *    deformation amplitudes are kept below the point where the lathe folds
 *    through itself, because a folded lathe is exactly what produces straight
 *    polygonal creases down one side of the fire.
 *
 * 3. THE HEAD IS A ROUNDED WEDGE, NOT A TEARDROP. High rounded cranium, a
 *    near-vertical back of skull, and a SHORT snout whose tip rises above its
 *    root. The moment the snout tips downward and the cranium trails backward
 *    the character becomes a Muppet. There is no brow bar: a hard angled ridge
 *    over the eyes reads as a scowl and is not a Charmander feature. Soft lids
 *    over large teal eyes do the work instead.
 *
 * 4. MARKINGS ARE ANGULAR FIELDS ABOUT A PER-HEIGHT CENTRE LINE, evaluated from
 *    vertex *position* and thresholded per fragment. Position is symmetric in x
 *    by construction, which is what makes the cream field symmetric; the earlier
 *    normal-derived field inherited every marching-cubes wobble and produced the
 *    ragged asymmetric blob. One smooth field, no `min` against a lateral box,
 *    so there is no hard vertical cut anywhere along the edge.
 *
 * 5. LIMBS HAVE JOINTS. Waist pinch, elbow with a crook, knee with a kneecap
 *    and a popliteal notch, a narrow ankle above a foot scaled to the leg. The
 *    silhouette has to read as an articulated animal at 2m, and a barrel with
 *    flippers does not.
 */

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

// Tuned against the studio key so the *mid-tone* lands on the reference
// #F08030 with the brightest lit pixel below 245 in red, rather than the base
// albedo matching on paper and clipping on screen.
const SKIN = 0xc95307;
const BELLY = 0xe0b761;
const CLAW = 0xb9a582;
const TOOTH = 0xd5c9ae;

/* ------------------------------------------------------------------ */
/* Sculpt hygiene                                                      */
/* ------------------------------------------------------------------ */

/**
 * Guarantees a closed sculpt is wound outward.
 *
 * `metaSurface` now emits correct winding, so this measures positive and
 * returns immediately; it stays as a cheap assertion rather than a fix.
 * Returns the mean of N . normalize(p - centroid): a correctly wound closed
 * surface scores strongly positive, the reversed surface strongly negative.
 */
function fixOutward(geo: THREE.BufferGeometry, label: string): THREE.BufferGeometry {
  const measure = (): number => {
    geo.computeVertexNormals();
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < pos.count; i++) {
      cx += pos.getX(i);
      cy += pos.getY(i);
      cz += pos.getZ(i);
    }
    cx /= pos.count;
    cy /= pos.count;
    cz /= pos.count;
    let sum = 0;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - cx;
      const dy = pos.getY(i) - cy;
      const dz = pos.getZ(i) - cz;
      const l = Math.hypot(dx, dy, dz) || 1;
      sum += (nor.getX(i) * dx + nor.getY(i) * dy + nor.getZ(i) * dz) / l;
    }
    return sum / pos.count;
  };

  if (measure() >= 0) return geo;

  const index = geo.getIndex();
  if (index) {
    const a = index.array as Uint32Array | Uint16Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    index.needsUpdate = true;
  }
  console.warn(`[Charmander] ${label} sculpt needed a winding flip — mesher regression?`);
  return geo;
}

/**
 * Grid-snapped vertex clustering.
 *
 * Marching cubes emits a large fraction of near-degenerate sliver triangles
 * where the isosurface clips a cell corner. Re-welding on a grid slightly
 * coarser than the sampling grid collapses those slivers to nothing; dropping
 * the resulting degenerate faces cuts the triangle count substantially with no
 * visible change to a smooth organic form. Combined with a sampling resolution
 * chosen for the 1–3m viewing distance rather than for a turntable close-up,
 * it is what keeps this character inside its budget.
 */
function weldDecimate(geo: THREE.BufferGeometry, cell: number): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const index = geo.getIndex();
  if (!index) return geo;

  const inv = 1 / cell;
  const map = new Map<string, number>();
  const remap = new Int32Array(pos.count);
  const out: number[] = [];
  const acc: number[] = [];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      out.push(0, 0, 0);
      acc.push(0);
      map.set(key, id);
    }
    // Average the cluster rather than snapping to the grid: snapping produces
    // visible faceting, averaging keeps the smooth surface.
    out[id * 3] += x;
    out[id * 3 + 1] += y;
    out[id * 3 + 2] += z;
    acc[id] += 1;
    remap[i] = id;
  }
  for (let i = 0; i < acc.length; i++) {
    out[i * 3] /= acc[i];
    out[i * 3 + 1] /= acc[i];
    out[i * 3 + 2] /= acc[i];
  }

  const src = index.array;
  const idx: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < src.length; i += 3) {
    const a = remap[src[i]];
    const b = remap[src[i + 1]];
    const c = remap[src[i + 2]];
    if (a === b || b === c || a === c) continue;
    // Drop duplicate faces, which clustering can create where two thin sheets
    // collapse onto each other.
    const k = [a, b, c].slice().sort((p, q) => p - q).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    idx.push(a, b, c);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  geo.dispose();
  return g;
}

/* ------------------------------------------------------------------ */
/* Marking field                                                       */
/* ------------------------------------------------------------------ */

/**
 * A signed scalar sampled per vertex: positive inside the cream marking,
 * negative outside, crossing zero at the boundary. Never thresholded on the
 * CPU — the shader does that per fragment, which is what keeps the edge crisp
 * independently of mesh density.
 */
type MarkField = (
  x: number, y: number, z: number,
  nx: number, ny: number, nz: number,
  i: number,
) => number;

/** Piecewise-linear lookup over a sorted [key, value] table. */
function ramp(table: [number, number][], k: number): number {
  if (k <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (k >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    if (k <= table[i][0]) {
      const [k0, v0] = table[i - 1];
      const [k1, v1] = table[i];
      return lerp(v0, v1, (k - k0) / (k1 - k0));
    }
  }
  return last[1];
}

/**
 * Writes the cavity term into vertex colours and the marking field into a
 * custom attribute. Two separate channels on purpose: the cavity term wants to
 * be smooth and interpolated, the marking wants a threshold, and mixing them
 * into one colour makes both impossible.
 */
function markSculpt(
  geo: THREE.BufferGeometry,
  core: THREE.Vector3,
  field: MarkField,
  aoStrength = 0.26,
  smoothIters = 6,
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  geo.computeBoundingSphere();
  const radius = geo.boundingSphere?.radius ?? 1;

  const colors = new Float32Array(pos.count * 3);
  const mark = new Float32Array(pos.count);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    mark[i] = field(v.x, v.y, v.z, nor.getX(i), nor.getY(i), nor.getZ(i), i);
    const d = clamp(v.distanceTo(core) / radius, 0, 1);
    const ao = lerp(1 - aoStrength, 1, d ** 0.7);
    colors[i * 3] = ao;
    colors[i * 3 + 1] = ao;
    colors[i * 3 + 2] = ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aMark', new THREE.BufferAttribute(mark, 1));
  smoothAttr(geo, 'aMark', smoothIters);
  return geo;
}

/**
 * Laplacian smoothing of a scalar vertex attribute.
 *
 * Even a position-derived field picks up a little stair-stepping from the
 * marching-cubes vertex distribution. A few averaging passes over the edge
 * graph take that out while leaving the field's zero crossing where it was,
 * which is what turns the boundary into a contour you could trace with a pen.
 */
function smoothAttr(geo: THREE.BufferGeometry, name: string, iters: number): void {
  const attr = geo.getAttribute(name) as THREE.BufferAttribute;
  const index = geo.getIndex();
  if (!attr || !index) return;
  const n = attr.count;
  const src = index.array;

  // Build a flat adjacency list once.
  const deg = new Uint16Array(n);
  for (let i = 0; i < src.length; i += 3) {
    deg[src[i]] += 2; deg[src[i + 1]] += 2; deg[src[i + 2]] += 2;
  }
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = new Uint32Array(n);
  const adj = new Uint32Array(start[n]);
  const push = (a: number, b: number) => { adj[start[a] + fill[a]++] = b; };
  for (let i = 0; i < src.length; i += 3) {
    const a = src[i]; const b = src[i + 1]; const c = src[i + 2];
    push(a, b); push(a, c); push(b, a); push(b, c); push(c, a); push(c, b);
  }

  let cur: Float32Array = new Float32Array(attr.array as ArrayLike<number>);
  let next: Float32Array = new Float32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let v = 0; v < n; v++) {
      let sum = cur[v];
      let cnt = 1;
      for (let k = start[v]; k < start[v] + fill[v]; k++) { sum += cur[adj[k]]; cnt++; }
      next[v] = sum / cnt;
    }
    const t = cur; cur = next; next = t;
  }
  (attr.array as Float32Array).set(cur);
  attr.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Flame shells                                                        */
/* ------------------------------------------------------------------ */

interface FlameShell {
  mesh: THREE.Mesh;
  uniforms: { uTime: { value: number }; uAmp: { value: number }; uOpacity: { value: number } };
}

/**
 * One layer of the fire.
 *
 * Opacity is driven by |N.V|, which for a closed shell is a cheap stand-in for
 * how much of the volume the ray passes through: hot and dense through the
 * middle, dissolving to nothing at the silhouette. That single term is the
 * difference between "fire" and "orange cone", and it is also what guarantees
 * no layer can ever show a hard polygon edge.
 *
 * Blending is plain `AdditiveBlending` and the shader outputs a real alpha, so
 * the flame can only ever add light — never darken, never leave an opaque
 * rectangle in the alpha channel for a later pass to composite.
 *
 * The base of the profile has a genuine radius rather than a point, and there
 * is no fade-out at the bottom: the fire has to *sit on* the tail tip, with the
 * hot part of the shell overlapping the ember, or a gap opens up the instant
 * the flame flickers smaller than its rest pose.
 */
function flameShell(
  height: number,
  radius: number,
  hot: number,
  cool: number,
  power: number,
  opacity: number,
  seed: number,
  amp: number,
  lobes = 3.0,
  base = 0.55,
): FlameShell {
  const T = [0.00, 0.06, 0.14, 0.26, 0.40, 0.54, 0.68, 0.80, 0.90, 0.96, 1.00];
  const R = [base, 0.82, 0.97, 1.00, 0.95, 0.85, 0.70, 0.53, 0.34, 0.17, 0.00];
  const profile = T.map((t, i) => new THREE.Vector2(R[i] * radius, t * height));
  const geo = new THREE.LatheGeometry(profile, 26);
  geo.computeVertexNormals();

  const uniforms = {
    uTime: { value: 0 },
    uAmp: { value: amp },
    uOpacity: { value: opacity },
    uHeight: { value: height },
    uSeed: { value: seed },
    uPower: { value: power },
    uLobes: { value: lobes },
    uHot: { value: new THREE.Color(hot) },
    uCool: { value: new THREE.Color(cool) },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uHeight;
      uniform float uSeed;
      uniform float uAmp;
      uniform float uLobes;
      varying vec3 vNrm;
      varying vec3 vDir;
      varying float vH;
      void main() {
        vec3 p = position;
        float h = clamp(p.y / uHeight, 0.0, 1.0);
        vH = h;
        // g pins every deformation to zero at the base. The fire licks and
        // leans at the tip and stays welded to the tail at the root.
        float g = h * h;
        p.x += sin(uTime * 6.1 + p.y * 22.0 + uSeed) * uHeight * 0.062 * g * uAmp;
        p.z += sin(uTime * 4.7 + p.y * 17.0 + uSeed * 1.9 + 2.1) * uHeight * 0.048 * g * uAmp;
        // Travelling radial ripple. Asymmetric lobe counts between shells stop
        // the layers from moving as one rigid body. Amplitudes are deliberately
        // held well under the point where the lathe folds through itself —
        // a folded lathe reads as straight polygonal creases, not as fire.
        float ang = atan(p.z, p.x);
        float rip = sin(ang * uLobes + uTime * 5.4 - p.y * 30.0 + uSeed);
        float rip2 = sin(ang * (uLobes + 2.0) - uTime * 3.1 + p.y * 44.0 + uSeed * 0.7);
        p.xz *= 1.0 + (rip * 0.10 + rip2 * 0.055) * (0.10 + g) * uAmp;
        p.y *= 1.0 + sin(uTime * 7.9 + uSeed) * 0.055 * uAmp;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vNrm = normalize(normalMatrix * normal);
        vDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHot;
      uniform vec3 uCool;
      uniform float uPower;
      uniform float uOpacity;
      varying vec3 vNrm;
      varying vec3 vDir;
      varying float vH;
      void main() {
        float f = abs(dot(normalize(vNrm), normalize(vDir)));
        float a = pow(clamp(f, 0.0, 1.0), uPower);
        a *= smoothstep(1.0, 0.42, vH);        // the top third wisps out
        vec3 c = mix(uHot, uCool, smoothstep(0.06, 0.66, vH));
        gl_FragColor = vec4(c, clamp(a * uOpacity, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 10;
  return { mesh, uniforms };
}

/** A curved, rounded-tip claw. Cones have a sharp apex; the bible forbids it. */
function clawGeometry(len: number, rad: number): THREE.BufferGeometry {
  const T = [0, 0.22, 0.45, 0.68, 0.86, 0.96, 1.0];
  const R = [1.0, 0.95, 0.80, 0.56, 0.30, 0.12, 0.0];
  const geo = new THREE.LatheGeometry(
    T.map((t, i) => new THREE.Vector2(R[i] * rad, t * len)),
    7,
  );
  bendY(geo, -0.62);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Eyes                                                                */
/* ------------------------------------------------------------------ */

interface EyeParts {
  holder: THREE.Group;
  lid: THREE.Mesh;
}

/**
 * One eye, built from scratch rather than through `makeEye`.
 *
 * THE EYE IS A SPHERICAL CAP IN A CRATER, NOT A BALL ON A FACE. The single
 * worst failure this model had was two glossy marbles standing off the skull
 * with a dark angled band over each one — bug-eyed and, in profile, a scowl.
 * Everything here is arranged to stop that happening again:
 *
 *  - The eyeball is SMALL and its centre is placed BEHIND the carved socket
 *    floor by the caller, so only a shallow cap clears the surrounding skin.
 *    Nothing about the eye can protrude as a visible sphere because the sphere
 *    is buried.
 *  - Because only the cap is visible, the iris has to cover almost the whole
 *    cap or a ring of white shows around it and reads as startled sclera. The
 *    iris cap therefore runs out to 0.90 of the ball, and the sclera underneath
 *    is a warm off-white, not a bright one, so any sliver that does show at the
 *    extreme corners is a soft shadow rather than a bloodshot rim.
 *  - The iris is FLAT-ISH and matte: no clearcoat, no envmap, no maps of any
 *    kind, so it cannot pick up speckle. A big black pupil and exactly ONE
 *    small crisp catchlight carry the whole read.
 *  - There is no resting lid geometry at all. The upper fold is a positive
 *    metaball in the sculpt, in skin colour, so the lid is literally made of
 *    the same surface as the face and can never draw a dark band.
 */
function buildEye(radius: number, side: number, splay: number, skinMat: THREE.Material): EyeParts {
  const holder = new THREE.Group();
  holder.rotation.y = side * splay;
  // Slight vertical squash: a perfect circle reads alert, a squashed one reads
  // relaxed. This is also what turns the visible cap into a soft oval.
  holder.scale.y = 0.86;

  const sclera = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 9),
    new THREE.MeshPhysicalMaterial({
      // Deliberately a dim warm grey, not a white. With the ball seated in a
      // socket the only sclera that can ever show is the extreme corner, and it
      // must read as the shadow inside the lid rather than as a ring of white
      // around the iris — a white ring is the whole "startled Muppet" effect.
      color: 0x9c8f80, roughness: 0.68, clearcoat: 0.0, envMapIntensity: 0.06,
    }),
  );
  holder.add(sclera);

  // Iris and pupil ride on their own pivot, counter-rotated so the gaze
  // converges even though the eyeballs themselves splay outward.
  const gaze = new THREE.Group();
  gaze.rotation.y = -side * (splay - 0.020);
  holder.add(gaze);

  // Nearly the whole ball: with the eye seated in a socket the only thing the
  // camera can see is the cap around the +Z pole, and that cap must be iris.
  const IRIS = 0.965;
  const iris = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.004, 14, 8, 0, Math.PI * 2, 0, Math.asin(clamp(IRIS, 0, 1))),
    new THREE.MeshPhysicalMaterial({
      color: 0x2a94a6, roughness: 0.56, clearcoat: 0.0, envMapIntensity: 0.05,
      metalness: 0,
    }),
  );
  iris.rotation.x = Math.PI / 2;
  gaze.add(iris);

  // The pupil must leave a WIDE band of iris all the way round. At 0.66 the
  // black filled the middle of the visible cap and the teal survived only as a
  // thin rim, which reads as a googly donut rather than as an eye. Roughly half
  // the cap is the ratio that keeps the iris colour legible at 2m.
  const pupilR = IRIS * 0.50;
  const pupil = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.01, 14, 7, 0, Math.PI * 2, 0, Math.asin(clamp(pupilR, 0, 1))),
    new THREE.MeshBasicMaterial({ color: 0x130f0e }),
  );
  pupil.rotation.x = Math.PI / 2;
  gaze.add(pupil);

  // Exactly one catchlight, up-left, small and crisp, and deliberately not 255
  // white: the flame core has to own the brightest pixel in every frame.
  const hi = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.150, 7, 5),
    new THREE.MeshBasicMaterial({ color: 0xe8ecf2 }),
  );
  hi.position.set(-radius * 0.30, radius * 0.36, radius * 0.94);
  gaze.add(hi);

  // Blink lid only — a downward dome hung from the top of the eyeball, scaled
  // flat at rest so it contributes nothing at all to the resting expression.
  const LR = radius * 1.06;
  const lidGeo = new THREE.SphereGeometry(LR, 12, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  lidGeo.scale(1, 2.2, 1);
  lidGeo.computeVertexNormals();
  const lid = new THREE.Mesh(lidGeo, skinMat);
  lid.position.y = LR * 0.92;
  lid.scale.y = 0;
  lid.castShadow = false;
  holder.add(lid);

  return { holder, lid };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildCharmander(): Creature {
  const rig = createRig();
  rig.root.name = 'Charmander';

  const skinC = new THREE.Color(SKIN);
  const bellyC = new THREE.Color(BELLY);

  /* ---- Materials --------------------------------------------------- */
  // The marking is applied in the shader from the `aMark` attribute, so the
  // material's own colour is white and the vertex colours carry cavity only.
  const painted = creatureSkin({
    color: 0xffffff, subsurface: 0xb8360a, wrap: 0.05, rim: 0.015,
    roughness: 0.66, detail: 'scales', detailScale: 3.0,
  });
  painted.vertexColors = true;
  painted.clearcoat = 0.06;
  painted.clearcoatRoughness = 0.72;
  painted.sheen = 0.0;
  // The studio set is bright and the environment is a cool grey dome; at any
  // meaningful intensity it lifts the blue channel until the orange goes pink
  // and the lit side clips. Kept near zero deliberately.
  painted.envMapIntensity = 0.05;
  // A white specular lobe at full strength is the other thing lifting the blue
  // channel and clipping the lit side. Warm and weak, so highlights stay inside
  // the orange rather than punching neutral holes in it.
  painted.specularIntensity = 0.30;
  painted.specularColor = new THREE.Color(0xffc59a);
  painted.roughnessMap = null; // its own noise blows out to plastic hotspots
  if (painted.normalScale) painted.normalScale.set(0.20, 0.20);

  // Chain the marking patch on top of creatureSkin's own patch rather than
  // replacing it — the scatter and rim terms still have to run.
  const baseCompile = painted.onBeforeCompile;
  painted.onBeforeCompile = (shader, renderer) => {
    baseCompile?.call(painted, shader, renderer);
    shader.uniforms.uSkin = { value: skinC };
    shader.uniforms.uBelly = { value: bellyC };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMark;\nvarying float vMark;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vMark;\nuniform vec3 uSkin;\nuniform vec3 uBelly;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        // Threshold the interpolated signed marking field per fragment. The
        // field is an angle in radians, so a fixed-width smoothstep around zero
        // gives a soft, near-constant-width transition regardless of how the
        // marching-cubes vertices happen to fall.
        {
          float w = fwidth(vMark) * 1.5 + 0.048;
          float m = smoothstep(-w, w, vMark);
          diffuseColor.rgb *= mix(uSkin, uBelly, m);
        }
        `,
      );
  };
  painted.customProgramCacheKey = () => 'charmander|marked';

  // Flat variant for the eyelids — same look, no attribute requirement.
  const plainSkin = creatureSkin({
    color: SKIN, subsurface: 0xb8360a, wrap: 0.05, rim: 0.015,
    roughness: 0.66, detail: 'none',
  });
  plainSkin.clearcoat = 0.06;
  plainSkin.sheen = 0.0;
  plainSkin.envMapIntensity = 0.05;

  // Keratin: dense and matte-waxy, clearly not the skin's soft sheen and
  // clearly not the wet plastic the claws used to be.
  const clawMat = new THREE.MeshPhysicalMaterial({
    color: CLAW, roughness: 0.48, clearcoat: 0.22, clearcoatRoughness: 0.45, metalness: 0,
    sheen: 0.12, sheenRoughness: 0.9,
  });
  const toothMat = new THREE.MeshPhysicalMaterial({
    color: TOOTH, roughness: 0.42, clearcoat: 0.20, clearcoatRoughness: 0.4, metalness: 0,
  });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x4a1a12, roughness: 0.78 });
  const nostrilMat = new THREE.MeshStandardMaterial({ color: 0x6e2a0e, roughness: 0.8 });

  /* ---- Body -------------------------------------------------------- */
  // Chest -> waist -> belly -> hips, so the torso has an hourglass rather than
  // being one barrel. Arms run shoulder / upper arm / elbow / forearm / wrist /
  // palm, legs run thigh / kneecap / shin / ankle / foot. Every one of those
  // joints exists because the black-shape test needs something to read.
  const bodyBalls: Ball[] = [
    { x: 0, y: 0.360, z: -0.004, r: 0.050, sy: 0.90 },                     // neck
    { x: 0, y: 0.312, z: 0.010, r: 0.094, sx: 1.00, sy: 0.92, sz: 0.90 },  // chest
    { x: 0, y: 0.262, z: 0.014, r: 0.079, sx: 0.94, sy: 0.86, sz: 0.92 },  // WAIST
    { x: 0, y: 0.212, z: 0.014, r: 0.097, sx: 1.00, sy: 0.90, sz: 0.98 },  // belly
    { x: 0, y: 0.156, z: -0.002, r: 0.094, sx: 1.06, sy: 0.78, sz: 0.96 }, // hips
    { x: 0, y: 0.172, z: -0.068, r: 0.056, sz: 1.10 },                     // tail root
    // Waist pinch. Two flank carves rather than a smaller ball, so the front
    // of the belly keeps its roundness and only the silhouette narrows.
    { x: 0.104, y: 0.264, z: 0.012, r: 0.052, sx: 0.90, sy: 1.25, sz: 1.05, strength: -0.54 },
    { x: -0.104, y: 0.264, z: 0.012, r: 0.052, sx: 0.90, sy: 1.25, sz: 1.05, strength: -0.54 },
    // neck notch — cuts the jaw free of the chest so the side silhouette has
    // a concave break under the jawline instead of one fused mass
    { x: 0, y: 0.400, z: -0.020, r: 0.082, sy: 0.28, strength: -0.62 },

    // arms: shoulder -> upper arm -> elbow -> forearm -> wrist -> palm
    { x: 0.088, y: 0.306, z: 0.004, r: 0.040 },
    { x: -0.088, y: 0.306, z: 0.004, r: 0.040 },
    { x: 0.119, y: 0.282, z: 0.006, r: 0.030 },
    { x: -0.119, y: 0.282, z: 0.006, r: 0.030 },
    { x: 0.139, y: 0.254, z: 0.017, r: 0.027 },                            // elbow
    { x: -0.139, y: 0.254, z: 0.017, r: 0.027 },
    { x: 0.151, y: 0.230, z: 0.040, r: 0.024 },                            // forearm
    { x: -0.151, y: 0.230, z: 0.040, r: 0.024 },
    { x: 0.157, y: 0.213, z: 0.060, r: 0.020 },                            // wrist
    { x: -0.157, y: 0.213, z: 0.060, r: 0.020 },
    { x: 0.159, y: 0.203, z: 0.078, r: 0.030, sy: 0.72, sz: 0.90 },        // palm
    { x: -0.159, y: 0.203, z: 0.078, r: 0.030, sy: 0.72, sz: 0.90 },
    // crook of the elbow, and a notch where the shoulder meets the ribs, so
    // the arm reads as a limb hung off the body rather than a fused stump
    { x: 0.127, y: 0.246, z: 0.036, r: 0.019, strength: -0.32 },
    { x: -0.127, y: 0.246, z: 0.036, r: 0.019, strength: -0.32 },
    { x: 0.084, y: 0.272, z: 0.012, r: 0.029, sx: 0.7, sy: 1.15, strength: -0.30 },
    { x: -0.084, y: 0.272, z: 0.012, r: 0.029, sx: 0.7, sy: 1.15, strength: -0.30 },

    // legs: thigh -> knee -> shin -> ankle
    { x: 0.076, y: 0.130, z: -0.002, r: 0.056, sy: 1.00 },
    { x: -0.076, y: 0.130, z: -0.002, r: 0.056, sy: 1.00 },
    { x: 0.079, y: 0.090, z: 0.014, r: 0.040 },                            // knee
    { x: -0.079, y: 0.090, z: 0.014, r: 0.040 },
    { x: 0.080, y: 0.084, z: 0.033, r: 0.022, strength: 0.58 },            // kneecap
    { x: -0.080, y: 0.084, z: 0.033, r: 0.022, strength: 0.58 },
    { x: 0.079, y: 0.108, z: 0.030, r: 0.019, sy: 0.7, strength: -0.28 },  // crease above the kneecap
    { x: -0.079, y: 0.108, z: 0.030, r: 0.019, sy: 0.7, strength: -0.28 },
    { x: 0.079, y: 0.093, z: -0.028, r: 0.028, strength: -0.44 },          // popliteal notch
    { x: -0.079, y: 0.093, z: -0.028, r: 0.028, strength: -0.44 },
    { x: 0.081, y: 0.062, z: 0.018, r: 0.032 },                            // shin
    { x: -0.081, y: 0.062, z: 0.018, r: 0.032 },
    { x: 0.082, y: 0.038, z: 0.012, r: 0.023 },                            // ANKLE — narrow
    { x: -0.082, y: 0.038, z: 0.012, r: 0.023 },

    // feet: scaled to the leg, not to a flipper. Heel pad back, ball forward.
    { x: 0.082, y: 0.017, z: -0.008, r: 0.027, sy: 0.58, sz: 0.84 },       // heel
    { x: -0.082, y: 0.017, z: -0.008, r: 0.027, sy: 0.58, sz: 0.84 },
    { x: 0.084, y: 0.016, z: 0.030, r: 0.031, sy: 0.50, sz: 1.00 },        // ball
    { x: -0.084, y: 0.016, z: 0.030, r: 0.031, sy: 0.50, sz: 1.00 },
    // ankle undercut: without it the shin and the foot fuse into a boot
    { x: 0.082, y: 0.036, z: -0.026, r: 0.024, sy: 0.9, strength: -0.34 },
    { x: -0.082, y: 0.036, z: -0.026, r: 0.024, sy: 0.9, strength: -0.34 },

    // crotch notch — keeps the legs from fusing into a single column
    { x: 0, y: 0.072, z: 0.008, r: 0.052, sx: 0.42, sz: 1.4, strength: -0.60 },
  ];

  // Toes and fingers, mirrored. Digits are real sculpted volumes with the
  // claws sitting on their tips, not claws glued to a mitten.
  const FINGER: number[] = [-0.36, 0, 0.36];
  const fingerTips: THREE.Vector3[] = [];
  const toeTips: THREE.Vector3[] = [];
  for (const s of [1, -1]) {
    // hand — three short capsules splayed off the palm
    for (const spread of FINGER) {
      const dx = Math.sin(spread);
      const dz = Math.cos(spread);
      bodyBalls.push({ x: s * (0.159 + dx * 0.018), y: 0.200, z: 0.078 + dz * 0.018, r: 0.0115 });
      bodyBalls.push({ x: s * (0.159 + dx * 0.032), y: 0.198, z: 0.078 + dz * 0.032, r: 0.0100 });
      fingerTips.push(new THREE.Vector3(s * (0.159 + dx * 0.041), 0.196, 0.078 + dz * 0.041));
      // split between fingers so the hand is not a mitten
      if (spread < 0.3) {
        bodyBalls.push({
          x: s * (0.159 + Math.sin(spread + 0.18) * 0.027), y: 0.199,
          z: 0.078 + Math.cos(spread + 0.18) * 0.027,
          r: 0.0105, sx: 0.5, sy: 1.1, strength: -0.34,
        });
      }
    }
    // foot — three forward toes off the ball of the foot
    for (const off of [-1, 0, 1]) {
      const px = 0.084 + off * 0.021;
      bodyBalls.push({ x: s * px, y: 0.015, z: 0.058, r: 0.0148, sy: 0.66, sz: 1.20 });
      bodyBalls.push({ x: s * (px + off * 0.006), y: 0.014, z: 0.080, r: 0.0118, sy: 0.62 });
      toeTips.push(new THREE.Vector3(s * (px + off * 0.010), 0.016, 0.093));
      // split between toes
      if (off < 1) {
        bodyBalls.push({
          x: s * (px + 0.0105), y: 0.015, z: 0.072, r: 0.013, sx: 0.40, sz: 1.6, strength: -0.46,
        });
      }
    }
  }

  // Resolution is chosen for a 0.5m character seen at 1–3m, not for a
  // turntable close-up. Past this the marching-cubes grid is finer than a
  // screen pixel and every extra triangle is invisible.
  const BODY_RES = 59;
  let bodyGeo = metaSurface(bodyBalls, { resolution: BODY_RES, smooth: 0.86, padding: 0.026 });
  fixOutward(bodyGeo, 'body');
  bodyGeo = weldDecimate(bodyGeo, 0.0105);
  bodyGeo.setAttribute('uv', boxProjectedUV(bodyGeo, 17));

  // ---- Cream field, torso ----
  // Angle about a per-height centre line, measured from straight ahead. Angles
  // taken from POSITION are exactly symmetric in x, which is the whole point:
  // the previous normal-derived field inherited the mesher's per-cell wobble
  // and came out as a ragged, off-centre blob. The half-width tapers to zero at
  // the throat and at the crotch, so the field closes itself top and bottom and
  // never needs a lateral clamp — which is what used to cut the hard vertical
  // edge down the side of the belly.
  const TORSO_AXIS: [number, number][] = [
    [0.030, 0.004], [0.100, 0.000], [0.156, -0.002], [0.212, 0.014],
    [0.262, 0.014], [0.312, 0.010], [0.400, -0.004],
  ];
  // Deliberately an oval, not a column: the half-width has to be changing at
  // every height or the boundary runs as a straight vertical line down the
  // flank and the cream reads as a painted stripe rather than as the animal's
  // underside.
  const TORSO_HALF: [number, number][] = [
    [0.030, 0.00],
    [0.066, 0.34],
    [0.112, 0.58],
    [0.158, 0.74],
    [0.206, 0.82],
    [0.252, 0.80],
    [0.298, 0.70],
    [0.344, 0.54],
    [0.390, 0.32],
    [0.428, 0.00],
  ];
  const bodyMark: MarkField = (x, y, z) =>
    ramp(TORSO_HALF, y) - Math.abs(Math.atan2(x, z - ramp(TORSO_AXIS, y)));
  markSculpt(bodyGeo, new THREE.Vector3(0, 0.22, 0), bodyMark, 0.22, 7);

  const body = new THREE.Mesh(bodyGeo, painted);
  body.castShadow = true;
  body.receiveShadow = true;
  rig.body.add(body);

  /* ---- Claws ------------------------------------------------------- */
  // Sunk into the fingertip so the nail bed is buried in the digit and the
  // claw stops casting a detached shadow of its own. Toe claws are pitched
  // past vertical so they point forward AND DOWN into the ground, the way a
  // weight-bearing claw does — straight-ahead claws read as plastic spikes.
  const handClaw = clawGeometry(0.023, 0.0068);
  const footClaw = clawGeometry(0.024, 0.0080);

  for (let i = 0; i < fingerTips.length; i++) {
    const p = fingerTips[i];
    const c = new THREE.Mesh(handClaw, clawMat);
    c.position.copy(p).add(new THREE.Vector3(0, -0.001, -0.007));
    c.rotation.set(Math.PI * 0.56, 0, ((i % 3) - 1) * 0.30 * Math.sign(p.x));
    c.castShadow = true;
    rig.body.add(c);
  }
  for (const p of toeTips) {
    const c = new THREE.Mesh(footClaw, clawMat);
    c.position.copy(p).add(new THREE.Vector3(0, 0.001, -0.009));
    c.rotation.set(Math.PI * 0.63, 0, 0);
    c.castShadow = true;
    rig.body.add(c);
  }

  /* ---- Head -------------------------------------------------------- */
  // A ROUNDED WEDGE. Read the profile back to front: the back of the skull is
  // near vertical, the cranium is tall and domed, it falls to a defined
  // jawline, and the snout is SHORT with its tip sitting HIGHER than its root.
  // The failure mode this replaces is a smooth teardrop trailing backward with
  // a muzzle drooping forward and down — an E.T. profile, not a lizard's.
  rig.head.position.set(0, 0.448, 0.004);

  // Mouth line: a wide, gently upturned arc that WRAPS the muzzle. z falls away
  // with the angle so the corners follow the narrowing sides of the snout
  // instead of hanging in the air off the front of it, which is what turns a
  // painted line into a real lip that has a near side and a far side.
  const mouthPoint = (a: number): THREE.Vector3 =>
    new THREE.Vector3(
      Math.sin(a) * 0.051,
      -0.035 + (1 - Math.cos(a)) * 0.043,
      0.130 - (1 - Math.cos(a)) * 0.074,
    );

  const headBalls: Ball[] = [
    { x: 0, y: 0.024, z: 0.002, r: 0.086, sx: 1.05, sy: 1.00, sz: 0.80 },    // cranium — tall dome
    { x: 0, y: 0.008, z: -0.038, r: 0.050, sy: 0.96, sz: 0.62 },             // occiput — vertical back
    // Glabella. The two socket carves sit close enough that the field between
    // them dips, and that dip renders as a hard V-shaped ridge across the
    // bridge of the nose — a frown, which is exactly the expression the brief
    // says to get rid of. This fills it back in so the forehead runs smooth
    // from one eye to the other. Narrower now that the eyes sit closer in.
    { x: 0, y: 0.034, z: 0.050, r: 0.031, sx: 0.96, sy: 0.86, sz: 0.72, strength: 0.68 },
    { x: 0.055, y: 0.018, z: -0.002, r: 0.048, sy: 0.94 },                   // temples — widest point
    { x: -0.055, y: 0.018, z: -0.002, r: 0.048, sy: 0.94 },
    { x: 0.050, y: -0.028, z: 0.018, r: 0.043, sz: 0.98 },                   // cheeks — narrower than the temples
    { x: -0.050, y: -0.028, z: 0.018, r: 0.043, sz: 0.98 },

    // ---- THE MUZZLE ----------------------------------------------------
    // A real projecting snout in four steps, each one narrower than the last
    // and each one sitting HIGHER than the last so the whole muzzle tips up.
    // The failure this replaces is a flat face with two nostril dents: there
    // was no forward volume at all, so there was nothing for the mouth line to
    // sit on and nothing to cast a shadow under the jaw.
    { x: 0, y: -0.024, z: 0.050, r: 0.051, sx: 0.90, sy: 0.84, sz: 0.94 },   // muzzle root
    { x: 0, y: -0.022, z: 0.083, r: 0.040, sx: 0.76, sy: 0.74, sz: 0.92 },   // muzzle mid
    { x: 0, y: -0.013, z: 0.109, r: 0.031, sx: 0.68, sy: 0.66, sz: 0.80 },   // snout — UPTURNED
    { x: 0, y: 0.000, z: 0.121, r: 0.021, sx: 0.58, sy: 0.50, sz: 0.62 },    // nose pad, above the tip
    // Bridge: a soft raised line from the glabella out to the nose pad, so the
    // top of the muzzle is a form and not a dent between two eye sockets.
    { x: 0, y: 0.012, z: 0.088, r: 0.020, sx: 0.52, sy: 0.48, sz: 1.15, strength: 0.44 },
    // The crease where the muzzle leaves the cheek. This is the single edge that
    // makes the snout read as a separate volume from the front. Deeper and
    // longer than before: it is what separates snout from face in flat light.
    { x: 0.043, y: -0.016, z: 0.066, r: 0.019, sx: 0.80, sy: 1.40, sz: 0.90, strength: -0.32 },
    { x: -0.043, y: -0.016, z: 0.066, r: 0.019, sx: 0.80, sy: 1.40, sz: 0.90, strength: -0.32 },

    // ---- LOWER JAW -----------------------------------------------------
    { x: 0, y: -0.054, z: 0.026, r: 0.045, sx: 0.98, sy: 0.54, sz: 1.02 },   // jaw
    { x: 0, y: -0.051, z: 0.076, r: 0.033, sx: 0.82, sy: 0.50, sz: 0.94 },   // lower lip mass
    { x: 0, y: -0.046, z: 0.106, r: 0.024, sx: 0.66, sy: 0.44, sz: 0.72 },   // chin, tucked under the snout
    // Jawline: a shallow crease under the cheekbone, carried forward to the
    // corner of the mouth so the lower jaw has an edge you can find in shadow.
    { x: 0.048, y: -0.038, z: 0.024, r: 0.023, sx: 0.7, sy: 0.34, sz: 1.30, strength: -0.32 },
    { x: -0.048, y: -0.038, z: 0.024, r: 0.023, sx: 0.7, sy: 0.34, sz: 1.30, strength: -0.32 },
    { x: 0.034, y: -0.044, z: 0.080, r: 0.016, sx: 0.7, sy: 0.36, sz: 1.05, strength: -0.20 },
    { x: -0.034, y: -0.044, z: 0.080, r: 0.016, sx: 0.7, sy: 0.36, sz: 1.05, strength: -0.20 },

    // Kill the backward teardrop: carve behind and below the occiput so the
    // back of the skull drops away vertically into the neck.
    { x: 0, y: -0.014, z: -0.058, r: 0.052, sy: 1.20, sz: 0.85, strength: -0.62 },

    // ---- EYE SOCKETS ---------------------------------------------------
    // Deep, tight craters set CLOSER TOGETHER and HIGHER than before. The eye
    // ball is seated behind the socket floor by the caller so only a cap
    // clears the skin; that is only possible if the crater is genuinely deep,
    // hence -0.92 rather than the timid -0.54 that left the eyes standing off
    // the face like headlights.
    // A wide, shallow almond rather than a round pit: a circular crater leaves a
    // circular rim, and a circular rim above the eye renders as a drawn wrinkle
    // arc on the forehead. Flattening it in y and stretching it in x puts the
    // rim tight against the lid where it belongs.
    { x: 0.0385, y: 0.0275, z: 0.0500, r: 0.0285, sx: 1.14, sy: 0.74, sz: 0.86, strength: -0.66 },
    { x: -0.0385, y: 0.0275, z: 0.0500, r: 0.0285, sx: 1.14, sy: 0.74, sz: 0.86, strength: -0.66 },
    // Upper lid fold: a soft positive ridge in SKIN, wider than the eye and
    // level rather than angled. This is the whole of the lid — a thin fold of
    // face, never a dark band, and never a brow bar. Strength is deliberately
    // LOW: at 0.40 the fold's outer edge met the socket rim and rendered as a
    // hard arc across the forehead — a pair of frown wrinkles, which is the one
    // expression this face must not have.
    { x: 0.0385, y: 0.0485, z: 0.046, r: 0.019, sx: 1.30, sy: 0.36, sz: 0.68, strength: 0.22 },
    { x: -0.0385, y: 0.0485, z: 0.046, r: 0.019, sx: 1.30, sy: 0.36, sz: 0.68, strength: 0.22 },
    // Lower lid: a whisper of cheek pushed up under the eye, which is what
    // makes a small eye read as warm rather than beady.
    { x: 0.0385, y: 0.0085, z: 0.0495, r: 0.017, sx: 1.15, sy: 0.40, sz: 0.70, strength: 0.26 },
    { x: -0.0385, y: 0.0085, z: 0.0495, r: 0.017, sx: 1.15, sy: 0.40, sz: 0.70, strength: 0.26 },

    // neck notch, matching the body's
    { x: 0, y: -0.055, z: -0.036, r: 0.082, sy: 0.28, strength: -0.62 },
    // nostril dents — on top of the upturned nose pad, mirrored in x
    { x: 0.0120, y: 0.008, z: 0.127, r: 0.0075, strength: -0.55 },
    { x: -0.0120, y: 0.008, z: 0.127, r: 0.0075, strength: -0.55 },
  ];
  // Mouth slot — a chain of flattened negative balls following the arc, cut
  // deep enough to be a genuine crease with an interior rather than a line.
  // A finer crease than before: at -0.68 with a 0.24 y-squash the slot opened
  // into a wide dark trough that read as a heavy frowning lip from the front.
  // Shallower and thinner turns it back into a drawn line that still has real
  // depth at the corners.
  for (let i = 0; i <= 20; i++) {
    const a = lerp(-1.24, 1.24, i / 20);
    const p = mouthPoint(a);
    // The corners cut deeper than the middle. A constant-depth slot fades out
    // where it wraps onto the side of the muzzle, so the line looked like a
    // short dash across the tip instead of a mouth that runs the width of the
    // face and turns up at each end.
    const k = Math.abs(a) / 1.24;
    headBalls.push({
      x: p.x, y: p.y, z: p.z,
      r: lerp(0.0150, 0.0175, k), sy: 0.20, sz: 0.60,
      strength: -lerp(0.50, 0.78, k * k),
    });
  }

  const HEAD_RES = 66;
  let headGeo = metaSurface(headBalls, { resolution: HEAD_RES, smooth: 0.92, padding: 0.024 });
  fixOutward(headGeo, 'head');
  headGeo = weldDecimate(headGeo, 0.0080);
  headGeo.setAttribute('uv', boxProjectedUV(headGeo, 17));

  // Cream wraps under the jaw and up the throat to meet the body's belly band.
  // Same construction as the torso: an angle about a centre line, this time
  // measured from straight DOWN, with a fore-aft window that closes the field
  // before it can climb the muzzle (a pelican's bill) or the nape (a bib).
  const THROAT_HALF: [number, number][] = [
    [-0.060, 0.00], [-0.026, 0.42], [0.012, 0.74], [0.056, 0.76],
    [0.092, 0.58], [0.116, 0.24], [0.134, 0.00],
  ];
  const headMark: MarkField = (x, y, z) =>
    ramp(THROAT_HALF, z) - Math.abs(Math.atan2(x, 0.004 - y));
  markSculpt(headGeo, new THREE.Vector3(0, 0, 0.01), headMark, 0.20, 6);

  const head = new THREE.Mesh(headGeo, painted);
  head.castShadow = true;
  head.receiveShadow = true;
  rig.head.add(head);

  /* ---- Eyes -------------------------------------------------------- */
  // SMALL, CLOSE, HIGH, AND SUNK. The radius is two thirds of what it was, the
  // pair is 26% closer together, they sit 7mm higher, and — the part that
  // actually fixes the bug-eyed read — the centre z is BEHIND the socket floor,
  // so the head's own surface clips the ball and only a shallow cap of iris is
  // ever visible. Nothing here can render as a protruding sphere.
  const EYE_R = 0.0200;
  for (const s of [1, -1]) {
    const { holder, lid } = buildEye(EYE_R, s, 0.10, plainSkin);
    holder.position.set(s * 0.0385, 0.0290, 0.0482);
    rig.head.add(holder);
    rig.eyes.push(holder);
    rig.eyelids.push(lid);
  }

  /* ---- Mouth interior, teeth, nostrils ----------------------------- */
  // A dark lens sitting just inside the slot. The slot itself is a deep crease
  // in the sculpt; this is what makes the gap read as depth rather than as a
  // painted line, and it never protrudes past the lip.
  const inner = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), mouthMat);
  // Sunk well behind the lip line. Previously it stood proud of the snout and
  // rendered as a dark brown blob on the tip of the muzzle — a smear, not a
  // mouth. It must only ever be glimpsed through the crease.
  inner.scale.set(0.036, 0.0062, 0.014);
  inner.position.set(0, -0.0325, 0.1085);
  inner.rotation.x = -0.10;
  rig.head.add(inner);

  for (const s of [1, -1]) {
    // Two small fangs, and small is the whole point: any bigger and the
    // friendly smile turns into a snarl.
    const tooth = new THREE.Mesh(clawGeometry(0.0042, 0.0021), toothMat);
    tooth.position.set(s * 0.0215, -0.0275, 0.1235);
    tooth.rotation.set(Math.PI * 0.97, 0, s * 0.20);
    rig.head.add(tooth);

    const n = new THREE.Mesh(new THREE.SphereGeometry(0.0037, 8, 6), nostrilMat);
    n.position.set(s * 0.0120, 0.0075, 0.1305);
    n.scale.set(1, 0.85, 0.55);
    rig.head.add(n);
  }

  /* ---- Tail -------------------------------------------------------- */
  // The tail leaves the hips, DROPS below them, then sweeps back, out to the
  // character's left and up. That drop is what gets the flame off the skull:
  // the flame base ends up behind the shoulder line and a full head-width
  // clear of the head in x as well as z.
  const tail = new THREE.Group();
  tail.position.set(0, 0.172, -0.068);
  rig.body.add(tail);
  rig.tail = tail;

  // The sweep is now much wider in x. Previously the flame rose almost directly
  // behind the skull and read as an antenna; the tip is carried a full
  // body-width out to the character's left so the fire clears the silhouette
  // completely from the front and, more importantly, so the TAIL ITSELF is a
  // visible tapering limb beside the hip rather than a hidden stub.
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.022, -0.034, -0.052),
    new THREE.Vector3(0.066, -0.056, -0.104),
    new THREE.Vector3(0.128, -0.034, -0.148),
    new THREE.Vector3(0.186, 0.032, -0.170),
    new THREE.Vector3(0.220, 0.108, -0.172),
    new THREE.Vector3(0.230, 0.160, -0.164),
  ]);
  const TAIL_SEG = 27;
  const TAIL_RAD = 12;
  const TAIL_R0 = 0.054;
  const TAIL_TIP = 0.28;
  const tailEase = (t: number): number => t ** 1.55;
  const tailGeo = new THREE.TubeGeometry(tailCurve, TAIL_SEG, TAIL_R0, TAIL_RAD, false);
  taperTube(tailGeo, tailCurve, TAIL_SEG + 1, TAIL_RAD + 1, 1.0, TAIL_TIP, tailEase);
  tailGeo.setAttribute('uv', boxProjectedUV(tailGeo, 17));

  // "Down" on an arcing tail is not a fixed world vector — it rotates with the
  // spine. Derive it per ring from the tangent so the cream stays on the
  // genuine underside instead of drifting onto the inner face.
  const perRing = TAIL_RAD + 1;
  const ringDown: THREE.Vector3[] = [];
  const down = new THREE.Vector3(0, -1, 0);
  for (let i = 0; i <= TAIL_SEG; i++) {
    const T = tailCurve.getTangent(i / TAIL_SEG).normalize();
    const d = down.clone().addScaledVector(T, -down.dot(T));
    ringDown.push(d.lengthSq() < 1e-8 ? new THREE.Vector3(0, -1, 0) : d.normalize());
  }
  // The cream runs the WHOLE length of the underside and only lets go where the
  // tip goes incandescent. Stopping it a third of the way along left the tail
  // reading as a featureless orange tube.
  const TAIL_HALF: [number, number][] = [
    [0.00, 0.60], [0.12, 0.78], [0.35, 0.86], [0.62, 0.84],
    [0.82, 0.66], [0.93, 0.36], [1.00, 0.00],
  ];
  const tailMark: MarkField = (_x, _y, _z, nx, ny, nz, i) => {
    const ring = Math.min(TAIL_SEG, Math.floor(i / perRing));
    const d = ringDown[ring];
    const dn = clamp(nx * d.x + ny * d.y + nz * d.z, -1, 1);
    return ramp(TAIL_HALF, ring / TAIL_SEG) - Math.acos(dn);
  };
  markSculpt(tailGeo, new THREE.Vector3(0.02, -0.02, -0.11), tailMark, 0.18, 5);

  const tailMesh = new THREE.Mesh(tailGeo, painted);
  tailMesh.castShadow = true;
  tailMesh.receiveShadow = true;
  tail.add(tailMesh);

  /* ---- Tail tip ember ---------------------------------------------- */
  // A thin additive sheath over the last quarter of the tail, ramping from
  // nothing to white-hot at the very end. Two jobs: it drives the tip toward
  // incandescent instead of leaving it flat orange, and it physically bridges
  // the tail and the flame so there is no gap between them at any point in the
  // flicker cycle. Additive over the skin, so it can only add heat.
  const EMBER_T0 = 0.74;
  const emberCurve = new THREE.CatmullRomCurve3(
    Array.from({ length: 7 }, (_, i) => tailCurve.getPoint(lerp(EMBER_T0, 1.0, i / 6))),
  );
  const EMB_SEG = 10;
  const EMB_RAD = 10;
  const emberGeo = new THREE.TubeGeometry(emberCurve, EMB_SEG, TAIL_R0, EMB_RAD, false);
  taperTube(
    emberGeo, emberCurve, EMB_SEG + 1, EMB_RAD + 1,
    lerp(1.0, TAIL_TIP, tailEase(EMBER_T0)) * 1.14,
    TAIL_TIP * 1.42,
    (t) => t ** 1.1,
  );
  const emberUniforms = { uHeat: { value: 1.0 } };
  const emberMat = new THREE.ShaderMaterial({
    uniforms: emberUniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vNrm; varying vec3 vDir;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNrm = normalize(normalMatrix * normal);
        vDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uHeat;
      varying vec2 vUv; varying vec3 vNrm; varying vec3 vDir;
      void main() {
        float t = smoothstep(0.02, 1.0, vUv.x);
        float g = pow(t, 1.7);
        // Ember colour: dull orange where the heat starts, white at the tip.
        vec3 c = mix(vec3(1.0, 0.36, 0.05), vec3(1.0, 0.97, 0.90), pow(t, 2.2));
        // Facing weight keeps the sheath from glowing as a flat uniform decal.
        float f = 0.45 + 0.55 * abs(dot(normalize(vNrm), normalize(vDir)));
        gl_FragColor = vec4(c, clamp(g * f * uHeat, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    toneMapped: true,
  });
  const ember = new THREE.Mesh(emberGeo, emberMat);
  ember.renderOrder = 9;
  ember.castShadow = false;
  tail.add(ember);

  /* ---- Flame ------------------------------------------------------- */
  const flameGroup = new THREE.Group();
  // Seated INTO the tip rather than balanced on it. The flame's fat base
  // (0.55 of its radius) swallows the last centimetre of the ember, so the two
  // are continuous from every angle and stay continuous when the flame
  // flickers down to 80% of its rest height.
  flameGroup.position.copy(tailCurve.getPoint(1.0)).add(new THREE.Vector3(0, -0.016, 0.002));
  tail.add(flameGroup);

  // Scaled down from 0.25: at that height the fire was as tall as the torso and
  // its white core swallowed the tail tip, so the character read as a candle
  // rather than as a lizard carrying a flame. The core opacity comes down too —
  // the hottest part should be a small bright heart inside an orange body, not
  // a blown-out white lozenge.
  const FH = 0.205;
  const shells: FlameShell[] = [
    // Wide soft halo. This replaces the glow billboard entirely: a sprite has
    // corners and an alpha rectangle, a Fresnel-dissolved shell has neither.
    flameShell(FH * 1.22, 0.106, 0xff8a34, 0xd8500e, 2.9, 0.28, 1.3, 0.55, 2.0, 0.42),
    flameShell(FH, 0.068, 0xff7d16, 0xe64a08, 1.35, 0.80, 0.0, 1.00, 3.0),
    flameShell(FH * 0.86, 0.048, 0xffc23e, 0xff7412, 1.75, 0.82, 2.4, 0.86, 4.0),
    flameShell(FH * 0.60, 0.030, 0xfff6e2, 0xffc75e, 1.55, 0.70, 5.1, 0.70, 5.0),
  ];
  // A fifth, narrow tongue at a different lobe count and phase. Its only job is
  // to break the closed lathe's outline so the fire is not a solid cone as a
  // black shape. It is NOT rotated off-axis — the previous version was, and
  // rotating a heavily deformed lathe is what folded it into the straight
  // polygonal edges the review caught.
  shells.push(flameShell(FH * 1.06, 0.032, 0xffab2e, 0xff6a10, 1.9, 0.48, 3.7, 1.20, 7.0, 0.30));
  for (const s of shells) flameGroup.add(s.mesh);

  // ---- The flame is a light source --------------------------------
  // Near field: bright and tight, so the underside of the tail, the backs of
  // the legs and the hip all pick up a genuine orange bounce.
  const flameLight = new THREE.PointLight(0xff7a1e, 1.9, 3.4, 2);
  flameLight.position.y = FH * 0.26;
  flameLight.castShadow = false;
  flameGroup.add(flameLight);

  // Far field: dimmer, much longer range, and hung low so it throws a warm
  // pool onto the ground under and behind the character rather than only
  // lighting the model.
  const spillLight = new THREE.PointLight(0xff9840, 1.3, 6.0, 2);
  spillLight.position.y = -FH * 0.10;
  spillLight.castShadow = false;
  flameGroup.add(spillLight);

  /* ---- Performance ------------------------------------------------- */
  const anim = new IdleAnimator(rig, 22);
  const rnd = makeRng(303);
  let attention = 0;
  let flickAccum = 0;
  let flick = 1;
  let flick2 = 1;

  return {
    id: 'charmander',
    name: 'Charmander',
    group: rig.root,
    get attention() { return attention; },
    set attention(v: number) { attention = clamp(v, 0, 1); },
    update(dt, elapsed) {
      anim.update(dt, elapsed, attention);

      // The tail counter-sways against the body — it balances the character.
      tail.rotation.y = Math.sin(elapsed * 0.82) * (0.09 + attention * 0.09);
      tail.rotation.x = Math.sin(elapsed * 1.1 + 0.6) * 0.045;

      // Fire is stochastic: a fast random walk, plus a slower second walk so
      // the flame surges and settles instead of buzzing at one frequency.
      flickAccum += dt;
      if (flickAccum > 0.04) {
        flickAccum = 0;
        flick = lerp(flick, 0.86 + rnd() * 0.30, 0.6);
        flick2 = lerp(flick2, 0.78 + rnd() * 0.46, 0.12);
      }
      const s = flick * lerp(1, flick2, 0.45) * (1 + attention * 0.22);
      flameGroup.scale.set(lerp(1, s, 0.34), lerp(1, s, 0.92), lerp(1, s, 0.34));
      flameGroup.rotation.z = Math.sin(elapsed * 3.7) * 0.07;
      flameGroup.rotation.x = Math.sin(elapsed * 2.9 + 1.1) * 0.05;

      for (const sh of shells) {
        sh.uniforms.uTime.value = elapsed;
        sh.uniforms.uAmp.value = 1 + (s - 1) * 0.6;
      }

      // Light, ember and shape all ride the SAME scalar, so the character is
      // lit brightest at exactly the frames where the fire is biggest. Driving
      // them independently is what makes CG fire look like a looping texture.
      emberUniforms.uHeat.value = 0.72 + (s - 1) * 0.9;
      flameLight.intensity = 1.5 * s + 0.45;
      spillLight.intensity = 0.9 * s + 0.28;
    },
    celebrate: () => anim.celebrate(),
    dispose: () => disposeCreature(rig.root),
  };
}
