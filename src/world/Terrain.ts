import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import { Simplex, fbm2, clamp, smoothstep, lerp } from '../core/Noise';
import { grassTurfMaps, cobbleMaps, type MaterialMaps } from '../core/TextureLab';
import {
  sandMaps,
  trackEarthMaps,
  terrainWarpTexture,
  packNormalPair,
  packScalarQuad,
} from '../fx/TerrainMaterials';

/**
 * Terrain — the heightfield everything else in Pallet Town stands on.
 *
 * Two rules drive the whole design here:
 *
 *  1. **The ground is a function, not a mesh.** `height(x, z)` is a closed-form
 *     analytic field. The mesh is a *sample* of it, and `collision.groundHeight`
 *     is the very same function, so a prop placed at (x, z) sits exactly on the
 *     visible surface with no raycast, no BVH, and no drift when the mesh LOD
 *     changes. Same story for the surface masks: `surfaceAt` and the baked splat
 *     texture are two readings of one `masks(x, z)`.
 *
 *  2. **Flatten by mask, not by clamp.** A town needs level building pads and a
 *     walkable path, but a terrain that is level *everywhere* looks dead. So the
 *     field is authored twice — a smooth macro version and a detailed version —
 *     and the town core cross-fades toward the smooth one. Buildings get pads
 *     that go all the way to dead flat. Nothing is ever hard-clamped, so there
 *     is no crease anywhere on the map.
 *
 * The material is a MeshStandardMaterial patched through `onBeforeCompile` to
 * do a four-way height-aware splat blend (turf / dirt / cobble / sand). Going
 * through Standard rather than a raw ShaderMaterial keeps VSM shadows, the
 * PMREM environment, fog and the HDR pipeline working for free.
 */

/* ------------------------------------------------------------------ */
/* Layout constants — other subsystems may read these.                 */
/* ------------------------------------------------------------------ */

export const TERRAIN = {
  minX: -32,
  minZ: -36,
  width: 64,
  depth: 72,
  // 36cm cells. The ground is one mesh that is never frustum-culled and, being
  // a shadow receiver under VSM, it is drawn in the shadow pass, the main pass,
  // the transmission pass and the G-buffer — so every triangle here is paid for
  // three or four times a frame. 25cm cells cost 147k triangles to buy a
  // piecewise-linear fit that was already far finer than the shape: measured
  // against the analytic field, dropping to 36cm moves the surface by 1.9mm on
  // average and 7mm at the 99th percentile, an order of magnitude below the
  // 1.5cm minimum bevel the art bible works to, and the worst-case error is
  // unchanged. The normal epsilon below is derived from these, so shading
  // follows automatically.
  segX: 176,
  segZ: 198,
  /** Height the town core is graded to. Water sits at y = 0. */
  townY: 0.3,
  /** Player-walkable bounds (inside the perimeter blockers). */
  playMinX: -21.0,
  playMaxX: 21.0,
  playMinZ: -26.2,
  playMaxZ: 25.0,
} as const;

/** Hand-authored spine of the north–south dirt path, south entrance -> lab. */
const MAIN_PATH: [number, number][] = [
  [1.6, 27.5],
  [1.1, 21.5],
  [0.1, 15.4],
  [-1.1, 10.6],
  [-0.6, 5.4],
  [0.6, 0.6],
  [0.15, -3.0],
  [0.0, -5.4],
];

/** Short branch to the player's front door (west). */
const BRANCH_W: [number, number][] = [
  [-0.5, 6.0],
  [-3.0, 6.6],
  [-5.8, 7.0],
  [-8.1, 6.6],
];

/** Short branch to the rival's front door (east). */
const BRANCH_E: [number, number][] = [
  [0.3, 6.3],
  [3.2, 6.9],
  [6.2, 7.1],
  [8.5, 6.6],
];

/** Dead-flat building pads. dy is relative to townY. */
const PADS = [
  { cx: 0.0, cz: -13.0, hx: 8.6, hz: 6.2, feather: 3.6, dy: 0.13 }, // Oak's lab
  { cx: -8.4, cz: 2.2, hx: 5.4, hz: 4.3, feather: 2.6, dy: 0.03 }, // player house
  { cx: 8.4, cz: 2.2, hx: 5.4, hz: 4.3, feather: 2.6, dy: 0.03 }, // rival house
  { cx: 0.0, cz: -7.6, hx: 6.6, hz: 3.1, feather: 2.0, dy: 0.06 }, // cobble forecourt
];

/** Cobble forecourt footprint (mask, slightly inset from the pad). */
const FORECOURT = { cx: 0.0, cz: -7.6, hx: 6.2, hz: 2.8, feather: 1.15 };

/* ------------------------------------------------------------------ */
/* Small analytic helpers                                              */
/* ------------------------------------------------------------------ */

/** Distance from (px,pz) to a segment, XZ plane. */
function segDist(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const L = vx * vx + vz * vz;
  let t = L > 1e-9 ? (wx * vx + wz * vz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t;
  const dz = wz - vz * t;
  return Math.sqrt(dx * dx + dz * dz);
}

function polyDist(px: number, pz: number, pts: Float64Array): number {
  let best = 1e9;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const d = segDist(px, pz, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
    if (d < best) best = d;
  }
  return best;
}

/** Catmull-Rom resample of a control polygon into a smooth dense polyline. */
function smoothPath(pts: [number, number][], perSegment = 4): Float64Array {
  const curve = new THREE.CatmullRomCurve3(
    pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    false,
    'catmullrom',
    0.5,
  );
  const n = (pts.length - 1) * perSegment;
  const out = new Float64Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const p = curve.getPoint(i / n);
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.z;
  }
  return out;
}

