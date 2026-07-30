import * as THREE from 'three';
import {
  bakeColorMap,
  bakeNormalMap,
  bakeScalarMap,
  cached,
  mixHex,
  type MaterialMaps,
} from '../core/TextureLab';
import { Simplex, tileableFbm, worley, clamp, smoothstep, lerp } from '../core/Noise';

/**
 * Terrain-only texture bakery.
 *
 * TextureLab owns everything shared across the town; this file adds the two
 * things only the ground needs — beach sand, and the large-scale world noise
 * texture the terrain shader uses to break up detail tiling. Keeping them here
 * means the terrain can iterate on its own maps without touching a file six
 * other subsystems import.
 */

const SAND = new Simplex(0x5a4d17);
const WARP = new Simplex(0x77c0de);
const EARTH = new Simplex(0x2c1d0b);

/* ------------------------------------------------------------------ */
/* Worn earth track                                                    */
/* ------------------------------------------------------------------ */

/**
 * Gravel field for the dirt track.
 *
 * The shared `dirtPathMaps` pebble layer is a single Worley at 22 cells, and a
 * single Worley is a *lattice*: every cell is the same size, so at any viewing
 * distance where one cell lands near one pixel the eye locks onto the grid and
 * the whole path reads as cobblestone paving. The fix is threefold —
 *
 *  1. three Worley layers at incommensurate cell counts (11 / 19 / 31), so
 *     there is no single dominant wavelength;
 *  2. a large-scale (2-cycle) selector noise cross-fading between them, so the
 *     *apparent grain size* drifts across the tile rather than being constant;
 *  3. a per-pebble radius drawn from the cell id, so even within one layer the
 *     stones do not share a footprint.
 *
 * Offsetting u/v is safe here only for `tileableFbm` (it is a phase shift on a
 * torus); Worley wraps on integer cell counts, so those layers differ by seed
 * alone.
 */
function gravel(u: number, v: number): number {
  // Selector: 0 -> coarse stones, 1 -> fine grit. Two cycles across the tile,
  // which at the terrain's 1.1 m dirt period is a ~2 m drift in grain size.
  const sel = clamp(tileableFbm(EARTH, u + 0.21, v + 0.83, 2, 2) * 1.9 + 0.5, 0, 1);
  // Density. One cycle across the tile, so whole stretches of track come out
  // swept almost clean and others hold their shingle. Without this the stone
  // *count* per square metre is constant even when the stone size is not, and a
  // constant count is itself a lattice — the eye reads the average spacing.
  const dens = clamp(tileableFbm(EARTH, u + 4.31, v + 1.77, 1, 2) * 2.1 + 0.5, 0, 1);
  // Per-layer UV jitter driven by a coarse noise: shifts each Worley grid
  // bodily by up to half a cell, so the three grids never stay in register.
  const jx = tileableFbm(EARTH, u + 8.1, v + 2.9, 2, 1) * 0.04;
  const jy = tileableFbm(EARTH, u + 3.7, v + 9.3, 2, 1) * 0.04;

  const wA = worley(u + jx, v - jy, 11, 41);
  const wB = worley(u - jy, v + jx, 19, 97);
  const wC = worley(u + jy, v + jx, 31, 151);
  // Per-stone radius jitter. Some cells get a radius near zero and drop out
  // entirely, which is what breaks the "one blob per cell" read.
  const rA = 0.16 + ((wA.id >>> 7) % 977) / 977 * 0.30;
  const rB = 0.14 + ((wB.id >>> 5) % 983) / 983 * 0.26;
  const rC = 0.10 + ((wC.id >>> 3) % 991) / 991 * 0.22;
  const pA = smoothstep(rA, rA * 0.12, wA.f1);
  const pB = smoothstep(rB, rB * 0.12, wB.f1);
  const pC = smoothstep(rC, rC * 0.12, wC.f1);

  const kA = clamp(1 - Math.abs(sel - 0.0) * 1.9, 0, 1);
  const kB = clamp(1 - Math.abs(sel - 0.5) * 1.9, 0, 1);
  const kC = clamp(1 - Math.abs(sel - 1.0) * 1.9, 0, 1);
  const norm = kA + kB + kC + 1e-4;
  const mixed = (pA * kA + pB * kB + pC * kC) / norm;
  return clamp(mixed * (0.22 + dens * 0.95), 0, 1);
}

