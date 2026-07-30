import * as THREE from 'three';

/**
 * Interaction registry.
 *
 * A prompt appears when the player is inside an interactable's radius *and*
 * facing it within a cone. Distance alone is not enough — in a town this dense
 * the player is frequently within two metres of three different signs.
 */

export interface Interactable {
  id: string;
  /** World position of the interaction anchor. */
  position: THREE.Vector3;
  /** Metres. */
  radius: number;
  /** Prompt text, e.g. "Read sign". */
  label: string;
  /** Verb shown in the key hint; defaults to "E". */
  key?: string;
  /** Called when the player confirms. */
  onInteract: () => void;
  /** Optional gate — return false to hide the prompt entirely. */
  enabled?: () => boolean;
  /** Optional highlight target that pulses while focused. */
  highlight?: THREE.Object3D;
  /** Cosine of the half-angle the player must face within. Default ~75deg. */
  facingDot?: number;
}

const _toTarget = new THREE.Vector3();
const _forward = new THREE.Vector3();

export class InteractionSystem {
  readonly name = 'interaction';
  readonly items = new Map<string, Interactable>();

  /** The currently focused interactable, or null. */
  focused: Interactable | null = null;

  /** Set by the UI layer; receives focus changes. */
  onFocusChange: ((item: Interactable | null) => void) | null = null;

  private camera: THREE.PerspectiveCamera;
  private pulse = 0;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  register(item: Interactable): Interactable {
    this.items.set(item.id, item);
    return item;
  }

  unregister(id: string): void {
    this.items.delete(id);
    if (this.focused?.id === id) this.setFocus(null);
  }

  /** Fires the focused interaction, if any. Returns true if something ran. */
  activate(): boolean {
    const f = this.focused;
    if (!f) return false;
    // State can change between the focus update and the input pass (for
    // example a lab fade becoming busy or a starter being chosen). Never fire
    // an interaction that has gone stale during that frame.
    if (f.enabled && !f.enabled()) {
      this.setFocus(null);
      return false;
    }
    f.onInteract();
    return true;
  }

  update(dt: number): void {
    this.camera.getWorldDirection(_forward);
    _forward.y = 0;
    _forward.normalize();

    const camPos = this.camera.getWorldPosition(new THREE.Vector3());

    let best: Interactable | null = null;
    let bestScore = -Infinity;

    for (const item of this.items.values()) {
      if (item.enabled && !item.enabled()) continue;

      _toTarget.copy(item.position).sub(camPos);
      const dist = _toTarget.length();
      if (dist > item.radius) continue;

      _toTarget.y = 0;
      const flatLen = _toTarget.length();
      // Directly overhead/underfoot: treat as always facing.
      const dot = flatLen < 0.05 ? 1 : _toTarget.divideScalar(flatLen).dot(_forward);
      const minDot = item.facingDot ?? 0.26;
      if (dot < minDot) continue;

      // Prefer things that are both close and centred in view.
      const score = dot * 2 - dist / item.radius;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    if (best !== this.focused) this.setFocus(best);

    // Gentle emissive pulse on the focused object so the player can see what
    // the prompt refers to without a screen-space outline pass.
    this.pulse += dt * 3.4;
    if (this.focused?.highlight) {
      const s = 1 + Math.sin(this.pulse) * 0.018;
      this.focused.highlight.scale.setScalar(s);
    }
  }

  private setFocus(item: Interactable | null): void {
    if (this.focused?.highlight) this.focused.highlight.scale.setScalar(1);
    this.focused = item;
    this.pulse = 0;
    this.onFocusChange?.(item);
  }
}
