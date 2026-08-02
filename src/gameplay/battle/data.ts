/**
 * Battle data — species stats, moves and the type chart.
 *
 * Pure data + pure functions, no THREE, no DOM. Everything the battle engine
 * needs to compute a turn lives here so BattleEngine.ts stays a state machine
 * and this file stays a spreadsheet.
 *
 * Numbers are Gen-1: base stats from the original games, the Gen-1 damage
 * formula (level 5 wild battles land hits in the 2-9 range, which is the
 * pacing the presentation layer is tuned for), and the classic 217..255/255
 * random roll.
 */

export type SpeciesId = 'bulbasaur' | 'charmander' | 'squirtle' | 'pidgey' | 'rattata';

export type TypeId = 'normal' | 'flying' | 'grass' | 'fire' | 'water' | 'poison' | 'ground';

export type StatId = 'atk' | 'def' | 'spe' | 'acc';

export interface MoveDef {
  id: string;
  name: string;
  type: TypeId;
  /** 0 for status moves. */
  power: number;
  /** 0..1. */
  accuracy: number;
  pp: number;
  priority: number;
  category: 'physical' | 'status';
  /** Stat-stage change applied on hit (status moves only). */
  effect?: { stat: StatId; delta: number; target: 'foe' | 'self' };
  /** Presentation hint for the FX layer. */
  fx: 'tackle' | 'quick' | 'vine' | 'ember' | 'water' | 'gust' | 'growl' | 'tailwhip' | 'sand';
}

export const MOVES: Record<string, MoveDef> = {
  tackle: {
    id: 'tackle', name: 'Tackle', type: 'normal', power: 40, accuracy: 0.95,
    pp: 35, priority: 0, category: 'physical', fx: 'tackle',
  },
  scratch: {
    id: 'scratch', name: 'Scratch', type: 'normal', power: 40, accuracy: 1,
    pp: 35, priority: 0, category: 'physical', fx: 'tackle',
  },
  'quick-attack': {
    id: 'quick-attack', name: 'Quick Attack', type: 'normal', power: 40, accuracy: 1,
    pp: 30, priority: 1, category: 'physical', fx: 'quick',
  },
  'vine-whip': {
    id: 'vine-whip', name: 'Vine Whip', type: 'grass', power: 45, accuracy: 1,
    pp: 25, priority: 0, category: 'physical', fx: 'vine',
  },
  ember: {
    id: 'ember', name: 'Ember', type: 'fire', power: 40, accuracy: 1,
    pp: 25, priority: 0, category: 'physical', fx: 'ember',
  },
  'water-gun': {
    id: 'water-gun', name: 'Water Gun', type: 'water', power: 40, accuracy: 1,
    pp: 25, priority: 0, category: 'physical', fx: 'water',
  },
  gust: {
    id: 'gust', name: 'Gust', type: 'flying', power: 40, accuracy: 1,
    pp: 35, priority: 0, category: 'physical', fx: 'gust',
  },
  growl: {
    id: 'growl', name: 'Growl', type: 'normal', power: 0, accuracy: 1,
    pp: 40, priority: 0, category: 'status', fx: 'growl',
    effect: { stat: 'atk', delta: -1, target: 'foe' },
  },
  'tail-whip': {
    id: 'tail-whip', name: 'Tail Whip', type: 'normal', power: 0, accuracy: 1,
    pp: 30, priority: 0, category: 'status', fx: 'tailwhip',
    effect: { stat: 'def', delta: -1, target: 'foe' },
  },
  'sand-attack': {
    id: 'sand-attack', name: 'Sand Attack', type: 'ground', power: 0, accuracy: 1,
    pp: 15, priority: 0, category: 'status', fx: 'sand',
    effect: { stat: 'acc', delta: -1, target: 'foe' },
  },
};

export interface SpeciesBattleData {
  id: SpeciesId;
  name: string;
  types: TypeId[];
  /** Gen-1 base stats. `spe` doubles as the run-away and turn-order stat. */
  base: { hp: number; atk: number; def: number; spe: number };
  /** Move ids in learn order; a battle set is the first four. */
  moves: string[];
}

