import type { GameContext } from '../../core/Context';
import { EVENTS } from '../../core/Context';
import { SPECIES, statsAtLevel, type SpeciesId } from './data';

/**
 * PlayerData — the little that persists between battles.
 *
 * One partner Pokemon: species, level, and current HP carried from battle to
 * battle. Wild battles are not saved anywhere; a white-out heals. The module
 * is a singleton because exactly one save slot exists.
 */

export interface PartyMon {
  species: SpeciesId;
  level: number;
  /** Current HP, tracked between battles. */
  hp: number;
  maxHp: number;
}

class PlayerDataStore {
  private mon: PartyMon | null = null;

  init(ctx: GameContext): void {
    ctx.events.on(EVENTS.STARTER_CHOSEN, (payload) => {
      const id = (payload as { id?: SpeciesId })?.id;
      if (id && SPECIES[id]) this.setPartner(id, 5);
    });
  }

  get partner(): PartyMon | null {
    return this.mon;
  }

  get hasStarter(): boolean {
    return this.mon !== null;
  }

  setPartner(species: SpeciesId, level: number): void {
    const maxHp = statsAtLevel(SPECIES[species], level).hp;
    this.mon = { species, level, hp: maxHp, maxHp };
  }

  /** Ensures a partner exists (debug/battleDebug path). */
  ensurePartner(fallback: SpeciesId = 'charmander'): PartyMon {
    if (!this.mon) this.setPartner(fallback, 5);
    return this.mon!;
  }

  /** Records post-battle HP. */
  setHp(hp: number): void {
    if (this.mon) this.mon.hp = Math.max(0, Math.min(this.mon.maxHp, hp));
  }

  healAll(): void {
    if (this.mon) this.mon.hp = this.mon.maxHp;
  }
}

export const PlayerData = new PlayerDataStore();
