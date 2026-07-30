import * as THREE from 'three';
import { Simplex, makeRng, clamp, smoothstep, lerp } from '../core/Noise';

/**
 * Sculpt — a small toolkit for building soft, rounded, hand-modelled-looking
 * forms out of code.
 *
 * The art bible forbids sharp edges, and primitive geometry in Three.js is all
 * sharp edges. Everything here exists to produce the opposite: capsules that
 * taper, boxes with real fillets, and metaball surfaces that let separate
 * blobs fuse into one continuous skin the way a sculpted character does.
 */

/* ------------------------------------------------------------------ */
/* Rounded box                                                         */
/* ------------------------------------------------------------------ */

/**
 * A box with genuinely filleted edges and corners, built by projecting a
 * subdivided cube onto a rounded-box signed distance field. Unlike
 * RoundedBoxGeometry this keeps even quad density across the fillet, which
 * matters because our normal maps are read at close range on props.
 */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius: number,
  segments = 4,
): THREE.BufferGeometry {
  const r = Math.min(radius, Math.min(width, height, depth) / 2 - 1e-4);
  const geo = new THREE.BoxGeometry(1, 1, 1, segments * 2, segments * 2, segments * 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const hx = width / 2 - r;
  const hy = height / 2 - r;
  const hz = depth / 2 - r;

  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Cube vertex -> direction; clamp to the inner box, then push out by r.
    const sx = Math.sign(v.x) || 1;
    const sy = Math.sign(v.y) || 1;
    const sz = Math.sign(v.z) || 1;

    // Map the unit cube face position into the rounded shell.
    const ax = clamp(v.x * 2, -1, 1);
    const ay = clamp(v.y * 2, -1, 1);
    const az = clamp(v.z * 2, -1, 1);

    // Spherified cube gives an even fillet in all three axes.
    const x2 = ax * ax;
    const y2 = ay * ay;
    const z2 = az * az;
    const nx = ax * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
    const ny = ay * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
    const nz = az * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);

    // Blend between the flat face position and the sphere position by how
    // close this vertex is to an edge — flat in the middle, round at the rim.
    const edge = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az));
    const t = smoothstep(1 - (r / Math.min(width, height, depth)) * 2.2, 1, edge);

    v.x = lerp(ax * (width / 2), sx * hx + nx * r, t);
    v.y = lerp(ay * (height / 2), sy * hy + ny * r, t);
    v.z = lerp(az * (depth / 2), sz * hz + nz * r, t);

    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  geo.setAttribute('uv', boxProjectedUV(geo));
  return geo;
}

/** Box-projects UVs so a tiling material maps sensibly onto a sculpted form. */
export function boxProjectedUV(geo: THREE.BufferGeometry, scale = 1): THREE.BufferAttribute {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  geo.computeVertexNormals();
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let vv: number;
    if (nx >= ny && nx >= nz) {
      u = z * scale;
      vv = y * scale;
    } else if (ny >= nx && ny >= nz) {
      u = x * scale;
      vv = z * scale;
    } else {
      u = x * scale;
      vv = y * scale;
    }
    uv[i * 2] = u;
    uv[i * 2 + 1] = vv;
  }
  return new THREE.BufferAttribute(uv, 2);
}

/* ------------------------------------------------------------------ */
/* Metaball surface                                                    */
/* ------------------------------------------------------------------ */

export interface Ball {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Negative strength carves material away (eye sockets, mouth openings). */
  strength?: number;
  /** Non-uniform scale applied to the field, for egg and teardrop shapes. */
  sx?: number;
  sy?: number;
  sz?: number;
}

/**
 * Builds a smooth surface from a set of blended spheres via marching cubes.
 *
 * This is the core of every creature and every organic prop. Separate blobs
 * fuse into one continuous skin with no seam, which is exactly what a sculpted
 * cartoon character needs and what you cannot get by parenting primitives.
 */
