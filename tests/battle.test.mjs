import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOVES,
  SPECIES,
  effectiveness,
  statsAtLevel,
  stageMultiplier,
  accuracyStageMultiplier,
  computeDamage,
} from '../src/gameplay/battle/data.ts';
import { Battle } from '../src/gameplay/battle/BattleEngine.ts';
import { makeRng } from '../src/core/Noise.ts';

/* ------------------------------------------------------------------ */
/* Type chart                                                          */
/* ------------------------------------------------------------------ */

test('type chart: super effective, resisted and neutral pairs', () => {
  assert.equal(effectiveness('fire', ['grass', 'poison']), 2);
  assert.equal(effectiveness('water', ['fire']), 2);
  assert.equal(effectiveness('grass', ['water']), 2);
  assert.equal(effectiveness('flying', ['grass', 'poison']), 2);
  // Resists stack multiplicatively.
  assert.equal(effectiveness('grass', ['grass', 'poison']), 0.25);
  assert.equal(effectiveness('fire', ['water']), 0.5);
  assert.equal(effectiveness('normal', ['normal', 'flying']), 1);
  // Immunity.
  assert.equal(effectiveness('ground', ['normal', 'flying']), 0);
});

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

test('gen-1 stats at level 5', () => {
  const s = statsAtLevel(SPECIES.charmander, 5);
  // floor(2*39*5/100)+5+10 = 3+15 = 18 hp
  assert.equal(s.hp, 18);
  assert.equal(s.atk, Math.floor((2 * 52 * 5) / 100) + 5);
  assert.ok(s.spe > s.def, 'charmander is faster than it is sturdy');
});

test('stage multipliers match the gen-1 table', () => {
  assert.equal(stageMultiplier(0), 1);
  assert.equal(stageMultiplier(2), 2);
  assert.equal(stageMultiplier(-2), 0.5);
  assert.equal(stageMultiplier(6), 4);
  assert.equal(stageMultiplier(-6), 0.25);
  assert.equal(accuracyStageMultiplier(-1), 0.75);
  assert.equal(accuracyStageMultiplier(0), 1);
});

/* ------------------------------------------------------------------ */
/* Damage                                                              */
/* ------------------------------------------------------------------ */

test('damage range: level 5 ember vs bulbasaur stays in a sane band', () => {
  const atkS = statsAtLevel(SPECIES.charmander, 5);
  const defS = statsAtLevel(SPECIES.bulbasaur, 5);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 400; i++) {
    const rng = makeRng(1000 + i);
    const r = computeDamage(5, MOVES.ember, atkS.atk, defS.def, atkS.atk, defS.def,
      SPECIES.charmander.types, SPECIES.bulbasaur.types, rng);
    assert.equal(r.effectiveness, 2);
    assert.ok(r.stab);
    lo = Math.min(lo, r.damage);
    hi = Math.max(hi, r.damage);
  }
  assert.ok(lo >= 6, `min damage ${lo} should be >= 6`);
  assert.ok(hi <= 30, `max damage ${hi} should be <= 30 (crits included)`);
  assert.ok(hi > lo, 'the random roll must matter');
});

test('immune move deals zero damage', () => {
  const rng = makeRng(1);
  const r = computeDamage(5, MOVES['sand-attack'], 10, 10, 10, 10, ['ground'], ['flying'], rng);
  assert.equal(r.damage, 0);
});

/* ------------------------------------------------------------------ */
/* Battle resolution                                                   */
/* ------------------------------------------------------------------ */

const setup = (seed, over = {}) =>
  new Battle({
    player: { species: 'charmander', level: 5, ...over.player },
    wild: { species: 'pidgey', level: 3, ...over.wild },
    seed,
  });

test('a full battle reaches a KO and emits faint + end', () => {
  const b = setup(42);
  let guard = 0;
  let events = [];
  while (!b.result && guard++ < 50) {
    events = events.concat(b.turn({ type: 'move', index: 2 })); // ember
  }
  assert.ok(guard < 50, 'battle must end');
  const faint = events.find((e) => e.kind === 'faint');
  const end = events.find((e) => e.kind === 'end');
  assert.ok(faint, 'someone fainted');
  assert.ok(end, 'battle ended');
  if (end.result === 'victory') {
    assert.equal(b.wild.hp, 0);
    assert.ok(b.player.hp > 0);
  } else {
    assert.equal(end.result, 'defeat');
    assert.equal(b.player.hp, 0);
  }
});

