import * as THREE from 'three';
import {
  bakeColorMap,
  bakeNormalMap,
  bakeScalarMap,
  cached,
  cobbleMaps,
  dirtPathMaps,
  mixHex,
  paintedWoodMaps,
  tile,
  NOISE,
  type MaterialMaps,
} from '../core/TextureLab';
import { clamp, lerp, smoothstep, tileableFbm } from '../core/Noise';

/**
 * Building materials — the substance layer for the three Pallet Town exteriors.
 *
 * Two ideas drive this file.
 *
 *  1. **One bake, many tints.** `TextureLab.paintedWoodMaps` bakes its tint into
 *     the albedo, so naively asking for cream cladding, brown trim and blue trim
 *     costs nine 1k textures. Instead every set is baked once at the palette's
 *     brightest value and the building's colour arrives as `material.color`,
 *     which is a pure multiply — relative grain contrast survives exactly, and
 *     the whole town costs three bakes.
 *
 *  2. **Weathering is a shader, not a texture.** Grime rises from the ground and
 *     collects under the eaves at a *world* height, so it cannot live in a
 *     tiling map and it must not depend on how finely a wall happens to be
 *     tessellated. `weather()` patches a few lines into MeshStandard/Physical
 *     that read a shared noise map in world space: ground damp, eave soot,
 *     rain streaks, per-board paint jitter and a fine grain break-up. That last
 *     term is the one that guarantees no painted surface is ever a flat colour.
 */

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/** Base tints the shared map sets are baked at. Colours divide down from these. */
const WALL_BASE = 0xf6f1e8;
const TRIM_BASE = 0xf4efe6;

export const BPAL = {
  wallCream: 0xf0e3c8,
  /** Deeper ochre cream — derived from wall cream toward the dirt-path warm. */
  wallWarm: 0xe8d3a6,
  wallLab: 0xf4f1e6,
  trimWhite: 0xfaf3e4,
  trimWood: 0x8a5c3b,
  trimBlue: 0x3f6f9e,
  roofRed: 0xd0553f,
  /** Rival's roof — a warmer, lighter terracotta from a different tile batch. */
  roofRust: 0xd87c46,
  roofBlue: 0x4a86c4,
  /** Rival's joinery: a soft sage the other owner painted his cottage in. */
  trimSage: 0xa8b596,
  stone: 0xb8b3a8,
  metalZinc: 0x9fa6ab,
  metalBrass: 0xc9a24a,
  /** Fired clay, derived between the palette's wood trim and roof red. */
  brick: 0xb0705a,
  /** Player's front door — the palette's lab blue used as a cottage accent. */
  doorTeal: 0x3f6f9e,
  /** Rival's front door. */
  doorRed: 0xd0553f,
  room: 0x2b221b,
  glow: 0xffc98a,
} as const;

/**
 * Colour multiplier that takes a baked base tint to a target tint, then scales
 * it into the exposure the grade actually wants.
 *
 * The palette in the art bible describes how a surface should *look* in the
 * graded frame, not its albedo. Feeding `#f0e3c8` straight in as reflectance
 * puts a sunlit wall at ~1.05 linear, over PostFX's 1.02 bloom threshold, and
 * the whole building glows white and loses its hue. `k` is the reflectance
 * scale that brings a lit face to ~0.75 linear — bright, but with headroom for
 * the sun to still read as sun.
 */
function ratio(target: number, base: number, k: number): THREE.Color {
  const c = new THREE.Color(
    Math.min(1, ((target >> 16) & 255) / Math.max(1, (base >> 16) & 255)),
    Math.min(1, ((target >> 8) & 255) / Math.max(1, (base >> 8) & 255)),
    Math.min(1, (target & 255) / Math.max(1, base & 255)),
  );
  // The ratio is authored in sRGB byte space; the exposure scale is physical,
  // so it is applied to the linear working value THREE.Color already holds.
  return c.multiplyScalar(k);
}

/* ------------------------------------------------------------------ */
/* Shared map sets                                                     */
/* ------------------------------------------------------------------ */

/** Painted horizontal cladding, ~24 cm boards. World-scale UVs, 2 m tile. */
export function claddingMaps(): MaterialMaps {
  return cachedMaps('bldg.clad', () => tile(paintedWoodMaps('bldg-clad', WALL_BASE, 8, 1024), 0.5, 16));
}

/** Smooth painted joinery for trim, frames, doors and fascias. 4 m tile. */
export function joineryMaps(): MaterialMaps {
  return cachedMaps('bldg.trim', () => tile(paintedWoodMaps('bldg-trim', TRIM_BASE, 1, 512), 0.26, 16));
}

