import * as THREE from 'three';
import { bakeNormalMap, cached } from '../core/TextureLab';
import { Simplex, tileableFbm, worley, clamp, smoothstep } from '../core/Noise';

/**
 * Water-only texture bakery.
 *
 * The sea needs three things TextureLab does not provide and no other subsystem
 * wants: two *different* tileable ripple normal maps (using one map twice at two
 * scales produces a visible beat pattern the moment the two layers drift into
 * phase), and a four-channel detail map packing foam, sparkle, streak and
 * caustic fields into a single fetch.
 *
 * Everything is baked on the torus via `tileableFbm` / `worley`, so the sea can
 * scroll forever without a seam.
 */

const SWELL = new Simplex(0x5ea1c0);
const CHOP = new Simplex(0x0cea11);
const FOAM = new Simplex(0xf0a3b1);

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* RGBA bake                                                           */
/* ------------------------------------------------------------------ */

/**
 * TextureLab's `bakeColorMap` hard-writes alpha, and the water detail map needs
 * all four channels, so this file carries its own minimal RGBA baker.
 */
function bakeRGBA(
  size: number,
  fn: (u: number, v: number) => [number, number, number, number],
): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const c = fn(i / size, v);
      const o = (j * size + i) * 4;
      data[o] = clamp(c[0], 0, 1) * 255;
      data[o + 1] = clamp(c[1], 0, 1) * 255;
      data[o + 2] = clamp(c[2], 0, 1) * 255;
      data[o + 3] = clamp(c[3], 0, 1) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Ripple height fields                                                */
/* ------------------------------------------------------------------ */

/**
 * Long ocean swell. Two low-order directional waves (integer coefficients keep
 * them seamless across the tile) warped by a soft fbm so the crests wander
 * instead of running dead straight.
 */
function swellHeight(u: number, v: number): number {
  const w = tileableFbm(SWELL, u, v, 3, 3);
  const a = Math.sin((u * 2 + v * 1) * TAU + w * 2.6) * 0.5 + 0.5;
  const b = Math.sin((u * 3 - v * 2) * TAU + w * 1.7) * 0.5 + 0.5;
  const c = tileableFbm(SWELL, u * 1.3 + 4.1, v * 1.3, 9, 3) * 0.5 + 0.5;
  // Crests sharpened, troughs flattened — real water is not a sine wave.
  const h = clamp(a * 0.44 + b * 0.24 + c * 0.32, 0, 1);
  return h * h * (3 - 2 * h);
}

/** Wind chop riding on the swell — an order of magnitude finer. */
function chopHeight(u: number, v: number): number {
  const w = tileableFbm(CHOP, u, v, 6, 3);
  const a = Math.sin((u * 7 + v * 4) * TAU + w * 3.4) * 0.5 + 0.5;
  const b = Math.sin((v * 9 - u * 5) * TAU + w * 2.2) * 0.5 + 0.5;
  const c = tileableFbm(CHOP, u * 1.7 + 2.3, v * 1.7, 26, 4) * 0.5 + 0.5;
  const d = tileableFbm(CHOP, u + 9.4, v - 3.2, 78, 3) * 0.5 + 0.5;
  return clamp(a * 0.28 + b * 0.2 + c * 0.32 + d * 0.2, 0, 1);
}

/** Broad, slow-scrolling swell normal. One tile ≈ 18 m of sea. */
export function waterSwellNormal(size = 512): THREE.Texture {
  return cached('water.swell.n', () => bakeNormalMap({ size, height: swellHeight }, 1.35));
}

/** Fine chop normal. One tile ≈ 7 m of sea. */
export function waterChopNormal(size = 512): THREE.Texture {
  return cached('water.chop.n', () => bakeNormalMap({ size, height: chopHeight }, 2.1));
}

/* ------------------------------------------------------------------ */
/* Packed detail map                                                   */
/* ------------------------------------------------------------------ */

/**
 * R — foam: three scales of cellular clumping. Big cauliflower heads broken by
 *     medium cells and a bubble layer, so a single threshold sweep across the
 *     channel produces a believable wash edge at any width.
 * G — sparkle: isolated high-frequency peaks driving the sun glitter.
 * B — streaks: fbm stretched 12:1, used for backwash trails running down the
 *     sand and for the drift lines in the shallows.
 * A — caustics: a worley ridge network, the classic seabed light web.
 */
export function waterDetailTexture(size = 512): THREE.Texture {
  return cached('water.detail', () =>
    bakeRGBA(size, (u, v) => {
      const w1 = worley(u, v, 6, 3);
      const w2 = worley(u, v, 15, 91);
      const w3 = worley(u, v, 37, 217);
      const clump =
        smoothstep(0.46, 0.05, w1.f1) * 0.52 +
        smoothstep(0.32, 0.02, w2.f1) * 0.46 +
        smoothstep(0.24, 0.0, w3.f1) * 0.34;
      const bubbles = smoothstep(0.19, 0.0, w3.f1);
      const foam = clamp(clump * (0.62 + bubbles * 0.72), 0, 1);

      const s1 = tileableFbm(FOAM, u * 1.9 + 3.1, v * 1.9, 96, 2) * 0.5 + 0.5;
      const s2 = worley(u, v, 26, 511).f1;
      const sparkle = clamp(smoothstep(0.54, 0.94, s1) * 0.7 + smoothstep(0.34, 0.02, s2) * 0.6, 0, 1);

      const streak = clamp(tileableFbm(FOAM, u * 4.2 + 11.3, v * 0.34, 22, 4) * 0.85 + 0.5, 0, 1);

      const c1 = worley(u, v, 10, 733);
      const caustic = clamp(Math.pow(1 - smoothstep(0.0, 0.26, c1.f2 - c1.f1), 1.6), 0, 1);

      return [foam, sparkle, streak, caustic];
    }),
  ) as THREE.DataTexture;
}
