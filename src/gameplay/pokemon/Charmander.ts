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
const SKIN = 0xcc4c05;
const BELLY = 0xdfbb55;
const CLAW = 0xb9a582;

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
  // Fat-bottomed teardrop: maximum girth in the lower third, then a long
  // concave taper to the tip — the HOME flame is a plump drop, not a candle.
  const T = [0.00, 0.06, 0.14, 0.26, 0.40, 0.54, 0.68, 0.80, 0.90, 0.96, 1.00];
  const R = [base, 0.90, 1.00, 0.99, 0.91, 0.79, 0.63, 0.46, 0.29, 0.14, 0.00];
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
        a *= smoothstep(1.02, 0.55, vH);       // the very top wisps out
        vec3 c = mix(uHot, uCool, smoothstep(0.10, 0.70, vH));
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
 * One eye — a LARGE vertical-oval toon eye sitting nearly flush on the face.
 *
 * The official model's eyes are essentially decals: big upright ovals on the
 * FRONT of the face, teal iris filling most of the oval, a huge dark pupil,
 * one white catchlight, and a sliver of white sclera showing along the top.
 * Character comes almost entirely from these, so they are built as a stack of
 * shallow nested ellipsoids — each layer's front face proud of the one behind
 * it by a millimetre, so nothing z-fights and nothing reads as a marble.
 */
