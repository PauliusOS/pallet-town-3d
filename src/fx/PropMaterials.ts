import * as THREE from 'three';
import {
  bakeColorMap,
  bakeNormalMap,
  bakeScalarMap,
  cached,
  mixHex,
  hexToRgb,
  type MaterialMaps,
} from '../core/TextureLab';
import { Simplex, tileableFbm, worley, clamp, smoothstep, lerp } from '../core/Noise';

/**
 * Prop-only texture bakery and geometry toolkit.
 *
 * TextureLab covers the surfaces the *buildings* are made of. The town dressing
 * needs a different vocabulary — silvered fence timber, chipped enamel paint,
 * granite, potting soil, linen, hemp rope — plus one thing nothing else in the
 * project needs: a text field baked into an albedo/height/normal triple so the
 * town sign's lettering is genuinely carved rather than printed.
 *
 * Everything here is keyed through TextureLab's `cached()`, so a map baked for
 * the fence is the same GPU texture the crates use.
 */

const WOOD = new Simplex(0x51a7c0);
const METAL = new Simplex(0x3ea11e);
const ROCK = new Simplex(0x70c15e);
const SOIL = new Simplex(0x5011ed);
const CLOTH = new Simplex(0x1eaf01);

/* ------------------------------------------------------------------ */
/* Geometry merge                                                      */
/* ------------------------------------------------------------------ */

/**
 * Indexed merge over position / normal / uv / color.
 *
 * Props are a long tail of one-off objects that all share three or four
 * materials. Merging them per material turns forty draw calls into four, and —
 * unlike instancing — lets every crate have its own plank pattern and every
 * rock its own silhouette. Colour is carried at four components so a single
 * merged mesh can also fade a decal out at its rim.
 */
export function mergeProps(geos: THREE.BufferGeometry[], colorSize = 3): THREE.BufferGeometry {
  const sizes: Record<string, number> = { position: 3, normal: 3, uv: 2, color: colorSize };
  const names = ['position', 'normal', 'uv', 'color'].filter((n) =>
    geos.every((g) => !!g.attributes[n]),
  );

  let total = 0;
  let idxTotal = 0;
  for (const g of geos) {
    const c = (g.attributes.position as THREE.BufferAttribute).count;
    total += c;
    idxTotal += g.index ? g.index.count : c;
  }

  const buffers: Record<string, Float32Array> = {};
  for (const n of names) buffers[n] = new Float32Array(total * sizes[n]);
  const indices = total > 65535 ? new Uint32Array(idxTotal) : new Uint16Array(idxTotal);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const count = (g.attributes.position as THREE.BufferAttribute).count;
    for (const n of names) {
      const src = g.attributes[n] as THREE.BufferAttribute;
      const s = sizes[n];
      const dst = buffers[n];
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < s; c++) dst[(vOff + i) * s + c] = src.getComponent(i, c);
      }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) indices[iOff + i] = g.index.getX(i) + vOff;
    else for (let i = 0; i < count; i++) indices[iOff + i] = vOff + i;
    iOff += g.index ? g.index.count : count;
    vOff += count;
  }

  const out = new THREE.BufferGeometry();
  for (const n of names) out.setAttribute(n, new THREE.BufferAttribute(buffers[n], sizes[n]));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}

/** Paints a flat vertex colour onto a geometry so it can join a merged mesh. */
export function tintGeo(
  geo: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  alpha?: number,
): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = (geo.attributes.position as THREE.BufferAttribute).count;
  const size = alpha === undefined ? 3 : 4;
  const arr = new Float32Array(n * size);
  for (let i = 0; i < n; i++) {
    arr[i * size] = c.r;
    arr[i * size + 1] = c.g;
    arr[i * size + 2] = c.b;
    if (size === 4) arr[i * size + 3] = alpha!;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, size));
  return geo;
}

/* ------------------------------------------------------------------ */
/* Wood                                                                */
/* ------------------------------------------------------------------ */

/**
 * Bare weathered timber: straight grain running along V, knots, a couple of
 * deep season checks, and silvered flat-sawn bands. Everything the eye uses to
 * tell a fence post from a plastic cylinder lives in the height field, so
 * albedo, normal and roughness are all derived from the one function.
 */