/**
 * Height basis for the track: compacted earth with cart ruts smeared along the
 * grain, gravel sitting in it, and a fine crumb layer for close range. Overall
 * amplitude is deliberately lower than the shared dirt map — this is a trodden
 * surface, not a shingle beach.
 */
function earthHeight(u: number, v: number): number {
  const lump = tileableFbm(EARTH, u, v, 7, 4) * 0.5 + 0.5;
  const smear = tileableFbm(EARTH, u + 0.47, v + 0.11, 13, 3) * 0.5 + 0.5;
  const crumb = tileableFbm(EARTH, u + 0.63, v + 0.29, 96, 2) * 0.5 + 0.5;
  return clamp(lump * 0.48 + smear * 0.17 + crumb * 0.13 + gravel(u, v) * 0.24, 0, 1);
}

/**
 * Worn earth track. Warm compacted soil in the bible's dirt range
 * (#9a6f45 -> #c9a173) with grey-brown gravel; contrast is kept low because
 * the terrain shader spreads this over tens of metres, where any grit contrast
 * that reads well at arm's length turns into visual noise.
 */
export function trackEarthMaps(size = 1024): MaterialMaps {
  return {
    map: cached('track.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const patch = tileableFbm(EARTH, u, v, 5, 4);
          const fine = tileableFbm(EARTH, u + 0.19, v + 0.71, 34, 3);
          const t = clamp(0.46 + patch * 0.85 + fine * 0.22, 0, 1);
          const base = mixHex(0x8f6941, 0xc7a075, t);
          // Damp patches where the track holds water after rain.
          const wetT = smoothstep(0.62, 0.95, tileableFbm(EARTH, u + 0.37, v + 0.05, 3, 3) * 0.5 + 0.5);
          const damp = mixHex(0x7a5b3a, 0x8f6b45, t);
          // 0.40, not 0.55: under the treeline's blue-only fill these damp
          // patches were reading as oil stains on tarmac rather than as ground
          // that is holding a little water.
          const soil: [number, number, number] = [
            lerp(base[0], damp[0], wetT * 0.4),
            lerp(base[1], damp[1], wetT * 0.4),
            lerp(base[2], damp[2], wetT * 0.4),
          ];
          const g = gravel(u, v);
          const stone = mixHex(0xa2947f, 0xbfb2a0, clamp(0.5 + fine * 1.6, 0, 1));
          // 0.42 rather than 0.85: gravel tints the earth, it does not replace
          // it. Every point of stone contrast here is a point of speckle the
          // shader has to average away over tens of metres.
          return [
            lerp(soil[0], stone[0], g * 0.42),
            lerp(soil[1], stone[1], g * 0.42),
            lerp(soil[2], stone[2], g * 0.42),
          ];
        },
      }),
    ),
    normalMap: cached('track.normal', () => bakeNormalMap({ size, height: earthHeight }, 1.35)),
    roughnessMap: cached('track.rough', () =>
      bakeScalarMap(512, (u, v) => clamp(0.9 - gravel(u, v) * 0.16, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Beach sand                                                          */
/* ------------------------------------------------------------------ */

/**
 * Height basis for the sand. Three scales stacked: soft drift dunes, wind
 * ripples running at a slight diagonal, and a grain layer fine enough that the
 * normal map still reads at 20cm from the camera.
 */
function sandHeight(u: number, v: number): number {
  const warp = tileableFbm(SAND, u, v, 5, 3);
  // Integer coefficients on u and v keep the sine wave seamless across the tile.
  const ripple = Math.sin((v * 17 + u * 5 + warp * 1.5) * Math.PI * 2) * 0.5 + 0.5;
  const ripple2 = Math.sin((v * 39 - u * 9 + warp * 2.6) * Math.PI * 2) * 0.5 + 0.5;
  const drift = tileableFbm(SAND, u, v, 9, 3) * 0.5 + 0.5;
  // NOTE: u/v must enter tileableFbm unscaled. It wraps by walking a circle of
  // circumference 2*pi*u, so `u * 1.7` no longer closes at u = 1 and the map
  // gets a hard seam down every tile — which on a 64 m beach is a dead straight
  // line across the sand. Offsets are fine (pure phase shift on the torus);
  // scales are not.
  const grain = tileableFbm(SAND, u + 3, v, 260, 2) * 0.5 + 0.5;
  const shell = smoothstep(0.2, 0.03, worley(u, v, 30, 5).f1);
  return clamp(
    drift * 0.36 + ripple * 0.15 + ripple2 * 0.09 + grain * 0.32 + shell * 0.2,
    0,
    1,
  );
}

/** Dry beach sand — pale warm quartz with shell fragments and wind ripples. */
export function sandMaps(size = 1024): MaterialMaps {
  return {
    map: cached('sand.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const h = sandHeight(u, v);
          const patch = tileableFbm(SAND, u, v, 7, 4) * 0.5 + 0.5;
          // Two sands: a cooler grey-beige and a warmer golden one, drifting
          // into each other so no two square metres are the same colour.
          const cool = mixHex(0xa9906b, 0xdfd0b2, clamp(h * 1.15, 0, 1));
          const warm = mixHex(0xbe9c6a, 0xefe0bd, clamp(h * 1.15, 0, 1));
          const base: [number, number, number] = [
            lerp(cool[0], warm[0], patch),
            lerp(cool[1], warm[1], patch),
            lerp(cool[2], warm[2], patch),
          ];
          // Shell chips and quartz specks, just above the sand value.
          const w = worley(u, v, 30, 5);
          const chip = smoothstep(0.13, 0.02, w.f1);
          const chipTint = ((w.id % 977) / 977) * 0.18;
          const shell = mixHex(0xe8dfd0, 0xf2ece1, chipTint);
          // A few darker mineral grains stop the sand reading as flat cream.
          // Unscaled u/v — see sandHeight: scaling breaks the wrap.
          const dark = smoothstep(0.86, 0.99, tileableFbm(SAND, u + 9, v, 190, 2) * 0.5 + 0.5);
          const c: [number, number, number] = [
            lerp(base[0], shell[0], chip * 0.8),
            lerp(base[1], shell[1], chip * 0.8),
            lerp(base[2], shell[2], chip * 0.8),
          ];
          return [
            lerp(c[0], 0.42, dark * 0.45),
            lerp(c[1], 0.36, dark * 0.45),
            lerp(c[2], 0.3, dark * 0.45),
          ];
        },
      }),
    ),
    normalMap: cached('sand.normal', () => bakeNormalMap({ size, height: sandHeight }, 1.7)),
    roughnessMap: cached('sand.rough', () =>
      bakeScalarMap(512, (u, v) => clamp(0.93 - sandHeight(u, v) * 0.16, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Channel packing                                                     */
/* ------------------------------------------------------------------ */

/**
 * A four-layer splat shader wants twelve maps, and WebGL guarantees only
 * sixteen fragment texture units — of which the renderer itself needs several
 * for shadows and the environment probe. So the terrain packs.
 *
 * Normal maps keep only XY (Z is reconstructed, the maps are unit length), so
 * two layers fit in one RGBA. Roughness is a single channel, so all four fit.
 * Net effect: twelve samplers collapse to three.
 */
function readCanvas(tex: THREE.Texture): ImageData {
  const canvas = tex.image as HTMLCanvasElement;
  const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
  return c2d.getImageData(0, 0, canvas.width, canvas.height);
}

function finishData(tex: THREE.DataTexture, anisotropy = 16): THREE.DataTexture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Packs two tangent-space normal maps into one RGBA: a.xy -> rg, b.xy -> ba. */
export function packNormalPair(key: string, a: THREE.Texture, b: THREE.Texture): THREE.DataTexture {
  return cached(`pack.n.${key}`, () => {
    const ia = readCanvas(a);
    const ib = readCanvas(b);
    const size = Math.min(ia.width, ib.width);
    const data = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) {
      // Source canvases upload with flipY; DataTextures do not. Flipping the
      // rows here is what keeps the packed normals registered to the albedo
      // they were baked from — without it every bump lights from the wrong
      // side and the ground reads as printed-on rather than sculpted.
      const sj = size - 1 - j;
      for (let i = 0; i < size; i++) {
        const o = (j * size + i) * 4;
        const pa = ((((sj * ia.height) / size) | 0) * ia.width + (((i * ia.width) / size) | 0)) * 4;
        const pb = ((((sj * ib.height) / size) | 0) * ib.width + (((i * ib.width) / size) | 0)) * 4;
        data[o] = ia.data[pa];
        data[o + 1] = ia.data[pa + 1];
        data[o + 2] = ib.data[pb];
        data[o + 3] = ib.data[pb + 1];
      }
    }
    return finishData(new THREE.DataTexture(data, size, size, THREE.RGBAFormat));
  }) as THREE.DataTexture;
}

/** Packs four single-channel maps into the four channels of one RGBA. */
export function packScalarQuad(
  key: string,
  r: THREE.Texture,
  g: THREE.Texture,
  b: THREE.Texture,
  a: THREE.Texture,
): THREE.DataTexture {
  return cached(`pack.s.${key}`, () => {
    const src = [r, g, b, a].map(readCanvas);
    const size = Math.min(...src.map((s) => s.width));
    const data = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) {
      const sj = size - 1 - j; // see packNormalPair — flipY compensation
      for (let i = 0; i < size; i++) {
        const o = (j * size + i) * 4;
        for (let c = 0; c < 4; c++) {
          const s = src[c];
          const p = ((((sj * s.height) / size) | 0) * s.width + (((i * s.width) / size) | 0)) * 4;
          data[o + c] = s.data[p + 1];
        }
      }
    }
    return finishData(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), 8);
  }) as THREE.DataTexture;
}

/* ------------------------------------------------------------------ */
/* World-scale variation texture                                       */
/* ------------------------------------------------------------------ */

/**
 * A single seamless RGBA noise sampled by the terrain shader at two very
 * different world scales.
 *
 *  - `rg` is a signed 2D offset used to domain-warp both the splat lookup and
 *    the detail UVs. This is the whole reason the ground has no visible tiling
 *    grid: every detail sample lands somewhere slightly different.
 *  - `b`  is an uncorrelated scalar used for macro albedo / hue drift.
 *  - `a`  is a broad soft-cloud term used to modulate detail-scale blending.
 */
export function terrainWarpTexture(size = 256): THREE.DataTexture {
  return cached('terrain.warp', () => {
    const data = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) {
      const v = j / size;
      for (let i = 0; i < size; i++) {
        const u = i / size;
        const wx = tileableFbm(WARP, u, v, 3, 3);
        const wy = tileableFbm(WARP, u + 0.37, v + 0.61, 3, 3);
        // b and a are *macro* channels: the shader reads them at 70 m and 32 m
        // to drive the lawn's colour, so what they need is a small number of
        // big blobs with the full byte range behind them. They used to be
        // frequency-5, four-octave fields scaled by 1.3 — which (a) broke the
        // tileable wrap, printing a hard seam across the map every 70 m, and
        // (b) being near-Gaussian sums of eight octaves, sat within a few
        // percent of 0.5 nearly everywhere. The shader then smoothstepped that
        // to a constant and 60 metres of lawn came out one tone. Two octaves at
        // frequency 2 and 1, gained hard into the clamp, is what actually gives
        // patches you can see from the far end of the town.
        const macro = tileableFbm(WARP, u + 7.1, v - 2.4, 2, 2);
        const cloud = tileableFbm(WARP, u + 11.3, v + 4.7, 1, 2);
        const o = (j * size + i) * 4;
        data[o] = clamp(wx * 0.72 + 0.5, 0, 1) * 255;
        data[o + 1] = clamp(wy * 0.72 + 0.5, 0, 1) * 255;
        data[o + 2] = clamp(macro * 1.55 + 0.5, 0, 1) * 255;
        data[o + 3] = clamp(cloud * 1.7 + 0.5, 0, 1) * 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }) as THREE.DataTexture;
}
