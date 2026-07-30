import * as THREE from 'three';
import { Simplex, tileableFbm, worley, clamp, smoothstep, lerp, withBakeResolution } from './Noise';

/**
 * Procedural texture bakery.
 *
 * The game ships no binary art assets — every albedo/normal/roughness map is
 * baked here into an OffscreenCanvas at load time. Working this way keeps the
 * whole world consistent (one noise basis, one palette) and lets materials be
 * authored as data rather than files.
 *
 * All maps are tileable. Normal maps are derived from a height field via Sobel
 * so albedo and normal always agree.
 */

export interface HeightFieldOptions {
  size: number;
  /** Returns height in [0,1] for tileable uv coordinates. */
  height: (u: number, v: number) => number;
}

const canvasCache = new Map<string, THREE.Texture>();

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return { canvas, ctx };
}

function finalize(
  canvas: HTMLCanvasElement,
  srgb: boolean,
  repeat: number,
  anisotropy: number,
): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bakes a tileable normal map from a height callback using a Sobel operator
 * with wrap-around sampling.
 */
export function bakeNormalMap(opts: HeightFieldOptions, strength = 1.6): THREE.Texture {
  const { size, height } = opts;
  const heights = new Float32Array(size * size);
  withBakeResolution(size, () => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        heights[y * size + x] = height(x / size, y / size);
      }
    }
  });

  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const at = (x: number, y: number) => heights[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const nzn = nz / len;

      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nzn * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finalize(canvas, false, 1, 8);
}

export interface ColorFieldOptions {
  size: number;
  /** Returns linear-ish sRGB triplet 0..1 for tileable uv. */
  color: (u: number, v: number) => [number, number, number];
  srgb?: boolean;
}

/** Bakes an arbitrary per-texel color field into a tileable texture. */
export function bakeColorMap(opts: ColorFieldOptions): THREE.Texture {
  const { size, color, srgb = true } = opts;
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  const data = img.data;
  withBakeResolution(size, () => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = color(x / size, y / size);
        const i = (y * size + x) * 4;
        data[i] = clamp(r, 0, 1) * 255;
        data[i + 1] = clamp(g, 0, 1) * 255;
        data[i + 2] = clamp(b, 0, 1) * 255;
        data[i + 3] = 255;
      }
    }
  });
  ctx.putImageData(img, 0, 0);
  return finalize(canvas, srgb, 1, 8);
}

/** Bakes a single-channel map (roughness / metalness / AO) as greyscale. */
export function bakeScalarMap(size: number, fn: (u: number, v: number) => number): THREE.Texture {
  return bakeColorMap({
    size,
    srgb: false,
    color: (u, v) => {
      const s = fn(u, v);
      return [s, s, s];
    },
  });
}

/** Memoised bake — identical keys reuse the same GPU texture. */
export function cached(key: string, build: () => THREE.Texture): THREE.Texture {
  const hit = canvasCache.get(key);
  if (hit) return hit;
  const tex = build();
  canvasCache.set(key, tex);
  return tex;
}

/* ------------------------------------------------------------------ */
/* Shared noise bases                                                  */
/* ------------------------------------------------------------------ */

export const NOISE = {
  grass: new Simplex(9001),
  bark: new Simplex(4242),
  soil: new Simplex(777),
  fabric: new Simplex(31337),
  stone: new Simplex(60613),
  paint: new Simplex(112358),
  water: new Simplex(24680),
  cloud: new Simplex(13579),
};

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

/** Mixes two hex colours in linear space and returns an rgb triplet 0..1. */
export function mixHex(a: number, b: number, t: number): [number, number, number] {
  const ar = ((a >> 16) & 255) / 255;
  const ag = ((a >> 8) & 255) / 255;
  const ab = (a & 255) / 255;
  const br = ((b >> 16) & 255) / 255;
  const bg = ((b >> 8) & 255) / 255;
  const bb = (b & 255) / 255;
  return [lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t)];
}

export function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** HSV -> RGB, all channels 0..1. Handy for hue-jittering foliage. */
export function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/* ------------------------------------------------------------------ */
/* Common material texture sets                                        */
/* ------------------------------------------------------------------ */

export interface MaterialMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  aoMap?: THREE.Texture;
}