function timberHeight(u: number, v: number, grain: number): number {
  // Grain: fbm stretched hard along V. The 0.13 on u is what makes the rings
  // wander across the board instead of running as parallel stripes.
  const g = tileableFbm(WOOD, u * 0.13, v * grain, 26, 4);
  const rings = Math.abs(Math.sin(g * 7.5)) ;
  const knot = worley(u, v, 3, 17);
  const knotMask = smoothstep(0.22, 0.03, knot.f1);
  const check = smoothstep(0.9, 1.0, Math.abs(tileableFbm(WOOD, u * 0.6 + 4, v * 0.3, 5, 3)) * 2.4);
  const fine = tileableFbm(WOOD, u * 2 + 9, v * grain * 1.6, 90, 2);
  return clamp(0.62 - rings * 0.24 + fine * 0.10 - knotMask * 0.30 - check * 0.42, 0, 1);
}

export function timberMaps(key: string, tint: number, grain = 5, size = 512): MaterialMaps {
  const h = (u: number, v: number) => timberHeight(u, v, grain);
  return {
    map: cached(`prop.wood.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const weather = tileableFbm(WOOD, u * 0.8 + 2.2, v * 0.8, 6, 3) * 0.5 + 0.5;
          // Two woods blended by the grain height: dark latewood, pale
          // earlywood, then silvered on the exposed faces.
          const base = mixHex(0x4a3524, tint, clamp(t * 1.25, 0, 1));
          const grey = hexToRgb(0xa9a094);
          const c: [number, number, number] = [
            lerp(base[0], grey[0], weather * 0.34),
            lerp(base[1], grey[1], weather * 0.34),
            lerp(base[2], grey[2], weather * 0.34),
          ];
          // Green-black damp in the deepest checks — wood that has sat outside.
          const damp = smoothstep(0.22, 0.0, t);
          return [
            lerp(c[0], 0.15, damp * 0.7),
            lerp(c[1], 0.16, damp * 0.7),
            lerp(c[2], 0.12, damp * 0.7),
          ];
        },
      }),
    ),
    normalMap: cached(`prop.wood.${key}.normal`, () => bakeNormalMap({ size, height: h }, 2.4)),
    roughnessMap: cached(`prop.wood.${key}.rough`, () =>
      bakeScalarMap(384, (u, v) => clamp(0.94 - h(u, v) * 0.18, 0, 1)),
    ),
  };
}

/** Painted timber — the grain reads *through* thin paint, chipped at the edges. */
export function paintedTimberMaps(key: string, tint: number, size = 512): MaterialMaps {
  const h = (u: number, v: number) => {
    const t = timberHeight(u, v, 4);
    // Paint fills the grain, so the surface height is a flattened version of it.
    return clamp(0.7 + (t - 0.6) * 0.34, 0, 1);
  };
  return {
    map: cached(`prop.paintwood.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = timberHeight(u, v, 4);
          const wear = tileableFbm(WOOD, u * 1.4 + 7.7, v * 1.4, 9, 4) * 0.5 + 0.5;
          const chip = smoothstep(0.80, 0.96, wear) * smoothstep(0.55, 0.25, t);
          const paint = mixHex(tint, 0xffffff, (t - 0.4) * 0.28);
          const bare = mixHex(0x6d5136, 0x9b7c58, t);
          return [
            lerp(paint[0], bare[0], chip),
            lerp(paint[1], bare[1], chip),
            lerp(paint[2], bare[2], chip),
          ];
        },
      }),
    ),
    normalMap: cached(`prop.paintwood.${key}.normal`, () => bakeNormalMap({ size, height: h }, 1.3)),
    roughnessMap: cached(`prop.paintwood.${key}.rough`, () =>
      bakeScalarMap(384, (u, v) => {
        const wear = tileableFbm(WOOD, u * 1.4 + 7.7, v * 1.4, 9, 4) * 0.5 + 0.5;
        return clamp(0.44 + wear * 0.34, 0, 1);
      }),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Painted metal                                                       */
/* ------------------------------------------------------------------ */

/**
 * Enamelled sheet metal: orange-peel from the spray gun, a scatter of chips
 * down to primer, and a faint rust bloom in the low spots. White base so the
 * merged mesh can tint per-object through vertex colour.
 */
export function paintedMetalMaps(size = 512): MaterialMaps {
  const peel = (u: number, v: number) => tileableFbm(METAL, u, v, 46, 3) * 0.5 + 0.5;
  const chipField = (u: number, v: number) => {
    const w = worley(u, v, 19, 61);
    const n = tileableFbm(METAL, u * 2 + 5, v * 2, 14, 3) * 0.5 + 0.5;
    return smoothstep(0.14, 0.02, w.f1) * smoothstep(0.42, 0.78, n);
  };
  return {
    map: cached('prop.metal.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const p = peel(u, v);
          const chip = chipField(u, v);
          const dust = tileableFbm(METAL, u * 0.7 + 3, v * 0.7, 5, 3) * 0.5 + 0.5;
          const base: [number, number, number] = [
            0.88 + p * 0.12,
            0.88 + p * 0.12,
            0.87 + p * 0.12,
          ];
          const primer = hexToRgb(0x6f6559);
          const rust = hexToRgb(0x8c4f2c);
          const c: [number, number, number] = [
            lerp(base[0], primer[0], chip),
            lerp(base[1], primer[1], chip),
            lerp(base[2], primer[2], chip),
          ];
          const bloom = chip * smoothstep(0.5, 0.85, dust);
          return [
            lerp(c[0], rust[0], bloom * 0.8),
            lerp(c[1], rust[1], bloom * 0.8),
            lerp(c[2], rust[2], bloom * 0.8),
          ];
        },
      }),
    ),
    normalMap: cached('prop.metal.normal', () =>
      bakeNormalMap(
        { size, height: (u, v) => clamp(0.62 + peel(u, v) * 0.12 - chipField(u, v) * 0.35, 0, 1) },
        1.1,
      ),
    ),
    roughnessMap: cached('prop.metal.rough', () =>
      bakeScalarMap(384, (u, v) => clamp(0.26 + chipField(u, v) * 0.5 + peel(u, v) * 0.1, 0, 1)),
    ),
  };
}

