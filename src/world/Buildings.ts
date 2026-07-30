import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext } from '../core/Context';
import { makeRng, rangeOf, clamp, smoothstep } from '../core/Noise';
import {
  BPAL,
  ROOM_COUNT,
  ROOM_GRID,
  brickMaterial,
  curtainMaterial,
  doorMaterial,
  glassMaterial,
  lampGlassMaterial,
  metalMaterial,
  roofMaterial,
  roomBackMaterial,
  roomShellMaterial,
  skirtMaterial,
  stainMaterial,
  stoneMaterial,
  trimMaterial,
  wallMaterial,
  type WeatherOptions,
} from '../fx/BuildingMaterials';

/**
 * Buildings — the player's house, the rival's house and Oak's laboratory.
 *
 * Everything here is built from one primitive: a chamfered box. The art bible
 * forbids sharp edges, and a 45° chamfer is the cheapest honest way to get one
 * — 44 triangles, a crisp specular line along every arris, and it works at any
 * aspect ratio (a spherified rounded box does not: it bulges a 4 m wall).
 *
 * Three decisions are worth calling out:
 *
 *  - **Openings are real holes.** `wallPanels()` splits a wall into the
 *    rectangles that survive after its windows and doors are punched out, so
 *    every opening shows the full wall thickness as a reveal. Nothing here is a
 *    decal sitting on a flat plane, which is why the facades hold up at 4 m.
 *
 *  - **UVs are world-space, applied after placement.** Each piece is
 *    transformed into world space first and then box-projected, so cladding
 *    courses line up across every panel of a wall, roof tiles run in continuous
 *    courses across slab, ridge and dormer, and the two houses — mirror images
 *    of each other — sit on different phases of the same texture.
 *
 *  - **One draw call per material, not per part.** Parts accumulate into
 *    per-material buckets and merge at the end: ~15 meshes for three fully
 *    detailed buildings. Merging beats InstancedMesh here — same draw-call
 *    count, no per-instance uniformity, and every window can differ.
 */

/* ------------------------------------------------------------------ */
/* Layout — other systems may read this.                               */
/* ------------------------------------------------------------------ */

export const BUILDINGS = {
  playerHouse: { cx: -8.4, cz: 2.0, w: 7.4, d: 6.2 },
  rivalHouse: { cx: 8.4, cz: 2.0, w: 7.62, d: 6.05 },
  lab: { cx: 0, cz: -13.0, w: 13.2, d: 9.2 },
  /** World position of the lab threshold. The lab door is LabInterior's. */
  labDoor: new THREE.Vector3(0, 0, -7.65),
} as const;

/**
 * Local z of each cottage's gable-end chimney. Declared here rather than inline
 * because the collider registration at the bottom of the file has to agree with
 * the geometry exactly — a stack you can walk through is worse than no stack.
 */
const PLAYER_CHIMNEY_Z = -1.85;
/**
 * The rival's cottage is front-gabled, so its stack rises on the *rear* gable
 * rather than a side wall. This is its local x on that face.
 */
const RIVAL_CHIMNEY_X = 2.15;

/* ------------------------------------------------------------------ */
/* Chamfered box                                                       */
/* ------------------------------------------------------------------ */

type V3 = [number, number, number];

/**
 * Box with a true chamfer on all twelve edges and eight corners.
 *
 * `segs` > 1 subdivides the chamfer into a filleted arc with smooth normals
 * across the strip and flat normals on the faces — soft edge, dead-flat wall.
 */
function chamferBox(w: number, h: number, d: number, c = 0.03, segs = 1): THREE.BufferGeometry {
  const r = Math.max(0.0015, Math.min(c, Math.min(w, h, d) / 2 - 0.0015));
  const half: V3 = [w / 2, h / 2, d / 2];
  const inner: V3 = [half[0] - r, half[1] - r, half[2] - r];

  const P: number[] = [];
  const N: number[] = [];

  const push = (p: V3, n: V3) => {
    P.push(p[0], p[1], p[2]);
    N.push(n[0], n[1], n[2]);
  };
  const tri = (a: V3, na: V3, b: V3, nb: V3, cc: V3, nc: V3) => {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = cc[0] - a[0];
    const vy = cc[1] - a[1];
    const vz = cc[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const dot = cx * (na[0] + nb[0] + nc[0]) + cy * (na[1] + nb[1] + nc[1]) + cz * (na[2] + nb[2] + nc[2]);
    if (dot >= 0) {
      push(a, na);
      push(b, nb);
      push(cc, nc);
    } else {
      push(a, na);
      push(cc, nc);
      push(b, nb);
    }
  };
  const axisVec = (a: number, s: number): V3 => {
    const v: V3 = [0, 0, 0];
    v[a] = s;
    return v;
  };
  const norm = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  // --- six flat faces -------------------------------------------------
  const OTHER: [number, number][] = [
    [1, 2],
    [2, 0],
    [0, 1],
  ];
  for (let a = 0; a < 3; a++) {
    const [b, cc] = OTHER[a];
    for (const s of [-1, 1]) {
      const n = axisVec(a, s);
      const corner = (sb: number, sc: number): V3 => {
        const p: V3 = [0, 0, 0];
        p[a] = s * half[a];
        p[b] = sb * inner[b];
        p[cc] = sc * inner[cc];
        return p;
      };
      tri(corner(-1, -1), n, corner(1, -1), n, corner(1, 1), n);
      tri(corner(-1, -1), n, corner(1, 1), n, corner(-1, 1), n);
    }
  }

  // --- twelve chamfer strips ------------------------------------------
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const f = 3 - a - b;
      for (const sa of [-1, 1]) {
        for (const sb of [-1, 1]) {
          const na = axisVec(a, sa);
          const nb = axisVec(b, sb);
          const at = (k: number, sf: number): { p: V3; n: V3 } => {
            const t = k / segs;
            const dir = norm([
              na[0] * (1 - t) + nb[0] * t,
              na[1] * (1 - t) + nb[1] * t,
              na[2] * (1 - t) + nb[2] * t,
            ]);
            const p: V3 = [0, 0, 0];
            p[a] = sa * inner[a];
            p[b] = sb * inner[b];
            p[f] = sf * inner[f];
            return { p: [p[0] + dir[0] * r, p[1] + dir[1] * r, p[2] + dir[2] * r], n: dir };
          };
          for (let k = 0; k < segs; k++) {
            const q0 = at(k, -1);
            const q1 = at(k + 1, -1);
            const q2 = at(k + 1, 1);
            const q3 = at(k, 1);
            tri(q0.p, q0.n, q1.p, q1.n, q2.p, q2.n);
            tri(q0.p, q0.n, q2.p, q2.n, q3.p, q3.n);
          }
        }
      }
    }
  }

  // --- eight corner patches -------------------------------------------
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const base: V3 = [sx * inner[0], sy * inner[1], sz * inner[2]];
        const A: V3 = [sx, 0, 0];
        const B: V3 = [0, sy, 0];
        const C: V3 = [0, 0, sz];
        const at = (i: number, j: number): { p: V3; n: V3 } => {
          const k = segs - i - j;
          const dir = norm([
            (A[0] * i + B[0] * j + C[0] * k) / segs,
            (A[1] * i + B[1] * j + C[1] * k) / segs,
            (A[2] * i + B[2] * j + C[2] * k) / segs,
          ]);
          return {
            p: [base[0] + dir[0] * r, base[1] + dir[1] * r, base[2] + dir[2] * r],
            n: dir,
          };
        };
        for (let i = 0; i < segs; i++) {
          for (let j = 0; j < segs - i; j++) {
            const p00 = at(i, j);
            const p10 = at(i + 1, j);
            const p01 = at(i, j + 1);
            tri(p00.p, p00.n, p10.p, p10.n, p01.p, p01.n);
            if (i + j < segs - 1) {
              const p11 = at(i + 1, j + 1);
              tri(p10.p, p10.n, p11.p, p11.n, p01.p, p01.n);
            }
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((P.length / 3) * 2), 2));
  return geo;
}

/* ------------------------------------------------------------------ */
/* UV projection                                                       */
/* ------------------------------------------------------------------ */

type UVFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => [number, number];

/** World-space triplanar box projection — keeps courses aligned across parts. */
const UV_BOX: UVFn = (x, y, z, nx, ny, nz) => {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  if (ay >= ax && ay >= az) return [x, z];
  if (ax >= az) return [z, y];
  return [x, y];
};

/** Roof projection: courses run parallel to the ridge, rows up the slope. */
function uvRoof(axis: 'x' | 'z', ridgeAt: number, slope: number): UVFn {
  const sec = Math.sqrt(1 + slope * slope);
  if (axis === 'x') return (x, _y, z) => [x, Math.abs(z - ridgeAt) * sec];
  return (x, _y, z) => [z, Math.abs(x - ridgeAt) * sec];
}