/** Deterministic 0..1 hash. Stands in for a per-tile random draw during a bake. */
function hash21(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Unequal course boundaries for a `rows`-course pantile bake.
 *
 * A roof laid by hand has courses of visibly different depth — the batten
 * spacing drifts a centimetre or two every row and the gauge is set by eye at
 * the eave. Quantising v by `floor(v * rows)` gives ten identical courses, and
 * ten identical courses at 45 cm is exactly what read as corrugated iron. This
 * returns cumulative edges in 0..1, so the bake still tiles with period 1 in v
 * while no two courses are the same depth.
 */
const rowEdgeCache = new Map<number, Float64Array>();
function rowEdges(rows: number): Float64Array {
  let e = rowEdgeCache.get(rows);
  if (e) return e;
  const w: number[] = [];
  let sum = 0;
  for (let i = 0; i < rows; i++) {
    const k = 0.74 + hash21(i * 3.17 + 1.9, 5.5) * 0.52;
    w.push(k);
    sum += k;
  }
  e = new Float64Array(rows + 1);
  let acc = 0;
  for (let i = 0; i < rows; i++) {
    acc += w[i] / sum;
    e[i + 1] = acc;
  }
  e[rows] = 1;
  rowEdgeCache.set(rows, e);
  return e;
}

/**
 * Clay pantiles, baked here rather than taken from TextureLab.
 *
 * The shared `roofTileMaps` lays a perfect grid: every course the same
 * thickness, every course offset exactly half a tile, every tile the same
 * height. At the scale these roofs are read that grid beats like corrugated
 * iron. Five jitters break it, all keyed off the course and tile index so the
 * bake stays deterministic:
 *
 *  - **unequal course depths** from `rowEdges`, the one that actually kills the
 *    corrugation, because it removes the constant vertical beat entirely;
 *  - **per-row skew** moves the crown of the roll up or down within its course;
 *  - **per-row lateral shift** on top of the half-tile stagger, because a
 *    hand-laid course never starts exactly above the one below;
 *  - **per-tile height and colour**, one tile in twenty slipped down its lap and
 *    one in eight fired darker than its neighbours;
 *  - **one tile in a hundred and twenty missing**, showing the dark felt and
 *    batten beneath — a couple per roof, which is what a tidy village looks like
 *    after a gale, not a ruin.
 */
function pantileField(u: number, v: number, rows: number) {
  const edges = rowEdges(rows);
  let ri = 0;
  while (ri < rows - 1 && v >= edges[ri + 1]) ri++;
  const rowT = (edges[ri + 1] - edges[ri]) * rows; // course depth, ~1
  const rf = (v - edges[ri]) / (edges[ri + 1] - edges[ri]);
  const rh = hash21(ri * 1.31 + 0.7, 7.3);
  const off = (ri % 2 === 0 ? 0 : 0.5) + (rh - 0.5) * 0.34;
  // Skew the roll profile: the crown sits anywhere from a third to two thirds
  // up the course, which is what makes the rows read as unequal.
  const skew = 0.5 + (rh - 0.5) * 0.54;
  const rs = rf < skew ? (rf / skew) * 0.5 : 0.5 + ((rf - skew) / (1 - skew)) * 0.5;
  const colF = u * rows + off;
  const ci = Math.floor(colF);
  const cf = colF - ci;
  const th = hash21(ci * 1.7 + 4.1, ri * 2.3 + 9.7);
  const slip = th > 0.95 ? 0.08 + (th - 0.95) * 2.4 : 0;
  const gone = th > 0.9917;
  const arch = Math.sin(Math.min(1, rs + slip) * Math.PI) * (0.68 + th * 0.58) * (0.82 + rowT * 0.2);
  const side = smoothstep(0.0, 0.11, cf) * smoothstep(1.0, 0.89, cf);
  const lap = smoothstep(0.15, 0.0, rs);
  return { arch, side, lap, ri, ci, th, rh, rowT, gone };
}

export function pantileMaps(rows: number, size = 1024): MaterialMaps {
  const key = `bldg.pantile.${rows}`;
  return {
    map: cached(`${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const { arch, side, lap, th, rh, rowT, gone } = pantileField(u, v, rows);
          const grime = tileableFbm(NOISE.stone, u, v, 16, 4) * 0.5 + 0.5;
          const fine = tileableFbm(NOISE.stone, u * 2 + 5, v * 2, 66, 3) * 0.5 + 0.5;
          const dark = clamp((1 - arch) * 0.42 + (1 - side) * 0.24 + lap * 0.5, 0, 1);
          const c = mixHex(0xffffff, 0x2a1c17, dark);
          // A gap in the courses: sarking felt and the top of a batten, not clay.
          if (gone) {
            const batten = smoothstep(0.34, 0.42, lap) * 0.5;
            const k = (0.1 + batten) * (0.8 + grime * 0.4);
            return [k * 1.02, k * 0.94, k * 0.88];
          }
          // Row band, tile jitter, one dark-fired tile in eight. Deeper courses
          // were struck from a wetter batch and fired a shade lighter.
          const k =
            (0.86 + rh * 0.28) *
            (0.79 + th * 0.44) *
            (0.9 + rowT * 0.12) *
            (th > 0.88 ? 0.66 : th < 0.1 ? 1.12 : 1) *
            (0.84 + grime * 0.26) *
            (0.93 + fine * 0.14);
          return [c[0] * k, c[1] * k, c[2] * k];
        },
      }),
    ),
    normalMap: cached(`${key}.normal`, () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const { arch, side, lap, th, rowT, gone } = pantileField(u, v, rows);
            if (gone) return clamp(0.03 + smoothstep(0.34, 0.42, lap) * 0.16, 0, 1);
            // rowT lifts deeper courses proudly over their shallower neighbours,
            // so the roof has a slow undulation across the slope as well as the
            // per-tile jitter.
            return clamp(arch * 0.72 * side + 0.1 + (rowT - 1) * 0.16 + th * 0.11 - lap * 0.15, 0, 1);
          },
        },
        2.4,
      ),
    ),
    roughnessMap: cached(`${key}.rough`, () =>
      bakeScalarMap(512, (u, v) => {
        const { arch, lap, gone } = pantileField(u, v, rows);
        if (gone) return 1;
        // Weather sits in the pans and along the laps, not on the crowns.
        return clamp(
          0.6 + (tileableFbm(NOISE.stone, u, v, 26, 3) * 0.5 + 0.5) * 0.2 + (1 - arch) * 0.12 + lap * 0.08,
          0,
          1,
        );
      }),
    ),
  };
}

/**
 * Pantiles at a given world scale. `repeat` is texture repeats per metre, so a
 * ten-course bake at 0.225 gives 44 cm courses — one tile size per building, and
 * two neighbours are never tiled by the same yard.
 *
 * The default used to be 0.28 (36 cm). Correct for a real pantile, wrong here:
 * at the distance these roofs are actually read the courses fell to two or three
 * pixels and the whole slope beat like corrugated iron. Going up to 44 cm costs
 * nothing and lets one tile occupy enough screen area for its own jitter to
 * register as a hand-laid roof.
 */
export function tileMaps(repeat = 0.225, rows = 10): MaterialMaps {
  return cachedMaps(`bldg.roof.${rows}.${repeat}`, () => tile(pantileMaps(rows, 1024), repeat, 16));
}

/** Coursed rubble for plinths and base courses. */
export function masonryMaps(): MaterialMaps {
  return cachedMaps('bldg.stone', () => tile(cobbleMaps(), 0.62, 16));
}

/**
 * The same rubble bake read at brick scale.
 *
 * A chimney sharing the plinth's stone is the fastest way to make a cottage
 * look like one extruded lump: the two forms are metres apart in the silhouette
 * and need to read as different substances. Tripling the tiling turns 30 cm
 * blocks into 11 cm bricks, and the tint below takes it from quarried grey to
 * fired clay, so the stack reads warm against a cream gable.
 */
export function brickMaps(): MaterialMaps {
  return cachedMaps('bldg.brick', () => tile(cobbleMaps(), 1.85, 16));
}

const mapCache = new Map<string, MaterialMaps>();
function cachedMaps(key: string, build: () => MaterialMaps): MaterialMaps {
  const hit = mapCache.get(key);
  if (hit) return hit;
  const m = build();
  mapCache.set(key, m);
  return m;
}

/* ------------------------------------------------------------------ */
/* Procedural textures owned by this file                              */
/* ------------------------------------------------------------------ */

/**
 * Three-channel weathering noise, read in world space by `weather()`.
 * R: fine grain. G: metre-scale blotches. B: high-frequency speckle.
 */
export function grimeTexture(): THREE.Texture {
  return cached('bldg.grime', () => {
    const t = bakeColorMap({
      size: 256,
      srgb: false,
      color: (u, v) => {
        const grain = tileableFbm(NOISE.paint, u, v, 26, 4) * 0.5 + 0.5;
        const blot = tileableFbm(NOISE.stone, u + 3.1, v, 6, 4) * 0.5 + 0.5;
        const speck = tileableFbm(NOISE.bark, u, v + 7.7, 64, 3) * 0.5 + 0.5;
        return [grain, blot, speck];
      },
    });
    t.anisotropy = 4;
    return t;
  });
}

/**
 * Interior atlas: four little rooms glimpsed through the glass.
 *
 * Windows that are simply dark are the single loudest "this is a model, not a
 * building" tell, so every opening gets a warm back panel with a lamp falloff,
 * a floor, and one piece of furniture in silhouette. Four variants, chosen per
 * window by the seeded rng, means no two rooms repeat side by side.
 */
/** Number of atlas cells per axis. `ROOM_COUNT` variants, indexed 0..15. */
export const ROOM_GRID = 4;
export const ROOM_COUNT = ROOM_GRID * ROOM_GRID;

/**
 * Lamp position, lamp strength and lamp colour per room. The lab's windows are
 * a regular grid of identical openings, so the *only* thing that can make them
 * read as sixteen different rooms is what is behind the glass: a bench lamp in
 * one corner, a cold monitor in another, one room with the blinds half down and
 * one with nobody in it at all.
 */
const ROOMS: { lx: number; ly: number; lit: number; warm: number }[] = [
  { lx: 0.32, ly: 0.3, lit: 1.0, warm: 1.0 }, // 0  bookshelf
  { lx: 0.7, ly: 0.22, lit: 1.1, warm: 1.05 }, // 1  hanging lamp + table
  { lx: 0.5, ly: 0.42, lit: 0.85, warm: 0.95 }, // 2  picture + curtain
  { lx: 0.24, ly: 0.34, lit: 0.95, warm: 1.0 }, // 3  kitchen jars
  { lx: 0.55, ly: 0.6, lit: 0.7, warm: 0.9 }, // 4  blinds half drawn
  { lx: 0.34, ly: 0.5, lit: 0.55, warm: 0.55 }, // 5  monitor (cold)
  { lx: 0.5, ly: 0.28, lit: 1.05, warm: 1.02 }, // 6  ball rack
  { lx: 0.72, ly: 0.4, lit: 0.9, warm: 1.0 }, // 7  potted plant
  { lx: 0.3, ly: 0.44, lit: 0.75, warm: 0.62 }, // 8  glassware bench (cold)
  { lx: 0.5, ly: 0.24, lit: 0.6, warm: 0.88 }, // 9  blinds nearly shut
  { lx: 0.5, ly: 0.36, lit: 1.0, warm: 1.08 }, // 10 drapes with a warm gap
  { lx: 0.66, ly: 0.3, lit: 0.6, warm: 0.85 }, // 11 stacked crates
  { lx: 0.28, ly: 0.26, lit: 0.85, warm: 0.9 }, // 12 wall chart
  { lx: 0.74, ly: 0.52, lit: 0.8, warm: 1.06 }, // 13 bed + bedside lamp
  { lx: 0.5, ly: 0.5, lit: 0.3, warm: 0.7 }, // 14 nobody home
  { lx: 0.4, ly: 0.32, lit: 0.9, warm: 0.98 }, // 15 tall cabinet
];

export function interiorAtlas(): THREE.Texture {
  return cached('bldg.room16', () => {
    const G = ROOM_GRID;
    const t = bakeColorMap({
      size: 1024,
      color: (u, v) => {
        const tx = Math.min(G - 1, Math.floor(u * G));
        const tyi = Math.min(G - 1, Math.floor(v * G));
        // Image row 0 is the top of the bake but v = 0 of a UV cell after the
        // upload flip, so the row index is mirrored to keep variant indices and
        // atlas cells in step with `fakeRoom`.
        const variant = (G - 1 - tyi) * G + tx;
        // lv = 0 is the top of the tile (ceiling).
        const lu = u * G - tx;
        const lv = v * G - tyi;
        const R = ROOMS[variant];

        const d = Math.hypot((lu - R.lx) * 0.9, (lv - R.ly) * 1.25);
        let glow = smoothstep(0.95, 0.02, d);
        glow = glow * glow * 0.92 * R.lit + 0.06;

        // Grubby plaster behind it.
        const n = tileableFbm(NOISE.paint, lu * 0.5 + variant, lv * 0.5, 9, 3) * 0.5 + 0.5;
        // Floor values, not zero: the darkest corner of the room still has to
        // sit above `#1a1614` once the emissive multiplies through, or the
        // window turns back into the black rectangle this atlas exists to kill.
        const cool = 1 - R.warm;
        let c: [number, number, number] = [
          lerp(0.22, 0.98, glow) * (0.85 + n * 0.3) * (1 - cool * 0.5),
          lerp(0.16, 0.78, glow) * (0.85 + n * 0.3) * (1 - cool * 0.12),
          lerp(0.12, 0.5, glow) * (0.85 + n * 0.3) * (1 + cool * 0.85),
        ];

        const shade = (k: number) => {
          c = [c[0] * k, c[1] * k, c[2] * k];
        };
        const add = (r: number, g: number, b: number) => {
          c = [c[0] + r, c[1] + g, c[2] + b];
        };
        const rect = (x0: number, x1: number, y0: number, y1: number) =>
          lu > x0 && lu < x1 && lv > y0 && lv < y1;

        // Floor / skirting.
        if (lv > 0.79) shade(lerp(1, 0.4, smoothstep(0.79, 0.9, lv)));
        // Ceiling shadow.
        if (lv < 0.12) shade(lerp(0.45, 1, smoothstep(0.0, 0.12, lv)));

        switch (variant) {
          case 0: {
            // Bookshelf: uprights and shelves.
            if (rect(0.52, 0.97, 0.2, 0.8)) {
              const shelf = Math.abs((((lv - 0.2) / 0.12) % 1) - 0.5) * 2;
              shade(shelf > 0.82 ? 0.28 : 0.42 + ((lu * 37) % 1) * 0.3);
            }
            break;
          }
          case 1: {
            if (Math.abs(lu - 0.7) < 0.012 && lv < 0.22) shade(0.22);
            if (Math.hypot((lu - 0.7) * 1.5, lv - 0.24) < 0.1) shade(1.35);
            if (rect(0.1, 0.45, 0.6, 0.78)) shade(0.4);
            break;
          }
          case 2: {
            if (rect(0.14, 0.38, 0.24, 0.5)) {
              const edge = Math.min(lu - 0.14, 0.38 - lu, lv - 0.24, 0.5 - lv);
              shade(edge < 0.025 ? 0.3 : 0.62);
            }
            if (lu > 0.86) shade(0.34 + (Math.sin(lu * 90) * 0.5 + 0.5) * 0.2);
            break;
          }
          case 3: {
            if (lv > 0.34 && lv < 0.38) shade(0.3);
            for (let i = 0; i < 4; i++) {
              if (Math.abs(lu - (0.16 + i * 0.2)) < 0.05 && lv > 0.2 && lv < 0.34) shade(0.45 + i * 0.12);
            }
            break;
          }
          case 4:
          case 9: {
            // Venetian blind, part drawn. Slats catch the sun on their upper
            // edge and shade the room below; the bottom rail is the give-away
            // that this is a blind and not a stripe pattern.
            const cut = variant === 4 ? 0.52 : 0.78;
            if (lv < cut) {
              const s = ((lv * (variant === 4 ? 26 : 30)) % 1);
              shade(s < 0.42 ? 0.5 : 1.18);
              shade(0.9);
            } else if (lv < cut + 0.035) {
              shade(0.3);
            } else if (rect(0.2, 0.8, cut + 0.1, cut + 0.2)) {
              shade(0.55); // whatever sits on the sill behind it
            }
            // Cords down each side.
            if (Math.abs(lu - 0.12) < 0.008 || Math.abs(lu - 0.88) < 0.008) {
              if (lv < cut + 0.14) shade(0.45);
            }
            break;
          }
          case 5: {
            // Monitor: a cold rectangle on a desk, the one cool light in town.
            if (rect(0.42, 0.86, 0.3, 0.56)) {
              const edge = Math.min(lu - 0.42, 0.86 - lu, lv - 0.3, 0.56 - lv);
              if (edge < 0.03) shade(0.2);
              else {
                shade(0.3);
                add(0.16, 0.34, 0.5);
                if (((lv * 40) % 1) < 0.4) add(0.05, 0.1, 0.14);
              }
            }
            if (rect(0.3, 0.95, 0.58, 0.68)) shade(0.34); // desk
            if (Math.hypot((lu - 0.6) * 1.2, lv - 0.6) < 0.045) shade(0.5);
            break;
          }
          case 6: {
            // A rack of balls on a shelf — three ranks, two rows.
            if (lv > 0.44 && lv < 0.475) shade(0.28);
            if (lv > 0.68 && lv < 0.715) shade(0.28);
            for (let row = 0; row < 2; row++) {
              const by = row === 0 ? 0.4 : 0.64;
              for (let i = 0; i < 3; i++) {
                const bx = 0.24 + i * 0.26;
                const dd = Math.hypot(lu - bx, (lv - by) * 1.02);
                if (dd < 0.058) {
                  if (lv < by - 0.004) {
                    shade(0.55);
                    add(0.3, 0.05, 0.05);
                  } else shade(1.15);
                  if (Math.abs(lv - by) < 0.008) shade(0.35);
                }
              }
            }
            break;
          }
          case 7: {
            // Potted plant on the sill: leaves fan out from a dark pot.
            if (rect(0.38, 0.62, 0.62, 0.76)) shade(0.4);
            for (let i = 0; i < 6; i++) {
              const a = -1.25 + i * 0.5;
              const lxp = 0.5 + Math.sin(a) * 0.19;
              const lyp = 0.62 - Math.cos(a) * 0.2;
              if (Math.hypot((lu - lxp) * 1.5, lv - lyp) < 0.075) {
                shade(0.42);
                add(0.05, 0.13, 0.03);
              }
            }
            break;
          }
          case 8: {
            // Glassware bench: three flasks with cold liquid in them.
            if (rect(0.08, 0.95, 0.56, 0.66)) shade(0.36);
            for (let i = 0; i < 3; i++) {
              const fx = 0.24 + i * 0.24;
              const fh = 0.2 + i * 0.05;
              const neck = Math.abs(lu - fx) < 0.022 && lv > 0.56 - fh && lv < 0.56 - fh * 0.45;
              const body = Math.hypot((lu - fx) * 1.25, lv - (0.56 - fh * 0.22)) < fh * 0.34;
              if (neck || body) {
                shade(0.8);
                add(0.02, 0.12, 0.14);
                if (body && lv > 0.56 - fh * 0.26) add(0.02, 0.2, 0.2);
              }
            }
            break;
          }
          case 10: {
            // Drapes pulled to, warm slot of light between them.
            const gap = Math.abs(lu - 0.5);
            if (gap > 0.07) {
              const fold = Math.sin((lu - 0.5) * 46) * 0.5 + 0.5;
              shade(0.34 + fold * 0.22);
            } else {
              shade(1.25);
              add(0.1, 0.05, 0.0);
            }
            break;
          }
          case 11: {
            // Stacked crates, stencil mark on the top one.
            if (rect(0.12, 0.56, 0.42, 0.78)) shade(rect(0.14, 0.54, 0.44, 0.76) ? 0.42 : 0.26);
            if (rect(0.5, 0.9, 0.54, 0.78)) shade(rect(0.52, 0.88, 0.56, 0.76) ? 0.5 : 0.28);
            if (rect(0.22, 0.44, 0.54, 0.6)) shade(0.7);
            break;
          }
          case 12: {
            // Wall chart with a route line on it.
            if (rect(0.16, 0.84, 0.18, 0.56)) {
              const edge = Math.min(lu - 0.16, 0.84 - lu, lv - 0.18, 0.56 - lv);
              shade(edge < 0.02 ? 0.3 : 1.1);
              if (edge >= 0.02 && Math.abs(lv - (0.34 + Math.sin(lu * 12) * 0.06)) < 0.012) shade(0.45);
            }
            break;
          }
          case 13: {
            // Bed with a headboard, and a lamp on the table beside it.
            if (rect(0.06, 0.62, 0.6, 0.82)) shade(0.62);
            if (rect(0.06, 0.2, 0.42, 0.62)) shade(0.34);
            if (rect(0.66, 0.84, 0.56, 0.72)) shade(0.4);
            if (Math.hypot((lu - 0.75) * 1.3, lv - 0.5) < 0.07) shade(1.3);
            break;
          }
          case 14: {
            // Nobody home: daylight from a far window, nothing else.
            if (rect(0.62, 0.92, 0.28, 0.58)) {
              shade(1.5);
              add(0.06, 0.09, 0.12);
            }
            break;
          }
          default: {
            // Tall cabinet with glazed doors.
            if (rect(0.52, 0.94, 0.18, 0.8)) {
              const edge = Math.min(lu - 0.52, 0.94 - lu, lv - 0.18, 0.8 - lv);
              shade(edge < 0.03 ? 0.24 : 0.5);
              if (edge >= 0.03 && Math.abs(lu - 0.73) < 0.012) shade(0.4);
              if (edge >= 0.03 && ((lv * 9) % 1) < 0.12) shade(0.6);
            }
            break;
          }
        }

        // Vignette so tiles never bleed a bright edge into their neighbour.
        const vig =
          smoothstep(0.0, 0.14, lu) * smoothstep(1.0, 0.86, lu) * smoothstep(0.0, 0.1, lv) * smoothstep(1.0, 0.9, lv);
        shade(lerp(0.62, 1, vig));

        return [clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1)];
      },
    });
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    return t;
  });
}