/** Bare galvanised / forged steel for pail bands, blades and lamp ironwork. */
export function bareMetalMaps(size = 512): MaterialMaps {
  const h = (u: number, v: number) => {
    const hammer = worley(u, v, 13, 7).f1;
    const scratch = Math.abs(tileableFbm(METAL, u * 5 + 1, v * 0.4, 40, 3));
    return clamp(0.55 + hammer * 0.3 - scratch * 0.35, 0, 1);
  };
  return {
    map: cached('prop.steel.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const patina = tileableFbm(METAL, u * 1.1 + 8, v * 1.1, 7, 4) * 0.5 + 0.5;
          const c = mixHex(0x5b5f63, 0x9ba3a8, t);
          const dark = mixHex(0x3a3f43, 0x6c7378, patina);
          return [lerp(dark[0], c[0], 0.35 + patina * 0.6), lerp(dark[1], c[1], 0.35 + patina * 0.6), lerp(dark[2], c[2], 0.35 + patina * 0.6)];
        },
      }),
    ),
    normalMap: cached('prop.steel.normal', () => bakeNormalMap({ size, height: h }, 1.5)),
    roughnessMap: cached('prop.steel.rough', () =>
      bakeScalarMap(384, (u, v) => clamp(0.32 + (1 - h(u, v)) * 0.32, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Granite                                                             */
/* ------------------------------------------------------------------ */

export function graniteMaps(size = 512): MaterialMaps {
  const h = (u: number, v: number) => {
    const pit = worley(u, v, 26, 3).f1;
    const band = tileableFbm(ROCK, u * 1.6, v * 0.7, 9, 4);
    const grit = tileableFbm(ROCK, u * 2 + 4, v * 2, 120, 2);
    return clamp(0.55 + band * 0.24 + grit * 0.12 + pit * 0.2 - 0.1, 0, 1);
  };
  return {
    map: cached('prop.granite.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const w = worley(u, v, 26, 3);
          const crystal = smoothstep(0.30, 0.04, w.f1);
          const jitter = ((w.id % 811) / 811 - 0.5) * 0.3;
          const base = mixHex(0x6e6a63, 0xc0bcb2, clamp(t + jitter, 0, 1));
          const dark = hexToRgb(0x413e3a);
          const lichen = hexToRgb(0x8ea56a);
          const moss = smoothstep(0.62, 0.92, tileableFbm(ROCK, u * 0.9 + 6, v * 0.9, 8, 3) * 0.5 + 0.5);
          const c: [number, number, number] = [
            lerp(base[0], dark[0], crystal * 0.35),
            lerp(base[1], dark[1], crystal * 0.35),
            lerp(base[2], dark[2], crystal * 0.35),
          ];
          return [
            lerp(c[0], lichen[0], moss * 0.4),
            lerp(c[1], lichen[1], moss * 0.4),
            lerp(c[2], lichen[2], moss * 0.4),
          ];
        },
      }),
    ),
    normalMap: cached('prop.granite.normal', () => bakeNormalMap({ size, height: h }, 2.2)),
    roughnessMap: cached('prop.granite.rough', () =>
      bakeScalarMap(384, (u, v) => clamp(0.72 + (1 - h(u, v)) * 0.2, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Soil                                                                */
/* ------------------------------------------------------------------ */

export function soilMaps(size = 384): MaterialMaps {
  const h = (u: number, v: number) => {
    const lump = worley(u, v, 16, 5).f1;
    const fine = tileableFbm(SOIL, u * 2, v * 2, 70, 3);
    return clamp(0.45 + lump * 0.55 + fine * 0.18, 0, 1);
  };
  return {
    map: cached('prop.soil.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const damp = tileableFbm(SOIL, u + 3, v, 8, 3) * 0.5 + 0.5;
          const c = mixHex(0x2e2318, 0x60482f, clamp(t * 1.1, 0, 1));
          return [c[0] * (0.8 + damp * 0.35), c[1] * (0.8 + damp * 0.35), c[2] * (0.8 + damp * 0.35)];
        },
      }),
    ),
    normalMap: cached('prop.soil.normal', () => bakeNormalMap({ size, height: h }, 2.6)),
    roughnessMap: cached('prop.soil.rough', () => bakeScalarMap(256, () => 0.95)),
  };
}

/* ------------------------------------------------------------------ */
/* Linen / rope                                                        */
/* ------------------------------------------------------------------ */

export function linenMaps(size = 384): MaterialMaps {
  const h = (u: number, v: number) => {
    // Plain weave: two out-of-phase square waves crossing.
    const warp = Math.sin(u * Math.PI * 2 * 64) * 0.5 + 0.5;
    const weft = Math.sin(v * Math.PI * 2 * 64 + Math.PI * 0.5) * 0.5 + 0.5;
    const slub = tileableFbm(CLOTH, u * 1.4, v * 1.4, 22, 3) * 0.5 + 0.5;
    return clamp(0.42 + warp * 0.28 + weft * 0.24 + slub * 0.18, 0, 1);
  };
  return {
    map: cached('prop.linen.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const stain = tileableFbm(CLOTH, u * 0.7 + 2, v * 0.7, 5, 3) * 0.5 + 0.5;
          const c = mixHex(0xd9d2c4, 0xfaf6ec, t);
          return [c[0] * (0.9 + stain * 0.14), c[1] * (0.9 + stain * 0.13), c[2] * (0.88 + stain * 0.15)];
        },
      }),
    ),
    normalMap: cached('prop.linen.normal', () => bakeNormalMap({ size, height: h }, 1.5)),
    roughnessMap: cached('prop.linen.rough', () => bakeScalarMap(256, (u, v) => 0.86 + h(u, v) * 0.08)),
  };
}

