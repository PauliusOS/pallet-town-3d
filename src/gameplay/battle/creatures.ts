import type { Creature } from '../pokemon/shared';

/**
 * A battle-capable creature. The shared Creature contract already spans every
 * buildable species (its `id` is a SpeciesId), so the battle layer's alias is
 * the contract itself — kept as a named type so battle code reads as operating
 * on combatants rather than on the generic sculpt interface.
 */
export type BattleCreature = Creature;

export { buildCreature } from '../Pokemon';
