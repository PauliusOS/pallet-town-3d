import * as THREE from 'three';
import { makeRng } from '../../core/Noise';

/**
 * Soft radial dot for every particle system. Without a map, PointsMaterial
 * renders hard squares — plainly visible in impact stills.
 */
let dotTex: THREE.Texture | null = null;
export function softDotTexture(): THREE.Texture {
  if (dotTex) return dotTex;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d')!;
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  dotTex = new THREE.CanvasTexture(canvas);
  dotTex.colorSpace = THREE.SRGBColorSpace;
  return dotTex;
}

/**
 * BattleFX — procedural attack and impact effects.
 *
 * Everything is Points-based where possible: the GTAO prepass hides Points
 * automatically, so additive particles never stamp ghost occluders into the
 * AO buffer the way sprites and quads do. The few mesh effects (rings, the
 * vine whip) are alive for a fraction of a second.
 *
 * All positions are in the parent group's local space (the arena), and every
 * random number comes from a seeded rng so a replayed battle produces the
 * same frames.
 */

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

interface Emitter {
  points: THREE.Points;
  mat: THREE.PointsMaterial;
  parts: Particle[];
  gravity: number;
  drag: number;
  /** Optional orbit constraint (gust). */
  orbit?: { center: THREE.Vector3; angVel: number };
  fade: boolean;
}

interface RingFx {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  growTo: number;
}

interface LightFx {
  light: THREE.PointLight;
  life: number;
  maxLife: number;
  peak: number;
}

/**
 * Light pulses come from a fixed pool created up front. Adding and removing
 * real lights mid-battle changes NUM_POINT_LIGHTS and forces every material
 * in the scene to recompile on the hit frame — the most expensive possible
 * moment — so the pool keeps the scene's light count constant instead.
 */
const LIGHT_POOL = 3;

interface WhipFx {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  total: number;
}

export class BattleFX {
  readonly group = new THREE.Group();

  private emitters: Emitter[] = [];
  private rings: RingFx[] = [];
  private lights: LightFx[] = [];
  private whips: WhipFx[] = [];
  private rng = makeRng(0x0f0f7);
  private pool: THREE.PointLight[] = [];
  private poolNext = 0;