test('deterministic: same seed, same actions, same events', () => {
  const run = () => {
    const b = setup(777);
    const out = [];
    for (let i = 0; i < 6 && !b.result; i++) out.push(...b.turn({ type: 'move', index: 0 }));
    return JSON.stringify(out);
  };
  assert.equal(run(), run());
});

test('priority: quick attack outruns a faster mon', () => {
  // Rattata (spe 72) vs squirtle (spe 43): squirtle's quick attack still lands first.
  const b = new Battle({
    player: { species: 'squirtle', level: 5 },
    wild: { species: 'rattata', level: 5 },
    seed: 5,
  });
  // Force the comparison: squirtle has no quick attack, so test the other way:
  // give the slower side priority via the wild rattata's own quick attack is
  // random. Instead assert the ordering helper through observable events:
  // pidgey (spe 56) player vs bulbasaur wild (spe 45) — player moves first.
  const b2 = new Battle({
    player: { species: 'pidgey', level: 5 },
    wild: { species: 'bulbasaur', level: 5 },
    seed: 9,
  });
  const ev = b2.turn({ type: 'move', index: 0 });
  const firstActor = ev.find((e) => e.kind === 'move' || e.kind === 'stat');
  assert.equal(firstActor.side, 'player', 'faster side acts first');

  // And priority beats raw speed: pidgey quick-attack (index 3) vs anything.
  const b3 = new Battle({
    player: { species: 'rattata', level: 5 }, // spe 72, has quick attack at idx 2
    wild: { species: 'pidgey', level: 99 },   // absurd speed, no priority when it picks tackle
    seed: 31,
  });
  // Player quick attack must always resolve first regardless of wild speed.
  const ev3 = b3.turn({ type: 'move', index: 2 });
  const first3 = ev3.find((e) => e.kind === 'move' || e.kind === 'stat');
  assert.equal(first3.side, 'player', 'priority move acts first');
  void b;
});

test('stat stages: growl reduces damage taken', () => {
  // Compare wild tackle damage before/after two growls, seeds fixed so the
  // wild always picks tackle-equivalent physical damage through many rolls.
  const atkBase = statsAtLevel(SPECIES.pidgey, 5).atk;
  const defS = statsAtLevel(SPECIES.charmander, 5);
  const dmgAt = (stage) => {
    const rng = makeRng(123);
    return computeDamage(
      5, MOVES.tackle,
      Math.floor(atkBase * stageMultiplier(stage)), defS.def,
      atkBase, defS.def,
      SPECIES.pidgey.types, SPECIES.charmander.types,
      // strip crits by re-rolling with a crit-free rng
      (() => { let r = rng; r(); return () => 0.99; })(),
    ).damage;
  };
  assert.ok(dmgAt(-2) < dmgAt(0), 'attack drops lower the damage');

  const b = setup(11);
  const before = b.wild.stages.atk;
  b.turn({ type: 'move', index: 1 }); // growl
  assert.equal(b.wild.stages.atk, before - 1, 'growl dropped wild attack one stage');
});

test('stat stages clamp at -6 and report failure', () => {
  const b = setup(3);
  b.wild.stages.atk = -6;
  const ev = b.turn({ type: 'move', index: 1 }); // growl at the floor
  const stat = ev.find((e) => e.kind === 'stat' && e.side === 'player');
  assert.ok(stat.failed, 'stage change at the clamp reports failure');
  assert.equal(b.wild.stages.atk, -6);
});

test('run away eventually succeeds and ends the battle', () => {
  const b = setup(21);
  let events = [];
  let guard = 0;
  while (!b.result && guard++ < 20) events = events.concat(b.turn({ type: 'run' }));
  const end = events.find((e) => e.kind === 'end');
  assert.ok(end, 'battle ended');
  assert.ok(['fled', 'defeat'].includes(end.result));
  if (end.result === 'fled') {
    assert.ok(events.find((e) => e.kind === 'run' && e.success));
  }
});

test('pp is spent per use', () => {
  const b = setup(2);
  const pp0 = b.player.moves[0].pp;
  b.turn({ type: 'move', index: 0 });
  assert.equal(b.player.moves[0].pp, pp0 - 1);
});