/**
 * Rounded-rectangle influence: 1 inside the rect, smoothly reaching 0 `feather`
 * metres outside it. Used for every pad and for the town-core grading mask.
 */
function rrMask(
  x: number,
  z: number,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  feather: number,
): number {
  const dx = Math.abs(x - cx) - hx;
  const dz = Math.abs(z - cz) - hz;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
  const inside = Math.min(Math.max(dx, dz), 0);
  return smoothstep(feather, 0, outside + inside);
}

export interface SurfaceMasks {
  dirt: number;
  cobble: number;
  sand: number;
  grass: number;
  /** Macro wear/value variation, 0 = trodden & dark, 1 = lush & bright. */
  wear: number;
}

/* ------------------------------------------------------------------ */
/* The field                                                           */
/* ------------------------------------------------------------------ */

function makeField(seed: number) {
  const nBase = new Simplex(seed ^ 0x9e3779b9);
  const nRoll = new Simplex((seed * 3 + 17) | 0);
  const nFine = new Simplex((seed * 7 + 313) | 0);
  const nWarpA = new Simplex((seed * 11 + 977) | 0);
  const nWarpB = new Simplex((seed * 13 + 4441) | 0);
  const nWear = new Simplex((seed * 17 + 88301) | 0);
  const nScuff = new Simplex((seed * 19 + 60623) | 0);

  const mainPath = smoothPath(MAIN_PATH, 4);
  const branchW = smoothPath(BRANCH_W, 4);
  const branchE = smoothPath(BRANCH_E, 4);

  const TY = TERRAIN.townY;

  /**
   * Macro shape: the silhouette of the land read from 40m away.
   * Gentle rise to the treeline east and west, a wooded bank closing the map
   * to the south, and a beach falling into the bay at the north.
   */
  function macroH(x: number, z: number): number {
    const ax = Math.abs(x);
    let h = TY;
    // The banks have to sink as they run out to sea, or the east and west
    // shoulders carry their +2.5m all the way to z = -36 and the mesh boundary
    // ends as a metre-wide green shelf floating just above the waterline — a
    // dead straight cut against the sky at both top corners of the frame. The
    // headlands keep a third of their height at the tideline so the bay still
    // reads as a cove, and lose the rest by the time the mesh runs out.
    const bank = 0.35 + 0.65 * (1 - smoothstep(-22, -31, z));
    // East/west: walkable swell inside the play area, tall bank outside it so
    // the player can never see over the edge of the world.
    h += smoothstep(13, 22, ax) * 0.62 * bank;
    h += smoothstep(22, 32, ax) * 1.95 * bank;
    // South: tall-grass shelf, then the closing bank.
    h += smoothstep(19, 27, z) * 0.5;
    h += smoothstep(27, 36, z) * 1.9;
    // The mesh stops somewhere, and ground that stops level draws a straight
    // line against the sky. So the last few metres before the boundary lift
    // into a ridge whose crest is noise-driven: what reaches the edge of the
    // frame is then an organic skyline rather than a cut. Held off the shore,
    // which must stay open water.
    // Crucially the crest sits *inboard* of the mesh boundary and the last two
    // metres fall away again. When the ridge peaked on the boundary row itself,
    // the highest thing on the horizon was the cut edge of the plane — a dead
    // straight line against the sky wherever the camera looked out of the town.
    // Peaking at ax ~ 29.5 and dropping to 70% of crest by ax = 32 puts the
    // boundary behind the crest from any eye height inside the play area, so
    // what reaches the skyline is a noise-driven hilltop and the edge is never
    // visible at all.
    const rimFall = 1 - 0.3 * smoothstep(29.5, 32, ax) - 0.3 * smoothstep(33, 36, z);
    const rim =
      Math.max(smoothstep(24, 29.5, ax), smoothstep(28, 33, z)) *
      (1 - smoothstep(-18, -26, z)) *
      rimFall;
    if (rim > 0) {
      // Two noise scales on the crest height: an 16 m roll for the shape of the
      // hills and a 5 m one to keep the skyline from reading as drawn with a
      // French curve.
      h +=
        rim *
        (1.5 +
          (fbm2(nRoll, x * 0.062 + 11.3, z * 0.062 - 5.1, 3) + 0.5) * 1.7 +
          fbm2(nRoll, x * 0.21 - 3.7, z * 0.21 + 8.9, 2) * 0.55);
    }
    // North: the shore. Concave profile — flat dry sand, then a quicker drop
    // once past the waterline so the shallows read turquoise and the far bay
    // reads deep. Deep enough at the boundary that the mesh edge is metres
    // under water and can never be seen.
    h -= 3.2 * Math.pow(smoothstep(-23, -36, z), 1.6);
    return h;
  }

  /** Macro plus only the softest undulation — what graded ground looks like. */
  function smoothH(x: number, z: number): number {
    // Even the graded town keeps a broad swell — a mathematically level green
    // reads as a football pitch, not a village.
    return (
      macroH(x, z) +
      fbm2(nRoll, x * 0.0195, z * 0.0195, 2) * 0.26 +
      fbm2(nRoll, x * 0.055 + 4.1, z * 0.055, 2) * 0.09
    );
  }

  /** Full-detail natural ground. */
  function roughH(x: number, z: number): number {
    return (
      smoothH(x, z) +
      fbm2(nBase, x * 0.058, z * 0.058, 3) * 0.3 +
      fbm2(nFine, x * 0.19, z * 0.19, 3) * 0.075
    );
  }

  /** The graded town core — level, but not mathematically flat. */
  function coreMask(x: number, z: number): number {
    // Never grade the shore: the beach has to keep its natural drift.
    const shoreGuard = smoothstep(-24, -18, z);
    return rrMask(x, z, 0, -1, 13.0, 16.0, 7) * shoreGuard;
  }

  /**
   * Path influence, low-frequency warped so the mask is already irregular
   * before the shader adds its own fine break-up. Shared by the grading, the
   * worn groove, the splat bake and `surfaceAt` so all four agree.
   */
  function pathInfluence(x: number, z: number): number {
    // Three warp scales, not one. The coarse term bends the whole track; the
    // 3m term is what produces tongues of turf pushing into the earth and
    // lobes of earth pushing back out, so the boundary is genuinely organic
    // rather than an offset curve; the 1m term frays the last few centimetres.
    // All of it lives in this one function so the graded height, the worn
    // groove, the baked splat and `surfaceAt` cannot disagree.
    const wx =
      x +
      fbm2(nWarpA, x * 0.085, z * 0.085, 2) * 1.9 +
      fbm2(nWarpA, x * 0.315 + 5.7, z * 0.315 - 1.9, 2) * 0.56 +
      fbm2(nWarpA, x * 0.95 + 13.1, z * 0.95, 1) * 0.15;
    const wz =
      z +
      fbm2(nWarpB, x * 0.085 + 7.3, z * 0.085 - 3.1, 2) * 1.9 +
      fbm2(nWarpB, x * 0.315, z * 0.315 + 8.2, 2) * 0.56 +
      fbm2(nWarpB, x * 0.95, z * 0.95 + 4.4, 1) * 0.15;
    // The half-width breathes at two scales as well: a track that is one
    // constant width with a wiggly centreline still reads as a drawn ribbon.
    const hwMain =
      1.02 + fbm2(nWear, x * 0.05, z * 0.05, 2) * 0.36 + fbm2(nWear, x * 0.23 + 9.4, z * 0.23, 2) * 0.2;
    const main = smoothstep(hwMain + 0.5, hwMain - 0.34, polyDist(wx, wz, mainPath));
    const hwBr =
      0.68 + fbm2(nWear, x * 0.07 + 3, z * 0.07, 2) * 0.24 + fbm2(nWear, x * 0.26, z * 0.26 + 6, 2) * 0.14;
    const br = smoothstep(
      hwBr + 0.42,
      hwBr - 0.22,
      Math.min(polyDist(wx, wz, branchW), polyDist(wx, wz, branchE)),
    );
    return Math.max(main, br);
  }

  function forecourtMask(x: number, z: number): number {
    // Two warp scales: the coarse one bows the sides of the laid rectangle,
    // the fine one nibbles the corners so the stones look worn back into the
    // grass rather than stamped out with a cookie cutter.
    const wx =
      x + fbm2(nWarpA, x * 0.09 + 3.3, z * 0.09, 3) * 1.5 + fbm2(nWarpA, x * 0.4, z * 0.4 + 2, 2) * 0.55;
    const wz =
      z + fbm2(nWarpB, x * 0.09, z * 0.09 + 5.5, 3) * 1.5 + fbm2(nWarpB, x * 0.4 + 8, z * 0.4, 2) * 0.55;
    return rrMask(wx, wz, FORECOURT.cx, FORECOURT.cz, FORECOURT.hx, FORECOURT.hz, FORECOURT.feather);
  }

  /** THE ground function. Cheap enough to call per-frame and per-prop. */
  function height(x: number, z: number): number {
    const smooth = smoothH(x, z);
    const rough = roughH(x, z);

    const path = pathInfluence(x, z);
    const grade = clamp(coreMask(x, z) * 0.84 + path * 0.92, 0, 1);
    let h = lerp(rough, smooth, grade);

    for (let i = 0; i < PADS.length; i++) {
      const p = PADS[i];
      const m = rrMask(x, z, p.cx, p.cz, p.hx, p.hz, p.feather);
      if (m > 0.001) h = lerp(h, TY + p.dy, m);
    }

    // A few centimetres of wear where feet have gone for a hundred years.
    const cob = forecourtMask(x, z);
    h -= path * (1 - cob) * 0.055;
    // The forecourt is laid slightly proud of the surrounding grass.
    h += cob * 0.025;
    return h;
  }

  /** Splat weights. Analytic, so the bake and the footstep query cannot drift. */
  function masks(x: number, z: number): SurfaceMasks {
    const path = pathInfluence(x, z);

    // Sand: a warped shoreline band, plus wind-blown fingers reaching inland
    // so the grass/sand transition is never a clean arc.
    const sz = z + fbm2(nWarpB, x * 0.07 + 19, z * 0.07, 3) * 2.6;
    const sx = x + fbm2(nWarpA, x * 0.07, z * 0.07 + 12, 3) * 2.6;
    let sand = smoothstep(-21.4, -25.0, sz);
    sand = Math.max(
      sand,
      smoothstep(-17.5, -24.0, sz) *
        smoothstep(0.06, 0.42, fbm2(nScuff, sx * 0.075 + 21, sz * 0.075, 3)),
    );
    // The bay is a bay: the headlands closing it east and west stay grassy
    // right down to the tideline, so the beach reads as a cove rather than a
    // band painted across the top of the map.
    sand *= smoothstep(27.5, 19.0, Math.abs(sx));
    sand = clamp(sand, 0, 1);

    let cobble = forecourtMask(x, z);

    const dMain = polyDist(x, z, mainPath);

    // ---- the path/turf boundary -----------------------------------------
    // `path` alone gives a boundary that is irregular in *shape* but even in
    // *character* — the same ~30cm ramp all the way along, which reads as a
    // drawn border. Two opposed terms fix that:
    //
    //  - tongues: turf survives inside the track wherever nobody walks, biting
    //    into the earth in metre-scale lobes;
    //  - bleed: bare scuffed earth escapes outward past the nominal edge where
    //    corners get cut.
    //
    // Both are kept at ~1m scale or coarser. The splat bake is 12.5cm/texel and
    // the shader domain-warps the lookup, so finer detail than this belongs to
    // the shader, not here.
    // Turf tongues, at two scales. The outer one is metre-scale and allowed to
    // bite most of the way through where it peaks, so in places the grass
    // genuinely closes over the track; the lip one is 40cm and frays the last
    // hand's width. One scale alone gives a wobbly but uniformly *soft* edge,
    // which from 20 m still reads as a drawn border.
    const bandOuter = smoothstep(0.03, 0.34, path) * smoothstep(1.0, 0.62, path);
    const bandLip = smoothstep(0.02, 0.2, path) * smoothstep(0.58, 0.24, path);
    const tongueA = smoothstep(0.4, 0.86, fbm2(nScuff, x * 0.3 + 31.7, z * 0.3 - 12.3, 3) + 0.5);
    const tongueB = smoothstep(0.44, 0.9, fbm2(nScuff, x * 0.86 - 14.2, z * 0.86 + 21.4, 2) + 0.5);
    let dirt =
      path * (1 - clamp(bandOuter * tongueA * 0.95 + bandLip * tongueB * 0.7, 0, 0.97));

    // Scuffed earth bleeding outward. Measured from the *unwarped* centrelines
    // of every path, main and branches, so corner-cutting shows up on the
    // branches too — those meet the front doors, which is exactly where a
    // hundred years of feet would have killed the grass.
    const dAny = Math.min(dMain, polyDist(x, z, branchW), polyDist(x, z, branchE));
    const ring = smoothstep(0.3, 1.25, dAny) * smoothstep(5.6, 1.5, dAny);
    const bleed = smoothstep(0.46, 0.86, fbm2(nScuff, x * 0.22 + 7.1, z * 0.22 - 4.6, 3) + 0.5) * ring;
    const bleedFine =
      smoothstep(0.56, 0.93, fbm2(nScuff, x * 0.62 - 9.3, z * 0.62 + 3.1, 2) + 0.5) * ring;
    dirt = Math.max(dirt, bleed * 0.8);
    dirt = Math.max(dirt, bleedFine * 0.52);

    // Worn earth away from the path: small patches of thin grass where a
    // hundred kids have cut the corner. Deliberately capped well below 1 so
    // the turf still shows through — these are scuffs, not more path.
    const scuff = fbm2(nScuff, x * 0.45, z * 0.45, 3);
    const nearPath = smoothstep(5.5, 1.2, dMain);
    const near = rrMask(x, z, 0, 1, 9, 11, 4) * (0.1 + nearPath * 0.9);
    dirt = Math.max(dirt, smoothstep(0.42, 0.72, scuff) * near * 0.32);

    cobble *= 1 - sand;
    dirt = clamp(dirt, 0, 1) * (1 - sand) * (1 - cobble);
    const grass = clamp(1 - sand - cobble - dirt, 0, 1);

    // Macro value break-up plus a trodden halo hugging the path. One octave
    // set at 48m and one at 14m, summed *before* the clamp: averaging two
    // independently-normalised fields would collapse the variance toward 0.5
    // and the whole lawn would come out one tone, which is exactly the failure
    // this channel exists to prevent.
    let wear = clamp(
      0.5 +
        fbm2(nWear, x * 0.0158 + 2.1, z * 0.0158 - 6.3, 2) * 1.0 +
        fbm2(nWear, x * 0.0545, z * 0.0545, 2) * 0.44,
      0,
      1,
    );
    const halo = smoothstep(4.6, 1.2, dMain);
    wear *= 1 - halo * 0.2;

    return { dirt, cobble, sand, grass, wear };
  }

  function surface(x: number, z: number): string {
    const m = masks(x, z);
    if (m.cobble > 0.45) return 'stone';
    if (m.sand > 0.4) return 'sand';
    if (m.dirt > 0.4) return 'dirt';
    return 'grass';
  }

  return { height, masks, surface, macroH };
}