export const SPECIES: Record<SpeciesId, SpeciesBattleData> = {
  bulbasaur: {
    id: 'bulbasaur', name: 'Bulbasaur', types: ['grass', 'poison'],
    base: { hp: 45, atk: 49, def: 49, spe: 45 },
    moves: ['tackle', 'growl', 'vine-whip'],
  },
  charmander: {
    id: 'charmander', name: 'Charmander', types: ['fire'],
    base: { hp: 39, atk: 52, def: 43, spe: 65 },
    moves: ['scratch', 'growl', 'ember'],
  },
  squirtle: {
    id: 'squirtle', name: 'Squirtle', types: ['water'],
    base: { hp: 44, atk: 48, def: 65, spe: 43 },
    moves: ['tackle', 'tail-whip', 'water-gun'],
  },
  pidgey: {
    id: 'pidgey', name: 'Pidgey', types: ['normal', 'flying'],
    base: { hp: 40, atk: 45, def: 40, spe: 56 },
    moves: ['tackle', 'sand-attack', 'gust', 'quick-attack'],
  },
  rattata: {
    id: 'rattata', name: 'Rattata', types: ['normal'],
    base: { hp: 30, atk: 56, def: 35, spe: 72 },
    moves: ['tackle', 'tail-whip', 'quick-attack'],
  },
};

/**
 * Type effectiveness, attacker -> defender. Only pairs that differ from 1 are
 * listed; everything else is neutral. Covers every type the five species and
 * their movepools can produce.
 */
const CHART: Partial<Record<TypeId, Partial<Record<TypeId, number>>>> = {
  flying: { grass: 2 },
  grass: { water: 2, ground: 2, fire: 0.5, grass: 0.5, poison: 0.5, flying: 0.5 },
  fire: { grass: 2, fire: 0.5, water: 0.5 },
  water: { fire: 2, ground: 2, water: 0.5, grass: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5 },
  ground: { fire: 2, poison: 2, grass: 0.5, flying: 0 },
};

/** Combined effectiveness of a move type against a defender's type list. */
export function effectiveness(moveType: TypeId, defenderTypes: TypeId[]): number {
  let mult = 1;
  for (const t of defenderTypes) {
    mult *= CHART[moveType]?.[t] ?? 1;
  }
  return mult;
}

/** Gen-1 stat formulas at a level, no IVs/EVs. */
export function statsAtLevel(species: SpeciesBattleData, level: number) {
  const grow = (base: number) => Math.floor((2 * base * level) / 100);
  return {
    hp: grow(species.base.hp) + level + 10,
    atk: grow(species.base.atk) + 5,
    def: grow(species.base.def) + 5,
    spe: grow(species.base.spe) + 5,
  };
}

/** Gen-1 stat-stage multiplier: -6..+6 -> 2/8 .. 8/2. */
export function stageMultiplier(stage: number): number {
  const s = Math.max(-6, Math.min(6, stage));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

/** Accuracy stages use thirds rather than halves. */
export function accuracyStageMultiplier(stage: number): number {
  const s = Math.max(-6, Math.min(6, stage));
  return s >= 0 ? (3 + s) / 3 : 3 / (3 - s);
}

export interface DamageRoll {
  damage: number;
  crit: boolean;
  effectiveness: number;
  stab: boolean;
}

/**
 * Gen-1 damage. `rng` supplies every roll so a seeded battle is replayable.
 *
 * Crits are a flat 1/16 and double the level term (which is what Gen 1 does —
 * at equal levels it comes out just under 2x). Gen 1 also has crits ignore
 * stat stages; that subtlety is kept because it prevents a Growl-locked player
 * from being unable to win.
 */
export function computeDamage(
  level: number,
  move: MoveDef,
  atk: number,
  def: number,
  atkUnmodified: number,
  defUnmodified: number,
  attackerTypes: TypeId[],
  defenderTypes: TypeId[],
  rng: () => number,
): DamageRoll {
  const eff = effectiveness(move.type, defenderTypes);
  const stab = attackerTypes.includes(move.type);
  if (move.power <= 0 || eff === 0) {
    return { damage: 0, crit: false, effectiveness: eff, stab };
  }

  const crit = rng() < 1 / 16;
  const L = crit ? level * 2 : level;
  const A = crit ? atkUnmodified : atk;
  const D = crit ? defUnmodified : def;

  let dmg = Math.floor(Math.floor((Math.floor((2 * L) / 5 + 2) * move.power * A) / Math.max(1, D)) / 50) + 2;
  if (stab) dmg = Math.floor(dmg * 1.5);
  dmg = Math.floor(dmg * eff);
  if (dmg > 0) {
    const roll = 217 + Math.floor(rng() * 39); // 217..255
    dmg = Math.max(1, Math.floor((dmg * roll) / 255));
  }
  return { damage: dmg, crit, effectiveness: eff, stab };
}