/**
 * Streak and blotch masks for the stain decals, side by side in one texture:
 * u < 0.5 is rain running down a wall, u > 0.5 is moss sitting in a valley.
 * Only the green channel is read (three samples `alphaMap.g`); hue comes from
 * the decal's vertex colour, so water stains and moss share one material and
 * one draw call.
 */
export function stainMasks(): THREE.Texture {
  return cached('bldg.stain', () => {
    const t = bakeColorMap({
      size: 512,
      srgb: false,
      color: (u, v) => {
        let a: number;
        if (u < 0.5) {
          const su = u * 2;
          const wob = tileableFbm(NOISE.stone, su, v, 3, 2) * 0.05;
          // Constant second argument: the noise becomes pure vertical streaks,
          // which is exactly how water leaves a wall.
          const s0 = tileableFbm(NOISE.paint, su + wob, 0.13, 20, 3) * 0.5 + 0.5;
          const s1 = tileableFbm(NOISE.paint, su * 0.5, 0.61, 6, 2) * 0.5 + 0.5;
          const grain = tileableFbm(NOISE.bark, su, v, 70, 2) * 0.5 + 0.5;
          a = clamp((s0 * 0.8 + s1 * 0.45 - 0.42) * 1.8, 0, 1) * (0.6 + grain * 0.55);
        } else {
          const bu = (u - 0.5) * 2;
          const b = tileableFbm(NOISE.stone, bu, v, 6, 4) * 0.5 + 0.5;
          const fleck = tileableFbm(NOISE.bark, bu, v, 30, 3) * 0.5 + 0.5;
          a = clamp((b - 0.46) * 3.2, 0, 1) * (0.45 + fleck * 0.7);
        }
        return [a, a, a];
      },
    });
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    return t;
  });
}

