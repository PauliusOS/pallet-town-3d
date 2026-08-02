import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import { EventBus, EVENTS, type GameContext, type EnvironmentState } from '../core/Context';
import { CollisionWorld } from './Collision';
import { InteractionSystem } from './Interaction';

import { buildAtmosphere } from './Atmosphere';
import { buildTerrain } from './Terrain';
import { buildWater } from './Water';
import { buildBuildings } from './Buildings';
import { buildVegetation } from './Vegetation';
import { buildProps } from './Props';
import { buildLabInterior } from './LabInterior';
import { buildWildGrass } from './WildGrass';
import { buildBattleArena } from '../gameplay/battle/BattleScene';

/**
 * World — orchestrates the build order for Pallet Town.
 *
 * Order matters: terrain publishes the heightfield that everything else
 * samples to sit on the ground, and buildings claim their footprints before
 * vegetation scatters so trees never grow through a porch.
 */
export const SEED = 20040129; // FireRed/LeafGreen JP release date.

export class World {
  readonly name = 'world';
  readonly ctx: GameContext;
  readonly collision = new CollisionWorld();
  readonly interaction: InteractionSystem;
  readonly root = new THREE.Group();

  private ticks: ((dt: number, elapsed: number) => void)[] = [];

  /** Per-step build durations in ms, populated by build(). */
  buildTimings: [string, number][] = [];

  constructor(engine: Engine) {
    this.root.name = 'World';
    engine.scene.add(this.root);

    this.interaction = new InteractionSystem(engine.camera);

    const env: EnvironmentState = {
      timeOfDay: 9.4,
      sunDirection: new THREE.Vector3(-0.42, -0.62, -0.66).normalize(),
      sunColor: new THREE.Color(1.0, 0.94, 0.82),
      skyColor: new THREE.Color(0.42, 0.66, 0.95),
      groundColor: new THREE.Color(0.36, 0.42, 0.3),
      windStrength: 0.42,
      windDirection: new THREE.Vector2(0.86, 0.51).normalize(),
      windTime: { value: 0 },
    };

    this.ctx = {
      engine,
      scene: this.root,
      stage: engine.scene,
      camera: engine.camera,
      collision: this.collision,
      interaction: this.interaction,
      seed: SEED,
      tick: (fn) => this.ticks.push(fn),
      events: new EventBus(),
      env,
    };
  }

  async build(onProgress?: (label: string, pct: number) => void): Promise<void> {
    const steps: [string, (ctx: GameContext) => void | Promise<void>][] = [
      ['Raising the sky', buildAtmosphere],
      ['Shaping the ground', buildTerrain],
      ['Filling the bay', buildWater],
      ['Building the town', buildBuildings],
      ['Planting', buildVegetation],
      ["Setting out props", buildProps],
      ["Furnishing Oak's lab", buildLabInterior],
      ['Wild grass', buildWildGrass],
      ['Battle arena', buildBattleArena],
    ];

    // Per-step timings. Load time is on the player's critical path and every
    // subsystem's texture bakes are synchronous, so it is worth knowing which
    // step is expensive rather than guessing.
    const timings: [string, number][] = [];
    const t0 = performance.now();

    for (let i = 0; i < steps.length; i++) {
      const [label, fn] = steps[i];
      onProgress?.(label, i / steps.length);
      // Yield to the event loop so the loading screen can actually paint
      // between heavy synchronous bakes.
      await new Promise((r) => requestAnimationFrame(r));
      const start = performance.now();
      await fn(this.ctx);
      timings.push([label, performance.now() - start]);
    }

    const total = performance.now() - t0;
    console.info(
      `[world] built in ${(total / 1000).toFixed(1)}s — ` +
        timings
          .slice()
          .sort((a, b) => b[1] - a[1])
          .map(([l, ms]) => `${l} ${(ms / 1000).toFixed(1)}s`)
          .join(', '),
    );
    this.buildTimings = timings;

    onProgress?.('Ready', 1);
    this.ctx.events.emit(EVENTS.WORLD_READY);
  }

  update(dt: number, elapsed: number): void {
    this.ctx.env.windTime.value += dt;
    this.interaction.update(dt);
    for (const fn of this.ticks) fn(dt, elapsed);
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
  }
}
