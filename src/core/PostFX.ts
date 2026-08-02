import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import type { Engine, QualityTier } from './Engine';

export interface RenderStats {
  calls: number;
  triangles: number;
}

/**
 * A zero-cost pass that exists only to bracket the scene render so we can read
 * `renderer.info` for it alone.
 *
 * `renderer.info` auto-resets at the start of every `render()` call, and a
 * composer frame ends with a fullscreen quad — so anything sampling the info
 * object after the frame sees "1 draw call, 0 triangles" no matter how heavy
 * the world is. Bracketing gives the number everyone actually means by
 * "draw calls": the shadow map plus the main scene pass.
 */
class StatsProbe extends Pass {
  constructor(private readonly fn: () => void) {
    super();
    this.needsSwap = false;
  }
  render(): void {
    this.fn();
  }
}

/**
 * Renders the scene once into a view-space normal + depth G-buffer.
 *
 * This exists so the frame contains exactly *one* geometry prepass instead of
 * two. GTAO needs normals+depth; the grade pass's DOF needs depth. Both used to
 * pay for their own full scene traversal, and the DOF one was the expensive
 * kind — it ran with the real materials, which also dragged three's
 * transmission pass along behind it and rendered the whole town a *fourth*
 * time. Rendering once with an override material and handing the result to both
 * consumers costs one cheap traversal and is bit-identical to what GTAOPass
 * produced for itself (same MeshNormalMaterial, same target format, same clear).
 *
 * The override material is also what makes this cheap: `renderTransmissionPass`
 * returns early when `scene.overrideMaterial` is set, so this pass cannot
 * trigger the duplicate opaque render that a normal `render()` does.
 */
class GBufferPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  readonly depthTexture: THREE.DepthTexture;

  /** Matches GTAOPass's own G-buffer material exactly. */
  private readonly overrideMaterial = new THREE.MeshNormalMaterial();
  private readonly clearColor = new THREE.Color(0x7777ff);
  private readonly prevClear = new THREE.Color();
  private readonly hidden: THREE.Object3D[] = [];

  /** Set false when neither AO nor DOF needs the buffer this frame. */
  wanted = true;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    width: number,
    height: number,
  ) {
    super();
    this.needsSwap = false;

    // Format copied from GTAOPass.setGBuffer()'s internal branch so that
    // handing this to the pass changes nothing about how it samples.
    this.depthTexture = new THREE.DepthTexture(width, height);
    this.depthTexture.format = THREE.DepthStencilFormat;
    this.depthTexture.type = THREE.UnsignedInt248Type;

    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthTexture: this.depthTexture,
    });
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.wanted) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(this.prevClear);
    const prevAlpha = renderer.getClearAlpha();

    // Points and lines have no meaningful surface normal; GTAOPass hides them
    // for its own prepass and the AO result depends on that.
    this.scene.traverse((o) => {
      const any = o as THREE.Object3D & { isPoints?: boolean; isLine?: boolean };
      if ((any.isPoints || any.isLine) && o.visible) {
        o.visible = false;
        this.hidden.push(o);
      }
    });

    renderer.setRenderTarget(this.target);
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 1.0);
    renderer.clear();

    this.scene.overrideMaterial = this.overrideMaterial;
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = null;

    for (const o of this.hidden) o.visible = true;
    this.hidden.length = 0;

    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(this.prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.target.dispose();
    this.overrideMaterial.dispose();
  }
}

/**
 * PostFX — the look.
 *
 * The chain runs entirely in HDR (half-float targets) so bloom sees real
 * over-range values, and only the final GradePass converts to display sRGB.
 * That ordering is what gives the sunlight its soft bloom falloff instead of
 * the muddy grey halo you get bloom-after-tonemap.
 *
 *   Render (HDR, MSAA)
 *     -> GTAO          contact shadows in creases and under foliage
 *     -> Bloom         HDR highlight bleed
 *     -> Grade         DOF-lite + ACES + film curve + vignette + grain + CA
 *     -> SMAA          edge antialias on the final LDR image
 */