/** Gathered net curtain — brightness folds plus an open lace weave. */
export function curtainTexture(): THREE.Texture {
  return cached('bldg.curtain.map', () =>
    bakeColorMap({
      size: 256,
      color: (u, v) => {
        const fold = Math.sin(u * Math.PI * 2 * 6 + tileableFbm(NOISE.fabric, u, v, 4, 2) * 2) * 0.5 + 0.5;
        const weave = (Math.sin(u * Math.PI * 2 * 64) * 0.5 + 0.5) * (Math.sin(v * Math.PI * 2 * 64) * 0.5 + 0.5);
        const k = 0.72 + fold * 0.26 - weave * 0.08;
        return [k * 0.99, k * 0.97, k * 0.93];
      },
    }),
  );
}

export function curtainAlpha(): THREE.Texture {
  return cached('bldg.curtain.alpha', () =>
    bakeColorMap({
      size: 256,
      srgb: false,
      color: (u, v) => {
        const fold = Math.sin(u * Math.PI * 2 * 6 + tileableFbm(NOISE.fabric, u, v, 4, 2) * 2) * 0.5 + 0.5;
        const weave = (Math.sin(u * Math.PI * 2 * 48) * 0.5 + 0.5) * (Math.sin(v * Math.PI * 2 * 48) * 0.5 + 0.5);
        const a = clamp(0.42 + fold * 0.44 - weave * 0.22, 0, 1);
        return [a, a, a];
      },
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Weathering injection                                                */
/* ------------------------------------------------------------------ */

export interface WeatherOptions {
  /** World Y of the ground line — damp and splash-back rise from here. */
  baseY: number;
  /** World Y of the eaves — soot and cobweb shade collects under here. */
  eaveY: number;
  /** Overall dirt strength, 0..1. */
  strength?: number;
  /** Height of one cladding board, for per-board paint jitter. 0 disables. */
  boardH?: number;
}

const WEATHER_VERT_HEAD = /* glsl */ `varying vec3 vBldgW;`;
const WEATHER_FRAG_HEAD = /* glsl */ `
varying vec3 vBldgW;
uniform sampler2D uGrimeMap;
uniform vec4 uGrimeA;   // baseY, eaveY, strength, boardH
`;

const WEATHER_BODY = /* glsl */ `
{
  vec3 wp = vBldgW;
  // Vertically stretched lookup: rain runs down, so the noise must too.
  float streak = texture2D( uGrimeMap, vec2( ( wp.x + wp.z ) * 0.42, wp.y * 0.055 ) ).r;
  vec4 blot = texture2D( uGrimeMap, vec2( wp.x * 0.11 - wp.z * 0.09, wp.y * 0.10 ) );
  float grain = texture2D( uGrimeMap, vec2( wp.x * 1.9 + wp.z * 0.7, wp.y * 1.9 ) ).b;

  float ground = smoothstep( uGrimeA.x + 1.25, uGrimeA.x + 0.01, wp.y );
  float eave   = smoothstep( uGrimeA.y - 1.55, uGrimeA.y - 0.02, wp.y );

  // Rain-splash spatter: the bottom half metre of a wall is not evenly dirty,
  // it is flecked where drops came back off the ground.
  float splash = smoothstep( uGrimeA.x + 0.6, uGrimeA.x + 0.015, wp.y );
  splash *= smoothstep( 0.42, 0.85, grain ) * 0.75;

  float dirt = ground * ( 0.34 + streak * 0.52 + blot.g * 0.34 ) + splash
             + eave   * ( 0.26 + blot.g * 0.44 );
  dirt = clamp( dirt, 0.0, 1.0 ) * uGrimeA.z;

  // Damp, cool grey-green at the foot; warm soot under the eaves.
  vec3 soil = mix( vec3( 0.55, 0.56, 0.50 ), vec3( 0.62, 0.58, 0.52 ), eave );
  diffuseColor.rgb *= mix( vec3( 1.0 ), soil, dirt );

  // Per-board paint jitter: quantise world height into courses and shift the
  // value of each one. Hand-painted boards are never one flat colour.
  if ( uGrimeA.w > 0.0 ) {
    float board = floor( wp.y / uGrimeA.w );
    float j = fract( sin( board * 12.9898 + 4.1414 ) * 43758.5453 );
    diffuseColor.rgb *= 0.955 + j * 0.09;
  }

  // Fine grain + metre-scale sun bleaching. Guarantees no flat colour anywhere.
  diffuseColor.rgb *= 0.925 + grain * 0.115;
  diffuseColor.rgb *= mix( 0.955, 1.045, blot.r );
  roughnessFactor = clamp( roughnessFactor * ( 1.0 + dirt * 0.35 - grain * 0.08 ), 0.05, 1.0 );
}
`;

/**
 * Patches world-space weathering into a standard/physical material.
 * Safe to call on any number of materials — they share one program.
 */
export function weather(mat: THREE.MeshStandardMaterial, opts: WeatherOptions): void {
  const grime = grimeTexture();
  const params = new THREE.Vector4(
    opts.baseY,
    opts.eaveY,
    opts.strength ?? 1,
    opts.boardH ?? 0,
  );
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrimeMap = { value: grime };
    shader.uniforms.uGrimeA = { value: params };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WEATHER_VERT_HEAD}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvBldgW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WEATHER_FRAG_HEAD}`)
      // Roughness is resolved before lighting; hook in after it so the grime
      // can push both albedo and roughness in one place.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${WEATHER_BODY}`);
  };
  mat.customProgramCacheKey = () => 'bldg-weather-v2';
}

