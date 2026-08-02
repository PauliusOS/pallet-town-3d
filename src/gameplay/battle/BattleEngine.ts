/**
 * BattleEngine — pure turn logic. No THREE, no DOM, no timers.
 *
 * The engine owns a battle's authoritative state and resolves one full turn
 * per call, returning a typed event list that the presentation layer plays
 * back at its own pace. Every random roll goes through the seeded rng handed
 * to the constructor, so a battle is a pure function of (setup, seed, action
 * sequence) — which is what makes the screenshot harness and the unit tests
 * possible.
 */

import {
  MOVES,
  SPECIES,
  computeDamage,
  accuracyStageMultiplier,
  stageMultiplier,
  statsAtLevel,
  type MoveDef,
  type SpeciesId,
  type StatId,
} from './data';
import { makeRng } from '../../core/Noise';

export type Side = 'player' | 'wild';

export interface MoveSlot {
  id: string;
  pp: number;
}

export interface Combatant {
  side: Side;
  species: SpeciesId;
  name: string;
  level: number;
  stats: { hp: number; atk: number; def: number; spe: number };
  hp: number;
  moves: MoveSlot[];
  stages: Record<StatId, number>;
}

export type BattleAction = { type: 'move'; index: number } | { type: 'run' };

export type BattleEvent =
  | {
      kind: 'move';
      side: Side;
      moveId: string;
      moveName: string;
      missed: boolean;
      damage: number;
      effectiveness: number;
      crit: boolean;
      /** Defender hp after the hit. */
      hpAfter: number;
    }
  | { kind: 'stat'; side: Side; target: Side; stat: StatId; delta: number; failed: boolean; moveName: string }
  | { kind: 'faint'; side: Side }
  | { kind: 'run'; success: boolean }
  | { kind: 'end'; result: 'victory' | 'defeat' | 'fled' };

export type BattleResult = 'victory' | 'defeat' | 'fled' | null;

export interface CombatantInit {
  species: SpeciesId;
  level: number;
  /** Carry-over HP from a previous battle; omitted = full. */
  hp?: number;
}

function buildCombatant(side: Side, init: CombatantInit): Combatant {
  const data = SPECIES[init.species];
  const stats = statsAtLevel(data, init.level);
  return {
    side,
    species: init.species,
    name: data.name.toUpperCase(),
    level: init.level,
    stats,
    hp: Math.max(1, Math.min(stats.hp, init.hp ?? stats.hp)),
    moves: data.moves.slice(0, 4).map((id) => ({ id, pp: MOVES[id].pp })),
    stages: { atk: 0, def: 0, spe: 0, acc: 0 },
  };
}

export class Battle {
  readonly player: Combatant;
  readonly wild: Combatant;
  result: BattleResult = null;
  private rng: () => number;
  private runAttempts = 0;

  constructor(opts: { player: CombatantInit; wild: CombatantInit; seed: number }) {
    this.player = buildCombatant('player', opts.player);
    this.wild = buildCombatant('wild', opts.wild);
    this.rng = makeRng(opts.seed >>> 0 || 1);
  }

  side(s: Side): Combatant {
    return s === 'player' ? this.player : this.wild;
  }

  /** Resolves one full turn. The wild side picks its own move. */
  turn(action: BattleAction): BattleEvent[] {
    if (this.result) return [];
    const events: BattleEvent[] = [];

    // ---- Run attempt resolves before anything else (Gen-1 wild battles).
    if (action.type === 'run') {
      this.runAttempts++;
      if (this.tryRun()) {
        events.push({ kind: 'run', success: true });
        events.push({ kind: 'end', result: 'fled' });
        this.result = 'fled';
        return events;
      }
      events.push({ kind: 'run', success: false });
      // Failed run: the wild mon gets a free hit.
      this.act(this.wild, this.player, this.pickWildMove(), events);
      this.checkEnd(events);
      return events;
    }

    const playerMove = this.moveFor(this.player, action.index);
    const wildMove = this.pickWildMove();

    const first = this.orderFirst(playerMove, wildMove);
    const order: [Combatant, Combatant, MoveDef][] =
      first === 'player'
        ? [
            [this.player, this.wild, playerMove],
            [this.wild, this.player, wildMove],
          ]
        : [
            [this.wild, this.player, wildMove],
            [this.player, this.wild, playerMove],
          ];

    for (const [attacker, defender, move] of order) {
      if (this.result) break;
      if (attacker.hp <= 0) continue;
      this.act(attacker, defender, move, events);
      this.checkEnd(events);
    }
    return events;
  }

