import * as THREE from 'three';

/**
 * SkyShader — the analytic sky dome used by `Atmosphere`.
 *
 * The gradient is not a straight lerp: real sky radiance rises steeply in the
 * last few degrees above the horizon, so the dome mixes a broad zenith->horizon
 * ramp with a tight, brighter haze band and a Mie forward-scatter lobe around
 * the sun. That combination is what stops a stylised sky from reading as a
 * two-stop Photoshop gradient.
 *
 * Everything is authored in the renderer's linear working space and left in
 * HDR — the sun disc deliberately exceeds 1.0 so PostFX's bloom threshold
 * (1.02) catches it and nothing else.
 */

export interface SkyUniforms {
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uHaze: { value: THREE.Color };
  uNadir: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uIntensity: { value: number };
  uSunDiscSize: { value: number };
  uSunDiscGain: { value: number };
  uHaloGain: { value: number };
  uDither: { value: number };
  [k: string]: THREE.IUniform;
}

export interface SkyPalette {
  zenith: number;
  horizon: number;
  haze: number;
  nadir: number;
  sun: number;
}

export const SKY_PALETTE: SkyPalette = {
  zenith: 0x3f7fd6,
  horizon: 0xbfe0f2,
  // A hair warmer and brighter than the horizon swatch — this is the thin
  // band of near-white air that sits right on the sea line.
  haze: 0xd7ebfb,
  // Below the horizon line: the water/land haze the dome falls away to, so a
  // gap between terrain and dome never shows as a hard seam.
  nadir: 0x9fc3dc,
  sun: 0xfff3d6,
};

export function createSkyUniforms(palette: SkyPalette = SKY_PALETTE): SkyUniforms {
  return {
    uZenith: { value: new THREE.Color(palette.zenith) },
    uHorizon: { value: new THREE.Color(palette.horizon) },
    uHaze: { value: new THREE.Color(palette.haze) },
    uNadir: { value: new THREE.Color(palette.nadir) },
    uSunDir: { value: new THREE.Vector3(0.53, 0.62, 0.59).normalize() },
    uSunColor: { value: new THREE.Color(palette.sun) },
    uIntensity: { value: 1.0 },
    uSunDiscSize: { value: 0.0165 },
    uSunDiscGain: { value: 7.0 },
    uHaloGain: { value: 1.0 },
    uDither: { value: 1.0 },
  };
}

const VERT = /* glsl */ `
  varying vec3 vWorldDir;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // World-space view ray. Computing it here rather than from the object
    // position keeps the shader correct no matter where the dome is parented.
    vWorldDir = wp.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;

  uniform vec3  uZenith;
  uniform vec3  uHorizon;
  uniform vec3  uHaze;
  uniform vec3  uNadir;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform float uIntensity;
  uniform float uSunDiscSize;
  uniform float uSunDiscGain;
  uniform float uHaloGain;
  uniform float uDither;

  varying vec3 vWorldDir;

  // Interleaved gradient noise — the cheapest dither that stays visually
  // uncorrelated frame to frame and does not produce a visible grid.
  float ign(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  void main() {
    vec3 d = normalize(vWorldDir);
    float h = d.y;

    // ---- Vertical gradient ------------------------------------------------
    // Two stacked falloffs: a broad zenith->horizon ramp, plus a tight band of
    // bright haze that only occupies the bottom few degrees.
    float up = clamp(h, 0.0, 1.0);
    float broad = pow(1.0 - up, 3.9);
    float band = pow(1.0 - up, 19.0);

    vec3 col = mix(uZenith, uHorizon, broad);
    col = mix(col, uHaze, band * 0.28);

    // Below the horizon the dome falls to a muted sea haze so the join with
    // distant water reads as atmosphere rather than a cut.
    float below = smoothstep(0.0, -0.10, h);
    col = mix(col, uNadir, below * 0.85);

    // ---- Sun-side warming --------------------------------------------------
    // Air near the sun's azimuth scatters warm; this is subtle but it is what
    // makes the sky feel directional instead of radially symmetric.
    vec2 dAz = normalize(d.xz + 1e-5);
    vec2 sAz = normalize(uSunDir.xz + 1e-5);
    float az = max(dot(dAz, sAz), 0.0);
    col += uSunColor * (0.085 * pow(az, 2.6) * pow(1.0 - up, 1.6));

    float cosT = dot(d, uSunDir);
    float mu = max(cosT, 0.0);

    // ---- Mie halo ----------------------------------------------------------
    // Wide, faint aureole + a tight bright core. Both fade below the horizon.
    float horizonMask = smoothstep(-0.06, 0.02, h);
    float halo = pow(mu, 6.0) * 0.09 + pow(mu, 44.0) * 0.34 + pow(mu, 340.0) * 1.15;
    col += uSunColor * halo * uHaloGain * horizonMask;

    // ---- Sun disc ----------------------------------------------------------
    // Limb softening: the disc is not a hard circle. Radiance stays flat across
    // the middle and rolls off over the outer ~20% of the radius, which is what
    // a real solar limb plus a little atmospheric smear looks like.
    float ang = acos(clamp(cosT, -1.0, 1.0));
    float r = ang / uSunDiscSize;
    float limb = 1.0 - smoothstep(0.72, 1.0, r);
    float rim = sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0)));
    col += uSunColor * limb * (uSunDiscGain * (0.35 + 0.65 * rim)) * horizonMask;

    col *= uIntensity;

    // ---- Dither ------------------------------------------------------------
    // Applied in HDR, scaled to the local value so the ramp never quantises
    // into bands after the grade pass' 8-bit write.
    vec2 px = gl_FragCoord.xy;
    float n = ign(px) - 0.5;
    // Amplitude raised: the previous level was under one 8-bit step once ACES
    // had compressed the sky's value range, so the zenith ramp still quantised
    // into visible contour bands after the grade pass wrote to 8 bits.
    col += n * (0.010 + 0.012 * max(col.r, max(col.g, col.b))) * uDither;

    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  }
`;

export function createSkyMaterial(uniforms: SkyUniforms): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });
  mat.name = 'SkyDome';
  return mat;
}
