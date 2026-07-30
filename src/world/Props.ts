import * as THREE from 'three';
import { EVENTS, type GameContext } from '../core/Context';
import { makeRng, rangeOf, clamp, lerp } from '../core/Noise';
import { roundedBox, boxProjectedUV, noiseDisplace } from '../fx/Sculpt';
import {
  mergeProps,
  tintGeo,
  timberMaps,
  paintedTimberMaps,
  paintedMetalMaps,
  bareMetalMaps,
  graniteMaps,
  soilMaps,
  linenMaps,
  ropeMaps,
  dirtDecalTexture,
  carvedSignMaps,
} from '../fx/PropMaterials';

/**
 * Props — everything in Pallet Town that is not ground, water, building or plant.
 *
 * Three ideas run through the whole file:
 *
 *  1. **Merge by substance, instance by repetition.** Every one-off object is
 *     built as loose geometry, vertex-tinted, and dropped into a bucket named
 *     after what it is *made of* — timber, painted timber, enamelled sheet,
 *     bare steel, granite, soil, linen, hemp. At the end each bucket becomes a
 *     single merged mesh, so forty props cost eight draw calls while every
 *     crate still gets its own plank pattern. Only things that genuinely repeat
 *     — fence posts, rails, rocks, pebbles, stepping stones — become
 *     InstancedMeshes, where the per-instance variation lives in the matrix and
 *     in `instanceColor`.
 *
 *  2. **Nothing sits on the ground; everything sits *in* it.** Every post is
 *     sunk, every rock is buried to somewhere between a third and half its
 *     radius, and every contact point gets a terrain-conforming dirt decal
 *     whose vertices sample `collision.groundHeight` so it drapes over slopes
 *     instead of hovering above them.
 *
 *  3. **The sign is a height field, not a decal.** `carvedSignMaps` renders the
 *     lettering once into a canvas and hands back albedo, roughness, normal
 *     *and* displacement from the same field, so the panel is subdivided enough
 *     for the letters to be real geometry that self-shadows in raking morning
 *     light.
 */

/* ------------------------------------------------------------------ */
/* Layout constants, measured against the built world                  */
/* ------------------------------------------------------------------ */

const P_HOUSE = { cx: -8.4, cz: 2.0, w: 7.4, d: 6.2, mirror: -1 as const };
const R_HOUSE = { cx: 8.4, cz: 2.0, w: 7.62, d: 6.05, mirror: 1 as const };
const LAB = { cx: 0, cz: -13.0, w: 13.2, d: 9.2 };

/** Footprints props must stay out of. */
const KEEPOUT = [
  { cx: LAB.cx, cz: LAB.cz, hx: 7.6, hz: 5.6 },
  { cx: P_HOUSE.cx, cz: P_HOUSE.cz, hx: 4.4, hz: 3.8 },
  { cx: R_HOUSE.cx, cz: R_HOUSE.cz, hx: 4.5, hz: 3.7 },
];

/** Palette, straight from the art bible. */
const C = {
  wood: 0x8a5c3b,
  woodPale: 0xa8805a,
  woodGrey: 0x9c9185,
  cream: 0xf0e3c8,
  white: 0xfaf3e4,
  roofRed: 0xd0553f,
  roofBlue: 0x4a86c4,
  stone: 0xb8b3a8,
  dirt: 0xc9a173,
  dirtDark: 0x9a6f45,
  leaf: 0x5b9e3c,
  leafDark: 0x3f7d3a,
  pink: 0xf25d7a,
  yellow: 0xffd447,
  petalWhite: 0xf5f0ea,
  purple: 0xb57fe0,
  iron: 0x6f7378,
  dark: 0x2a2622,
} as const;

/* ------------------------------------------------------------------ */
/* Geometry primitives                                                 */
/* ------------------------------------------------------------------ */

/** Rounded box with world-scale box-projected UVs. */
function rbox(w: number, h: number, d: number, r = 0.025, segs = 2, uvScale = 1): THREE.BufferGeometry {
  const g = roundedBox(w, h, d, Math.min(r, Math.min(w, h, d) * 0.48), segs);
  g.deleteAttribute('uv');
  g.setAttribute('uv', boxProjectedUV(g, uvScale));
  return g;
}

/**
 * A cylinder whose rims are actually filleted. Straight `CylinderGeometry`
 * gives two razor edges that catch the key light as white lines — the single
 * most obvious "untouched primitive" tell in a stylised scene.
 */
function roundedCyl(rBot: number, rTop: number, h: number, fillet = 0.02, seg = 16): THREE.BufferGeometry {
  const f = Math.max(0.004, Math.min(fillet, Math.min(rBot, rTop, h / 2) * 0.85));
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0), new THREE.Vector2(rBot - f, 0)];
  for (let i = 1; i <= 3; i++) {
    const a = (i / 3) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(rBot - f + Math.sin(a) * f, f - Math.cos(a) * f));
  }
  pts.push(new THREE.Vector2(rTop, h - f));
  for (let i = 1; i <= 3; i++) {
    const a = (i / 3) * Math.PI * 0.5;
    pts.push(new THREE.Vector2(rTop - f + Math.cos(a) * f, h - f + Math.sin(a) * f));
  }
  pts.push(new THREE.Vector2(0, h));
  const g = new THREE.LatheGeometry(pts, seg);
  g.computeVertexNormals();
  return g;
}

/** A short log: a filleted cylinder lying along X with a cut-end disc. */
function logGeo(r: number, len: number, seg = 12): THREE.BufferGeometry {
  const g = roundedCyl(r * 0.96, r, len, r * 0.22, seg);
  g.translate(0, -len / 2, 0);
  g.rotateZ(Math.PI / 2);
  g.deleteAttribute('uv');
  g.setAttribute('uv', boxProjectedUV(g, 1.6));
  return g;
}

interface Xform {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  s?: number;
}

