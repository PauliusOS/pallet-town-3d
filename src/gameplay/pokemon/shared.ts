import * as THREE from 'three';
import { bakeCavityAO } from '../../fx/Sculpt';
import { makeEye } from '../../fx/CreatureMaterials';
import { makeRng, clamp } from '../../core/Noise';

/**
 * Shared creature rig, idle performance, and eye assembly.
 *
 * Each starter lives in its own module and owns its sculpt; everything they
 * have in common lives here so the three characters move like they belong to
 * the same game.
 */

export type StarterId = 'bulbasaur' | 'charmander' | 'squirtle';

export interface Creature {
  readonly id: StarterId;
  readonly name: string;
  readonly group: THREE.Group;
  update(dt: number, elapsed: number): void;
  celebrate(): void;
  /** 0..1 — raised while the player is looking at this creature. */
  attention: number;
  dispose(): void;
}

export const STARTERS: { id: StarterId; name: string; type: string; blurb: string }[] = [
  { id: 'bulbasaur', name: 'Bulbasaur', type: 'Grass', blurb: 'A seed Pokemon. Calm and patient, it carries a bulb that grows along with it.' },
  { id: 'charmander', name: 'Charmander', type: 'Fire', blurb: 'A lizard Pokemon. The flame on its tail shows exactly how it is feeling.' },
  { id: 'squirtle', name: 'Squirtle', type: 'Water', blurb: 'A tiny turtle Pokemon. Its shell hardens as it grows.' },
];

/**
 * A minimal animation rig.
 *
 * The creatures have no skeleton — skinning a marching-cubes mesh would need
 * weights we have no authoring tool for. Instead the body is one mesh that
 * squashes and stretches as a whole, and the parts that articulate (head,
 * tail, ears, limbs) are separate nodes on their own pivots. At the scale
 * these are viewed that reads identically to a skinned rig, and costs nothing.
 */
export interface Rig {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Group[];
  eyelids: THREE.Mesh[];
  tail?: THREE.Group;
  extras: THREE.Object3D[];
}

export function createRig(): Rig {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const head = new THREE.Group();
  root.add(body);
  body.add(head);
  return { root, body, head, eyes: [], eyelids: [], extras: [] };
}

/**
 * Drives the idle performance shared by all three starters.
 *
 * Breathing, blinking, head sway and a weight shift, all on mutually prime
 * periods so the loop never visibly repeats. Blink timing is stochastic
 * because evenly-spaced blinks are uncanny.
 */
export class IdleAnimator {
  private blinkTimer: number;
  private blinkPhase = 0;
  private blinking = false;
  private rng: () => number;
  private celebrateT = -1;

  constructor(private rig: Rig, seed: number) {
    this.rng = makeRng(seed);
    this.blinkTimer = 1 + this.rng() * 3;
  }

  celebrate(): void {
    this.celebrateT = 0;
  }

  update(dt: number, elapsed: number, attention: number): void {
    const { body, head, eyelids } = this.rig;

    // ---- Breathing: volume-preserving squash and stretch -------------
    const breath = Math.sin(elapsed * 1.55) * 0.5 + 0.5;
    const amp = 0.026 + attention * 0.014;
    body.scale.set(1 - breath * amp * 0.46, 1 + breath * amp, 1 - breath * amp * 0.46);

    // ---- Head: slow figure-of-eight, faster when attentive -----------
    const hs = 0.6 + attention * 0.9;
    head.rotation.y = Math.sin(elapsed * 0.73 * hs) * (0.10 + attention * 0.14);
    head.rotation.x = Math.sin(elapsed * 0.51 * hs + 1.7) * (0.055 + attention * 0.05);
    head.rotation.z = Math.sin(elapsed * 0.37 * hs + 0.4) * 0.035;

    // ---- Weight shift ------------------------------------------------
    body.rotation.z = Math.sin(elapsed * 0.44) * 0.022;
    body.position.y = Math.sin(elapsed * 1.55) * 0.004;

    // ---- Blink -------------------------------------------------------
    this.blinkTimer -= dt;
    if (!this.blinking && this.blinkTimer <= 0) {
      this.blinking = true;
      this.blinkPhase = 0;
    }
    if (this.blinking) {
      this.blinkPhase += dt / 0.13;
      if (this.blinkPhase >= 1) {
        this.blinking = false;
        // Occasionally double-blink, which is what real eyes do.
        this.blinkTimer = this.rng() < 0.22 ? 0.18 : 1.6 + this.rng() * 3.4;
      }
    }
    // Triangle wave: shut fast, open slightly slower.
    const closed = this.blinking
      ? this.blinkPhase < 0.45
        ? this.blinkPhase / 0.45
        : 1 - (this.blinkPhase - 0.45) / 0.55
      : 0;
    for (const lid of eyelids) lid.scale.y = clamp(closed, 0, 1);

    // ---- Celebration -------------------------------------------------
    if (this.celebrateT >= 0) {
      this.celebrateT += dt;
      const t = this.celebrateT;
      if (t > 1.5) {
        this.celebrateT = -1;
        this.rig.root.position.y = 0;
        this.rig.root.rotation.y = 0;
      } else {
        // Two decaying hops with a little spin.
        const hop = Math.abs(Math.sin(t * Math.PI * 2.2)) * Math.max(0, 1 - t / 1.5);
        this.rig.root.position.y = hop * 0.11;
        this.rig.root.rotation.y = Math.sin(t * Math.PI * 3) * 0.3 * Math.max(0, 1 - t / 1.5);
        body.scale.y *= 1 - hop * 0.1;
        body.scale.x *= 1 + hop * 0.07;
        body.scale.z *= 1 + hop * 0.07;
      }
    }
  }
}