/* ------------------------------------------------------------------ */
/* Material factories                                                  */
/* ------------------------------------------------------------------ */

function standard(maps: MaterialMaps, color: THREE.Color, roughness: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color,
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness,
    metalness: 0,
    envMapIntensity: 0.95,
    dithering: true,
  });
  m.normalScale.set(1.0, 1.0);
  return m;
}

export function wallMaterial(tint: number, w: WeatherOptions): THREE.MeshStandardMaterial {
  const m = standard(claddingMaps(), ratio(tint, WALL_BASE, 0.6), 0.88);
  m.normalScale.set(1.15, 1.15);
  weather(m, { ...w, boardH: 0.25 });
  return m;
}

export function trimMaterial(tint: number, w: WeatherOptions): THREE.MeshStandardMaterial {
  const m = standard(joineryMaps(), ratio(tint, TRIM_BASE, 0.66), 0.82);
  m.normalScale.set(0.7, 0.7);
  weather(m, { ...w, strength: (w.strength ?? 1) * 0.8 });
  return m;
}

export function roofMaterial(tint: number, w: WeatherOptions, repeat = 0.225): THREE.MeshPhysicalMaterial {
  const maps = tileMaps(repeat);
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(tint).multiplyScalar(0.82),
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    roughness: 0.92,
    metalness: 0,
    clearcoat: 0.15,
    clearcoatRoughness: 0.55,
    envMapIntensity: 1.0,
    dithering: true,
  });
  m.normalScale.set(2.1, 2.1);
  // Roofs weather from the top down: the ridge bleaches, the eaves grow moss.
  weather(m, { ...w, strength: (w.strength ?? 1) * 0.9 });
  return m;
}