/**
 * Short, dense, hand-painted-looking lawn grass.
 *
 * The blade detail is deliberately *anisotropic*. Isotropic fbm at blade
 * frequency reads as woven fabric — the eye finds the lattice immediately —
 * whereas real turf is a field of short strokes that all lean the same way
 * within a clump and change direction between clumps. `bladeField` builds that
 * by rotating the sample coordinates by a low-frequency angle field and then
 * stretching them, so each clump gets its own combed direction.
 */
/**
 * The comb-direction field, precomputed.
 *
 * It is only frequency 3, so evaluating fbm for it at every one of a million
 * texels is pure waste — and it doubled the terrain bake when done that way.
 * A 64x64 table with wrapped bilinear interpolation is indistinguishable at
 * this frequency and reduces the cost to a few multiplies per texel.
 */
const COMB_RES = 128;
/** Direction changes per unit — high enough that clumps stay small. */
const COMB_FREQ = 14;
let combTable: Float32Array | null = null;

function combAngle(u: number, v: number): number {
  if (!combTable) {
    combTable = new Float32Array(COMB_RES * COMB_RES);
    for (let y = 0; y < COMB_RES; y++) {
      for (let x = 0; x < COMB_RES; x++) {
        combTable[y * COMB_RES + x] =
          tileableFbm(NOISE.grass, x / COMB_RES, y / COMB_RES, COMB_FREQ, 2) * Math.PI;
      }
    }
  }
  const fx = u * COMB_RES;
  const fy = v * COMB_RES;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = ((x0 % COMB_RES) + COMB_RES) % COMB_RES;
  const ya = ((y0 % COMB_RES) + COMB_RES) % COMB_RES;
  const xb = (xa + 1) % COMB_RES;
  const yb = (ya + 1) % COMB_RES;
  const t = combTable;
  return lerp(
    lerp(t[ya * COMB_RES + xa], t[ya * COMB_RES + xb], tx),
    lerp(t[yb * COMB_RES + xa], t[yb * COMB_RES + xb], tx),
    ty,
  );
}

function bladeField(u: number, v: number, freq: number, octaves: number): number {
  const angle = combAngle(u, v);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Rotate into the clump's frame, then squash across the blade direction so
  // features become strokes rather than blobs. The squash is deliberately mild:
  // pushed harder (0.16 was tried) the strokes fuse into wood-grain whorls,
  // which is a worse artefact than the isotropic weave it replaced.
  const ru = u * cos - v * sin;
  const rv = (u * sin + v * cos) * 0.45;
  const streak = tileableFbm(NOISE.grass, ru + 5, rv, freq, octaves);
  // A little isotropic noise breaks up any residual directional banding.
  const speck = tileableFbm(NOISE.grass, u * 1.7 + 11, v * 1.7, freq * 1.6, 1);
  return streak * 0.72 + speck * 0.28;
}

export function grassTurfMaps(size = 1024): MaterialMaps {
  return {
    map: cached('turf.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const n = tileableFbm(NOISE.grass, u, v, 26, 5);
          const blades = bladeField(u, v, 96, 2);
          const clump = tileableFbm(NOISE.grass, u, v, 6, 3);
          // Base green with warm/cool clumping and per-blade value break-up.
          const t = clamp(0.5 + n * 0.55 + blades * 0.26, 0, 1);
          const warm = clamp(0.5 + clump * 0.9, 0, 1);
          const a = mixHex(0x4f8f36, 0x7cc24a, t);
          const b = mixHex(0x3f7d3a, 0x93cf58, t);
          const c: [number, number, number] = [
            lerp(a[0], b[0], warm),
            lerp(a[1], b[1], warm),
            lerp(a[2], b[2], warm),
          ];
          // Sparse yellowed blades keep it from reading flat.
          const dry = smoothstep(0.72, 0.95, blades * 0.5 + 0.5);
          return [
            lerp(c[0], 0.78, dry * 0.5),
            lerp(c[1], 0.76, dry * 0.4),
            lerp(c[2], 0.36, dry * 0.5),
          ];
        },
      }),
    ),
    normalMap: cached('turf.normal', () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const blades = bladeField(u, v, 96, 2);
            const clump = tileableFbm(NOISE.grass, u, v, 14, 4);
            return 0.5 + blades * 0.35 + clump * 0.15;
          },
        },
        2.2,
      ),
    ),
    roughnessMap: cached('turf.rough', () =>
      bakeScalarMap(512, (u, v) => 0.78 + tileableFbm(NOISE.grass, u, v, 40, 3) * 0.12),
    ),
  };
}