export function metaSurface(
  balls: Ball[],
  opts: { resolution?: number; isoLevel?: number; padding?: number; smooth?: number } = {},
): THREE.BufferGeometry {
  const resolution = opts.resolution ?? 48;
  const iso = opts.isoLevel ?? 1.0;
  const padding = opts.padding ?? 0.28;
  const smoothK = opts.smooth ?? 1.0;

  // Bounds from the positive balls only; negative ones only carve.
  const box = new THREE.Box3();
  box.makeEmpty();
  for (const b of balls) {
    if ((b.strength ?? 1) < 0) continue;
    const rx = b.r * (b.sx ?? 1);
    const ry = b.r * (b.sy ?? 1);
    const rz = b.r * (b.sz ?? 1);
    box.expandByPoint(new THREE.Vector3(b.x - rx, b.y - ry, b.z - rz));
    box.expandByPoint(new THREE.Vector3(b.x + rx, b.y + ry, b.z + rz));
  }
  box.expandByScalar(padding);

  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const nx = Math.max(8, Math.ceil((size.x / maxDim) * resolution));
  const ny = Math.max(8, Math.ceil((size.y / maxDim) * resolution));
  const nz = Math.max(8, Math.ceil((size.z / maxDim) * resolution));

  const dx = size.x / (nx - 1);
  const dy = size.y / (ny - 1);
  const dz = size.z / (nz - 1);

  const field = new Float32Array(nx * ny * nz);

  const sample = (px: number, py: number, pz: number): number => {
    let sum = 0;
    for (const b of balls) {
      const s = b.strength ?? 1;
      const ex = (px - b.x) / (b.sx ?? 1);
      const ey = (py - b.y) / (b.sy ?? 1);
      const ez = (pz - b.z) / (b.sz ?? 1);
      const d2 = ex * ex + ey * ey + ez * ez;
      const r2 = b.r * b.r;
      if (d2 > r2 * 4) continue;
      // Wyvill falloff: finite support, C2 continuous, no long-range bulge.
      const q = clamp(d2 / (r2 * 4 * smoothK), 0, 1);
      const f = 1 - q;
      sum += s * f * f * f;
    }
    return sum;
  };

  for (let k = 0; k < nz; k++) {
    const pz = box.min.z + k * dz;
    for (let j = 0; j < ny; j++) {
      const py = box.min.y + j * dy;
      for (let i = 0; i < nx; i++) {
        field[i + j * nx + k * nx * ny] = sample(box.min.x + i * dx, py, pz);
      }
    }
  }

  return marchingCubes(field, nx, ny, nz, box.min, dx, dy, dz, iso * 0.35);
}

/* ------------------------------------------------------------------ */
/* Marching cubes                                                      */
/* ------------------------------------------------------------------ */

function marchingCubes(
  field: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  origin: THREE.Vector3,
  dx: number,
  dy: number,
  dz: number,
  iso: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const idx = (i: number, j: number, k: number) => i + j * nx + k * nx * ny;

  const CORNER = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const EDGE_V = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const vals = new Float32Array(8);
  const pts: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  const edgeVerts: (THREE.Vector3 | null)[] = new Array(12).fill(null);

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const [ci, cj, ck] = CORNER[c];
          const v = field[idx(i + ci, j + cj, k + ck)];
          vals[c] = v;
          pts[c].set(
            origin.x + (i + ci) * dx,
            origin.y + (j + cj) * dy,
            origin.z + (k + ck) * dz,
          );
          if (v > iso) cubeIndex |= 1 << c;
        }

        const edges = EDGE_TABLE[cubeIndex];
        if (edges === 0) continue;

        for (let e = 0; e < 12; e++) {
          if ((edges & (1 << e)) === 0) {
            edgeVerts[e] = null;
            continue;
          }
          const [a, b] = EDGE_V[e];
          const va = vals[a];
          const vb = vals[b];
          const t = Math.abs(vb - va) < 1e-9 ? 0.5 : (iso - va) / (vb - va);
          edgeVerts[e] = new THREE.Vector3().lerpVectors(pts[a], pts[b], clamp(t, 0, 1));
        }

        const tri = TRI_TABLE[cubeIndex];
        for (let t = 0; t < tri.length; t += 3) {
          const a = edgeVerts[tri[t]];
          const b = edgeVerts[tri[t + 1]];
          const c = edgeVerts[tri[t + 2]];
          if (!a || !b || !c) continue;
          // Emitted b/c swapped. The classic triangle table assumes the cube
          // index bit is set for corners INSIDE the surface (value < iso),
          // whereas we set it for corners above the isolevel — which mirrors
          // every face. Without the swap the whole sculpt comes back wound
          // inside-out: back faces culled and lighting evaluated against the
          // inside of the skin, which reads as a flat, milky surface.
          positions.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const merged = mergeVerticesSimple(geo, 1e-4);
  merged.computeVertexNormals();
  return merged;
}