function place(g: THREE.BufferGeometry, t: Xform): THREE.BufferGeometry {
  if (t.s !== undefined && t.s !== 1) g.scale(t.s, t.s, t.s);
  if (t.rz) g.rotateZ(t.rz);
  if (t.rx) g.rotateX(t.rx);
  if (t.ry) g.rotateY(t.ry);
  g.translate(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  return g;
}

/* ------------------------------------------------------------------ */
/* The kit                                                             */
/* ------------------------------------------------------------------ */

type Bucket = 'timber' | 'paint' | 'metal' | 'steel' | 'granite' | 'soil' | 'linen' | 'rope';

class PropKit {
  readonly group = new THREE.Group();
  private buckets = new Map<Bucket, THREE.BufferGeometry[]>();
  private decals: THREE.BufferGeometry[] = [];

  constructor(readonly ctx: GameContext) {
    this.group.name = 'Props';
    ctx.scene.add(this.group);
  }

  /** Adds a geometry to a material bucket with a flat vertex tint. */
  add(geo: THREE.BufferGeometry, bucket: Bucket, color: THREE.ColorRepresentation, t?: Xform): void {
    if (t) place(geo, t);
    if (!geo.attributes.uv) geo.setAttribute('uv', boxProjectedUV(geo, 1));
    tintGeo(geo, color);
    let list = this.buckets.get(bucket);
    if (!list) this.buckets.set(bucket, (list = []));
    list.push(geo);
  }

  /**
   * A terrain-conforming ground decal: a small grid whose every vertex samples
   * the heightfield, so it drapes over the slope instead of slicing into it.
   */
  decal(cx: number, cz: number, size: number, rot: number, alpha = 0.9, tint = 0xffffff, aspect = 1): void {
    const seg = size > 1.2 ? 4 : 2;
    const g = new THREE.PlaneGeometry(size, size * aspect, seg, seg);
    g.rotateX(-Math.PI / 2);
    g.rotateY(rot);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const gh = this.ctx.collision.groundHeight;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      pos.setXYZ(i, x, gh(x, z) + 0.022, z);
    }
    g.computeVertexNormals();
    tintGeo(g, tint, alpha);
    this.decals.push(g);
  }

  /** Builds the merged meshes. One draw call per substance. */
  flush(): void {
    const mats: Record<Bucket, THREE.Material> = {
      timber: new THREE.MeshStandardMaterial({
        ...timberMaps('fence', 0x9a7048, 5),
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      }),
      paint: new THREE.MeshStandardMaterial({
        ...paintedTimberMaps('prop', 0xffffff),
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      }),
      metal: new THREE.MeshStandardMaterial({
        ...paintedMetalMaps(),
        vertexColors: true,
        roughness: 1,
        metalness: 0.08,
      }),
      steel: new THREE.MeshStandardMaterial({
        ...bareMetalMaps(),
        vertexColors: true,
        roughness: 1,
        metalness: 0.82,
      }),
      granite: new THREE.MeshStandardMaterial({
        ...graniteMaps(),
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      }),
      soil: new THREE.MeshStandardMaterial({
        ...soilMaps(),
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      }),
      linen: new THREE.MeshStandardMaterial({
        ...linenMaps(),
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
      rope: new THREE.MeshStandardMaterial({
        ...ropeMaps(),
        vertexColors: true,
        roughness: 1,
        metalness: 0,
      }),
    };

    for (const [name, list] of this.buckets) {
      if (!list.length) continue;
      const geo = mergeProps(list, 3);
      const mesh = new THREE.Mesh(geo, mats[name]);
      mesh.name = `props.${name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      for (const g of list) g.dispose();
    }

    if (this.decals.length) {
      const geo = mergeProps(this.decals, 4);
      const mat = new THREE.MeshStandardMaterial({
        map: dirtDecalTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        roughness: 0.96,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'props.decals';
      mesh.receiveShadow = true;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      for (const g of this.decals) g.dispose();
    }
  }
}

/** White vertex colours so a shared `vertexColors` material also works instanced. */
function whiteColors(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = (g.attributes.position as THREE.BufferAttribute).count;
  const arr = new Float32Array(n * 3).fill(1);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function insideKeepout(x: number, z: number, pad = 0): boolean {
  for (const k of KEEPOUT) {
    if (Math.abs(x - k.cx) < k.hx + pad && Math.abs(z - k.cz) < k.hz + pad) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Fences                                                              */
/* ------------------------------------------------------------------ */

interface FenceRun {
  pts: [number, number][];
  /** Post spacing, metres. */
  gap: number;
  /** Post height above ground. */
  h: number;
  /** Rail heights as a fraction of post height. */
  rails: number[];
  tag: string;
}

const FENCE_RUNS: FenceRun[] = [
  // West town edge — the treeline boundary the player walks along.
  {
    pts: [
      [-16.5, -7.6],
      [-17.0, -1.4],
      [-16.4, 4.8],
      [-17.1, 11.2],
      [-16.5, 17.4],
      [-15.9, 22.4],
    ],
    gap: 1.95,
    h: 1.08,
    rails: [0.4, 0.76],
    tag: 'fence-w',
  },
  // East town edge.
  {
    pts: [
      [16.4, -7.2],
      [16.9, -0.8],
      [16.3, 5.4],
      [17.0, 11.6],
      [16.4, 17.8],
      [15.8, 22.6],
    ],
    gap: 2.05,
    h: 1.08,
    rails: [0.4, 0.76],
    tag: 'fence-e',
  },
  // South entrance wings, flanking the path either side of the sign.
  {
    pts: [
      [-3.6, 15.0],
      [-7.4, 15.5],
      [-11.2, 15.1],
      [-14.9, 15.7],
      [-16.2, 16.2],
    ],
    gap: 1.85,
    h: 1.0,
    rails: [0.42, 0.78],
    tag: 'fence-sw',
  },
  {
    pts: [
      [3.8, 15.3],
      [7.6, 15.8],
      [11.4, 15.2],
      [15.0, 15.9],
      [16.1, 16.4],
    ],
    gap: 1.9,
    h: 1.0,
    rails: [0.42, 0.78],
    tag: 'fence-se',
  },
  // Player's garden — wraps the back and west of the house, open at the front.
  {
    pts: [
      [-4.4, -2.5],
      [-8.6, -3.0],
      [-12.9, -2.5],
      [-13.1, 2.3],
      [-12.7, 6.6],
      [-12.5, 9.2],
    ],
    gap: 1.6,
    h: 0.86,
    rails: [0.42, 0.8],
    tag: 'garden-p',
  },
  // Rival's garden — same idea, deliberately different shape and spacing.
  {
    pts: [
      [5.0, -2.1],
      [9.6, -3.1],
      [13.3, -2.2],
      [13.1, 3.5],
      [12.4, 8.4],
    ],
    gap: 1.75,
    h: 0.9,
    rails: [0.38, 0.74],
    tag: 'garden-r',
  },
];

interface PostSample {
  x: number;
  z: number;
  y: number;
  h: number;
  yaw: number;
}

function buildFences(ctx: GameContext, kit: PropKit): { posts: PostSample[] } {
  const rng = makeRng(ctx.seed ^ 0x5eed01);
  const gh = ctx.collision.groundHeight;

  // --- geometry ----------------------------------------------------------
  // A post is a chunky, slightly tapered square section with a weathered,
  // strongly filleted top — the diorama-scale cue from the bible.
  const postGeo = rbox(0.155, 1, 0.155, 0.045, 2, 1.3);
  postGeo.translate(0, 0.5, 0);
  whiteColors(postGeo);

  const railGeo = rbox(0.085, 0.135, 1, 0.038, 2, 1.4);
  whiteColors(railGeo);

  const timberMat = new THREE.MeshStandardMaterial({
    ...timberMaps('fence', 0x9a7048, 5),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  const postM: THREE.Matrix4[] = [];
  const postC: THREE.Color[] = [];
  const railM: THREE.Matrix4[] = [];
  const railC: THREE.Color[] = [];
  const samples: PostSample[] = [];

  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const dir = new THREE.Vector3();

  for (const run of FENCE_RUNS) {
    // Resample the polyline at the post spacing so posts follow the curve.
    const curve = new THREE.CatmullRomCurve3(
      run.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      false,
      'catmullrom',
      0.4,
    );
    const total = curve.getLength();
    const n = Math.max(2, Math.round(total / run.gap));
    const runPosts: PostSample[] = [];

    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const pt = curve.getPointAt(t);
      // Jitter along and across the run so no two posts line up perfectly.
      const tan = curve.getTangentAt(t);
      const side = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
      const jx = pt.x + side.x * rangeOf(rng, -0.09, 0.09) + tan.x * rangeOf(rng, -0.13, 0.13);
      const jz = pt.z + side.z * rangeOf(rng, -0.09, 0.09) + tan.z * rangeOf(rng, -0.13, 0.13);
      const y = gh(jx, jz);
      const h = run.h * rangeOf(rng, 0.9, 1.09);
      const yaw = Math.atan2(tan.x, tan.z) + rangeOf(rng, -0.16, 0.16);
      runPosts.push({ x: jx, z: jz, y, h, yaw });
    }

    for (let i = 0; i < runPosts.length; i++) {
      const post = runPosts[i];
      samples.push(post);
      // Lean: a real fence has posts that have shifted in the ground.
      const leanA = rangeOf(rng, -0.055, 0.055);
      const leanB = rangeOf(rng, -0.05, 0.05);
      const e = new THREE.Euler(leanA, post.yaw, leanB, 'YXZ');
      q.setFromEuler(e);
      p.set(post.x, post.y - 0.14, post.z);
      s.set(rangeOf(rng, 0.9, 1.12), post.h + 0.14, rangeOf(rng, 0.9, 1.12));
      postM.push(new THREE.Matrix4().compose(p, q, s));
      // Weathering: sun-bleached tops, green-damp bases, per-post.
      const w = rng();
      postC.push(new THREE.Color().setHSL(0.09 + w * 0.02, 0.24 + w * 0.14, 0.46 + w * 0.24));

      // Dirt ring where the post enters the turf.
      if (rng() > 0.12) {
        kit.decal(
          post.x + rangeOf(rng, -0.05, 0.05),
          post.z + rangeOf(rng, -0.05, 0.05),
          rangeOf(rng, 0.44, 0.72),
          rng() * Math.PI * 2,
          rangeOf(rng, 0.34, 0.62),
          0xe4d3b6,
        );
      }

      // --- rails to the next post ---
      const next = runPosts[i + 1];
      if (!next) continue;
      const dx = next.x - post.x;
      const dz = next.z - post.z;
      const flat = Math.hypot(dx, dz);
      for (const frac of run.rails) {
        const y0 = post.y + post.h * frac;
        const y1 = next.y + next.h * frac;
        const dy = y1 - y0;
        const len = Math.hypot(flat, dy);
        dir.set(dx, dy, dz).normalize();
        q.setFromUnitVectors(zAxis, dir);
        // A little roll so rails are not all perfectly flat-faced.
        q.multiply(new THREE.Quaternion().setFromAxisAngle(zAxis, rangeOf(rng, -0.14, 0.14)));
        p.set((post.x + next.x) / 2, (y0 + y1) / 2, (post.z + next.z) / 2);
        s.set(rangeOf(rng, 0.88, 1.1), rangeOf(rng, 0.86, 1.14), len + 0.06);
        railM.push(new THREE.Matrix4().compose(p, q, s));
        const w = rng();
        railC.push(new THREE.Color().setHSL(0.085 + w * 0.025, 0.2 + w * 0.16, 0.44 + w * 0.26));
      }

      // Collider: one thin box per span, which is exact enough for a fence.
      const midY = (post.y + next.y) / 2;
      ctx.collision.addBox(
        (post.x + next.x) / 2,
        (post.z + next.z) / 2,
        0.13,
        flat / 2 + 0.08,
        midY - 0.6,
        midY + run.h,
        Math.atan2(dx, dz),
        run.tag,
      );
    }
  }

  const posts = new THREE.InstancedMesh(postGeo, timberMat, postM.length);
  postM.forEach((m, i) => {
    posts.setMatrixAt(i, m);
    posts.setColorAt(i, postC[i]);
  });
  posts.name = 'props.fencePosts';
  posts.castShadow = true;
  posts.receiveShadow = true;
  posts.instanceMatrix.needsUpdate = true;
  kit.group.add(posts);

  const rails = new THREE.InstancedMesh(railGeo, timberMat, railM.length);
  railM.forEach((m, i) => {
    rails.setMatrixAt(i, m);
    rails.setColorAt(i, railC[i]);
  });
  rails.name = 'props.fenceRails';
  rails.castShadow = true;
  rails.receiveShadow = true;
  rails.instanceMatrix.needsUpdate = true;
  kit.group.add(rails);

  return { posts: samples };
}

/* ------------------------------------------------------------------ */
/* Town sign                                                           */
/* ------------------------------------------------------------------ */

const SIGN_LINES = [
  'PALLET TOWN',
  '"Shades of your journey await!"',
  'A quiet seaside town where every trainer starts out.',
];

function buildTownSign(ctx: GameContext, kit: PropKit): void {
  const sx = -2.5;
  const sz = 12.55;
  const yaw = 0.52;
  const g0 = ctx.collision.groundHeight(sx, sz);

  const BW = 1.66;
  const BH = 0.68;
  const BT = 0.1;
  const boardY = 1.22;
  const postX = 0.72;
  const postH = 1.78;

  const root = new THREE.Object3D();
  root.position.set(sx, g0, sz);
  root.rotation.y = yaw;
  root.updateMatrixWorld(true);

  // Local-space builder: build at the origin, then bake the sign transform in.
  const local: { g: THREE.BufferGeometry; b: Bucket; c: number }[] = [];
  const add = (g: THREE.BufferGeometry, b: Bucket, c: number, t: Xform) => {
    local.push({ g: place(g, t), b, c });
  };

  for (const sgn of [-1, 1]) {
    // Posts sit in their own ground height, so the sign is never floating.
    const px = sgn * postX;
    const wx = sx + Math.cos(yaw) * px;
    const wz = sz - Math.sin(yaw) * px;
    const gy = ctx.collision.groundHeight(wx, wz) - g0;
    const h = postH - gy;
    add(rbox(0.165, h + 0.4, 0.165, 0.05, 2, 1.2), 'timber', C.wood, {
      x: px,
      y: gy + (h + 0.4) / 2 - 0.4,
      rz: sgn * 0.012,
    });
    // Chamfered cap so the post top is not a flat lid.
    add(rbox(0.2, 0.09, 0.2, 0.04, 2, 1.4), 'timber', C.woodPale, { x: px, y: gy + h + 0.03 });
    // Diagonal brace into the board.
    add(rbox(0.075, 0.62, 0.075, 0.028, 2, 1.6), 'timber', C.wood, {
      x: px - sgn * 0.2,
      y: gy + 0.95,
      rz: sgn * 0.62,
    });
    // Stone footing + dirt ring at the base.
    const rock = noiseDisplace(new THREE.IcosahedronGeometry(0.19, 1), 0.05, 3.4, 41 + sgn * 7, 3);
    rock.scale(1, 0.5, 1);
    rock.deleteAttribute('uv');
    rock.setAttribute('uv', boxProjectedUV(rock, 1.6));
    add(rock, 'granite', C.stone, { x: px + sgn * 0.16, y: gy + 0.03, z: 0.1 });
    kit.decal(wx, wz, 0.86, yaw + sgn, 0.8, 0xdcc9a8);
  }

  // Board body and a small gabled cap plank to throw a shadow across the text.
  add(rbox(BW, BH, BT, 0.035, 2, 1.1), 'timber', C.woodPale, { y: boardY });
  add(rbox(BW + 0.2, 0.07, 0.24, 0.03, 2, 1.4), 'timber', C.wood, {
    y: boardY + BH / 2 + 0.11,
    z: 0.07,
    rx: -0.34,
  });
  add(rbox(BW + 0.2, 0.07, 0.24, 0.03, 2, 1.4), 'timber', C.wood, {
    y: boardY + BH / 2 + 0.11,
    z: -0.07,
    rx: 0.34,
  });
  add(rbox(BW + 0.24, 0.09, 0.09, 0.035, 2, 1.4), 'timber', C.woodPale, {
    y: boardY + BH / 2 + 0.19,
  });

  for (const { g, b, c } of local) {
    g.applyMatrix4(root.matrixWorld);
    kit.add(g, b, c);
  }

  // --- the carved face ---------------------------------------------------
  const PW = BW - 0.12;
  const PH = BH - 0.1;
  const maps = carvedSignMaps('pallet', {
    title: 'PALLET TOWN',
    subtitle: 'Shades of your journey await!',
    aspect: PW / PH,
    ink: 0x35506b,
    timber: 0xc59a68,
  });
  const panel = new THREE.PlaneGeometry(PW, PH, 168, 66);
  place(panel, { y: boardY, z: BT / 2 + 0.006 });
  panel.applyMatrix4(root.matrixWorld);
  const panelMat = new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    displacementMap: maps.displacementMap,
    displacementScale: 0.014,
    roughness: 1,
    metalness: 0,
  });
  const panelMesh = new THREE.Mesh(panel, panelMat);
  panelMesh.name = 'props.signFace';
  panelMesh.castShadow = true;
  panelMesh.receiveShadow = true;
  kit.group.add(panelMesh);

  // --- collision + interaction ------------------------------------------
  ctx.collision.addBox(sx, sz, 0.92, 0.18, g0 - 0.5, g0 + 1.9, yaw, 'town-sign');

  const anchor = new THREE.Vector3(sx, g0 + boardY, sz);
  ctx.interaction.register({
    id: 'sign.pallet',
    position: anchor,
    radius: 3.4,
    label: 'Read the sign',
    onInteract: () => {
      ctx.events.emit(EVENTS.SAY, { speaker: 'PALLET TOWN', lines: SIGN_LINES });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Mailboxes                                                           */
/* ------------------------------------------------------------------ */

function buildMailboxes(ctx: GameContext, kit: PropKit): void {
  const gh = ctx.collision.groundHeight;

  // --- player's: a hand-made timber post with an arched cream tunnel box ---
  {
    const x = -5.3;
    const z = 7.35;
    const y = gh(x, z);
    const yaw = 0.18;
    kit.add(rbox(0.115, 1.28, 0.115, 0.035, 2, 1.4), 'timber', C.wood, {
      x,
      y: y + 0.5,
      z,
      ry: yaw,
      rz: 0.024,
    });
    // Arched body: a rounded box with a radius large enough to read as a tunnel.
    kit.add(rbox(0.34, 0.38, 0.54, 0.17, 3, 1.8), 'timber', 0xb08a5f, {
      x,
      y: y + 1.28,
      z,
      ry: yaw,
    });
    // Front plate and knob.
    kit.add(rbox(0.29, 0.33, 0.05, 0.09, 3, 2.4), 'paint', 0xb8492f, {
      x,
      y: y + 1.28,
      z: z + 0.28,
      ry: yaw,
    });
    kit.add(roundedCyl(0.035, 0.035, 0.05, 0.014, 10), 'steel', 0xc8c2b6, {
      x,
      y: y + 1.26,
      z: z + 0.32,
      rx: Math.PI / 2,
      ry: yaw,
    });
    // The flag: up, because someone has post to go out.
    kit.add(rbox(0.035, 0.3, 0.02, 0.01, 1, 3), 'paint', C.roofRed, {
      x: x + 0.2,
      y: y + 1.46,
      z: z - 0.04,
      ry: yaw,
      rz: 0.09,
    });
    kit.add(rbox(0.14, 0.09, 0.022, 0.012, 1, 3), 'paint', C.roofRed, {
      x: x + 0.26,
      y: y + 1.61,
      z: z - 0.04,
      ry: yaw,
    });
    // Base detail.
    kit.decal(x, z, 0.62, 0.7, 0.75, 0xd6c2a2);
    ctx.collision.addCircle(x, z, 0.22, y - 0.4, y + 1.5, 'mailbox-p');
  }

  // --- rival's: a bought-in steel pole with a square blue hipped-lid box ---
  {
    const x = 5.95;
    const z = 7.55;
    const y = gh(x, z);
    const yaw = -0.22;
    kit.add(roundedCyl(0.07, 0.05, 1.24, 0.02, 12), 'steel', 0x8d9298, { x, y, z });
    kit.add(roundedCyl(0.12, 0.11, 0.05, 0.02, 14), 'steel', 0x8d9298, { x, y: y + 0.02, z });
    kit.add(rbox(0.4, 0.42, 0.32, 0.05, 2, 2), 'metal', C.roofBlue, {
      x,
      y: y + 1.42,
      z,
      ry: yaw,
    });
    // Hipped lid: two slabs meeting at a ridge.
    for (const sgn of [-1, 1]) {
      kit.add(rbox(0.46, 0.045, 0.22, 0.02, 2, 2.4), 'metal', 0x35659a, {
        x,
        y: y + 1.66,
        z: z + sgn * 0.085,
        ry: yaw,
        rx: sgn * 0.42,
      });
    }
    // Letter slot, recessed and dark.
    kit.add(rbox(0.26, 0.035, 0.03, 0.012, 1, 4), 'metal', C.dark, {
      x,
      y: y + 1.5,
      z: z + 0.155,
      ry: yaw,
    });
    kit.add(roundedCyl(0.03, 0.03, 0.045, 0.012, 10), 'steel', 0xb9b3a6, {
      x,
      y: y + 1.34,
      z: z + 0.17,
      rx: Math.PI / 2,
      ry: yaw,
    });
    // A newspaper still in the cradle under the box.
    kit.add(rbox(0.3, 0.07, 0.16, 0.03, 2, 3), 'linen', 0xe6dfcd, {
      x,
      y: y + 1.16,
      z,
      ry: yaw + 0.2,
      rz: 0.06,
    });
    kit.decal(x, z, 0.58, -0.4, 0.7, 0xd6c2a2);
    ctx.collision.addCircle(x, z, 0.24, y - 0.4, y + 1.7, 'mailbox-r');
  }
}

/* ------------------------------------------------------------------ */
/* Rocks, pebbles, stepping stones                                     */
/* ------------------------------------------------------------------ */

function rockVariant(seed: number, amp: number, freq: number, squash: number, detail = 2): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  noiseDisplace(g, amp, freq, seed, 4);
  noiseDisplace(g, amp * 0.3, freq * 3.1, seed + 11, 2);
  g.scale(1, squash, 1);
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  g.setAttribute('uv', boxProjectedUV(g, 1.1));
  whiteColors(g);
  return g;
}

function buildRocks(ctx: GameContext, kit: PropKit, fencePosts: PostSample[]): void {
  const rng = makeRng(ctx.seed ^ 0x51049);
  const gh = ctx.collision.groundHeight;
  const surf = ctx.collision.surfaceAt;

  const mat = new THREE.MeshStandardMaterial({
    ...graniteMaps(),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  const variants = [
    rockVariant(0x11, 0.3, 1.05, 0.72),
    rockVariant(0x27, 0.22, 1.9, 0.58),
    rockVariant(0x53, 0.36, 0.8, 0.85),
    rockVariant(0x91, 0.18, 2.6, 0.5, 1),
  ];
  const pebbleGeo = rockVariant(0xc4, 0.26, 1.6, 0.46, 1);

  const buckets: { m: THREE.Matrix4[]; c: THREE.Color[] }[] = variants.map(() => ({ m: [], c: [] }));
  const pebbles = { m: [] as THREE.Matrix4[], c: [] as THREE.Color[] };

  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();

  const tooCloseToFence = (x: number, z: number, r: number) => {
    for (const f of fencePosts) {
      if ((f.x - x) ** 2 + (f.z - z) ** 2 < (r + 0.45) ** 2) return true;
    }
    return false;
  };

  const scatter = (
    count: number,
    minR: number,
    maxR: number,
    target: { m: THREE.Matrix4[]; c: THREE.Color[] }[] | { m: THREE.Matrix4[]; c: THREE.Color[] },
    bury: number,
  ) => {
    let placed = 0;
    let tries = 0;
    while (placed < count && tries < count * 26) {
      tries++;
      const x = rangeOf(rng, -26, 26);
      const z = rangeOf(rng, -24, 30);
      const y = gh(x, z);
      if (y < 0.12) continue;
      const sf = surf(x, z);
      if (sf === 'stone') continue;
      if (insideKeepout(x, z, 0.6)) continue;
      const r = rangeOf(rng, minR, maxR);
      if (tooCloseToFence(x, z, r)) continue;
      // Rocks cluster: the further from a notional outcrop line, the rarer.
      const cluster = Math.abs(Math.sin(x * 0.21) + Math.cos(z * 0.17));
      if (rng() > 0.24 + cluster * 0.7) continue;

      p.set(x, y - r * bury * rangeOf(rng, 0.85, 1.2), z);
      q.setFromEuler(
        new THREE.Euler(rangeOf(rng, -0.3, 0.3), rng() * Math.PI * 2, rangeOf(rng, -0.3, 0.3)),
      );
      s.set(r * rangeOf(rng, 0.8, 1.25), r * rangeOf(rng, 0.75, 1.15), r * rangeOf(rng, 0.8, 1.25));
      const m = new THREE.Matrix4().compose(p, q, s);
      const w = rng();
      const col = new THREE.Color().setHSL(0.11 - w * 0.03, 0.05 + w * 0.09, 0.5 + w * 0.24);
      const dst = Array.isArray(target) ? target[Math.floor(rng() * target.length)] : target;
      dst.m.push(m);
      dst.c.push(col);
      placed++;

      // Bigger stones get a scuffed soil collar and, if properly chunky, a
      // collider so the player cannot walk through them.
      if (r > 0.26) kit.decal(x, z, r * 3.1, rng() * 6.28, 0.3 + rng() * 0.22, 0xdccaab);
      if (r > 0.46) ctx.collision.addCircle(x, z, r * 0.78, y - 0.5, y + r, 'rock');
    }
  };

  scatter(96, 0.16, 0.62, buckets, 0.42);
  scatter(190, 0.05, 0.14, pebbles, 0.35);

  variants.forEach((geo, i) => {
    const b = buckets[i];
    if (!b.m.length) return;
    const im = new THREE.InstancedMesh(geo, mat, b.m.length);
    b.m.forEach((m, k) => {
      im.setMatrixAt(k, m);
      im.setColorAt(k, b.c[k]);
    });
    im.name = `props.rock${i}`;
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    kit.group.add(im);
  });

  if (pebbles.m.length) {
    const im = new THREE.InstancedMesh(pebbleGeo, mat, pebbles.m.length);
    pebbles.m.forEach((m, k) => {
      im.setMatrixAt(k, m);
      im.setColorAt(k, pebbles.c[k]);
    });
    im.name = 'props.pebbles';
    im.castShadow = true;
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    kit.group.add(im);
  }

  // --- stepping stones ---------------------------------------------------
  const stoneGeo = rockVariant(0x7a, 0.14, 1.4, 0.24, 2);
  const stoneRuns: [number, number][][] = [
    // Path -> lab forecourt.
    [
      [0.4, -3.4],
      [-0.1, -4.2],
      [0.35, -5.0],
      [-0.2, -5.8],
      [0.25, -6.6],
    ],
    // Branch -> player's porch.
    [
      [-8.3, 6.0],
      [-8.45, 5.4],
    ],
    // Branch -> rival's porch.
    [
      [8.5, 6.1],
      [8.35, 5.5],
    ],
    // Off the green onto the path by the sign.
    [
      [-1.0, 12.6],
      [-0.4, 12.0],
      [0.2, 11.4],
    ],
  ];
  const sm: THREE.Matrix4[] = [];
  const sc: THREE.Color[] = [];
  for (const run of stoneRuns) {
    for (const [x, z] of run) {
      const jx = x + rangeOf(rng, -0.14, 0.14);
      const jz = z + rangeOf(rng, -0.14, 0.14);
      const y = gh(jx, jz);
      const r = rangeOf(rng, 0.3, 0.42);
      p.set(jx, y - r * 0.16, jz);
      q.setFromEuler(new THREE.Euler(rangeOf(rng, -0.08, 0.08), rng() * 6.28, rangeOf(rng, -0.08, 0.08)));
      s.set(r * rangeOf(rng, 0.9, 1.2), r * rangeOf(rng, 0.8, 1.1), r * rangeOf(rng, 0.9, 1.2));
      sm.push(new THREE.Matrix4().compose(p, q, s));
      const w = rng();
      sc.push(new THREE.Color().setHSL(0.1, 0.04 + w * 0.05, 0.56 + w * 0.18));
      kit.decal(jx, jz, r * 3.4, rng() * 6.28, 0.55, 0xd4bf9d);
    }
  }
  const stones = new THREE.InstancedMesh(stoneGeo, mat, sm.length);
  sm.forEach((m, i) => {
    stones.setMatrixAt(i, m);
    stones.setColorAt(i, sc[i]);
  });
  stones.name = 'props.steppingStones';
  stones.castShadow = true;
  stones.receiveShadow = true;
  stones.instanceMatrix.needsUpdate = true;
  kit.group.add(stones);

  // --- worn scuffs where the path meets the forecourt --------------------
  for (let i = 0; i < 22; i++) {
    const t = rng();
    const x = lerp(-5.4, 5.4, rng()) * (0.4 + t * 0.7);
    const z = lerp(-4.2, -6.9, t) + rangeOf(rng, -0.5, 0.5);
    kit.decal(x, z, rangeOf(rng, 0.7, 1.9), rng() * 6.28, rangeOf(rng, 0.25, 0.6), 0xcbb493, rangeOf(rng, 0.5, 1.3));
  }
  for (let i = 0; i < 16; i++) {
    const z = rangeOf(rng, -2.5, 24);
    const x = rangeOf(rng, -2.6, 2.6);
    kit.decal(x, z, rangeOf(rng, 0.8, 2.2), rng() * 6.28, rangeOf(rng, 0.2, 0.5), 0xc8b090, rangeOf(rng, 0.4, 1.2));
  }
}

/* ------------------------------------------------------------------ */
/* Village dressing                                                    */
/* ------------------------------------------------------------------ */

function flowerBox(
  kit: PropKit,
  rng: () => number,
  x: number,
  y: number,
  z: number,
  trim: number,
  seedHue: number,
): void {
  const W = 1.36;
  kit.add(rbox(W, 0.26, 0.28, 0.05, 2, 2), 'paint', trim, { x, y, z });
  kit.add(rbox(W + 0.1, 0.05, 0.33, 0.022, 2, 2.4), 'paint', trim, { x, y: y + 0.14, z });
  // Brackets underneath — the detail that stops it reading as a floating box.
  for (const sgn of [-1, 1]) {
    kit.add(rbox(0.05, 0.2, 0.2, 0.02, 1, 3), 'paint', C.wood, {
      x: x + sgn * (W / 2 - 0.14),
      y: y - 0.19,
      z: z - 0.05,
      rx: 0.5,
    });
  }
  // Soil, sitting a centimetre below the rim.
  kit.add(rbox(W - 0.12, 0.08, 0.2, 0.03, 2, 4), 'soil', 0x7a6047, { x, y: y + 0.1, z });

  // Blossoms: oversized, as the bible asks, and never evenly spaced.
  const hues = [C.pink, C.yellow, C.petalWhite, C.purple];
  const n = 9 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n + rangeOf(rng, -0.35, 0.35) / n;
    const bx = x + (u - 0.5) * (W - 0.16);
    const bz = z + rangeOf(rng, -0.06, 0.06);
    const by = y + 0.16 + rangeOf(rng, 0, 0.06);
    // Foliage clump first.
    const leaf = new THREE.IcosahedronGeometry(rangeOf(rng, 0.07, 0.11), 1);
    noiseDisplace(leaf, 0.03, 12, 100 + i, 2);
    leaf.deleteAttribute('uv');
    leaf.setAttribute('uv', boxProjectedUV(leaf, 3));
    kit.add(leaf, 'paint', i % 3 === 0 ? C.leafDark : C.leaf, { x: bx, y: by, z: bz });
    if (rng() > 0.32) {
      const head = new THREE.IcosahedronGeometry(rangeOf(rng, 0.045, 0.075), 1);
      head.scale(1, 0.7, 1);
      head.deleteAttribute('uv');
      head.setAttribute('uv', boxProjectedUV(head, 4));
      kit.add(head, 'paint', hues[(i + seedHue) % hues.length], {
        x: bx + rangeOf(rng, -0.04, 0.04),
        y: by + rangeOf(rng, 0.05, 0.11),
        z: bz + rangeOf(rng, -0.03, 0.05),
      });
    }
  }
}

function crate(kit: PropKit, rng: () => number, x: number, y: number, z: number, ry: number, size: number, tint: number): void {
  const w = size;
  const h = size * rangeOf(rng, 0.76, 0.92);
  const d = size * rangeOf(rng, 0.9, 1.0);
  kit.add(rbox(w - 0.06, h - 0.06, d - 0.06, 0.03, 2, 1.6), 'timber', tint, { x, y: y + h / 2, z, ry });
  // Corner stiles and rails, which is what makes a crate read as slatted.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.add(rbox(0.065, h, 0.065, 0.022, 1, 2.4), 'timber', C.wood, {
        x: x + sx * (w / 2 - 0.03) * Math.cos(ry) - sz * (d / 2 - 0.03) * Math.sin(ry),
        y: y + h / 2,
        z: z - sx * (w / 2 - 0.03) * Math.sin(ry) - sz * (d / 2 - 0.03) * Math.cos(ry),
        ry,
      });
    }
  }
  for (const fy of [0.22, 0.72]) {
    kit.add(rbox(w + 0.04, 0.07, d + 0.04, 0.02, 2, 2), 'timber', C.woodPale, {
      x,
      y: y + h * fy,
      z,
      ry,
    });
  }
}

function buildDressing(ctx: GameContext, kit: PropKit): void {
  const rng = makeRng(ctx.seed ^ 0x0dd3551);
  const gh = ctx.collision.groundHeight;

  /* --- window flower boxes --------------------------------------------- */
  {
    const py = gh(P_HOUSE.cx, P_HOUSE.cz) + 1.2 - 0.16;
    const pz = P_HOUSE.cz + P_HOUSE.d / 2 + 0.11;
    for (const u of [-2.28, 2.16]) {
      flowerBox(kit, rng, P_HOUSE.cx - u, py, pz, C.white, 0);
    }
    const ry = gh(R_HOUSE.cx, R_HOUSE.cz) + 1.2 - 0.16;
    const rz = R_HOUSE.cz + R_HOUSE.d / 2 + 0.11;
    for (const u of [-2.28, 2.16]) {
      flowerBox(kit, rng, R_HOUSE.cx + u, ry, rz, C.cream, 2);
    }
  }

  /* --- water pail by the player's porch --------------------------------- */
  {
    const x = -6.55;
    const z = 5.85;
    const y = gh(x, z);
    kit.add(roundedCyl(0.15, 0.185, 0.3, 0.03, 18), 'metal', 0x7fb7bd, { x, y, z, rz: 0.05 });
    kit.add(roundedCyl(0.192, 0.192, 0.035, 0.014, 18), 'steel', 0x9aa1a6, { x, y: y + 0.25, z, rz: 0.05 });
    // Handle, hanging over one side.
    const handle = new THREE.TorusGeometry(0.17, 0.014, 6, 16, Math.PI);
    kit.add(handle, 'steel', 0x9aa1a6, { x, y: y + 0.27, z, rx: 0.1, ry: 0.4 });
    // Water, sitting a little below the rim.
    kit.add(roundedCyl(0.165, 0.165, 0.012, 0.005, 18), 'metal', 0x5fc8d2, { x, y: y + 0.22, z, rz: 0.05 });
    kit.decal(x, z, 0.7, 1.2, 0.7, 0xbfae94);
    ctx.collision.addCircle(x, z, 0.22, y - 0.3, y + 0.35, 'pail');

    // A second, tipped-over pail by the lab steps for asymmetry.
    const x2 = -3.9;
    const z2 = -6.0;
    const y2 = gh(x2, z2);
    kit.add(roundedCyl(0.14, 0.17, 0.28, 0.03, 16), 'metal', 0xc4b49a, {
      x: x2,
      y: y2 + 0.16,
      z: z2,
      rz: Math.PI / 2 - 0.18,
    });
    kit.decal(x2, z2, 0.66, 0.3, 0.6, 0xbfae94);
  }

  /* --- wheelbarrow, tipped onto its nose by the rival's garden ---------- */
  {
    const x = 11.3;
    const z = -0.9;
    const y = gh(x, z);
    const ry = -0.75;
    const tilt = -0.42;
    const root = new THREE.Object3D();
    root.position.set(x, y, z);
    root.rotation.set(0, ry, 0);
    root.updateMatrixWorld(true);
    const parts: { g: THREE.BufferGeometry; b: Bucket; c: number }[] = [];
    const add = (g: THREE.BufferGeometry, b: Bucket, c: number, t: Xform) =>
      parts.push({ g: place(g, t), b, c });

    // Tray: a shallow, softly filleted tub.
    add(rbox(0.62, 0.32, 0.92, 0.12, 3, 1.4), 'metal', 0xc75a44, { y: 0.52, z: 0.06, rx: tilt });
    add(rbox(0.56, 0.06, 0.86, 0.04, 2, 2), 'metal', 0x8f4535, { y: 0.66, z: 0.06, rx: tilt });
    // Handles.
    for (const sx of [-1, 1]) {
      add(rbox(0.065, 0.065, 1.5, 0.028, 2, 1.6), 'timber', C.wood, {
        x: sx * 0.26,
        y: 0.42,
        z: -0.34,
        rx: tilt,
      });
      add(roundedCyl(0.05, 0.045, 0.13, 0.02, 10), 'steel', 0x6b7075, {
        x: sx * 0.26,
        y: 0.42 - Math.sin(tilt) * 0.75,
        z: -0.34 - Math.cos(tilt) * 0.75,
        rx: Math.PI / 2 + tilt,
      });
      // Leg stub.
      add(rbox(0.05, 0.34, 0.05, 0.02, 1, 3), 'steel', 0x6b7075, {
        x: sx * 0.24,
        y: 0.2,
        z: -0.14,
        rx: 0.1,
      });
    }
    // Wheel.
    add(new THREE.TorusGeometry(0.2, 0.06, 8, 20), 'steel', 0x4c5054, { y: 0.24, z: 0.62, ry: Math.PI / 2 });
    add(roundedCyl(0.07, 0.07, 0.09, 0.02, 12), 'steel', 0x8d9298, {
      y: 0.24,
      z: 0.62,
      rz: Math.PI / 2,
      rx: Math.PI / 2,
    });
    for (const { g, b, c } of parts) {
      g.applyMatrix4(root.matrixWorld);
      kit.add(g, b, c);
    }
    kit.decal(x, z, 1.5, ry, 0.55, 0xc0ad91, 0.7);
    ctx.collision.addBox(x, z, 0.5, 0.8, y - 0.4, y + 0.9, ry, 'wheelbarrow');
  }

  /* --- crate stack at the forecourt corner ------------------------------ */
  {
    const bx = 5.3;
    const bz = -5.45;
    const by = gh(bx, bz);
    crate(kit, rng, bx, by, bz, 0.24, 0.66, C.woodPale);
    crate(kit, rng, bx + 0.62, by, bz + 0.28, -0.42, 0.58, C.wood);
    crate(kit, rng, bx + 0.06, by + 0.55, bz - 0.05, 0.52, 0.6, 0xb08a5f);
    // A loose plank leaning on the stack.
    kit.add(rbox(0.24, 1.24, 0.045, 0.02, 2, 1.6), 'timber', C.woodPale, {
      x: bx - 0.5,
      y: by + 0.5,
      z: bz + 0.34,
      rx: -0.3,
      rz: 0.32,
    });
    kit.decal(bx + 0.2, bz + 0.1, 2.1, 0.3, 0.5, 0xc2ae90);
    ctx.collision.addBox(bx + 0.2, bz + 0.1, 0.75, 0.62, by - 0.4, by + 1.15, 0.2, 'crates');
  }

  /* --- laundry line in the western yard --------------------------------- */
  {
    const ax = -14.7;
    const az = 6.9;
    const bx2 = -15.2;
    const bz2 = 10.5;
    const ay = gh(ax, az);
    const by2 = gh(bx2, bz2);
    const poleH = 2.05;

    for (const [px, pz, py] of [
      [ax, az, ay],
      [bx2, bz2, by2],
    ]) {
      kit.add(rbox(0.11, poleH + 0.3, 0.11, 0.035, 2, 1.3), 'timber', C.wood, {
        x: px,
        y: py + poleH / 2 - 0.15,
        z: pz,
        rz: rangeOf(rng, -0.03, 0.03),
      });
      kit.add(rbox(0.4, 0.075, 0.075, 0.028, 2, 2), 'timber', C.woodPale, {
        x: px,
        y: py + poleH - 0.12,
        z: pz,
      });
      kit.decal(px, pz, 0.6, rng() * 6.28, 0.7, 0xd0bb9a);
      ctx.collision.addCircle(px, pz, 0.16, py - 0.4, py + poleH, 'laundry-pole');
    }

    // The line itself: a catenary, because a dead-straight rope is a giveaway.
    const topA = new THREE.Vector3(ax, ay + poleH - 0.1, az);
    const topB = new THREE.Vector3(bx2, by2 + poleH - 0.1, bz2);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const v = topA.clone().lerp(topB, t);
      v.y -= 0.16 * 4 * t * (1 - t);
      pts.push(v);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    kit.add(new THREE.TubeGeometry(curve, 28, 0.016, 6, false), 'rope', 0xbfa87e);

    // Hanging cloths, each a plane with sag and folds baked in.
    const clothTints = [0xf2ecdd, 0xd9e6f0, 0xf4d9cf, 0xe7edd6];
    for (let i = 0; i < 4; i++) {
      const t = 0.16 + i * 0.22 + rangeOf(rng, -0.03, 0.03);
      const anchor = curve.getPointAt(clamp(t, 0.02, 0.98));
      const w = rangeOf(rng, 0.46, 0.62);
      const h = rangeOf(rng, 0.5, 0.78);
      const g = new THREE.PlaneGeometry(w, h, 8, 10);
      const pos = g.attributes.position as THREE.BufferAttribute;
      const phase = rng() * 6.28;
      for (let k = 0; k < pos.count; k++) {
        const vx = pos.getX(k);
        const vy = pos.getY(k);
        const fr = (vy + h / 2) / h; // 1 at the pegged top
        const u = vx / w + 0.5;
        // Folds relax toward the pegged edge; the hem lifts in the wind.
        const fold = Math.sin(u * Math.PI * 3.4 + phase) * 0.05 * (1 - fr * 0.55);
        const belly = Math.sin(u * Math.PI) * 0.09 * (1 - fr);
        pos.setXYZ(k, vx, vy - (1 - fr) * 0.03 * Math.sin(u * Math.PI * 2), fold + belly);
      }
      g.computeVertexNormals();
      const yaw = Math.atan2(topB.x - topA.x, topB.z - topA.z) + Math.PI / 2 + rangeOf(rng, -0.14, 0.14);
      kit.add(g, 'linen', clothTints[i], {
        x: anchor.x,
        y: anchor.y - h / 2 - 0.03,
        z: anchor.z,
        ry: yaw,
        rz: rangeOf(rng, -0.06, 0.06),
      });
      // Pegs.
      for (const sgn of [-1, 1]) {
        kit.add(rbox(0.03, 0.07, 0.02, 0.008, 1, 6), 'paint', sgn > 0 ? C.roofRed : C.yellow, {
          x: anchor.x + Math.cos(yaw) * sgn * (w / 2 - 0.06),
          y: anchor.y,
          z: anchor.z - Math.sin(yaw) * sgn * (w / 2 - 0.06),
          ry: yaw,
        });
      }
    }
  }

  /* --- benches ----------------------------------------------------------- */
  const bench = (x: number, z: number, ry: number, tint: number, tag: string) => {
    const y = gh(x, z);
    const root = new THREE.Object3D();
    root.position.set(x, y, z);
    root.rotation.set(0, ry, 0);
    root.updateMatrixWorld(true);
    const parts: { g: THREE.BufferGeometry; b: Bucket; c: number }[] = [];
    const add = (g: THREE.BufferGeometry, b: Bucket, c: number, t: Xform) =>
      parts.push({ g: place(g, t), b, c });
    // Seat slats.
    for (let i = 0; i < 3; i++) {
      add(rbox(1.62, 0.055, 0.14, 0.024, 2, 1.6), 'timber', i === 1 ? C.woodPale : tint, {
        y: 0.44 + rangeOf(rng, -0.006, 0.006),
        z: -0.16 + i * 0.16,
      });
    }
    // Back slats, raked.
    for (let i = 0; i < 2; i++) {
      add(rbox(1.62, 0.055, 0.15, 0.024, 2, 1.6), 'timber', i === 0 ? tint : C.woodPale, {
        y: 0.68 + i * 0.2,
        z: -0.28 - i * 0.07,
        rx: -0.22,
      });
    }
    // Legs and back stiles.
    for (const sx of [-1, 1]) {
      add(rbox(0.09, 0.46, 0.09, 0.03, 2, 2), 'timber', C.wood, { x: sx * 0.68, y: 0.21, z: 0.14 });
      add(rbox(0.09, 0.92, 0.09, 0.03, 2, 2), 'timber', C.wood, {
        x: sx * 0.68,
        y: 0.44,
        z: -0.24,
        rx: -0.11,
      });
      add(rbox(0.07, 0.07, 0.5, 0.025, 2, 2), 'timber', C.wood, { x: sx * 0.68, y: 0.4, z: -0.03 });
      kit.decal(x + Math.cos(ry) * sx * 0.68, z - Math.sin(ry) * sx * 0.68, 0.5, ry, 0.55, 0xcdb896);
    }
    for (const { g, b, c } of parts) {
      g.applyMatrix4(root.matrixWorld);
      kit.add(g, b, c);
    }
    ctx.collision.addBox(x, z, 0.85, 0.34, y - 0.4, y + 0.95, ry, tag);
  };
  bench(-16.0, 3.0, Math.PI / 2 + 0.24, 0xa87d52, 'bench-w');
  bench(3.1, 11.6, -Math.PI / 2 - 0.2, 0x9c7c58, 'bench-s');

  /* --- lamp posts -------------------------------------------------------- */
  const lamp = (x: number, z: number, ry: number) => {
    const y = gh(x, z);
    const root = new THREE.Object3D();
    root.position.set(x, y, z);
    root.rotation.set(0, ry, 0);
    root.updateMatrixWorld(true);
    const parts: { g: THREE.BufferGeometry; b: Bucket; c: number }[] = [];
    const add = (g: THREE.BufferGeometry, b: Bucket, c: number, t: Xform) =>
      parts.push({ g: place(g, t), b, c });

    add(roundedCyl(0.19, 0.15, 0.26, 0.05, 14), 'granite', C.stone, { y: -0.04 });
    add(roundedCyl(0.085, 0.062, 2.5, 0.03, 12), 'metal', 0x3f4a4e, { y: 0.2 });
    // Three collars up the shaft so the silhouette is not a bare stick.
    for (const cy of [0.42, 1.5, 2.5]) {
      add(roundedCyl(0.1, 0.095, 0.07, 0.025, 14), 'metal', 0x333c40, { y: cy });
    }
    // Lantern: tapered glass housing with a little peaked cap and a finial.
    add(roundedCyl(0.15, 0.19, 0.34, 0.035, 6), 'metal', 0x4d5a5f, { y: 2.58, ry: 0.4 });
    add(roundedCyl(0.13, 0.16, 0.3, 0.03, 6), 'metal', 0xffe9b8, { y: 2.6, ry: 0.4 });
    add(roundedCyl(0.24, 0.03, 0.16, 0.03, 6), 'metal', 0x333c40, { y: 2.92, ry: 0.4 });
    add(roundedCyl(0.035, 0.02, 0.1, 0.015, 8), 'metal', 0x333c40, { y: 3.06 });
    // Cross-arm bracket, because a bare pole reads as a pipe.
    for (const sgn of [-1, 1]) {
      add(rbox(0.045, 0.3, 0.045, 0.018, 1, 3), 'metal', 0x333c40, {
        x: sgn * 0.14,
        y: 2.34,
        rz: sgn * 0.6,
      });
    }
    for (const { g, b, c } of parts) {
      g.applyMatrix4(root.matrixWorld);
      kit.add(g, b, c);
    }
    kit.decal(x, z, 0.9, ry, 0.7, 0xcdb896);
    ctx.collision.addCircle(x, z, 0.22, y - 0.5, y + 3.1, 'lamp');
  };
  lamp(2.35, 12.1, 0.3);
  lamp(-2.55, -4.85, -0.4);
  lamp(-13.1, 10.2, 1.2);

  /* --- woodpile against the western fence -------------------------------- */
  {
    const bx = -16.4;
    const bz = 1.9;
    const by = gh(bx, bz);
    const ry = 0.14;
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const perRow = 5 - Math.floor(r / 2);
      const rowY = by + 0.12 + r * 0.21;
      for (let i = 0; i < perRow; i++) {
        const lr = rangeOf(rng, 0.095, 0.125);
        const off = (i - (perRow - 1) / 2) * 0.24 + rangeOf(rng, -0.03, 0.03);
        const g = logGeo(lr, rangeOf(rng, 1.0, 1.35), 10);
        kit.add(g, 'timber', rng() > 0.5 ? C.wood : C.woodPale, {
          x: bx + Math.sin(ry) * off,
          y: rowY,
          z: bz + Math.cos(ry) * off,
          ry: ry + rangeOf(rng, -0.05, 0.05),
          rz: rangeOf(rng, -0.03, 0.03),
        });
      }
    }
    // Two end stakes holding the stack in.
    for (const sgn of [-1, 1]) {
      kit.add(rbox(0.08, 1.1, 0.08, 0.03, 2, 2), 'timber', C.woodGrey, {
        x: bx + Math.sin(ry) * sgn * 0.72,
        y: by + 0.45,
        z: bz + Math.cos(ry) * sgn * 0.72,
        rz: sgn * 0.05,
      });
    }
    // A couple of split rounds fallen off the pile.
    for (let i = 0; i < 3; i++) {
      const lx = bx + rangeOf(rng, 0.4, 0.9);
      const lz = bz + rangeOf(rng, -1.0, 1.0);
      kit.add(logGeo(rangeOf(rng, 0.1, 0.13), rangeOf(rng, 0.3, 0.5), 10), 'timber', C.woodPale, {
        x: lx,
        y: gh(lx, lz) + 0.11,
        z: lz,
        ry: rng() * 6.28,
        rz: Math.PI / 2,
      });
    }
    kit.decal(bx, bz, 2.4, ry, 0.6, 0xc3ae8f, 1.4);
    ctx.collision.addBox(bx, bz, 0.55, 0.8, by - 0.4, by + 1.0, ry, 'woodpile');
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function buildProps(ctx: GameContext): void {
  const kit = new PropKit(ctx);
  const { posts } = buildFences(ctx, kit);
  buildTownSign(ctx, kit);
  buildMailboxes(ctx, kit);
  buildDressing(ctx, kit);
  buildRocks(ctx, kit, posts);
  kit.flush();
}
