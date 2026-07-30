import * as THREE from 'three';
import { Simplex, tileableFbm, worley, clamp, smoothstep, lerp, makeRng } from '../core/Noise';
import {
  bakeColorMap,
  bakeNormalMap,
  bakeScalarMap,
  cached,
  mixHex,
  hexToRgb,
  type MaterialMaps,
} from '../core/TextureLab';

/**
 * LabMaterials — the procedural substance library for Oak's laboratory interior.
 *
 * The exterior of the town is painted timber, clay tile and turf; an interior
 * has to read as a completely different set of materials or the transition
 * feels like walking into a photograph of the outside. Everything here is
 * baked through TextureLab's primitives so the noise basis and the bake path
 * stay identical to the rest of the game, but the substances — glazed floor
 * tile, trowelled plaster, beadboard, walnut, brushed steel, book cloth,
 * laboratory glass — are unique to this room.
 *
 * All UVs in the interior are world-metre box projections, so every map here is
 * authored with a one-metre period unless noted.
 */

/* ------------------------------------------------------------------ */
/* Noise bases                                                         */
/* ------------------------------------------------------------------ */

const N = {
  plaster: new Simplex(51501),
  wood: new Simplex(88117),
  tile: new Simplex(33019),
  cloth: new Simplex(90041),
  leaf: new Simplex(61627),
  metal: new Simplex(20916),
  paper: new Simplex(70304),
};

/* ------------------------------------------------------------------ */
/* Canvas helper (for the drawn content maps: screen, whiteboard)      */
/* ------------------------------------------------------------------ */

function drawnTexture(
  key: string,
  size: number,
  draw: (c: CanvasRenderingContext2D, s: number) => void,
  srgb = true,
): THREE.Texture {
  return cached(key, () => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d')!;
    draw(c, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Floor — waxed oak basket-weave parquet                              */
/* ------------------------------------------------------------------ */

/**
 * The floor is the single largest surface in the room and therefore sets its
 * temperature. A pale institutional tile made the lab read cold and, worse,
 * made the floor the brightest thing in frame — which is fatal when the whole
 * scene is supposed to funnel the eye onto the starter table. Waxed oak
 * parquet solves both: mid-tone warm albedo that sits below the table in
 * luminance, and a waxed sheen that catches the pendant and the window shafts
 * so the lighting actually reads on the ground plane.
 *
 * Layout is a basket weave — square blocks of four fingers, orientation
 * alternating with block parity. It tiles exactly, has no visible repeat
 * rhythm at eye level, and gives every finger its own tone and grain phase.
 */
const PQ_BLOCKS = 2; // blocks per texture period
const PQ_FINGERS = 4; // fingers per block

function parquetCell(u: number, v: number) {
  const p = u * PQ_BLOCKS;
  const q = v * PQ_BLOCKS;
  const ci = Math.floor(p);
  const cj = Math.floor(q);
  const fu = p - ci;
  const fv = q - cj;
  const horiz = ((ci + cj) & 1) === 0;
  // `across` runs perpendicular to the fingers, `along` down their length.
  const across = horiz ? fv : fu;
  const along = horiz ? fu : fv;
  const fi = Math.floor(across * PQ_FINGERS);
  const ff = across * PQ_FINGERS - fi;

  // Seams: the gap between fingers is tighter than the gap between blocks.
  const seamF = 1 - smoothstep(0.0, 0.055, Math.min(ff, 1 - ff));
  const seamB = 1 - smoothstep(0.0, 0.018, Math.min(along, 1 - along));
  const seam = Math.max(seamF, seamB * 1.15);
  // Slight cupping across each finger so the wax highlight breaks up.
  const cup = Math.sin(ff * Math.PI);

  const rng = makeRng((((ci & 31) << 10) | ((cj & 31) << 5) | (fi & 31)) + 4409);
  const id = rng();
  const phase = rng() * 7.3;
  return { seam, cup, id, phase, along, across, horiz, fi, ci, cj };
}

/** Cathedral figure running down the length of a single parquet finger. */
function parquetGrain(t: ReturnType<typeof parquetCell>, u: number, v: number) {
  const s = t.horiz ? u : v;
  const rings = Math.abs(Math.sin((s * 46 + t.phase * 3.1 + t.id * 5) * Math.PI));
  const fig = smoothstep(0.05, 0.75, rings);
  const fibre = tileableFbm(N.wood, u * 1.6 + t.phase, v * 1.6, 150, 2) * 0.5 + 0.5;
  return { fig, fibre };
}

export function labFloorMaps(size = 1024): MaterialMaps {
  return {
    map: cached('lab.floor.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = parquetCell(u, v);
          const g = parquetGrain(t, u, v);
          // Per-finger tone: some boards were cut from heartwood, some sap.
          const tone = clamp(0.24 + t.id * 0.62 + g.fig * 0.3 + g.fibre * 0.18, 0, 1);
          const c = mixHex(0x6a4527, 0xbd8f56, tone);
          // Broad wear/polish across the room: traffic lanes lift the value,
          // the corners keep a little more of the original dark oil.
          const traffic = tileableFbm(N.wood, u * 0.35 + 9, v * 0.35, 2.4, 3) * 0.5 + 0.5;
          const k = 0.86 + traffic * 0.26;
          // Seams read as a dark line of old wax, never as pure black.
          const seamC = mixHex(0x2c1d12, 0x50361f, t.id);
          return [
            lerp(c[0] * k, seamC[0], t.seam * 0.9),
            lerp(c[1] * k, seamC[1], t.seam * 0.9),
            lerp(c[2] * k, seamC[2], t.seam * 0.9),
          ];
        },
      }),
    ),
    normalMap: cached('lab.floor.normal', () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const t = parquetCell(u, v);
            const g = parquetGrain(t, u, v);
            // Each finger sits a hair proud or shy of its neighbours, which is
            // what makes a waxed parquet's highlight wobble as you walk.
            const lie = (t.id - 0.5) * 0.1;
            return clamp(
              0.66 + lie + t.cup * 0.06 + g.fig * 0.035 + g.fibre * 0.05 - t.seam * 0.62,
              0,
              1,
            );
          },
        },
        1.9,
      ),
    ),
    roughnessMap: cached('lab.floor.rough', () =>
      bakeScalarMap(512, (u, v) => {
        const t = parquetCell(u, v);
        const g = parquetGrain(t, u, v);
        // Wax is glossy; the open grain of the figure drinks it and stays matt.
        const scuff = tileableFbm(N.wood, u * 0.8 + 3, v * 0.8, 7, 3) * 0.5 + 0.5;
        return clamp(0.2 + (1 - g.fig) * 0.16 + scuff * 0.18 + t.seam * 0.5, 0.12, 1);
      }),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Contact shading                                                     */
/* ------------------------------------------------------------------ */

/**
 * A soft dark blob used as a multiply decal where furniture meets the floor.
 *
 * Only the pendant over the starter table casts a real shadow — three shadow
 * maps for a room this wide would either be coarse enough to crawl or expensive
 * enough to matter. Ambient occlusion at the contact line is what the eye
 * actually reads as "this object is standing on the floor" (ART_DIRECTION §9),
 * and a decal delivers it at one draw call for the whole room.
 */
export function contactTexture(): THREE.Texture {
  return drawnTexture(
    'lab.contact',
    128,
    (c, s) => {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, s, s);
      const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0.0, 'rgba(58,44,34,1)');
      g.addColorStop(0.34, 'rgba(96,76,60,1)');
      g.addColorStop(0.62, 'rgba(184,168,152,1)');
      g.addColorStop(0.86, 'rgba(240,236,231,1)');
      g.addColorStop(1.0, 'rgba(255,255,255,1)');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    },
    false,
  );
}