  constructor(parent: THREE.Object3D, seed = 1) {
    this.group.name = 'BattleFX';
    this.rng = makeRng(seed >>> 0 || 1);
    parent.add(this.group);
    for (let i = 0; i < LIGHT_POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 6, 2);
      this.group.add(l);
      this.pool.push(l);
    }
  }

  /** Borrows a pooled light for a decaying pulse. */
  private pulse(pos: THREE.Vector3, color: number, peak: number, life: number): void {
    const light = this.pool[this.poolNext];
    this.poolNext = (this.poolNext + 1) % this.pool.length;
    // Drop any active pulse still using this light.
    this.lights = this.lights.filter((l) => l.light !== light);
    light.color.setHex(color);
    light.position.copy(pos);
    this.lights.push({ light, life, maxLife: life, peak });
  }

  reseed(seed: number): void {
    this.rng = makeRng(seed >>> 0 || 1);
  }

  /* -------------------------------------------------------------- core */

  private makeEmitter(
    count: number,
    color: number,
    size: number,
    opts: { gravity?: number; drag?: number; orbit?: Emitter['orbit'] } = {},
  ): Emitter {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const mat = new THREE.PointsMaterial({
      color,
      size,
      map: softDotTexture(),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    const e: Emitter = {
      points,
      mat,
      parts: [],
      gravity: opts.gravity ?? 0,
      drag: opts.drag ?? 0,
      orbit: opts.orbit,
      fade: true,
    };
    this.emitters.push(e);
    return e;
  }

  /* ------------------------------------------------------------ bursts */

  /**
   * Expanding flat shockwave ring (send-out, big impacts).
   *
   * Implemented as a circle of Points rather than an additive RingGeometry
   * mesh: on the ANGLE/Metal path the transparent ring mesh intermittently
   * blacked out the entire frame (whole scene rendered as void while the UI
   * stayed up). Points render through the same battle-FX path as every other
   * particle here and have never exhibited the fault.
   */
  ring(pos: THREE.Vector3, color = 0xfff0c4, growTo = 1.6, life = 0.45): void {
    const N = 64;
    const e = this.makeEmitter(N, color, 0.09, { drag: 0 });
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      e.parts.push({
        pos: pos.clone().add(new THREE.Vector3(0, 0.03, 0)).addScaledVector(dir, 0.12),
        vel: dir.multiplyScalar(growTo / Math.max(0.15, life)),
        life,
        maxLife: life,
        size: 1,
      });
    }
  }

  /** Rising sparkle burst (send-out). */
  sparkles(pos: THREE.Vector3, color = 0xfff4d0, count = 42): void {
    const e = this.makeEmitter(count, color, 0.035, { gravity: -1.6, drag: 1.4 });
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const up = 0.6 + this.rng() * 1.6;
      const r = 0.3 + this.rng() * 1.1;
      e.parts.push({
        pos: pos.clone().add(new THREE.Vector3(0, 0.05, 0)),
        vel: new THREE.Vector3(Math.cos(a) * r, up, Math.sin(a) * r),
        life: 0.5 + this.rng() * 0.35,
        maxLife: 0.85,
        size: 1,
      });
    }
  }

  /** Radial impact star + a light pulse. The universal "hit" frame. */
  impact(pos: THREE.Vector3, color = 0xffe9a8, strength = 1): void {
    const count = Math.round(26 * strength + 14);
    const e = this.makeEmitter(count, color, 0.05 * Math.min(1.6, strength), { drag: 4.2 });
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const b = (this.rng() - 0.5) * Math.PI;
      const sp = (1.6 + this.rng() * 3.4) * strength;
      e.parts.push({
        pos: pos.clone(),
        vel: new THREE.Vector3(Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp * 0.7, Math.sin(a) * Math.cos(b) * sp),
        life: 0.22 + this.rng() * 0.2,
        maxLife: 0.42,
        size: 1,
      });
    }
    // Peak tuned low: at 60+ the ACES chain blew the whole frame to white.
    this.pulse(pos.clone().add(new THREE.Vector3(0, 0.3, 0)), color, 9 * strength, 0.2 * strength + 0.06);
  }

  /** Ground dust puff (faints, landings). */
  dust(pos: THREE.Vector3, count = 26): void {
    const e = this.makeEmitter(count, 0x9a8f78, 0.09, { gravity: 0.6, drag: 2.6 });
    e.mat.blending = THREE.NormalBlending;
    e.mat.opacity = 0.55;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const sp = 0.5 + this.rng() * 1.2;
      e.parts.push({
        pos: pos.clone().add(new THREE.Vector3(0, 0.04, 0)),
        vel: new THREE.Vector3(Math.cos(a) * sp, 0.5 + this.rng() * 0.8, Math.sin(a) * sp),
        life: 0.45 + this.rng() * 0.35,
        maxLife: 0.8,
        size: 1,
      });
    }
  }

  /* ----------------------------------------------------------- attacks */

  /** Ember: an arcing volley of hot sparks from mouth to target. */
  emberArc(from: THREE.Vector3, to: THREE.Vector3, dur = 0.4): void {
    const count = 46;
    const e = this.makeEmitter(count, 0xff8a30, 0.055, { gravity: -3.4, drag: 0.15 });
    const flat = to.clone().sub(from);
    for (let i = 0; i < count; i++) {
      const t = dur * (0.75 + this.rng() * 0.45);
      // Ballistic solve: v = (d - 0.5*g*t^2*up)/t with g negative gravity.
      const vel = flat
        .clone()
        .multiplyScalar(1 / t)
        .add(new THREE.Vector3(0, 0.5 * 3.4 * t + 0.6 + this.rng() * 0.5, 0));
      vel.x += (this.rng() - 0.5) * 0.8;
      vel.z += (this.rng() - 0.5) * 0.8;
      e.parts.push({
        pos: from.clone().add(new THREE.Vector3((this.rng() - 0.5) * 0.1, (this.rng() - 0.5) * 0.1, 0)),
        vel,
        life: t,
        maxLife: t,
        size: 1,
      });
    }
    this.pulse(from.clone().lerp(to, 0.4).add(new THREE.Vector3(0, 0.5, 0)), 0xff7a1e, 7, dur);
  }

  /** Water Gun: a dense pressurised stream. */
  waterStream(from: THREE.Vector3, to: THREE.Vector3, dur = 0.5): void {
    const count = 90;
    const e = this.makeEmitter(count, 0x7ec4ff, 0.045, { gravity: -1.2, drag: 0 });
    const dir = to.clone().sub(from);
    const dist = dir.length();
    dir.normalize();
    for (let i = 0; i < count; i++) {
      const speed = dist / (dur * 0.55);
      const vel = dir.clone().multiplyScalar(speed * (0.9 + this.rng() * 0.2));
      vel.x += (this.rng() - 0.5) * 0.5;
      vel.y += 0.35 + (this.rng() - 0.5) * 0.5;
      vel.z += (this.rng() - 0.5) * 0.5;
      const delay = (i / count) * dur * 0.6;
      e.parts.push({
        pos: from.clone().addScaledVector(vel, -delay), // staggered launch
        vel,
        life: dur * 0.6 + delay,
        maxLife: dur * 1.2,
        size: 1,
      });
    }
  }

  /** Gust: a swirling vortex around the target. */
  gust(center: THREE.Vector3, dur = 0.7): void {
    const count = 80;
    const e = this.makeEmitter(count, 0xd8ecff, 0.045, {
      orbit: { center: center.clone(), angVel: 9 },
      drag: 0,
    });
    e.mat.opacity = 0.8;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = 0.25 + this.rng() * 0.55;
      const y = this.rng() * 0.9;
      e.parts.push({
        pos: new THREE.Vector3(center.x + Math.cos(a) * r, center.y + y, center.z + Math.sin(a) * r),
        vel: new THREE.Vector3(0, 0.8 + this.rng() * 0.9, 0),
        life: dur * (0.5 + this.rng() * 0.5),
        maxLife: dur,
        size: 1,
      });
    }
  }

  /** Sand Attack: a low fan of grit kicked at the target's face. */
  sandFan(from: THREE.Vector3, to: THREE.Vector3, dur = 0.4): void {
    const count = 60;
    const e = this.makeEmitter(count, 0xd8b878, 0.04, { gravity: -3.5, drag: 0.4 });
    e.mat.blending = THREE.NormalBlending;
    e.mat.opacity = 0.85;
    const dir = to.clone().sub(from).normalize();
    for (let i = 0; i < count; i++) {
      const spread = new THREE.Vector3((this.rng() - 0.5) * 1.6, 0.8 + this.rng() * 1.2, (this.rng() - 0.5) * 1.6);
      const vel = dir.clone().multiplyScalar(3 + this.rng() * 2).add(spread);
      e.parts.push({
        pos: from.clone().add(new THREE.Vector3(0, 0.05, 0)),
        vel,
        life: dur * (0.6 + this.rng() * 0.5),
        maxLife: dur,
        size: 1,
      });
    }
  }

  /** Vine Whip: a green lash that sweeps from attacker across the target. */
  vineWhip(from: THREE.Vector3, to: THREE.Vector3, dur = 0.34): void {
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0.7, 0.9, 0));
    const curve = new THREE.CatmullRomCurve3([
      from.clone().add(new THREE.Vector3(0, 0.25, 0)),
      mid,
      to.clone().add(new THREE.Vector3(0, 0.35, 0)),
    ]);
    const geo = new THREE.TubeGeometry(curve, 32, 0.035, 6, false);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7ed048,
      transparent: true,
      opacity: 0.95,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // drawRange animates the lash extending tip-first.
    geo.setDrawRange(0, 0);
    this.group.add(mesh);
    this.whips.push({ mesh, mat, life: dur, maxLife: dur, total: geo.index ? geo.index.count : 0 });
  }

  /** Quick Attack / Tackle: an afterimage streak along the dash line. */
  dashStreak(from: THREE.Vector3, to: THREE.Vector3, color = 0xffffff): void {
    const count = 30;
    const e = this.makeEmitter(count, color, 0.07, { drag: 6 });
    e.mat.opacity = 0.55;
    for (let i = 0; i < count; i++) {
      const t = i / count;
      e.parts.push({
        pos: from.clone().lerp(to, t).add(new THREE.Vector3(0, 0.2 + this.rng() * 0.25, 0)),
        vel: new THREE.Vector3((this.rng() - 0.5) * 0.4, (this.rng() - 0.5) * 0.4, (this.rng() - 0.5) * 0.4),
        life: 0.12 + t * 0.14,
        maxLife: 0.26,
        size: 1,
      });
    }
  }

  /** Growl / Tail Whip: expanding sonic rings toward the target (Points). */
  sonicRings(from: THREE.Vector3, to: THREE.Vector3): void {
    const dir = to.clone().sub(from).normalize();
    // Build an orthonormal frame facing the target.
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const vUp = new THREE.Vector3().crossVectors(side, dir).normalize();
    for (let i = 0; i < 3; i++) {
      const N = 36;
      const life = 0.4 + i * 0.12;
      const e = this.makeEmitter(N, 0xfff0c4, 0.05, { drag: 0 });
      e.mat.opacity = 0.7;
      const origin = from.clone().addScaledVector(dir, 0.4 + i * 0.4).add(new THREE.Vector3(0, 0.35, 0));
      for (let k = 0; k < N; k++) {
        const a = (k / N) * Math.PI * 2;
        const rad = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(vUp, Math.sin(a));
        e.parts.push({
          pos: origin.clone().addScaledVector(rad, 0.12),
          vel: rad.clone().multiplyScalar(0.9).addScaledVector(dir, 1.6),
          life,
          maxLife: life,
          size: 1,
        });
      }
    }
  }

  /* ------------------------------------------------------------- frame */

  update(dt: number): void {
    if (dt <= 0) return;

    // Particles.
    for (let ei = this.emitters.length - 1; ei >= 0; ei--) {
      const e = this.emitters[ei];
      const posAttr = e.points.geometry.attributes.position as THREE.BufferAttribute;
      let alive = 0;
      let maxFrac = 0;
      for (const p of e.parts) {
        p.life -= dt;
        if (p.life <= 0) continue;
        if (e.orbit) {
          // Swirl: rotate the offset from the orbit centre while rising.
          const off = p.pos.clone().sub(e.orbit.center);
          const y = off.y;
          off.y = 0;
          const a = e.orbit.angVel * dt;
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          const nx = off.x * cos - off.z * sin;
          const nz = off.x * sin + off.z * cos;
          p.pos.set(e.orbit.center.x + nx, e.orbit.center.y + y + p.vel.y * dt, e.orbit.center.z + nz);
        } else {
          p.vel.y += e.gravity * dt;
          if (e.drag > 0) p.vel.multiplyScalar(Math.max(0, 1 - e.drag * dt));
          p.pos.addScaledVector(p.vel, dt);
        }
        posAttr.setXYZ(alive, p.pos.x, p.pos.y, p.pos.z);
        maxFrac = Math.max(maxFrac, p.life / p.maxLife);
        alive++;
      }
      if (alive === 0) {
        this.group.remove(e.points);
        e.points.geometry.dispose();
        e.mat.dispose();
        this.emitters.splice(ei, 1);
        continue;
      }
      e.points.geometry.setDrawRange(0, alive);
      posAttr.needsUpdate = true;
      if (e.fade) e.mat.opacity = Math.min(e.mat.opacity, 0.15 + maxFrac * 0.85);
    }

    // Rings.
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const t = 1 - Math.max(0, r.life / r.maxLife);
      const ease = 1 - (1 - t) * (1 - t);
      r.mesh.scale.setScalar(0.1 + ease * r.growTo);
      r.mat.opacity = 0.85 * (1 - t);
      if (r.life <= 0) {
        this.group.remove(r.mesh);
        r.mesh.geometry.dispose();
        r.mat.dispose();
        this.rings.splice(i, 1);
      }
    }

    // Light pulses (pooled lights stay in the scene at zero intensity).
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i];
      l.life -= dt;
      const t = Math.max(0, l.life / l.maxLife);
      l.light.intensity = l.peak * t * t;
      if (l.life <= 0) {
        l.light.intensity = 0;
        this.lights.splice(i, 1);
      }
    }

    // Vine whips: extend, hold, dissolve.
    for (let i = this.whips.length - 1; i >= 0; i--) {
      const w = this.whips[i];
      w.life -= dt;
      const t = 1 - Math.max(0, w.life / w.maxLife);
      const geo = w.mesh.geometry as THREE.TubeGeometry;
      const extend = Math.min(1, t * 2.4);
      geo.setDrawRange(0, Math.floor(w.total * extend));
      w.mat.opacity = t > 0.65 ? (1 - t) / 0.35 : 0.95;
      if (w.life <= 0) {
        this.group.remove(w.mesh);
        w.mesh.geometry.dispose();
        w.mat.dispose();
        this.whips.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const e of this.emitters) {
      this.group.remove(e.points);
      e.points.geometry.dispose();
      e.mat.dispose();
    }
    this.emitters = [];
    for (const r of this.rings) {
      this.group.remove(r.mesh);
      r.mesh.geometry.dispose();
      r.mat.dispose();
    }
    this.rings = [];
    for (const l of this.lights) l.light.intensity = 0;
    this.lights = [];
    for (const w of this.whips) {
      this.group.remove(w.mesh);
      w.mesh.geometry.dispose();
      w.mat.dispose();
    }
    this.whips = [];
  }
}
