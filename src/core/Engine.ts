import * as THREE from 'three';
import { PostFX } from './PostFX';
import { Input } from './Input';

/**
 * Engine — owns the renderer, the frame loop, and the render-quality budget.
 *
 * Systems register themselves via `add()` and receive `update(dt, elapsed)`
 * every frame in insertion order. Everything else in the game is a system.
 */

export interface System {
  readonly name: string;
  update?(dt: number, elapsed: number): void;
  dispose?(): void;
}

export interface QualityTier {
  name: 'low' | 'medium' | 'high' | 'ultra';
  pixelRatioCap: number;
  shadowMapSize: number;
  ssao: boolean;
  bloom: boolean;
  dof: boolean;
  msaaSamples: number;
}

export const QUALITY: Record<QualityTier['name'], QualityTier> = {
  low: { name: 'low', pixelRatioCap: 1, shadowMapSize: 1024, ssao: false, bloom: true, dof: false, msaaSamples: 0 },
  medium: { name: 'medium', pixelRatioCap: 1.25, shadowMapSize: 2048, ssao: true, bloom: true, dof: false, msaaSamples: 2 },
  high: { name: 'high', pixelRatioCap: 1.5, shadowMapSize: 4096, ssao: true, bloom: true, dof: true, msaaSamples: 4 },
  ultra: { name: 'ultra', pixelRatioCap: 2, shadowMapSize: 4096, ssao: true, bloom: true, dof: true, msaaSamples: 4 },
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly clock = new THREE.Clock();
  readonly input: Input;
  readonly systems: System[] = [];

  postfx!: PostFX;
  quality: QualityTier = QUALITY.high;

  /** Set true once the world is built; gates the frame loop. */
  running = false;

  private container: HTMLElement;
  private accum = 0;
  private frames = 0;
  private fpsWindow = 0;
  private measuredFps = 60;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // handled by the composer's multisampled target + SMAA
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Tone mapping deliberately stays OFF here. The composer runs in HDR so
    // bloom sees true over-range values; PostFX's grade pass owns the single
    // ACES conversion at the end of the chain. Tone mapping in both places
    // would crush the highlights twice.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;

    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.06, 600);
    this.camera.position.set(0, 1.65, 0);
    this.scene.add(this.camera);

    this.input = new Input(this.renderer.domElement);

    window.addEventListener('resize', this.onResize);
  }

  initPost(): void {
    this.postfx = new PostFX(this);
  }

  add<T extends System>(system: T): T {
    this.systems.push(system);
    return system;
  }

  get<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  setQuality(tier: QualityTier['name']): void {
    this.quality = QUALITY[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatioCap));
    this.postfx?.applyQuality(this.quality);
    this.onResize();
  }

  /** Rolling FPS used by the adaptive-resolution governor. */
  get fps(): number {
    return this.measuredFps;
  }

  start(): void {
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this.frame);
  }

  private frame = (): void => {
    if (!this.running) return;
    // Clamp dt so a background tab or a GC pause cannot teleport the player
    // through a collider on the frame it resumes.
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 1 / 20);
    const elapsed = this.clock.elapsedTime;

    this.fpsWindow += raw;
    this.frames++;
    if (this.fpsWindow >= 0.5) {
      this.measuredFps = this.frames / this.fpsWindow;
      this.frames = 0;
      this.fpsWindow = 0;
      this.governResolution();
    }

    for (const s of this.systems) s.update?.(dt, elapsed);

    this.input.endFrame();
    this.postfx.render(dt);
  };

  /**
   * Adaptive resolution. Keeps the frame time inside budget on weaker GPUs by
   * trimming the pixel ratio before touching any visual feature, so the art
   * direction survives even when the hardware does not.
   */
  private governResolution(): void {
    const cap = this.quality.pixelRatioCap;
    const current = this.renderer.getPixelRatio();
    const target = Math.min(window.devicePixelRatio, cap);
    if (this.measuredFps < 45 && current > 0.75) {
      this.renderer.setPixelRatio(Math.max(0.75, current - 0.15));
      this.postfx?.setSize(window.innerWidth, window.innerHeight);
    } else if (this.measuredFps > 58 && current < target) {
      this.renderer.setPixelRatio(Math.min(target, current + 0.1));
      this.postfx?.setSize(window.innerWidth, window.innerHeight);
    }
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postfx?.setSize(w, h);
  };

  dispose(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    for (const s of this.systems) s.dispose?.();
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}
