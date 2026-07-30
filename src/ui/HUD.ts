/**
 * HUD — the whole DOM interface layer, mounted over the canvas.
 *
 * Owns four things and nothing else:
 *   • the loading curtain and the start / pause card   (Menu.ts)
 *   • the conversation panel                           (Dialogue.ts)
 *   • the interaction prompt driven by InteractionSystem.onFocusChange
 *   • the crosshair
 *
 * It never touches the 3D scene. It listens to the event bus and to pointer
 * lock, and it emits nothing except what Dialogue emits on its behalf.
 */

import './ui.css';
import type { GameContext } from '../core/Context';
import type { Interactable } from '../world/Interaction';
import { LoadingScreen, StartCard, el } from './Menu';
import { DialogueBox } from './Dialogue';

/** Pretty names for the raw key codes an interactable can ask for. */
const KEY_LABEL: Record<string, string> = {
  E: 'E',
  KeyE: 'E',
  F: 'F',
  KeyF: 'F',
  Enter: 'Enter',
  Space: 'Space',
};

/**
 * The automated capture harness drives the game with no user gesture, so the
 * click-to-play card would sit in front of every art-review screenshot. Under
 * automation we drop straight into the world; `?ui=title` forces the card back
 * for inspecting it.
 */
function isAutomated(): boolean {
  const q = new URLSearchParams(location.search);
  if (q.get('ui') === 'title') return false;
  if (q.has('auto') || q.has('capture')) return true;
  return navigator.webdriver === true;
}

export class HUD {
  readonly name = 'hud';

  readonly root: HTMLElement;
  readonly dialogue: DialogueBox;

  private ctx: GameContext;
  private loading: LoadingScreen;
  private start: StartCard;

  private crosshair: HTMLElement;
  private prompt: HTMLElement;
  private promptKey: HTMLElement;
  private promptLabel: HTMLElement;

  private hint: HTMLElement;
  private hintTimer = 0;

  private booted = false;
  private auto = false;
  /** Seconds left before an unlock is treated as a real pause. */
  private lockReturn = 0;
  /** True only after this game canvas has actually owned pointer lock. */
  private wasPointerLocked = false;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.auto = isAutomated();

    this.root = el('div', 'pt-ui');

    // --- crosshair -------------------------------------------------------
    this.crosshair = el('div', 'pt-crosshair');
    this.crosshair.appendChild(el('i'));
    this.root.appendChild(this.crosshair);

    // --- interaction prompt ---------------------------------------------
    this.prompt = el('div', 'pt-prompt');
    this.promptKey = el('span', 'pt-key', 'E');
    this.promptLabel = el('span', 'pt-prompt__label', '');
    this.prompt.appendChild(this.promptKey);
    this.prompt.appendChild(this.promptLabel);
    this.root.appendChild(this.prompt);

    // --- transient hint (pointer-lock fallback notice) -------------------
    this.hint = el('div', 'pt-hint');
    this.root.appendChild(this.hint);

    // --- dialogue --------------------------------------------------------
    this.dialogue = new DialogueBox(ctx);
    this.root.appendChild(this.dialogue.el);

    // --- overlays --------------------------------------------------------
    this.start = new StartCard();
    this.start.onStart = () => this.beginPlay();
    this.root.appendChild(this.start.el);

    this.loading = new LoadingScreen();
    this.root.appendChild(this.loading.el);

    // Mount inside the app container so overlay clicks still bubble to the
    // engine's gesture handler (pointer lock + audio unlock).
    const host = document.getElementById('app') ?? document.body;
    host.appendChild(this.root);

    // --- wiring ----------------------------------------------------------
    const prevFocus = ctx.interaction.onFocusChange;
    ctx.interaction.onFocusChange = (item) => {
      prevFocus?.(item);
      this.setFocus(item);
    };

    ctx.events.on('dialogue:active', (active) => {
      const on = Boolean(active);
      if (on) {
        this.setPrompt(false);
        this.crosshair.classList.remove('is-on');
      } else {
        this.setFocus(ctx.interaction.focused);
        if (this.booted && !this.start.visible) this.crosshair.classList.add('is-on');
      }
    });

    // A refused lock is not a pause — the browser said no. Without this the
    // card would already be gone and `suspended` already false, dropping the
    // player into the world with a free cursor and a camera that cannot turn.
    ctx.engine.input.onLockError = () => this.onLockDenied();

    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  /* ------------------------------------------------------------ loading */