export interface GradeSettings {
  exposure: number;
  contrast: number;
  saturation: number;
  /** Warm/cool push on highlights and shadows respectively. */
  liftShadow: THREE.Color;
  gainHighlight: THREE.Color;
  vignette: number;
  grain: number;
  chromatic: number;
  /** Distance in metres where the far blur reaches full strength. */
  dofFar: number;
  dofStrength: number;
}

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uExposure: { value: 1.0 },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.12 },
    uLift: { value: new THREE.Color(0.02, 0.035, 0.07) },
    uGain: { value: new THREE.Color(1.03, 1.005, 0.96) },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.018 },
    uChromatic: { value: 0.0016 },
    uTime: { value: 0 },
    uDofFar: { value: 55.0 },
    uDofStrength: { value: 1.0 },
    uCameraNear: { value: 0.06 },
    uCameraFar: { value: 600.0 },
    uEnableDof: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2  uResolution;
    uniform float uExposure;
    uniform float uContrast;
    uniform float uSaturation;
    uniform vec3  uLift;
    uniform vec3  uGain;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uChromatic;
    uniform float uTime;
    uniform float uDofFar;
    uniform float uDofStrength;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform float uEnableDof;

    varying vec2 vUv;

    // ---- ACES filmic (Stephen Hill's fit) -------------------------------
    const mat3 ACESInputMat = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777
    );
    const mat3 ACESOutputMat = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602
    );

    vec3 acesRRTAndODTFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }

    vec3 ACESFitted(vec3 color) {
      color = ACESInputMat * color;
      color = acesRRTAndODTFit(color);
      color = ACESOutputMat * color;
      return clamp(color, 0.0, 1.0);
    }

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    float linearDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      // Perspective depth -> view-space distance in metres.
      float ndc = z * 2.0 - 1.0;
      return (2.0 * uCameraNear * uCameraFar) /
             (uCameraFar + uCameraNear - ndc * (uCameraFar - uCameraNear));
    }

    // Golden-angle spiral: 12 taps read as a smooth circular bokeh without
    // the ring artefacts a fixed-ring kernel produces at this tap count.
    const int DOF_TAPS = 12;
    vec3 depthOfField(vec2 uv, float coc) {
      vec3 sum = vec3(0.0);
      float total = 0.0;
      float radius = coc * 0.012;
      for (int i = 0; i < DOF_TAPS; i++) {
        float fi = float(i);
        float ang = fi * 2.39996323;
        float r = sqrt(fi / float(DOF_TAPS)) * radius;
        vec2 off = vec2(cos(ang), sin(ang)) * r;
        off.x *= uResolution.y / uResolution.x;
        vec3 s = texture2D(tDiffuse, uv + off).rgb;
        // Weight by luminance so bright background points bloom into discs.
        float w = 1.0 + luma(s) * 0.6;
        sum += s * w;
        total += w;
      }
      return sum / max(total, 0.0001);
    }

    // Hash-based blue-ish noise for grain and dither.
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---- Depth of field ---------------------------------------------
      vec3 color;
      float coc = 0.0;
      if (uEnableDof > 0.5) {
        float d = linearDepth(uv);
        // Only the far field defocuses. Near-field blur on a first-person
        // camera reads as an eye problem, not a lens.
        coc = smoothstep(uDofFar * 0.45, uDofFar, d) * uDofStrength;
        color = coc > 0.01 ? depthOfField(uv, coc) : texture2D(tDiffuse, uv).rgb;
      } else {
        color = texture2D(tDiffuse, uv).rgb;
      }

      // ---- Chromatic aberration ---------------------------------------
      // Scaled by r^2 so the centre of frame stays perfectly clean.
      if (uChromatic > 0.0) {
        float amt = uChromatic * r2 * 4.0;
        vec2 dir = normalize(centered + 1e-6);
        float rr = texture2D(tDiffuse, uv - dir * amt).r;
        float bb = texture2D(tDiffuse, uv + dir * amt).b;
        color.r = mix(color.r, rr, 0.85);
        color.b = mix(color.b, bb, 0.85);
      }

      // ---- Exposure and tone map --------------------------------------
      color *= uExposure;
      color = ACESFitted(color);

      // ---- Lift / gain split tone -------------------------------------
      // Cool shadows + warm highlights is the single strongest cue that a
      // stylised scene was lit by a real sun rather than a flat ambient.
      float l = luma(color);
      color += uLift * (1.0 - smoothstep(0.0, 0.55, l));
      color *= mix(vec3(1.0), uGain, smoothstep(0.25, 1.0, l));

      // ---- Contrast and saturation ------------------------------------
      color = (color - 0.5) * uContrast + 0.5;
      float g = luma(color);
      color = mix(vec3(g), color, uSaturation);

      // Gentle highlight rolloff keeps saturated greens from clipping to
      // neon after the saturation push.
      color = color / (1.0 + max(vec3(0.0), color - 1.0) * 0.6);

      // ---- Vignette ----------------------------------------------------
      float vig = 1.0 - uVignette * smoothstep(0.15, 0.78, r2);
      color *= vig;

      // ---- Grain -------------------------------------------------------
      float n = hash12(gl_FragCoord.xy + uTime * 137.0);
      color += (n - 0.5) * uGrain;

      color = clamp(color, 0.0, 1.0);

      // ---- Output transfer ---------------------------------------------
      // The whole composer chain is linear-light in half-float targets, and
      // neither ShaderPass nor SMAAPass emits a colorspace_fragment include, so
      // the renderer applies no output conversion for us. Without this encode the
      // linear buffer is handed to an sRGB display verbatim and the entire
      // frame reads two stops dark and blue-crushed. This is the single
      // conversion for the whole pipeline (ART_DIRECTION §8).
      color = mix(
        color * 12.92,
        1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
        step(vec3(0.0031308), color)
      );

      // 8-bit dither, applied after the transfer so it lands on the value
      // that actually gets quantised. Removes banding in the sky gradient.
      color += (hash12(gl_FragCoord.xy * 1.7) - 0.5) / 255.0;

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