/**
 * An upper eyelid that closes over an eyeball.
 *
 * A slightly oversized hemisphere scaled to zero on Y when open, so blinking
 * is a single scale animation with no geometry swap. Must be given the
 * creature's own skin material by the caller — a mismatched lid colour is
 * instantly visible as a pale rim around the eye.
 */
export function makeEyelid(radius: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius * 1.05, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const lid = new THREE.Mesh(geo, material);
  lid.scale.y = 0;
  lid.castShadow = false;
  return lid;
}

export interface EyeSpec {
  position: THREE.Vector3;
  radius: number;
  irisColor: number;
  /** Outward splay in radians so the eyes read in three-quarter view. */
  splay: number;
  /** Material used for the eyelid — pass the creature's skin material. */
  lidMaterial: THREE.Material;
  irisScale?: number;
  /** Vertical squash; below 1 gives a more relaxed, less startled eye. */
  squash?: number;
}

/** Builds and parents a complete eye assembly, registering it on the rig. */
export function addEye(rig: Rig, parent: THREE.Object3D, spec: EyeSpec): THREE.Group {
  const holder = new THREE.Group();
  holder.position.copy(spec.position);
  holder.rotation.y = spec.splay;
  if (spec.squash !== undefined) holder.scale.y = spec.squash;

  const eye = makeEye({
    radius: spec.radius,
    irisColor: spec.irisColor,
    irisScale: spec.irisScale ?? 0.7,
  });
  holder.add(eye);
  holder.add(makeEyelid(spec.radius, spec.lidMaterial));

  parent.add(holder);
  rig.eyes.push(eye);
  rig.eyelids.push(holder.children[1] as THREE.Mesh);
  return holder;
}

/**
 * Applies cavity shading and shadow flags to a sculpted body mesh.
 *
 * The cavity pass darkens vertices toward the form's core, which is what
 * gives a smooth stylised surface its sense of volume without a baked AO map.
 */
export function finishBody(mesh: THREE.Mesh, center: THREE.Vector3, strength = 0.22): THREE.Mesh {
  bakeCavityAO(mesh.geometry, center, strength);
  (mesh.material as THREE.MeshStandardMaterial).vertexColors = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Tapers a TubeGeometry along its length by scaling each ring toward the
 * spine curve. Used for tails, which must thin out or they read as sausages.
 */
export function taperTube(
  geo: THREE.BufferGeometry,
  curve: THREE.Curve<THREE.Vector3>,
  rings: number,
  perRing: number,
  startScale: number,
  endScale: number,
  ease: (t: number) => number = (t) => t,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const s = startScale + (endScale - startScale) * ease(t);
    const c = curve.getPoint(t);
    for (let j = 0; j < perRing; j++) {
      const idx = i * perRing + j;
      if (idx >= pos.count) break;
      pos.setXYZ(
        idx,
        c.x + (pos.getX(idx) - c.x) * s,
        c.y + (pos.getY(idx) - c.y) * s,
        c.z + (pos.getZ(idx) - c.z) * s,
      );
    }
  }
  geo.computeVertexNormals();
}

/** Disposes every geometry under a creature root. */
export function disposeCreature(root: THREE.Object3D): void {
  root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
}