function applyUV(geo: THREE.BufferGeometry, fn: UVFn): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const [u, v] = fn(
      pos.getX(i),
      pos.getY(i),
      pos.getZ(i),
      nor.getX(i),
      nor.getY(i),
      nor.getZ(i),
    );
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function flipWinding(geo: THREE.BufferGeometry): void {
  for (const name of Object.keys(geo.attributes)) {
    const attr = geo.attributes[name] as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const s = attr.itemSize;
    for (let t = 0; t < attr.count; t += 3) {
      for (let k = 0; k < s; k++) {
        const i = (t + 1) * s + k;
        const j = (t + 2) * s + k;
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
/* Assembler                                                           */
/* ------------------------------------------------------------------ */

interface PieceOpts {
  /** Chamfer radius. */
  c?: number;
  /** Chamfer subdivisions — 2 gives a soft fillet on hero parts. */
  segs?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  /** UV projection; `null` keeps the geometry's own UVs. */
  uv?: UVFn | null;
}

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3(1, 1, 1);

class Kit {
  private buckets = new Map<string, THREE.BufferGeometry[]>();
  private base = new THREE.Matrix4();
  private mirrored = false;

  /** Sets the building-to-world transform. `mirror` flips about local X. */
  origin(ox: number, oy: number, oz: number, mirror = 1): void {
    this.base.makeTranslation(ox, oy, oz);
    if (mirror < 0) this.base.multiply(new THREE.Matrix4().makeScale(-1, 1, 1));
    this.mirrored = mirror < 0;
  }

  /** Adds a geometry expressed in building-local space. */
  raw(mat: string, geo: THREE.BufferGeometry, uv: UVFn | null = UV_BOX): void {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g === geo) g = geo.clone();
    g.applyMatrix4(this.base);
    if (this.mirrored) flipWinding(g);
    if (uv) applyUV(g, uv);
    else if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    g.deleteAttribute('tangent');
    let list = this.buckets.get(mat);
    if (!list) this.buckets.set(mat, (list = []));
    list.push(g);
  }

  box(mat: string, size: V3, pos: V3, o: PieceOpts = {}): void {
    const geo = chamferBox(size[0], size[1], size[2], o.c ?? 0.03, o.segs ?? 1);
    _euler.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _pos.set(pos[0], pos[1], pos[2]);
    geo.applyMatrix4(new THREE.Matrix4().compose(_pos, _quat, _scl));
    this.raw(mat, geo, o.uv === undefined ? UV_BOX : o.uv);
  }

  /** Cylinder along Y unless rotated. */
  cyl(
    mat: string,
    rTop: number,
    rBot: number,
    h: number,
    pos: V3,
    o: PieceOpts & { seg?: number; open?: boolean; thetaStart?: number; thetaLength?: number } = {},
  ): void {
    const geo = new THREE.CylinderGeometry(
      rTop,
      rBot,
      h,
      o.seg ?? 12,
      1,
      o.open ?? false,
      o.thetaStart ?? 0,
      o.thetaLength ?? Math.PI * 2,
    );
    _euler.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _pos.set(pos[0], pos[1], pos[2]);
    geo.applyMatrix4(new THREE.Matrix4().compose(_pos, _quat, _scl));
    this.raw(mat, geo, o.uv === undefined ? UV_BOX : o.uv);
  }

  /** Flat quad facing a wall face's outward direction. */
  quad(mat: string, or: Orient, w: number, h: number, pos: V3, uv: UVFn | null = UV_BOX, segX = 1, segY = 1): THREE.BufferGeometry {
    const geo = new THREE.PlaneGeometry(w, h, segX, segY);
    const ry = or === 'S' ? 0 : or === 'N' ? Math.PI : or === 'E' ? Math.PI / 2 : -Math.PI / 2;
    geo.rotateY(ry);
    geo.translate(pos[0], pos[1], pos[2]);
    this.raw(mat, geo, uv);
    return geo;
  }

  merge(): Map<string, THREE.BufferGeometry> {
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      if (merged) {
        merged.computeBoundingSphere();
        out.set(key, merged);
      }
      for (const g of list) g.dispose();
    }
    this.buckets.clear();
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Wall faces and openings                                             */
/* ------------------------------------------------------------------ */

type Orient = 'S' | 'N' | 'E' | 'W';

interface Face {
  o: Orient;
  /** Coordinate of the outer surface: z for S/N, x for E/W. */
  outer: number;
}

/** Local (along-wall, height, outward-from-face) -> building space. */
function fpos(f: Face, u: number, y: number, n: number): V3 {
  switch (f.o) {
    case 'S':
      return [u, y, f.outer + n];
    case 'N':
      return [u, y, f.outer - n];
    case 'E':
      return [f.outer + n, y, u];
    default:
      return [f.outer - n, y, u];
  }
}

function fsize(f: Face, du: number, dy: number, dn: number): V3 {
  return f.o === 'S' || f.o === 'N' ? [du, dy, dn] : [dn, dy, du];
}

/** Rotation about the wall's own along-axis (for tilted sills). */
function ftilt(f: Face, a: number): PieceOpts {
  return f.o === 'S' ? { rx: a } : f.o === 'N' ? { rx: -a } : f.o === 'E' ? { rz: -a } : { rz: a };
}

interface Opening {
  u: number;
  y: number;
  w: number;
  h: number;
}

interface WallCfg {
  f: Face;
  uMin: number;
  uMax: number;
  yMin: number;
  yMax: number;
  t: number;
  ops?: Opening[];
  mat: string;
}

/**
 * A wall is one extruded slab with its openings as real holes in the profile.
 *
 * The obvious alternative — tiling the wall out of boxes around each opening —
 * leaves coplanar seams that z-fight and chamfer grooves that print a grid
 * across the facade. Extruding a shape with holes gives one watertight solid,
 * a bevel that runs continuously around every jamb, head and sill, and reveals
 * that are exactly as deep as the wall is thick.
 */
function buildWall(kit: Kit, c: WallCfg): void {
  // The shape's local +x maps to world +u for S/W and world -u for N/E.
  const sgn = c.f.o === 'N' || c.f.o === 'E' ? -1 : 1;
  const a = sgn > 0 ? c.uMin : -c.uMax;
  const b = sgn > 0 ? c.uMax : -c.uMin;

  const shape = new THREE.Shape();
  shape.moveTo(a, c.yMin);
  shape.lineTo(b, c.yMin);
  shape.lineTo(b, c.yMax);
  shape.lineTo(a, c.yMax);
  shape.closePath();

  for (const o of c.ops ?? []) {
    const cu = sgn * o.u;
    const p = new THREE.Path();
    p.moveTo(cu - o.w / 2, o.y);
    p.lineTo(cu - o.w / 2, o.y + o.h);
    p.lineTo(cu + o.w / 2, o.y + o.h);
    p.lineTo(cu + o.w / 2, o.y);
    p.closePath();
    shape.holes.push(p);
  }

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: c.t,
    bevelEnabled: true,
    bevelSize: 0.03,
    bevelThickness: 0.03,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1,
  });
  switch (c.f.o) {
    case 'S':
      geo.translate(0, 0, c.f.outer - c.t);
      break;
    case 'N':
      geo.rotateY(Math.PI);
      geo.translate(0, 0, c.f.outer + c.t);
      break;
    case 'E':
      geo.rotateY(Math.PI / 2);
      geo.translate(c.f.outer - c.t, 0, 0);
      break;
    default:
      geo.rotateY(-Math.PI / 2);
      geo.translate(c.f.outer + c.t, 0, 0);
      break;
  }
  kit.raw(c.mat, geo, UV_BOX);
}

/* ------------------------------------------------------------------ */
/* Window unit                                                         */
/* ------------------------------------------------------------------ */

interface WindowCfg {
  f: Face;
  u: number;
  y: number;
  w: number;
  h: number;
  t: number;
  cols?: number;
  rows?: number;
  /** Depth of the faked interior volume. Small for the lab (real room behind). */
  roomDepth?: number;
  curtain?: boolean;
  shutters?: boolean;
  sill?: boolean;
  room: Room;
  matTrim: string;
  matStone?: string;
}

function windowUnit(kit: Kit, c: WindowCfg): void {
  const { f, u, y, w, h, t } = c;
  const cols = c.cols ?? 2;
  const rows = c.rows ?? 2;
  const cy = y + h / 2;
  const trim = c.matTrim;

  // --- outer architrave ------------------------------------------------
  const AW = 0.115;
  const AD = 0.085;
  kit.box(trim, fsize(f, AW, h + AW * 2, AD), fpos(f, u - w / 2 - AW / 2 + 0.02, cy, AD / 2 - 0.03), { c: 0.028 });
  kit.box(trim, fsize(f, AW, h + AW * 2, AD), fpos(f, u + w / 2 + AW / 2 - 0.02, cy, AD / 2 - 0.03), { c: 0.028 });
  kit.box(trim, fsize(f, w + AW * 2 + 0.1, 0.135, AD + 0.03), fpos(f, u, y + h + 0.055, AD / 2 - 0.02), { c: 0.03 });

  // --- sill ------------------------------------------------------------
  if (c.sill !== false) {
    const sm = c.matStone ?? trim;
    kit.box(
      sm,
      fsize(f, w + 0.42, 0.115, 0.36),
      fpos(f, u, y - 0.03, 0.09),
      { c: 0.035, ...ftilt(f, -0.05) },
    );
    // Two little brackets under it.
    for (const s of [-1, 1]) {
      kit.box(trim, fsize(f, 0.09, 0.16, 0.16), fpos(f, u + s * (w / 2 - 0.02), y - 0.16, 0.06), { c: 0.025 });
    }
  }

  // --- inner frame set into the reveal ---------------------------------
  const FD = 0.1; // frame depth
  const FN = -0.17; // frame centre, measured inward from the outer face
  const FW = 0.075;
  kit.box(trim, fsize(f, FW, h, FD), fpos(f, u - w / 2 + FW / 2, cy, FN), { c: 0.022 });
  kit.box(trim, fsize(f, FW, h, FD), fpos(f, u + w / 2 - FW / 2, cy, FN), { c: 0.022 });
  kit.box(trim, fsize(f, w, FW, FD), fpos(f, u, y + FW / 2, FN), { c: 0.022 });
  kit.box(trim, fsize(f, w, FW, FD), fpos(f, u, y + h - FW / 2, FN), { c: 0.022 });

  const iw = w - FW * 2;
  const ih = h - FW * 2;
  for (let i = 1; i < cols; i++) {
    kit.box(trim, fsize(f, 0.055, ih, FD - 0.012), fpos(f, u - iw / 2 + (iw * i) / cols, cy, FN), { c: 0.016 });
  }
  for (let j = 1; j < rows; j++) {
    kit.box(trim, fsize(f, iw, 0.055, FD - 0.012), fpos(f, u, y + FW + (ih * j) / rows, FN), { c: 0.016 });
  }

  // --- glass -----------------------------------------------------------
  kit.quad('glass', f.o, iw + 0.02, ih + 0.02, fpos(f, u, cy, FN - 0.012), null);

  // --- faked interior --------------------------------------------------
  const depth = c.roomDepth ?? 1.0;
  const n0 = FN - FD / 2 - 0.01;
  fakeRoom(kit, f, u, cy, w + 0.02, h + 0.02, n0, depth, c.room);

  const ry = f.o === 'S' ? 0 : f.o === 'N' ? Math.PI : f.o === 'E' ? Math.PI / 2 : -Math.PI / 2;

  // --- net curtain -----------------------------------------------------
  if (c.curtain) {
    const cg = new THREE.PlaneGeometry(iw - 0.02, ih * 0.98, 12, 2);
    const p = cg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, Math.sin(x * 9.5 + c.room.variant) * 0.022 - 0.02);
    }
    cg.computeVertexNormals();
    cg.rotateY(ry);
    const cc = fpos(f, u, cy, FN - 0.075);
    cg.translate(cc[0], cc[1], cc[2]);
    kit.raw('curtain', cg, UV_BOX);
  }

  // --- shutters --------------------------------------------------------
  if (c.shutters) {
    for (const s of [-1, 1]) {
      const su = u + s * (w / 2 + 0.2);
      kit.box(trim, fsize(f, 0.34, h + 0.04, 0.07), fpos(f, su, cy, 0.075), { c: 0.02 });
      for (let i = 0; i < 5; i++) {
        const ly = y + 0.14 + ((h - 0.28) * i) / 4;
        kit.box(trim, fsize(f, 0.27, 0.062, 0.055), fpos(f, su, ly, 0.115), { c: 0.014, ...ftilt(f, 0.34) });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Doors                                                               */
/* ------------------------------------------------------------------ */

interface DoorCfg {
  f: Face;
  u: number;
  y: number;
  w: number;
  h: number;
  t: number;
  matTrim: string;
  matStone: string;
  /** Paint for the leaves; falls back to the trim colour. */
  matDoor?: string;
  /** Two leaves instead of one, with a transom light above. */
  double?: boolean;
  glazed?: boolean;
  /** Glazed light over a single leaf — gives a shaded porch something to lift. */
  fanlight?: boolean;
  /** Interiors seen through each glazed leaf. */
  rooms?: Room[];
  /** Interior seen through the transom / fanlight. */
  transomRoom?: Room;
}

/** Per-window interior: which atlas room, and how its lamp is burning. */
interface Room {
  variant: number;
  /** Multiplies both the room albedo and its emissive, via vertex colour. */
  tint: V3;
}

/** Flat vertex colour, so a merged bucket can carry per-piece tinting. */
function paintVertexColor(geo: THREE.BufferGeometry, c: V3): void {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c[0];
    arr[i * 3 + 1] = c[1];
    arr[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/**
 * Room chooser. `order` is authored per building so the rooms you can actually
 * see are the ones worth seeing, and the brightness/warmth draw on top makes two
 * windows showing the same room still read as two different rooms.
 *
 * The lab was the reason this exists. Sixteen openings in a regular grid, all
 * the same size, all the same frame: the only variable left is what is behind
 * the glass, so it has to carry the whole load.
 */
function roomPicker(rng: () => number, order: readonly number[]): () => Room {
  let i = 0;
  return () => {
    const variant = order[i++ % order.length];
    // 5 and 8 are the cold rooms (monitor, glassware); never warm them up.
    const cold = variant === 5 || variant === 8 || variant === 14;
    const b = rangeOf(rng, 0.68, 1.1);
    const wm = cold ? rangeOf(rng, -0.16, -0.06) : rangeOf(rng, -0.05, 0.09);
    return { variant, tint: [b * (1 + wm * 0.85), b, b * (1 - wm * 1.7)] };
  };
}

const NO_ROOM: Room = { variant: 0, tint: [1, 1, 1] };

/**
 * Drops a lit interior behind an opening: a back-faced shell plus one of the
 * sixteen rooms from the atlas. Every piece of glass in the town gets one,
 * because glass with nothing behind it reads as a hole punched in the model.
 *
 * The atlas is 4x4. This used to index it as if it were 2x2 — every "room" was
 * therefore a half-scale collage of four of them, which is precisely why the
 * lab's windows read as a repeating grid of little warm blocks instead of
 * sixteen rooms. One cell per window, and the variety the atlas already had
 * finally reaches the screen.
 */
function fakeRoom(
  kit: Kit,
  f: Face,
  u: number,
  y: number,
  w: number,
  h: number,
  n: number,
  depth: number,
  room: Room,
): void {
  const ry = f.o === 'S' ? 0 : f.o === 'N' ? Math.PI : f.o === 'E' ? Math.PI / 2 : -Math.PI / 2;
  const shell = new THREE.BoxGeometry(w + 0.12, h + 0.12, depth);
  const sc = fpos(f, u, y, n - depth / 2);
  if (f.o === 'E' || f.o === 'W') shell.rotateY(Math.PI / 2);
  shell.translate(sc[0], sc[1], sc[2]);
  // The reveal walls sit off to the side of the lamp, so they read a shade
  // deeper than the back panel they frame.
  paintVertexColor(shell, [room.tint[0] * 0.86, room.tint[1] * 0.86, room.tint[2] * 0.9]);
  kit.raw('roomShell', shell, UV_BOX);

  const back = new THREE.PlaneGeometry(w + 0.11, h + 0.11);
  back.rotateY(ry);
  const bc = fpos(f, u, y, n - depth + 0.02);
  back.translate(bc[0], bc[1], bc[2]);
  atlasCell(back, room.variant);
  paintVertexColor(back, room.tint);
  kit.raw('roomBack', back, null);
}

/** Remaps a plane's 0..1 UVs onto one cell of the 4x4 interior atlas. */
function atlasCell(geo: THREE.BufferGeometry, variant: number): void {
  const cell = 1 / ROOM_GRID;
  const vi = ((variant % ROOM_COUNT) + ROOM_COUNT) % ROOM_COUNT;
  const cx = (vi % ROOM_GRID) * cell;
  const cy = Math.floor(vi / ROOM_GRID) * cell;
  const inset = cell * 0.05;
  const span = cell - inset * 2;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, cx + inset + uv.getX(i) * span, cy + inset + uv.getY(i) * span);
  }
}

/* ------------------------------------------------------------------ */
/* Wear decals                                                         */
/* ------------------------------------------------------------------ */

/**
 * A water stain, a dirt splash or a patch of moss, as one alpha-masked quad.
 *
 * A tidy seaside village still shows where the water goes, and where it goes is
 * completely predictable: a grey fan under every sill, a long weep below the
 * gutter joint, a flecked splash line at the foot of the wall, and moss in the
 * one roof valley that never sees the sun. All of it shares `stainMaterial`, so
 * the whole town's weathering is a single draw call and the hue lives in the
 * vertex colour.
 *
 * `kind` picks which half of the mask atlas is sampled: vertical streaks for
 * water, soft blotches for moss and splash-back.
 */
function stainDecal(
  kit: Kit,
  w: number,
  h: number,
  pos: V3,
  rot: { rx?: number; ry?: number; rz?: number },
  kind: 'streak' | 'blotch',
  tint: V3,
  aTop: number,
  aBot: number,
  seed: number,
): void {
  const rng = makeRng(seed);
  const geo = new THREE.PlaneGeometry(w, h, 3, 5);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 4);
  // Sub-window into the mask so no two decals in town show the same blotch.
  const u0 = kind === 'streak' ? 0.02 : 0.52;
  const vh = 0.4 + rng() * 0.55;
  const v0 = rng() * (1 - vh);
  const uh = 0.3 + rng() * 0.16;
  const uo = rng() * (0.46 - uh);
  for (let i = 0; i < p.count; i++) {
    const fx = p.getX(i) / w + 0.5;
    const fy = p.getY(i) / h + 0.5;
    uv.setXY(i, u0 + uo + fx * uh, v0 + fy * vh);
    // Fade at both sides and at the far end so the quad's own rectangle never
    // shows; the mask alone would leave hard vertical edges.
    const edge = smoothstep(0, 0.26, fx) * smoothstep(1, 0.74, fx);
    const a = clamp(aBot + (aTop - aBot) * fy * fy, 0, 1) * edge;
    col[i * 4] = tint[0];
    col[i * 4 + 1] = tint[1];
    col[i * 4 + 2] = tint[2];
    col[i * 4 + 3] = a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  _euler.set(rot.rx ?? 0, rot.ry ?? 0, rot.rz ?? 0, 'YXZ');
  _quat.setFromEuler(_euler);
  _pos.set(pos[0], pos[1], pos[2]);
  geo.applyMatrix4(new THREE.Matrix4().compose(_pos, _quat, _scl));
  kit.raw('stain', geo, null);
}

/** Yaw that puts a decal flat on a given wall face. */
function faceYaw(o: Orient): number {
  return o === 'S' ? 0 : o === 'N' ? Math.PI : o === 'E' ? Math.PI / 2 : -Math.PI / 2;
}

/** Water weep hanging below a sill or a gutter, on a wall face. */
function weep(kit: Kit, f: Face, u: number, yTop: number, w: number, h: number, seed: number, strength = 1): void {
  const c = fpos(f, u, yTop - h / 2, 0.012);
  stainDecal(kit, w, h, c, { ry: faceYaw(f.o) }, 'streak', [0.5, 0.5, 0.46], 0.62 * strength, 0.02, seed);
}

/** Rain splash-back at the foot of a wall. */
function splash(kit: Kit, f: Face, u: number, yBot: number, w: number, h: number, seed: number): void {
  const c = fpos(f, u, yBot + h / 2, 0.012);
  stainDecal(kit, w, h, c, { ry: faceYaw(f.o) }, 'blotch', [0.62, 0.56, 0.45], 0.1, 0.5, seed);
}

/**
 * Moss on a roof slope. `side` is -1/+1 on the axis perpendicular to the ridge;
 * the quad is laid in the plane of the pitch, which is why the rotation is
 * derived from the slope rather than authored.
 */
function roofMoss(
  kit: Kit,
  axis: 'x' | 'z',
  side: number,
  slope: number,
  pos: V3,
  w: number,
  h: number,
  seed: number,
  alpha = 0.5,
): void {
  const theta = Math.atan(slope);
  // A plane faces +Z; rx = theta - 90deg lays it on the +perpendicular pitch.
  const t = side > 0 ? theta - Math.PI / 2 : -Math.PI / 2 - theta;
  const rot = axis === 'x' ? { rx: t } : { rx: t, ry: Math.PI / 2 };
  stainDecal(kit, w, h, pos, rot, 'blotch', [0.42, 0.55, 0.3], alpha, alpha * 0.35, seed);
}

function doorUnit(kit: Kit, c: DoorCfg): void {
  const { f, u, y, w, h, t } = c;
  const trim = c.matTrim;
  const door = c.matDoor ?? c.matTrim;
  const SET = -0.2; // leaf face, inward from the wall face

  // Architrave and a heavy head with a keystone.
  const AW = 0.14;
  kit.box(trim, fsize(f, AW, h + 0.16, 0.1), fpos(f, u - w / 2 - AW / 2 + 0.02, y + h / 2, 0.03), { c: 0.03 });
  kit.box(trim, fsize(f, AW, h + 0.16, 0.1), fpos(f, u + w / 2 + AW / 2 - 0.02, y + h / 2, 0.03), { c: 0.03 });
  kit.box(trim, fsize(f, w + AW * 2 + 0.12, 0.17, 0.14), fpos(f, u, y + h + 0.085, 0.045), { c: 0.032 });
  kit.box(c.matStone, fsize(f, 0.26, 0.3, 0.16), fpos(f, u, y + h + 0.12, 0.055), { c: 0.03 });

  const leaves = c.double ? 2 : 1;
  const transom = c.double ? 0.62 : c.fanlight ? 0.52 : 0;
  const leafH = h - transom - 0.04;
  const leafW = (w - 0.06) / leaves - 0.02;
  const LEAF_T = 0.075;

  for (let i = 0; i < leaves; i++) {
    const lu = u + (leaves === 1 ? 0 : (i - 0.5) * (leafW + 0.035));

    if (c.glazed) {
      // A glazed leaf is a frame, not a slab with a picture on it. Stiles,
      // rails and a bottom panel enclose a genuine opening, so the glass has
      // depth behind it and the lobby light actually comes through — the
      // earlier version drew glass *behind* a solid leaf and read as a plank.
      const gh = leafH * 0.46;
      const gy = y + leafH - gh / 2 - 0.2;
      const gw = leafW - 0.26;
      const stile = (leafW - gw) / 2;
      const railTop = y + leafH - (gy + gh / 2);
      const lockY = gy - gh / 2;

      for (const s of [-1, 1]) {
        kit.box(door, fsize(f, stile, leafH, LEAF_T), fpos(f, lu + s * (leafW - stile) / 2, y + leafH / 2 + 0.02, SET), { c: 0.022 });
      }
      kit.box(door, fsize(f, gw, railTop, LEAF_T), fpos(f, lu, y + leafH + 0.02 - railTop / 2, SET), { c: 0.022 });
      kit.box(door, fsize(f, gw, 0.22, LEAF_T), fpos(f, lu, lockY - 0.09, SET), { c: 0.022 });
      const panelH = lockY - 0.2 - (y + 0.02);
      kit.box(door, fsize(f, gw, panelH, LEAF_T), fpos(f, lu, y + 0.02 + panelH / 2, SET), { c: 0.022 });
      // Raised bolection moulding on the panel.
      kit.box(door, fsize(f, gw - 0.12, panelH - 0.14, 0.03), fpos(f, lu, y + 0.02 + panelH / 2, SET + 0.05), { c: 0.02 });

      kit.quad('glass', f.o, gw, gh, fpos(f, lu, gy, SET - 0.02), null);
      kit.box(door, fsize(f, 0.045, gh, 0.05), fpos(f, lu, gy, SET), { c: 0.012 });
      for (let m = 1; m < 3; m++) {
        kit.box(door, fsize(f, gw, 0.045, 0.05), fpos(f, lu, gy - gh / 2 + (gh * m) / 3, SET), { c: 0.012 });
      }
      fakeRoom(kit, f, lu, gy, gw, gh, SET - 0.06, 1.4, c.rooms?.[i] ?? NO_ROOM);
    } else {
      kit.box(door, fsize(f, leafW, leafH, LEAF_T), fpos(f, lu, y + leafH / 2 + 0.02, SET), { c: 0.024 });
      // Four recessed panels, proud mouldings around each.
      for (let p = 0; p < 2; p++) {
        const ph = p === 0 ? leafH * 0.34 : leafH * 0.4;
        const py = p === 0 ? y + leafH * 0.24 : y + leafH * 0.7;
        kit.box(door, fsize(f, leafW - 0.16, ph, 0.028), fpos(f, lu, py, SET + 0.048), { c: 0.02 });
        kit.box(door, fsize(f, leafW - 0.26, ph - 0.1, 0.02), fpos(f, lu, py, SET + 0.058), { c: 0.016 });
      }
    }

    // Handle: backplate, lever and an escutcheon.
    const hu = leaves === 1 ? lu + leafW / 2 - 0.14 : lu + (i === 0 ? leafW / 2 - 0.12 : -leafW / 2 + 0.12);
    if (c.double) {
      kit.cyl('metal', 0.028, 0.028, leafH * 0.42, fpos(f, hu, y + leafH * 0.55, SET - 0.12), { seg: 10 });
      for (const s of [-1, 1]) {
        kit.cyl('metal', 0.022, 0.022, 0.12, fpos(f, hu, y + leafH * 0.55 + s * leafH * 0.2, SET - 0.06), {
          seg: 8,
          ...ftilt(f, Math.PI / 2),
        });
      }
    } else {
      kit.box('metal', fsize(f, 0.11, 0.19, 0.035), fpos(f, hu, y + 1.02, SET - 0.055), { c: 0.02 });
      kit.cyl('metal', 0.028, 0.028, 0.16, fpos(f, hu, y + 1.02, SET - 0.09), { seg: 10, ...ftilt(f, Math.PI / 2) });
      kit.cyl('metal', 0.035, 0.035, 0.02, fpos(f, hu, y + 0.78, SET - 0.06), { seg: 10, ...ftilt(f, Math.PI / 2) });
      // Letter plate.
      kit.box('metal', fsize(f, 0.3, 0.07, 0.03), fpos(f, u, y + leafH * 0.52, SET - 0.052), { c: 0.012 });
    }
  }

  if (transom > 0) {
    // Transom / fanlight over the door. The shell alone left a black slot over
    // the lab doors, so it gets a lit back panel like every other opening.
    const ty = y + h - transom / 2 - 0.02;
    const gw = w - 0.2;
    const gh = transom - 0.16;
    kit.quad('glass', f.o, gw, gh, fpos(f, u, ty, SET - 0.04), null);
    kit.box(trim, fsize(f, w - 0.1, 0.07, 0.09), fpos(f, u, y + h - transom, SET - 0.02), { c: 0.018 });
    const bars = c.double ? 4 : 3;
    for (let i = 1; i < bars; i++) {
      kit.box(trim, fsize(f, 0.05, gh, 0.07), fpos(f, u - gw / 2 + (gw * i) / bars, ty, SET - 0.02), { c: 0.014 });
    }
    fakeRoom(kit, f, u, ty, gw, gh, SET - 0.07, 1.1, c.transomRoom ?? NO_ROOM);
  }

  // Threshold, flush with the ground so the player never clips a step.
  kit.box(c.matStone, fsize(f, w + 0.5, 0.09, 0.62), fpos(f, u, y + 0.035, 0.16), { c: 0.03 });
  kit.box(c.matStone, fsize(f, w + 1.0, 0.06, 0.5), fpos(f, u, y + 0.015, 0.68), { c: 0.025 });
}

/* ------------------------------------------------------------------ */
/* Roof                                                                */
/* ------------------------------------------------------------------ */

interface RoofCfg {
  axis: 'x' | 'z';
  /** Perpendicular coordinate of the ridge. */
  ridgeAt: number;
  ridgeY: number;
  /** Ridge to eave edge, measured on the perpendicular axis. */
  halfSpan: number;
  slope: number;
  /** Extent along the ridge. */
  from: number;
  to: number;
  /** Slab thickness measured perpendicular to the pitch. */
  thick: number;
  matRoof: string;
  matTrim: string;
  /** Runs of fascia/gutter along each eave; defaults to the whole length. */
  runs?: [number, number][];
  gutter?: boolean;
  /**
   * Stretches of eave where the gutter is interrupted because something else
   * crosses it — a porch roof, a dormer. Without this the metal run ploughs
   * straight through the porch tiles and re-emerges in mid-air on the far side.
   * `side` is -1 / +1 on the perpendicular axis, matching the eave being run.
   */
  gutterGaps?: { side: number; a: number; b: number }[];
  barge?: boolean;
  ridgeCap?: boolean;
  /** Proud bottom tile course along each eave. */
  eaveCourse?: boolean;
  /** Half-extent of the wall below, perpendicular to the ridge. Boxes the eaves. */
  wallHalf?: number;
  /** Wall extent along the ridge, for the rake soffits. */
  wallEnds?: [number, number];
}

function buildRoof(kit: Kit, c: RoofCfg): { eaveY: number; tv: number } {
  const sec = Math.sqrt(1 + c.slope * c.slope);
  const tv = c.thick * sec;
  const eaveY = c.ridgeY - c.halfSpan * c.slope;
  const len = c.to - c.from;
  const uv = uvRoof(c.axis, c.ridgeAt, c.slope);

  // --- slab -------------------------------------------------------------
  const shape = new THREE.Shape();
  shape.moveTo(-c.halfSpan, eaveY - tv);
  shape.lineTo(c.halfSpan, eaveY - tv);
  shape.lineTo(c.halfSpan, eaveY);
  shape.lineTo(0, c.ridgeY);
  shape.lineTo(-c.halfSpan, eaveY);
  shape.closePath();

  const slab = new THREE.ExtrudeGeometry(shape, {
    depth: len,
    bevelEnabled: true,
    bevelSize: 0.035,
    bevelThickness: 0.035,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 1,
  });
  if (c.axis === 'x') {
    slab.rotateY(Math.PI / 2);
    slab.translate(c.from, 0, c.ridgeAt);
  } else {
    slab.translate(c.ridgeAt, 0, c.from);
  }
  kit.raw(c.matRoof, slab, uv);

  // --- ridge cap --------------------------------------------------------
  if (c.ridgeCap !== false) {
    const size: V3 = c.axis === 'x' ? [len + 0.05, 0.19, 0.46] : [0.46, 0.19, len + 0.05];
    const pos: V3 =
      c.axis === 'x'
        ? [(c.from + c.to) / 2, c.ridgeY - 0.03, c.ridgeAt]
        : [c.ridgeAt, c.ridgeY - 0.03, (c.from + c.to) / 2];
    kit.box(c.matRoof, size, pos, { c: 0.07, segs: 2, uv });
  }

  const runs = c.runs ?? [[c.from, c.to]];
  const theta = Math.atan(c.slope);

  // --- boxed eaves ------------------------------------------------------
  // Without a soffit the underside of the overhang shows roof tile, which is
  // the single most common tell of a roof modelled as a slab. A horizontal
  // soffit plus the fascia closes the eave the way a real one is closed.
  if (c.wallHalf !== undefined) {
    const over = c.halfSpan - c.wallHalf;
    if (over > 0.08) {
      for (const side of [-1, 1]) {
        const p = c.ridgeAt + side * (c.wallHalf + over / 2);
        for (const [a, b] of runs) {
          const size: V3 = c.axis === 'x' ? [b - a, 0.07, over + 0.12] : [over + 0.12, 0.07, b - a];
          const pos: V3 = c.axis === 'x' ? [(a + b) / 2, eaveY - tv + 0.02, p] : [p, eaveY - tv + 0.02, (a + b) / 2];
          kit.box(c.matTrim, size, pos, { c: 0.02 });
        }
      }
    }
  }
  if (c.wallEnds) {
    const slopeLen = c.halfSpan * sec;
    for (const side of [-1, 1]) {
      const mid = c.ridgeAt + (side * c.halfSpan) / 2;
      const my = c.ridgeY - (c.halfSpan / 2) * c.slope - tv - 0.03;
      for (const [end, dir] of [
        [c.wallEnds[0], -1],
        [c.wallEnds[1], 1],
      ] as [number, number][]) {
        const over = dir > 0 ? c.to - end : end - c.from;
        if (over < 0.08) continue;
        if (c.axis === 'x') {
          kit.box(c.matTrim, [over + 0.05, 0.07, slopeLen], [end + (dir * over) / 2, my, mid], {
            c: 0.02,
            rx: side > 0 ? theta : -theta,
          });
        } else {
          kit.box(c.matTrim, [slopeLen, 0.07, over + 0.05], [mid, my, end + (dir * over) / 2], {
            c: 0.02,
            rz: side > 0 ? -theta : theta,
          });
        }
      }
    }
  }

  for (const side of [-1, 1]) {
    const p = c.ridgeAt + side * (c.halfSpan + 0.045);
    for (const [a, b] of runs) {
      // --- eave course ---------------------------------------------------
      // The bottom row of tiles oversails everything below it. Without this
      // the roof terminates in the slab's own chamfer, which reads as a cut
      // edge; with it the eave throws a hard 4 cm shadow onto the fascia and
      // the roof finally has thickness at the exact place the eye checks.
      if (c.eaveCourse !== false) {
        const q = c.halfSpan - 0.15;
        const lipY = c.ridgeY - q * c.slope + 0.055;
        const lipPos = c.ridgeAt + side * q;
        const size: V3 = c.axis === 'x' ? [b - a, 0.1, 0.4] : [0.4, 0.1, b - a];
        const pos: V3 = c.axis === 'x' ? [(a + b) / 2, lipY, lipPos] : [lipPos, lipY, (a + b) / 2];
        kit.box(c.matRoof, size, pos, {
          c: 0.03,
          uv,
          ...(c.axis === 'x'
            ? { rx: side > 0 ? theta : -theta }
            : { rz: side > 0 ? -theta : theta }),
        });
      }

      // --- fascia board -------------------------------------------------
      const fSize: V3 = c.axis === 'x' ? [b - a, tv + 0.13, 0.085] : [0.085, tv + 0.13, b - a];
      const fPos: V3 =
        c.axis === 'x' ? [(a + b) / 2, eaveY - tv / 2 - 0.03, p] : [p, eaveY - tv / 2 - 0.03, (a + b) / 2];
      kit.box(c.matTrim, fSize, fPos, { c: 0.026 });

      // --- gutter -------------------------------------------------------
      if (c.gutter) {
        // Cut the run wherever something crosses this eave, then lay each
        // surviving stretch separately with its own end brackets, so every
        // length of metal both starts and stops against real structure.
        let spans: [number, number][] = [[a, b]];
        for (const gap of c.gutterGaps ?? []) {
          if (gap.side !== side) continue;
          const next: [number, number][] = [];
          for (const [s0, s1] of spans) {
            if (gap.b <= s0 || gap.a >= s1) {
              next.push([s0, s1]);
              continue;
            }
            if (gap.a > s0) next.push([s0, gap.a]);
            if (gap.b < s1) next.push([gap.b, s1]);
          }
          spans = next;
        }
        // `along` puts a point at distance s down the run; `perp` is the eave's
        // own axis. Written this way the same run works for a ridge along x
        // (eaves facing north and south) and one along z (eaves east and west),
        // which is what lets the two cottages have different ridge directions.
        const alongZ = c.axis === 'z';
        const at = (s: number, y: number, off: number): V3 =>
          alongZ ? [p + side * off, y, s] : [s, y, p + side * off];
        for (const [s0, s1] of spans) {
          const runLen = s1 - s0;
          if (runLen < 0.35) continue;
          const g = new THREE.CylinderGeometry(0.085, 0.085, runLen - 0.05, 10, 1, true, 0, Math.PI);
          g.rotateZ(-Math.PI / 2);
          if (alongZ) g.rotateY(-Math.PI / 2);
          const gc = at((s0 + s1) / 2, eaveY - tv - 0.09, 0.075);
          g.translate(gc[0], gc[1], gc[2]);
          kit.raw('metal', g, UV_BOX);
          // Capped ends: an open pipe mouth reads as a modelling mistake.
          for (const e of [s0, s1]) {
            const ec = at(e + (e === s0 ? 0.012 : -0.012), eaveY - tv - 0.075, 0.075);
            kit.box('metal', alongZ ? [0.19, 0.185, 0.03] : [0.03, 0.185, 0.19], ec, { c: 0.012 });
          }
          const n = Math.max(1, Math.round(runLen / 1.9));
          for (let i = 0; i <= n; i++) {
            const bc = at(s0 + (runLen * i) / n, eaveY - tv - 0.05, 0.055);
            kit.box('metal', alongZ ? [0.24, 0.1, 0.05] : [0.05, 0.1, 0.24], bc, { c: 0.015 });
          }
        }
      }
    }

    // --- barge boards along the rakes ---------------------------------
    if (c.barge !== false) {
      const slopeLen = c.halfSpan * sec;
      for (const end of [c.from, c.to]) {
        const dir = end === c.from ? -1 : 1;
        const mid = c.ridgeAt + (side * c.halfSpan) / 2;
        const my = c.ridgeY - (c.halfSpan / 2) * c.slope - tv / 2 - 0.06;
        if (c.axis === 'x') {
          kit.box(
            c.matTrim,
            [0.09, 0.32, slopeLen],
            [end + dir * 0.05, my, mid],
            { c: 0.025, rx: side > 0 ? theta : -theta },
          );
        } else {
          kit.box(
            c.matTrim,
            [slopeLen, 0.32, 0.09],
            [mid, my, end + dir * 0.05],
            { c: 0.025, rz: side > 0 ? -theta : theta },
          );
        }
      }
    }
  }

  return { eaveY, tv };
}

/** Gable infill triangle between the wall head and the roof underside. */
function gableWall(
  kit: Kit,
  mat: string,
  axis: 'x' | 'z',
  at: number,
  t: number,
  ridgeAt: number,
  ridgeY: number,
  slope: number,
  tv: number,
  wallTop: number,
  outward: number,
  ops?: Opening[],
): void {
  const pEdge = (ridgeY - tv - wallTop) / slope;
  if (pEdge <= 0.05) return;
  const shape = new THREE.Shape();
  shape.moveTo(-pEdge, wallTop - 0.09);
  shape.lineTo(pEdge, wallTop - 0.09);
  shape.lineTo(0, ridgeY - tv + 0.03);
  shape.closePath();
  // An apex casement is a real hole in the gable, so it gets the same reveal
  // depth as every other opening in town.
  for (const o of ops ?? []) {
    const q = new THREE.Path();
    q.moveTo(o.u - o.w / 2, o.y);
    q.lineTo(o.u - o.w / 2, o.y + o.h);
    q.lineTo(o.u + o.w / 2, o.y + o.h);
    q.lineTo(o.u + o.w / 2, o.y);
    q.closePath();
    shape.holes.push(q);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: t,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  if (axis === 'x') {
    geo.rotateY(Math.PI / 2);
    geo.translate(at - (outward > 0 ? t : 0), 0, ridgeAt);
  } else {
    geo.translate(ridgeAt, 0, at - (outward > 0 ? t : 0));
  }
  kit.raw(mat, geo, UV_BOX);
}

/* ------------------------------------------------------------------ */
/* Chimney, vents, dish                                                */
/* ------------------------------------------------------------------ */

/**
 * External gable-end stack: breast, weathered shoulder, shaft, corbelled cap.
 *
 * A chimney drawn as one prism from ground to sky is a chimney-shaped hole in
 * the silhouette — it was the loudest fault on the cottages. A real stack steps
 * twice: a broad breast up to eaves height, a sloped stone weathering that
 * sheds water off the shoulder, then a slimmer shaft. Those two set-offs are
 * what let the eye read height, and they cost eight boxes.
 */
function chimney(
  kit: Kit,
  matBrick: string,
  matStone: string,
  matPot: string,
  x: number,
  z: number,
  base: number,
  shoulder: number,
  top: number,
  w: number,
  d: number,
  pots: number,
): void {
  const bw = w + 0.4;
  const bd = d + 0.24;

  // --- breast --------------------------------------------------------------
  kit.box(matBrick, [bw, shoulder - base, bd], [x, (base + shoulder) / 2, z], { c: 0.07, segs: 2 });
  // Splayed footing so it lands on the ground rather than stopping at it.
  kit.box(matStone, [bw + 0.2, 0.34, bd + 0.2], [x, base + 0.36, z], { c: 0.06, segs: 2 });
  kit.box(matStone, [bw + 0.1, 0.1, bd + 0.1], [x, base + 0.56, z], { c: 0.035 });

  // --- weathered shoulder --------------------------------------------------
  kit.box(matStone, [bw + 0.12, 0.14, bd + 0.12], [x, shoulder + 0.03, z], { c: 0.055 });
  kit.box(matBrick, [w + 0.2, 0.2, d + 0.16], [x, shoulder + 0.2, z], { c: 0.05 });

  // --- shaft ---------------------------------------------------------------
  const shaftBase = shoulder + 0.3;
  kit.box(matBrick, [w, top - shaftBase, d], [x, (shaftBase + top) / 2, z], { c: 0.055, segs: 2 });

  // --- corbelled cap -------------------------------------------------------
  kit.box(matBrick, [w + 0.13, 0.11, d + 0.13], [x, top - 0.045, z], { c: 0.03 });
  kit.box(matBrick, [w + 0.25, 0.12, d + 0.25], [x, top + 0.07, z], { c: 0.035 });
  kit.box(matStone, [w + 0.34, 0.11, d + 0.34], [x, top + 0.19, z], { c: 0.04 });

  for (let i = 0; i < pots; i++) {
    const px = x + (pots === 1 ? 0 : (i - (pots - 1) / 2) * (w * 0.46));
    kit.cyl(matPot, 0.115, 0.14, 0.46, [px, top + 0.47, z], { seg: 14 });
    kit.cyl(matPot, 0.145, 0.115, 0.1, [px, top + 0.74, z], { seg: 14 });
    kit.cyl(matPot, 0.085, 0.085, 0.06, [px, top + 0.79, z], { seg: 12 });
  }
}

function roofVent(kit: Kit, matTrim: string, x: number, y: number, z: number, w: number): void {
  kit.box(matTrim, [w, 0.34, w * 0.62], [x, y + 0.17, z], { c: 0.03 });
  for (let i = 0; i < 3; i++) {
    kit.box(matTrim, [w - 0.06, 0.055, w * 0.66], [x, y + 0.08 + i * 0.09, z], { c: 0.014, rx: 0.35 });
  }
  kit.box('metal', [w + 0.14, 0.055, w * 0.62 + 0.14], [x, y + 0.37, z], { c: 0.022 });
  kit.box('metal', [w * 0.55, 0.09, w * 0.4], [x, y + 0.43, z], { c: 0.03 });
}

function satelliteDish(kit: Kit, x: number, y: number, z: number, r: number, aim: number): void {
  // Mast and feet.
  kit.box('metal', [0.5, 0.08, 0.5], [x, y + 0.04, z], { c: 0.02 });
  kit.cyl('metal', 0.055, 0.065, 1.15, [x, y + 0.6, z], { seg: 10 });
  for (const s of [-1, 1]) {
    kit.box('metal', [0.045, 0.62, 0.045], [x + s * 0.18, y + 0.32, z], { c: 0.012, rz: s * 0.5 });
  }

  // Dish: a lathed paraboloid with a rolled rim, so it has real thickness.
  const pts: THREE.Vector2[] = [];
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * r;
    pts.push(new THREE.Vector2(Math.max(0.02, t), (t * t) / (r * 1.35)));
  }
  for (let i = N; i >= 0; i--) {
    const t = (i / N) * r;
    pts.push(new THREE.Vector2(Math.max(0.015, t * 0.985), (t * t) / (r * 1.35) - 0.045));
  }
  // Aimed south and up, so it presents its face to the town rather than its
  // rim. A dish seen edge-on is an unreadable grey disc, and this is the one
  // silhouette element that says "laboratory" from across the green.
  const el = Math.PI / 2 - 0.62; // ~36 deg above horizontal
  const dish = new THREE.LatheGeometry(pts, 26);
  dish.rotateX(el);
  dish.rotateY(aim);
  const cy = y + 1.32;
  dish.translate(x, cy, z);
  kit.raw('metal', dish, UV_BOX);

  // Feed arm and horn, on the dish axis.
  const ax = Math.sin(el) * Math.sin(aim);
  const ay = Math.cos(el);
  const az = Math.sin(el) * Math.cos(aim);
  kit.cyl('metal', 0.028, 0.028, r * 1.2, [x + ax * r * 0.55, cy + ay * r * 0.55, z + az * r * 0.55], {
    seg: 8,
    rx: el,
    ry: aim,
  });
  kit.box('metal', [0.14, 0.14, 0.17], [x + ax * r * 1.05, cy + ay * r * 1.05, z + az * r * 1.05], { c: 0.035 });
}

/* ------------------------------------------------------------------ */
/* Ground contact                                                      */
/* ------------------------------------------------------------------ */

/**
 * Dirt skirt: a draped decal ring around the footprint. Vertex alpha fades it
 * out, vertex colour carries a splash-back gradient, and every vertex samples
 * the terrain so it never floats over a slope.
 */
function dirtSkirt(
  ctx: GameContext,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  margin: number,
  seed: number,
): THREE.BufferGeometry {
  const rng = makeRng(seed);
  const nx = 30;
  const nz = 30;
  const W = (hx + margin) * 2;
  const D = (hz + margin) * 2;
  const geo = new THREE.PlaneGeometry(W, D, nx, nz);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 4);
  const jit: number[] = [];
  for (let i = 0; i < 64; i++) jit.push(rangeOf(rng, -1, 1));

  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const lz = pos.getZ(i);
    const wx = cx + lx;
    const wz = cz + lz;
    pos.setY(i, ctx.collision.groundHeight(wx, wz) + 0.018);

    // Distance outside the footprint, wobbled so the ring is never a rectangle.
    const wob =
      jit[(Math.abs(Math.round(lx * 2.3)) + Math.abs(Math.round(lz * 3.1)) * 7) % 64] * 0.34 +
      Math.sin(lx * 1.7 + lz * 2.3) * 0.22;
    const dx = Math.abs(lx) - hx;
    const dz = Math.abs(lz) - hz;
    const out = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
    const a = smoothstep(margin * 0.92 + wob, -0.25 + wob, out);
    const inside = smoothstep(0.0, -0.45, out);
    col[i * 4] = 1 - inside * 0.18;
    col[i * 4 + 1] = 1 - inside * 0.16;
    col[i * 4 + 2] = 1 - inside * 0.1;
    col[i * 4 + 3] = clamp(a * 0.82, 0, 1);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.translate(cx, 0, cz);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Cottage                                                             */
/* ------------------------------------------------------------------ */

interface CottageCfg {
  cx: number;
  cz: number;
  mirror: 1 | -1;
  w: number;
  d: number;
  wallH: number;
  rise: number;
  matWall: string;
  matTrim: string;
  matRoof: string;
  matDoor: string;
  seed: number;
  shutters: 'lower' | 'upper';
  pots: number;
  /** Local z of the gable-end chimney — keeps the two stacks off each other. */
  chimneyZ: number;
}

function buildCottage(kit: Kit, ctx: GameContext, c: CottageCfg): { top: number } {
  const rng = makeRng(c.seed);
  const g = ctx.collision.groundHeight(c.cx, c.cz);
  kit.origin(c.cx, g, c.cz, c.mirror);

  const W = c.w;
  const D = c.d;
  const T = 0.3;
  const PLINTH = 0.28;
  const wallTop = PLINTH + c.wallH;
  const ridgeY = wallTop + c.rise;
  const slope = c.rise / (D / 2);
  const theta0 = Math.atan(slope);
  const eaveOver = 0.6;
  const halfSpan = D / 2 + eaveOver;
  const gableOver = 0.34;

  const S: Face = { o: 'S', outer: D / 2 };
  const N: Face = { o: 'N', outer: -D / 2 };
  const E: Face = { o: 'E', outer: W / 2 };
  const Wf: Face = { o: 'W', outer: -W / 2 };

  // --- plinth -----------------------------------------------------------
  kit.box('stone', [W + 0.26, PLINTH + 0.55, D + 0.26], [0, PLINTH / 2 - 0.275, 0], { c: 0.055, segs: 2 });
  kit.box('stone', [W + 0.34, 0.1, D + 0.34], [0, PLINTH - 0.03, 0], { c: 0.035 });

  // --- openings ---------------------------------------------------------
  const doorW = 1.12;
  const doorH = 2.24;
  const gw = 1.16;
  const gh = 1.44;
  const uw = 1.02;
  const uh = 1.18;
  const gSill = PLINTH + 0.92;
  const uSill = PLINTH + 2.74;

  const frontOps: Opening[] = [
    { u: 0, y: PLINTH - 0.14, w: doorW, h: doorH },
    { u: -2.28, y: gSill, w: gw, h: gh },
    { u: 2.16, y: gSill, w: gw, h: gh },
    { u: -1.62, y: uSill, w: uw, h: uh },
    { u: 1.58, y: uSill, w: uw, h: uh },
  ];
  const backOps: Opening[] = [
    { u: -1.55, y: gSill, w: 1.24, h: 1.3 },
    { u: 1.35, y: uSill, w: 0.96, h: 1.04 },
  ];
  const eastOps: Opening[] = [
    { u: 1.05, y: gSill, w: 1.12, h: gh },
    { u: -0.85, y: uSill, w: 0.92, h: 1.02 },
  ];
  const westOps: Opening[] = [
    { u: -1.15, y: gSill, w: 1.08, h: 1.3 },
    { u: 1.2, y: uSill, w: 0.92, h: 1.02 },
  ];

  const yBase = -0.35;
  buildWall(kit, { f: S, uMin: -W / 2, uMax: W / 2, yMin: yBase, yMax: wallTop, t: T, ops: frontOps, mat: c.matWall });
  buildWall(kit, { f: N, uMin: -W / 2, uMax: W / 2, yMin: yBase, yMax: wallTop, t: T, ops: backOps, mat: c.matWall });
  buildWall(kit, { f: E, uMin: -D / 2 + T, uMax: D / 2 - T, yMin: yBase, yMax: wallTop, t: T, ops: eastOps, mat: c.matWall });
  buildWall(kit, { f: Wf, uMin: -D / 2 + T, uMax: D / 2 - T, yMin: yBase, yMax: wallTop, t: T, ops: westOps, mat: c.matWall });

  // --- corner boards, skirting and belt course --------------------------
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.box(c.matTrim, [0.26, wallTop - 0.06, 0.26], [(sx * W) / 2, (wallTop + 0.06) / 2, (sz * D) / 2], {
        c: 0.035,
      });
    }
  }
  // Skirting board: grounds the box and catches a shadow at ankle height.
  // Split around the doorway rather than run across it.
  for (const [h, proud, yy] of [
    [0.42, 0.05, PLINTH + 0.16],
    [0.07, 0.09, PLINTH + 0.34],
  ] as [number, number, number][]) {
    kit.box(c.matTrim, [W + proud * 2, h, 0.12], [0, yy, -D / 2 - 0.01], { c: 0.026 });
    for (const sx of [-1, 1]) {
      kit.box(c.matTrim, [0.12, h, D + proud * 2], [sx * (W / 2 + 0.01), yy, 0], { c: 0.026 });
      const inner = doorW / 2 + 0.14;
      kit.box(
        c.matTrim,
        [W / 2 + proud - inner, h, 0.12],
        [sx * ((W / 2 + proud + inner) / 2), yy, D / 2 + 0.01],
        { c: 0.026 },
      );
    }
  }
  // String course. It runs at the height of the ground-floor window heads, so
  // it is deliberately *less* proud than a window architrave (0.04 against
  // 0.08): the band then reads as passing behind the joinery instead of two
  // pieces of trim fighting over the same 1 cm of wall.
  const belt = PLINTH + 2.3;
  kit.box(c.matTrim, [W + 0.08, 0.19, D + 0.08], [0, belt, 0], { c: 0.03 });
  kit.box(c.matTrim, [W + 0.13, 0.06, D + 0.13], [0, belt + 0.11, 0], { c: 0.02 });

  // Porch dimensions are needed up here so the main eave can be told where the
  // porch roof crosses it.
  const porchZ = D / 2;
  const porchOut = 1.42;
  const porchHalf = 1.46;
  const porchEave = PLINTH + 2.62;
  const porchRise = 0.92;

  // --- roof --------------------------------------------------------------
  const roof = buildRoof(kit, {
    axis: 'x',
    ridgeAt: 0,
    ridgeY,
    halfSpan,
    slope,
    from: -W / 2 - gableOver,
    to: W / 2 + gableOver,
    thick: 0.3,
    matRoof: c.matRoof,
    matTrim: c.matTrim,
    gutter: true,
    // The porch gable pushes through the south eave; the gutter stops either
    // side of it instead of skewering the tiles.
    gutterGaps: [{ side: 1, a: -porchHalf - 0.22, b: porchHalf + 0.22 }],
    ridgeCap: true,
    wallHalf: D / 2,
    wallEnds: [-W / 2, W / 2],
  });

  gableWall(kit, c.matWall, 'x', W / 2, T, 0, ridgeY, slope, roof.tv, wallTop, 1);
  gableWall(kit, c.matWall, 'x', -W / 2 + T, T, 0, ridgeY, slope, roof.tv, wallTop, -1);

  // Battens and a louvred vent in each gable.
  for (const sx of [-1, 1]) {
    const gx = (sx * W) / 2 + sx * 0.005;
    for (let i = -1; i <= 1; i++) {
      const p = i * 0.86;
      const hTop = ridgeY - roof.tv - Math.abs(p) * slope;
      if (hTop - wallTop < 0.2) continue;
      kit.box(c.matTrim, [0.07, hTop - wallTop + 0.1, 0.16], [gx, (wallTop + hTop) / 2, p], { c: 0.02 });
    }
    const vy = wallTop + (ridgeY - roof.tv - wallTop) * 0.42;
    kit.cyl(c.matTrim, 0.3, 0.3, 0.11, [gx + sx * 0.04, vy, 0], { seg: 16, rz: Math.PI / 2 });
    kit.cyl(c.matTrim, 0.23, 0.23, 0.14, [gx + sx * 0.02, vy, 0], { seg: 16, rz: Math.PI / 2 });
    for (let i = -1; i <= 1; i++) {
      kit.box(c.matTrim, [0.05, 0.05, 0.4], [gx + sx * 0.06, vy + i * 0.1, 0], { c: 0.012, rz: Math.PI / 2, rx: 0.3 });
    }
  }

  // --- windows -----------------------------------------------------------
  // Authored order, front elevation first: the two rooms the player stands in
  // front of every time they leave the house are the bedroom and the bookshelf.
  const room = roomPicker(rng, [13, 0, 10, 2, 3, 7, 15, 4, 11, 1]);
  const winDefaults = { t: T, matTrim: c.matTrim, matStone: 'stone' as string };

  // The upper sashes sit directly beneath the eave on the two long faces, and
  // the hard-coded 1.18 m height buried their architrave heads 5-22 cm inside
  // the roof soffit — the frame vanished into the tiles and what was left read
  // as a sill stuck to bare cladding. Derive the tallest head this roof can
  // actually clear rather than trusting a literal.
  const HEAD_OUT = 0.08; // how far the architrave head stands off the wall face
  const HEAD_TOP = 0.1225; // architrave top, above the opening
  const eaveHeadRoom = wallTop - roof.tv - HEAD_OUT * slope - 0.09;
  const uhEave = Math.max(0.62, Math.min(uh, eaveHeadRoom - uSill - HEAD_TOP));

  windowUnit(kit, {
    ...winDefaults,
    f: S,
    u: -2.28,
    y: gSill,
    w: gw,
    h: gh,
    cols: 2,
    rows: 2,
    room: room(),
    curtain: true,
    shutters: c.shutters === 'lower',
  });
  windowUnit(kit, {
    ...winDefaults,
    f: S,
    u: 2.16,
    y: gSill,
    w: gw,
    h: gh,
    cols: 2,
    rows: 2,
    room: room(),
    shutters: c.shutters === 'lower',
  });
  windowUnit(kit, {
    ...winDefaults,
    f: S,
    u: -1.62,
    y: uSill,
    w: uw,
    h: uhEave,
    cols: 2,
    rows: 1,
    room: room(),
    curtain: true,
    shutters: c.shutters === 'upper',
    roomDepth: 0.85,
  });
  windowUnit(kit, {
    ...winDefaults,
    f: S,
    u: 1.58,
    y: uSill,
    w: uw,
    h: uhEave,
    cols: 2,
    rows: 1,
    room: room(),
    shutters: c.shutters === 'upper',
    roomDepth: 0.85,
  });
  windowUnit(kit, { ...winDefaults, f: N, u: -1.55, y: gSill, w: 1.24, h: 1.3, cols: 2, rows: 2, room: room() });
  windowUnit(kit, { ...winDefaults, f: N, u: 1.35, y: uSill, w: 0.96, h: Math.min(1.04, uhEave), cols: 2, rows: 1, room: room(), roomDepth: 0.8 });
  windowUnit(kit, { ...winDefaults, f: E, u: 1.05, y: gSill, w: 1.12, h: gh, cols: 2, rows: 2, room: room(), curtain: true });
  windowUnit(kit, { ...winDefaults, f: E, u: -0.85, y: uSill, w: 0.92, h: 1.02, cols: 2, rows: 1, room: room(), roomDepth: 0.8 });
  windowUnit(kit, { ...winDefaults, f: Wf, u: -1.15, y: gSill, w: 1.08, h: 1.3, cols: 2, rows: 2, room: room() });
  windowUnit(kit, { ...winDefaults, f: Wf, u: 1.2, y: uSill, w: 0.92, h: 1.02, cols: 2, rows: 1, room: room(), curtain: true, roomDepth: 0.8 });

  // --- door and porch ----------------------------------------------------
  doorUnit(kit, {
    f: S,
    u: 0,
    y: PLINTH - 0.14,
    w: doorW,
    h: doorH,
    t: T,
    matTrim: c.matTrim,
    matDoor: c.matDoor,
    matStone: 'stone',
    fanlight: true,
    transomRoom: room(),
  });

  const porchRoof = buildRoof(kit, {
    axis: 'z',
    ridgeAt: 0,
    ridgeY: porchEave + porchRise,
    halfSpan: porchHalf,
    slope: porchRise / (porchHalf - 0.34),
    from: porchZ - 0.55,
    to: porchZ + porchOut,
    thick: 0.2,
    matRoof: c.matRoof,
    matTrim: c.matTrim,
    ridgeCap: true,
    barge: true,
  });
  // Pediment infill under the porch gable so it is not see-through.
  gableWall(kit, c.matTrim, 'z', porchZ + porchOut, 0.12, 0, porchEave + porchRise, porchRise / (porchHalf - 0.34), porchRoof.tv, porchEave - 0.35, 1);

  // Head beam, capitals and posts, stacked from the beam down so each piece
  // lands on the one below. Previously the capital's whole 12 cm sat inside the
  // 20 cm beam, so the posts appeared to run straight into the underside of a
  // board with no bearing detail at all.
  const beamY = porchEave - 0.44; // beam centre; its top tucks 1 cm into the pediment
  const beamBot = beamY - 0.1;
  const capY = beamBot - 0.06; // capital centre, top flush with the beam soffit
  const padTop = 0.2;
  kit.box(c.matTrim, [2.52, 0.2, 0.16], [0, beamY, porchZ + porchOut - 0.36], { c: 0.03 });

  for (const s of [-1, 1]) {
    const px = s * 1.02;
    const pz = porchZ + porchOut - 0.36;
    const postTop = capY - 0.04; // tenon 2 cm up into the capital
    kit.box(c.matTrim, [0.26, postTop - padTop + 0.06, 0.26], [px, (postTop + padTop - 0.06) / 2, pz], {
      c: 0.035,
      segs: 2,
    });
    kit.box(c.matTrim, [0.34, 0.12, 0.34], [px, capY, pz], { c: 0.03 });
    kit.box('stone', [0.42, 0.2, 0.42], [px, padTop / 2, pz], { c: 0.035 });
    // Knee brace from the post shaft up into the beam soffit.
    kit.box(c.matTrim, [0.09, 0.5, 0.5], [px, capY - 0.14, pz - 0.34], { c: 0.02, rx: -Math.PI / 4 });
  }

  // --- chimney -----------------------------------------------------------
  chimney(kit, 'brick', 'stone', c.matRoof, -W / 2 - 0.16, c.chimneyZ, -0.35, wallTop - 0.3, ridgeY + 0.95, 0.74, 0.66, c.pots);

  // --- downpipes ---------------------------------------------------------
  for (const s of [-1, 1]) {
    const px = s * (W / 2 - 0.16);
    const pz = D / 2 + 0.5;
    kit.cyl('metal', 0.055, 0.055, roof.eaveY - roof.tv - 0.35, [px, (roof.eaveY - roof.tv) / 2 + 0.05, pz], { seg: 10 });
    kit.cyl('metal', 0.075, 0.075, 0.1, [px, roof.eaveY - roof.tv - 0.28, pz], { seg: 10 });
    kit.cyl('metal', 0.06, 0.075, 0.3, [px, 0.2, pz - 0.08], { seg: 10, rx: 0.5 });
    for (let i = 0; i < 2; i++) {
      kit.box('metal', [0.13, 0.05, 0.16], [px, 0.9 + i * 1.5, pz - 0.08], { c: 0.015 });
    }
  }

  // --- wear ---------------------------------------------------------------
  // Where the water goes. Sills weep, the gutter joint over the east bay drips,
  // the wall foot takes splash-back off the path, and the one place the sun
  // never reaches — the valley where the porch gable dies into the main slope —
  // grows moss.
  const sillWeep: [Face, number, number, number][] = [
    [S, -2.28, gSill - 0.12, gw + 0.5],
    [S, 2.16, gSill - 0.12, gw + 0.5],
    [S, -1.62, uSill - 0.12, uw + 0.45],
    [S, 1.58, uSill - 0.12, uw + 0.45],
    [E, 1.05, gSill - 0.12, 1.5],
    [Wf, -1.15, gSill - 0.12, 1.45],
    [N, -1.55, gSill - 0.12, 1.6],
  ];
  sillWeep.forEach(([f, u, yTop, w], i) => weep(kit, f, u, yTop, w, 0.95, c.seed ^ (0x51 + i * 7), 0.85));
  // Gutter weeps: long, faint, starting under the fascia.
  weep(kit, S, 2.7, roof.eaveY - roof.tv - 0.05, 0.75, 2.4, c.seed ^ 0x9a1, 0.8);
  weep(kit, N, -2.5, roof.eaveY - roof.tv - 0.05, 0.62, 2.1, c.seed ^ 0x9a2, 0.6);
  for (const [f, u, w] of [
    [S, -2.6, 3.0],
    [S, 2.6, 3.0],
    [E, 0, D - 0.9],
    [Wf, 0, D - 0.9],
    [N, 0, W - 1.2],
  ] as [Face, number, number][]) {
    splash(kit, f, u, PLINTH + 0.12, w, 0.62, c.seed ^ (0x2c0 + Math.round(u * 10) + w));
  }
  // Moss in the porch valley, both sides of the porch gable, where the main
  // slope is shaded by the porch tiles all morning.
  for (const s of [-1, 1]) {
    const mz = D / 2 - 0.12;
    roofMoss(kit, 'x', 1, slope, [s * (porchHalf + 0.38), ridgeY - mz * slope + 0.055, mz], 0.95, 1.25, c.seed ^ (0x4d0 + s), 0.44);
  }

  // --- a slipped tile at the east eave ------------------------------------
  // One course-end tile has worked loose and sits proud and askew. It is two
  // boxes, it is only visible from the porch, and it is the difference between a
  // roof that was laid and a roof that was modelled.
  {
    const q = halfSpan - 0.32;
    const ty = ridgeY - q * slope + 0.1;
    kit.box(c.matRoof, [0.42, 0.075, 0.4], [W / 2 - 0.9, ty + 0.05, q], {
      c: 0.02,
      uv: uvRoof('x', 0, slope),
      rx: theta0 - 0.16,
      ry: 0.09,
    });
    kit.box(c.matRoof, [0.4, 0.07, 0.38], [W / 2 - 1.36, ty - 0.03, q - 0.05], {
      c: 0.02,
      uv: uvRoof('x', 0, slope),
      rx: theta0 + 0.1,
      ry: -0.06,
    });
  }

  return { top: ridgeY + 1.6 };
}

/* ------------------------------------------------------------------ */
/* Rival's cottage — a front-gabled cottage by a different hand         */
/* ------------------------------------------------------------------ */

interface GableCottageCfg {
  cx: number;
  cz: number;
  w: number;
  d: number;
  wallH: number;
  /** Ridge height above the wall head. Sets the pitch: rise / (w / 2). */
  rise: number;
  matWall: string;
  matTrim: string;
  matRoof: string;
  matDoor: string;
  seed: number;
  /** Local x of the rear-gable stack. */
  chimneyX: number;
}

/**
 * The rival's cottage.
 *
 * The two houses used to be one asset mirrored — same pitch, same ridge
 * direction, same massing, same window rhythm, same porch. In a real village
 * two neighbours share a *vernacular*, not a plan, so everything here is
 * deliberately a different decision by a different builder working from the
 * same pattern book:
 *
 *  - the ridge runs **north-south**, so the road sees a gable end, not an eaves
 *    front, and the roof reads as a triangle against the sky rather than a slab;
 *  - the pitch is **shallower** (about 35 deg against the player's 42), which is
 *    what stops the two silhouettes rhyming even at this distance;
 *  - the door is **off-centre** under a mono-pitch hood on knee brackets rather
 *    than centred under a gabled portico on stone-padded posts;
 *  - the fenestration is **asymmetric**: one wide triple light, one single, and
 *    a small casement in the apex, instead of a symmetric pair over a pair;
 *  - the base course is **brick** rather than rubble stone, matching its stack;
 *  - the joinery is painted **sage**, and the gable is boarded and battened.
 */
function buildGableCottage(kit: Kit, ctx: GameContext, c: GableCottageCfg): { top: number } {
  const rng = makeRng(c.seed);
  const g = ctx.collision.groundHeight(c.cx, c.cz);
  kit.origin(c.cx, g, c.cz, 1);

  const W = c.w;
  const D = c.d;
  const T = 0.3;
  const PLINTH = 0.34;
  const wallTop = PLINTH + c.wallH;
  const ridgeY = wallTop + c.rise;
  const slope = c.rise / (W / 2);
  const theta = Math.atan(slope);
  const eaveOver = 0.66;
  const halfSpan = W / 2 + eaveOver;
  const gableOver = 0.44;

  const S: Face = { o: 'S', outer: D / 2 };
  const N: Face = { o: 'N', outer: -D / 2 };
  const E: Face = { o: 'E', outer: W / 2 };
  const Wf: Face = { o: 'W', outer: -W / 2 };

  // --- brick base course --------------------------------------------------
  kit.box('brick', [W + 0.3, PLINTH + 0.55, D + 0.3], [0, PLINTH / 2 - 0.275, 0], { c: 0.05, segs: 2 });
  kit.box('stone', [W + 0.4, 0.11, D + 0.4], [0, PLINTH - 0.02, 0], { c: 0.04 });

  // --- openings -----------------------------------------------------------
  const doorW = 1.16;
  const doorH = 2.3;
  const doorU = -1.98;
  const gSill = PLINTH + 0.95;
  const uSill = PLINTH + 2.8;
  const tw = 2.24; // triple light
  const th = 1.5;
  const atticY = wallTop + 0.28;
  const atticW = 0.92;
  const atticH = 0.82;

  // The gable front can carry a taller upper window than the eaves sides, where
  // the head has to duck under the roof soffit.
  const uhEave = Math.max(0.62, Math.min(1.16, wallTop - 0.3 * Math.sqrt(1 + slope * slope) - 0.09 - uSill - 0.13));

  const frontOps: Opening[] = [
    { u: doorU, y: PLINTH - 0.14, w: doorW, h: doorH },
    { u: 1.5, y: gSill, w: tw, h: th },
    { u: doorU, y: uSill, w: 1.02, h: 1.3 },
    { u: 1.5, y: uSill, w: 1.5, h: 1.24 },
  ];
  const backOps: Opening[] = [
    { u: -1.5, y: gSill, w: 1.22, h: 1.38 },
    { u: 0.0, y: uSill, w: 1.0, h: 1.24 },
  ];
  const eastOps: Opening[] = [
    { u: -1.2, y: gSill, w: 1.14, h: th },
    { u: 1.35, y: uSill, w: 0.94, h: uhEave },
  ];
  const westOps: Opening[] = [
    { u: 1.4, y: gSill, w: 1.1, h: 1.34 },
    { u: -1.25, y: uSill, w: 0.94, h: uhEave },
  ];

  const yBase = -0.35;
  buildWall(kit, { f: S, uMin: -W / 2, uMax: W / 2, yMin: yBase, yMax: wallTop, t: T, ops: frontOps, mat: c.matWall });
  buildWall(kit, { f: N, uMin: -W / 2, uMax: W / 2, yMin: yBase, yMax: wallTop, t: T, ops: backOps, mat: c.matWall });
  buildWall(kit, { f: E, uMin: -D / 2 + T, uMax: D / 2 - T, yMin: yBase, yMax: wallTop, t: T, ops: eastOps, mat: c.matWall });
  buildWall(kit, { f: Wf, uMin: -D / 2 + T, uMax: D / 2 - T, yMin: yBase, yMax: wallTop, t: T, ops: westOps, mat: c.matWall });

  // --- corner boards and skirting ----------------------------------------
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.box(c.matTrim, [0.3, wallTop - 0.06, 0.3], [(sx * W) / 2, (wallTop + 0.06) / 2, (sz * D) / 2], { c: 0.04 });
    }
  }
  for (const [h, proud, yy] of [
    [0.38, 0.05, PLINTH + 0.14],
    [0.08, 0.1, PLINTH + 0.31],
  ] as [number, number, number][]) {
    kit.box(c.matTrim, [W + proud * 2, h, 0.12], [0, yy, -D / 2 - 0.01], { c: 0.026 });
    for (const sx of [-1, 1]) {
      kit.box(c.matTrim, [0.12, h, D + proud * 2], [sx * (W / 2 + 0.01), yy, 0], { c: 0.026 });
    }
    // Front run stops either side of the doorway.
    for (const [a, b] of [
      [-W / 2 - proud, doorU - doorW / 2 - 0.14],
      [doorU + doorW / 2 + 0.14, W / 2 + proud],
    ] as [number, number][]) {
      kit.box(c.matTrim, [b - a, h, 0.12], [(a + b) / 2, yy, D / 2 + 0.01], { c: 0.026 });
    }
  }
  // A single deep string course under the first-floor sills — one band, not the
  // player's cornice-and-fillet pair.
  const belt = uSill - 0.24;
  kit.box(c.matTrim, [W + 0.1, 0.24, D + 0.1], [0, belt, 0], { c: 0.035 });

  // --- roof (ridge north-south) -------------------------------------------
  const roof = buildRoof(kit, {
    axis: 'z',
    ridgeAt: 0,
    ridgeY,
    halfSpan,
    slope,
    from: -D / 2 - gableOver,
    to: D / 2 + gableOver,
    thick: 0.3,
    matRoof: c.matRoof,
    matTrim: c.matTrim,
    gutter: true,
    ridgeCap: true,
    wallHalf: W / 2,
    wallEnds: [-D / 2, D / 2],
  });

  // Front and rear gables. The front one carries the apex casement.
  gableWall(kit, c.matWall, 'z', D / 2, T, 0, ridgeY, slope, roof.tv, wallTop, 1, [
    { u: 0, y: atticY, w: atticW, h: atticH },
  ]);
  gableWall(kit, c.matWall, 'z', -D / 2 + T, T, 0, ridgeY, slope, roof.tv, wallTop, -1);

  // Board-and-batten in both gable fields: vertical, close-spaced, and stopped
  // on a moulded ledge at the wall head.
  for (const [zAt, sz] of [
    [D / 2 + 0.012, 1],
    [-D / 2 - 0.012, -1],
  ] as [number, number][]) {
    kit.box(c.matTrim, [(ridgeY - roof.tv - wallTop) / slope * 2 + 0.4, 0.16, 0.2], [0, wallTop + 0.02, zAt], { c: 0.03 });
    for (let i = -4; i <= 4; i++) {
      const px = i * 0.42;
      const hTop = ridgeY - roof.tv - Math.abs(px) * slope - 0.04;
      if (hTop - wallTop < 0.22) continue;
      if (Math.abs(px) < atticW / 2 + 0.22 && wallTop < atticY + atticH + 0.2) {
        // Battens interrupted by the casement: run only above its head.
        const yb = atticY + atticH + 0.24;
        if (hTop - yb < 0.18) continue;
        kit.box(c.matTrim, [0.09, hTop - yb, 0.11], [px, (yb + hTop) / 2, zAt], { c: 0.018 });
        continue;
      }
      kit.box(c.matTrim, [0.09, hTop - wallTop - 0.02, 0.11], [px, (wallTop + hTop) / 2, zAt], { c: 0.018 });
    }
    // Apex finial block.
    kit.box(c.matTrim, [0.2, 0.46, 0.16], [0, ridgeY - roof.tv + 0.1, zAt], { c: 0.035, segs: 2 });
    kit.cyl(c.matTrim, 0.09, 0.11, 0.16, [0, ridgeY - roof.tv + 0.4, zAt + sz * 0.01], { seg: 10 });
  }

  // --- windows ------------------------------------------------------------
  const room = roomPicker(rng, [7, 3, 12, 1, 15, 11, 6, 2, 10, 4]);
  const wd = { t: T, matTrim: c.matTrim, matStone: 'stone' as string };
  windowUnit(kit, { ...wd, f: S, u: 1.5, y: gSill, w: tw, h: th, cols: 3, rows: 2, room: room(), curtain: true });
  windowUnit(kit, { ...wd, f: S, u: doorU, y: uSill, w: 1.02, h: 1.3, cols: 2, rows: 2, room: room() });
  windowUnit(kit, { ...wd, f: S, u: 1.5, y: uSill, w: 1.5, h: 1.24, cols: 3, rows: 2, room: room(), curtain: true });
  windowUnit(kit, {
    ...wd,
    f: { o: 'S', outer: D / 2 },
    u: 0,
    y: atticY,
    w: atticW,
    h: atticH,
    cols: 2,
    rows: 1,
    room: room(),
    roomDepth: 0.7,
    sill: true,
  });
  windowUnit(kit, { ...wd, f: N, u: -1.5, y: gSill, w: 1.22, h: 1.38, cols: 2, rows: 2, room: room() });
  windowUnit(kit, { ...wd, f: N, u: 0.0, y: uSill, w: 1.0, h: 1.24, cols: 2, rows: 2, room: room(), roomDepth: 0.8 });
  windowUnit(kit, { ...wd, f: E, u: -1.2, y: gSill, w: 1.14, h: th, cols: 2, rows: 2, room: room(), shutters: true });
  windowUnit(kit, { ...wd, f: E, u: 1.35, y: uSill, w: 0.94, h: uhEave, cols: 2, rows: 1, room: room(), roomDepth: 0.8 });
  windowUnit(kit, { ...wd, f: Wf, u: 1.4, y: gSill, w: 1.1, h: 1.34, cols: 2, rows: 2, room: room(), shutters: true });
  windowUnit(kit, { ...wd, f: Wf, u: -1.25, y: uSill, w: 0.94, h: uhEave, cols: 2, rows: 1, room: room(), curtain: true, roomDepth: 0.8 });

  // --- door and mono-pitch hood -------------------------------------------
  doorUnit(kit, {
    f: S,
    u: doorU,
    y: PLINTH - 0.14,
    w: doorW,
    h: doorH,
    t: T,
    matTrim: c.matTrim,
    matDoor: c.matDoor,
    matStone: 'stone',
    transomRoom: room(),
  });

  {
    const hoodZ = D / 2;
    const out = 1.24;
    const tilt = 0.42;
    const yHigh = PLINTH + 2.72;
    const ledger = yHigh + 0.02;
    kit.box(c.matTrim, [2.62, 0.2, 0.12], [doorU, ledger, hoodZ + 0.06], { c: 0.03 });
    // Slab, pitched away from the wall.
    const midZ = hoodZ + out / 2 + 0.08;
    const midY = yHigh - Math.sin(tilt) * (out / 2) - 0.06;
    kit.box(c.matRoof, [2.5, 0.16, out + 0.34], [doorU, midY, midZ], {
      c: 0.035,
      rx: tilt,
      uv: uvRoof('x', hoodZ - 1.0, Math.tan(tilt)),
    });
    // Proud bottom course and a fascia to close it.
    const lowZ = hoodZ + out + 0.15;
    const lowY = yHigh - Math.sin(tilt) * (out + 0.1) - 0.03;
    kit.box(c.matRoof, [2.56, 0.1, 0.36], [doorU, lowY + 0.07, lowZ - 0.02], {
      c: 0.028,
      rx: tilt,
      uv: uvRoof('x', hoodZ - 1.0, Math.tan(tilt)),
    });
    kit.box(c.matTrim, [2.62, 0.19, 0.08], [doorU, lowY - 0.06, lowZ + 0.14], { c: 0.024 });
    // Knee brackets instead of posts — nothing to walk into.
    for (const s of [-1, 1]) {
      const bx = doorU + s * 1.06;
      kit.box(c.matTrim, [0.11, 0.86, 0.86], [bx, ledger - 0.56, hoodZ + 0.42], { c: 0.022, rx: -Math.PI / 4 });
      kit.box(c.matTrim, [0.15, 0.14, 0.2], [bx, ledger - 0.14, hoodZ + 0.1], { c: 0.02 });
    }
  }

  // --- chimney on the rear gable ------------------------------------------
  chimney(kit, 'brick', 'stone', c.matRoof, c.chimneyX, -D / 2 - 0.2, -0.35, wallTop - 0.35, ridgeY + 0.82, 0.68, 0.6, 1);

  // --- gutters' downpipes at the two front corners ------------------------
  const gutY = roof.eaveY - roof.tv - 0.09;
  for (const s of [-1, 1]) {
    const gx = s * (halfSpan + 0.045);
    const px = s * (W / 2 + 0.1);
    const pz = D / 2 - 0.42;
    // Swan neck back to the wall face.
    const dx = gx - px;
    const dy = 0.34;
    const len = Math.hypot(dx, dy);
    kit.cyl('metal', 0.055, 0.055, len + 0.1, [(gx + px) / 2, gutY - dy / 2, pz], {
      seg: 10,
      rz: -s * Math.atan2(Math.abs(dx), dy),
    });
    kit.cyl('metal', 0.06, 0.06, gutY - dy - 0.25, [px, (gutY - dy) / 2 + 0.1, pz], { seg: 10 });
    kit.cyl('metal', 0.062, 0.078, 0.3, [px, 0.22, pz + 0.09], { seg: 10, rx: -0.5 });
    for (let i = 0; i < 2; i++) kit.box('metal', [0.16, 0.05, 0.13], [px + s * 0.02, 0.95 + i * 1.5, pz], { c: 0.015 });
  }

  // --- wear ---------------------------------------------------------------
  const sillWeep: [Face, number, number, number][] = [
    [S, 1.5, gSill - 0.12, tw + 0.5],
    [S, doorU, uSill - 0.12, 1.4],
    [S, 1.5, uSill - 0.12, 1.9],
    [E, -1.2, gSill - 0.12, 1.5],
    [Wf, 1.4, gSill - 0.12, 1.5],
    [N, -1.5, gSill - 0.12, 1.6],
  ];
  sillWeep.forEach(([f, u, yTop, w], i) => weep(kit, f, u, yTop, w, 0.9, c.seed ^ (0x71 + i * 11), 0.8));
  weep(kit, E, 0.6, gutY + 0.02, 0.68, 2.3, c.seed ^ 0xb11, 0.85);
  weep(kit, Wf, -1.9, gutY + 0.02, 0.6, 2.0, c.seed ^ 0xb12, 0.6);
  for (const [f, u, w] of [
    [S, -2.4, 3.2],
    [S, 2.0, 3.4],
    [E, 0, D - 0.9],
    [Wf, 0, D - 0.9],
    [N, -0.6, W - 1.4],
  ] as [Face, number, number][]) {
    splash(kit, f, u, PLINTH + 0.1, w, 0.58, c.seed ^ (0x3c0 + Math.round(u * 10) + w));
  }
  // Moss where the door hood dies into the wall — the shadiest metre of the
  // whole cottage — and a patch low on the sheltered west pitch.
  stainDecal(kit, 2.4, 0.5, fpos(S, doorU, PLINTH + 2.62, 0.014), { ry: 0 }, 'blotch', [0.44, 0.54, 0.33], 0.42, 0.1, c.seed ^ 0xd01);
  roofMoss(kit, 'z', -1, slope, [-(halfSpan - 0.55), ridgeY - (halfSpan - 0.55) * slope + 0.06, -0.4], 1.1, 1.5, c.seed ^ 0xd02, 0.4);

  return { top: ridgeY + 1.5 };
}