/**
 * Warm limestone for plinths, sills, thresholds and the lab's base course.
 *
 * The multiplier is above 1 on purpose. The cobble bake averages ~0.40 linear
 * before any tint, so feeding the palette's `#b8b3a8` in as a plain colour
 * lands the plinth near 0.17 — wet slate, not stone, and it printed as a black
 * band under every wall. Scaling back up puts a sunlit plinth at ~0.27 linear:
 * clearly darker than the cream cladding above it, never a silhouette hole.
 */
export function stoneMaterial(w: WeatherOptions): THREE.MeshStandardMaterial {
  // The shared cobble bake is a cool quarried grey; the bible's stone is warm,
  // and a cold plinth under a cream wall reads as concrete.
  const m = standard(masonryMaps(), new THREE.Color(BPAL.stone).multiplyScalar(1.3), 0.95);
  m.color.r *= 1.1;
  m.color.g *= 1.0;
  m.color.b *= 0.86;
  m.normalScale.set(1.35, 1.35);
  weather(m, { ...w, strength: (w.strength ?? 1) * 1.05 });
  return m;
}

/** Fired-clay brick for the chimney stacks. */
export function brickMaterial(w: WeatherOptions): THREE.MeshStandardMaterial {
  const m = standard(brickMaps(), new THREE.Color(BPAL.brick).multiplyScalar(1.22), 0.94);
  m.normalScale.set(1.5, 1.5);
  weather(m, { ...w, strength: (w.strength ?? 1) * 1.2 });
  return m;
}