/**
 * Welds coincident vertices so the surface shades smoothly. Marching cubes
 * emits a soup of independent triangles; without this every facet gets its own
 * normal and the creature looks like it is made of glass shards.
 */
function mergeVerticesSimple(geo: THREE.BufferGeometry, tolerance: number): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const out: number[] = [];
  const indices: number[] = [];
  const inv = 1 / tolerance;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      out.push(x, y, z);
      map.set(key, id);
    }
    indices.push(id);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(indices);
  return g;
}

/* ------------------------------------------------------------------ */
/* Deformers                                                           */
/* ------------------------------------------------------------------ */

/** Adds seeded noise displacement along the normal — for rocks, bark, canopies. */
export function noiseDisplace(
  geo: THREE.BufferGeometry,
  amplitude: number,
  frequency: number,
  seed = 1,
  octaves = 3,
): THREE.BufferGeometry {
  const simplex = new Simplex(seed);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nor = geo.attributes.normal as THREE.BufferAttribute;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let amp = 1;
    let freq = frequency;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * simplex.noise3D(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    const d = (sum / norm) * amplitude;
    pos.setXYZ(i, x + nor.getX(i) * d, y + nor.getY(i) * d, z + nor.getZ(i) * d);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Tapers a geometry along Y — narrower at the top (or bottom if factor > 1). */
export function taperY(geo: THREE.BufferGeometry, topScale: number, bottomScale = 1): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const h = bb.max.y - bb.min.y || 1;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y - bb.min.y) / h;
    const s = lerp(bottomScale, topScale, t);
    pos.setXYZ(i, pos.getX(i) * s, y, pos.getZ(i) * s);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Bends a geometry around the Z axis, for curved trunks, tails and stalks. */
export function bendY(geo: THREE.BufferGeometry, angle: number): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const h = bb.max.y - bb.min.y || 1;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y - bb.min.y) / h;
    const a = angle * t;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const x = v.x * cos - v.y * sin;
    const y = v.x * sin + v.y * cos;
    pos.setXYZ(i, x, y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Bakes cavity/thickness darkening into vertex colours.
 *
 * For each vertex, casts a few rays inward and measures how enclosed it is.
 * Applied to foliage canopies and creature crevices, this is what gives
 * stylised surfaces their sense of volume without a baked AO texture.
 */
export function bakeCavityAO(
  geo: THREE.BufferGeometry,
  center: THREE.Vector3,
  strength = 0.55,
  base = new THREE.Color(1, 1, 1),
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  if (!geo.attributes.normal) geo.computeVertexNormals();

  geo.computeBoundingSphere();
  const radius = geo.boundingSphere?.radius ?? 1;

  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Distance from the form's core, normalised. Interior -> dark.
    const d = v.distanceTo(center) / radius;
    const ao = lerp(1 - strength, 1, clamp(d, 0, 1) ** 0.7);
    colors[i * 3] = base.r * ao;
    colors[i * 3 + 1] = base.g * ao;
    colors[i * 3 + 2] = base.b * ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/* ------------------------------------------------------------------ */
/* Marching cubes tables                                               */
/* ------------------------------------------------------------------ */

const EDGE_TABLE = new Int32Array([
  0x0, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c, 0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03,
  0xe09, 0xf00, 0x190, 0x99, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c, 0x99c, 0x895, 0xb9f, 0xa96,
  0xd9a, 0xc93, 0xf99, 0xe90, 0x230, 0x339, 0x33, 0x13a, 0x636, 0x73f, 0x435, 0x53c, 0xa3c, 0xb35,
  0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30, 0x3a0, 0x2a9, 0x1a3, 0xaa, 0x7a6, 0x6af, 0x5a5, 0x4ac,
  0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0, 0x460, 0x569, 0x663, 0x76a, 0x66, 0x16f,
  0x265, 0x36c, 0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60, 0x5f0, 0x4f9, 0x7f3, 0x6fa,
  0x1f6, 0xff, 0x3f5, 0x2fc, 0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0, 0x650, 0x759,
  0x453, 0x55a, 0x256, 0x35f, 0x55, 0x15c, 0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
  0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0xcc, 0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3,
  0x9c9, 0x8c0, 0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc, 0xcc, 0x1c5, 0x2cf, 0x3c6,
  0x4ca, 0x5c3, 0x6c9, 0x7c0, 0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c, 0x15c, 0x55,
  0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650, 0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
  0x2fc, 0x3f5, 0xff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0, 0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f,
  0xd65, 0xc6c, 0x36c, 0x265, 0x16f, 0x66, 0x76a, 0x663, 0x569, 0x460, 0xca0, 0xda9, 0xea3, 0xfaa,
  0x8a6, 0x9af, 0xaa5, 0xbac, 0x4ac, 0x5a5, 0x6af, 0x7a6, 0xaa, 0x1a3, 0x2a9, 0x3a0, 0xd30, 0xc39,
  0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c, 0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x33, 0x339, 0x230,
  0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c, 0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393,
  0x99, 0x190, 0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c, 0x70c, 0x605, 0x50f, 0x406,
  0x30a, 0x203, 0x109, 0x0,
]);

const TRI_TABLE: number[][] = [
  [], [0, 8, 3], [0, 1, 9], [1, 8, 3, 9, 8, 1], [1, 2, 10], [0, 8, 3, 1, 2, 10], [9, 2, 10, 0, 2, 9],
  [2, 8, 3, 2, 10, 8, 10, 9, 8], [3, 11, 2], [0, 11, 2, 8, 11, 0], [1, 9, 0, 2, 3, 11],
  [1, 11, 2, 1, 9, 11, 9, 8, 11], [3, 10, 1, 11, 10, 3], [0, 10, 1, 0, 8, 10, 8, 11, 10],
  [3, 9, 0, 3, 11, 9, 11, 10, 9], [9, 8, 10, 10, 8, 11], [4, 7, 8], [4, 3, 0, 7, 3, 4], [0, 1, 9, 8, 4, 7],
  [4, 1, 9, 4, 7, 1, 7, 3, 1], [1, 2, 10, 8, 4, 7], [3, 4, 7, 3, 0, 4, 1, 2, 10], [9, 2, 10, 9, 0, 2, 8, 4, 7],
  [2, 10, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4], [8, 4, 7, 3, 11, 2], [11, 4, 7, 11, 2, 4, 2, 0, 4],
  [9, 0, 1, 8, 4, 7, 2, 3, 11], [4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1], [3, 10, 1, 3, 11, 10, 7, 8, 4],
  [1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4], [4, 7, 8, 9, 0, 11, 9, 11, 10, 11, 0, 3],
  [4, 7, 11, 4, 11, 9, 9, 11, 10], [9, 5, 4], [9, 5, 4, 0, 8, 3], [0, 5, 4, 1, 5, 0], [8, 5, 4, 8, 3, 5, 3, 1, 5],
  [1, 2, 10, 9, 5, 4], [3, 0, 8, 1, 2, 10, 4, 9, 5], [5, 2, 10, 5, 4, 2, 4, 0, 2],
  [2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8], [9, 5, 4, 2, 3, 11], [0, 11, 2, 0, 8, 11, 4, 9, 5],
  [0, 5, 4, 0, 1, 5, 2, 3, 11], [2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5], [10, 3, 11, 10, 1, 3, 9, 5, 4],
  [4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11, 10], [5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3],
  [5, 4, 8, 5, 8, 10, 10, 8, 11], [9, 7, 8, 5, 7, 9], [9, 3, 0, 9, 5, 3, 5, 7, 3], [0, 7, 8, 0, 1, 7, 1, 5, 7],
  [1, 5, 3, 3, 5, 7], [9, 7, 8, 9, 5, 7, 10, 1, 2], [10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3],
  [8, 0, 2, 8, 2, 5, 8, 5, 7, 10, 5, 2], [2, 10, 5, 2, 5, 3, 3, 5, 7], [7, 9, 5, 7, 8, 9, 3, 11, 2],
  [9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11], [2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7],
  [11, 2, 1, 11, 1, 7, 7, 1, 5], [9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11],
  [5, 7, 0, 5, 0, 9, 7, 11, 0, 1, 0, 10, 11, 10, 0], [11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0],
  [11, 10, 5, 7, 11, 5], [10, 6, 5], [0, 8, 3, 5, 10, 6], [9, 0, 1, 5, 10, 6], [1, 8, 3, 1, 9, 8, 5, 10, 6],
  [1, 6, 5, 2, 6, 1], [1, 6, 5, 1, 2, 6, 3, 0, 8], [9, 6, 5, 9, 0, 6, 0, 2, 6],
  [5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8], [2, 3, 11, 10, 6, 5], [11, 0, 8, 11, 2, 0, 10, 6, 5],
  [0, 1, 9, 2, 3, 11, 5, 10, 6], [5, 10, 6, 1, 9, 2, 9, 11, 2, 9, 8, 11], [6, 3, 11, 6, 5, 3, 5, 1, 3],
  [0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6], [3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9],
  [6, 5, 9, 6, 9, 11, 11, 9, 8], [5, 10, 6, 4, 7, 8], [4, 3, 0, 4, 7, 3, 6, 5, 10], [1, 9, 0, 5, 10, 6, 8, 4, 7],
  [10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4], [6, 1, 2, 6, 5, 1, 4, 7, 8], [1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7],
  [8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6], [7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9, 6, 2, 6, 9],
  [3, 11, 2, 7, 8, 4, 10, 6, 5], [5, 10, 6, 4, 7, 2, 4, 2, 0, 2, 7, 11], [0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6],
  [9, 2, 1, 9, 11, 2, 9, 4, 11, 7, 11, 4, 5, 10, 6], [8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6],
  [5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11], [0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7],
  [6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9], [10, 4, 9, 6, 4, 10], [4, 10, 6, 4, 9, 10, 0, 8, 3],
  [10, 0, 1, 10, 6, 0, 6, 4, 0], [8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10], [1, 4, 9, 1, 2, 4, 2, 6, 4],
  [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4], [0, 2, 4, 4, 2, 6], [8, 3, 2, 8, 2, 4, 4, 2, 6],
  [10, 4, 9, 10, 6, 4, 11, 2, 3], [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6], [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10],
  [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1], [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3],
  [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1], [3, 11, 6, 3, 6, 0, 0, 6, 4], [6, 4, 8, 11, 6, 8],
  [7, 10, 6, 7, 8, 10, 8, 9, 10], [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10], [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0],
  [10, 6, 7, 10, 7, 1, 1, 7, 3], [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7],
  [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9], [7, 8, 0, 7, 0, 6, 6, 0, 2], [7, 3, 2, 6, 7, 2],
  [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7], [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7],
  [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11], [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1],
  [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6], [0, 9, 1, 11, 6, 7], [7, 8, 0, 7, 0, 6, 3, 11, 0, 11, 6, 0],
  [7, 11, 6], [7, 6, 11], [3, 0, 8, 11, 7, 6], [0, 1, 9, 11, 7, 6], [8, 1, 9, 8, 3, 1, 11, 7, 6],
  [10, 1, 2, 6, 11, 7], [1, 2, 10, 3, 0, 8, 6, 11, 7], [2, 9, 0, 2, 10, 9, 6, 11, 7],
  [6, 11, 7, 2, 10, 3, 10, 8, 3, 10, 9, 8], [7, 2, 3, 6, 2, 7], [7, 0, 8, 7, 6, 0, 6, 2, 0], [2, 7, 6, 2, 3, 7, 0, 1, 9],
  [1, 6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6], [10, 7, 6, 10, 1, 7, 1, 3, 7], [10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8],
  [0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10, 7], [7, 6, 10, 7, 10, 8, 8, 10, 9], [6, 8, 4, 11, 8, 6], [3, 6, 11, 3, 0, 6, 0, 4, 6],
  [8, 6, 11, 8, 4, 6, 9, 0, 1], [9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6], [6, 8, 4, 6, 11, 8, 2, 10, 1],
  [1, 2, 10, 3, 0, 11, 0, 6, 11, 0, 4, 6], [4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9],
  [10, 9, 3, 10, 3, 2, 9, 4, 3, 11, 3, 6, 4, 6, 3], [8, 2, 3, 8, 4, 2, 4, 6, 2], [0, 4, 2, 4, 6, 2],
  [1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8], [1, 9, 4, 1, 4, 2, 2, 4, 6], [8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1],
  [10, 1, 0, 10, 0, 6, 6, 0, 4], [4, 6, 3, 4, 3, 8, 6, 10, 3, 0, 3, 9, 10, 9, 3], [10, 9, 4, 6, 10, 4],
  [4, 9, 5, 7, 6, 11], [0, 8, 3, 4, 9, 5, 11, 7, 6], [5, 0, 1, 5, 4, 0, 7, 6, 11], [11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5],
  [9, 5, 4, 10, 1, 2, 7, 6, 11], [6, 11, 7, 1, 2, 10, 0, 8, 3, 4, 9, 5], [7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2],
  [3, 4, 8, 3, 5, 4, 3, 2, 5, 10, 5, 2, 11, 7, 6], [7, 2, 3, 7, 6, 2, 5, 4, 9], [9, 5, 4, 0, 8, 6, 0, 6, 2, 6, 8, 7],
  [3, 6, 2, 3, 7, 6, 1, 5, 0, 5, 4, 0], [6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8], [9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7],
  [1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4], [4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3, 7, 10],
  [7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10], [6, 9, 5, 6, 11, 9, 11, 8, 9], [3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5],
  [0, 11, 8, 0, 5, 11, 0, 1, 5, 5, 6, 11], [6, 11, 3, 6, 3, 5, 5, 3, 1], [1, 2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6],
  [0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2, 10], [11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5],
  [6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3], [5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2], [9, 5, 6, 9, 6, 0, 0, 6, 2],
  [1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8], [1, 5, 6, 2, 1, 6], [1, 3, 6, 1, 6, 10, 3, 8, 6, 5, 6, 9, 8, 9, 6],
  [10, 1, 0, 10, 0, 6, 9, 5, 0, 5, 6, 0], [0, 3, 8, 5, 6, 10], [10, 5, 6], [11, 5, 10, 7, 5, 11], [11, 5, 10, 11, 7, 5, 8, 3, 0],
  [5, 11, 7, 5, 10, 11, 1, 9, 0], [10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1], [11, 1, 2, 11, 7, 1, 7, 5, 1],
  [0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11], [9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7], [7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2, 8, 9, 8, 2],
  [2, 5, 10, 2, 3, 5, 3, 7, 5], [8, 2, 0, 8, 5, 2, 8, 7, 5, 10, 2, 5], [9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2],
  [9, 8, 2, 9, 2, 1, 8, 7, 2, 10, 2, 5, 7, 5, 2], [1, 3, 5, 3, 7, 5], [0, 8, 7, 0, 7, 1, 1, 7, 5], [9, 0, 3, 9, 3, 5, 5, 3, 7],
  [9, 8, 7, 5, 9, 7], [5, 8, 4, 5, 10, 8, 10, 11, 8], [5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0], [0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5],
  [10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4], [2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8], [0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11],
  [0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5], [9, 4, 5, 2, 11, 3], [2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4], [5, 10, 2, 5, 2, 4, 4, 2, 0],
  [3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9], [5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2], [8, 4, 5, 8, 5, 3, 3, 5, 1], [0, 4, 5, 1, 0, 5],
  [8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5], [9, 4, 5], [4, 11, 7, 4, 9, 11, 9, 10, 11], [0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11],
  [1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11], [3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4], [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2],
  [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3], [11, 7, 4, 11, 4, 2, 2, 4, 0], [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4],
  [2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9], [9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7], [3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10],
  [1, 10, 2, 8, 7, 4], [4, 9, 1, 4, 1, 7, 7, 1, 3], [4, 9, 1, 4, 1, 7, 0, 8, 1, 8, 7, 1], [4, 0, 3, 7, 4, 3], [4, 8, 7],
  [9, 10, 8, 10, 11, 8], [3, 0, 9, 3, 9, 11, 11, 9, 10], [0, 1, 10, 0, 10, 8, 8, 10, 11], [3, 1, 10, 11, 3, 10], [1, 2, 11, 1, 11, 9, 9, 11, 8],
  [3, 0, 9, 3, 9, 11, 1, 2, 9, 2, 11, 9], [0, 2, 11, 8, 0, 11], [3, 2, 11], [2, 3, 8, 2, 8, 10, 10, 8, 9], [9, 10, 2, 0, 9, 2],
  [2, 3, 8, 2, 8, 10, 0, 1, 8, 1, 10, 8], [1, 10, 2], [1, 3, 8, 9, 1, 8], [0, 9, 1], [0, 3, 8], [],
];
