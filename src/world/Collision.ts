import * as THREE from 'three';

/**
 * Collision registry.
 *
 * The town is small and almost entirely axis-aligned, so a broadphase-free
 * list of analytic shapes beats a mesh BVH here: it is exact, allocation-free
 * per frame, and lets each builder declare its own blockers without any shared
 * bake step.
 *
 * All shapes are 2D in the XZ plane with a vertical span, because the player
 * walks on a heightfield and never needs to resolve against sloped ceilings.
 */

export interface ColliderBase {
  /** Vertical span; the player only collides when their capsule overlaps it. */
  minY: number;
  maxY: number;
  /** Debug label, shown by the collider visualiser. */
  tag?: string;
}

export interface BoxCollider extends ColliderBase {
  kind: 'box';
  /** Centre in world XZ. */
  cx: number;
  cz: number;
  /** Half-extents along the box's local axes. */
  hx: number;
  hz: number;
  /** Rotation about Y, radians. */
  rot: number;
}

export interface CircleCollider extends ColliderBase {
  kind: 'circle';
  cx: number;
  cz: number;
  r: number;
}

export type Collider = BoxCollider | CircleCollider;

export interface GroundSampler {
  /** World-space ground height at (x, z). */
  (x: number, z: number): number;
}

const _v = new THREE.Vector2();

export class CollisionWorld {
  readonly colliders: Collider[] = [];

  /** Replaced by the terrain system once its heightfield exists. */
  groundHeight: GroundSampler = () => 0;

  /** Surface material id at a point, used to pick footstep sounds. */
  surfaceAt: (x: number, z: number) => string = () => 'grass';

  addBox(
    cx: number,
    cz: number,
    hx: number,
    hz: number,
    minY: number,
    maxY: number,
    rot = 0,
    tag?: string,
  ): BoxCollider {
    const c: BoxCollider = { kind: 'box', cx, cz, hx, hz, minY, maxY, rot, tag };
    this.colliders.push(c);
    return c;
  }

  addCircle(
    cx: number,
    cz: number,
    r: number,
    minY: number,
    maxY: number,
    tag?: string,
  ): CircleCollider {
    const c: CircleCollider = { kind: 'circle', cx, cz, r, minY, maxY, tag };
    this.colliders.push(c);
    return c;
  }

  /** Wraps an Object3D's world AABB as a box collider. */
  addFromObject(obj: THREE.Object3D, shrink = 0, tag?: string): BoxCollider {
    obj.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    return this.addBox(
      center.x,
      center.z,
      Math.max(0.02, size.x / 2 - shrink),
      Math.max(0.02, size.z / 2 - shrink),
      box.min.y,
      box.max.y,
      0,
      tag ?? obj.name,
    );
  }

  clear(): void {
    this.colliders.length = 0;
  }

  /**
   * Resolves a moving circle (the player's capsule footprint) against every
   * collider, returning the corrected position.
   *
   * Two passes: the first resolves the deepest penetrations, the second
   * catches the corner case where pushing out of one collider pushes into
   * another. More passes buy nothing at this scene's density.
   */
  resolve(
    x: number,
    z: number,
    feetY: number,
    headY: number,
    radius: number,
    out: THREE.Vector2,
  ): THREE.Vector2 {
    let px = x;
    let pz = z;

    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const c of this.colliders) {
        // Vertical overlap test — lets the player walk over low kerbs and
        // under raised eaves without extra geometry.
        if (headY <= c.minY || feetY >= c.maxY) continue;

        if (c.kind === 'circle') {
          const dx = px - c.cx;
          const dz = pz - c.cz;
          const d2 = dx * dx + dz * dz;
          const rr = c.r + radius;
          if (d2 < rr * rr && d2 > 1e-9) {
            const d = Math.sqrt(d2);
            const push = rr - d;
            px += (dx / d) * push;
            pz += (dz / d) * push;
            moved = true;
          } else if (d2 <= 1e-9) {
            px += rr;
            moved = true;
          }
        } else {
          // Transform into the box's local frame, resolve, transform back.
          const cos = Math.cos(-c.rot);
          const sin = Math.sin(-c.rot);
          const rx = px - c.cx;
          const rz = pz - c.cz;
          const lx = rx * cos - rz * sin;
          const lz = rx * sin + rz * cos;

          const nx = Math.max(-c.hx, Math.min(c.hx, lx));
          const nz = Math.max(-c.hz, Math.min(c.hz, lz));
          const dx = lx - nx;
          const dz = lz - nz;
          const d2 = dx * dx + dz * dz;

          if (d2 > radius * radius) continue;

          let outLx: number;
          let outLz: number;
          if (d2 > 1e-9) {
            // Outside the box, inside the radius: push along the surface normal.
            const d = Math.sqrt(d2);
            outLx = nx + (dx / d) * radius;
            outLz = nz + (dz / d) * radius;
          } else {
            // Centre is inside the box: eject along the shallowest axis.
            const px1 = c.hx - Math.abs(lx);
            const pz1 = c.hz - Math.abs(lz);
            if (px1 < pz1) {
              outLx = Math.sign(lx || 1) * (c.hx + radius);
              outLz = lz;
            } else {
              outLx = lx;
              outLz = Math.sign(lz || 1) * (c.hz + radius);
            }
          }

          const cos2 = Math.cos(c.rot);
          const sin2 = Math.sin(c.rot);
          px = c.cx + (outLx * cos2 - outLz * sin2);
          pz = c.cz + (outLx * sin2 + outLz * cos2);
          moved = true;
        }
      }
      if (!moved) break;
    }

    return out.set(px, pz);
  }

  /** True if a circle at (x,z) spanning [feetY, headY] overlaps anything. */
  overlaps(x: number, z: number, feetY: number, headY: number, radius: number): boolean {
    this.resolve(x, z, feetY, headY, radius, _v);
    return Math.abs(_v.x - x) > 1e-4 || Math.abs(_v.y - z) > 1e-4;
  }

  /** Builds a wireframe visualisation of every collider, for debugging. */
  buildDebugMesh(): THREE.Object3D {
    const group = new THREE.Group();
    group.name = 'ColliderDebug';
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3366, wireframe: true, transparent: true, opacity: 0.6 });
    for (const c of this.colliders) {
      const h = Math.max(0.05, c.maxY - c.minY);
      let mesh: THREE.Mesh;
      if (c.kind === 'box') {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(c.hx * 2, h, c.hz * 2), mat);
        mesh.rotation.y = c.rot;
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r, h, 12), mat);
      }
      mesh.position.set(c.cx, c.minY + h / 2, c.cz);
      group.add(mesh);
    }
    return group;
  }
}
