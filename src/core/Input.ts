/**
 * Input — pointer-lock mouse look plus keyboard state.
 *
 * Exposes both level ("is W held") and edge ("was E pressed this frame")
 * queries; `endFrame()` clears the edge sets and must run once per frame after
 * all systems have polled.
 */

/** How far a lock request got. `denied` covers every browser refusal. */
export type LockFailure = 'unsupported' | 'denied';

/** Ceiling on a single frame's mouse delta, in raw pixels. */
const MAX_DELTA = 300;

/**
 * Longest we wait for a browser that answers a lock request with neither a
 * promise nor an event. Without this the request would stay "pending" forever
 * and every later click would be ignored.
 */
const LOCK_ANSWER_TIMEOUT = 1000;

/**
 * Chrome refuses a fresh lock for roughly 1.25s after the user presses Escape
 * to release the cursor. Requests made inside that window are suppressed rather
 * than sent: a refusal the browser was always going to give says nothing about
 * whether pointer lock works here, and counting it would wrongly push the game
 * into its fallback look mode when the player simply clicked too soon.
 */
const RELOCK_COOLDOWN_MS = 1400;

export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();

  /** Accumulated mouse delta for the current frame, in radians-ready units. */
  mouseDX = 0;
  mouseDY = 0;
  sensitivity = 0.0022;
  invertY = false;

  locked = false;
  /** Suppresses look/move input while a modal (dialogue, menu) owns the screen. */
  suspended = false;

  /**
   * Consecutive refused lock requests, reset the moment a lock is granted. Two
   * in a row means this browser context will not grant pointer lock at all
   * (an iframe without `allow="pointer-lock"` is the usual reason).
   */
  lockFailures = 0;

  /**
   * Fallback look mode for contexts that refuse pointer lock: hold the left
   * button and drag. Off unless something switches it on after a refusal, so
   * normal play is never affected.
   */
  dragLook = false;

  onLockChange: ((locked: boolean) => void) | null = null;
  onLockError: ((reason: LockFailure) => void) | null = null;

  private el: HTMLElement;

  /** True between asking for a lock and hearing back; blocks pile-ups. */
  private lockPending = false;
  /** Identifies the in-flight request so a stale answer cannot settle it. */
  private lockRequestId = 0;
  private lockTimer = 0;

  /** Drops the one bogus jump some browsers report as look begins. */
  private swallowNextDelta = false;
  private dragging = false;
  /** Timestamp of the last unlock, for the relock cooldown above. */
  private unlockedAt = 0;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
    document.addEventListener('mousemove', this.onMouseMove);
    this.el.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  /** Whether the engine exposes pointer lock at all. */
  get lockSupported(): boolean {
    return typeof this.el.requestPointerLock === 'function';
  }

  /**
   * Milliseconds until a lock request can succeed again, 0 when it can go out
   * now. UI that invites the player to click back in should stay inert this
   * long, or the click it accepts will be wasted.
   */
  get relockWaitMs(): number {
    if (!this.unlockedAt) return 0;
    return Math.max(0, RELOCK_COOLDOWN_MS - (performance.now() - this.unlockedAt));
  }

  /**
   * Takes pointer lock on the canvas.
   *
   * Must be called *synchronously* from inside a user gesture. Chrome and
   * Safari both refuse a request that has been deferred through a promise, a
   * timeout or a rAF callback, so nothing here awaits anything before asking —
   * and callers must not either.
   */
  requestLock(): void {
    if (this.locked || this.lockPending) return;
    if (this.relockWaitMs > 0) return;
    if (!this.lockSupported) {
      this.lockFailures++;
      this.onLockError?.('unsupported');
      return;
    }

    this.lockPending = true;
    const id = ++this.lockRequestId;

    // Chrome settles a promise; Safari and Firefox return undefined and speak
    // only through pointerlockchange / pointerlockerror. Both paths funnel into
    // settleLock / failLock, which ignore everything but the live request.
    let answer: unknown;
    try {
      answer = this.el.requestPointerLock();
    } catch {
      this.failLock(id, 'denied');
      return;
    }

    if (isThenable(answer)) {
      answer.then(
        () => this.settleLock(id),
        () => this.failLock(id, 'denied'),
      );
    } else {
      this.lockTimer = window.setTimeout(() => this.failLock(id, 'denied'), LOCK_ANSWER_TIMEOUT);
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Marks the live request answered without disturbing the failure count. */
  private settleLock(id: number): void {
    if (id !== this.lockRequestId) return;
    this.clearLockTimer();
    this.lockPending = false;
  }

  private failLock(id: number, reason: LockFailure): void {
    if (id !== this.lockRequestId || !this.lockPending) return;
    this.clearLockTimer();
    this.lockPending = false;
    this.lockFailures++;
    this.onLockError?.(reason);
  }

  private clearLockTimer(): void {
    if (this.lockTimer) {
      window.clearTimeout(this.lockTimer);
      this.lockTimer = 0;
    }
  }

  isDown(code: string): boolean {
    return !this.suspended && this.held.has(code);
  }

  /** True only on the frame the key transitioned to down. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  wasReleased(code: string): boolean {
    return this.released.has(code);
  }

  /** Any of the listed codes held. */
  anyDown(...codes: string[]): boolean {
    return codes.some((c) => this.isDown(c));
  }

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    // Never swallow devtools / reload shortcuts.
    if (e.metaKey || e.ctrlKey) return;
    this.held.add(e.code);
    this.pressed.add(e.code);
    if (MOVEMENT_CODES.has(e.code) || e.code === 'Space') e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    this.released.add(e.code);
  };

  private onBlur = (): void => {
    this.held.clear();
    this.dragging = false;
  };

  private onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.el;
    if (this.locked) {
      // A granted lock answers the request and clears the refusal history, so a
      // one-off denial never leaves the game stuck in the fallback path.
      this.settleLock(this.lockRequestId);
      this.lockFailures = 0;
      this.dragLook = false;
      this.swallowNextDelta = true;
      this.unlockedAt = 0;
    } else {
      this.held.clear();
      this.dragging = false;
      this.unlockedAt = performance.now();
    }
    this.onLockChange?.(this.locked);
  };

  /**
   * The only signal a refusal gives on Safari and Firefox, and the signal
   * Chrome sends alongside its rejected promise — `failLock` keys on the live
   * request id, so hearing it twice reports the failure once.
   */
  private onPointerLockError = (): void => {
    this.failLock(this.lockRequestId, 'denied');
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.dragging = true;
    if (this.dragLook && !this.locked) {
      // Suppress the text-selection drag that would otherwise fight the look.
      e.preventDefault();
      this.swallowNextDelta = true;
    }
  };

  private onMouseUp = (): void => {
    this.dragging = false;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.suspended) return;
    const looking = this.locked || (this.dragLook && this.dragging);
    if (!looking) return;
    if (this.swallowNextDelta) {
      // Some browsers report the jump from the old cursor position as the first
      // delta after look begins. Dropping exactly one event kills that snap.
      this.swallowNextDelta = false;
      return;
    }
    // Clamp rather than discard. A fast flick on a high-DPI mouse legitimately
    // reports a few hundred pixels, and throwing those frames away reads as
    // stutter; only genuinely impossible values get trimmed.
    const dx = clampDelta(e.movementX);
    const dy = clampDelta(e.movementY);
    this.mouseDX += dx * this.sensitivity;
    this.mouseDY += dy * this.sensitivity * (this.invertY ? -1 : 1);
  };

  dispose(): void {
    this.clearLockTimer();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.el.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
  }
}

function clampDelta(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, v));
}

function isThenable(v: unknown): v is Promise<unknown> {
  return typeof (v as Promise<unknown> | undefined)?.then === 'function';
}

const MOVEMENT_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