export function ropeMaps(size = 256): MaterialMaps {
  // Three-strand lay: a sawtooth in the diagonal, plus fibre fuzz.
  const h = (u: number, v: number) => {
    const lay = Math.abs(((u * 3 + v * 0.5) % 1) - 0.5) * 2;
    const fibre = tileableFbm(CLOTH, u * 3 + 5, v * 0.5, 60, 2) * 0.5 + 0.5;
    return clamp(0.35 + (1 - lay) * 0.5 + fibre * 0.2, 0, 1);
  };
  return {
    map: cached('prop.rope.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const c = mixHex(0x6d5a3c, 0xc4ac83, t);
          return c;
        },
      }),
    ),
    normalMap: cached('prop.rope.normal', () => bakeNormalMap({ size, height: h }, 2.4)),
    roughnessMap: cached('prop.rope.rough', () => bakeScalarMap(192, () => 0.92)),
  };
}

/* ------------------------------------------------------------------ */
/* Ground decal                                                        */
/* ------------------------------------------------------------------ */

/**
 * A single RGBA decal sheet: scuffed earth in RGB, an irregular radial falloff
 * in A. Every scuff and every post's dirt ring maps the whole 0..1 square, and
 * a random UV rotation per decal at bake time means no two read as the same
 * stamp. Alpha lives in `map` rather than in an alphaMap so the whole system
 * costs one texture fetch.
 */