export class PostFX {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly gtao: GTAOPass;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  readonly smaa: SMAAPass;

  private engine: Engine;
  private gbuffer: GBufferPass;
  private time = 0;

  /** Shadow map + main scene pass only. This is the art-budget number. */
  readonly sceneStats: RenderStats = { calls: 0, triangles: 0 };
  /** Everything the frame cost, post chain and prepasses included. */
  readonly frameStats: RenderStats = { calls: 0, triangles: 0 };

  settings: GradeSettings = {
    exposure: 1.0,
    contrast: 1.06,
    saturation: 1.14,
    liftShadow: new THREE.Color(0.018, 0.032, 0.066),
    gainHighlight: new THREE.Color(1.035, 1.005, 0.955),
    vignette: 0.32,
    grain: 0.016,
    // Cut from 0.0014. At the old strength the fringing was plainly visible as
    // magenta and cyan doubled edges on high-contrast boundaries — roof eaves
    // against sky, leaves against sky — which reads as a rendering fault rather
    // than as a lens. Aberration should be findable only if you look for it.
    chromatic: 0.0005,
    dofFar: 58,
    dofStrength: 1.0,
  };

  constructor(engine: Engine) {
    this.engine = engine;
    const { renderer, scene, camera, quality } = engine;
    const w = window.innerWidth;
    const h = window.innerHeight;

    // Bloom must see HDR, so the whole chain is half-float.
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: quality.msaaSamples,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    renderer.info.autoReset = false;
    this.composer.addPass(new StatsProbe(() => renderer.info.reset()));

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.composer.addPass(
      new StatsProbe(() => {
        this.sceneStats.calls = renderer.info.render.calls;
        this.sceneStats.triangles = renderer.info.render.triangles;
      }),
    );

    // One geometry prepass, two consumers: GTAO's AO and the grade pass's DOF.
    // Reusing the composer's own depth is not possible once MSAA resolve is in
    // play, so a dedicated buffer is unavoidable — but only one of them is.
    this.gbuffer = new GBufferPass(scene, camera, w, h);
    this.composer.addPass(this.gbuffer);

    this.gtao = new GTAOPass(scene, camera, w, h);
    // Hand GTAO the shared buffer. This flips its internal `_renderGBuffer`
    // flag off, so it stops rendering the scene for itself.
    this.gtao.setGBuffer(this.gbuffer.depthTexture, this.gbuffer.target.texture);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.9;
    this.gtao.updateGtaoMaterial({
      radius: 0.42,
      distanceExponent: 1.2,
      thickness: 0.65,
      scale: 1.15,
      samples: 16,
      distanceFallOff: 1.0,
      screenSpaceRadius: false,
    });
    this.composer.addPass(this.gtao);

    // Threshold well above 1.0 so only genuinely over-range pixels (sky, sun
    // glints, emissive signage) bloom — never mid-tone albedo.
    //
    // The first tuning (0.42 strength at a 1.02 threshold) was far too eager: a
    // warmly-lit interior sits above 1.0 across most of the frame, so the whole
    // image bled into an orange-cream mush and every character lost its identity
    // colour. It also amplified single-pixel specular aliasing on the wood
    // normal maps into visible firefly speckle. A higher threshold with a wider
    // soft knee keeps the glow for actual highlights and nothing else.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.24, 0.85, 1.35);
    // NaN guard on the bloom input. A single NaN/Inf fragment anywhere in the
    // HDR buffer — a degenerate particle, a mid-animation zero-scale mesh —
    // poisons the high-pass, then every downsampled mip, and the composite
    // wipes the ENTIRE frame to black (observed repeatedly during battle FX
    // bursts on the ANGLE/Metal path). Zeroing non-finite texels here confines
    // the damage to the one source pixel instead of the whole image.
    {
      const hp = this.bloom.materialHighPassFilter as THREE.ShaderMaterial;
      hp.fragmentShader = hp.fragmentShader.replace(
        'vec4 texel = texture2D( tDiffuse, vUv );',
        /* glsl */ `vec4 texel = texture2D( tDiffuse, vUv );
        // NaN != NaN, so this selects exactly the poisoned channels.
        texel = mix( texel, vec4( 0.0 ), vec4( notEqual( texel, texel ) ) );
        texel = clamp( texel, vec4( 0.0 ), vec4( 5.0e3 ) );`,
      );
      hp.needsUpdate = true;
    }
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.tDepth.value = this.gbuffer.depthTexture;
    this.grade.uniforms.uCameraNear.value = camera.near;
    this.grade.uniforms.uCameraFar.value = camera.far;
    this.composer.addPass(this.grade);

    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.applyQuality(quality);
    this.setSize(w, h);
  }

