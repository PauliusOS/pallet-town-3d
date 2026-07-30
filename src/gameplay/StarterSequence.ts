import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import { EVENTS } from '../core/Context';
import { buildPokeBall, buildStarter, STARTERS, type Creature, type StarterId, type PokeBall } from './Pokemon';
import { clamp } from '../core/Noise';

/**
 * The starter choice.
 *
 * The moment the whole game exists for, so the interaction is deliberately
 * two-stage: the first press opens a ball and lets the Pokemon out to be
 * looked at; only a second press on the same one commits. That gives the
 * player room to browse all three without a modal yes/no dialog, and it means
 * the creatures actually get to perform — which is the entire point of having
 * modelled them.
 *
 * State machine:
 *   idle           --interact(i)--> previewing(i)
 *   previewing(i)  --interact(i)--> chosen(i)
 *   previewing(i)  --interact(j)--> previewing(j)   (i is recalled first)
 */

type Phase = 'idle' | 'previewing' | 'chosen';

interface Slot {
  id: StarterId;
  name: string;
  blurb: string;
  anchor: THREE.Vector3;
  ball: PokeBall;
  creature: Creature;
  /** 0 = in ball, 1 = fully out. */
  release: number;
  target: number;
  ring: THREE.Mesh;
  sparkles: THREE.Points;
}

const RELEASE_TIME = 0.55;
const RECALL_TIME = 0.32;