/**
 * Front-door paint: the one saturated accent on each cottage.
 *
 * Gloss is the point. Every other painted surface in the town is a chalky
 * 0.8-roughness distemper, so dropping the door to 0.42 gives it a highlight
 * nothing else has and pulls the eye straight to the entrance — which is what
 * a front door is for.
 */
export function doorMaterial(tint: number, w: WeatherOptions): THREE.MeshStandardMaterial {
  const m = standard(joineryMaps(), ratio(tint, TRIM_BASE, 0.78), 0.42);
  m.normalScale.set(0.45, 0.45);
  m.envMapIntensity = 1.25;
  weather(m, { ...w, strength: (w.strength ?? 1) * 0.45 });
  return m;
}

export function metalMaterial(): THREE.MeshStandardMaterial {
  const maps = joineryMaps();
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(BPAL.metalZinc).multiplyScalar(0.72),
    normalMap: maps.normalMap,
    roughness: 0.34,
    metalness: 0.88,
    envMapIntensity: 1.25,
  });
  m.normalScale.set(0.35, 0.35);
  return m;
}

export function glassMaterial(): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xdff0f2),
    metalness: 0,
    roughness: 0.07,
    transmission: 0.94,
    thickness: 0.04,
    ior: 1.5,
    specularIntensity: 1,
    envMapIntensity: 1.6,
    side: THREE.FrontSide,
  });

  // Faked sky reflection. The PMREM alone gives glass a dim grey sheen at this
  // environment intensity; real window glass at a glancing angle is almost a
  // mirror of the sky above it, and that bright rake is the single cue that
  // separates "glazed opening" from "hole with a picture in it". Fresnel-driven
  // so the reflection only takes over where the room behind is invisible
  // anyway, which means it never fights the interior.
  const uSkyLo = { value: new THREE.Color(0xbfe0f2).convertSRGBToLinear() };
  const uSkyHi = { value: new THREE.Color(0x6f9fdc).convertSRGBToLinear() };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyLo = uSkyLo;
    shader.uniforms.uSkyHi = uSkyHi;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uSkyLo;\nuniform vec3 uSkyHi;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 V = normalize( vViewPosition );
  float F = pow( clamp( 1.0 - max( dot( normal, V ), 0.0 ), 0.0, 1.0 ), 4.0 );
  // Reflected ray back into world space; its height picks the sky gradient.
  vec3 Rw = ( vec4( reflect( -V, normal ), 0.0 ) * viewMatrix ).xyz;
  vec3 sky = mix( uSkyLo, uSkyHi, clamp( Rw.y * 1.4 + 0.12, 0.0, 1.0 ) );
  totalEmissiveRadiance += sky * ( 0.055 + F * 0.62 );
}`,
      );
  };
  m.customProgramCacheKey = () => 'pallet-glass-v2';
  return m;
}

/**
 * The lit back wall of a faked room. Emissive does all the work: no light
 * reaches inside a sealed box, and a window that reads darker than its own
 * frame is the thing that makes a building look like a prop.
 */
/**
 * Emissive is not affected by vertex colour in the standard shader, which would
 * make per-window tinting invisible on exactly the term that carries the light.
 * One line after the emissive map fixes that, and lets every window in town
 * carry its own lamp brightness and warmth in two floats of vertex data.
 */
function tintEmissiveByVertexColor(m: THREE.MeshStandardMaterial, cacheKey: string): void {
  m.vertexColors = true;
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
#ifdef USE_COLOR
  totalEmissiveRadiance *= vColor.rgb;
#endif`,
    );
  };
  m.customProgramCacheKey = () => cacheKey;
}