/** Warm compacted dirt path with embedded pebbles. */
export function dirtPathMaps(size = 1024): MaterialMaps {
  const pebble = (u: number, v: number) => {
    const w = worley(u, v, 22, 3);
    return smoothstep(0.34, 0.02, w.f1);
  };
  return {
    map: cached('dirt.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const n = tileableFbm(NOISE.soil, u, v, 18, 5);
          const fine = tileableFbm(NOISE.soil, u * 2 + 3, v * 2, 90, 3);
          const t = clamp(0.5 + n * 0.6 + fine * 0.25, 0, 1);
          const base = mixHex(0x9a6f45, 0xc9a173, t);
          const p = pebble(u, v);
          const stone = mixHex(0xa89c8c, 0xd6cec2, clamp(0.5 + fine, 0, 1));
          return [
            lerp(base[0], stone[0], p * 0.85),
            lerp(base[1], stone[1], p * 0.85),
            lerp(base[2], stone[2], p * 0.85),
          ];
        },
      }),
    ),
    normalMap: cached('dirt.normal', () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const n = tileableFbm(NOISE.soil, u, v, 18, 5) * 0.5 + 0.5;
            return clamp(n * 0.7 + pebble(u, v) * 0.5, 0, 1);
          },
        },
        1.9,
      ),
    ),
    roughnessMap: cached('dirt.rough', () =>
      bakeScalarMap(512, (u, v) => clamp(0.88 - pebble(u, v) * 0.22, 0, 1)),
    ),
  };
}

/** Painted timber cladding — the walls of the Pallet Town houses. */
export function paintedWoodMaps(
  key: string,
  tint: number,
  planks = 9,
  size = 1024,
): MaterialMaps {
  const seam = (v: number) => {
    const p = v * planks;
    const f = Math.abs(p - Math.floor(p) - 0.5) * 2;
    return smoothstep(0.86, 1.0, f);
  };
  return {
    map: cached(`wood.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const grain = tileableFbm(NOISE.bark, u * 0.4, v * 8, 40, 4);
          const wear = tileableFbm(NOISE.paint, u, v, 7, 4);
          const t = clamp(0.5 + grain * 0.18 + wear * 0.3, 0, 1);
          const c = mixHex(tint, 0xffffff, t * 0.22);
          const s = seam(v);
          return [c[0] * (1 - s * 0.42), c[1] * (1 - s * 0.42), c[2] * (1 - s * 0.42)];
        },
      }),
    ),
    normalMap: cached(`wood.${key}.normal`, () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const grain = tileableFbm(NOISE.bark, u * 0.4, v * 8, 40, 4) * 0.5 + 0.5;
            return clamp(0.6 + grain * 0.25 - seam(v) * 0.75, 0, 1);
          },
        },
        1.5,
      ),
    ),
    roughnessMap: cached(`wood.${key}.rough`, () =>
      bakeScalarMap(512, (u, v) => {
        const wear = tileableFbm(NOISE.paint, u, v, 12, 3) * 0.5 + 0.5;
        return clamp(0.52 + wear * 0.24 + seam(v) * 0.18, 0, 1);
      }),
    ),
  };
}

/** Clay roof tiles. */
export function roofTileMaps(key: string, tint: number, rows = 14, size = 1024): MaterialMaps {
  const tile = (u: number, v: number) => {
    const row = v * rows;
    const ri = Math.floor(row);
    const rf = row - ri;
    const offset = ri % 2 === 0 ? 0 : 0.5;
    const col = (u * rows + offset) % 1;
    const arch = Math.sin(rf * Math.PI);
    const side = smoothstep(0.0, 0.08, col) * smoothstep(1.0, 0.92, col);
    return { arch, side, ri, ci: Math.floor(u * rows + offset) };
  };
  return {
    map: cached(`roof.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const { arch, side, ri, ci } = tile(u, v);
          const jitter = ((Math.sin(ri * 12.9898 + ci * 78.233) * 43758.5453) % 1 + 1) % 1;
          const grime = tileableFbm(NOISE.stone, u, v, 20, 4) * 0.5 + 0.5;
          const c = mixHex(tint, 0x2a1c17, (1 - arch) * 0.45 + (1 - side) * 0.3);
          const j = 0.88 + jitter * 0.24;
          return [c[0] * j * (0.86 + grime * 0.2), c[1] * j * (0.86 + grime * 0.2), c[2] * j * (0.86 + grime * 0.2)];
        },
      }),
    ),
    normalMap: cached(`roof.${key}.normal`, () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const { arch, side } = tile(u, v);
            return clamp(arch * 0.75 * side + 0.15, 0, 1);
          },
        },
        2.6,
      ),
    ),
    roughnessMap: cached(`roof.${key}.rough`, () =>
      bakeScalarMap(512, (u, v) => 0.66 + (tileableFbm(NOISE.stone, u, v, 30, 3) * 0.5 + 0.5) * 0.2),
    ),
  };
}