  // ---------------------------------------------------------------- helpers

  private moveFor(c: Combatant, index: number): MoveDef {
    const slot = c.moves[Math.max(0, Math.min(c.moves.length - 1, index))];
    return MOVES[slot.id];
  }

  private pickWildMove(): MoveDef {
    const usable = this.wild.moves.filter((m) => m.pp > 0);
    const pool = usable.length > 0 ? usable : this.wild.moves;
    const pickIdx = Math.min(pool.length - 1, Math.floor(this.rng() * pool.length));
    return MOVES[pool[pickIdx].id];
  }

  private orderFirst(playerMove: MoveDef, wildMove: MoveDef): Side {
    if (playerMove.priority !== wildMove.priority) {
      return playerMove.priority > wildMove.priority ? 'player' : 'wild';
    }
    const ps = this.player.stats.spe * stageMultiplier(this.player.stages.spe);
    const ws = this.wild.stats.spe * stageMultiplier(this.wild.stages.spe);
    if (ps !== ws) return ps > ws ? 'player' : 'wild';
    return this.rng() < 0.5 ? 'player' : 'wild';
  }

  private act(attacker: Combatant, defender: Combatant, move: MoveDef, events: BattleEvent[]): void {
    // Spend PP.
    const slot = attacker.moves.find((m) => m.id === move.id);
    if (slot && slot.pp > 0) slot.pp--;

    // Accuracy.
    const acc = move.accuracy * accuracyStageMultiplier(attacker.stages.acc);
    const hit = this.rng() < acc;

    if (move.category === 'status') {
      if (!hit || !move.effect) {
        events.push({
          kind: 'stat', side: attacker.side, target: defender.side,
          stat: move.effect?.stat ?? 'atk', delta: 0, failed: true, moveName: move.name,
        });
        return;
      }
      const target = move.effect.target === 'self' ? attacker : defender;
      const prev = target.stages[move.effect.stat];
      const next = Math.max(-6, Math.min(6, prev + move.effect.delta));
      target.stages[move.effect.stat] = next;
      events.push({
        kind: 'stat', side: attacker.side, target: target.side,
        stat: move.effect.stat, delta: next - prev, failed: next === prev, moveName: move.name,
      });
      return;
    }

    if (!hit) {
      events.push({
        kind: 'move', side: attacker.side, moveId: move.id, moveName: move.name,
        missed: true, damage: 0, effectiveness: 1, crit: false, hpAfter: defender.hp,
      });
      return;
    }

    const roll = computeDamage(
      attacker.level,
      move,
      Math.floor(attacker.stats.atk * stageMultiplier(attacker.stages.atk)),
      Math.floor(defender.stats.def * stageMultiplier(defender.stages.def)),
      attacker.stats.atk,
      defender.stats.def,
      SPECIES[attacker.species].types,
      SPECIES[defender.species].types,
      this.rng,
    );

    defender.hp = Math.max(0, defender.hp - roll.damage);
    events.push({
      kind: 'move', side: attacker.side, moveId: move.id, moveName: move.name,
      missed: false, damage: roll.damage, effectiveness: roll.effectiveness,
      crit: roll.crit, hpAfter: defender.hp,
    });

    if (defender.hp <= 0) {
      events.push({ kind: 'faint', side: defender.side });
    }
  }

  private checkEnd(events: BattleEvent[]): void {
    if (this.result) return;
    if (this.wild.hp <= 0) {
      this.result = 'victory';
      events.push({ kind: 'end', result: 'victory' });
    } else if (this.player.hp <= 0) {
      this.result = 'defeat';
      events.push({ kind: 'end', result: 'defeat' });
    }
  }

  /**
   * Gen-1 escape odds. At these levels the player's speed usually clears the
   * threshold outright, but the roll is kept so a slow mon against a quick
   * wild can genuinely fail to get away.
   */
  private tryRun(): boolean {
    const a = this.player.stats.spe;
    const b = Math.max(1, Math.floor(this.wild.stats.spe / 4) % 256);
    const f = Math.floor((a * 32) / b) + 30 * this.runAttempts;
    if (f > 255) return true;
    return Math.floor(this.rng() * 256) < f;
  }
}