/* ------------------------------------------------------------------ */
/* Oak's laboratory                                                    */
/* ------------------------------------------------------------------ */

function buildLab(kit: Kit, ctx: GameContext): { top: number; g: number } {
  const L = BUILDINGS.lab;
  const g = ctx.collision.groundHeight(L.cx, L.cz);
  kit.origin(L.cx, g, L.cz, 1);
  const rng = makeRng(0x1a71 ^ 991);

  const W = L.w;
  const D = L.d;
  const T = 0.42;
  const BASE = 1.05; // stone base course
  const wallTop = 7.1;
  const rise = 2.85;
  const slope = rise / (D / 2);
  const eaveOver = 0.55;
  const halfSpan = D / 2 + eaveOver;
  const gableOver = 0.6;

  const S: Face = { o: 'S', outer: D / 2 };
  const N: Face = { o: 'N', outer: -D / 2 };
  const E: Face = { o: 'E', outer: W / 2 };
  const Wf: Face = { o: 'W', outer: -W / 2 };

  // --- window layout -----------------------------------------------------
  const bayHalf = 2.75;
  const doorW = 2.62;
  const doorH = 3.4;
  const bayFront = D / 2 + 0.75;

  // --- stone base course --------------------------------------------------
  // A ring rather than a solid: the lab is a shell the player walks into, so
  // nothing may protrude into the room, and the doorway needs a clear run.
  const ringW = T + 0.32;
  const baseRing = (h: number, y: number, out: number, cham: number) => {
    const ox = W / 2 + out;
    const oz = D / 2 + out;
    kit.box('stone', [ox * 2, h, ringW], [0, y, -oz + ringW / 2], { c: cham, segs: 2 });
    for (const sx of [-1, 1]) {
      kit.box('stone', [ringW, h, oz * 2 - ringW * 2], [sx * (ox - ringW / 2), y, 0], { c: cham, segs: 2 });
      const inner = doorW / 2 + 0.22;
      kit.box('stone', [ox - inner, h, ringW], [sx * ((ox + inner) / 2), y, oz - ringW / 2], { c: cham, segs: 2 });
      // The bay's own base returns, either side of the doorway.
      kit.box('stone', [ox - inner - (ox - bayHalf - 0.15), h, 1.1], [sx * ((bayHalf + 0.15 + inner) / 2), y, oz + 0.42], {
        c: cham,
        segs: 2,
      });
    }
  };
  baseRing(BASE + 0.6, BASE / 2 - 0.3, 0.15, 0.07);
  baseRing(0.15, BASE + 0.02, 0.29, 0.045);
  // Moulded copings on the two pedestals flanking the entrance, so they read
  // as built pedestals rather than the stub ends of a wall that stopped.
  for (const sx of [-1, 1]) {
    kit.box('stone', [1.52, 0.13, 1.26], [sx * 2.215, BASE + 0.15, D / 2 + 0.57], { c: 0.055, segs: 2 });
    kit.box('stone', [1.34, 0.09, 1.08], [sx * 2.215, BASE + 0.25, D / 2 + 0.57], { c: 0.04 });
  }
  const lowY = BASE + 0.35;
  const lowH = 2.35;
  const upY = BASE + 3.55;
  const upH = 1.5;
  const lowW = 1.4;
  const upW = 1.28;

  const frontXs = [-5.35, -3.55, 3.55, 5.35];
  const frontOps: Opening[] = [
    // The doorway carries on through the main wall behind the entrance bay.
    { u: 0, y: -0.6, w: doorW + 0.12, h: doorH + 0.66 },
  ];
  for (const x of frontXs) {
    frontOps.push({ u: x, y: lowY, w: lowW, h: lowH });
    frontOps.push({ u: x, y: upY, w: upW, h: upH });
  }
  const sideOps: Opening[] = [
    { u: -2.5, y: lowY, w: lowW, h: lowH },
    { u: 1.0, y: lowY, w: lowW, h: lowH },
    { u: -2.5, y: upY, w: upW, h: upH },
    { u: 1.0, y: upY, w: upW, h: upH },
  ];
  const backOps: Opening[] = [
    { u: -3.4, y: lowY, w: lowW, h: lowH },
    { u: 3.4, y: lowY, w: lowW, h: lowH },
    { u: 0, y: upY, w: upW, h: upH },
  ];

  const yBase = -0.7;
  buildWall(kit, { f: S, uMin: -W / 2, uMax: W / 2, yMin: yBase, yMax: wallTop, t: T, ops: frontOps, mat: 'wallC' });
  buildWall(kit, { f: N, uMin: -W / 2, uMax: W / 2, yMin: yBase, yMax: wallTop, t: T, ops: backOps, mat: 'wallC' });
  buildWall(kit, { f: E, uMin: -D / 2 + T, uMax: D / 2 - T, yMin: yBase, yMax: wallTop, t: T, ops: sideOps, mat: 'wallC' });
  buildWall(kit, { f: Wf, uMin: -D / 2 + T, uMax: D / 2 - T, yMin: yBase, yMax: wallTop, t: T, ops: sideOps, mat: 'wallC' });

  // --- pilasters and cornice band ---------------------------------------
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      kit.box('trimC', [0.36, wallTop - BASE + 0.3, 0.36], [(sx * W) / 2, (wallTop + BASE - 0.3) / 2, (sz * D) / 2], { c: 0.04 });
    }
  }
  const band = BASE + 3.05;
  kit.box('trimC', [W + 0.18, 0.26, D + 0.18], [0, band, 0], { c: 0.04 });
  kit.box('trimC', [W + 0.26, 0.08, D + 0.26], [0, band + 0.16, 0], { c: 0.025 });
  kit.box('trimC', [W + 0.22, 0.22, D + 0.22], [0, wallTop - 0.16, 0], { c: 0.04 });

  // --- roof ---------------------------------------------------------------
  const ridgeY = wallTop + rise;
  const roof = buildRoof(kit, {
    axis: 'x',
    ridgeAt: 0,
    ridgeY,
    halfSpan,
    slope,
    from: -W / 2 - gableOver,
    to: W / 2 + gableOver,
    thick: 0.34,
    matRoof: 'roofC',
    matTrim: 'trimC',
    gutter: true,
    runs: [
      [-W / 2 - gableOver, -bayHalf - 0.1],
      [bayHalf + 0.1, W / 2 + gableOver],
    ],
    wallHalf: D / 2,
    wallEnds: [-W / 2, W / 2],
  });
  gableWall(kit, 'wallC', 'x', W / 2, T, 0, ridgeY, slope, roof.tv, wallTop, 1);
  gableWall(kit, 'wallC', 'x', -W / 2 + T, T, 0, ridgeY, slope, roof.tv, wallTop, -1);
  for (const sx of [-1, 1]) {
    const gx = (sx * W) / 2 + sx * 0.01;
    const vy = wallTop + (ridgeY - roof.tv - wallTop) * 0.4;
    kit.cyl('trimC', 0.36, 0.36, 0.12, [gx + sx * 0.04, vy, 0], { seg: 18, rz: Math.PI / 2 });
    kit.cyl('trimC', 0.27, 0.27, 0.16, [gx + sx * 0.02, vy, 0], { seg: 18, rz: Math.PI / 2 });
    for (let i = -1; i <= 1; i++) {
      kit.box('trimC', [0.05, 0.055, 0.48], [gx + sx * 0.07, vy + i * 0.12, 0], { c: 0.012, rz: Math.PI / 2, rx: 0.3 });
    }
  }

  // --- entrance frontispiece ---------------------------------------------
  const bayTop = 7.55;
  const bayF: Face = { o: 'S', outer: bayFront };
  const roundY = 5.95;

  buildWall(kit, {
    f: bayF,
    uMin: -bayHalf,
    uMax: bayHalf,
    yMin: -0.6,
    yMax: bayTop,
    t: 0.4,
    ops: [
      { u: 0, y: -0.5, w: doorW, h: doorH + 0.5 },
      { u: 0, y: roundY - 0.62, w: 1.24, h: 1.24 },
    ],
    mat: 'wallC',
  });
  // Bay returns.
  for (const sx of [-1, 1]) {
    kit.box('wallC', [0.44, bayTop + 0.6, 1.2], [sx * (bayHalf - 0.22), bayTop / 2 - 0.3, D / 2 + 0.2], { c: 0.04 });
    kit.box('trimC', [0.34, bayTop, 0.34], [sx * (bayHalf - 0.06), bayTop / 2, bayFront - 0.16], { c: 0.045 });
  }

  // Cornice and pediment.
  kit.box('trimC', [bayHalf * 2 + 0.5, 0.28, 1.75], [0, bayTop + 0.14, D / 2 + 0.32], { c: 0.045 });
  kit.box('trimC', [bayHalf * 2 + 0.34, 0.14, 1.6], [0, bayTop + 0.34, D / 2 + 0.32], { c: 0.03 });
  const pedRise = 1.3;
  const pedHalf = bayHalf + 0.2;
  const pedSlope = pedRise / pedHalf;
  const ped = buildRoof(kit, {
    axis: 'z',
    ridgeAt: 0,
    ridgeY: bayTop + 0.42 + pedRise,
    halfSpan: pedHalf,
    slope: pedSlope,
    from: D / 2 - 0.35,
    to: bayFront + 0.12,
    thick: 0.22,
    matRoof: 'roofC',
    matTrim: 'trimC',
    ridgeCap: false,
    barge: false,
  });
  gableWall(kit, 'wallC', 'z', bayFront + 0.02, 0.16, 0, bayTop + 0.42 + pedRise, pedSlope, ped.tv, bayTop + 0.42, 1);
  for (const s of [-1, 1]) {
    kit.box(
      'trimC',
      [pedHalf * Math.sqrt(1 + pedSlope * pedSlope), 0.24, 0.16],
      [(s * pedHalf) / 2, bayTop + 0.42 + pedRise / 2 - 0.12, bayFront + 0.11],
      { c: 0.03, rz: s > 0 ? -Math.atan(pedSlope) : Math.atan(pedSlope) },
    );
  }

  // Round window in the pediment.
  kit.cyl('trimC', 0.78, 0.78, 0.16, [0, roundY, bayFront - 0.06], { seg: 26, rx: Math.PI / 2 });
  kit.cyl('trimC', 0.6, 0.6, 0.24, [0, roundY, bayFront - 0.14], { seg: 26, rx: Math.PI / 2 });
  for (let i = 0; i < 4; i++) {
    kit.box('trimC', [1.12, 0.055, 0.06], [0, roundY, bayFront - 0.2], { c: 0.014, rx: Math.PI / 2, rz: (i * Math.PI) / 4 });
  }
  kit.quad('glass', 'S', 1.15, 1.15, [0, roundY, bayFront - 0.24], null);
  {
    // The stair landing behind the pediment oculus: the tall cabinet, lit low.
    const oc: Room = { variant: 15, tint: [0.94, 0.9, 0.84] };
    const shell = new THREE.BoxGeometry(1.3, 1.3, 0.7);
    shell.translate(0, roundY, bayFront - 0.6);
    paintVertexColor(shell, [oc.tint[0] * 0.86, oc.tint[1] * 0.86, oc.tint[2] * 0.9]);
    kit.raw('roomShell', shell, UV_BOX);
    const back = new THREE.PlaneGeometry(1.28, 1.28);
    back.translate(0, roundY, bayFront - 0.93);
    atlasCell(back, oc.variant);
    paintVertexColor(back, oc.tint);
    kit.raw('roomBack', back, null);
  }

  // --- double doors -------------------------------------------------------
  doorUnit(kit, {
    f: bayF,
    u: 0,
    y: 0.0,
    w: doorW,
    h: doorH,
    t: 0.4,
    matTrim: 'trimC',
    matDoor: 'doorC',
    matStone: 'stone',
    double: true,
    glazed: true,
    rooms: [
      { variant: 6, tint: [1.02, 0.98, 0.9] },
      { variant: 12, tint: [0.96, 0.94, 0.9] },
    ],
    transomRoom: { variant: 14, tint: [0.9, 0.92, 0.98] },
  });

  // --- carriage lanterns flanking the doors --------------------------------
  // Two emissive lanterns, no lights: the bible caps the rig at five and the
  // entrance sits in its own porch shadow all morning. These give the darkest
  // part of the lab's most-viewed elevation two warm anchors.
  for (const s of [-1, 1]) {
    const lx = s * (bayHalf - 0.62);
    const ly = 2.72;
    const lz = bayFront - 0.02;
    kit.box('metal', [0.2, 0.34, 0.1], [lx, ly - 0.02, lz - 0.06], { c: 0.025 });
    kit.cyl('metal', 0.035, 0.035, 0.34, [lx, ly + 0.16, lz + 0.16], { seg: 8, rx: Math.PI / 2 - 0.5 });
    kit.cyl('lamp', 0.13, 0.16, 0.34, [lx, ly + 0.06, lz + 0.3], { seg: 8 });
    kit.cyl('metal', 0.19, 0.02, 0.2, [lx, ly + 0.32, lz + 0.3], { seg: 8 });
    kit.cyl('metal', 0.17, 0.17, 0.04, [lx, ly - 0.13, lz + 0.3], { seg: 8 });
    kit.cyl('metal', 0.03, 0.03, 0.09, [lx, ly + 0.45, lz + 0.3], { seg: 8 });
  }

  // --- windows ------------------------------------------------------------
  // The lab's fenestration is a regular grid of identical rectangles — that is
  // what a nineteenth-century institutional facade *is*, and restyling it would
  // lose the one building in town that reads as public rather than domestic. So
  // the variety has to come from behind the glass, and it is authored position
  // by position rather than drawn at random: the ground floor shows a glassware
  // bench, a rack of balls, a route chart and a half-drawn blind, left to right,
  // and the floor above shows a nearly-shut blind, a bookshelf, one room with
  // nobody in it and a tall cabinet. Brightness and warmth are jittered on top,
  // so even the two rooms with the same furniture burn different lamps.
  const wd = { t: T, matTrim: 'trimC', matStone: 'stone', roomDepth: 0.34 };
  const frontLow = roomPicker(rng, [8, 6, 12, 4]);
  const frontUp = roomPicker(rng, [9, 0, 14, 15]);
  const rest = roomPicker(rng, [11, 3, 7, 2, 10, 13, 1, 5]);
  frontXs.forEach((x, i) => {
    windowUnit(kit, { ...wd, f: S, u: x, y: lowY, w: lowW, h: lowH, cols: 2, rows: 3, room: frontLow() });
    windowUnit(kit, {
      ...wd,
      f: S,
      u: x,
      y: upY,
      w: upW,
      h: upH,
      cols: 2,
      rows: 2,
      room: frontUp(),
      curtain: i === 1 || i === 3,
    });
  });
  for (const f of [E, Wf]) {
    for (const o of sideOps) {
      windowUnit(kit, {
        ...wd,
        f,
        u: o.u,
        y: o.y,
        w: o.w,
        h: o.h,
        cols: 2,
        rows: o.h > 2 ? 3 : 2,
        room: rest(),
      });
    }
  }
  for (const o of backOps) {
    windowUnit(kit, { ...wd, f: N, u: o.u, y: o.y, w: o.w, h: o.h, cols: 2, rows: o.h > 2 ? 3 : 2, room: rest() });
  }

  // --- roof furniture ------------------------------------------------------
  const roofYAt = (z: number) => ridgeY - Math.abs(z) * slope;
  roofVent(kit, 'trimC', -3.4, roofYAt(0) - 0.12, 0, 0.62);
  roofVent(kit, 'trimC', 1.9, roofYAt(0) - 0.12, 0, 0.52);
  satelliteDish(kit, 4.35, roofYAt(1.9) - 0.1, 1.9, 0.8, -0.55);
  // Flue with a rain cap.
  kit.cyl('metal', 0.13, 0.15, 1.5, [-5.1, roofYAt(1.5) + 0.5, 1.5], { seg: 12 });
  kit.cyl('metal', 0.22, 0.19, 0.11, [-5.1, roofYAt(1.5) + 1.3, 1.5], { seg: 12 });
  kit.box('stone', [0.9, 0.55, 0.86], [-5.1, roofYAt(1.5) - 0.2, 1.5], { c: 0.05 });

  // --- downpipes -----------------------------------------------------------
  for (const sx of [-1, 1]) {
    const px = sx * (W / 2 - 0.24);
    const pz = D / 2 + 0.36;
    kit.cyl('metal', 0.07, 0.07, roof.eaveY - roof.tv - 0.4, [px, (roof.eaveY - roof.tv) / 2 + 0.1, pz], { seg: 10 });
    kit.cyl('metal', 0.09, 0.09, 0.12, [px, roof.eaveY - roof.tv - 0.32, pz], { seg: 10 });
    kit.cyl('metal', 0.075, 0.09, 0.34, [px, 0.24, pz - 0.09], { seg: 10, rx: 0.5 });
    for (let i = 0; i < 3; i++) kit.box('metal', [0.15, 0.06, 0.18], [px, 1.1 + i * 1.7, pz - 0.09], { c: 0.016 });
  }

  // --- wear -----------------------------------------------------------------
  // A public building gets cleaned; it still stains. Sills weep, the two gutter
  // outlets at the ends of the front run leave long faint streaks, the base
  // course takes splash off the forecourt, and moss sits in the two valleys the
  // entrance bay creates against the main slope.
  const lowSillY = lowY - 0.12;
  frontXs.forEach((x, i) => {
    weep(kit, S, x, lowSillY, lowW + 0.5, 1.05, 0x1a71 ^ (0x40 + i * 13), 0.75);
    weep(kit, S, x, upY - 0.12, upW + 0.42, 0.8, 0x1a71 ^ (0x60 + i * 17), 0.5);
  });
  for (const sx of [-1, 1]) {
    weep(kit, S, sx * (W / 2 - 0.9), roof.eaveY - roof.tv - 0.06, 0.8, 3.4, 0x1a71 ^ (0x90 + sx), 0.8);
    weep(kit, sx > 0 ? E : Wf, -2.5, roof.eaveY - roof.tv - 0.06, 0.7, 3.0, 0x1a71 ^ (0xa0 + sx), 0.55);
    splash(kit, S, sx * 4.3, BASE + 0.22, 3.6, 0.72, 0x1a71 ^ (0xb0 + sx));
    splash(kit, sx > 0 ? E : Wf, 0, BASE + 0.22, D - 1.2, 0.68, 0x1a71 ^ (0xc0 + sx));
    // Valleys either side of the entrance bay.
    const mz = D / 2 - 0.2;
    roofMoss(kit, 'x', 1, slope, [sx * (bayHalf + 0.45), ridgeY - mz * slope + 0.055, mz], 1.0, 1.3, 0x1a71 ^ (0xd0 + sx), 0.42);
    roofMoss(
      kit,
      'z',
      sx,
      pedSlope,
      [sx * (pedHalf - 0.6), bayTop + 0.42 + pedRise - (pedHalf - 0.6) * pedSlope + 0.05, D / 2 + 0.25],
      0.8,
      0.9,
      0x1a71 ^ (0xe0 + sx),
      0.34,
    );
  }

  // --- name board over the door --------------------------------------------
  kit.box('trimC', [3.1, 0.52, 0.14], [0, doorH + 0.55, bayFront + 0.02], { c: 0.04 });
  kit.box('trimC', [3.3, 0.1, 0.2], [0, doorH + 0.83, bayFront + 0.03], { c: 0.03 });
  kit.box('trimC', [3.3, 0.1, 0.2], [0, doorH + 0.27, bayFront + 0.03], { c: 0.03 });
  for (let i = 0; i < 5; i++) {
    kit.box('metal', [0.32, 0.2, 0.03], [-1.05 + i * 0.52, doorH + 0.55, bayFront + 0.09], { c: 0.012 });
  }

  return { top: ridgeY + 2.4, g };
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildBuildings(ctx: GameContext): void {
  const kit = new Kit();
  const group = new THREE.Group();
  group.name = 'Buildings';

  const P = BUILDINGS.playerHouse;
  const R = BUILDINGS.rivalHouse;
  const L = BUILDINGS.lab;

  const gP = ctx.collision.groundHeight(P.cx, P.cz);
  const gR = ctx.collision.groundHeight(R.cx, R.cz);
  const gL = ctx.collision.groundHeight(L.cx, L.cz);

  // Publish the authored lab entrance for the interior/travel system. Keeping
  // this tied to the building layout prevents its interaction anchor and
  // exterior return point from drifting away from the visible doorway.
  const labDoor = BUILDINGS.labDoor.clone();
  labDoor.y = ctx.collision.groundHeight(labDoor.x, labDoor.z);
  ctx.scene.userData.labDoor = labDoor;

  // --- materials ----------------------------------------------------------
  const wP: WeatherOptions = { baseY: gP, eaveY: gP + 4.9 };
  const wR: WeatherOptions = { baseY: gR, eaveY: gR + 5.0 };
  const wL: WeatherOptions = { baseY: gL, eaveY: gL + 7.0, strength: 0.85 };

  const materials: Record<string, THREE.Material> = {
    wallA: wallMaterial(BPAL.wallCream, wP),
    wallB: wallMaterial(BPAL.wallWarm, wR),
    wallC: wallMaterial(BPAL.wallLab, wL),
    trimA: trimMaterial(BPAL.trimWood, wP),
    // The rival's owner painted his joinery sage; the player's is stained wood.
    // Two neighbours never buy the same tin.
    trimB: trimMaterial(BPAL.trimSage, wR),
    trimC: trimMaterial(BPAL.trimBlue, wL),
    // A different course gauge per roof: 44 cm on the player's, 49 on the
    // rival's shallower pitch, 47 on the lab. Three tile sizes from one bake, and
    // no two adjacent slopes beat at the same frequency.
    roofA: roofMaterial(BPAL.roofRed, wP, 0.225),
    roofB: roofMaterial(BPAL.roofRust, wR, 0.202),
    roofC: roofMaterial(BPAL.roofBlue, wL, 0.213),
    doorA: doorMaterial(BPAL.doorTeal, wP),
    doorB: doorMaterial(BPAL.doorRed, wR),
    doorC: doorMaterial(BPAL.trimBlue, wL),
    stone: stoneMaterial({ baseY: gP, eaveY: gL + 7.0, strength: 1.1 }),
    brick: brickMaterial({ baseY: gP, eaveY: gP + 5.4, strength: 1.0 }),
    metal: metalMaterial(),
    glass: glassMaterial(),
    lamp: lampGlassMaterial(),
    roomShell: roomShellMaterial(),
    roomBack: roomBackMaterial(),
    curtain: curtainMaterial(),
    skirt: skirtMaterial(),
    stain: stainMaterial(),
  };

  // --- geometry -----------------------------------------------------------
  const player = buildCottage(kit, ctx, {
    cx: P.cx,
    cz: P.cz,
    mirror: -1,
    w: P.w,
    d: P.d,
    wallH: 4.3,
    rise: 2.78,
    matWall: 'wallA',
    matTrim: 'trimA',
    matRoof: 'roofA',
    matDoor: 'doorA',
    seed: ctx.seed ^ 0x11a1,
    shutters: 'lower',
    pots: 2,
    chimneyZ: PLAYER_CHIMNEY_Z,
  });

  const rival = buildGableCottage(kit, ctx, {
    cx: R.cx,
    cz: R.cz,
    w: R.w,
    d: R.d,
    wallH: 4.42,
    // 2.67 over a 3.81 m half-span is a 35 deg pitch; the player's is 42.
    rise: 2.67,
    matWall: 'wallB',
    matTrim: 'trimB',
    matRoof: 'roofB',
    matDoor: 'doorB',
    seed: ctx.seed ^ 0x77c3,
    chimneyX: RIVAL_CHIMNEY_X,
  });

  const lab = buildLab(kit, ctx);

  // --- ground contact ------------------------------------------------------
  kit.origin(0, 0, 0, 1);
  kit.raw('skirt', dirtSkirt(ctx, P.cx, P.cz, P.w / 2 + 0.2, P.d / 2 + 0.2, 1.15, ctx.seed ^ 5), null);
  kit.raw('skirt', dirtSkirt(ctx, R.cx, R.cz, R.w / 2 + 0.2, R.d / 2 + 0.2, 1.15, ctx.seed ^ 9), null);
  kit.raw('skirt', dirtSkirt(ctx, L.cx, L.cz + 0.35, L.w / 2 + 0.25, L.d / 2 + 0.6, 1.05, ctx.seed ^ 21), null);

  // --- merge ---------------------------------------------------------------
  const merged = kit.merge();
  let tris = 0;
  for (const [key, geo] of merged) {
    const mat = materials[key];
    if (!mat) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `Buildings.${key}`;
    const decal = key === 'skirt' || key === 'stain';
    const solid = key !== 'glass' && key !== 'roomShell' && key !== 'roomBack' && key !== 'curtain' && !decal;
    mesh.castShadow = solid;
    mesh.receiveShadow = key !== 'roomShell' && key !== 'roomBack';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (decal) mesh.renderOrder = 1;
    group.add(mesh);
    tris += geo.attributes.position.count / 3;
  }
  ctx.scene.add(group);

  // --- colliders -----------------------------------------------------------
  // Houses are solid volumes; the lab is a shell with an open doorway so the
  // player can walk in — the door itself belongs to the LabInterior system.
  ctx.collision.addBox(P.cx, P.cz, P.w / 2 + 0.14, P.d / 2 + 0.14, gP - 0.5, gP + player.top, 0, 'player-house');
  // The player house is mirrored about local X, so its stack lands on the
  // *east* gable while the rival's stays west — the two never face each other.
  ctx.collision.addBox(P.cx + P.w / 2 + 0.5, P.cz + PLAYER_CHIMNEY_Z, 0.6, 0.48, gP - 0.5, gP + 8, 0, 'player-chimney');
  ctx.collision.addBox(R.cx, R.cz, R.w / 2 + 0.14, R.d / 2 + 0.14, gR - 0.5, gR + rival.top, 0, 'rival-house');
  // The rival's cottage is front-gabled, so its stack stands against the *rear*
  // gable rather than a side wall — the collider has to follow the massing.
  ctx.collision.addBox(R.cx + RIVAL_CHIMNEY_X, R.cz - R.d / 2 - 0.54, 0.58, 0.48, gR - 0.5, gR + 8, 0, 'rival-chimney');
  // Porch posts — the player's portico only. The rival's door hood is carried on
  // knee brackets at 2.2 m, so there is nothing at ground level to walk into.
  for (const s of [-1, 1]) {
    ctx.collision.addCircle(P.cx - s * 1.02, P.cz + P.d / 2 + 1.06, 0.2, gP - 0.5, gP + 2.6, 'porch-post');
  }

  const lz = L.cz;
  const lyLo = lab.g - 0.5;
  const lyHi = lab.g + lab.top;
  const front = lz + L.d / 2;
  const gap = 1.12; // half-width of the walk-through doorway
  ctx.collision.addBox((-L.w / 2 - gap) / 2, front - 0.25, (L.w / 2 - gap) / 2, 0.45, lyLo, lyHi, 0, 'lab-front-w');
  ctx.collision.addBox((L.w / 2 + gap) / 2, front - 0.25, (L.w / 2 - gap) / 2, 0.45, lyLo, lyHi, 0, 'lab-front-e');
  ctx.collision.addBox(-L.w / 2 + 0.25, lz, 0.45, L.d / 2, lyLo, lyHi, 0, 'lab-west');
  ctx.collision.addBox(L.w / 2 - 0.25, lz, 0.45, L.d / 2, lyLo, lyHi, 0, 'lab-east');
  ctx.collision.addBox(0, lz - L.d / 2 + 0.25, L.w / 2, 0.45, lyLo, lyHi, 0, 'lab-north');
  // Entrance bay returns, either side of the open doorway.
  for (const s of [-1, 1]) {
    ctx.collision.addBox(s * 2.53, front + 0.4, 0.28, 0.75, lyLo, lyHi, 0, 'lab-bay');
  }

  if (import.meta.env?.DEV) {
    console.info(`[Buildings] ${merged.size} draw calls, ${Math.round(tris / 1000)}k tris`);
  }
}