/** Cobble / flagstone for the lab forecourt. */
export function cobbleMaps(size = 1024): MaterialMaps {
  const stone = (u: number, v: number) => {
    const w = worley(u, v, 9, 11);
    const edge = smoothstep(0.0, 0.09, w.f2 - w.f1);
    const jitter = ((w.id % 1000) / 1000) * 0.3;
    return { edge, jitter };
  };
  return {
    map: cached('cobble.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const { edge, jitter } = stone(u, v);
          const n = tileableFbm(NOISE.stone, u, v, 44, 4) * 0.5 + 0.5;
          const c = mixHex(0x9d9a92, 0xcfccc3, clamp(n * 0.7 + jitter, 0, 1));
          const mortar = mixHex(0x6b6862, 0x827e77, n);
          return [
            lerp(mortar[0], c[0], edge),
            lerp(mortar[1], c[1], edge),
            lerp(mortar[2], c[2], edge),
          ];
        },
      }),
    ),
    normalMap: cached('cobble.normal', () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const { edge } = stone(u, v);
            const n = tileableFbm(NOISE.stone, u, v, 60, 3) * 0.5 + 0.5;
            return clamp(edge * 0.85 + n * 0.15, 0, 1);
          },
        },
        2.4,
      ),
    ),
    roughnessMap: cached('cobble.rough', () =>
      bakeScalarMap(512, (u, v) => {
        const { edge } = stone(u, v);
        return clamp(0.62 + (1 - edge) * 0.28, 0, 1);
      }),
    ),
  };
}

/** Tree bark. */
export function barkMaps(size = 1024): MaterialMaps {
  const h = (u: number, v: number) => {
    const stretch = tileableFbm(NOISE.bark, u * 3.2, v * 0.42, 16, 5);
    const fissure = Math.abs(tileableFbm(NOISE.bark, u * 3.0 + 9, v * 0.4, 8, 4));
    return clamp(0.55 + stretch * 0.3 - fissure * 0.55, 0, 1);
  };
  return {
    map: cached('bark.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const moss = smoothstep(0.35, 0.0, t) * smoothstep(0.4, 0.9, tileableFbm(NOISE.grass, u, v, 8, 3) * 0.5 + 0.5);
          const c = mixHex(0x4e392a, 0x9c7d5f, t);
          const m = hexToRgb(0x5f7a3c);
          return [lerp(c[0], m[0], moss * 0.5), lerp(c[1], m[1], moss * 0.5), lerp(c[2], m[2], moss * 0.5)];
        },
      }),
    ),
    normalMap: cached('bark.normal', () => bakeNormalMap({ size, height: h }, 2.8)),
    roughnessMap: cached('bark.rough', () => bakeScalarMap(512, (u, v) => clamp(0.94 - h(u, v) * 0.12, 0, 1))),
  };
}

/** Applies the standard tiling + anisotropy settings to a whole map set. */
export function tile(maps: MaterialMaps, repeat: number, anisotropy = 16): MaterialMaps {
  const out: MaterialMaps = {
    map: maps.map.clone(),
    normalMap: maps.normalMap.clone(),
    roughnessMap: maps.roughnessMap.clone(),
  };
  if (maps.aoMap) out.aoMap = maps.aoMap.clone();
  for (const key of Object.keys(out) as (keyof MaterialMaps)[]) {
    const t = out[key];
    if (!t) continue;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
  }
  return out;
}
