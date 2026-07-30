/**
 * Dialogue — the bottom conversation panel.
 *
 * Listens for `dialogue:say` on the global bus and owns the screen until the
 * last line is dismissed. While it is open it emits `dialogue:active` so the
 * player controller freezes movement; that contract is the only thing other
 * systems need to know about this file.
 *
 * Reveal model: characters stream in at a readable cadence with a short extra
 * beat after sentence punctuation. Pressing advance mid-reveal completes the
 * line instantly (never skips it), which is the behaviour every Pokemon player
 * already has in their fingers.
 */

import type { GameContext } from '../core/Context';
import { el } from './Menu';

export interface DialogueRequest {
  speaker?: string;
  lines: string[];
  onDone?: () => void;
}

/** Characters per second. Fast enough to not annoy, slow enough to read. */
const CPS = 52;
/** Extra seconds held after a sentence-ending glyph. */
const PUNCT_HOLD: Record<string, number> = {
  '.': 0.18,
  '!': 0.18,
  '?': 0.18,
  ',': 0.08,
  '—': 0.12,
  '…': 0.22,
};

export class DialogueBox {
  readonly name = 'dialogue';
  readonly el: HTMLElement;

  private ctx: GameContext;
  private nameEl: HTMLElement;
  private textEl: HTMLElement;
  private caret: HTMLElement;
  private nextEl: HTMLElement;

  private open = false;
  private lines: string[] = [];
  private index = 0;
  private revealed = 0;
  private hold = 0;
  private onDone: (() => void) | null = null;
  /** Guards against the same keypress that opened the box also advancing it. */
  private openedAt = 0;
  /** Set when the dialogue owned the latest confirm keydown. */
  private confirmConsumed = false;

  constructor(ctx: GameContext) {
    this.ctx = ctx;

    this.el = el('div', 'pt-dialogue');

    this.nameEl = el('div', 'pt-name is-empty');
    this.el.appendChild(this.nameEl);

    const panel = el('div', 'pt-dialogue__panel');
    this.textEl = el('p', 'pt-dialogue__text');
    this.caret = el('span', 'pt-caret', '▌');
    this.textEl.appendChild(document.createTextNode(''));
    this.textEl.appendChild(this.caret);
    panel.appendChild(this.textEl);

    this.nextEl = el('div', 'pt-dialogue__next');
    this.nextEl.appendChild(el('span', 'pt-dialogue__hint', 'Next'));
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 17.2 3.6 8.8a2 2 0 0 1 2.8-2.8L12 11.6l5.6-5.6a2 2 0 1 1 2.8 2.8Z');
    chev.appendChild(path);
    this.nextEl.appendChild(chev);
    panel.appendChild(this.nextEl);

    this.el.appendChild(panel);

    ctx.events.on('dialogue:say', (payload) => this.say(payload as DialogueRequest));
    this.el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.advance();
    });
    window.addEventListener('keydown', this.onKey, true);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Returns whether the current confirm press was handled by the dialogue.
   * The input system records key edges after this capture-phase handler runs,
   * so the gameplay interaction pass consumes this flag on the same frame.
   */
  consumeConfirm(): boolean {
    const consumed = this.confirmConsumed;
    this.confirmConsumed = false;
    return consumed;
  }

  say(req: DialogueRequest | undefined): void {
    if (!req || !req.lines || req.lines.length === 0) return;
    // A conversation already owns the screen; ignore re-triggers rather than
    // stacking them, so leaning on E at a sign cannot build a queue.
    if (this.open) return;

    this.lines = req.lines.slice();
    this.onDone = req.onDone ?? null;
    this.index = 0;
    this.revealed = 0;
    this.hold = 0;
    this.openedAt = performance.now();

    const speaker = (req.speaker ?? '').trim();
    this.nameEl.textContent = speaker;
    this.nameEl.classList.toggle('is-empty', speaker.length === 0);

    this.setText('');
    this.nextEl.classList.remove('is-on');
    this.open = true;
    this.el.classList.add('is-on');
    this.ctx.events.emit('dialogue:active', true);
  }

  /** Advance: complete the line if still revealing, else step to the next. */
  advance(): void {
    if (!this.open) return;
    if (performance.now() - this.openedAt < 180) return;

    const line = this.lines[this.index] ?? '';
    if (this.revealed < line.length) {
      this.revealed = line.length;
      this.hold = 0;
      this.setText(line);
      this.nextEl.classList.add('is-on');
      return;
    }

    this.index += 1;
    if (this.index >= this.lines.length) {
      this.close();
      return;
    }
    this.revealed = 0;
    this.hold = 0;
    this.setText('');
    this.nextEl.classList.remove('is-on');
    this.openedAt = performance.now() - 400; // re-arm immediately for the next line
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('is-on');
    this.nextEl.classList.remove('is-on');
    this.caret.style.opacity = '0';
    const done = this.onDone;
    this.onDone = null;
    this.lines = [];
    this.ctx.events.emit('dialogue:active', false);
    // Let the panel start sliding away before any follow-up sequence fires.
    if (done) window.setTimeout(done, 60);
  }

  update(dt: number): void {
    if (!this.open) return;

    const line = this.lines[this.index] ?? '';

    if (this.revealed < line.length) {
      if (this.hold > 0) {
        this.hold -= dt;
      } else {
        let budget = dt * CPS;
        while (budget >= 1 && this.revealed < line.length) {
          const ch = line[this.revealed];
          this.revealed += 1;
          budget -= 1;
          const pause = PUNCT_HOLD[ch];
          if (pause !== undefined && this.revealed < line.length) {
            this.hold = pause;
            break;
          }
        }
        this.setText(line.slice(0, this.revealed));
      }
      this.caret.style.opacity = this.revealed < line.length ? '0.55' : '0';
    } else {
      this.caret.style.opacity = '0';
      if (!this.nextEl.classList.contains('is-on')) this.nextEl.classList.add('is-on');
    }
  }

  private setText(s: string): void {
    // First child is the text node; the caret span stays put after it.
    const node = this.textEl.firstChild;
    if (node) node.nodeValue = s;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.open || e.repeat) return;
    if (e.metaKey || e.ctrlKey) return;
    if (e.code === 'KeyE' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      e.preventDefault();
      this.confirmConsumed = true;
      this.advance();
    }
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
  }
}