  setLoading(label: string, pct: number): void {
    this.loading.set(label, pct);
  }

  hideLoading(): void {
    this.loading.hide(() => {
      this.booted = true;
      if (this.auto) this.crosshair.classList.add('is-on');
      else {
        this.ctx.engine.input.suspended = true;
        this.start.show('title');
      }
    }, this.auto);
  }

  /* ------------------------------------------------------------- update */

  update(dt: number): void {
    this.dialogue.update(dt);

    if (this.lockReturn > 0) {
      this.lockReturn -= dt;
      if (this.lockReturn <= 0) this.pauseIfUnlocked();
    }
  }

  private pauseIfUnlocked(): void {
    if (this.auto || !this.booted) return;
    if (document.pointerLockElement === this.ctx.engine.renderer.domElement) return;
    this.start.show('paused', this.relockWait());
    this.ctx.engine.input.suspended = true;
    this.setPrompt(false);
    this.crosshair.classList.remove('is-on');
  }

  /**
   * How long the card should stay unclickable. The floor swallows the click that
   * released the cursor in the first place; beyond that it waits out the
   * browser's relock cooldown, so the click it finally accepts is one that can
   * actually take the lock.
   */
  private relockWait(): number {
    return Math.max(140, this.ctx.engine.input.relockWaitMs);
  }

  /**
   * The browser turned a lock request down. One refusal is usually the cooldown
   * or a click the page never really owned, so the card comes back to invite
   * another try. A second refusal in a row means pointer lock is off the table
   * here — an iframe without `allow="pointer-lock"` being the common case — so
   * the game switches to drag-to-look rather than leaving the camera dead.
   */
  private onLockDenied(): void {
    if (this.auto || !this.booted) return;
    const input = this.ctx.engine.input;

    if (input.lockFailures >= 2 || !input.lockSupported) {
      input.dragLook = true;
      input.suspended = false;
      this.start.hide();
      this.crosshair.classList.add('is-on');
      this.setFocus(this.ctx.interaction.focused);
      this.showHint('Hold the left mouse button to look around');
      return;
    }

    input.suspended = true;
    this.setPrompt(false);
    this.crosshair.classList.remove('is-on');
    this.start.show('retry', this.relockWait());
  }

  /* --------------------------------------------------------------- hint */

  private showHint(text: string, ms = 6000): void {
    this.hint.textContent = text;
    this.hint.classList.add('is-on');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hint.classList.remove('is-on'), ms);
  }

  /* ------------------------------------------------------------- prompt */

  private setFocus(item: Interactable | null): void {
    if (!item || this.dialogue.isOpen) {
      this.setPrompt(false);
      return;
    }
    const key = item.key ?? 'E';
    const label = KEY_LABEL[key] ?? key;
    this.promptKey.textContent = label;
    this.promptKey.className = label.length > 1 ? 'pt-key pt-key--wide' : 'pt-key';
    this.promptLabel.textContent = item.label;
    this.setPrompt(true);
  }

  private setPrompt(on: boolean): void {
    const show = on && this.booted && !this.start.visible;
    this.prompt.classList.toggle('is-on', show);
    this.crosshair.classList.toggle('is-focus', show);
  }

  /* -------------------------------------------------------- start/pause */

  private beginPlay(): void {
    this.start.hide();
    this.booted = true;
    this.ctx.engine.input.suspended = false;
    this.crosshair.classList.add('is-on');
    // The click bubbles on to the app container, which takes pointer lock and
    // unlocks audio. Some embedded browsers do not grant pointer lock; that is
    // not a pause, so only a later locked -> unlocked transition may reopen
    // the pause card.
    this.lockReturn = 0;
    this.setFocus(this.ctx.interaction.focused);
  }

  private onLockChange = (): void => {
    const locked = document.pointerLockElement === this.ctx.engine.renderer.domElement;
    if (locked) {
      this.wasPointerLocked = true;
      this.lockReturn = 0;
      this.ctx.engine.input.suspended = false;
      this.start.hide();
      this.crosshair.classList.add('is-on');
      this.setFocus(this.ctx.interaction.focused);
    } else if (this.wasPointerLocked && this.booted && !this.auto) {
      this.wasPointerLocked = false;
      // Small grace period so a relock inside the same gesture cannot flash
      // the pause card.
      this.lockReturn = 0.35;
    }
  };

  dispose(): void {
    window.clearTimeout(this.hintTimer);
    this.ctx.engine.input.onLockError = null;
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.dialogue.dispose();
    this.root.remove();
  }
}