type Field = ReturnType<typeof makeField>;

/* ------------------------------------------------------------------ */
/* Splat bake                                                          */
/* ------------------------------------------------------------------ */

/**
 * Bakes the four-way surface mask into an RGBA texture spanning the terrain.
 *
 * 768² over 64m is 8.3cm per texel. It was 512² / 12.5cm, and that was too
 * coarse to survive the hard height-aware blend downstream: the blend's
 * threshold traced the bilinear ramp between texel centres, so the grass/dirt
 * boundary came out as a staircase of visible 12.5cm blocks whenever the camera
 * got within a couple of metres of it. Finer texels plus a sub-decimetre warp on
 * the lookup (see the shader) is what turns that staircase back into a frayed
 * organic edge. The shader still domain-warps at metre scale on top, so this is
 * not the resolution the boundary detail comes from — only the resolution below
 * which the *blocks* stop being individually resolvable.
 */
function bakeSplat(field: Field, size = 768): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const z = TERRAIN.minZ + ((j + 0.5) / size) * TERRAIN.depth;
    for (let i = 0; i < size; i++) {
      const x = TERRAIN.minX + ((i + 0.5) / size) * TERRAIN.width;
      const m = field.masks(x, z);
      const o = (j * size + i) * 4;
      data[o] = m.dirt * 255;
      data[o + 1] = m.cobble * 255;
      data[o + 2] = m.sand * 255;
      data[o + 3] = m.wear * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Material                                                            */
/* ------------------------------------------------------------------ */

function sharpen(maps: MaterialMaps): MaterialMaps {
  // Terrain is the one surface always seen at a grazing angle; it needs the
  // full anisotropic budget or the horizon smears.
  for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) {
    if (t.anisotropy < 16) {
      t.anisotropy = 16;
      t.needsUpdate = true;
    }
  }
  return maps;
}