export function buildStarterSequence(ctx: GameContext): void {
  const anchors = ctx.scene.userData.starterAnchors as THREE.Vector3[] | undefined;
  if (!anchors || anchors.length < 3) {
    console.warn('[starter] lab interior published no starterAnchors; sequence disabled');
    return;
  }

  const group = new THREE.Group();
  group.name = 'StarterSequence';
  ctx.scene.add(group);

  const slots: Slot[] = [];
  let phase: Phase = 'idle';
  let active = -1;
  let chosenId: StarterId | null = null;
  let introPlayed = false;

  /* ---------------------------------------------------------------- */
  /* Build the three stations                                          */
  /* ---------------------------------------------------------------- */

  for (let i = 0; i < 3; i++) {
    const meta = STARTERS[i];
    const anchor = anchors[i].clone();

    const ball = buildPokeBall(i + 1);
    ball.group.position.copy(anchor).add(new THREE.Vector3(0, 0.037, 0));
    group.add(ball.group);

    const creature = buildStarter(meta.id);
    creature.group.position.copy(anchor);
    creature.group.visible = false;
    // The sculpts face local +Z and the player approaches the table from the
    // south (+Z), so the resting pose is yaw 0. Starting at PI turned all
    // three to face the wall.
    creature.group.rotation.y = 0;
    group.add(creature.group);

    // Release ring — a flat expanding shockwave across the table surface.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.02, 0.16, 48),
      new THREE.MeshBasicMaterial({
        color: 0xfff0c4,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(anchor).add(new THREE.Vector3(0, 0.004, 0));
    group.add(ring);

    // Sparkle burst riding the release.
    const COUNT = 48;
    const pos = new Float32Array(COUNT * 3);
    const dirs: THREE.Vector3[] = [];
    for (let p = 0; p < COUNT; p++) {
      // Seeded from the index rather than Math.random so a given ball's
      // burst is identical every run and screenshots stay comparable.
      const a = (p / COUNT) * Math.PI * 2 * 3.77 + i;
      const y = ((p * 7919) % 100) / 100;
      dirs.push(new THREE.Vector3(Math.cos(a), 0.35 + y, Math.sin(a)).normalize());
      pos[p * 3] = anchor.x;
      pos[p * 3 + 1] = anchor.y;
      pos[p * 3 + 2] = anchor.z;
    }
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const sparkles = new THREE.Points(
      sparkGeo,
      new THREE.PointsMaterial({
        color: 0xfff4d0,
        size: 0.012,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    sparkles.userData.dirs = dirs;
    sparkles.userData.origin = anchor.clone();
    group.add(sparkles);

    slots.push({
      id: meta.id, name: meta.name, blurb: meta.blurb,
      anchor, ball, creature, release: 0, target: 0, ring, sparkles,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Interaction                                                       */
  /* ---------------------------------------------------------------- */

  const say = (speaker: string, lines: string[], onDone?: () => void): void => {
    ctx.events.emit(EVENTS.SAY, { speaker, lines, onDone });
  };

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    ctx.interaction.register({
      id: `starter-${slot.id}`,
      // Anchor the prompt above the ball so it does not sit inside it.
      position: slot.anchor.clone().add(new THREE.Vector3(0, 0.12, 0)),
      radius: 1.6,
      label: `Look at ${slot.name}`,
      highlight: slot.ball.group,
      enabled: () => phase !== 'chosen',
      onInteract: () => onSlotInteract(i),
    });
  }

  function onSlotInteract(i: number): void {
    if (phase === 'chosen') return;

    // Second press on the same station commits.
    if (phase === 'previewing' && active === i) {
      commit(i);
      return;
    }

    // Switching: recall whoever is currently out.
    if (phase === 'previewing' && active >= 0 && active !== i) {
      slots[active].target = 0;
    }

    active = i;
    phase = 'previewing';
    slots[i].target = 1;
    updateLabels();

    say('PROF. OAK', [
      `So! You're interested in ${slots[i].name}?`,
      slots[i].blurb,
      `Take your time. Press E again to choose ${slots[i].name}, or go and meet the others first.`,
    ]);
  }

  function commit(i: number): void {
    const slot = slots[i];
    phase = 'chosen';
    chosenId = slot.id;
    slot.creature.celebrate();

    // Recall the other two so the chosen one owns the frame.
    for (let j = 0; j < slots.length; j++) if (j !== i) slots[j].target = 0;

    updateLabels();

    say(
      'PROF. OAK',
      [
        `${slot.name}, is it? A fine choice!`,
        `${slot.name} seems delighted to meet you.`,
        'This Pokemon is yours now. Take good care of it!',
      ],
      () => ctx.events.emit(EVENTS.STARTER_CHOSEN, { id: slot.id, name: slot.name }),
    );
  }

  function updateLabels(): void {
    for (let i = 0; i < slots.length; i++) {
      const item = ctx.interaction.items.get(`starter-${slots[i].id}`);
      if (!item) continue;
      item.label =
        phase === 'previewing' && active === i
          ? `Choose ${slots[i].name}`
          : `Look at ${slots[i].name}`;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Ambient intro                                                     */
  /* ---------------------------------------------------------------- */

  // Fires the first time the player nears the table, so the scene introduces
  // itself without seizing control for a cutscene.
  const tableCenter = slots[1].anchor;
  ctx.tick(() => {
    if (introPlayed) return;
    if (ctx.camera.position.distanceTo(tableCenter) < 2.8) {
      introPlayed = true;
      say('PROF. OAK', [
        'Ah, there you are! I was hoping you would come.',
        'Inside these three Poke Balls are three Pokemon. You may have one.',
        'Go on — take a look at each of them, and choose the one you like.',
      ]);
    }
  });

  /* ---------------------------------------------------------------- */
  /* Per-frame                                                         */
  /* ---------------------------------------------------------------- */

  const camWorld = new THREE.Vector3();
  const toCam = new THREE.Vector3();

  ctx.tick((dt, elapsed) => {
    for (const slot of slots) {
      const rate = slot.target > slot.release ? dt / RELEASE_TIME : dt / RECALL_TIME;
      const prev = slot.release;
      slot.release = clamp(slot.release + Math.sign(slot.target - slot.release) * rate, 0, 1);

      slot.ball.update(dt, elapsed);
      slot.ball.setOpen(slot.release);
      // The ball and its Pokemon share one anchor, so once the creature is
      // most of the way out the ball is inside its legs. Retire it as the
      // creature lands — the ball has already done its job by then, and this
      // is what the games do too.
      slot.ball.group.visible = slot.release < 0.72;

      // --- Creature emergence -------------------------------------
      const out = slot.release;
      slot.creature.group.visible = out > 0.001;
      if (out > 0.001) {
        // Overshoot easing: it pops out slightly too big and settles, which
        // is what makes a release read as energetic rather than as a fade-in.
        slot.creature.group.scale.setScalar(Math.max(0.001, easeOutBack(out)));
        slot.creature.group.position.y = slot.anchor.y + (1 - out) * 0.045;
        slot.creature.update(dt, elapsed);

        // Track the player while out.
        //
        // The models are sculpted facing local +Z (the eyes sit at positive z
        // on the head), so yaw = atan2(dx, dz) aims them at a target. Turn
        // briskly: at dt*3 the lerp needs well over a second to cross a half
        // turn, which is slow enough that a creature released behind the
        // player never visibly comes round at all.
        ctx.camera.getWorldPosition(camWorld);
        toCam.copy(camWorld).sub(slot.creature.group.position);
        slot.creature.group.rotation.y = lerpAngle(
          slot.creature.group.rotation.y,
          Math.atan2(toCam.x, toCam.z),
          dt * 9,
        );
        slot.creature.attention = out;
      }

      // --- Release VFX — rising edge only, so recall is quiet -------
      const burst = slot.release > prev ? Math.sin(out * Math.PI) : 0;

      (slot.ring.material as THREE.MeshBasicMaterial).opacity = burst * 0.75;
      const rs = 0.35 + out * 1.5;
      slot.ring.scale.set(rs, rs, rs);

      (slot.sparkles.material as THREE.PointsMaterial).opacity = burst * 0.9;
      if (burst > 0.01) {
        const p = slot.sparkles.geometry.attributes.position as THREE.BufferAttribute;
        const dirs = slot.sparkles.userData.dirs as THREE.Vector3[];
        const origin = slot.sparkles.userData.origin as THREE.Vector3;
        const spread = out * 0.28;
        for (let k = 0; k < dirs.length; k++) {
          // Gravity-arced scatter.
          p.setXYZ(
            k,
            origin.x + dirs[k].x * spread,
            origin.y + dirs[k].y * spread * 1.3 - spread * spread * 0.9,
            origin.z + dirs[k].z * spread,
          );
        }
        p.needsUpdate = true;
      }
    }
  });

  // Exposed so the capture harness can stage the reveal for screenshots.
  ctx.scene.userData.starterDebug = {
    preview: (i: number) => onSlotInteract(i),
    commit: (i: number) => commit(i),
    setRelease: (i: number, v: number) => {
      slots[i].target = v;
      slots[i].release = v;
    },
    get chosen() { return chosenId; },
    slots,
  };
}

/** Overshoot ease — pops past 1, then settles. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

/** Shortest-path angle lerp, so a creature never spins the long way round. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * clamp(t, 0, 1);
}