export function roomBackMaterial(): THREE.MeshStandardMaterial {
  const tex = interiorAtlas();
  const m = new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: new THREE.Color(0xffd9b0),
    // No light reaches a sealed box, so emissive is the whole budget here. At
    // 0.26 the rooms sat below the shaded side of the cladding and every window
    // in town read as a punched black rectangle — the exact defect the atlas
    // exists to prevent. 0.92 puts the lamp hotspot a touch under a sunlit
    // cream wall: unmistakably a lit room, still clearly recessed, and still
    // well under the bloom threshold so the town does not read as night.
    emissiveIntensity: 0.92,
    color: new THREE.Color(0x8b7458),
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.4,
  });
  tintEmissiveByVertexColor(m, 'pallet-roomback-v1');
  return m;
}

export function roomShellMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(BPAL.room),
    // The reveal walls of the room box. They are lit only by the same fake
    // lamp, so they carry their own emissive — brighter near the glass would be
    // wrong, but a dead-flat dark shell turns the recess into a black frame
    // around the back panel and undoes the effect.
    emissive: new THREE.Color(0xffc98e),
    emissiveIntensity: 0.7,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.35,
    side: THREE.BackSide,
  });
  tintEmissiveByVertexColor(m, 'pallet-roomshell-v1');
  return m;
}

/**
 * Water staining and moss, as vertex-tinted decals.
 *
 * A tidy village still shows where the water goes: a grey-brown fan under every
 * sill, a long streak where a gutter joint weeps, a splash line at the foot of
 * the wall, and moss in the one roof valley the sun never reaches. All of it is
 * one alpha-masked material — hue and strength live in the vertex colour — so
 * the whole town's weathering costs a single draw call.
 */
export function stainMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xffffff),
    alphaMap: stainMasks(),
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.45,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -5,
    side: THREE.DoubleSide,
  });
}

/**
 * Lamp glass for the carriage lanterns either side of the lab doors.
 * Emissive only — the bible caps the scene at five lights, so a lantern is
 * geometry that glows, never a light source.
 */
export function lampGlassMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0xf6e2b8),
    emissive: new THREE.Color(0xffdca6),
    emissiveIntensity: 0.55,
    roughness: 0.28,
    metalness: 0,
    transparent: true,
    opacity: 0.86,
    envMapIntensity: 1.4,
  });
}

export function curtainMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: curtainTexture(),
    alphaMap: curtainAlpha(),
    color: new THREE.Color(0xd8cbb4),
    // Alpha-tested, not blended, and deliberately so: the glass in front is a
    // transmissive material, and three renders the transmission buffer from the
    // opaque pass only. A blended curtain is therefore invisible through its own
    // window. Cutout keeps it in the opaque pass where the glass can see it.
    alphaTest: 0.42,
    depthWrite: true,
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
    // Sealed box again: without emissive the curtain is a black rag.
    emissive: new THREE.Color(0xffd9ab),
    emissiveIntensity: 0.62,
    envMapIntensity: 0.35,
  });
}

/** Dirt scuff decal skirting the base of each building. Vertex-alpha driven. */
export function skirtMaterial(): THREE.MeshStandardMaterial {
  const dirt = tile(dirtPathMaps(), 0.35, 8);
  return new THREE.MeshStandardMaterial({
    map: dirt.map,
    normalMap: dirt.normalMap,
    color: new THREE.Color(0xb59a7c),
    roughness: 1,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -6,
    envMapIntensity: 0.6,
  });
}
