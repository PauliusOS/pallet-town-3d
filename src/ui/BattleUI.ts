import './battle.css';
import { el } from './Menu';
import { MOVES, type MoveDef } from '../gameplay/battle/data';
import type { MoveSlot } from '../gameplay/battle/BattleEngine';

/**
 * BattleUI — the DOM layer of a battle. Two HP plates, a message strip with
 * the dialogue box's typewriter cadence, and a keyboard-navigable action
 * panel. Pure presentation: BattleSystem drives it and reads selections back
 * through callbacks.
 */

const CPS = 52;

interface Plate {
  root: HTMLElement;
  name: HTMLElement;
  lv: HTMLElement;
  fill: HTMLElement;
  num: HTMLElement | null;
  /** Displayed fraction, eased toward target. */
  shown: number;
  target: number;
  max: number;
}

export type MenuChoice = { kind: 'fight' } | { kind: 'run' } | { kind: 'move'; index: number } | { kind: 'back' };

export class BattleUI {
  readonly el: HTMLElement;

  /** Fired when the player confirms a highlighted entry. */
  onChoose: ((c: MenuChoice) => void) | null = null;
  /** Fired on any selection change (for the tick sfx). */
  onNavigate: (() => void) | null = null;

  private foe: Plate;
  private ally: Plate;

  private msg: HTMLElement;
  private msgText: HTMLElement;
  private line = '';
  private revealed = 0;
  private msgDone: (() => void) | null = null;
  private msgHold = 0;

  private actions: HTMLElement;
  private grid: HTMLElement;
  private hint: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private choices: MenuChoice[] = [];
  private sel = 0;
  private menuMode: 'none' | 'main' | 'moves' = 'none';

  constructor(host: HTMLElement) {
    this.el = el('div', 'pt-battle');

    this.foe = this.buildPlate('pt-plate pt-plate--foe', false);
    this.ally = this.buildPlate('pt-plate pt-plate--ally', true);
    this.el.appendChild(this.foe.root);
    this.el.appendChild(this.ally.root);

    this.msg = el('div', 'pt-bmsg');
    this.msgText = el('p', 'pt-bmsg__text', '');
    this.msg.appendChild(this.msgText);
    this.el.appendChild(this.msg);

    this.actions = el('div', 'pt-bactions');
    this.grid = el('div', 'pt-bactions__grid');
    this.actions.appendChild(this.grid);
    this.hint = el('div', 'pt-bactions__hint', '');
    this.actions.appendChild(this.hint);
    this.el.appendChild(this.actions);

    host.appendChild(this.el);
  }

  private buildPlate(cls: string, withNumbers: boolean): Plate {
    const root = el('div', cls);
    const row = el('div', 'pt-plate__row');
    const name = el('span', 'pt-plate__name', '—');
    const lv = el('span', 'pt-plate__lv', 'Lv 5');
    row.appendChild(name);
    row.appendChild(lv);
    root.appendChild(row);

    const bar = el('div', 'pt-hpbar');
    bar.appendChild(el('span', 'pt-hpbar__label', 'HP'));
    const fill = el('div', 'pt-hpbar__fill');
    bar.appendChild(fill);
    root.appendChild(bar);

    let num: HTMLElement | null = null;
    if (withNumbers) {
      num = el('div', 'pt-plate__hpnum', '— / —');
      root.appendChild(num);
    }
    return { root, name, lv, fill, num, shown: 1, target: 1, max: 1 };
  }

  /* ---------------------------------------------------------- lifecycle */

  show(): void {
    this.el.classList.add('is-on');
    document.querySelector('.pt-ui')?.classList.add('in-battle');
  }

  hide(): void {
    this.el.classList.remove('is-on');
    this.hideMenu();
    this.hideMessage();
    document.querySelector('.pt-ui')?.classList.remove('in-battle');
  }

  /* ------------------------------------------------------------- plates */

  setFoe(name: string, level: number, hpFrac: number): void {
    this.foe.name.textContent = name;
    this.foe.lv.textContent = `Lv ${level}`;
    this.foe.shown = this.foe.target = hpFrac;
  }

  setAlly(name: string, level: number, hp: number, maxHp: number): void {
    this.ally.name.textContent = name;
    this.ally.lv.textContent = `Lv ${level}`;
    this.ally.max = maxHp;
    this.ally.shown = this.ally.target = hp / maxHp;
    if (this.ally.num) this.ally.num.textContent = `${hp} / ${maxHp}`;
  }

  /** Starts an animated drain toward the new fraction. */
  driveFoeHp(frac: number): void {
    this.foe.target = Math.max(0, Math.min(1, frac));
  }

  driveAllyHp(hp: number): void {
    this.ally.target = Math.max(0, Math.min(1, hp / this.ally.max));
  }

  /** True while an HP bar is still easing toward its target. */
  get draining(): boolean {
    return (
      Math.abs(this.foe.shown - this.foe.target) > 0.002 ||
      Math.abs(this.ally.shown - this.ally.target) > 0.002
    );
  }

  /* ------------------------------------------------------------ message */

  /** Typewriter message; resolves after the line completes + a beat. */
  say(text: string, holdSeconds = 0.55): Promise<void> {
    this.msg.classList.add('is-on');
    this.line = text;
    this.revealed = 0;
    this.msgHold = holdSeconds;
    this.msgText.textContent = '';
    return new Promise((res) => {
      this.msgDone = res;
    });
  }

