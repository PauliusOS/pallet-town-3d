import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import { Simplex, fbm2, makeRng, rangeOf, clamp, smoothstep, lerp } from '../core/Noise';
import { metaSurface, noiseDisplace, boxProjectedUV, type Ball } from '../fx/Sculpt';
import {
  createFoliageMaterial,
  leafMaps,
  barkSet,
  litterTexture,
  grassCardTexture,
  leafCardTexture,
  leafClusterTexture,
  canopyPerforationMap,
  petalMaps,
  taperedTube,
  curvedCard,
  mergeGeos,
  setFlex,
  bakeCanopyShading,
} from '../fx/FoliageMaterials';
import { TERRAIN } from './Terrain';
import { wildGrassClearance } from './WildGrass';

/**
 * Vegetation — every plant in Pallet Town.
 *
 * Three ideas carry the whole system:
 *
 *  1. **A tree is a swept spine, not a cylinder.** Trunks are tubes along a
 *     leaning Catmull-Rom curve with a radius function that flares into root
 *     buttresses at the base and tapers to nothing at the crown, plus limbs
 *     grown off the same curve. Canopies are metaball clusters — five to eight
 *     overlapping blobs fused into one skin and then noise-displaced — so the
 *     silhouette is lumpy and asymmetric from every angle. Six species are
 *     generated, then instanced with seeded per-tree scale, yaw, lean and hue.
 *
 *  2. **Foliage is a lighting problem, not a modelling problem.** See
 *     `src/fx/FoliageMaterials.ts`: wrapped diffuse, shadow-correct back-lit
 *     transmission, and interior occlusion baked into vertex colours. A canopy
 *     without those three reads as a painted ball no matter how good its
 *     silhouette is.
 *
 *  3. **The ground is never empty.** Grass, clover, flowers and weeds are
 *     scattered against a baked plantability grid so nothing grows on the path,
 *     the forecourt, the beach, inside a building footprint or below the
 *     waterline — and everything else is dense. The grid is baked once from
 *     `collision.surfaceAt` so the mask can never drift from the terrain
 *     shader's own splat.
 */

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const VEG = {
  /** Ground cover is generated and culled inside this box. */
  scatterMinX: -25,
  scatterMaxX: 25,
  scatterMinZ: -25,
  scatterMaxZ: 31,
  /** Grass chunk edge, metres. Trades draw calls against cull granularity. */
  chunk: 13,
  /** Everything beyond this from the camera is hidden. */
  cullRadius: 41,
  /** Jittered-grid cell for grass tufts. Smaller = denser. */
  grassCell: 0.32,
  /** Minimum ground height a plant may sit at. Water is at y = 0. */
  minPlantY: 0.2,

  /**
   * Per-category draw distance, metres.
   *
   * These are not "how far can you see a plant" — they are "how far away does a
   * plant stop contributing a pixel". A clover leaf is 5cm across: past ~20m it
   * is comfortably sub-pixel and every one of its 21 triangles is spent drawing
   * nothing. A grass tuft is 30cm and holds up until the turf texture takes
   * over. Trees and bushes have no distance cut at all — they are silhouette,
   * and a tree vanishing at the treeline would be instantly visible.
   */
  drawDist: {
    grass: 26,
    clover: 16,
    flowers: 27,
    weeds: 23,
  },
} as const;

/**
 * Building footprints to keep clear, derived from the terrain's flat pads.
 * Slightly inset from the pad so plants still crowd right up against the walls
 * — a bare halo around a house looks like a bug, a bush touching the cladding
 * looks like a garden.
 */
const FOOTPRINTS: { cx: number; cz: number; hx: number; hz: number }[] = [
  { cx: 0.0, cz: -13.0, hx: 7.4, hz: 5.3 }, // Oak's lab
  { cx: -8.4, cz: 2.2, hx: 4.5, hz: 3.6 }, // player house
  { cx: 8.4, cz: 2.2, hx: 4.5, hz: 3.6 }, // rival house
];

/** Hand-placed hero trees inside the town proper. */
const HERO_TREES: [number, number, number][] = [
  // x, z, species index
  [-12.9, 8.8, 0],
  [12.6, -1.4, 5],
  [-12.2, -8.6, 1],
  [11.4, 12.4, 0],
  [-4.6, 20.6, 3],
  [6.2, 22.4, 2],
  [-14.4, 16.2, 4],
  [15.2, 5.6, 1],
];

/* ------------------------------------------------------------------ */
/* Species                                                             */
/* ------------------------------------------------------------------ */

type LeafSet = 'warm' | 'cool' | 'needle';
type BarkSet = 'oak' | 'ash' | 'pale';

interface TreeDef {
  key: string;
  /** Trunk spine length before the crown takes over. */
  h: number;
  r: number;
  flare: number;
  lean: number;
  curve: number;
  limbs: number;
  limbStart: number;
  /** How far up the spine the topmost limb sits. Low = a stubby, forked tree. */
  limbEnd: number;
  /** Root buttresses sweeping out of the base into the ground. */
  roots: number;
  crown: 'broad' | 'dome' | 'conic' | 'open';
  crownR: number;
  crownSquash: number;
  res: number;
  leafSet: LeafSet;
  bark: BarkSet;
  /**
   * Per-species bark colour, applied as an instance tint over the shared bark
   * albedo. This is the channel that separates a warm brown oak from a
   * grey-green ash from a chalk-white birch without baking a third set of maps
   * per species, and it is multiplicative over a near-white material colour so
   * the value here is the trunk's actual hue.
   */
  barkTint: number;
  tint: number;
  lumpy: number;
}

/**
 * Eight distinct forms, not one form eight times.
 *
 * The single most damning fault in the old treeline was that every trunk was the
 * same trunk: six species existed but they shared a family resemblance —
 * comparable height, comparable thickness, five limbs starting at the same
 * fraction of the spine — so at a glance the wood was fifteen copies of one
 * asset. What separates these is deliberately *structural*, in descending order
 * of how much it changes the silhouette:
 *
 *  - **Height spread of better than 2 : 1** (2.9 m of stubby thorn against
 *    6.8 m of pine). Scale jitter cannot fake this; a uniformly scaled tree is
 *    the same tree, and the eye reads the proportion, not the size.
 *  - **Slenderness**, independently varied: `h / r` runs from 9 (fat gnarled
 *    oak) to 38 (whippy birch).
 *  - **Where the limbs are.** A tree that forks at 25% of its height and one
 *    that carries a clean bole to 70% do not look related. `limbStart` and
 *    `limbEnd` now differ per species instead of every species spreading its
 *    limbs over the same upper half.
 *  - **Lean and curve**, from ruler-straight pine to a 0.3 lean, 0.5 curve
 *    windswept thorn.
 */
const SPECIES: TreeDef[] = [
  {
    key: 'oak-broad',
    h: 3.6, r: 0.34, flare: 0.30, lean: 0.09, curve: 0.18,
    limbs: 5, limbStart: 0.42, limbEnd: 0.95, roots: 5,
    crown: 'broad', crownR: 2.05, crownSquash: 0.78,
    res: 22, leafSet: 'warm', bark: 'oak',
    barkTint: 0xc79a68, tint: 0xeaf6d4, lumpy: 0.34,
  },
  {
    key: 'oak-old',
    h: 4.4, r: 0.46, flare: 0.44, lean: 0.05, curve: 0.12,
    limbs: 7, limbStart: 0.30, limbEnd: 0.88, roots: 6,
    crown: 'open', crownR: 2.35, crownSquash: 0.70,
    res: 22, leafSet: 'warm', bark: 'oak',
    barkTint: 0xb0854f, tint: 0xe2eec2, lumpy: 0.38,
  },
  {
    key: 'ash-tall',
    h: 5.8, r: 0.26, flare: 0.19, lean: 0.06, curve: 0.30,
    limbs: 4, limbStart: 0.62, limbEnd: 0.99, roots: 4,
    crown: 'dome', crownR: 1.70, crownSquash: 1.10,
    res: 21, leafSet: 'warm', bark: 'ash',
    // Warmed from 0xbaa483. That was a neutral grey-tan, and an ash is the
    // slenderest, tallest thing in the wood so it is nearly always the trunk
    // filling the foreground of the treeline shot — the one place a grey-blue
    // trunk is unmissable. ART_DIRECTION §3 has no neutral greys in it.
    barkTint: 0xb59066, tint: 0xdff0c6, lumpy: 0.30,
  },
  {
    key: 'pine',
    h: 6.8, r: 0.25, flare: 0.16, lean: 0.02, curve: 0.06,
    limbs: 5, limbStart: 0.44, limbEnd: 0.99, roots: 3,
    crown: 'conic', crownR: 1.42, crownSquash: 1.85,
    res: 20, leafSet: 'needle', bark: 'ash',
    barkTint: 0xa97c55, tint: 0xcfe6c8, lumpy: 0.30,
  },
  {
    key: 'spruce-young',
    h: 3.2, r: 0.16, flare: 0.11, lean: 0.03, curve: 0.08,
    limbs: 4, limbStart: 0.18, limbEnd: 0.86, roots: 3,
    crown: 'conic', crownR: 1.06, crownSquash: 2.05,
    res: 18, leafSet: 'needle', bark: 'ash',
    barkTint: 0x9c7a58, tint: 0xc4dcbc, lumpy: 0.32,
  },
  {
    key: 'birch',
    h: 6.1, r: 0.16, flare: 0.11, lean: 0.19, curve: 0.38,
    limbs: 4, limbStart: 0.70, limbEnd: 1.0, roots: 3,
    crown: 'open', crownR: 1.42, crownSquash: 1.02,
    res: 20, leafSet: 'cool', bark: 'pale',
    barkTint: 0xe6e0d0, tint: 0xeef8d2, lumpy: 0.32,
  },
  {
    key: 'maple',
    h: 4.6, r: 0.24, flare: 0.21, lean: 0.14, curve: 0.26,
    limbs: 5, limbStart: 0.52, limbEnd: 0.96, roots: 4,
    crown: 'broad', crownR: 1.78, crownSquash: 0.94,
    res: 21, leafSet: 'warm', bark: 'ash',
    barkTint: 0xc2a071, tint: 0xf6efb4, lumpy: 0.32,
  },
  {
    key: 'thorn',
    h: 2.9, r: 0.31, flare: 0.34, lean: 0.30, curve: 0.50,
    limbs: 6, limbStart: 0.22, limbEnd: 0.92, roots: 5,
    crown: 'open', crownR: 1.62, crownSquash: 0.66,
    res: 20, leafSet: 'cool', bark: 'oak',
    barkTint: 0xa8814d, tint: 0xdaeeb8, lumpy: 0.36,
  },
];

/* ------------------------------------------------------------------ */
/* Plantability grid                                                   */
/* ------------------------------------------------------------------ */

/**
 * A baked 25cm grid of "may something grow here".
 *
 * `surfaceAt` is analytic but not cheap — it re-walks the path polylines and
 * several fbm octaves per call — and the scatter needs on the order of a
 * hundred thousand queries. Baking once and bilinear-sampling turns a
 * three-second stall into a tenth of a second, and because it is baked from the
 * same function the terrain shader splats from, the mask cannot disagree with
 * what is painted on the ground.
 */
class PlantMask {
  readonly w: number;
  readonly h: number;
  private data: Float32Array;

  constructor(ctx: GameContext, w = 256, h = 288) {
    this.w = w;
    this.h = h;
    this.data = new Float32Array(w * h);
    const surfaceAt = ctx.collision.surfaceAt;
    const groundHeight = ctx.collision.groundHeight;
    for (let j = 0; j < h; j++) {
      const z = TERRAIN.minZ + ((j + 0.5) / h) * TERRAIN.depth;
      for (let i = 0; i < w; i++) {
        const x = TERRAIN.minX + ((i + 0.5) / w) * TERRAIN.width;
        const grass = surfaceAt(x, z) === 'grass' ? 1 : 0;
        const dry = groundHeight(x, z) > VEG.minPlantY ? 1 : 0;
        this.data[j * w + i] = grass * dry;
      }
    }
  }

  /** Bilinear sample. The blur across cells is what softens the path edge. */
  at(x: number, z: number): number {
    const u = ((x - TERRAIN.minX) / TERRAIN.width) * this.w - 0.5;
    const v = ((z - TERRAIN.minZ) / TERRAIN.depth) * this.h - 0.5;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fx = u - i0;
    const fz = v - j0;
    const g = (i: number, j: number) => {
      if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0;
      return this.data[j * this.w + i];
    };
    return lerp(
      lerp(g(i0, j0), g(i0 + 1, j0), fx),
      lerp(g(i0, j0 + 1), g(i0 + 1, j0 + 1), fx),
      fz,
    );
  }
}