const TERRAIN_FRAG_DECL = /* glsl */ `
varying vec2 vTerXZ;
varying float vTerH;
varying vec3 vTerN;
uniform sampler2D uSplat;
uniform sampler2D uWarp;
uniform sampler2D uTurfMap;
uniform sampler2D uDirtMap;
uniform sampler2D uCobMap;
uniform sampler2D uSandMap;
uniform sampler2D uNrmTD;
uniform sampler2D uNrmCS;
uniform sampler2D uRough4;
uniform vec4 uExtent;
uniform float uNormalStrength;
vec3 gAlbedo;
vec3 gNrm;
float gRough;
// Packed normals keep XY only; Z comes back from the unit-length constraint.
vec3 decodeN( vec2 xy, float k ) {
  vec2 n = xy * 2.0 - 1.0;
  float z = sqrt( max( 1.0 - dot( n, n ), 0.0 ) );
  return vec3( n * k, z );
}
`;

const TERRAIN_BLEND = /* glsl */ `
{
  vec2 tXZ = vTerXZ;
  const vec3 LUM = vec3( 0.2126, 0.7152, 0.0722 );

  // ---- world-scale variation --------------------------------------------
  // One 256px noise sampled at four scales. Each macro term averages two
  // *different* channels at two *different* periods: a single repeating
  // texture driving a visible brightness field prints its own tiling grid
  // across the whole map, which is exactly the failure this system exists to
  // prevent. Averaging two incommensurate periods pushes the beat far beyond
  // the size of the island.
  vec4 w0 = texture2D( uWarp, tXZ * 0.014170 );                        // ~70.6 m
  vec4 wM = texture2D( uWarp, tXZ * 0.031300 + vec2( 0.71, 0.19 ) );   // ~31.9 m
  vec4 w1 = texture2D( uWarp, tXZ * 0.073700 + vec2( 0.37, 0.61 ) );   // ~13.6 m
  vec4 w2 = texture2D( uWarp, tXZ * 0.830000 + vec2( 0.13, 0.77 ) );   // ~1.2 m
  vec4 w3 = texture2D( uWarp, tXZ * 3.970000 + vec2( 0.53, 0.29 ) );   // ~0.25 m
  // The baked noise is now authored to fill the byte range (see
  // terrainWarpTexture), so these remaps are near pass-throughs that only clip
  // the tails. They used to squeeze a 6%-wide field, which is why 60 m of lawn
  // came out one flat tone.
  float macroA = smoothstep( 0.12, 0.88, w0.b );
  float macroM = smoothstep( 0.14, 0.86, wM.b * 0.55 + w1.a * 0.45 );
  float macroB = smoothstep( 0.14, 0.86, w1.b * 0.55 + wM.a * 0.45 );
  float cloud  = smoothstep( 0.16, 0.84, w0.a * 0.50 + w1.a * 0.50 );

  // The high-frequency terms are what turn the splat's bilinear ramps into a
  // ragged, finger-y boundary. Without them the path edge reads as a contour
  // line no matter how much noise went into the bake. The 25 cm term matters
  // most: the splat is 8.3 cm/texel and the blend below thresholds it hard, so
  // without a sub-decimetre jitter the boundary snaps to the texel grid and
  // walks as a visible staircase of blocks. It mips away with distance, which
  // is exactly right — there is nothing to break up once a texel is subpixel.
  vec2 warpOff = ( w0.rg - 0.5 ) * 1.35 + ( wM.rg - 0.5 ) * 0.72
               + ( w1.rg - 0.5 ) * 0.58 + ( w2.rg - 0.5 ) * 0.44
               + ( w3.rg - 0.5 ) * 0.14;

  // ---- splat lookup ------------------------------------------------------
  vec2 sUv = ( tXZ + warpOff - uExtent.xy ) / uExtent.zw;
  vec4 sp = texture2D( uSplat, clamp( sUv, vec2( 0.0015 ), vec2( 0.9985 ) ) );
  // How far into the middle of the track we are. 1 along the centreline,
  // falling away through the shoulders — the profile of where feet actually go.
  float centre = smoothstep( 0.42, 0.95, sp.r );

  // ---- detail UVs. Two turf scales + per-layer warp kills the tile grid --
  vec2 uvTa = ( tXZ + warpOff * 0.30 ) * 0.6300;
  vec2 uvTb = vec2( tXZ.x * 0.8660 - tXZ.y * 0.5000,
                    tXZ.x * 0.5000 + tXZ.y * 0.8660 ) * 0.2070 + vec2( 2.7, 5.1 );
  // The dirt is the one layer that runs as a long thin ribbon through the
  // frame, so its tile period is on screen at every distance at once. Scaling
  // its UVs by a 32m noise means the grain size itself drifts along the track:
  // there is no single period left for the eye to lock onto.
  float dScale = 0.7900 + macroM * 0.4400;
  vec2 uvD  = ( tXZ + warpOff * 0.62 ) * dScale;
  vec2 uvC  = ( tXZ + warpOff * 0.14 ) * 0.5150 + vec2( 0.15, 0.42 );
  vec2 uvS  = ( tXZ + warpOff * 0.34 ) * 0.6400;

  float turfMix = clamp( 0.22 + cloud * 0.58, 0.0, 1.0 );

  vec3 aT = mix( texture2D( uTurfMap, uvTa ).rgb, texture2D( uTurfMap, uvTb ).rgb, turfMix );
  vec2 uvD2 = vec2( tXZ.x * 0.9397 + tXZ.y * 0.3420,
                   -tXZ.x * 0.3420 + tXZ.y * 0.9397 ) * 0.3170 + vec2( 4.1, 8.7 );
  vec3 aD = mix( texture2D( uDirtMap, uvD ).rgb, texture2D( uDirtMap, uvD2 ).rgb, turfMix );
  vec3 aC = texture2D( uCobMap,  uvC ).rgb;
  // Sand gets the same two-scale treatment as turf: a beach is a large,
  // uninterrupted expanse and a single tile shows its wavelength instantly.
  vec2 uvS2 = vec2( tXZ.x * 0.6428 + tXZ.y * 0.7660,
                   -tXZ.x * 0.7660 + tXZ.y * 0.6428 ) * 0.2110 + vec2( 6.3, 1.9 );
  vec3 aS = mix( texture2D( uSandMap, uvS ).rgb, texture2D( uSandMap, uvS2 ).rgb, turfMix );

  // The shared dirt and cobble maps are authored for props seen at arm's
  // length, where high grit contrast reads well. Spread over a whole path
  // they turn to confetti, so roll the highlights off and warm them before
  // they enter the blend. Turf loses a little saturation for the same reason:
  // a whole field of it at full chroma reads as astroturf.
  // Feet wear a track smooth up the middle and sweep the loose grit out to the
  // shoulders, so the gravel contrast is pulled down by the centre weight. The
  // flat term is the same texture read 12x magnified — its own low-frequency
  // content, i.e. a smooth compacted-soil colour, for one fetch and no constants.
  vec3 aDflat = texture2D( uDirtMap, uvD * 0.0820 + vec2( 0.31, 0.67 ) ).rgb;
  aD = mix( aD, aDflat, centre * 0.40 );

  float dl = dot( aD, LUM );
  aD *= mix( 1.0, 0.80, smoothstep( 0.20, 0.55, dl ) );
  // Chroma, not just value. Half the track is in tree shade, lit only by a blue
  // sky, and a low-chroma brown under a blue fill is grey — the south approach
  // was reading as tarmac. Bare earth has to carry enough saturation to still be
  // earth-coloured when the sun is off it.
  aD  = mix( vec3( dot( aD, LUM ) ), aD, 0.90 );
  aD  = ( aD * 0.90 + 0.050 ) * vec3( 1.26, 0.99, 0.68 );

  // Cobble ships a cool quarried grey; the bible's stone is warm (#b8b3a8),
  // and a cold forecourt in a warm town reads as a puddle from 20 m away.
  // Cobble: neutralise, then lift the mortar and compress the range before
  // tinting warm. Deep mortar joints under a blue sky fill turn a forecourt
  // into a slate roof lying on the ground; sun-bleached stone needs its
  // blacks raised, not its highlights lowered.
  aC  = mix( vec3( dot( aC, LUM ) ), aC, 0.50 );
  aC  = aC * 0.78 + 0.115;
  aC *= vec3( 1.32, 1.12, 0.74 );
  // Per-stone warm/cool jitter so the forecourt is laid, not printed.
  aC *= mix( vec3( 0.93, 0.96, 1.00 ), vec3( 1.09, 1.02, 0.88 ), macroB );

  aT  = mix( vec3( dot( aT, LUM ) ), aT, 0.84 ) * vec3( 1.07, 1.00, 0.84 );
  aS  = mix( vec3( dot( aS, LUM ) ), aS, 0.94 ) * vec3( 1.22, 1.05, 0.72 );

  // ---- height-aware blend ----------------------------------------------
  // Linear lerping four surfaces gives a soapy dissolve. Biasing each weight
  // by the layer's own luminance (a good proxy for surface height in all four
  // of these maps) makes pebbles poke through grass and grass fill the mortar
  // joints, which is what sells the transition.
  vec4 wgt = vec4( clamp( 1.0 - sp.r - sp.g - sp.b, 0.0, 1.0 ), sp.r, sp.g, sp.b );
  vec4 hgt = vec4( dot( aT, LUM ), dot( aD, LUM ), dot( aC, LUM ), dot( aS, LUM ) );
  vec4 bias = wgt + hgt * 0.52;
  float peak = max( max( bias.x, bias.y ), max( bias.z, bias.w ) ) - 0.21;
  // The gate was 0.035 wide. On a splat that is metres-per-texel-ish that is a
  // hard contour, and a hard contour on a bilinear ramp is a staircase: the
  // grass/dirt boundary showed as a row of dark texel-sized blocks close up.
  // 0.10 keeps the height blend crisp enough for pebbles to poke through turf
  // while giving the ramp somewhere to live.
  vec4 bl = max( bias - peak, 0.0 ) * smoothstep( 0.0, 0.10, wgt );
  bl /= max( bl.x + bl.y + bl.z + bl.w, 1e-4 );

  vec3 albedo = aT * bl.x + aD * bl.y + aC * bl.z + aS * bl.w;

  vec3 nrm =
      decodeN( texture2D( uNrmTD, uvTa ).rg, 1.32 ) * bl.x +
      decodeN( texture2D( uNrmTD, uvD  ).ba, 0.62 * ( 1.0 - centre * 0.38 ) ) * bl.y +
      decodeN( texture2D( uNrmCS, uvC  ).rg, 1.00 ) * bl.z +
      decodeN( texture2D( uNrmCS, uvS  ).ba, 0.58 ) * bl.w;

  float rgh =
      texture2D( uRough4, uvTa ).r * bl.x +
      texture2D( uRough4, uvD  ).g * bl.y +
      texture2D( uRough4, uvC  ).b * bl.z +
      texture2D( uRough4, uvS  ).a * bl.w;

  // ---- macro colour ------------------------------------------------------
  // Four independent scales of hue and value drift. This is the single most
  // important thing keeping 64 x 72 metres of one texture from reading as one
  // texture: the eye finds the repeat in the *colour* long before the detail.
  float band = macroA * 0.50 + macroM * 0.34 + macroB * 0.16;
  vec3 sunTint  = vec3( 1.215, 1.100, 0.700 );  // sun-bleached, yellow-green
  vec3 lushTint = vec3( 0.735, 0.955, 0.800 );  // shaded, blue-green
  vec3 tint = mix( lushTint, sunTint, smoothstep( 0.16, 0.84, band ) );
  albedo *= mix( vec3( 1.0 ), tint, bl.x * 0.94 + 0.06 );

  // A different green under the treeline. The ground out there is in leaf shade
  // half the day and its turf goes bluer, deeper and less yellow — and 60 m of
  // one hue is the single loudest tell that a lawn is a texture. Faded out
  // toward the shore, where the grass is exposed and salt-bleached instead.
  float edgeX = smoothstep( 11.0, 21.0, abs( tXZ.x ) );
  float edgeS = smoothstep( 17.0, 26.0, tXZ.y );
  float edge  = max( edgeX, edgeS ) * ( 1.0 - smoothstep( -13.0, -21.0, tXZ.y ) );
  albedo *= mix( vec3( 1.0 ), vec3( 0.855, 0.965, 0.895 ), edge * bl.x * 0.8 );

  // Patchy mown-lawn value break-up, three scales stacked. Sun-bleached crowns
  // against damp hollows; the macro channels behind these now carry real
  // variance, so the swing here is visible from the far end of the town.
  albedo *= 0.875 + macroB * 0.265;
  albedo *= 0.895 + macroM * 0.215;
  albedo *= 0.855 + sp.a  * 0.275;

  // Banks and cut slopes wear through to bare earth at the top of the fall.
  float slope = clamp( ( 1.0 - vTerN.y ) * 5.2, 0.0, 1.0 );
  albedo = mix( albedo, albedo * vec3( 1.06, 0.90, 0.72 ), slope * bl.x * 0.55 );

  // Hollows hold water: the turf goes deeper and cooler where the ground dips.
  // Gated by a macro noise as well as by height — the town core is graded to
  // y = 0.3, so a purely height-driven term applied a flat cool cast to the
  // whole village at once, which is the opposite of what it is for.
  float damp = smoothstep( 0.40, 0.05, vTerH ) * bl.x * ( 0.30 + macroM * 0.95 );
  albedo *= mix( vec3( 1.0 ), vec3( 0.745, 0.885, 0.785 ), clamp( damp, 0.0, 1.0 ) * 0.62 );

  // ---- shoreline damp band ---------------------------------------------
  // Tight around the waterline: a wide gradient turns the whole beach grey.
  float wet = smoothstep( 0.13, -0.09, vTerH );
  float sandy = bl.w + bl.y * 0.22;
  albedo *= mix( vec3( 1.0 ), vec3( 0.50, 0.49, 0.53 ), wet * sandy );
  rgh = mix( rgh, 0.13, wet * sandy * 0.92 );

  gAlbedo = albedo;
  gRough  = clamp( rgh, 0.06, 1.0 );
  gNrm    = nrm;
}
diffuseColor.rgb *= gAlbedo;
`;