  /** Instantly completes the current line (confirm-to-skip). */
  rushMessage(): void {
    this.revealed = this.line.length;
    this.msgText.textContent = this.line;
    this.msgHold = Math.min(this.msgHold, 0.1);
  }

  hideMessage(): void {
    this.msg.classList.remove('is-on');
    this.msgText.textContent = '';
    this.line = '';
    this.msgDone = null;
  }

  /* --------------------------------------------------------------- menu */

  showMainMenu(): void {
    this.menuMode = 'main';
    this.grid.classList.remove('is-moves');
    this.buildButtons(
      [
        { label: 'Fight', sub: 'Choose a move', cls: 'pt-bbtn--fight', choice: { kind: 'fight' } as MenuChoice },
        { label: 'Run', sub: 'Flee the battle', cls: 'pt-bbtn--run', choice: { kind: 'run' } as MenuChoice },
      ],
    );
    this.hint.textContent = 'E confirm';
    this.actions.classList.add('is-on');
  }

  showMoves(moves: MoveSlot[]): void {
    this.menuMode = 'moves';
    this.grid.classList.add('is-moves');
    this.buildButtons(
      moves.map((slot, i) => {
        const def: MoveDef = MOVES[slot.id];
        return {
          label: def.name,
          subChip: def.type,
          sub: `PP ${slot.pp}/${def.pp}`,
          cls: '',
          disabled: slot.pp <= 0,
          choice: { kind: 'move', index: i } as MenuChoice,
        };
      }),
    );
    this.hint.textContent = 'Q back · E confirm';
    this.actions.classList.add('is-on');
  }

  hideMenu(): void {
    this.menuMode = 'none';
    this.actions.classList.remove('is-on');
  }

  get menuOpen(): 'none' | 'main' | 'moves' {
    return this.menuMode;
  }

  private buildButtons(
    defs: { label: string; sub?: string; subChip?: string; cls?: string; disabled?: boolean; choice: MenuChoice }[],
  ): void {
    this.grid.innerHTML = '';
    this.buttons = [];
    this.choices = [];
    this.sel = 0;
    defs.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = `pt-bbtn ${d.cls ?? ''}`.trim();
      b.type = 'button';
      if (d.disabled) b.disabled = true;
      b.appendChild(el('span', 'pt-bbtn__label', d.label));
      const sub = el('span', 'pt-bbtn__sub');
      if (d.subChip) sub.appendChild(el('span', `pt-chip pt-chip--${d.subChip}`, d.subChip));
      if (d.sub) sub.appendChild(el('span', undefined, d.sub));
      b.appendChild(sub);
      b.addEventListener('mouseenter', () => this.select(i));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(i);
        this.confirm();
      });
      this.grid.appendChild(b);
      this.buttons.push(b);
      this.choices.push(d.choice);
    });
    this.applySelection();
  }

  private select(i: number): void {
    if (i === this.sel || !this.buttons[i]) return;
    this.sel = i;
    this.applySelection();
    this.onNavigate?.();
  }

  private applySelection(): void {
    this.buttons.forEach((b, i) => b.classList.toggle('is-sel', i === this.sel));
  }

  /** Keyboard navigation from BattleSystem. Grid is 2 columns. */
  nav(dir: 'up' | 'down' | 'left' | 'right'): void {
    if (this.menuMode === 'none' || this.buttons.length === 0) return;
    const cols = 2;
    let i = this.sel;
    if (dir === 'left') i = i % cols === 0 ? i : i - 1;
    else if (dir === 'right') i = i % cols === cols - 1 || i + 1 >= this.buttons.length ? i : i + 1;
    else if (dir === 'up') i = i - cols >= 0 ? i - cols : i;
    else if (dir === 'down') i = i + cols < this.buttons.length ? i + cols : i;
    this.select(Math.max(0, Math.min(this.buttons.length - 1, i)));
  }

  confirm(): void {
    if (this.menuMode === 'none') return;
    const c = this.choices[this.sel];
    if (!c || this.buttons[this.sel]?.disabled) return;
    this.onChoose?.(c);
  }

  back(): void {
    if (this.menuMode === 'moves') this.onChoose?.({ kind: 'back' });
  }

  /* ------------------------------------------------------------- update */

  update(dt: number): void {
    // Typewriter.
    if (this.msgDone) {
      if (this.revealed < this.line.length) {
        this.revealed = Math.min(this.line.length, this.revealed + dt * CPS);
        this.msgText.textContent = this.line.slice(0, Math.floor(this.revealed));
      } else {
        this.msgHold -= dt;
        if (this.msgHold <= 0) {
          const done = this.msgDone;
          this.msgDone = null;
          done();
        }
      }
    }

    // HP drains: exponential ease, ~0.6s to close a full-bar gap.
    for (const p of [this.foe, this.ally]) {
      const k = Math.min(1, dt * 5.2);
      if (Math.abs(p.shown - p.target) > 0.0005) {
        p.shown += (p.target - p.shown) * k;
        if (Math.abs(p.shown - p.target) < 0.003) p.shown = p.target;
      }
      const pct = Math.max(0, Math.min(1, p.shown));
      p.fill.style.width = `calc(${(pct * 100).toFixed(2)}% - 4px)`;
      p.fill.classList.toggle('is-warn', pct <= 0.5 && pct > 0.21);
      p.fill.classList.toggle('is-danger', pct <= 0.21);
      if (p.num) {
        const hp = Math.round(p.shown * p.max);
        p.num.textContent = `${hp} / ${p.max}`;
      }
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