/* ------------------------------------------------------------------ */
/* Walls — trowelled plaster                                           */
/* ------------------------------------------------------------------ */

export function labPlasterMaps(key: string, tint: number, size = 512): MaterialMaps {
  const h = (u: number, v: number) => {
    const trowel = tileableFbm(N.plaster, u * 0.9, v * 2.4, 9, 4);
    const grit = tileableFbm(N.plaster, u + 3, v, 120, 2);
    return clamp(0.55 + trowel * 0.34 + grit * 0.1, 0, 1);
  };
  return {
    map: cached(`lab.plaster.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const blotch = tileableFbm(N.plaster, u * 0.6 + 8, v * 0.6, 4, 3) * 0.5 + 0.5;
          const c = mixHex(tint, 0xfffaf0, t * 0.2 + blotch * 0.12);
          const dirt = smoothstep(0.62, 0.05, t) * 0.1;
          return [c[0] * (1 - dirt), c[1] * (1 - dirt * 0.92), c[2] * (1 - dirt * 0.82)];
        },
      }),
    ),
    normalMap: cached(`lab.plaster.${key}.normal`, () => bakeNormalMap({ size, height: h }, 0.95)),
    roughnessMap: cached(`lab.plaster.${key}.rough`, () =>
      bakeScalarMap(256, (u, v) => clamp(0.74 + (h(u, v) - 0.5) * 0.2, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Beadboard wainscot                                                  */
/* ------------------------------------------------------------------ */

/** Vertical tongue-and-groove boards, 12 cm pitch, with a bead at each seam. */
export function beadboardMaps(key: string, tint: number, size = 512): MaterialMaps {
  const pitch = 8; // boards per metre-period => 12.5 cm boards
  const profile = (u: number) => {
    const p = u * pitch;
    const f = p - Math.floor(p);
    // groove at the seam, small bead just beside it
    const groove = 1 - smoothstep(0.0, 0.055, Math.min(f, 1 - f));
    const bead = Math.exp(-((f - 0.11) * (f - 0.11)) / 0.0014);
    return { groove, bead, board: Math.floor(p) };
  };
  const h = (u: number, v: number) => {
    const { groove, bead } = profile(u);
    const grain = tileableFbm(N.wood, u * 0.5, v * 3.0, 44, 3);
    return clamp(0.66 - groove * 0.6 + bead * 0.16 + grain * 0.06, 0, 1);
  };
  return {
    map: cached(`lab.bead.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const { groove, bead, board } = profile(u);
          const rng = makeRng(board * 7717 + 13);
          const jitter = 0.9 + rng() * 0.2;
          const grain = tileableFbm(N.wood, u * 0.5, v * 3.0, 44, 3) * 0.5 + 0.5;
          const wear = tileableFbm(N.plaster, u, v, 6, 3) * 0.5 + 0.5;
          const c = mixHex(tint, 0xffffff, grain * 0.12 + wear * 0.14);
          const k = jitter * (1 - groove * 0.4) * (1 + bead * 0.06);
          return [c[0] * k, c[1] * k, c[2] * k];
        },
      }),
    ),
    normalMap: cached(`lab.bead.${key}.normal`, () => bakeNormalMap({ size, height: h }, 2.4)),
    roughnessMap: cached(`lab.bead.${key}.rough`, () =>
      bakeScalarMap(256, (u, v) => {
        const { groove } = profile(u);
        const wear = tileableFbm(N.plaster, u, v, 9, 3) * 0.5 + 0.5;
        return clamp(0.44 + wear * 0.18 + groove * 0.2, 0, 1);
      }),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Furniture timber                                                    */
/* ------------------------------------------------------------------ */

/**
 * Solid hardwood with cathedral grain, growth rings and the occasional knot.
 * Distinct from the exterior's `paintedWoodMaps`, which is opaque paint over
 * plank seams — this is oiled timber where the figure is the material.
 */
export function hardwoodMaps(key: string, dark: number, light: number, scale = 1, size = 512): MaterialMaps {
  const grain = (u: number, v: number) => {
    // A *little* warp so the rings drift instead of running dead straight. Any
    // more than a few percent of the ring pitch and the figure stops reading as
    // timber and starts reading as marble.
    // Ring pitch is *modulated*, not constant: an unmodulated sine reads as
    // corrugated iron the moment the camera gets within a metre.
    const drift = tileableFbm(N.wood, u * 0.4, v * 0.5, 2.6, 3) * 2.6;
    const r = v * scale * 24.0 + drift;
    const s = Math.abs(Math.sin(r * Math.PI));
    const rings = smoothstep(0.04, 0.7, s);
    const fibre = tileableFbm(N.wood, u * 0.3, v * 3.2, 46, 2) * 0.5 + 0.5;
    const knot = smoothstep(0.9, 1.0, tileableFbm(N.wood, u * 1.1 + 11, v * 1.1, 2.6, 2) * 0.5 + 0.5);
    // Open pores: short dashes lying along the grain. Without them an oiled
    // hardwood at arm's length is a smooth brown gradient, and the starter
    // table is the one surface in the game the player will stare at.
    const poreN = tileableFbm(N.wood, u * 0.22 + 5, v * 9.5, 190, 2) * 0.5 + 0.5;
    const pore = smoothstep(0.62, 0.9, poreN) * smoothstep(0.02, 0.36, s);
    return { rings, fibre, knot, pore };
  };
  return {
    map: cached(`lab.wood.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const g = grain(u, v);
          const t = clamp(g.rings * 0.52 + g.fibre * 0.48, 0, 1);
          const c = mixHex(dark, light, t);
          const k = (1 - g.knot * 0.34) * (1 - g.pore * 0.22);
          return [c[0] * k, c[1] * k, c[2] * k];
        },
      }),
    ),
    normalMap: cached(`lab.wood.${key}.normal`, () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const g = grain(u, v);
            return clamp(
              0.62 + g.rings * 0.1 + g.fibre * 0.08 - g.knot * 0.18 - g.pore * 0.34,
              0,
              1,
            );
          },
        },
        0.62,
      ),
    ),
    roughnessMap: cached(`lab.wood.${key}.rough`, () =>
      bakeScalarMap(384, (u, v) => {
        const g = grain(u, v);
        // Pores hold oil and stay matt — that contrast is what sells "polished
        // solid timber" over "brown plastic" under a single hero light.
        return clamp(0.3 + (1 - g.rings) * 0.14 + g.knot * 0.16 + g.pore * 0.3, 0, 1);
      }),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Painted trim                                                        */
/* ------------------------------------------------------------------ */

/** Thick oil paint over timber — skirting, cornice, window frames, doors. */
export function paintedTrimMaps(key: string, tint: number, size = 384): MaterialMaps {
  const h = (u: number, v: number) => {
    const brush = tileableFbm(N.plaster, u * 0.4, v * 3.2, 26, 3);
    const orange = tileableFbm(N.plaster, u * 4 + 2, v * 4, 60, 2);
    return clamp(0.6 + brush * 0.22 + orange * 0.1, 0, 1);
  };
  return {
    map: cached(`lab.trim.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const c = mixHex(tint, 0xffffff, (t - 0.5) * 0.24);
          return c;
        },
      }),
    ),
    normalMap: cached(`lab.trim.${key}.normal`, () => bakeNormalMap({ size, height: h }, 0.75)),
    roughnessMap: cached(`lab.trim.${key}.rough`, () =>
      bakeScalarMap(256, (u, v) => clamp(0.34 + (h(u, v) - 0.5) * 0.24, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Brushed steel                                                       */
/* ------------------------------------------------------------------ */

export function brushedMetalMaps(size = 384): MaterialMaps {
  const h = (u: number, v: number) => {
    const streak = tileableFbm(N.metal, u * 0.06, v * 5, 220, 2);
    return clamp(0.55 + streak * 0.4, 0, 1);
  };
  return {
    map: cached('lab.metal.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const c = mixHex(0x8e9298, 0xd6d9dc, t);
          return c;
        },
      }),
    ),
    normalMap: cached('lab.metal.normal', () => bakeNormalMap({ size, height: h }, 0.5)),
    roughnessMap: cached('lab.metal.rough', () =>
      bakeScalarMap(256, (u, v) => clamp(0.2 + (h(u, v) - 0.5) * 0.22, 0.08, 0.9)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Woven cloth — rug, stool seat, chair pad                            */
/* ------------------------------------------------------------------ */

export function wovenMaps(key: string, warp: number, weft: number, threads = 90, size = 384): MaterialMaps {
  const weave = (u: number, v: number) => {
    const a = Math.sin(u * threads * Math.PI * 2);
    const b = Math.sin(v * threads * Math.PI * 2);
    const over = a * b > 0 ? 1 : 0;
    const bump = Math.abs(over ? a : b);
    return { over, bump };
  };
  const h = (u: number, v: number) => {
    const w = weave(u, v);
    const fuzz = tileableFbm(N.cloth, u, v, 200, 2);
    return clamp(0.45 + w.bump * 0.4 + fuzz * 0.12, 0, 1);
  };
  return {
    map: cached(`lab.cloth.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const w = weave(u, v);
          const fade = tileableFbm(N.cloth, u * 0.5, v * 0.5, 5, 3) * 0.5 + 0.5;
          const c = mixHex(warp, weft, w.over ? 0.08 + fade * 0.2 : 0.82 - fade * 0.2);
          const k = 0.82 + w.bump * 0.26;
          return [c[0] * k, c[1] * k, c[2] * k];
        },
      }),
    ),
    normalMap: cached(`lab.cloth.${key}.normal`, () => bakeNormalMap({ size, height: h }, 1.5)),
    roughnessMap: cached(`lab.cloth.${key}.rough`, () =>
      bakeScalarMap(256, (u, v) => clamp(0.82 + (h(u, v) - 0.5) * 0.16, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Book cloth                                                          */
/* ------------------------------------------------------------------ */

/**
 * A white-ish spine so the per-instance colour does the tinting. Bands, a
 * label panel and a head/tail cap give every book a printed spine at almost no
 * cost, which is what stops a wall of books reading as a striped box.
 */
export function bookSpineMaps(size = 256): MaterialMaps {
  const band = (v: number) => {
    // v runs up the spine in the book's own metre space, period 1.
    const f = ((v % 1) + 1) % 1;
    const cap = smoothstep(0.02, 0.05, f) * smoothstep(0.98, 0.95, f);
    const label = smoothstep(0.6, 0.63, f) * smoothstep(0.86, 0.83, f);
    const rule1 = smoothstep(0.55, 0.565, f) * smoothstep(0.585, 0.57, f);
    const rule2 = smoothstep(0.29, 0.305, f) * smoothstep(0.325, 0.31, f);
    return { cap, label, rule: Math.max(rule1, rule2) };
  };
  return {
    map: cached('lab.book.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const b = band(v);
          const fibre = tileableFbm(N.paper, u * 3, v * 3, 90, 2) * 0.5 + 0.5;
          let k = 0.72 + fibre * 0.2;
          k *= 1 - (1 - b.cap) * 0.42;
          const lab = b.label * 0.85;
          const r = lerp(k, 0.96, lab);
          const g = lerp(k, 0.94, lab);
          const bl = lerp(k, 0.88, lab);
          const rl = 1 - b.rule * 0.5;
          return [r * rl, g * rl, bl * rl];
        },
      }),
    ),
    normalMap: cached('lab.book.normal', () =>
      bakeNormalMap(
        {
          size,
          height: (u, v) => {
            const b = band(v);
            const fibre = tileableFbm(N.paper, u * 3, v * 3, 70, 2) * 0.5 + 0.5;
            return clamp(0.6 + b.cap * 0.16 - b.rule * 0.3 + b.label * 0.08 + fibre * 0.1, 0, 1);
          },
        },
        1.4,
      ),
    ),
    roughnessMap: cached('lab.book.rough', () =>
      bakeScalarMap(192, (u, v) => {
        const b = band(v);
        return clamp(0.72 - b.label * 0.24 + tileableFbm(N.paper, u, v, 30, 2) * 0.1, 0, 1);
      }),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Paper                                                               */
/* ------------------------------------------------------------------ */

export function paperMaps(size = 256): MaterialMaps {
  const h = (u: number, v: number) => 0.5 + tileableFbm(N.paper, u, v, 60, 3) * 0.4;
  return {
    map: cached('lab.paper.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          // Faint ruled lines and a print block so a stack of paper is not a
          // slab of untextured white.
          const line = smoothstep(0.42, 0.5, Math.abs(Math.sin(v * 34 * Math.PI))) * 0.0;
          const text = smoothstep(0.75, 0.9, tileableFbm(N.paper, u * 6 + 3, v * 22, 30, 2) * 0.5 + 0.5);
          const c = mixHex(0xe8e2d4, 0xf4efe6, t);
          const k = 1 - text * 0.3 - line;
          return [c[0] * k, c[1] * k, c[2] * k];
        },
      }),
    ),
    normalMap: cached('lab.paper.normal', () => bakeNormalMap({ size, height: h }, 0.5)),
    roughnessMap: cached('lab.paper.rough', () => bakeScalarMap(128, (u, v) => 0.82 + h(u, v) * 0.1)),
  };
}

/* ------------------------------------------------------------------ */
/* Terracotta and soil                                                 */
/* ------------------------------------------------------------------ */

export function terracottaMaps(size = 384): MaterialMaps {
  const h = (u: number, v: number) => {
    const rings = Math.abs(Math.sin(v * 46 * Math.PI)) ** 0.7;
    const clay = tileableFbm(N.tile, u * 2, v * 2, 70, 3);
    return clamp(0.5 + rings * 0.22 + clay * 0.18, 0, 1);
  };
  return {
    map: cached('lab.terracotta.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const bloom = smoothstep(0.55, 0.95, tileableFbm(N.tile, u + 5, v, 8, 3) * 0.5 + 0.5);
          const c = mixHex(0xa9603f, 0xd08c5f, t);
          return [lerp(c[0], 0.83, bloom * 0.3), lerp(c[1], 0.79, bloom * 0.3), lerp(c[2], 0.72, bloom * 0.3)];
        },
      }),
    ),
    normalMap: cached('lab.terracotta.normal', () => bakeNormalMap({ size, height: h }, 1.1)),
    roughnessMap: cached('lab.terracotta.rough', () =>
      bakeScalarMap(192, (u, v) => clamp(0.66 + (h(u, v) - 0.5) * 0.2, 0, 1)),
    ),
  };
}

export function potSoilMaps(size = 256): MaterialMaps {
  const h = (u: number, v: number) => {
    const w = worley(u, v, 16, 7);
    return clamp(0.4 + smoothstep(0.3, 0.02, w.f1) * 0.5 + tileableFbm(N.plaster, u, v, 40, 3) * 0.2, 0, 1);
  };
  return {
    map: cached('lab.soil.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const c = mixHex(0x30251d, 0x5c4534, t);
          return c;
        },
      }),
    ),
    normalMap: cached('lab.soil.normal', () => bakeNormalMap({ size, height: h }, 2.4)),
    roughnessMap: cached('lab.soil.rough', () => bakeScalarMap(128, () => 0.93)),
  };
}

/* ------------------------------------------------------------------ */
/* Leaf                                                                */
/* ------------------------------------------------------------------ */

export function leafMaps(size = 256): MaterialMaps {
  const h = (u: number, v: number) => {
    const mid = 1 - smoothstep(0.0, 0.05, Math.abs(u - 0.5));
    const ribs = Math.abs(Math.sin((v * 9 + (u - 0.5) * 5) * Math.PI)) ** 1.5;
    return clamp(0.5 + mid * 0.4 - ribs * 0.14, 0, 1);
  };
  return {
    map: cached('lab.leaf.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const mid = 1 - smoothstep(0.0, 0.055, Math.abs(u - 0.5));
          const shade = tileableFbm(N.leaf, u * 2, v * 2, 12, 3) * 0.5 + 0.5;
          const tipFade = smoothstep(0.1, 0.8, v);
          const c = mixHex(0x3c6b34, 0x8fd257, clamp(shade * 0.55 + tipFade * 0.45, 0, 1));
          return [lerp(c[0], 0.72, mid * 0.4), lerp(c[1], 0.84, mid * 0.35), lerp(c[2], 0.44, mid * 0.4)];
        },
      }),
    ),
    normalMap: cached('lab.leaf.normal', () => bakeNormalMap({ size, height: h }, 1.6)),
    roughnessMap: cached('lab.leaf.rough', () => bakeScalarMap(128, (u, v) => 0.62 + h(u, v) * 0.2)),
  };
}

/* ------------------------------------------------------------------ */
/* Drawn content: terminal screen, whiteboard, window backdrop         */
/* ------------------------------------------------------------------ */

/**
 * The terminal display. Drawn rather than noise-baked because a research
 * readout needs actual shapes — a header, a scrolling log, a spectrum, a
 * radar sweep. Tiles vertically so the whole thing can be scrolled by
 * animating the texture offset.
 */
export function terminalScreenTexture(): THREE.Texture {
  return drawnTexture('lab.screen', 512, (c, s) => {
    const rng = makeRng(4242);
    c.fillStyle = '#0a1c26';
    c.fillRect(0, 0, s, s);

    // faint grid
    c.strokeStyle = 'rgba(70,190,190,0.10)';
    c.lineWidth = 1;
    for (let i = 0; i <= 16; i++) {
      const p = (i / 16) * s;
      c.beginPath();
      c.moveTo(p, 0);
      c.lineTo(p, s);
      c.stroke();
      c.beginPath();
      c.moveTo(0, p);
      c.lineTo(s, p);
      c.stroke();
    }

    // left column: scrolling log lines
    const lineH = s / 34;
    for (let i = 0; i < 34; i++) {
      const y = i * lineH + lineH * 0.28;
      const w = 30 + rng() * 150;
      c.fillStyle = i % 7 === 3 ? 'rgba(255,212,71,0.85)' : 'rgba(120,236,214,0.72)';
      c.fillRect(s * 0.045, y, w, lineH * 0.34);
      if (rng() > 0.55) {
        c.fillStyle = 'rgba(120,236,214,0.34)';
        c.fillRect(s * 0.045 + w + 8, y, 20 + rng() * 60, lineH * 0.34);
      }
    }

    // right column: two panels
    const px = s * 0.56;
    const pw = s * 0.39;
    for (const [py, ph] of [
      [s * 0.05, s * 0.4],
      [s * 0.52, s * 0.43],
    ]) {
      c.fillStyle = 'rgba(12,44,58,0.9)';
      c.fillRect(px, py, pw, ph);
      c.strokeStyle = 'rgba(120,236,214,0.4)';
      c.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    }

    // spectrum bars in the top panel
    const bars = 22;
    for (let i = 0; i < bars; i++) {
      const bh = (0.12 + rng() * 0.8) * s * 0.32;
      const bw = (pw * 0.86) / bars;
      c.fillStyle = i % 5 === 0 ? 'rgba(255,212,71,0.9)' : 'rgba(95,200,210,0.85)';
      c.fillRect(px + pw * 0.07 + i * bw, s * 0.05 + s * 0.38 - bh, bw * 0.66, bh);
    }

    // radar in the lower panel
    const cx = px + pw * 0.5;
    const cy = s * 0.52 + s * 0.215;
    for (let r = 1; r <= 4; r++) {
      c.strokeStyle = 'rgba(120,236,214,0.28)';
      c.beginPath();
      c.arc(cx, cy, (r / 4) * s * 0.17, 0, Math.PI * 2);
      c.stroke();
    }
    c.strokeStyle = 'rgba(120,236,214,0.55)';
    c.beginPath();
    c.moveTo(cx - s * 0.18, cy);
    c.lineTo(cx + s * 0.18, cy);
    c.moveTo(cx, cy - s * 0.18);
    c.lineTo(cx, cy + s * 0.18);
    c.stroke();
    for (let i = 0; i < 5; i++) {
      const a = rng() * Math.PI * 2;
      const rr = rng() * s * 0.16;
      c.fillStyle = 'rgba(255,120,140,0.9)';
      c.beginPath();
      c.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 3.2, 0, Math.PI * 2);
      c.fill();
    }

    // scanlines
    c.fillStyle = 'rgba(0,0,0,0.20)';
    for (let y = 0; y < s; y += 3) c.fillRect(0, y, s, 1);
  });
}

/** Glossy whiteboard with hand-drawn research scribbles. */
export function whiteboardTexture(): THREE.Texture {
  return drawnTexture('lab.whiteboard', 1024, (c, s) => {
    const rng = makeRng(90210);
    // Board itself: warm white with a faint ghost of everything ever wiped off.
    c.fillStyle = '#f2efe6';
    c.fillRect(0, 0, s, s);
    c.globalAlpha = 0.024;
    for (let i = 0; i < 34; i++) {
      c.strokeStyle = i % 3 === 0 ? '#3b6ea5' : '#555';
      c.lineWidth = 5 + rng() * 16;
      c.beginPath();
      c.moveTo(rng() * s, rng() * s);
      c.bezierCurveTo(rng() * s, rng() * s, rng() * s, rng() * s, rng() * s, rng() * s);
      c.stroke();
    }
    c.globalAlpha = 1;

    const stroke = (col: string, w: number) => {
      c.strokeStyle = col;
      c.lineWidth = w;
      c.lineCap = 'round';
      c.lineJoin = 'round';
    };
    const scribbleLine = (x: number, y: number, len: number, h: number, col: string, w = 5) => {
      stroke(col, w);
      c.beginPath();
      let px = x;
      c.moveTo(px, y);
      while (px < x + len) {
        const step = 9 + rng() * 12;
        px += step;
        c.lineTo(px, y + (rng() - 0.5) * h);
      }
      c.stroke();
    };

    // Title block
    stroke('#2b3a4a', 9);
    c.beginPath();
    c.moveTo(s * 0.06, s * 0.14);
    c.lineTo(s * 0.44, s * 0.14);
    c.stroke();
    for (let i = 0; i < 3; i++) scribbleLine(s * 0.06, s * 0.075 + i * s * 0.028, s * (0.2 + rng() * 0.16), 5, '#2b3a4a', 7);

    // A big Poke Ball diagram with callouts
    const bx = s * 0.72;
    const by = s * 0.27;
    const br = s * 0.15;
    stroke('#c0392b', 8);
    c.beginPath();
    c.arc(bx, by, br, Math.PI, Math.PI * 2);
    c.stroke();
    stroke('#2b3a4a', 8);
    c.beginPath();
    c.arc(bx, by, br, 0, Math.PI);
    c.stroke();
    c.beginPath();
    c.moveTo(bx - br, by);
    c.lineTo(bx + br, by);
    c.stroke();
    c.beginPath();
    c.arc(bx, by, br * 0.24, 0, Math.PI * 2);
    c.stroke();
    stroke('#3b6ea5', 4);
    for (let i = 0; i < 3; i++) {
      const a = -0.9 + i * 0.75;
      c.beginPath();
      c.moveTo(bx + Math.cos(a) * br * 1.05, by + Math.sin(a) * br * 1.05);
      c.lineTo(bx + Math.cos(a) * br * 1.5, by + Math.sin(a) * br * 1.5);
      c.stroke();
      scribbleLine(bx + Math.cos(a) * br * 1.55, by + Math.sin(a) * br * 1.5, s * 0.1, 4, '#3b6ea5', 4);
    }

    // Bar chart
    const gx = s * 0.08;
    const gy = s * 0.62;
    const gw = s * 0.3;
    const gh = s * 0.2;
    stroke('#2b3a4a', 6);
    c.beginPath();
    c.moveTo(gx, gy);
    c.lineTo(gx, gy + gh);
    c.lineTo(gx + gw, gy + gh);
    c.stroke();
    for (let i = 0; i < 6; i++) {
      const h = (0.2 + rng() * 0.78) * gh;
      c.fillStyle = ['#c0392b', '#3b6ea5', '#4a9d4a'][i % 3];
      c.globalAlpha = 0.75;
      c.fillRect(gx + 12 + i * (gw / 6.4), gy + gh - h, gw / 10, h);
      c.globalAlpha = 1;
    }

    // Flow arrows
    stroke('#4a9d4a', 6);
    for (let i = 0; i < 3; i++) {
      const y = s * 0.86 + i * s * 0.035;
      c.beginPath();
      c.moveTo(s * 0.46, y);
      c.lineTo(s * 0.46 + s * 0.18, y);
      c.stroke();
      c.beginPath();
      c.moveTo(s * 0.46 + s * 0.18, y);
      c.lineTo(s * 0.46 + s * 0.16, y - 8);
      c.lineTo(s * 0.46 + s * 0.16, y + 8);
      c.closePath();
      c.fillStyle = '#4a9d4a';
      c.fill();
    }

    // Right-hand notes column
    for (let i = 0; i < 9; i++) {
      scribbleLine(s * 0.53, s * 0.5 + i * s * 0.032, s * (0.16 + rng() * 0.28), 5, i % 4 === 1 ? '#c0392b' : '#3b4652', 5);
    }
  });
}

/**
 * What you see through the lab windows. A soft, out-of-focus impression of the
 * town green rather than a hole into the void — windows that are dark holes
 * are the single most common tell of a fake interior (ART_DIRECTION §5).
 */
export function windowBackdropTexture(): THREE.Texture {
  return drawnTexture('lab.backdrop', 256, (c, s) => {
    const rng = makeRng(1717);
    const sky = c.createLinearGradient(0, 0, 0, s);
    sky.addColorStop(0, '#8fc4ec');
    sky.addColorStop(0.44, '#cfe6f4');
    sky.addColorStop(0.52, '#c8dfae');
    sky.addColorStop(1, '#6fa64a');
    c.fillStyle = sky;
    c.fillRect(0, 0, s, s);
    // Blurred canopy blobs on the horizon.
    for (let i = 0; i < 26; i++) {
      const x = rng() * s;
      const y = s * (0.4 + rng() * 0.12);
      const r = s * (0.05 + rng() * 0.09);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      const t = rng();
      g.addColorStop(0, t > 0.5 ? 'rgba(120,190,90,0.85)' : 'rgba(90,160,80,0.8)');
      g.addColorStop(1, 'rgba(120,190,90,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    // Soft cloud smears.
    for (let i = 0; i < 10; i++) {
      const x = rng() * s;
      const y = s * rng() * 0.34;
      const r = s * (0.07 + rng() * 0.12);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
  });
}

/**
 * The three engraved nameplates on the starter table.
 *
 * Three columns in one atlas so all three plates merge into a single draw
 * call; the caller assigns each plate the u-range of its column. Each plate is
 * a cream enamel card with an engraved bevel, a coloured type roundel and
 * engraved lettering — at 40 cm from the player's eye during the choice this is
 * the most closely-read surface in the game, and a blank white slab there is
 * the single most damaging thing in the hero shot.
 */
export function nameplateTexture(): THREE.Texture {
  return cached('lab.nameplate', () => {
    const CW = 512;
    const CH = 160;
    const canvas = document.createElement('canvas');
    canvas.width = CW * 3;
    canvas.height = CH;
    const c = canvas.getContext('2d')!;
    const rng = makeRng(90210);

    const cols: [string, string, string][] = [
      ['GRASS', '#4e9440', '#dff0c8'],
      ['FIRE', '#d4622f', '#f7ddc4'],
      ['WATER', '#3585c0', '#cfe6f2'],
    ];

    for (let i = 0; i < 3; i++) {
      const x0 = i * CW;
      const [word, ink, wash] = cols[i];

      // enamel field, very slightly warmer at the bottom
      const bg = c.createLinearGradient(x0, 0, x0, CH);
      bg.addColorStop(0, '#efe7d4');
      bg.addColorStop(1, '#ddd1b8');
      c.fillStyle = bg;
      c.fillRect(x0, 0, CW, CH);

      // fired speckle so it never reads as flat vector art
      for (let k = 0; k < 900; k++) {
        const a = rng() * 0.05;
        c.fillStyle = rng() > 0.5 ? `rgba(120,104,84,${a})` : `rgba(255,250,238,${a * 1.6})`;
        c.fillRect(x0 + rng() * CW, rng() * CH, 2, 2);
      }

      // engraved border: dark on the top/left, light on the bottom/right
      c.lineWidth = 5;
      c.strokeStyle = 'rgba(104,88,68,0.55)';
      c.strokeRect(x0 + 14, 14, CW - 28, CH - 28);
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(255,252,242,0.7)';
      c.strokeRect(x0 + 19, 19, CW - 38, CH - 38);

      // type roundel
      const cx = x0 + 72;
      const cy = CH / 2;
      c.fillStyle = wash;
      c.beginPath();
      c.arc(cx, cy, 40, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 5;
      c.strokeStyle = ink;
      c.stroke();
      c.fillStyle = ink;
      c.beginPath();
      if (i === 0) {
        // leaf
        c.moveTo(cx - 20, cy + 18);
        c.quadraticCurveTo(cx - 22, cy - 22, cx + 20, cy - 20);
        c.quadraticCurveTo(cx + 20, cy + 20, cx - 20, cy + 18);
      } else if (i === 1) {
        // flame
        c.moveTo(cx, cy - 24);
        c.quadraticCurveTo(cx + 22, cy - 2, cx + 13, cy + 14);
        c.quadraticCurveTo(cx + 4, cy + 26, cx - 10, cy + 20);
        c.quadraticCurveTo(cx - 24, cy + 10, cx - 8, cy - 8);
        c.quadraticCurveTo(cx - 4, cy - 16, cx, cy - 24);
      } else {
        // droplet
        c.moveTo(cx, cy - 26);
        c.quadraticCurveTo(cx + 22, cy + 2, cx + 15, cy + 14);
        c.quadraticCurveTo(cx, cy + 30, cx - 15, cy + 14);
        c.quadraticCurveTo(cx - 22, cy + 2, cx, cy - 26);
      }
      c.fill();

      // engraved lettering — cut shadow first, then the ink face
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.font = '700 62px "Trebuchet MS", "Gill Sans", Optima, sans-serif';
      c.fillStyle = 'rgba(255,252,244,0.85)';
      c.fillText(word, 132 + x0 + 2, cy - 9 + 2);
      c.fillStyle = 'rgba(58,46,34,0.88)';
      c.fillText(word, 132 + x0, cy - 9);

      // a small engraved catalogue number under the word
      c.font = '400 22px "Trebuchet MS", sans-serif';
      c.fillStyle = 'rgba(92,78,60,0.6)';
      c.fillText(`SPECIMEN 00${i + 1} · PROF. OAK`, 134 + x0, cy + 34);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

/** Soft-edged additive gradient used for the window light shafts. */
export function shaftTexture(): THREE.Texture {
  return drawnTexture(
    'lab.shaft',
    128,
    (c, s) => {
      const g = c.createLinearGradient(0, 0, s, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.32, 'rgba(255,238,205,0.85)');
      g.addColorStop(0.5, 'rgba(255,246,224,1)');
      g.addColorStop(0.68, 'rgba(255,238,205,0.85)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
      // Fade along the length so the beam dissolves before it reaches the floor.
      const f = c.createLinearGradient(0, 0, 0, s);
      f.addColorStop(0, 'rgba(0,0,0,0)');
      f.addColorStop(0.18, 'rgba(0,0,0,0.15)');
      f.addColorStop(1, 'rgba(0,0,0,1)');
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = f;
      c.fillRect(0, 0, s, s);
    },
    false,
  );
}

/** Radial falloff used for the pool of daylight on the floor and glow cards. */
export function glowTexture(): THREE.Texture {
  return drawnTexture(
    'lab.glow',
    128,
    (c, s) => {
      const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,247,228,1)');
      g.addColorStop(0.45, 'rgba(255,236,200,0.5)');
      g.addColorStop(1, 'rgba(255,230,190,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, s, s);
    },
    false,
  );
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Strips a geometry down to position/normal/uv and gives it an index, so any
 * mix of primitives can be merged into a single draw call. Merging is not a
 * micro-optimisation here: a room this densely dressed is 400+ primitives and
 * would blow the whole scene's draw-call budget on its own.
 */
export function normalizeGeo(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    const n = g.attributes.position.count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') {
      g.deleteAttribute(name);
    }
  }
  if (!g.index) {
    const n = g.attributes.position.count;
    const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    g.setIndex(new THREE.BufferAttribute(arr, 1));
  }
  g.groups.length = 0;
  return g;
}

/** Concatenates geometries into one buffer. All inputs are consumed. */
export function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geos = list.map(normalizeGeo);
  let vTotal = 0;
  let iTotal = 0;
  for (const g of geos) {
    vTotal += g.attributes.position.count;
    iTotal += g.index!.count;
  }
  const anyColor = geos.some((g) => !!g.attributes.color);
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const col = anyColor ? new Float32Array(vTotal * 3).fill(1) : null;
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);

  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const p = g.attributes.position.array as ArrayLike<number>;
    const n = g.attributes.normal.array as ArrayLike<number>;
    const t = g.attributes.uv.array as ArrayLike<number>;
    const c = g.attributes.position.count;
    for (let i = 0; i < c * 3; i++) {
      pos[vo * 3 + i] = p[i];
      nor[vo * 3 + i] = n[i];
    }
    for (let i = 0; i < c * 2; i++) uv[vo * 2 + i] = t[i];
    if (col && g.attributes.color) {
      const s = g.attributes.color.array as ArrayLike<number>;
      for (let i = 0; i < c * 3; i++) col[vo * 3 + i] = s[i];
    }
    const gi = g.index!;
    for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo;
    vo += c;
    io += gi.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/** Places a geometry in the parent's space. Returns the same geometry. */
export function place(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Re-projects world-metre UVs onto a geometry after it has been placed. */
export function worldUV(g: THREE.BufferGeometry, scale = 1, rotate = 0): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = z;
      v = y;
    } else if (ny >= nx && ny >= nz) {
      u = x;
      v = z;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = (u * cos - v * sin) * scale;
    uv[i * 2 + 1] = (u * sin + v * cos) * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Shifts existing UVs. Cheaper than a texture clone when only one mesh needs it. */
export function shiftUV(g: THREE.BufferGeometry, du: number, dv: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
  uv.needsUpdate = true;
  return g;
}

/** Paints a flat vertex colour onto a geometry so it survives a merge. */
export function tintGeo(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/* ------------------------------------------------------------------ */
/* Material factory                                                    */
/* ------------------------------------------------------------------ */

export interface InteriorMatOpts extends THREE.MeshStandardMaterialParameters {
  /** Multiplies the map/normal/roughness repeat. UVs are already in metres. */
  repeat?: number;
}

const _texClones = new Map<string, THREE.Texture>();

function repeated(tex: THREE.Texture, key: string, r: number): THREE.Texture {
  if (r === 1) return tex;
  const k = `${key}:${r}`;
  const hit = _texClones.get(k);
  if (hit) return hit;
  const c = tex.clone();
  c.wrapS = THREE.RepeatWrapping;
  c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(r, r);
  c.needsUpdate = true;
  _texClones.set(k, c);
  return c;
}

/** Builds a standard interior material from a baked map set. */
export function interiorMaterial(
  key: string,
  maps: MaterialMaps,
  opts: InteriorMatOpts = {},
): THREE.MeshStandardMaterial {
  const { repeat = 1, ...rest } = opts;
  const m = new THREE.MeshStandardMaterial({
    map: repeated(maps.map, key + '.a', repeat),
    normalMap: repeated(maps.normalMap, key + '.n', repeat),
    roughnessMap: repeated(maps.roughnessMap, key + '.r', repeat),
    ...rest,
  });
  m.name = key;
  return m;
}

/** As above but physical, for anything that needs a clearcoat or transmission. */
export function interiorPhysical(
  key: string,
  maps: MaterialMaps | null,
  opts: THREE.MeshPhysicalMaterialParameters & { repeat?: number } = {},
): THREE.MeshPhysicalMaterial {
  const { repeat = 1, ...rest } = opts;
  const m = new THREE.MeshPhysicalMaterial({
    ...(maps
      ? {
          map: repeated(maps.map, key + '.a', repeat),
          normalMap: repeated(maps.normalMap, key + '.n', repeat),
          roughnessMap: repeated(maps.roughnessMap, key + '.r', repeat),
        }
      : {}),
    ...rest,
  });
  m.name = key;
  return m;
}

export { hexToRgb, mixHex, clamp, lerp, smoothstep };
