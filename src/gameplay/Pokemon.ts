/**
 * Barrel for the Pokemon creatures.
 *
 * Each creature owns its own module so they can be sculpted and reviewed
 * independently; this file is the single import site for the rest of the game.
 */
import { buildBulbasaur } from './pokemon/Bulbasaur';
import { buildCharmander } from './pokemon/Charmander';
import { buildSquirtle } from './pokemon/Squirtle';
import { buildPidgey } from './pokemon/Pidgey';
import { buildRattata } from './pokemon/Rattata';
import type { Creature, SpeciesId, StarterId } from './pokemon/shared';

export { buildBulbasaur } from './pokemon/Bulbasaur';
export { buildCharmander } from './pokemon/Charmander';
export { buildSquirtle } from './pokemon/Squirtle';
export { buildPidgey } from './pokemon/Pidgey';
export { buildRattata } from './pokemon/Rattata';
export { buildPokeBall, type PokeBall } from './pokemon/PokeBall';
export { STARTERS, SPECIES, type Creature, type StarterId, type SpeciesId } from './pokemon/shared';

/** Builds any species by id. */
export function buildCreature(id: SpeciesId): Creature {
  switch (id) {
    case 'bulbasaur': return buildBulbasaur();
    case 'charmander': return buildCharmander();
    case 'squirtle': return buildSquirtle();
    case 'pidgey': return buildPidgey();
    case 'rattata': return buildRattata();
  }
}

/** Builds a starter by id. */
export function buildStarter(id: StarterId): Creature {
  return buildCreature(id);
}