  applyQuality(q: QualityTier): void {
    this.gtao.enabled = q.ssao;
    this.bloom.enabled = q.bloom;
    this.grade.uniforms.uEnableDof.value = q.dof ? 1 : 0;
    this.smaa.enabled = q.msaaSamples < 4;
    // Nobody is reading the G-buffer if both consumers are off, so skip the
    // prepass entirely on the tiers that disable them.
    this.gbuffer.wanted = q.ssao || q.dof;
  }

  /** Live-tweak hook used by the debug grade panel. */
  syncSettings(): void {
    const u = this.grade.uniforms;
    const s = this.settings;
    u.uExposure.value = s.exposure;
    u.uContrast.value = s.contrast;
    u.uSaturation.value = s.saturation;
    u.uLift.value.copy(s.liftShadow);
    u.uGain.value.copy(s.gainHighlight);
    u.uVignette.value = s.vignette;
    u.uGrain.value = s.grain;
    u.uChromatic.value = s.chromatic;
    u.uDofFar.value = s.dofFar;
    u.uDofStrength.value = s.dofStrength;
  }

  setSize(w: number, h: number): void {
    const pr = this.engine.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const bw = Math.floor(w * pr);
    const bh = Math.floor(h * pr);
    this.gbuffer.setSize(bw, bh);
    this.gtao.setSize(bw, bh);
    // GTAOPass.setSize() resizes the internal G-buffer target it no longer
    // renders to. Shrink it back so it does not sit on a full-res colour +
    // depth attachment for nothing. (Not in the published typings.)
    (this.gtao as unknown as { normalRenderTarget?: THREE.WebGLRenderTarget })
      .normalRenderTarget?.setSize(1, 1);
    this.bloom.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(w * pr, h * pr);
  }

  render(dt: number): void {
    this.time += dt;
    this.grade.uniforms.uTime.value = this.time;
    this.syncSettings();

    // The DOF depth prepass used to live here, as a second full-material render
    // of the whole scene. It is now the GBufferPass inside the composer chain,
    // shared with GTAO — see the class comment.
    this.composer.render(dt);

    // Publish both numbers, then leave `info.render` holding the scene-only
    // figures: that is what the capture harness samples and what the draw-call
    // budget in ART_DIRECTION §7 refers to.
    const info = this.engine.renderer.info;
    this.frameStats.calls = info.render.calls;
    this.frameStats.triangles = info.render.triangles;
    info.render.calls = this.sceneStats.calls;
    info.render.triangles = this.sceneStats.triangles;
  }

  dispose(): void {
    this.composer.dispose();
    this.gbuffer.dispose();
  }
}