const TERRAIN_NORMAL = /* glsl */ `
{
  // The detail UVs run along world +X and +Z, so the tangent frame is those
  // two axes brought into view space and re-orthogonalised against the
  // interpolated surface normal. No derivatives, no seams on the shore slope.
  vec3 T = ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz;
  vec3 B = ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz;
  T = normalize( T - normal * dot( normal, T ) );
  B = normalize( B - normal * dot( normal, B ) - T * dot( T, B ) );
  vec3 mn = gNrm;
  mn.xy *= uNormalStrength;
  normal = normalize( T * mn.x + B * mn.y + normal * max( mn.z, 0.15 ) );
}
`;

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildTerrain(ctx: GameContext): void {
  const field = makeField(ctx.seed);

  // ---- publish the sampler first: everything downstream needs it -------
  ctx.collision.groundHeight = (x: number, z: number) => field.height(x, z);
  ctx.collision.surfaceAt = (x: number, z: number) => field.surface(x, z);

  // ---- geometry --------------------------------------------------------
  const geo = new THREE.PlaneGeometry(TERRAIN.width, TERRAIN.depth, TERRAIN.segX, TERRAIN.segZ);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const count = pos.count;
  const e = TERRAIN.width / TERRAIN.segX; // one cell — normals match the mesh
  const inv = 1 / (2 * e);

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = field.height(x, z);
    pos.setY(i, h);

    // Central differences of the analytic field: smooth shading with none of
    // the faceting computeVertexNormals() leaves on a low-amplitude grid.
    const dhx = (field.height(x + e, z) - field.height(x - e, z)) * inv;
    const dhz = (field.height(x, z + e) - field.height(x, z - e)) * inv;
    const len = Math.hypot(dhx, 1, dhz);
    nrm.setXYZ(i, -dhx / len, 1 / len, -dhz / len);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  // ---- textures --------------------------------------------------------
  const turf = sharpen(grassTurfMaps());
  // The worn-track maps, not the shared `dirtPathMaps`. That one is authored for
  // props at arm's length and its pebble layer is a *single* Worley at 22 cells
  // — one cell size everywhere, which is the definition of a lattice: at the
  // distance where a cell lands on a pixel the whole track reads as laid
  // cobblestone. `trackEarthMaps` stacks three incommensurate Worley grids with
  // a drifting size selector and a drifting density, so there is no dominant
  // wavelength left to find.
  const dirt = sharpen(trackEarthMaps());
  const cobble = sharpen(cobbleMaps());
  const sand = sharpen(sandMaps());
  const splat = bakeSplat(field);
  const warp = terrainWarpTexture();
  const nrmTD = packNormalPair('turf-dirt', turf.normalMap, dirt.normalMap);
  const nrmCS = packNormalPair('cobble-sand', cobble.normalMap, sand.normalMap);
  const rough4 = packScalarQuad(
    'terrain',
    turf.roughnessMap,
    dirt.roughnessMap,
    cobble.roughnessMap,
    sand.roughnessMap,
  );

  // ---- material --------------------------------------------------------
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    dithering: true,
  });

  const uniforms = {
    uSplat: { value: splat },
    uWarp: { value: warp },
    uTurfMap: { value: turf.map },
    uDirtMap: { value: dirt.map },
    uCobMap: { value: cobble.map },
    uSandMap: { value: sand.map },
    uNrmTD: { value: nrmTD },
    uNrmCS: { value: nrmCS },
    uRough4: { value: rough4 },
    uExtent: {
      value: new THREE.Vector4(TERRAIN.minX, TERRAIN.minZ, TERRAIN.width, TERRAIN.depth),
    },
    uNormalStrength: { value: 1.15 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vTerXZ;\nvarying float vTerH;\nvarying vec3 vTerN;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvTerN = normalize( mat3( modelMatrix ) * objectNormal );',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n{ vec4 terWp = modelMatrix * vec4( transformed, 1.0 ); vTerXZ = terWp.xz; vTerH = terWp.y; }',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TERRAIN_FRAG_DECL)
      .replace('#include <map_fragment>', TERRAIN_BLEND)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * gRough;')
      .replace('#include <normal_fragment_maps>', TERRAIN_NORMAL);
  };
  mat.customProgramCacheKey = () => 'terrain-splat-v2';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false; // the ground is the receiver; nothing gains from it
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  ctx.scene.add(mesh);

  // ---- perimeter blockers ---------------------------------------------
  // Tall enough that a jump cannot clear them, deep enough that walking down
  // the beach never slips under them.
  const LO = -6;
  const HI = 9;
  const { playMinX, playMaxX, playMinZ, playMaxZ } = TERRAIN;
  const midX = (playMinX + playMaxX) / 2;
  const midZ = (playMinZ + playMaxZ) / 2;
  const halfX = (playMaxX - playMinX) / 2;
  const halfZ = (playMaxZ - playMinZ) / 2;
  const T = 1.5;

  ctx.collision.addBox(playMinX - T, midZ, T, halfZ + T * 2, LO, HI, 0, 'bounds-west');
  ctx.collision.addBox(playMaxX + T, midZ, T, halfZ + T * 2, LO, HI, 0, 'bounds-east');
  ctx.collision.addBox(midX, playMinZ - T, halfX + T * 2, T, LO, HI, 0, 'bounds-north');
  ctx.collision.addBox(midX, playMaxZ + T, halfX + T * 2, T, LO, HI, 0, 'bounds-south');
}