function buildEye(w: number, h: number, side: number, splay: number, skinMat: THREE.Material): EyeParts {
  const holder = new THREE.Group();
  holder.rotation.y = side * splay;

  const d = w * 0.85; // shallow: a lens, not a ball

  // Dark liner ellipsoid BEHIND the sclera, slightly larger in x/y and set
  // back in z: its rim shows as a thick dark outline around the whole eye —
  // the HOME model draws this ring and it is what makes the eyes pop off the
  // orange instead of floating as pale ovals.
  const liner = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0x14262c, roughness: 0.55 }),
  );
  liner.scale.set(w * 1.10, h * 1.075, d * 0.92);
  liner.position.z = -d * 0.05;
  holder.add(liner);

  const sclera = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshPhysicalMaterial({
      color: 0xf4f1e6, roughness: 0.35, clearcoat: 0.25, clearcoatRoughness: 0.35,
      envMapIntensity: 0.12,
    }),
  );
  sclera.scale.set(w, h, d);
  holder.add(sclera);

  // Iris and pupil are SPHERE CAPS hugging a slightly inflated copy of the
  // sclera ellipsoid. Floating shells left their rims sticking off the white
  // as dark fins in profile; a cap's rim lies on the ellipsoid, so the eye is
  // watertight from every angle. The iris sits slightly LOW so a sliver of
  // white shows along the top — that sliver is what makes the face friendly.
  // Caps must stay CENTRED: any y-offset breaks the hug and buries one layer
  // under the one behind it (the offset iris vanished under the sclera and the
  // eye rendered black-on-white). Layer separation comes from inflation alone.
  const capMesh = (reach: number, inflate: number, mat: THREE.Material): THREE.Mesh => {
    const geo = new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.asin(clamp(reach, 0, 1)));
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = Math.PI / 2;              // cap axis: +Y -> +Z
    m.scale.set(w * inflate, d * inflate, h * inflate);
    return m;
  };
  // Darker saturated teal, matched to the HOME render — the previous pale
  // sky-blue washed out under the studio key.
  // A touch of emissive keeps the teal saturated when the head shades the
  // eye — a purely lit iris went near-black in three-quarter view.
  const iris = capMesh(0.93, 1.02, new THREE.MeshPhysicalMaterial({
    color: 0x0f6e80, roughness: 0.38, clearcoat: 0.3, clearcoatRoughness: 0.3,
    envMapIntensity: 0.10, emissive: 0x0c4a58, emissiveIntensity: 0.5,
  }));
  holder.add(iris);
  const pupil = capMesh(0.46, 1.035, new THREE.MeshBasicMaterial({ color: 0x101314 }));
  holder.add(pupil);

  // Exactly one catchlight, upper-left from the viewer, crisp and not-quite
  // white so the flame keeps the brightest pixel in frame.
  const hi = new THREE.Mesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xeef1f4 }),
  );
  hi.scale.set(w * 0.20, h * 0.13, d * 0.18);
  hi.position.set(-w * 0.18, h * 0.16, d * 0.99);
  holder.add(hi);

  // Blink lid — a skin dome hung from the top of the oval, scaled flat at
  // rest so it contributes nothing to the neutral expression.
  const LR = Math.max(w, h) * 1.1;
  const lidGeo = new THREE.SphereGeometry(LR, 14, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  // Sized to the eye WIDTH and kept SHALLOW in z: the rest pose (scale.y = 0)
  // collapses the dome to a flat disc, and any part of that disc that clears
  // the eyeball or the skin renders as a floating dark lash in profile. The
  // whole disc therefore has to live INSIDE the head: narrow in x, thin in z,
  // pushed back. Blink coverage is slightly imperfect for it; a 150ms blink
  // artifact is a far better trade than a permanent lash.
  lidGeo.scale(w / LR * 1.02, 2.2, d / LR * 0.55);
  lidGeo.computeVertexNormals();
  const lid = new THREE.Mesh(lidGeo, skinMat);
  lid.position.set(0, h * 0.94, -d * 0.35);
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
  // detail: 'none' — the scale/pore normal map read as diseased, wrinkly skin
  // at this character's size. The official model is perfectly smooth vinyl.
  const painted = creatureSkin({
    color: 0xffffff, subsurface: 0xb8360a, wrap: 0.05, rim: 0.015,
    roughness: 0.60, detail: 'none',
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

    // arms: SHORT and CHUNKY — shoulder -> upper arm -> elbow -> forearm ->
    // wrist -> palm. The reference arm is nearly as thick as it is long; the
    // thin tapering arm the previous build had read as an old man's.
    // Posed slightly SPREAD, out and forward, the way HOME holds them — hands
    // clear of the hips, palms angled ahead — rather than hanging at the seams.
    { x: 0.090, y: 0.304, z: 0.006, r: 0.044 },
    { x: -0.090, y: 0.304, z: 0.006, r: 0.044 },
    { x: 0.126, y: 0.282, z: 0.014, r: 0.036 },
    { x: -0.126, y: 0.282, z: 0.014, r: 0.036 },
    { x: 0.154, y: 0.260, z: 0.028, r: 0.032 },                            // elbow
    { x: -0.154, y: 0.260, z: 0.028, r: 0.032 },
    { x: 0.174, y: 0.244, z: 0.050, r: 0.029 },                            // forearm
    { x: -0.174, y: 0.244, z: 0.050, r: 0.029 },
    { x: 0.188, y: 0.234, z: 0.070, r: 0.026 },                            // wrist
    { x: -0.188, y: 0.234, z: 0.070, r: 0.026 },
    { x: 0.196, y: 0.228, z: 0.090, r: 0.032, sy: 0.76, sz: 0.94 },        // palm
    { x: -0.196, y: 0.228, z: 0.090, r: 0.032, sy: 0.76, sz: 0.94 },
    // notch where the shoulder meets the ribs, so the arm reads as a limb
    // hung off the body rather than a fused stump
    { x: 0.086, y: 0.270, z: 0.014, r: 0.028, sx: 0.7, sy: 1.15, strength: -0.26 },
    { x: -0.086, y: 0.270, z: 0.014, r: 0.028, sx: 0.7, sy: 1.15, strength: -0.26 },

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
  const FINGER: number[] = [-0.52, -0.17, 0.17, 0.52];
  const fingerTips: { p: THREE.Vector3; spread: number; s: number }[] = [];
  const toeTips: THREE.Vector3[] = [];
  for (const s of [1, -1]) {
    // hand — FOUR short capsules splayed off the palm, per the reference
    for (const spread of FINGER) {
      const dx = Math.sin(spread);
      const dz = Math.cos(spread);
      bodyBalls.push({ x: s * (0.196 + dx * 0.019), y: 0.225, z: 0.090 + dz * 0.019, r: 0.0115 });
      bodyBalls.push({ x: s * (0.196 + dx * 0.033), y: 0.223, z: 0.090 + dz * 0.033, r: 0.0100 });
      fingerTips.push({
        p: new THREE.Vector3(s * (0.196 + dx * 0.042), 0.221, 0.090 + dz * 0.042),
        spread, s,
      });
      // split between fingers so the hand is not a mitten
      if (spread < 0.4) {
        bodyBalls.push({
          x: s * (0.196 + Math.sin(spread + 0.17) * 0.028), y: 0.224,
          z: 0.090 + Math.cos(spread + 0.17) * 0.028,
          r: 0.0100, sx: 0.5, sy: 1.1, strength: -0.34,
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

  for (const tip of fingerTips) {
    const c = new THREE.Mesh(handClaw, clawMat);
    c.position.copy(tip.p).add(new THREE.Vector3(0, -0.001, -0.007));
    c.rotation.set(Math.PI * 0.56, 0, -tip.spread * 0.8 * tip.s);
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

  // Mouth line: a WIDE, gently upturned arc that WRAPS the muzzle all the way
  // to the cheeks — in the HOME render the grin is the widest facial feature,
  // spanning about two thirds of the head. The z coordinate cannot come from a
  // (1-cos) falloff at this width: the muzzle's plan silhouette is a bulbous
  // nose in the middle falling away steeply to the cheeks, so z is a piecewise
  // ramp fitted to the sculpt's actual plan-view at mouth height. That keeps
  // every point of the line ON the skin instead of floating off the corners.
  // Corner x of 0.075 against a probed head half-width of ~0.113 at mouth
  // height puts the grin at about two thirds of the head — matching HOME. The
  // z table is FITTED TO THE SCULPT: probed by raycasting the actual marching-
  // cubes head front-to-back along this arc, then inset 1mm. Guessing these
  // values buries the corners of the mouth centimetres inside the cheeks.
  const MOUTH_X = 0.075;
  const MOUTH_PLAN: [number, number][] = [
    [0.000, 0.1205], [0.014, 0.1200], [0.021, 0.1146], [0.028, 0.1115],
    [0.035, 0.1058], [0.041, 0.0956], [0.047, 0.0888], [0.052, 0.0813],
    [0.057, 0.0748], [0.062, 0.0732], [0.069, 0.0700], [0.075, 0.0665],
  ];
  const mouthPoint = (a: number): THREE.Vector3 => {
    const x = Math.sin(a) * MOUTH_X;
    return new THREE.Vector3(
      x,
      -0.031 + (1 - Math.cos(a)) * 0.028,
      ramp(MOUTH_PLAN, Math.abs(x)),
    );
  };

  // The OPEN grin. Angular half-width of the opening (the crease continues a
  // little past the corners), and the vertical gap between the lips: widest at
  // the centre, zero at the corners — a wide shallow upturned crescent, NOT a
  // round pit. All the mouth geometry below is driven by these two.
  const MOUTH_A = 1.45;
  const MOUTH_GAP = 0.030;
  const mouthGap = (a: number): number =>
    MOUTH_GAP * Math.pow(Math.max(0, Math.cos((a / MOUTH_A) * Math.PI * 0.5)), 0.7);
  // Local outward direction of the muzzle surface at lip angle a — used to
  // hold the mouth surfaces a hair proud of the sculpt so nothing z-fights.
  // Even at the corners the cheek front still faces mostly FORWARD (plan
  // normal ~(0.48, 0.88) from the probe), so the z component stays dominant;
  // a sideways-pointing offset would slide the strips along the skin instead
  // of lifting off it.
  const mouthOut = (a: number): THREE.Vector3 =>
    new THREE.Vector3(
      Math.sin(a) * 0.5,
      -0.16,
      1.0 - 0.45 * Math.sin(a) * Math.sin(a),
    ).normalize();
  // Offset along the local outward direction. Slightly proud only where the
  // opening is widest (so the dark fill is never z-fought by the skin), and
  // SUNK toward the corners. Kept small on purpose: a fat proud offset is what
  // used to read as puffy raised lips.
  // The sunk-to-proud transition is deliberately STEEP: the band where the
  // offset crosses zero is a z-fighting stripe against the skin, and a slow
  // ramp parks that band right at the visible corners of the grin.
  const mouthLift = (a: number): number =>
    -0.0018 + 0.0032 * clamp(mouthGap(a) / 0.010, 0, 1);

  // SMOOTH ABOVE ALL. Every socket carve, lid fold, glabella fill, jaw crease
  // and muzzle crease the previous face had rendered as wrinkles at this
  // scale — an old man's face on a baby dinosaur. The official head is one
  // clean rounded volume: tall dome, full cheeks, a SHORT smooth muzzle, and
  // that is all. The eyes are surface-mounted ovals, not sunk marbles, so the
  // sculpt no longer needs sockets at all.
  const headBalls: Ball[] = [
    { x: 0, y: 0.024, z: 0.002, r: 0.086, sx: 1.10, sy: 1.00, sz: 0.82 },    // cranium — tall dome
    { x: 0, y: 0.008, z: -0.038, r: 0.050, sy: 0.96, sz: 0.62 },             // occiput — vertical back
    { x: 0.058, y: 0.014, z: -0.002, r: 0.049, sy: 0.96 },                   // temples — widest point
    { x: -0.058, y: 0.014, z: -0.002, r: 0.049, sy: 0.96 },
    { x: 0.051, y: -0.028, z: 0.016, r: 0.044, sz: 0.98 },                   // cheeks
    { x: -0.051, y: -0.028, z: 0.016, r: 0.044, sz: 0.98 },

    // Muzzle: short, smooth, gently upturned. No nose pad, no bridge ridge,
    // no cheek creases — the snout blends into the face the way soft vinyl
    // does, and the smile line alone separates it visually.
    { x: 0, y: -0.026, z: 0.048, r: 0.052, sx: 0.94, sy: 0.86, sz: 0.94 },   // muzzle root
    { x: 0, y: -0.024, z: 0.080, r: 0.041, sx: 0.86, sy: 0.78, sz: 0.92 },   // muzzle mid
    // Snout tip — BLUNT. Wider than deep, held high: pulled back and widened
    // from the previous tip, which read as a pointed hook drooping downward in
    // three-quarter view. HOME's muzzle ends in a soft rounded button.
    { x: 0, y: -0.013, z: 0.096, r: 0.034, sx: 0.82, sy: 0.72, sz: 0.70 },

    // Lower jaw: one smooth pass, no creases.
    { x: 0, y: -0.054, z: 0.024, r: 0.045, sx: 0.98, sy: 0.56, sz: 1.00 },   // jaw
    { x: 0, y: -0.048, z: 0.070, r: 0.030, sx: 0.82, sy: 0.48, sz: 0.90 },   // lower lip mass
    // Chin, tucked under AND behind the open mouth's floor: at its old spot
    // (y -0.041, z 0.096) its front face poked through the dark interior as
    // an orange bump in the bottom-centre of the grin.
    { x: 0, y: -0.046, z: 0.088, r: 0.019, sx: 0.64, sy: 0.42, sz: 0.66 },

    // Kill the backward teardrop: carve behind and below the occiput so the
    // back of the skull drops away vertically into the neck.
    { x: 0, y: -0.014, z: -0.058, r: 0.052, sy: 1.20, sz: 0.85, strength: -0.62 },
    // neck notch, matching the body's
    { x: 0, y: -0.055, z: -0.036, r: 0.082, sy: 0.28, strength: -0.62 },
  ];
  // Smile crease — a very shallow thin groove along the mouth arc. It only has
  // to catch a little shadow; the mouth-opening meshes below do the legibility.
  for (let i = 0; i <= 22; i++) {
    const a = lerp(-1.47, 1.47, i / 22);
    const p = mouthPoint(a);
    headBalls.push({
      x: p.x, y: p.y, z: p.z,
      r: 0.0105, sy: 0.22, sz: 0.55,
      strength: -0.22,
    });
  }
  // Open the sculpt BETWEEN the lips: small, gentle carves centred on the gap
  // pull the skin back a touch so the dark interior strip reads recessed. Kept
  // deliberately weak and buried — the first attempt used fat strong carves
  // and their crater rims rolled the skin into puffy human lips.
  // Carve centres hug the skin (the line itself is ON the probed surface, so
  // a centre a full gap behind it never touches the isosurface) and are sized
  // to pull the whole between-the-lips band a few millimetres back — the dark
  // interior strip must be the nearest surface across the entire crescent, or
  // the skin shows through the middle and the grin reads as an outline.
  for (let i = 0; i <= 18; i++) {
    const a = lerp(-1.25, 1.25, i / 18);
    const gap = mouthGap(a);
    if (gap < 0.010) continue;
    const p = mouthPoint(a);
    headBalls.push({
      x: p.x, y: p.y - gap * 0.6, z: p.z - gap * 0.5,
      r: 0.005 + gap * 0.38, sy: 1.0, sz: 0.7,
      strength: -0.55,
    });
  }
  // Shallow centred recess on the lower-lip front. The chin region bulges
  // forward at the centreline, which lifted the skin/interior crossing line
  // into an orange bump intruding on the bottom-centre of the grin.
  headBalls.push({
    x: 0, y: -0.057, z: 0.100, r: 0.015, sx: 1.5, sy: 0.6, sz: 0.7,
    strength: -0.30,
  });

  const HEAD_RES = 66;
  let headGeo = metaSurface(headBalls, { resolution: HEAD_RES, smooth: 0.92, padding: 0.024 });
  fixOutward(headGeo, 'head');
  headGeo = weldDecimate(headGeo, 0.0080);
  headGeo.setAttribute('uv', boxProjectedUV(headGeo, 17));

  // The head carries NO cream at all. In both references the cream patch
  // starts at the chest — the chin and throat are plain orange, and painting
  // cream up the chin is exactly what produced the scraggly discoloured beard
  // the review flagged. Field is constant-negative: pure skin.
  const headMark: MarkField = () => -1;
  markSculpt(headGeo, new THREE.Vector3(0, 0, 0.01), headMark, 0.20, 6);

  const head = new THREE.Mesh(headGeo, painted);
  head.castShadow = true;
  head.receiveShadow = true;
  rig.head.add(head);

  /* ---- Eyes -------------------------------------------------------- */
  // LARGE vertical ovals on the FRONT of the face, close together, mostly
  // embedded so they read as part of the head rather than as marbles. The
  // eye is roughly a third of the head's height — this is the single biggest
  // likeness lever the character has.
  const EYE_W = 0.0242;
  const EYE_H = 0.0368;
  for (const s of [1, -1]) {
    const { holder, lid } = buildEye(EYE_W, EYE_H, s, 0.30, plainSkin);
    holder.position.set(s * 0.0350, 0.0250, 0.0630);
    rig.head.add(holder);
    rig.eyes.push(holder);
    rig.eyelids.push(lid);
  }

  /* ---- Mouth: the wide open grin ------------------------------------ */
  // The HOME render's single most identifying feature. Two parametric strips
  // hug the muzzle between the lips: a warm dark interior filling the crescent
  // gap, and a thin white band with tiny tooth notches hanging off the upper
  // lip edge. The crescent is WIDE and SHALLOW with upturned corners — an
  // earlier build's round pit with fangs read as a horror mouth, so the gap is
  // capped low relative to the mouth's width and the teeth stay a millimetre
  // band, never individual fangs.
  const mouthStrip = (
    n: number, m: number,
    f: (a: number, t: number) => THREE.Vector3,
  ): THREE.BufferGeometry => {
    const pos: number[] = [];
    for (let j = 0; j <= m; j++) {
      for (let i = 0; i <= n; i++) {
        const p = f(lerp(-MOUTH_A, MOUTH_A, i / n), j / m);
        pos.push(p.x, p.y, p.z);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) {
        const r0 = j * (n + 1) + i;
        const r1 = r0 + n + 1;
        idx.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  // Interior: upper edge rides the lip line; the lower edge sags by the gap
  // and RECEDES in z toward the jaw, because the mouth floor sits well behind
  // the upper lip — keeping z constant left the chin wearing a dark shovel.
  // The top edge rides slightly ABOVE the lip line so the dark fill swallows
  // the smile crease's shiny lower rim — left exposed, that rim catches the
  // studio key as a white "lipstick" line.
  const interiorGeo = mouthStrip(40, 6, (a, t) => {
    const u = mouthPoint(a);
    const gap = mouthGap(a);
    const p = new THREE.Vector3(
      u.x * (1 - 0.08 * t),
      u.y + 0.003 * (1 - t) - gap * t,
      // Curved floor: stays PROUD of the lower-lip skin through the middle of
      // the opening and only dives behind it in the last stretch, so the
      // skin/floor crossing line — the visible bottom edge of the dark — is
      // a steep, clean intersection instead of a grazing one.
      u.z - gap * (0.55 * t + 0.65 * t ** 4),
    );
    return p.addScaledVector(mouthOut(a), mouthLift(a));
  });
  // Fully rough, near-zero specular: the opening must read as a flat matte
  // dark crescent set into the skin. Any sheen here reads as glossy lips.
  const interiorMat = new THREE.MeshPhysicalMaterial({
    color: 0x531d0d, roughness: 1.0, specularIntensity: 0.04,
    side: THREE.DoubleSide,
  });
  const interior = new THREE.Mesh(interiorGeo, interiorMat);
  interior.castShadow = false;
  rig.head.add(interior);

  // Teeth: a continuous white band whose lower edge zigzags — reads as a row
  // of tiny teeth along the upper lip without ever becoming discrete fangs.
  // The band FADES OUT well before the corners — carried to the ends it
  // rendered as a white-lipstick outline around the whole smile. Where it
  // lives, it hangs a hair below the lip edge with dark interior showing above
  // it, so it reads as teeth inside a mouth rather than as a painted lip.
  const TEETH = 7;
  const toothDepth = (a: number): number => {
    const saw = Math.abs((((a / MOUTH_A) * TEETH + TEETH) % 2) - 1); // 1 at notch tips
    // Fades to nothing well inside the corners — a HINT of teeth along the
    // upper edge, never a white outline ring around the opening. The band
    // covers only the central ~60% of the grin, and it is a real BAND: a
    // sub-millimetre depth renders as a one-pixel aliased wire floating in
    // the dark, which is worse than no teeth at all.
    const fade = clamp((mouthGap(a) / MOUTH_GAP - 0.78) / 0.15, 0, 1);
    return fade * (0.0013 + 0.0010 * saw);
  };
  const teethGeo = mouthStrip(72, 1, (a, t) => {
    const u = mouthPoint(a);
    const d = toothDepth(a) * t;
    // Starts right AT the visible top edge of the opening and hangs down,
    // so the strip reads as teeth under the upper lip, not a wire mid-mouth.
    return new THREE.Vector3(u.x, u.y + 0.0012 - d, u.z - d * 1.1)
      .addScaledVector(mouthOut(a), mouthLift(a) + 0.0006);
  });
  const teeth = new THREE.Mesh(
    teethGeo,
    new THREE.MeshStandardMaterial({
      color: 0xe9e4d6, roughness: 0.8, side: THREE.DoubleSide,
    }),
  );
  teeth.castShadow = false;
  rig.head.add(teeth);

  // Two tiny nostril dots on the smooth snout — dots, not a nose.
  const nostrilMat = new THREE.MeshStandardMaterial({ color: 0x7a3410, roughness: 0.85 });
  for (const s of [1, -1]) {
    const n = new THREE.Mesh(new THREE.SphereGeometry(0.0017, 8, 6), nostrilMat);
    n.position.set(s * 0.0100, 0.0040, 0.1150);
    n.scale.set(1, 0.8, 0.4);
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
  // HOME's flame is a PLUMP red-to-yellow drop: a wide yellow base and core,
  // orange body, red crown. Every shell is hot-at-the-base / cool-at-the-top,
  // so the gradient runs yellow -> orange -> red going up, and the widest
  // shells got wider while the heights barely moved — fat, not tall.
  const FH = 0.21;
  const shells: FlameShell[] = [
    // Wide soft halo. This replaces the glow billboard entirely: a sprite has
    // corners and an alpha rectangle, a Fresnel-dissolved shell has neither.
    flameShell(FH * 1.20, 0.128, 0xff9c2e, 0xd83208, 2.9, 0.22, 1.3, 0.55, 2.0, 0.50),
    flameShell(FH, 0.090, 0xffc63a, 0xe63a06, 1.35, 0.82, 0.0, 1.00, 3.0, 0.62),
    flameShell(FH * 0.85, 0.064, 0xffdf55, 0xff5a10, 1.75, 0.84, 2.4, 0.86, 4.0, 0.60),
    // Yellow core — short and fat, so the heart of the fire reads yellow the
    // way HOME's does, not white-hot.
    flameShell(FH * 0.58, 0.045, 0xffee9a, 0xffb62e, 1.55, 0.75, 5.1, 0.70, 5.0, 0.58),
  ];
  // A fifth, narrow tongue at a different lobe count and phase. Its only job is
  // to break the closed lathe's outline so the fire is not a solid cone as a
  // black shape. It is NOT rotated off-axis — the previous version was, and
  // rotating a heavily deformed lathe is what folded it into the straight
  // polygonal edges the review caught.
  shells.push(flameShell(FH * 1.04, 0.040, 0xffc33e, 0xff4a0e, 1.9, 0.48, 3.7, 1.20, 7.0, 0.34));
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
