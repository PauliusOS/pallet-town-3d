import * as THREE from 'three';
import type { Engine } from './Engine';
import type { CollisionWorld } from '../world/Collision';
import type { InteractionSystem } from '../world/Interaction';

/**
 * GameContext — the single object every world builder receives.
 *
 * Builders are pure functions of this context: they add meshes to `scene`,
 * register blockers on `collision`, register prompts on `interaction`, and
 * push any per-frame work onto `tick`. Nothing reaches across to another
 * builder's internals, which is what lets each subsystem be developed and
 * reviewed in isolation.
 */
export interface GameContext {
  engine: Engine;
  /** World content root. Add all town geometry here. */
  scene: THREE.Group;
  /** The actual THREE.Scene — use only for fog, background and environment. */
  stage: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  collision: CollisionWorld;
  interaction: InteractionSystem;
  /** Shared deterministic seed so a given build always looks identical. */
  seed: number;
  /** Registers a per-frame callback. */
  tick: (fn: (dt: number, elapsed: number) => void) => void;
  /** Global event bus for cross-system signals. */
  events: EventBus;
  /** Time-of-day / weather state, owned by the Atmosphere system. */
  env: EnvironmentState;
}

export interface EnvironmentState {
  /** 0..24 hours. Pallet Town opens at a warm mid-morning. */
  timeOfDay: number;
  /** Sun direction, normalised, pointing *from* the sun toward the origin. */
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
  /** 0..1 wind strength driving all foliage motion. */
  windStrength: number;
  windDirection: THREE.Vector2;
  /** Global time uniform shared by every wind-animated material. */
  windTime: { value: number };
}

type Handler = (payload?: unknown) => void;

/** Minimal typed-enough event bus. */
export class EventBus {
  private map = new Map<string, Set<Handler>>();

  on(event: string, fn: Handler): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  once(event: string, fn: Handler): void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
  }

  emit(event: string, payload?: unknown): void {
    const set = this.map.get(event);
    if (!set) return;
    // Copy so a handler that unsubscribes during dispatch cannot skip a peer.
    for (const fn of [...set]) fn(payload);
  }
}

/** Named events used across systems. */
export const EVENTS = {
  /** Player picked a starter. Payload: { id, name } */
  STARTER_CHOSEN: 'starter:chosen',
  /** Dialogue opened/closed. Payload: boolean */
  DIALOGUE_ACTIVE: 'dialogue:active',
  /** A cutscene took/released camera control. Payload: boolean */
  CINEMATIC: 'cinematic',
  /** Request a dialogue sequence. Payload: DialogueRequest */
  SAY: 'dialogue:say',
  /** Player entered a named trigger volume. Payload: string */
  ENTER_ZONE: 'zone:enter',
  /** Footstep for the audio system. Payload: { surface: string } */
  FOOTSTEP: 'player:footstep',
  /** World finished building; safe to start gameplay. */
  WORLD_READY: 'world:ready',
} as const;