export function dirtDecalTexture(size = 256): THREE.DataTexture {
  return cached('prop.decal.dirt', () => {
    const data = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) {
      const v = j / size;
      for (let i = 0; i < size; i++) {
        const u = i / size;
        const dx = u - 0.5;
        const dy = v - 0.5;
        const r = Math.hypot(dx, dy) * 2;
        // Radius modulated by angle so the patch is a blob, not a disc.
        const ang = Math.atan2(dy, dx);
        const wobble =
          tileableFbm(SOIL, 0.5 + Math.cos(ang) * 0.25, 0.5 + Math.sin(ang) * 0.25, 5, 3) * 0.42;
        const edge = smoothstep(0.98 + wobble, 0.30 + wobble * 0.6, r);
        const grit = tileableFbm(SOIL, u * 1.7, v * 1.7, 34, 4) * 0.5 + 0.5;
        const peb = smoothstep(0.30, 0.06, worley(u, v, 14, 23).f1);
        const c = mixHex(0x7a5a38, 0xb08a5c, clamp(grit * 1.2, 0, 1));
        const stone = mixHex(0x9a9084, 0xcac2b4, grit);
        const o = (j * size + i) * 4;
        data[o] = clamp(lerp(c[0], stone[0], peb * 0.7), 0, 1) * 255;
        data[o + 1] = clamp(lerp(c[1], stone[1], peb * 0.7), 0, 1) * 255;
        data[o + 2] = clamp(lerp(c[2], stone[2], peb * 0.7), 0, 1) * 255;
        data[o + 3] = clamp(edge * (0.55 + grit * 0.6), 0, 1) * 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }) as THREE.DataTexture;
}

/* ------------------------------------------------------------------ */
/* Carved sign                                                         */
/* ------------------------------------------------------------------ */

export interface CarvedMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  displacementMap: THREE.Texture;
  aspect: number;
}

interface Sampler {
  (u: number, v: number): number;
}

function canvasSampler(data: ImageData): Sampler {
  const { width: w, height: hgt, data: px } = data;
  return (u: number, v: number) => {
    // Bilinear, clamped. Canvas rows run top-down; the geometry's V runs
    // bottom-up, so V is flipped here once and never thought about again.
    const x = clamp(u, 0, 1) * (w - 1);
    const y = (1 - clamp(v, 0, 1)) * (hgt - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(hgt - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const at = (xx: number, yy: number) => px[(yy * w + xx) * 4] / 255;
    return lerp(lerp(at(x0, y0), at(x1, y0), fx), lerp(at(x0, y1), at(x1, y1), fx), fy);
  };
}

function rectTexture(
  w: number,
  h: number,
  srgb: boolean,
  fn: (u: number, v: number) => [number, number, number],
): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    // DataTexture rows run bottom-up.
    const v = (j + 0.5) / h;
    for (let i = 0; i < w; i++) {
      const c = fn((i + 0.5) / w, v);
      const o = (j * w + i) * 4;
      data[o] = clamp(c[0], 0, 1) * 255;
      data[o + 1] = clamp(c[1], 0, 1) * 255;
      data[o + 2] = clamp(c[2], 0, 1) * 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Non-tiling Sobel normal bake over a rectangular height field. */
function rectNormal(w: number, h: number, height: Sampler, strength: number): THREE.DataTexture {
  const hs = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) hs[j * w + i] = height((i + 0.5) / w, (j + 0.5) / h);
  const at = (i: number, j: number) =>
    hs[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];

  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const dx =
        at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1) -
        (at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1));
      const dy =
        at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1) -
        (at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1));
      let nx = dx * strength;
      let ny = dy * strength;
      const len = Math.hypot(nx, ny, 1) || 1;
      nx /= len;
      ny /= len;
      const o = (j * w + i) * 4;
      data[o] = (nx * 0.5 + 0.5) * 255;
      data[o + 1] = (ny * 0.5 + 0.5) * 255;
      data[o + 2] = (1 / len) * 0.5 * 255 + 127.5;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export interface SignSpec {
  title: string;
  subtitle: string;
  /** Board aspect, width / height. */
  aspect: number;
  /** Painted letter colour. */
  ink: number;
  /** Board timber colour. */
  timber: number;
}

/**
 * Bakes a routed-and-painted signboard.
 *
 * The letters are drawn once into a canvas, blurred to give the router bit a
 * shoulder rather than a vertical wall, and then read back four times: as a
 * *displacement* map (so the lettering is real geometry on a subdivided panel),
 * as a normal map (so it lights correctly between displaced vertices), as an
 * albedo mask (painted letters over grain) and as a roughness mask (enamel on
 * the letters, weathered timber around them). Drawing text is the only sane way
 * to get readable glyphs; everything after that is a height field like any
 * other in this project.
 */