/** 1 outside every building footprint, 0 inside, with a short feather. */
function outsideBuildings(x: number, z: number, pad = 0): number {
  let m = 1;
  for (const f of FOOTPRINTS) {
    const dx = Math.abs(x - f.cx) - (f.hx + pad);
    const dz = Math.abs(z - f.cz) - (f.hz + pad);
    const d = Math.max(dx, dz);
    m = Math.min(m, smoothstep(-0.35, 0.35, d));
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Scatter helpers                                                     */
/* ------------------------------------------------------------------ */

interface Spot {
  x: number;
  z: number;
}

/**
 * Dart-throwing Poisson-disc rejection over a density field. Used where spacing
 * has to be genuinely enforced — trees, bushes, flower clusters — because a
 * jittered grid there produces visible rows the moment two neighbours line up.
 */
function poisson(
  rng: () => number,
  o: {
    minX: number; maxX: number; minZ: number; maxZ: number;
    minDist: number; attempts: number;
    density: (x: number, z: number) => number;
  },
): Spot[] {
  const cell = o.minDist / Math.SQRT2;
  const gw = Math.ceil((o.maxX - o.minX) / cell) + 1;
  const gh = Math.ceil((o.maxZ - o.minZ) / cell) + 1;
  const grid = new Int32Array(gw * gh).fill(-1);
  const out: Spot[] = [];
  const d2 = o.minDist * o.minDist;

  for (let a = 0; a < o.attempts; a++) {
    const x = rangeOf(rng, o.minX, o.maxX);
    const z = rangeOf(rng, o.minZ, o.maxZ);
    const dens = o.density(x, z);
    if (dens <= 0.001 || rng() > dens) continue;

    const gi = Math.floor((x - o.minX) / cell);
    const gj = Math.floor((z - o.minZ) / cell);
    let ok = true;
    for (let j = Math.max(0, gj - 2); j <= Math.min(gh - 1, gj + 2) && ok; j++) {
      for (let i = Math.max(0, gi - 2); i <= Math.min(gw - 1, gi + 2); i++) {
        const id = grid[j * gw + i];
        if (id < 0) continue;
        const s = out[id];
        const dx = s.x - x;
        const dz = s.z - z;
        if (dx * dx + dz * dz < d2) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    grid[gj * gw + gi] = out.length;
    out.push({ x, z });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Instanced mesh helper                                               */
/* ------------------------------------------------------------------ */

/**
 * Creates an InstancedMesh with its own copy of the geometry so the
 * per-instance `aWind` buffer cannot be shared between two meshes that need
 * different phases.
 */
function makeInstanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  count: number,
  rng: () => number,
  windMul = 1,
): THREE.InstancedMesh {
  const g = geo.clone();
  const wind = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    wind[i * 2] = rng() * Math.PI * 2 * 3.7;
    wind[i * 2 + 1] = windMul * (0.55 + rng() * 0.9);
  }
  g.setAttribute('aWind', new THREE.InstancedBufferAttribute(wind, 2));
  const mesh = new THREE.InstancedMesh(g, mat, count);
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  return mesh;
}

/* ------------------------------------------------------------------ */
/* Per-instance culling                                                */
/* ------------------------------------------------------------------ */

/**
 * Frustum- and distance-culls the *instances* of an InstancedMesh, not just the
 * mesh.
 *
 * The problem this solves: `InstancedMesh.computeBoundingSphere()` spans every
 * instance, and that one sphere is what the renderer's frustum test uses. A
 * single mesh holding all 66 oak trees therefore has a bounding sphere the size
 * of the map — it intersects the frustum no matter where you stand, so all 66
 * trees are submitted every frame whether you are looking at the wood or at
 * your feet. The same was true of every bush, every clover and every flower in
 * the town. Measured, that was 1.65M triangles drawn in full in *every* frame
 * regardless of view direction, which is most of the overdraw in this scene.
 *
 * The fix keeps one draw call per mesh (chunking into many small meshes would
 * trade the triangles straight back for draw calls, and the draw-call budget is
 * tight too). Instead the instance matrices are permuted in place each frame so
 * the visible ones occupy a prefix, and `count` is set to the length of that
 * prefix.
 *
 * Shadows are the subtlety, and they apply to *everything* here, not just the
 * obvious casters. The sun is low and to the south-east, so a tree behind the
 * camera legitimately casts into frame; culling it against the camera frustum
 * would delete its shadow. Less obviously, this project uses VSM shadows, and
 * three.js renders a mesh into a VSM shadow map when it either casts *or*
 * receives:
 *
 *     object.castShadow || ( object.receiveShadow && type === VSMShadowMap )
 *
 * Every plant in this file sets `receiveShadow = true`, so the grass, clover,
 * flowers, weeds and leaf fringe are all in the shadow pass despite having
 * `castShadow = false`. An earlier version of this culler only restored the
 * count for meshes it thought were casters, and quietly dropped ~286k triangles
 * of receivers out of the shadow map.
 *
 * So every group keeps its full permutation in the buffer — hidden instances
 * are written after the visible prefix rather than dropped — and
 * `onBeforeShadow`/`onAfterShadow` raise `count` back to the full set for the
 * shadow pass and drop it again afterwards.
 */
/** One per-instance buffer that has to travel with the permutation. */
interface CullBuffer {
  attr: THREE.BufferAttribute;
  itemSize: number;
  base: Float32Array;
  live: Float32Array;
}

/**
 * A set of meshes that share one instance layout — a trunk, its canopy and its
 * leaf fringe — culled as a single unit.
 *
 * They must share the decision as well as the layout. Trunk, canopy and fringe
 * have different bounding radii, so culled independently they would disagree at
 * the frustum edge and you would watch a crown wink out above a trunk that
 * stayed. They also share one `aWind` buffer by design, so a permutation
 * applied to one and not the others would slide every crown off its trunk.
 */
interface CullGroup {
  meshes: THREE.InstancedMesh[];
  n: number;
  /** Union bounding sphere of the whole group, per instance, in world space. */
  cx: Float32Array;
  cy: Float32Array;
  cz: Float32Array;
  cr: Float32Array;
  buffers: CullBuffer[];
  maxDist2: number;
  /** The maxDist2 the world was authored with; QA can override maxDist2. */
  authoredMaxDist2: number;
  wasVisible: Uint8Array;
  visibleCount: number;
  primed: boolean;
}

class InstanceCuller {
  private groups: CullGroup[] = [];
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private viewInverse = new THREE.Matrix4();
  private camPos = new THREE.Vector3();
  private sphere = new THREE.Sphere();

  /**
   * @param meshes Meshes sharing one instance layout. Instance `i` must be the
   *               same plant in every one of them.
   * @param extra  Per-instance attributes beyond matrix and colour that must be
   *               permuted alongside — deduplicated, so a buffer shared between
   *               several meshes is only permuted once.
   */
  add(
    meshes: THREE.InstancedMesh[],
    opts: {
      maxDist?: number;
      extra?: THREE.BufferAttribute[];
      /** Meshes a solid caster already covers; kept out of the shadow map. */
      skipShadow?: THREE.InstancedMesh[];
    },
  ): void {
    const live = meshes.filter((m) => m.count > 0);
    if (live.length === 0) return;
    const n = live[0].count;

    // Union of each mesh's geometry sphere, so the group's radius covers the
    // canopy even when we are iterating the trunk's matrices.
    let gcx = 0;
    let gcy = 0;
    let gcz = 0;
    let grad = 0;
    for (const m of live) {
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const s = m.geometry.boundingSphere!;
      gcx += s.center.x;
      gcy += s.center.y;
      gcz += s.center.z;
    }
    gcx /= live.length;
    gcy /= live.length;
    gcz /= live.length;
    const gc = new THREE.Vector3(gcx, gcy, gcz);
    for (const m of live) {
      const s = m.geometry.boundingSphere!;
      grad = Math.max(grad, gc.distanceTo(s.center) + s.radius);
    }

    const cx = new Float32Array(n);
    const cy = new Float32Array(n);
    const cz = new Float32Array(n);
    const cr = new Float32Array(n);
    const m4 = new THREE.Matrix4();
    const c = new THREE.Vector3();
    const s3 = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      live[0].getMatrixAt(i, m4);
      c.copy(gc).applyMatrix4(m4);
      // Largest axis scale: instances are scaled non-uniformly and a radius
      // that under-covers would pop the plant out at the edge of frame.
      s3.setFromMatrixScale(m4);
      cx[i] = c.x;
      cy[i] = c.y;
      cz[i] = c.z;
      // 4% of slack on the radius. The wind shader displaces vertices beyond
      // the geometry's authored bounds, and a plant that is culled one frame
      // before it leaves the screen is far more noticeable than one drawn a
      // frame longer than it needed to be.
      cr[i] = grad * Math.max(s3.x, s3.y, s3.z) * 1.04;
    }

    const buffers: CullBuffer[] = [];
    const seen = new Set<THREE.BufferAttribute>();
    const track = (attr: THREE.BufferAttribute | null | undefined): void => {
      if (!attr || seen.has(attr)) return;
      seen.add(attr);
      const arr = attr.array as Float32Array;
      buffers.push({ attr, itemSize: attr.itemSize, base: arr.slice(), live: arr });
    };
    for (const m of live) {
      track(m.instanceMatrix);
      track(m.instanceColor);
      // Every per-instance attribute has to travel with the permutation, not
      // just the matrix. `makeInstanced` gives each geometry an `aWind` buffer
      // holding that plant's phase and stiffness; permuting the matrices while
      // leaving it behind hands each plant a stranger's wind and visibly slides
      // it across the ground. Discovering these off the geometry rather than
      // listing them by hand is what stops that happening again. The Set also
      // handles the tree case, where trunk, canopy and fringe deliberately
      // share one `aWind` buffer and it must be permuted exactly once.
      for (const attr of Object.values(m.geometry.attributes)) {
        if ((attr as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) {
          track(attr as THREE.BufferAttribute);
        }
      }
    }
    for (const e of opts.extra ?? []) track(e);

    const group: CullGroup = {
      meshes: live,
      n,
      cx, cy, cz, cr,
      buffers,
      maxDist2: opts.maxDist === undefined ? Infinity : opts.maxDist * opts.maxDist,
      authoredMaxDist2: opts.maxDist === undefined ? Infinity : opts.maxDist * opts.maxDist,
      wasVisible: new Uint8Array(n),
      visibleCount: n,
      primed: false,
    };
    this.groups.push(group);

    const shadowSkip = new Set<THREE.InstancedMesh>(opts.skipShadow ?? []);
    for (const m of live) {
      // We own the decision now. The renderer's whole-mesh test could only ever
      // agree with us, and it would apply the camera frustum to the shadow pass
      // too, which needs the full set.
      m.frustumCulled = false;
      // Under VSM, three.js draws every *receiver* into the shadow map as well
      // as every caster, so `castShadow = false` does not keep a mesh out of
      // it. For the leaf fringe that is pure waste: the canopy blob and the
      // bush shell sit inside the same volume and already cast that crown's
      // shadow, so the forty thousand alpha-tested cards on top of them can
      // only add noise to the edge of a shadow that is already there — which is
      // exactly the reasoning behind their `castShadow = false` in the first
      // place. Zeroing the instance count skips the draw outright
      // (`renderInstances` early-outs at zero) while leaving `receiveShadow`
      // alone, so the cards are still lit and shadowed exactly as before.
      //
      // Ground scatter is deliberately NOT treated this way. Grass, clover,
      // flowers and weeds have no solid proxy underneath them, so taking them
      // out of the map removes real contact shadowing and visibly flattens the
      // turf. Measured at ~530k triangles a frame, and not worth it.
      const skipShadow = shadowSkip.has(m);
      m.onBeforeShadow = () => { m.count = skipShadow ? 0 : group.n; };
      m.onAfterShadow = () => { m.count = group.visibleCount; };
    }
  }

  /**
   * Restores every instance to its authored order and full count.
   *
   * This is the A/B hook for visual QA: it puts the scene back to "no instance
   * culling at all" so a frozen capture can prove that culling changed the
   * triangle count and nothing else. Without it there is no way to tell a
   * culling bug from a wind-phase difference in a screenshot diff.
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) {
      for (const g of this.groups) g.primed = false;
      return;
    }
    for (const g of this.groups) {
      for (const b of g.buffers) {
        b.live.set(b.base);
        b.attr.needsUpdate = true;
      }
      g.visibleCount = g.n;
      g.wasVisible.fill(1);
      g.primed = false;
      for (const m of g.meshes) m.count = g.n;
    }
  }

  private enabled = true;

  /** QA hook: drop only the distance cuts, keeping frustum culling. */
  setDistanceCulling(on: boolean): void {
    for (const g of this.groups) {
      if (on) {
        g.maxDist2 = g.authoredMaxDist2;
      } else {
        g.maxDist2 = Infinity;
      }
      g.primed = false;
    }
  }

  update(camera: THREE.Camera): void {
    if (!this.enabled) return;
    // The renderer refreshes these during `render()`, which has not happened
    // yet this frame — the tick runs first. Using them as they stand would test
    // against the *previous* frame's frustum and pop plants in at the edge of
    // frame whenever the camera turns quickly.
    camera.updateMatrixWorld();
    this.viewInverse.copy(camera.matrixWorld).invert();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, this.viewInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    camera.getWorldPosition(this.camPos);
    const px = this.camPos.x;
    const py = this.camPos.y;
    const pz = this.camPos.z;

    for (const g of this.groups) {
      const { n, cx, cy, cz, cr, wasVisible } = g;
      let changed = !g.primed;
      let k = 0;

      // Pass 1: decide, and notice whether anything actually flipped. Rewriting
      // and re-uploading thousands of matrices for a camera that has not moved
      // far enough to change the set is pure waste.
      for (let i = 0; i < n; i++) {
        const r = cr[i];
        let vis = 1;
        if (g.maxDist2 !== Infinity) {
          const dx = cx[i] - px;
          const dy = cy[i] - py;
          const dz = cz[i] - pz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
          if (d > 0 && d * d > g.maxDist2) vis = 0;
        }
        if (vis) {
          this.sphere.center.set(cx[i], cy[i], cz[i]);
          this.sphere.radius = r;
          if (!this.frustum.intersectsSphere(this.sphere)) vis = 0;
        }
        if (wasVisible[i] !== vis) {
          wasVisible[i] = vis;
          changed = true;
        }
        if (vis) k++;
      }

      if (!changed) continue;
      g.primed = true;

      // Pass 2: compact the visible instances into a prefix, and write the
      // hidden ones after it. The tail is not optional: the shadow pass raises
      // `count` back to the full set, so every instance must be somewhere in
      // the buffer with a valid matrix.
      let head = 0;
      let tail = k;
      for (let i = 0; i < n; i++) {
        const slot = wasVisible[i] ? head++ : tail++;
        for (const b of g.buffers) {
          const w = b.itemSize;
          b.live.set(b.base.subarray(i * w, i * w + w), slot * w);
        }
      }

      g.visibleCount = k;
      for (const b of g.buffers) b.attr.needsUpdate = true;
      for (const m of g.meshes) m.count = k;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Leaf shell                                                          */
/* ------------------------------------------------------------------ */

/**
 * Skins the outer shell of a blob with alpha-cut leaf-cluster cards.
 *
 * A metaball crown, however lumpy, always presents a *smooth* silhouette
 * against the sky, and a smooth green silhouette reads as a surface — moss, a
 * gumdrop, a painted ball — never as leaves. Everything else in this file is
 * downstream of that one fact: the vertex-colour occlusion, the transmission
 * and the wind all make the blob look like a good blob.
 *
 * Breaking the edge is what makes it a tree. Cards are seated on the blob's own
 * vertices (so their occlusion and thickness match the surface they grow out
 * of), tilted along the surface normal with a bias toward the sky, buried to
 * roughly half their height, and jittered in size and roll. The blob stays as
 * the opaque mass that catches light and casts the shadow; the cards only have
 * to break the outline, so they are cheap and never shadow-cast.
 */
function shellCards(
  surface: THREE.BufferGeometry,
  o: {
    seed: number;
    count: number;
    minSize: number;
    maxSize: number;
    /** How hard cards rotate from the surface normal toward world up. */
    upBias: number;
    /** Fraction of the card's height buried inside the blob. */
    sink: number;
    /** Extra wind compliance over the surface vertex the card grows from. */
    flexBoost: number;
    /** Bias placement toward the top of the blob. 0 = uniform. */
    crownBias?: number;
  },
): THREE.BufferGeometry {
  const rng = makeRng(o.seed);
  const pos = surface.attributes.position as THREE.BufferAttribute;
  const nor = surface.attributes.normal as THREE.BufferAttribute;
  const colA = surface.attributes.color as THREE.BufferAttribute | undefined;
  const flexA = surface.attributes.aFlex as THREE.BufferAttribute | undefined;
  const n = pos.count;
  if (n === 0) return new THREE.BufferGeometry();

  surface.computeBoundingBox();
  const bb = surface.boundingBox!;
  const spanY = Math.max(1e-3, bb.max.y - bb.min.y);

  const parts: THREE.BufferGeometry[] = [];
  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const roll = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const stride = n / o.count;

  for (let i = 0; i < o.count; i++) {
    const idx = Math.min(n - 1, Math.floor(i * stride + rng() * stride));
    p.fromBufferAttribute(pos, idx);
    dir.fromBufferAttribute(nor, idx);

    const up01 = clamp((p.y - bb.min.y) / spanY, 0, 1);
    // Undersides get fewer, smaller leaves — they are in shadow and mostly
    // hidden, and cards hanging off the bottom of a crown read as a beard.
    const keep = lerp(1, 0.28 + up01 * 0.9, o.crownBias ?? 0.6);
    if (rng() > keep) continue;

    dir.normalize().addScaledVector(up, o.upBias).normalize();
    q.setFromUnitVectors(up, dir);
    roll.setFromAxisAngle(up, rng() * Math.PI * 2);
    q.multiply(roll);

    const thick = flexA ? flexA.getY(idx) : 1;
    // Exposed shell vertices carry the biggest clumps; buried ones get a scrap
    // that only shows through a gap.
    const h = rangeOf(rng, o.minSize, o.maxSize) * (0.66 + thick * 0.45);
    const w = h * rangeOf(rng, 0.95, 1.35);

    const card = curvedCard(w, h, rangeOf(rng, -0.16, 0.16) * h, rangeOf(rng, -0.12, 0.12) * h, 2);
    m.compose(p.clone().addScaledVector(dir, -h * o.sink), q, new THREE.Vector3(1, 1, 1));
    card.applyMatrix4(m);

    const cpos = card.attributes.position as THREE.BufferAttribute;
    const cuv = card.attributes.uv as THREE.BufferAttribute;
    const colors = new Float32Array(cpos.count * 3);
    const flex = new Float32Array(cpos.count * 2);
    const baseR = colA ? colA.getX(idx) : 1;
    const baseG = colA ? colA.getY(idx) : 1;
    const baseB = colA ? colA.getZ(idx) : 1;
    const baseFlex = flexA ? flexA.getX(idx) : 0.5;
    for (let k = 0; k < cpos.count; k++) {
      // Along the card: buried root dark, exposed tip catches the sky. The
      // gradient is what gives each clump its own little form instead of a
      // flat-lit chip.
      const t = cuv.getY(k);
      const g = 0.88 + t * 0.30;
      colors[k * 3] = baseR * g;
      colors[k * 3 + 1] = baseG * g;
      colors[k * 3 + 2] = baseB * g;
      flex[k * 2] = baseFlex * (1 + o.flexBoost) + t * o.flexBoost * 0.5;
      flex[k * 2 + 1] = clamp(lerp(thick, 1, 0.45) * (0.55 + t * 0.5), 0, 1);
    }
    card.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    card.setAttribute('aFlex', new THREE.BufferAttribute(flex, 2));
    parts.push(card);
  }

  if (parts.length === 0) return new THREE.BufferGeometry();
  const geo = mergeGeos(parts);
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Tree construction                                                   */
/* ------------------------------------------------------------------ */

interface TreeGeo {
  trunk: THREE.BufferGeometry;
  canopy: THREE.BufferGeometry;
  /** Alpha-cut leaf clusters breaking the canopy silhouette. */
  fringe: THREE.BufferGeometry;
  /** Total height, used for wind flex normalisation and collider extents. */
  height: number;
  trunkR: number;
}

function buildTree(def: TreeDef, seed: number): TreeGeo {
  const rng = makeRng(seed);

  /* ---- spine ------------------------------------------------------ */
  // Lean azimuth is per-species-instance, so no two generated variants of the
  // same species tilt the same way.
  const leanAz = rng() * Math.PI * 2;
  const lx = Math.cos(leanAz);
  const lz = Math.sin(leanAz);
  const curveAz = leanAz + rangeOf(rng, -1.4, 1.4);

  const spine: THREE.Vector3[] = [];
  const SEG = 6;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const y = def.h * t;
    const leanOff = def.lean * def.h * t * t;
    // A sine bulge on top of the lean gives an S — a trunk that leans one way
    // low down and recovers higher up reads as grown, a straight tilt reads as
    // a knocked-over pole.
    const bulge = Math.sin(t * Math.PI) * def.curve * def.h * 0.34;
    spine.push(
      new THREE.Vector3(
        lx * leanOff + Math.cos(curveAz) * bulge + rangeOf(rng, -0.03, 0.03) * def.h * t,
        y,
        lz * leanOff + Math.sin(curveAz) * bulge + rangeOf(rng, -0.03, 0.03) * def.h * t,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(spine, false, 'catmullrom', 0.5);

  const rootPhase = rng() * Math.PI * 2;
  const rootCount = 3 + Math.floor(rng() * 2);
  /**
   * Taper to a leader, not to a stub.
   *
   * The old profile held 31% of the base radius at t = 1 (`0.1 ^ 0.55`), and
   * `taperedTube` builds an open tube — so every trunk terminated in a
   * fat, flat, back-facing hole. On the trees whose crown sits behind another
   * tree's canopy that hole is what you see, and a trunk cut off square reads as
   * a sawn stump. 8% of the base radius with a slightly harder exponent closes
   * it to a shoot thin enough to disappear into the leaves.
   */
  const radiusAt = (t: number) =>
    def.r * Math.pow(Math.max(0.001, 1 - t * 0.985), 0.62) + def.flare * Math.exp(-t * 11) * 0.55;

  const trunkGeo = taperedTube({
    spine,
    rings: 13,
    radial: 11,
    // Bark texel density is now fixed per metre of trunk rather than per trunk.
    // At 0.42 * h a four-metre spine got 1.7 v repeats, so a single bark fissure
    // was stretched over two metres — the vertical streak in the treeline shot.
    // 1.5 repeats per metre puts a fissure at ~20 cm, which is what bark is.
    vScale: def.h * 1.5,
    radius: radiusAt,
    lobe: (t, theta) => {
      // Root buttresses: a few ridges that flare hard at the very base and are
      // gone by knee height. This is the single detail that separates a trunk
      // from a pipe at close range.
      const root = Math.exp(-t * 11);
      const flute = Math.max(0, Math.cos(theta * rootCount + rootPhase));
      const ridge = Math.sin(theta * 7 + t * 5.5) * 0.045;
      return 1 + root * 0.72 * Math.pow(flute, 1.6) + ridge * (1 - root * 0.5);
    },
  });

  /* ---- limbs ------------------------------------------------------ */
  const parts: THREE.BufferGeometry[] = [trunkGeo];

  /* ---- roots ------------------------------------------------------ */
  /**
   * Root buttresses that sweep out of the base and dive under the turf.
   *
   * The lobe function above widens the trunk at its foot, but a widened cylinder
   * still terminates in a *circle*, and a circle sitting on a lawn is a fence
   * post. What makes a tree look grown out of the ground is a handful of roots
   * crossing the boundary — the silhouette of the base becomes irregular and the
   * eye stops looking for the seam. They live in the trunk geometry, so they
   * ride the same instance matrix and cost no extra draw call.
   */
  {
    const baseR = radiusAt(0);
    const rootN = def.roots;
    const az0 = rng() * Math.PI * 2;
    for (let i = 0; i < rootN; i++) {
      const az = az0 + (i / rootN) * Math.PI * 2 + rangeOf(rng, -0.35, 0.35);
      const reach = baseR * rangeOf(rng, 1.5, 2.9);
      const rr = baseR * rangeOf(rng, 0.30, 0.46);
      const bendAz = az + rangeOf(rng, -0.5, 0.5);
      const rp: THREE.Vector3[] = [];
      const RS = 4;
      for (let k = 0; k <= RS; k++) {
        const u = k / RS;
        // Shoulder high at the trunk, plunging below the turf at the tip: a
        // quarter-circle in section, which is the shape of a real buttress.
        const y = 0.30 * baseR * (1 - u) - u * u * 0.42 * baseR - u * 0.06;
        const d = reach * u;
        rp.push(
          new THREE.Vector3(
            Math.cos(az) * d * 0.7 + Math.cos(bendAz) * d * 0.3,
            y + 0.16 * baseR,
            Math.sin(az) * d * 0.7 + Math.sin(bendAz) * d * 0.3,
          ),
        );
      }
      parts.push(
        taperedTube({
          spine: rp,
          rings: 5,
          radial: 6,
          vScale: reach * 1.6,
          radius: (u) => rr * Math.pow(1 - u * 0.82, 0.6) + 0.01,
          // Flattened in section — roots spread sideways, they are not dowels.
          lobe: (_u, theta) => 1 + Math.cos(theta * 2) * 0.22,
        }),
      );
    }
  }
  const limbTips: THREE.Vector3[] = [];
  const attach = new THREE.Vector3();
  const tangent = new THREE.Vector3();

  for (let i = 0; i < def.limbs; i++) {
    const t = clamp(
      def.limbStart + (i / Math.max(1, def.limbs - 1)) * (def.limbEnd - def.limbStart) +
        rangeOf(rng, -0.06, 0.06),
      0.14,
      0.99,
    );
    curve.getPointAt(t, attach);
    curve.getTangentAt(t, tangent);

    // Golden-angle phyllotaxis plus jitter: limbs spiral round the trunk the
    // way they do on a real tree instead of sitting on one plane.
    const az = i * 2.39996 + rng() * 0.9;
    const rise = lerp(1.15, 0.5, t) + rng() * 0.35;
    const len = def.h * rangeOf(rng, 0.3, 0.52) * (1 - t * 0.35);
    const dir = new THREE.Vector3(Math.cos(az), rise, Math.sin(az)).normalize();

    const lp: THREE.Vector3[] = [];
    const LS = 4;
    for (let k = 0; k <= LS; k++) {
      const u = k / LS;
      // Limbs bend upward toward the light as they extend.
      const up = u * u * 0.42;
      lp.push(
        new THREE.Vector3(
          attach.x + dir.x * len * u + tangent.x * len * u * 0.25,
          attach.y + dir.y * len * u + len * up * 0.5,
          attach.z + dir.z * len * u + tangent.z * len * u * 0.25,
        ),
      );
    }
    const baseR = radiusAt(t) * rangeOf(rng, 0.42, 0.6);
    parts.push(
      taperedTube({
        spine: lp,
        rings: 6,
        radial: 7,
        vScale: len * 0.6,
        radius: (u) => baseR * Math.pow(1 - u * 0.94, 0.7) + 0.012,
        lobe: (_u, theta) => 1 + Math.sin(theta * 5) * 0.04,
      }),
    );
    limbTips.push(lp[LS].clone());
  }

  const trunk = mergeGeos(parts);
  const totalH = def.h + def.crownR * def.crownSquash * 1.5;

  // Bark contact darkening. Trunks are lit from one side and lose everything in
  // the grass at the base; baking it means the tree meets the ground instead of
  // being dropped onto it.
  {
    const pos = trunk.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      // Two stacked terms. The wide one is the ambient gradient up the bole; the
      // tight one is the contact ring in the first 25 cm, where the turf, the
      // litter and the roots occlude nearly all of the sky. Without the tight
      // term the trunk is uniformly lit right down to the blade of grass it
      // touches, which is exactly what "planted on the ground" looks like.
      const amb = lerp(0.68, 1.0, smoothstep(-0.05, 1.5, y));
      const contact = lerp(0.30, 1.0, smoothstep(-0.12, 0.46, y));
      const ao = amb * contact;
      colors[i * 3] = ao;
      // Bounce off the litter is warm, so the shaded base goes brown, not grey.
      colors[i * 3 + 1] = ao * lerp(0.96, 1.0, smoothstep(0, 1.2, y));
      colors[i * 3 + 2] = ao * lerp(0.82, 1.0, smoothstep(0, 1.2, y));
    }
    trunk.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    setFlex(trunk, (_x, y) => [Math.pow(clamp(y / totalH, 0, 1), 2.1) * 0.55, 0.12]);
  }

  /* ---- crown ------------------------------------------------------ */
  const balls: Ball[] = [];
  const top = curve.getPointAt(1, new THREE.Vector3());
  const cR = def.crownR;

  if (def.crown === 'conic') {
    // Eight closely-spaced layers rather than five widely-spaced ones. The
    // spacing has to stay below the sum of adjacent radii or the top of the
    // cone stops fusing with the layer under it and flies off as a free blob.
    const layers = 8;
    const spread = cR * def.crownSquash * 1.45;
    for (let i = 0; i < layers; i++) {
      const u = i / (layers - 1);
      const r = cR * lerp(1.0, 0.22, Math.pow(u, 0.92));
      balls.push({
        x: top.x + rangeOf(rng, -0.22, 0.22) * r,
        y: top.y - cR * 0.35 + u * spread,
        z: top.z + rangeOf(rng, -0.22, 0.22) * r,
        r,
        sy: 0.88,
      });
    }
  } else if (def.crown === 'open') {
    // Separated masses so daylight punches through the crown — the point of an
    // "open" tree is the gaps. They still have to reach the core, though: a
    // satellite further out than about 1.6x its own radius stops fusing and
    // ends up as a lump of leaves floating in the sky.
    balls.push({
      x: top.x, y: top.y + cR * 0.30, z: top.z,
      r: cR * 0.74, sy: def.crownSquash,
    });
    for (const tip of limbTips) {
      const r = cR * rangeOf(rng, 0.56, 0.86);
      const reach = Math.min(1, (cR * 0.74 + r) * 0.94 / Math.max(0.001, Math.hypot(tip.x, tip.z)));
      balls.push({
        x: tip.x * reach,
        y: top.y + cR * 0.3 + (tip.y - top.y - cR * 0.3) * 0.75 + cR * rangeOf(rng, 0.05, 0.3),
        z: tip.z * reach,
        r,
        sy: def.crownSquash,
      });
    }
  } else {
    /**
     * A ring of lobes around a *small* core, not one big ball with bumps.
     *
     * The old crown was a ball of radius `cR` with satellites pulled in to 80%
     * of touching distance, so every lump was swallowed by the core and the
     * result was a single convex mass — a smooth ceiling with no holes. Two
     * numbers fix it: the core drops to ~0.8 of its old radius, and the
     * satellites push out to 92% of touching distance instead of 80%. They still
     * fuse (past ~1.1 they detach and fly off as free blobs of leaves), but the
     * saddles between them now dip deep enough to be gaps, and gaps are what
     * lets daylight through the canopy and what makes the silhouette read as
     * several masses of leaves rather than one shell.
     */
    const central = def.crown === 'dome' ? 0.78 : 0.84;
    balls.push({
      x: top.x, y: top.y + cR * (def.crown === 'dome' ? 0.62 : 0.36), z: top.z,
      r: cR * central, sy: def.crownSquash,
    });
    for (const tip of limbTips) {
      const r = cR * rangeOf(rng, 0.52, 0.80);
      const reach = Math.min(1, (cR * central + r) * 0.92 / Math.max(0.001, Math.hypot(tip.x, tip.z)));
      balls.push({
        x: tip.x * reach,
        y: tip.y + cR * rangeOf(rng, 0.06, 0.26),
        z: tip.z * reach,
        r,
        sy: def.crownSquash * rangeOf(rng, 0.85, 1.1),
      });
    }
    // One deliberately off-centre lobe. Perfect radial symmetry is the tell
    // that a canopy was generated rather than grown.
    const az = rng() * Math.PI * 2;
    balls.push({
      x: top.x + Math.cos(az) * cR * 0.85,
      y: top.y + cR * rangeOf(rng, 0.1, 0.55),
      z: top.z + Math.sin(az) * cR * 0.85,
      r: cR * rangeOf(rng, 0.42, 0.6),
      sy: def.crownSquash,
    });
  }

  // Padding matters: the Wyvill isosurface sits at ~1.17x a lone ball's radius
  // and further where blobs overlap, so a tight bounding box slices the crown
  // flat at the top. Scale the pad with the crown instead of using a constant.
  const canopy = metaSurface(balls, {
    resolution: def.res,
    isoLevel: 1.0,
    padding: cR * 0.4,
    smooth: 0.85,
  });
  noiseDisplace(canopy, cR * def.lumpy, 1.05 / cR, seed ^ 0x9e37, 3);
  noiseDisplace(canopy, cR * def.lumpy * 0.34, 3.4 / cR, seed ^ 0x51ed, 2);

  canopy.setAttribute('uv', boxProjectedUV(canopy, 0.40));

  // Blend the geometric normal toward the direction out of the crown centre.
  // Full geometric normals make every metaball lump shade as its own sphere;
  // fully spherified normals lose the lumps. Just under half-way keeps the
  // silhouette detail while the shading reads as one soft volume.
  {
    canopy.computeVertexNormals();
    const pos = canopy.attributes.position as THREE.BufferAttribute;
    const nor = canopy.attributes.normal as THREE.BufferAttribute;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const b of balls) {
      cx += b.x;
      cy += b.y;
      cz += b.z;
    }
    cx /= balls.length;
    cy /= balls.length;
    cz /= balls.length;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i) - cx, pos.getY(i) - cy, pos.getZ(i) - cz).normalize();
      n.fromBufferAttribute(nor, i).lerp(v, 0.42).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    nor.needsUpdate = true;
  }

  const thick = bakeCanopyShading(canopy, balls as { x: number; y: number; z: number; r: number }[], {
    interior: 0.62,
    underside: 0.24,
    cool: 0.55,
  });

  {
    const pos = canopy.attributes.position as THREE.BufferAttribute;
    const flex = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const rad = Math.hypot(pos.getX(i), pos.getZ(i)) / Math.max(0.4, cR);
      const f = Math.pow(clamp(y / totalH, 0, 1), 1.25) * (0.62 + 0.38 * clamp(rad, 0, 1));
      flex[i * 2] = f;
      flex[i * 2 + 1] = thick[i];
    }
    canopy.setAttribute('aFlex', new THREE.BufferAttribute(flex, 2));
    canopy.computeBoundingSphere();
  }

  // Leaf clusters over the crown. Count scales with surface area so a big oak
  // is not skinned at the same density as a spruce. Both the count and the card
  // size are up hard on the old values and the cards sit proud of the surface
  // rather than half-buried: the blob's silhouette is the thing that reads as
  // 2004, and only these cards break it.
  const fringe = shellCards(canopy, {
    seed: seed ^ 0x1eaf,
    count: Math.round(150 + cR * cR * def.crownSquash * 88),
    // A wider size band for the same card count. The silhouette of a real crown
    // is broken at several scales at once — big terminal clumps with scraps
    // between them — and a narrow band gives an evenly scalloped edge, which is
    // its own kind of procedural tell. Less sink for the same reason: the cards
    // have to stand proud of the blob to break its outline at all.
    minSize: cR * 0.20,
    // 0.66 was too far: the biggest cards are wider than the opaque pad at the
    // root of the cluster texture is tall, so a card caught face-on showed that
    // pad as a bare green lozenge sitting on the crown. 0.56 keeps the size
    // spread without any single card being large enough to read as a panel.
    maxSize: cR * 0.56,
    upBias: def.crown === 'conic' ? 0.12 : 0.26,
    sink: 0.30,
    flexBoost: 0.45,
    crownBias: 0.68,
  });
  // Re-normalise compliance against the whole tree so a card 6m up moves like
  // the branch under it rather than like a blade of grass on the ground.
  if (fringe.attributes.aFlex) {
    const fa = fringe.attributes.aFlex as THREE.BufferAttribute;
    const fp = fringe.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < fa.count; i++) {
      fa.setX(i, fa.getX(i) * Math.pow(clamp(fp.getY(i) / totalH, 0, 1), 0.9));
    }
    fa.needsUpdate = true;
  }

  trunk.computeBoundingSphere();
  return { trunk, canopy, fringe, height: totalH, trunkR: def.r + def.flare * 0.4 };
}

/* ------------------------------------------------------------------ */
/* Bush construction                                                   */
/* ------------------------------------------------------------------ */

function buildBush(
  seed: number,
  size: number,
  lobes: number,
): { shell: THREE.BufferGeometry; fringe: THREE.BufferGeometry } {
  const rng = makeRng(seed);
  const balls: Ball[] = [];
  for (let i = 0; i < lobes; i++) {
    const az = i * 2.39996 + rng();
    const rad = i === 0 ? 0 : size * rangeOf(rng, 0.34, 0.62);
    balls.push({
      x: Math.cos(az) * rad,
      y: size * rangeOf(rng, 0.42, 0.78) * (i === 0 ? 1.05 : 1),
      z: Math.sin(az) * rad,
      r: size * rangeOf(rng, 0.44, 0.66),
      sy: rangeOf(rng, 0.74, 0.96),
    });
  }
  const geo = metaSurface(balls, { resolution: 16, isoLevel: 1.0, padding: size * 0.4, smooth: 1.1 });
  noiseDisplace(geo, size * 0.15, 1.7 / size, seed ^ 0x2b45, 3);
  geo.setAttribute('uv', boxProjectedUV(geo, 0.85));
  geo.computeVertexNormals();

  const thick = bakeCanopyShading(geo, balls as { x: number; y: number; z: number; r: number }[], {
    interior: 0.58,
    underside: 0.44,
    cool: 0.5,
  });
  geo.computeBoundingBox();
  const maxY = geo.boundingBox!.max.y || 1;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const flex = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    flex[i * 2] = Math.pow(clamp(pos.getY(i) / maxY, 0, 1), 1.3);
    flex[i * 2 + 1] = thick[i];
  }
  geo.setAttribute('aFlex', new THREE.BufferAttribute(flex, 2));
  geo.computeBoundingSphere();

  // A bush sits at eye-to-knee height in almost every shot in the town, so its
  // silhouette is scrutinised harder than a canopy twenty metres away. It gets
  // proportionally more, larger cards than a tree does.
  const fringe = shellCards(geo, {
    seed: seed ^ 0x1eaf,
    count: Math.round(105 + size * 205),
    minSize: size * 0.23,
    maxSize: size * 0.42,
    upBias: 0.5,
    sink: 0.32,
    flexBoost: 0.6,
    crownBias: 0.5,
  });
  return { shell: geo, fringe };
}

/* ------------------------------------------------------------------ */
/* Ground-cover geometry                                               */
/* ------------------------------------------------------------------ */

/** A tuft: three curved cards fanned out and tilted, so it reads from above. */
function grassTuftGeometry(seed: number, cards = 3, height = 0.44): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < cards; i++) {
    const h = height * rangeOf(rng, 0.78, 1.18);
    // Two segments, not three. A tuft is ~30cm tall and there are twenty-two
    // thousand of them; the third segment adds two triangles of curve to a
    // blade that is a handful of pixels tall even when you are standing on it,
    // and multiplied out it was ~130k triangles in every pass of every frame.
    const card = curvedCard(h * rangeOf(rng, 0.85, 1.1), h, rangeOf(rng, 0.05, 0.14) * h, 0, 2);
    // Tilt outward so a top-down camera sees leaf area instead of a razor edge.
    card.rotateX(rangeOf(rng, 0.12, 0.3));
    card.rotateY((i / cards) * Math.PI * 2 + rangeOf(rng, -0.3, 0.3));
    card.translate(rangeOf(rng, -0.05, 0.05), 0, rangeOf(rng, -0.05, 0.05));
    parts.push(card);
  }
  const geo = mergeGeos(parts);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const maxY = geo.boundingBox!.max.y || 1;
  // Root-to-tip occlusion. Without it a tuft is a flat cut-out standing on the
  // lawn; with it, the base sinks into the turf and the tips catch the sun.
  // (It is also mandatory: a vertexColors material with no colour attribute
  // reads the attribute default of black.)
  tintByHeight(geo, maxY, 0.42, 0x86a35e);
  setFlex(geo, (_x, y) => {
    const t = clamp(y / maxY, 0, 1);
    return [Math.pow(t, 1.5), 0.35 + t * 0.65];
  });
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A scrap of forest floor: two overlapping cards of leaf litter lying almost
 * flat, at slightly different heights and angles.
 *
 * The ground under the treeline was flat green with hard-edged splat patches, and
 * no amount of grass fixes that — grass is the *same* colour as the problem.
 * Litter works because it is the wrong hue: warm browns and tired ochres against
 * a green lawn, which breaks up both the value and the hue of the turf and reads
 * as the layer of dead leaves that is actually under every real tree.
 *
 * Two cards rather than one, offset and tilted, so the patch has a broken outline
 * of its own and does not read as a rectangular decal from a grazing angle.
 */
function litterPatchGeometry(seed: number, size: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const R = size * 0.5;
  const RAD = 9;
  const RING = 3;

  /**
   * A drift, not a decal.
   *
   * The previous version was two flat `PlaneGeometry` quads laid at
   * `ground(x, z) + 12 mm`, and that is wrong in two ways at once, both of which
   * were plainly visible in the treeline and exterior shots:
   *
   *  - **It is coplanar with the terrain.** 12 mm of separation does not survive
   *    a depth buffer at 40 m of far plane, so every patch z-fought with the turf
   *    and rendered as a dense stipple of interleaved brown and green.
   *  - **It is flat and the ground is not.** The treeline sits on the slope
   *    rising to y ~ 2.6, and a rigid 1.45 m quad on a 15 degree slope buries one
   *    edge and floats the other. What remains above the turf is a
   *    *straight-edged* sliver, so the wood was littered with hard-cornered dark
   *    rectangles that read as scorch marks in a lawn.
   *
   * The fix is the same one the buildings use for their dirt skirts: drape rather
   * than lay. This is a low mound — a radial dome about 12% of its radius high,
   * whose outer ring dives *below* the ground. Nothing is coplanar (every face
   * is tilted, so it catches its own shade and z-fighting is impossible), and the
   * terrain cuts the mound along its curved buried rim rather than across a
   * straight edge, so a patch on a slope reads as litter thinning into grass.
   *
   * The radius is also wobbled per-vertex, so the outline is a lobed blob rather
   * than a circle, and the alpha-cut leaf texture breaks it further.
   */
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  // Per-spoke radius and height wobble, generated once so the ring seam closes.
  const wob: number[] = [];
  const hWob: number[] = [];
  for (let a = 0; a < RAD; a++) {
    wob.push(rangeOf(rng, 0.68, 1.22));
    hWob.push(rangeOf(rng, 0.7, 1.3));
  }
  // Ring radii, and their height as a fraction of R. The last ring is negative:
  // it is the buried skirt that absorbs whatever the terrain does underneath.
  const rr = [0, 0.42, 0.78, 1.0];
  // The skirt dives only 5% of the radius, not 15%. A deep skirt is a band of
  // outward- and *downward*-facing wall, and on the treeline's slope the downhill
  // half of that band stands clear of the turf — where, facing away from both the
  // sun and the sky, it rendered as a black dash. From twenty of those per screen
  // the forest floor looked cracked. The rim barely needs to dip at all: the
  // radial UV puts the outer ring at the edge of the litter texture, which is
  // transparent there, so the alpha test does most of the burying.
  const hh = [0.13, 0.105, 0.05, -0.055];
  for (let k = 0; k <= RING; k++) {
    for (let a = 0; a <= RAD; a++) {
      const ai = a % RAD;
      const th = (a / RAD) * Math.PI * 2;
      const r = R * rr[k] * lerp(1, wob[ai], rr[k]);
      const y = R * hh[k] * (k === RING ? 1 : hWob[ai]);
      positions.push(Math.cos(th) * r, y, Math.sin(th) * r);
      // Radial UV so one litter texture covers the whole mound once.
      uvs.push(0.5 + Math.cos(th) * rr[k] * 0.5, 0.5 + Math.sin(th) * rr[k] * 0.5);
    }
  }
  const stride = RAD + 1;
  for (let k = 0; k < RING; k++) {
    for (let a = 0; a < RAD; a++) {
      const i0 = k * stride + a;
      const i1 = i0 + 1;
      const i2 = i0 + stride;
      const i3 = i2 + 1;
      if (k === 0) {
        indices.push(i0, i2, i3);
      } else {
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  /**
   * Flatten the normals toward world up.
   *
   * Litter is a *ground* surface: physically it is a 2 cm layer of leaves, and
   * every part of it — including the part draped over the shoulder of the mound —
   * sees the same sky the turf beside it sees. The mound's geometric normals do
   * not say that. The rim's point outward and slightly down, which under a sky
   * fill and a 38 degree sun is nearly unlit, so the shoulder of every patch came
   * out as a dark rind around a lit centre. Biasing 78% toward +Y keeps just
   * enough of the real shape to give the mound a soft form while lighting it like
   * the ground it is part of.
   */
  {
    const nor = geo.attributes.normal as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    for (let i = 0; i < nor.count; i++) {
      n.fromBufferAttribute(nor, i);
      n.y += 0.78 * (1 - n.y);
      n.normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    nor.needsUpdate = true;
  }

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // Value break across the mound, a little darker in the rim where the grass
    // closes over it. This is the contact shading that stops the patch reading as
    // a sticker laid on top of the turf. Only a shallow gradient though — the rim
    // used to reach 0.62 and that, multiplied into an already grazing-lit face,
    // is what made the edge of a drift read as a hole rather than as a hollow.
    const rel = clamp(pos.getY(i) / (R * 0.13), -1, 1);
    const v = rangeOf(rng, 0.86, 1.06) * lerp(0.82, 1.0, smoothstep(-0.9, 0.45, rel));
    colors[i * 3] = v;
    colors[i * 3 + 1] = v * 0.98;
    colors[i * 3 + 2] = v * 0.92;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Dead leaves on the ground do not sway; they still need the attribute.
  setFlex(geo, () => [0, 0.1]);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A fallen branch: one bent, tapered stick with a side stub, resting on the
 * ground along its own local +X.
 *
 * This is the piece of detail that makes a forest floor read as a forest rather
 * than as a lawn with trees standing on it. It shares the bark material, so it
 * is free of a texture bake, and because it is instanced the whole wood's
 * deadfall is one draw call.
 */
function deadfallGeometry(seed: number, len: number, r: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const bendAz = rng() * Math.PI * 2;
  const sag = rangeOf(rng, 0.05, 0.14);
  const spine: THREE.Vector3[] = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    spine.push(
      new THREE.Vector3(
        t * len,
        // Sits on the ground at both ends, bowed up in the middle: a stick lying
        // on turf is supported at its ends, and the gap under the bow is what
        // makes it read as *on* the ground rather than half sunk into it.
        r * 0.9 + Math.sin(t * Math.PI) * r * sag * 9,
        Math.sin(t * 2.3 + bendAz) * len * 0.07,
      ),
    );
  }
  const main = taperedTube({
    spine,
    rings: 5,
    radial: 6,
    vScale: len * 1.5,
    radius: (t) => r * Math.pow(1 - t * 0.66, 0.55) + 0.008,
    lobe: (_t, theta) => 1 + Math.sin(theta * 5 + 1.1) * 0.07,
  });

  // One side shoot. A straight bare stick reads as dropped dowel.
  const az = rangeOf(rng, 0.7, 1.5) * (rng() < 0.5 ? 1 : -1);
  const at = rangeOf(rng, 0.35, 0.65);
  const base = spine[Math.round(at * 4)];
  const sl = len * rangeOf(rng, 0.22, 0.38);
  const sp: THREE.Vector3[] = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    sp.push(
      new THREE.Vector3(
        base.x + Math.cos(az) * sl * t,
        base.y - t * r * 0.5,
        base.z + Math.sin(az) * sl * t,
      ),
    );
  }
  const stub = taperedTube({
    spine: sp,
    rings: 3,
    radial: 5,
    vScale: sl * 1.5,
    radius: (t) => r * 0.5 * Math.pow(1 - t * 0.9, 0.6) + 0.006,
  });

  const geo = mergeGeos([main, stub]);
  geo.computeVertexNormals();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // Dead wood is greyer and darker than a living trunk, and the underside is
    // in permanent contact shadow.
    const ao = lerp(0.52, 1.0, clamp(pos.getY(i) / (r * 2.2), 0, 1));
    colors[i * 3] = ao * 0.86;
    colors[i * 3 + 1] = ao * 0.82;
    colors[i * 3 + 2] = ao * 0.74;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  setFlex(geo, () => [0, 0.08]);
  geo.computeBoundingSphere();
  return geo;
}

/** Darkens a plant toward its base and cools the shadow rather than greying it. */
function tintByHeight(
  geo: THREE.BufferGeometry,
  maxY: number,
  baseDark: number,
  coolHex: number,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const cool = new THREE.Color(coolHex);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp(pos.getY(i) / maxY, 0, 1);
    const ao = lerp(1 - baseDark, 1.0, smoothstep(0, 0.72, t));
    const k = (1 - ao) * 0.8;
    colors[i * 3] = lerp(ao, cool.r * 1.6 * ao, k);
    colors[i * 3 + 1] = lerp(ao, cool.g * 1.4 * ao, k);
    colors[i * 3 + 2] = lerp(ao, cool.b * 1.5 * ao, k);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Three rounded clover leaves on short stalks. */
function cloverGeometry(seed: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const r = rangeOf(rng, 0.045, 0.072);
    // A 5-6cm leaf: five segments read as round once the dome below curves it,
    // and there are ~5800 clovers paying for every extra triangle three times.
    const leaf = new THREE.CircleGeometry(r, 4);
    // Dome the leaf so it catches a highlight rather than reading as a decal.
    const pos = leaf.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const d = Math.hypot(pos.getX(k), pos.getY(k)) / r;
      pos.setZ(k, (1 - d * d) * r * 0.34);
    }
    leaf.rotateX(-Math.PI / 2 + rangeOf(rng, -0.42, -0.16));
    const az = (i / 3) * Math.PI * 2 + rng() * 0.5;
    leaf.rotateY(az);
    leaf.translate(Math.cos(az) * r * 0.86, rangeOf(rng, 0.035, 0.075), Math.sin(az) * r * 0.86);
    parts.push(leaf);
  }
  const geo = mergeGeos(parts);
  geo.computeVertexNormals();
  const colors = new Float32Array((geo.attributes.position as THREE.BufferAttribute).count * 3);
  colors.fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  setFlex(geo, (_x, y) => [clamp(y / 0.1, 0, 1) * 0.6, 0.8]);
  geo.computeBoundingSphere();
  return geo;
}

/** Oversized diorama flower: stem, five petals, a domed centre. */
function flowerGeometry(seed: number, accent: THREE.Color): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const height = rangeOf(rng, 0.18, 0.3);
  const tiltAz = rng() * Math.PI * 2;
  const tilt = rangeOf(rng, 0.06, 0.3);

  const spine: THREE.Vector3[] = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    spine.push(
      new THREE.Vector3(
        Math.cos(tiltAz) * tilt * height * t * t,
        height * t,
        Math.sin(tiltAz) * tilt * height * t * t,
      ),
    );
  }
  const stem = taperedTube({
    spine,
    rings: 3,
    // An 8mm stem. Four sides is already more than the silhouette can show.
    radial: 4,
    vScale: 1,
    radius: (t) => 0.008 * (1 - t * 0.35),
  });
  const head = spine[3];

  const parts: THREE.BufferGeometry[] = [stem];
  const petals = 5 + Math.floor(rng() * 2);
  const pr = rangeOf(rng, 0.042, 0.062);
  for (let i = 0; i < petals; i++) {
    const p = curvedCard(pr * 1.15, pr * 1.7, -pr * 0.42, 0, 2);
    p.rotateX(-Math.PI / 2 + rangeOf(rng, 0.5, 0.86));
    p.rotateY((i / petals) * Math.PI * 2 + rangeOf(rng, -0.1, 0.1));
    p.translate(head.x, head.y, head.z);
    parts.push(p);
  }
  // The flower centre is a ~2cm dome. Six-by-three was 24 triangles on
  // something that is never more than a few pixels of solid yellow.
  const centre = new THREE.SphereGeometry(pr * 0.42, 4, 2);
  centre.scale(1, 0.62, 1);
  centre.translate(head.x, head.y + pr * 0.12, head.z);
  parts.push(centre);

  const geo = mergeGeos(parts);
  geo.computeVertexNormals();

  // Vertex colours carry the part identity — green stem, accent petals, gold
  // centre — so one draw call covers a whole flower.
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const stemCount = (stem.attributes.position as THREE.BufferAttribute).count;
  const centreStart = pos.count - (centre.attributes.position as THREE.BufferAttribute).count;
  const gold = new THREE.Color(0xffd447);
  const green = new THREE.Color(0x5f9b3e);
  for (let i = 0; i < pos.count; i++) {
    let c: THREE.Color;
    if (i < stemCount) c = green;
    else if (i >= centreStart) c = gold;
    else {
      // Petals pale slightly toward the tip; a flat-coloured petal reads as
      // plastic at the diorama scale the art bible asks for.
      const t = clamp((pos.getY(i) - head.y) / (pr * 1.4) + 0.5, 0, 1);
      c = accent.clone().lerp(new THREE.Color(0xfaf3e4), t * 0.34);
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  setFlex(geo, (_x, y) => [Math.pow(clamp(y / height, 0, 1), 1.4), 0.7]);
  geo.computeBoundingSphere();
  return geo;
}

/** A leafy weed / small fern — five leaf cards fanned from one point. */
function weedGeometry(seed: number, size: number): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const n = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const h = size * rangeOf(rng, 0.7, 1.15);
    // Two segments, not three: a 50 cm fern frond a metre from the camera does
    // not show the third segment's curvature, and there are thousands of them.
    const card = curvedCard(h * 0.72, h, rangeOf(rng, 0.16, 0.34) * h, 0, 2);
    card.rotateX(rangeOf(rng, 0.24, 0.52));
    card.rotateY((i / n) * Math.PI * 2 + rangeOf(rng, -0.35, 0.35));
    parts.push(card);
  }
  const geo = mergeGeos(parts);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const maxY = geo.boundingBox!.max.y || 1;
  tintByHeight(geo, maxY, 0.36, 0x8aa668);
  setFlex(geo, (_x, y) => {
    const t = clamp(y / maxY, 0, 1);
    return [Math.pow(t, 1.4), 0.4 + t * 0.6];
  });
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildVegetation(ctx: GameContext): void {
  const rng = makeRng(ctx.seed ^ 0x5eed1e5);
  const ground = ctx.collision.groundHeight;
  const mask = new PlantMask(ctx);
  const clump = new Simplex(ctx.seed ^ 0x0c10ff);

  const group = new THREE.Group();
  group.name = 'Vegetation';
  ctx.scene.add(group);

  /* ---------------- materials -------------------------------------- */

  /**
   * Three bark surfaces, not one.
   *
   * The old wood used `TextureLab.barkMaps` for every species: one grey-brown
   * albedo whose noise is stretched 8 : 1 in u : v, which is where the vertical
   * streak down every trunk came from. `barkSet` (see FoliageMaterials) replaces
   * it with a plated Worley field — cracks between plates, fine fibre inside
   * them, horizontal checking across them — authored in a warm palette and baked
   * with a deliberately violent normal map, because a trunk fills a third of the
   * frame in the treeline shot and relief is the only thing that stops it
   * reading as a painted tube.
   *
   * `roughShare` slides the same field from a deeply fissured oak to an almost
   * smooth birch, so three bakes cover the whole wood. Material colour is white:
   * hue arrives entirely as the per-species `barkTint` instance colour, which
   * means eight species of trunk cost three textures and zero extra draw calls.
   */
  const barkSets: Record<BarkSet, ReturnType<typeof barkSet>> = {
    oak: barkSet('oak', 0x3d2716, 0xb28c5a, 1.0, 512),
    // Was 0x4e4335 → 0xa8977a: both neutral, and the crack colour in particular
    // was a dead grey, so the deepest, most visible part of the relief carried no
    // hue at all. Warm both ends and the whole surface reads as wood.
    ash: barkSet('ash', 0x453424, 0xac9268, 0.72, 512),
    // Birch: the paper is warm-white, the lenticels are grey-brown.
    pale: barkSet('pale', 0x7d7565, 0xf2ece0, 0.22, 512),
  };
  const makeBarkMat = (set: BarkSet) =>
    createFoliageMaterial(ctx.env, {
      color: 0xffffff,
      map: barkSets[set].map,
      // The albedo is mid-value by construction, so it only needs a light lift
      // to survive a stylised sky. Lifting harder is what bleached the old
      // trunks to grey card.
      mapContrast: 0.86,
      normalMap: barkSets[set].normalMap,
      roughnessMap: barkSets[set].roughnessMap,
      normalScale: set === 'pale' ? 1.2 : 2.0,
      roughness: 0.94,
      windScale: 0.16,
      // Bark is opaque, but a low wrap keeps the shaded side of a trunk from
      // going to flat black under one low sun.
      wrap: 0.34,
      transStrength: 0.0,
      haloStrength: 0.0,
      side: THREE.FrontSide,
    });
  const barkMats: Record<BarkSet, THREE.MeshStandardMaterial> = {
    oak: makeBarkMat('oak'),
    ash: makeBarkMat('ash'),
    pale: makeBarkMat('pale'),
  };

  // Three leaf palettes rather than six: species read apart on silhouette and
  // instance tint, and three 512² bakes is already a noticeable slice of the
  // loading budget.
  const leafSets: Record<LeafSet, ReturnType<typeof leafMaps>> = {
    warm: leafMaps('warm', 0x4e8c3c, 0xaadd6c, 512),
    cool: leafMaps('cool', 0x3f7d4a, 0x92d072, 512),
    needle: leafMaps('needle', 0x3a6b46, 0x7cb266, 512),
  };

  const canopyMat = (set: LeafSet, tint: number, wind: number, tri = 0.55) =>
    createFoliageMaterial(ctx.env, {
      color: tint,
      map: leafSets[set].map,
      normalMap: leafSets[set].normalMap,
      roughnessMap: leafSets[set].roughnessMap,
      normalScale: 0.9,
      roughness: 0.86,
      windScale: wind,
      wrap: 0.52,
      transColor: set === 'needle' ? 0x8fc86a : 0xb2e065,
      // Backlit leaves have to *glow*, not merely be lit. transPower down and
      // strength up widens the transmission lobe so the whole sunward half of a
      // crown lifts instead of only the few vertices pointing at the sun.
      transStrength: 2.9,
      transPower: 2.1,
      haloStrength: 0.18,
      triplanar: tri,
    });

  // The leaf-cluster cards that break every blob silhouette. One texture, one
  // material per leaf palette — the cards read apart through per-instance tint
  // and the vertex gradient baked into each card, not through extra bakes.
  // Two clump scales, because a leaf is an absolute size and a canopy is not.
  // The tree texture is coarse so its scallops still read from twenty metres;
  // the shrub texture packs three times as many, much smaller leaves, because a
  // bush is looked at from two metres and 40cm leaves make it a houseplant.
  const clusterTex = leafClusterTexture('canopy', ctx.seed ^ 0x1eafc1, 17, 1.0);
  const shrubTex = leafClusterTexture('shrub', ctx.seed ^ 0x1eafc2, 40, 0.46);
  const makeFringeMat = (set: LeafSet, tex: THREE.Texture) =>
    createFoliageMaterial(ctx.env, {
      color: set === 'needle' ? 0xc9e0b4 : set === 'cool' ? 0xdcf0c2 : 0xe8f4cc,
      map: tex,
      roughness: 0.88,
      windScale: 1.25,
      wrap: 0.62,
      transColor: set === 'needle' ? 0x8fc86a : 0xb2e065,
      // The cards are one leaf thick and they are the part of the crown the sky
      // is actually behind, so they carry the strongest transmission in the
      // scene. This is what makes a backlit treeline read as foliage.
      transStrength: 3.4,
      transPower: 2.0,
      haloStrength: 0.2,
      alphaTest: 0.38,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });

  const fringeMats: Record<LeafSet, THREE.MeshStandardMaterial> = {
    warm: makeFringeMat('warm', clusterTex),
    cool: makeFringeMat('cool', clusterTex),
    needle: makeFringeMat('needle', clusterTex),
  };
  const shrubMats: Record<'warm' | 'cool', THREE.MeshStandardMaterial> = {
    warm: makeFringeMat('warm', shrubTex),
    cool: makeFringeMat('cool', shrubTex),
  };

  /**
   * The canopy's shadow-pass stand-in: the same blob, alpha-cut by a coarse hole
   * mask so the shade it throws is dappled rather than solid.
   *
   * `DoubleSide` deliberately. Three.js normally shadow-renders a `FrontSide`
   * material from its back faces to push the acne behind the geometry, but a
   * perforated blob is no longer a closed volume — cutting a hole in the front
   * exposes the inside of the back, and a single-sided depth pass would then let
   * light through the *whole* crown rather than through one gap.
   */
  const canopyDepthMat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    alphaMap: canopyPerforationMap(),
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });

  /* ---------------- species geometry ------------------------------- */

  const built = SPECIES.map((def, i) => ({
    def,
    geo: buildTree(def, (ctx.seed ^ 0x7ee0) + i * 7919),
    mat: canopyMat(def.leafSet, def.tint, 1.0),
    fringeMat: fringeMats[def.leafSet],
    barkMat: barkMats[def.bark],
    spots: [] as { x: number; z: number; s: number; yaw: number; tilt: number; tiltAz: number }[],
  }));

  /* ---------------- tree placement --------------------------------- */

  /**
   * Treeline density. Zero inside the town, ramping to solid at the map edge,
   * broken up by a low-frequency clump field so the wall of trees has bays and
   * promontories instead of a constant thickness.
   */
  const treeDensity = (x: number, z: number): number => {
    // Sides and the southern bank.
    const side = smoothstep(15.0, 21.0, Math.abs(x));
    const south = smoothstep(21.5, 27.0, z);
    // Northern headlands only — the middle of the north edge is the bay.
    const head = smoothstep(17.0, 22.0, Math.abs(x)) * smoothstep(-20.0, -26.0, z);
    let d = Math.max(Math.max(side, south), head);
    if (d <= 0) return 0;
    // Grass only, and never on a pad or the path.
    const m = mask.at(x, z);
    if (m < 0.55) return 0;
    d *= outsideBuildings(x, z, 1.4);
    // Clumping: copses and clearings.
    const c = fbm2(clump, x * 0.09, z * 0.09, 3) * 0.5 + 0.5;
    // The wild-grass lobes are a deliberate clearing: no trunks in them.
    return clamp(d * (0.35 + c * 0.95), 0, 1) * 0.92 * wildGrassClearance(x, z, 1.6);
  };

  /**
   * Copses, not a lattice.
   *
   * A single Poisson pass with a fixed minimum distance is a *jammed packing*
   * once the attempt count saturates, and a jammed packing at 2.3 m looks
   * exactly like what it is: fifteen trunks at near-uniform spacing. It was the
   * second-worst thing about the treeline after the trunks themselves.
   *
   * So placement is two-tier. Poisson picks copse centres at 3.7 m — chosen so
   * that centres times mean cluster size reproduces the old total, because the
   * wood's overall mass was fine — and each centre grows one to five trees with
   * a radius distribution biased toward the middle. The result is stands of two
   * and three trees almost touching, with genuine clearings between them, and a
   * 1.5 m hard separation so nothing interpenetrates.
   */
  const treeSpots: Spot[] = [];
  {
    const copses = poisson(rng, {
      minX: -30.5, maxX: 30.5, minZ: -31, maxZ: 34,
      minDist: 3.7, attempts: 24000, density: treeDensity,
    });
    // Bucketed by copse for the separation test: over a few hundred trees a
    // naive all-pairs check is fine, but a copse only ever collides with its own
    // members and its immediate neighbours, so test against a local window.
    const MIN_SEP2 = 1.5 * 1.5;
    for (const c of copses) {
      // Cluster size skewed low: mostly singles and pairs, occasional thicket.
      const n = 1 + Math.floor(Math.pow(rng(), 1.35) * 5);
      const spread = rangeOf(rng, 0.9, 3.1);
      const start = treeSpots.length;
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const r = i === 0 ? 0 : spread * Math.pow(rng(), 0.55);
        const x = c.x + Math.cos(a) * r;
        const z = c.z + Math.sin(a) * r;
        if (treeDensity(x, z) <= 0.02) continue;
        let ok = true;
        // Own copse, plus the tail of the list (spatially adjacent, since
        // Poisson emits in dart order and neighbours cluster in that order too).
        for (let k = Math.max(0, Math.min(start, treeSpots.length - 24)); k < treeSpots.length; k++) {
          const dx = treeSpots[k].x - x;
          const dz = treeSpots[k].z - z;
          if (dx * dx + dz * dz < MIN_SEP2) {
            ok = false;
            break;
          }
        }
        if (ok) treeSpots.push({ x, z });
      }
    }
  }

  const placeTree = (x: number, z: number, speciesIdx: number) => {
    const b = built[speciesIdx];
    // Bigger trees deeper into the wood; the trees nearest the town are the
    // small ones, which keeps the treeline from crowding the eye line.
    const edge = clamp((Math.max(Math.abs(x) - 14, z - 21) / 12), 0, 1);
    // A 1.75 : 1 spread on top of the species' own 2.3 : 1 height spread. The
    // old 0.82–1.08 was a 1.3 : 1 band, which is inside the range a viewer
    // reads as "the same asset".
    const s = rangeOf(rng, 0.70, 1.22) * lerp(0.86, 1.22, edge);
    b.spots.push({
      x, z, s,
      yaw: rng() * Math.PI * 2,
      // Up to 9 degrees of lean, and never exactly zero. The old 4 degree cap
      // was small enough that every trunk read as vertical.
      tilt: rangeOf(rng, 0.02, 0.16),
      tiltAz: rng() * Math.PI * 2,
    });
  };

  for (const s of treeSpots) {
    // Species distribution varies with position so the wood has regions rather
    // than a uniform shuffle: conifers cluster on the high banks, birches in
    // the damper hollows near the shore.
    const bias = fbm2(clump, s.x * 0.045 + 30, s.z * 0.045, 2);
    let idx: number;
    const r = rng();
    if (bias > 0.18) idx = r < 0.5 ? 2 : r < 0.72 ? 1 : r < 0.9 ? 0 : 5;
    else if (bias < -0.18) idx = r < 0.4 ? 3 : r < 0.68 ? 4 : r < 0.88 ? 0 : 1;
    else idx = r < 0.3 ? 0 : r < 0.55 ? 4 : r < 0.75 ? 1 : r < 0.9 ? 5 : 3;
    placeTree(s.x, s.z, idx);
  }

  for (const [x, z, idx] of HERO_TREES) {
    if (mask.at(x, z) < 0.4) continue;
    // Two of the authored trees predate the wild-grass clearing on the shelf.
    if (wildGrassClearance(x, z) < 0.5) continue;
    placeTree(x, z, idx);
  }

  /* ---------------- tree instancing -------------------------------- */

  const culler = new InstanceCuller();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scl = new THREE.Vector3();
  const pos3 = new THREE.Vector3();
  const col = new THREE.Color();
  const treeBases: { x: number; z: number; r: number; y: number }[] = [];

  const barkTint = new THREE.Color();

  for (const b of built) {
    const n = b.spots.length;
    if (n === 0) continue;
    const cRng = makeRng(ctx.seed ^ (b.def.key.length * 7717) ^ n);
    // Species bark colour rides in as an instance tint over a white bark
    // material, so a birch is genuinely pale and an oak genuinely warm-brown
    // without a fourth texture bake or a fourth draw call.
    barkTint.setHex(b.def.barkTint);
    const btR = barkTint.r;
    const btG = barkTint.g;
    const btB = barkTint.b;
    const trunkMesh = makeInstanced(b.geo.trunk, b.barkMat, n, cRng, 1);
    const canopyMesh = makeInstanced(b.geo.canopy, b.mat, n, cRng, 1);
    const fringeMesh = makeInstanced(b.geo.fringe, b.fringeMat, n, cRng, 1);
    // Dappled light. The crown stays a solid mass in the beauty pass and is
    // rendered *perforated* into the shadow map, so sun-flecks fall through it
    // onto the forest floor. See `canopyPerforationMap`. One shared depth
    // material across every species: it samples nothing species-specific, and a
    // material per species would be eight programs for one effect.
    canopyMesh.customDepthMaterial = canopyDepthMat;
    // All three meshes must share phases or the crown will sway off its own
    // trunk and the leaf cards will slide off the crown.
    canopyMesh.geometry.setAttribute('aWind', trunkMesh.geometry.getAttribute('aWind'));
    fringeMesh.geometry.setAttribute('aWind', trunkMesh.geometry.getAttribute('aWind'));

    for (let i = 0; i < n; i++) {
      const sp = b.spots[i];
      // Slope- and girth-aware sink.
      //
      // A trunk is a vertical cylinder with a root flare, so on any gradient its
      // downhill side lifts clear of the surface: half the flare's width times
      // the slope. A fixed 9cm sink covers that on the flat town but not on the
      // hillside at x ~ +/-30, where trees were left visibly hovering with sky
      // under their bases. The tilt applied below pivots about the origin and
      // lifts the base further, so that is folded in too.
      const probe = 0.45 * sp.s;
      const gh = ground(sp.x, sp.z);
      const slope = Math.max(
        Math.abs(ground(sp.x + probe, sp.z) - ground(sp.x - probe, sp.z)),
        Math.abs(ground(sp.x, sp.z + probe) - ground(sp.x, sp.z - probe)),
      ) / (2 * probe);
      const flare = 0.34 * sp.s;
      const y = gh - 0.09 * sp.s - flare * slope - Math.tan(sp.tilt) * flare;
      euler.set(
        Math.cos(sp.tiltAz) * sp.tilt,
        sp.yaw,
        Math.sin(sp.tiltAz) * sp.tilt,
        'ZYX',
      );
      q.setFromEuler(euler);
      pos3.set(sp.x, y, sp.z);
      // Independent girth and height. A uniformly scaled tree is the *same*
      // tree seen from further away — what the eye reads is proportion, not
      // size, so slenderness has to vary per instance or two neighbours of one
      // species still read as copies. Costs nothing: it is one matrix.
      const girth = sp.s * rangeOf(cRng, 0.78, 1.28);
      scl.set(girth, sp.s * rangeOf(cRng, 0.80, 1.28), girth);
      m4.compose(pos3, q, scl);
      trunkMesh.setMatrixAt(i, m4);
      canopyMesh.setMatrixAt(i, m4);
      fringeMesh.setMatrixAt(i, m4);

      // Hue / value jitter. Warm-yellow in the light, cool-blue in the shade,
      // per ART_DIRECTION §3 — never a flat brightness scale.
      const warm = rangeOf(cRng, -1, 1);
      col.setRGB(
        1 + warm * 0.075 + rangeOf(cRng, -0.05, 0.05),
        1 + rangeOf(cRng, -0.055, 0.055),
        1 - warm * 0.1 + rangeOf(cRng, -0.05, 0.05),
      );
      canopyMesh.setColorAt(i, col);
      fringeMesh.setColorAt(i, col);
      // Value and warmth jitter on the bark, wide enough that a stand of one
      // species still has light trunks and dark trunks in it.
      const bt = rangeOf(cRng, -0.15, 0.15);
      col.setRGB(btR * (1 + bt), btG * (1 + bt * 0.85), btB * (1 + bt * 0.6));
      trunkMesh.setColorAt(i, col);

      treeBases.push({ x: sp.x, z: sp.z, r: b.geo.trunkR * girth, y });

      // Only things the player can reach need a blocker; the perimeter boxes
      // already stop them long before the outer wood.
      if (Math.abs(sp.x) < 23 && sp.z < 27 && sp.z > -27) {
        ctx.collision.addCircle(
          sp.x, sp.z,
          b.geo.trunkR * girth * 1.05 + 0.12,
          y - 1.0,
          y + b.geo.height * sp.s * 0.75,
          'tree',
        );
      }
    }
    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    fringeMesh.instanceMatrix.needsUpdate = true;
    if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;
    if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    if (fringeMesh.instanceColor) fringeMesh.instanceColor.needsUpdate = true;

    trunkMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    canopyMesh.castShadow = true;
    canopyMesh.receiveShadow = true;
    // The blob under the cards already casts the crown's shadow; making forty
    // thousand alpha-tested quads cast as well would double the shadow pass and
    // only add fringe noise to the shadow's edge.
    fringeMesh.castShadow = false;
    fringeMesh.receiveShadow = true;
    trunkMesh.name = `Trunk_${b.def.key}`;
    canopyMesh.name = `Canopy_${b.def.key}`;
    fringeMesh.name = `Leaves_${b.def.key}`;
    trunkMesh.computeBoundingSphere();
    canopyMesh.computeBoundingSphere();
    fringeMesh.computeBoundingSphere();
    group.add(trunkMesh, canopyMesh, fringeMesh);

    // One decision for the whole tree, and the shared wind buffer travels with
    // the permutation so crowns stay on their trunks. No distance cut: a tree
    // is silhouette, and the treeline thinning out would be the first thing a
    // reviewer noticed.
    culler.add([trunkMesh, canopyMesh, fringeMesh], { skipShadow: [fringeMesh] });
  }

  /* ---------------- bushes ----------------------------------------- */

  const bushGeos = [
    buildBush(ctx.seed ^ 0xb0511, 0.72, 4),
    buildBush(ctx.seed ^ 0xb0512, 0.55, 5),
    buildBush(ctx.seed ^ 0xb0513, 0.95, 6),
  ];
  // The shell is now backing, not surface: the leaf cards carry the read, so
  // it is darkened to act as the shrub's interior and its triplanar frequency
  // is tripled — at the old scale a single flat facet of the low-poly shell
  // showed one big smooth blob of leaf texture from a metre away.
  const bushMats = [
    canopyMat('warm', 0xbdd693, 1.35, 3.0),
    canopyMat('cool', 0xaccb85, 1.5, 3.4),
    canopyMat('warm', 0xc6da9c, 1.25, 2.7),
  ];
  const bushFringeMats: THREE.MeshStandardMaterial[] = [
    shrubMats.warm, shrubMats.cool, shrubMats.warm,
  ];

  const bushDensity = (x: number, z: number): number => {
    if (mask.at(x, z) < 0.75) return 0;
    if (ground(x, z) < 0.35) return 0;
    // Bushes hug things: the skirt of the wood, and the corners of buildings.
    const nearWood = smoothstep(11.5, 15.0, Math.abs(x)) * smoothstep(21.0, 16.5, Math.abs(x));
    const nearSouth = smoothstep(18.5, 22.5, z) * smoothstep(28, 24.5, z);
    let corner = 0;
    for (const f of FOOTPRINTS) {
      const dx = Math.abs(x - f.cx) - f.hx;
      const dz = Math.abs(z - f.cz) - f.hz;
      const d = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
      corner = Math.max(corner, smoothstep(1.9, 0.25, d) * (Math.min(dx, dz) > -0.4 ? 1 : 0));
    }
    // Free scatter is deliberately tiny and gated behind a low-frequency mask:
    // a bush every few metres across an open green reads as procedural litter,
    // a thicket in one corner reads as landscaping.
    const scatter =
      smoothstep(0.34, 0.62, fbm2(clump, x * 0.075 + 9, z * 0.075, 3) * 0.5 + 0.5) * 0.3;
    const d = clamp(Math.max(Math.max(nearWood, nearSouth) * 0.42, corner * 0.7) + scatter * 0.4, 0, 1);
    return d * outsideBuildings(x, z, 0.25) * wildGrassClearance(x, z);
  };

  const bushSpots = poisson(rng, {
    minX: -24, maxX: 24, minZ: -24, maxZ: 30,
    minDist: 2.5, attempts: 9000, density: bushDensity,
  });

  const bushBuckets: { x: number; z: number }[][] = [[], [], []];
  for (const s of bushSpots) bushBuckets[Math.floor(rng() * 3) % 3].push(s);

  bushBuckets.forEach((spots, bi) => {
    if (spots.length === 0) return;
    const bRng = makeRng(ctx.seed ^ (0x8005 + bi * 131));
    const mesh = makeInstanced(bushGeos[bi].shell, bushMats[bi], spots.length, bRng, 1);
    const leaves = makeInstanced(bushGeos[bi].fringe, bushFringeMats[bi], spots.length, bRng, 1);
    leaves.geometry.setAttribute('aWind', mesh.geometry.getAttribute('aWind'));
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      const sc = rangeOf(bRng, 0.62, 1.12);
      euler.set(rangeOf(bRng, -0.09, 0.09), bRng() * Math.PI * 2, rangeOf(bRng, -0.09, 0.09), 'ZYX');
      q.setFromEuler(euler);
      pos3.set(s.x, ground(s.x, s.z) - 0.14 * sc, s.z);
      scl.set(sc * rangeOf(bRng, 0.9, 1.15), sc * rangeOf(bRng, 0.82, 1.1), sc * rangeOf(bRng, 0.9, 1.15));
      m4.compose(pos3, q, scl);
      mesh.setMatrixAt(i, m4);
      leaves.setMatrixAt(i, m4);
      const warm = rangeOf(bRng, -1, 1);
      col.setRGB(1 + warm * 0.08, 1 + rangeOf(bRng, -0.05, 0.05), 1 - warm * 0.1);
      mesh.setColorAt(i, col);
      leaves.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    leaves.castShadow = false;
    leaves.receiveShadow = true;
    mesh.name = `Bush_${bi}`;
    leaves.name = `BushLeaves_${bi}`;
    mesh.computeBoundingSphere();
    leaves.computeBoundingSphere();
    group.add(mesh, leaves);

    culler.add([mesh, leaves], { skipShadow: [leaves] });
  });

  /* ---------------- forest floor ------------------------------------ */

  /**
   * Leaf litter and deadfall.
   *
   * Everything else in this file grows *up*. The floor of the wood needs the
   * opposite: warm dead matter lying flat, thickest at the foot of a trunk where
   * it actually accumulates, thinning out into the clearings. Two instanced
   * meshes and two draw calls buy the whole forest floor, and both are distance
   * culled hard because a 40 cm patch of brown is sub-pixel by 25 m.
   */
  {
    const litTex = litterTexture('floor', ctx.seed ^ 0x11a7e2, 3);
    const litMat = createFoliageMaterial(ctx.env, {
      // Toned from 0xcdbb9c. The litter texture is already authored in warm mid
      // browns; multiplying it by a near-cream material colour pushed the
      // brightest dead leaves up into a saturated brick that read as spilled
      // paint on the turf rather than as debris under a tree. Litter should be
      // *darker* than the grass it lies on, and only warmer in hue — but not so
      // dark that it disappears: the point of it is that the forest floor stops
      // being flat green, and a litter layer you cannot see does not do that.
      color: 0xb9a583,
      map: litTex,
      roughness: 0.96,
      windScale: 0.0,
      wrap: 0.5,
      transStrength: 0.0,
      haloStrength: 0.0,
      alphaTest: 0.42,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });
    // Two mound sizes. Pulled in from 0.85 / 1.45 m: a draped mound absorbs
    // terrain slope across its own radius, so the smaller it is the less of it
    // ends up buried on a hillside, and the treeline is *all* hillside. At 1.05 m
    // the big variant still reads as a drift from six metres — which is the whole
    // reason the patches were enlarged in the first place — while spanning only
    // ~28 cm of rise on the steepest ground the wood grows on.
    const litGeos = [
      litterPatchGeometry(ctx.seed ^ 0x1177, 0.62),
      litterPatchGeometry(ctx.seed ^ 0x1178, 1.05),
    ];

    const lRng = makeRng(ctx.seed ^ 0x11a770);
    const litSpots: { x: number; z: number; v: number }[] = [];

    // Rings at the foot of every trunk: this is where litter is, and it is also
    // the seam the eye goes looking for, so it is where the detail pays.
    for (const t of treeBases) {
      const n = 4 + Math.floor(lRng() * 6);
      for (let i = 0; i < n; i++) {
        const a = lRng() * Math.PI * 2;
        const r = t.r * rangeOf(lRng, 1.0, 5.5);
        const x = t.x + Math.cos(a) * r;
        const z = t.z + Math.sin(a) * r;
        if (mask.at(x, z) < 0.35) continue;
        litSpots.push({ x, z, v: lRng() < 0.6 ? 0 : 1 });
      }
    }
    // Plus a drift through the wood itself so the ground between the trunks is
    // not clean turf either.
    for (const s of poisson(lRng, {
      minX: -28, maxX: 28, minZ: -28, maxZ: 32,
      // Widened with the patch size, so the drift covers the same ground for
      // roughly half the instances it used to take.
      minDist: 1.25, attempts: 14000,
      density: (x, z) => {
        if (mask.at(x, z) < 0.6) return 0;
        // The z band starts at 19 rather than 17. Litter is what falls off a
        // canopy, so it has no business on open ground — and the old band put a
        // drift of dead leaves right across the near foreground of the wide
        // establishing shot, where there is nothing overhead to shed it.
        const wood = Math.max(smoothstep(11.0, 17.0, Math.abs(x)), smoothstep(19.0, 25.0, z));
        const n = fbm2(clump, x * 0.19 + 61, z * 0.19, 3) * 0.5 + 0.5;
        return clamp(wood * (0.2 + n * 0.8), 0, 1) * outsideBuildings(x, z, 0.2) * wildGrassClearance(x, z);
      },
    })) {
      litSpots.push({ x: s.x, z: s.z, v: lRng() < 0.5 ? 0 : 1 });
    }

    for (let v = 0; v < litGeos.length; v++) {
      const subset = litSpots.filter((s) => s.v === v);
      if (!subset.length) continue;
      const mesh = makeInstanced(litGeos[v], litMat, subset.length, lRng, 1);
      for (let i = 0; i < subset.length; i++) {
        const s = subset[i];
        const sc = rangeOf(lRng, 0.7, 1.5);
        euler.set(0, lRng() * Math.PI * 2, 0, 'ZYX');
        q.setFromEuler(euler);
        // Set *below* the surface, not above it. The mound carries its own height
        // (apex ~7 cm) and its outer ring dives another 15% of its radius under,
        // so sinking the origin is what buries the rim and lets the turf close
        // over the edge of the drift instead of the drift ending in mid-air.
        pos3.set(s.x, ground(s.x, s.z) - 0.025, s.z);
        scl.set(sc, sc, sc * rangeOf(lRng, 0.8, 1.25));
        m4.compose(pos3, q, scl);
        mesh.setMatrixAt(i, m4);
        // Litter runs from fresh yellow-brown to weathered grey-brown.
        const age = lRng();
        col.setRGB(1 - age * 0.16, 1 - age * 0.10, 0.9 + age * 0.14);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = `Litter_${v}`;
      mesh.computeBoundingSphere();
      group.add(mesh);
      // Kept out of the shadow map: it is a flat card lying on the ground, so it
      // can only occlude what it is already touching.
      culler.add([mesh], { maxDist: 21, skipShadow: [mesh] });
    }

    // ---- deadfall ---------------------------------------------------
    const fallGeos = [
      deadfallGeometry(ctx.seed ^ 0xfa11, 1.35, 0.055),
      deadfallGeometry(ctx.seed ^ 0xfa12, 2.30, 0.105),
    ];
    const fRng2 = makeRng(ctx.seed ^ 0xfa1100);
    const fallSpots = poisson(fRng2, {
      minX: -27, maxX: 27, minZ: -27, maxZ: 31,
      // 3.5 m rather than 2.6 m. At 2.6 the wood had a fallen branch every
      // couple of paces, which is not a forest floor, it is a woodpile — and
      // deadfall is the most expensive floor detail per unit of read, since each
      // stick is a swept tube rather than a card. Fewer, further apart, larger.
      minDist: 3.5, attempts: 5000,
      density: (x, z) => {
        if (mask.at(x, z) < 0.7) return 0;
        if (ground(x, z) < 0.3) return 0;
        const wood = Math.max(smoothstep(11.5, 17.5, Math.abs(x)), smoothstep(17.5, 23.5, z));
        return clamp(wood * 0.8, 0, 1) * outsideBuildings(x, z, 0.8) * wildGrassClearance(x, z);
      },
    });
    const fallBuckets: { x: number; z: number }[][] = [[], []];
    for (const s of fallSpots) fallBuckets[fRng2() < 0.62 ? 0 : 1].push(s);

    fallBuckets.forEach((list, fi) => {
      if (!list.length) return;
      const mesh = makeInstanced(fallGeos[fi], barkMats.ash, list.length, fRng2, 1);
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const sc = rangeOf(fRng2, 0.75, 1.3);
        // Lying down: yaw freely, and roll a little so it is not perfectly level.
        euler.set(rangeOf(fRng2, -0.14, 0.14), fRng2() * Math.PI * 2, rangeOf(fRng2, -0.10, 0.10), 'ZYX');
        q.setFromEuler(euler);
        pos3.set(s.x, ground(s.x, s.z) - 0.03, s.z);
        scl.set(sc, sc * rangeOf(fRng2, 0.85, 1.15), sc);
        m4.compose(pos3, q, scl);
        mesh.setMatrixAt(i, m4);
        // Dead wood is *grey*: the lignin has weathered out of it and it is the
        // one thing in the wood allowed to be desaturated. It shares the living
        // bark material, so the whole colour shift has to happen here — and at
        // the old near-1.0 value the sticks were as warm as a living oak, which
        // is why a branch lying in grass read as a bright orange streak.
        const g = rangeOf(fRng2, 0.52, 0.76);
        col.setRGB(g, g * 0.97, g * 0.90);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `Deadfall_${fi}`;
      mesh.computeBoundingSphere();
      group.add(mesh);
      culler.add([mesh], { maxDist: 34 });
    });
  }

  /* ---------------- ground cover ----------------------------------- */

  const cullables: THREE.Object3D[] = [];

  // ---- grass -------------------------------------------------------
  const grassTex = grassCardTexture('turf', ctx.seed ^ 0x9ea55, 11);
  const grassMat = createFoliageMaterial(ctx.env, {
    color: 0xe8f0d8,
    map: grassTex,
    roughness: 0.9,
    windScale: 1.9,
    wrap: 0.6,
    transColor: 0xc4ea6a,
    transStrength: 2.6,
    transPower: 2.2,
    haloStrength: 0.14,
    alphaTest: 0.34,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
  });
  // Two variants only: every extra variant multiplies the chunk draw calls, and
  // the per-instance yaw / non-uniform scale plus an eleven-blade texture
  // already make repeats impossible to spot.
  const tuftGeos = [
    grassTuftGeometry(ctx.seed ^ 0x1111, 3, 0.30),
    grassTuftGeometry(ctx.seed ^ 0x2222, 4, 0.21),
  ];

  const grassDensity = (x: number, z: number): number => {
    const m = mask.at(x, z);
    if (m < 0.12) return 0;
    const patch = 0.68 + (fbm2(clump, x * 0.13, z * 0.13, 3) * 0.5 + 0.5) * 0.62;
    return clamp(Math.pow(m, 1.35) * patch, 0, 1) * outsideBuildings(x, z, 0.05);
  };

  // Chunk grid: each chunk is its own InstancedMesh so the renderer can
  // frustum-cull it, and a distance test hides the rest. One giant instanced
  // grass mesh can never be culled at all — it has a single bounding sphere.
  type ChunkList = { x: number; z: number; v: number; g: number }[];
  const chunkCols = Math.ceil((VEG.scatterMaxX - VEG.scatterMinX) / VEG.chunk);
  const chunkRows = Math.ceil((VEG.scatterMaxZ - VEG.scatterMinZ) / VEG.chunk);
  const chunks: ChunkList[] = Array.from({ length: chunkCols * chunkRows }, () => []);

  /**
   * One tuft variant per chunk rather than both in every chunk.
   *
   * Every (chunk, variant) pair is its own InstancedMesh, so carrying two
   * variants everywhere doubled the grass draw calls — forty of them, the single
   * largest block in the frame, on a budget of 260. Assigning the variant by a
   * hash of the chunk index halves that outright, and it is invisible: the two
   * variants differ only in blade count and rest height, and the per-instance
   * scale jitter spans 0.62-1.77, which is a far wider spread than the
   * difference between them.
   */
  const chunkVariant = (ci: number): number =>
    Math.imul(ci ^ 0x9e3779b9, 2654435761) >>> 31;

  const chunkOf = (x: number, z: number): number => {
    const ci = clamp(Math.floor((x - VEG.scatterMinX) / VEG.chunk), 0, chunkCols - 1);
    const cj = clamp(Math.floor((z - VEG.scatterMinZ) / VEG.chunk), 0, chunkRows - 1);
    return cj * chunkCols + ci;
  };

  {
    const cell = VEG.grassCell;
    const gRng = makeRng(ctx.seed ^ 0x9ea5501);
    const nx = Math.ceil((VEG.scatterMaxX - VEG.scatterMinX) / cell);
    const nz = Math.ceil((VEG.scatterMaxZ - VEG.scatterMinZ) / cell);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        // Jittered grid rather than dart-throwing: at fourteen thousand tufts
        // the rejection test dominates the build time and buys nothing, because
        // overlapping grass is exactly what a lawn looks like.
        const x = VEG.scatterMinX + (i + gRng()) * cell;
        const z = VEG.scatterMinZ + (j + gRng()) * cell;
        if (gRng() > grassDensity(x, z)) continue;
        const ci = chunkOf(x, z);
        chunks[ci].push({ x, z, v: chunkVariant(ci), g: 0 });
      }
    }
  }

  // Contact detail: a thicker ruff of grass at the foot of every trunk so
  // nothing appears to be pushed through the ground (ART_DIRECTION §2.5).
  {
    const sRng = makeRng(ctx.seed ^ 0x5c1f7);
    for (const t of treeBases) {
      const n = 5 + Math.floor(sRng() * 5);
      for (let i = 0; i < n; i++) {
        const a = sRng() * Math.PI * 2;
        const r = t.r * rangeOf(sRng, 0.9, 2.4);
        const x = t.x + Math.cos(a) * r;
        const z = t.z + Math.sin(a) * r;
        if (x < VEG.scatterMinX || x > VEG.scatterMaxX || z < VEG.scatterMinZ || z > VEG.scatterMaxZ) continue;
        if (mask.at(x, z) < 0.3) continue;
        const ci = chunkOf(x, z);
        chunks[ci].push({ x, z, v: chunkVariant(ci), g: 0 });
      }
    }
  }

  chunks.forEach((list, ci) => {
    if (list.length === 0) return;
    // One mesh per (chunk, tuft variant): variants must not share a geometry.
    for (let v = 0; v < tuftGeos.length; v++) {
      const subset = list.filter((s) => s.v === v);
      if (subset.length === 0) continue;
      const cRng = makeRng(ctx.seed ^ (ci * 2654435761) ^ (v * 40503));
      const mesh = makeInstanced(tuftGeos[v], grassMat, subset.length, cRng, 1);
      for (let i = 0; i < subset.length; i++) {
        const s = subset[i];
        // Cubed so the distribution is bottom-heavy: mostly short lawn with a
        // scattering of taller tufts, which is what a mown-but-loved green does.
        const sc = 0.62 + Math.pow(cRng(), 2.4) * 1.15;
        euler.set(rangeOf(cRng, -0.1, 0.1), cRng() * Math.PI * 2, rangeOf(cRng, -0.1, 0.1), 'ZYX');
        q.setFromEuler(euler);
        pos3.set(s.x, ground(s.x, s.z) - 0.035, s.z);
        scl.set(sc * rangeOf(cRng, 0.9, 1.25), sc * rangeOf(cRng, 0.82, 1.25), sc);
        m4.compose(pos3, q, scl);
        mesh.setMatrixAt(i, m4);
        const warm = rangeOf(cRng, -1, 1);
        col.setRGB(1 + warm * 0.1, 1 + rangeOf(cRng, -0.07, 0.07), 1 - warm * 0.14);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Grass is billboard filler; ART_DIRECTION §2.4 exempts it from casting,
      // and fourteen thousand alpha-tested shadow casters would cost more than
      // the whole rest of the town.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      // Grass deliberately stays in the VSM shadow pass even though it does not
      // cast. Being a receiver puts it in the map, and the soft tuft-shaped
      // darkening that falls on the turf as a result is the ground contact
      // shadowing ART_DIRECTION §9 asks for. Taking grass out flattens the lawn
      // into an even sheet of green — measured, it is worth ~330k triangles a
      // frame and it is not worth having.
      mesh.name = `Grass_${ci}_${v}`;
      mesh.computeBoundingSphere();
      group.add(mesh);
      cullables.push(mesh);
    }
  });

  // ---- clover ------------------------------------------------------
  {
    const cloverGeo = cloverGeometry(ctx.seed ^ 0xc10e);
    const cloverMat = createFoliageMaterial(ctx.env, {
      color: 0x7fbe4c,
      map: leafSets.warm.map,
      normalMap: leafSets.warm.normalMap,
      roughnessMap: leafSets.warm.roughnessMap,
      normalScale: 0.6,
      roughness: 0.84,
      windScale: 0.7,
      wrap: 0.55,
      transColor: 0xb2e065,
      transStrength: 2.0,
      haloStrength: 0.10,
      side: THREE.DoubleSide,
    });

    const cRng = makeRng(ctx.seed ^ 0xc10e5);
    const patches = poisson(cRng, {
      minX: VEG.scatterMinX, maxX: VEG.scatterMaxX,
      minZ: VEG.scatterMinZ, maxZ: VEG.scatterMaxZ,
      minDist: 2.3, attempts: 2600,
      density: (x, z) => (mask.at(x, z) > 0.85 ? 0.85 * outsideBuildings(x, z, 0.1) : 0),
    });

    const spots: { x: number; z: number }[] = [];
    for (const p of patches) {
      const n = 12 + Math.floor(cRng() * 26);
      const spread = rangeOf(cRng, 0.5, 1.35);
      for (let i = 0; i < n; i++) {
        // Gaussian-ish falloff from the patch centre: real clover grows out
        // from a runner, so density has to decay, not stop at a hard rim.
        const a = cRng() * Math.PI * 2;
        const r = spread * Math.pow(cRng(), 0.65);
        const x = p.x + Math.cos(a) * r;
        const z = p.z + Math.sin(a) * r;
        if (mask.at(x, z) < 0.6) continue;
        spots.push({ x, z });
      }
    }

    if (spots.length) {
      const mesh = makeInstanced(cloverGeo, cloverMat, spots.length, cRng, 1);
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        const sc = rangeOf(cRng, 0.75, 1.5);
        euler.set(rangeOf(cRng, -0.14, 0.14), cRng() * Math.PI * 2, rangeOf(cRng, -0.14, 0.14), 'ZYX');
        q.setFromEuler(euler);
        pos3.set(s.x, ground(s.x, s.z) - 0.012, s.z);
        scl.set(sc, sc * rangeOf(cRng, 0.85, 1.2), sc);
        m4.compose(pos3, q, scl);
        mesh.setMatrixAt(i, m4);
        const warm = rangeOf(cRng, -1, 1);
        col.setRGB(1 + warm * 0.09, 1 + rangeOf(cRng, -0.06, 0.06), 1 - warm * 0.12);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = 'Clover';
      mesh.computeBoundingSphere();
      group.add(mesh);
      // Clover is the one piece of ground scatter that is kept out of the
      // shadow map. Grass, flowers and weeds stand up off the turf and their
      // shadows are the contact detail §9 asks for; a clover leaf is a 5cm dome
      // lying flat on the ground, so at 1.7cm a shadow texel, blurred, it
      // occludes nothing it is not already touching.
      culler.add([mesh], { maxDist: VEG.drawDist.clover, skipShadow: [mesh] });
    }
  }

  // ---- flowers -----------------------------------------------------
  {
    const petal = petalMaps();
    const ACCENTS = [0xf25d7a, 0xffd447, 0xf5f0ea, 0xb57fe0];
    const fRng = makeRng(ctx.seed ^ 0xf10e72);

    // Flowers grow in single-species drifts. A mixed confetti scatter is the
    // classic procedural tell; real meadows are patchy and monochrome per patch.
    const drifts = poisson(fRng, {
      minX: VEG.scatterMinX + 1, maxX: VEG.scatterMaxX - 1,
      minZ: VEG.scatterMinZ + 1, maxZ: VEG.scatterMaxZ - 1,
      minDist: 3.1, attempts: 2200,
      density: (x, z) => {
        if (mask.at(x, z) < 0.9) return 0;
        // Denser on the town green and along the treeline skirt.
        const green = smoothstep(16, 4, Math.hypot(x, z - 6));
        const skirt = smoothstep(9.5, 13.5, Math.abs(x)) * smoothstep(20, 14, Math.abs(x));
        return clamp(0.22 + green * 0.6 + skirt * 0.55, 0, 1) * outsideBuildings(x, z, 0.2);
      },
    });

    const buckets: { x: number; z: number }[][] = ACCENTS.map(() => []);
    for (const d of drifts) {
      const which = Math.floor(fRng() * ACCENTS.length) % ACCENTS.length;
      const n = 5 + Math.floor(fRng() * 14);
      const spread = rangeOf(fRng, 0.42, 1.15);
      for (let i = 0; i < n; i++) {
        const a = fRng() * Math.PI * 2;
        const r = spread * Math.pow(fRng(), 0.6);
        const x = d.x + Math.cos(a) * r;
        const z = d.z + Math.sin(a) * r;
        if (mask.at(x, z) < 0.7) continue;
        buckets[which].push({ x, z });
      }
    }

    ACCENTS.forEach((hex, ai) => {
      const spots = buckets[ai];
      if (!spots.length) return;
      const accent = new THREE.Color(hex);
      const geo = flowerGeometry((ctx.seed ^ 0xf10) + ai * 977, accent);
      const mat = createFoliageMaterial(ctx.env, {
        color: 0xffffff,
        map: petal.map,
        normalMap: petal.normalMap,
        normalScale: 0.5,
        roughness: 0.72,
        windScale: 1.35,
        wrap: 0.6,
        transColor: hex,
        transStrength: 1.6,
        haloStrength: 0.12,
        side: THREE.DoubleSide,
      });
      const mesh = makeInstanced(geo, mat, spots.length, fRng, 1);
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        const sc = rangeOf(fRng, 0.8, 1.45);
        euler.set(rangeOf(fRng, -0.16, 0.16), fRng() * Math.PI * 2, rangeOf(fRng, -0.16, 0.16), 'ZYX');
        q.setFromEuler(euler);
        pos3.set(s.x, ground(s.x, s.z) - 0.01, s.z);
        scl.set(sc, sc * rangeOf(fRng, 0.85, 1.25), sc);
        m4.compose(pos3, q, scl);
        mesh.setMatrixAt(i, m4);
        col.setRGB(rangeOf(fRng, 0.9, 1.08), rangeOf(fRng, 0.9, 1.08), rangeOf(fRng, 0.9, 1.08));
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = `Flowers_${ai}`;
      mesh.computeBoundingSphere();
      group.add(mesh);
      culler.add([mesh], { maxDist: VEG.drawDist.flowers });
    });
  }

  // ---- weeds / ferns ----------------------------------------------
  {
    const wRng = makeRng(ctx.seed ^ 0x3e2d);
    const weedTex = leafCardTexture('fern', ctx.seed ^ 0x1eaf);
    const weedMat = createFoliageMaterial(ctx.env, {
      color: 0xdcecc0,
      map: weedTex,
      roughness: 0.88,
      windScale: 1.35,
      wrap: 0.58,
      transColor: 0xa8dd60,
      transStrength: 2.3,
      haloStrength: 0.12,
      alphaTest: 0.36,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
    });

    const geos = [weedGeometry(ctx.seed ^ 0x4e1, 0.48), weedGeometry(ctx.seed ^ 0x4e2, 0.74)];
    const spots = poisson(wRng, {
      minX: VEG.scatterMinX, maxX: VEG.scatterMaxX,
      minZ: VEG.scatterMinZ, maxZ: VEG.scatterMaxZ,
      minDist: 0.7, attempts: 12000,
      density: (x, z) => {
        if (mask.at(x, z) < 0.8) return 0;
        // Weeds go where a mower would not: against the wood, the south shelf,
        // and the shady side of the houses.
        const wood = smoothstep(9.5, 14.5, Math.abs(x));
        const south = smoothstep(16.5, 22, z);
        let wall = 0;
        for (const f of FOOTPRINTS) {
          const dx = Math.abs(x - f.cx) - f.hx;
          const dz = Math.abs(z - f.cz) - f.hz;
          const d = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
          wall = Math.max(wall, smoothstep(1.6, 0.2, d));
        }
        const n = fbm2(clump, x * 0.22 + 41, z * 0.22, 3) * 0.5 + 0.5;
        return clamp((Math.max(wood, south) * 0.75 + wall * 0.7) * (0.3 + n), 0, 1) *
          outsideBuildings(x, z, 0.1);
      },
    });

    const groups: { x: number; z: number }[][] = [[], []];
    for (const s of spots) groups[wRng() < 0.6 ? 0 : 1].push(s);

    groups.forEach((list, gi) => {
      if (!list.length) return;
      const mesh = makeInstanced(geos[gi], weedMat, list.length, wRng, 1);
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const sc = rangeOf(wRng, 0.7, 1.45);
        euler.set(rangeOf(wRng, -0.12, 0.12), wRng() * Math.PI * 2, rangeOf(wRng, -0.12, 0.12), 'ZYX');
        q.setFromEuler(euler);
        pos3.set(s.x, ground(s.x, s.z) - 0.03, s.z);
        scl.set(sc, sc * rangeOf(wRng, 0.85, 1.25), sc);
        m4.compose(pos3, q, scl);
        mesh.setMatrixAt(i, m4);
        const warm = rangeOf(wRng, -1, 1);
        col.setRGB(1 + warm * 0.09, 1 + rangeOf(wRng, -0.06, 0.06), 1 - warm * 0.11);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = `Weeds_${gi}`;
      mesh.computeBoundingSphere();
      group.add(mesh);
      culler.add([mesh], { maxDist: VEG.drawDist.weeds });
    });
  }

  /* ---------------- culling ----------------------------------------- */

  // Grass keeps chunk-granularity culling rather than joining the per-instance
  // culler. It is by far the biggest instance population (~22k), and permuting
  // that many matrices every time the camera crosses a chunk edge would cost
  // more CPU and upload bandwidth than the triangles it saves. The chunk grid
  // already gives the renderer a small bounding sphere to reject, which is the
  // property the single-mesh categories were missing.
  const camPos = new THREE.Vector3();
  const cullData = cullables.map((o) => {
    const m = o as THREE.InstancedMesh;
    m.computeBoundingSphere();
    const bs = m.boundingSphere!;
    return { obj: m, cx: bs.center.x, cy: bs.center.y, cz: bs.center.z, r: bs.radius };
  });

  let grassCull = true;
  let grassDistCull = true;
  ctx.tick(() => {
    ctx.camera.getWorldPosition(camPos);
    for (const c of cullData) {
      if (!grassCull || !grassDistCull) {
        c.obj.visible = true;
        continue;
      }
      const dx = c.cx - camPos.x;
      const dy = c.cy - camPos.y;
      const dz = c.cz - camPos.z;
      c.obj.visible =
        Math.sqrt(dx * dx + dy * dy + dz * dz) - c.r < VEG.drawDist.grass;
    }
    culler.update(ctx.camera);
  });

  // Visual-QA hook, mirroring `starterDebug`: lets the frozen-capture tool turn
  // culling off and re-shoot the identical frame, so a screenshot diff isolates
  // culling from wind phase and resolution.
  group.userData.vegDebug = {
    setCulling: (on: boolean) => {
      grassCull = on;
      culler.setEnabled(on);
    },
    /** Keeps frustum culling but drops every draw-distance cut. */
    setDistanceCulling: (on: boolean) => {
      grassDistCull = on;
      culler.setDistanceCulling(on);
    },
  };
}
