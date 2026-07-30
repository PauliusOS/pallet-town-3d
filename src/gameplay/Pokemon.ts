/**
 * Barrel for the starter Pokemon.
 *
 * Each creature owns its own module so they can be sculpted and reviewed
 * independently; this file is the single import site for the rest of the game.
 */
import { buildBulbasaur } from './pokemon/Bulbasaur';
import { buildCharmander } from './pokemon/Charmander';
import { buildSquirtle } from './pokemon/Squirtle';
import type { Creature, StarterId } from './pokemon/shared';

export { buildBulbasaur } from './pokemon/Bulbasaur';
export { buildCharmander } from './pokemon/Charmander';
export { buildSquirtle } from './pokemon/Squirtle';
export { buildPokeBall, type PokeBall } from './pokemon/PokeBall';
export { STARTERS, type Creature, type StarterId } from './pokemon/shared';

/** Builds a starter by id. */
export function buildStarter(id: StarterId): Creature {
  switch (id) {
    case 'bulbasaur': return buildBulbasaur();
    case 'charmander': return buildCharmander();
    case 'squirtle': return buildSquirtle();
  }
}