export function carvedSignMaps(key: string, spec: SignSpec): CarvedMaps {
  const W = 1024;
  const H = Math.round(W / spec.aspect);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
  c2d.fillStyle = '#000';
  c2d.fillRect(0, 0, W, H);

  // Routed border groove — drawn as a dark inset so it carves *in*.
  c2d.strokeStyle = '#000';
  c2d.lineWidth = 10;
  c2d.strokeRect(26, 26, W - 52, H - 52);
  c2d.strokeStyle = '#4a4a4a';
  c2d.lineWidth = 4;
  c2d.strokeRect(26, 26, W - 52, H - 52);

  c2d.textAlign = 'center';
  c2d.textBaseline = 'middle';
  c2d.fillStyle = '#fff';

  const titleSize = Math.round(H * 0.30);
  c2d.font = `700 ${titleSize}px "Trebuchet MS", "Verdana", "DejaVu Sans", sans-serif`;
  try {
    (c2d as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${Math.round(titleSize * 0.06)}px`;
  } catch {
    /* older engines simply render without tracking */
  }
  c2d.fillText(spec.title, W / 2, H * 0.36, W * 0.86);

  // Hairline rule between the two lines of copy.
  c2d.fillStyle = '#d8d8d8';
  c2d.fillRect(W * 0.24, H * 0.545, W * 0.52, 5);

  c2d.fillStyle = '#fff';
  const subSize = Math.round(H * 0.135);
  c2d.font = `600 ${subSize}px "Trebuchet MS", "Verdana", "DejaVu Sans", sans-serif`;
  try {
    (c2d as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '1px';
  } catch {
    /* ignore */
  }
  c2d.fillText(spec.subtitle, W / 2, H * 0.72, W * 0.84);

  const sharp = canvasSampler(c2d.getImageData(0, 0, W, H));

  // Blurred copy: the router shoulder.
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = W;
  blurCanvas.height = H;
  const b2d = blurCanvas.getContext('2d', { willReadFrequently: true })!;
  b2d.filter = 'blur(4px)';
  b2d.drawImage(canvas, 0, 0);
  b2d.filter = 'none';
  const soft = canvasSampler(b2d.getImageData(0, 0, W, H));

  const grain = (u: number, v: number) => timberHeight(u * 1.6, v * 0.5, 6);
  const height: Sampler = (u, v) => clamp(0.30 + soft(u, v) * 0.62 + grain(u, v) * 0.08, 0, 1);

  const maps: CarvedMaps = {
    map: cached(`prop.sign.${key}.albedo`, () =>
      rectTexture(W, H, true, (u, v) => {
        const letter = smoothstep(0.30, 0.72, sharp(u, v));
        const g = grain(u, v);
        const weather = tileableFbm(WOOD, u * 1.2 + 4, v * 1.2, 7, 3) * 0.5 + 0.5;
        const board = mixHex(0x3f2d1d, spec.timber, clamp(g * 1.2, 0, 1));
        const grey = hexToRgb(0xa79c8c);
        const wood: [number, number, number] = [
          lerp(board[0], grey[0], weather * 0.26),
          lerp(board[1], grey[1], weather * 0.26),
          lerp(board[2], grey[2], weather * 0.26),
        ];
        // The paint sits proud, so it catches the light and stays clean while
        // the timber around it silvers.
        const ink = mixHex(spec.ink, 0xffffff, 0.12 + weather * 0.16);
        return [
          lerp(wood[0], ink[0], letter),
          lerp(wood[1], ink[1], letter),
          lerp(wood[2], ink[2], letter),
        ];
      }),
    ),
    normalMap: cached(`prop.sign.${key}.normal`, () => rectNormal(W, H, height, 3.2)),
    roughnessMap: cached(`prop.sign.${key}.rough`, () =>
      rectTexture(W >> 1, H >> 1, false, (u, v) => {
        const letter = smoothstep(0.30, 0.72, sharp(u, v));
        const r = lerp(0.86, 0.42, letter);
        return [r, r, r];
      }),
    ),
    displacementMap: cached(`prop.sign.${key}.disp`, () =>
      rectTexture(W, H, false, (u, v) => {
        const d = soft(u, v);
        return [d, d, d];
      }),
    ),
    aspect: spec.aspect,
  };
  return maps;
}
