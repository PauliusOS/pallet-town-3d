import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import { Simplex, clamp } from '../core/Noise';
import { waterSwellNormal, waterChopNormal, waterDetailTexture } from '../fx/WaterMaterials';

/**
 * Water — the bay closing Pallet Town to the north.
 *
 * Three ideas carry the whole system:
 *
 *  1. **The sea knows the shape of the land.** Before anything is drawn, the
 *     terrain's own `groundHeight` is sampled into a *seabed map*: signed depth
 *     at every point of the bay, plus the signed **horizontal** distance to the
 *     waterline (height divided by local slope) and the slope itself. That map
 *     is what makes the depth ramp exact and — far more importantly — lets the
 *     foam be authored in metres of beach rather than in metres of altitude, so
 *     the wash band stays a constant width whether the sand is steep or flat.
 *     No depth prepass, no scene depth texture, no cost after load.
 *
 *  2. **Stylised water is colour and foam, not a mirror.** The surface is a
 *     `MeshPhysicalMaterial` patched through `onBeforeCompile`, so it keeps the
 *     PMREM environment, the fog and the HDR pipeline, but its diffuse term is
 *     a hand-authored turquoise→deep-blue ramp and it is genuinely translucent
 *     in the shallows, letting the sand read through. Reflection arrives only
 *     as Fresnel-weighted ambient specular. A chrome sheet would be physically
 *     closer and artistically wrong.
 *
 *  3. **The shoreline is animated, everything else scrolls.** Two ripple normal
 *     maps drift at different scales and directions; the foam band advances and
 *     retreats on two out-of-phase sine terms plus a per-place noise offset, so
 *     the wash breaks along the beach rather than pulsing as one rigid ring.
 *
 * The mesh is a radial disc rather than a plane: its rings are distributed
 * exponentially so the near shore gets metre-scale tessellation for the wave
 * displacement while the horizon costs almost nothing, and its far edge sits
 * inside the sky dome at a constant radius in every direction, which is what
 * makes the horizon line read as a horizon instead of the corner of a square.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SEA = {
  /** Comfortably inside the sky dome (460) and the camera far plane (600). */
  radius: 420,
  rings: 76,
  spokes: 108,
};

/** Seabed map window. 25 cm per texel over the whole bay and its headlands. */
const BED = {
  minX: -46,
  minZ: -46,
  width: 92,
  depth: 60,
  resX: 368,
  resZ: 240,
};

/** Beyond the terrain mesh there is no land — force open sea. */
const LAND = { hx: 31.6, minZ: -35.6, maxZ: 35.6 };

/** Encoding range for the depth channel, metres. */
const DEPTH_RANGE = 4.0;
/** Encoding range for the horizontal shore-distance channel, metres. */
const SHORE_RANGE = 8.0;

const COLOR_SHALLOW = 0x5fc8d2;
const COLOR_DEEP = 0x1f7ba8;
const COLOR_FOAM = 0xeef6f4;

/* ------------------------------------------------------------------ */
/* Seabed map                                                          */
/* ------------------------------------------------------------------ */

/**
 * Signed square-root encoding. Byte textures spend their precision uniformly,
 * which is exactly backwards for a field whose interesting values all sit
 * within a few centimetres of zero. Square-rooting the magnitude gives sub-
 * millimetre resolution at the waterline and a still-useful 5 cm out at the
 * range limit.
 */
function enc(x: number, range: number): number {
  const s = Math.sign(x) * Math.sqrt(Math.min(Math.abs(x), range) / range);
  return s * 0.5 + 0.5;
}

function bakeSeabed(ground: (x: number, z: number) => number): THREE.DataTexture {
  const { minX, minZ, width, depth, resX, resZ } = BED;
  const dx = width / resX;
  const dz = depth / resZ;

  // Pass 1: heights. One `groundHeight` call per texel — the gradient comes
  // from the grid itself rather than four extra samples, which is a 5x saving
  // on the most expensive function in the build.
  const h = new Float32Array(resX * resZ);
  for (let j = 0; j < resZ; j++) {
    const z = minZ + (j + 0.5) * dz;
    const cz = Math.min(LAND.maxZ, Math.max(LAND.minZ, z));
    for (let i = 0; i < resX; i++) {
      const x = minX + (i + 0.5) * dx;
      const cx = Math.min(LAND.hx, Math.max(-LAND.hx, x));
      const outside = Math.hypot(x - cx, z - cz);
      // Past the edge of the terrain mesh the seabed is extrapolated rather
      // than stamped flat: the nearest real depth, forced under water, then
      // falling away. A hard cut here would print a dead-straight colour
      // boundary right across the bay at 40 m — the single most obvious tell
      // that the sea is a texture on a plane.
      h[j * resX + i] =
        outside < 1e-6
          ? ground(x, z)
          : Math.max(-DEPTH_RANGE, Math.min(ground(cx, cz), -0.35) - outside * 0.3);
    }
  }

  // Pass 2: gradient -> horizontal distance to the waterline, and encode.
  const noise = new Simplex(0x0cea9f);
  const data = new Uint8Array(resX * resZ * 4);
  const at = (i: number, j: number) =>
    h[Math.min(resZ - 1, Math.max(0, j)) * resX + Math.min(resX - 1, Math.max(0, i))];

  for (let j = 0; j < resZ; j++) {
    for (let i = 0; i < resX; i++) {
      const v = h[j * resX + i];
      // Two-cell central differences: a wider stencil than the mesh uses,
      // because the foam wants the macro slope of the beach and not the
      // centimetre-scale ripple sitting on top of it.
      const gx = (at(i + 2, j) - at(i - 2, j)) / (4 * dx);
      const gz = (at(i, j + 2) - at(i, j - 2)) / (4 * dz);
      const slope = Math.hypot(gx, gz);
      const shore = v / Math.max(slope, 0.05);

      const x = minX + (i + 0.5) * dx;
      const z = minZ + (j + 0.5) * dz;
      const n = noise.noise2D(x * 0.055, z * 0.055) * 0.5 + 0.5;

      const o = (j * resX + i) * 4;
      data[o] = enc(v, DEPTH_RANGE) * 255;
      data[o + 1] = enc(shore, SHORE_RANGE) * 255;
      data[o + 2] = clamp(slope / 0.9, 0, 1) * 255;
      data[o + 3] = clamp(n, 0, 1) * 255;
    }
  }

  const tex = new THREE.DataTexture(data, resX, resZ, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // No mipmaps: this is a signed field, and a mipped waterline bleeds land
  // into sea and softens the foam edge into a 3 m smear at grazing angles.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Radial disc with exponentially spaced rings: ~2.4 m quads where the surf is,
 * hundreds of metres out at the horizon, 14k triangles total.
 */
function buildSeaDisc(radius: number, rings: number, spokes: number): THREE.BufferGeometry {
  const k = 5.5;
  const denom = Math.exp(k) - 1;
  const ringR: number[] = [];
  for (let r = 1; r <= rings; r++) ringR.push((radius * (Math.exp((k * r) / rings) - 1)) / denom);

  const vertCount = 1 + rings * spokes;
  const pos = new Float32Array(vertCount * 3);
  const nrm = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) nrm[i * 3 + 1] = 1;

  let p = 3; // vertex 0 is the centre, already (0,0,0)
  for (let r = 0; r < rings; r++) {
    const rad = ringR[r];
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2;
      pos[p++] = Math.cos(a) * rad;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * rad;
    }
  }

  const idx: number[] = [];
  for (let s = 0; s < spokes; s++) {
    const a = 1 + s;
    const b = 1 + ((s + 1) % spokes);
    idx.push(0, b, a);
  }
  for (let r = 0; r < rings - 1; r++) {
    const base = 1 + r * spokes;
    const next = base + spokes;
    for (let s = 0; s < spokes; s++) {
      const s1 = (s + 1) % spokes;
      idx.push(base + s, next + s1, next + s);
      idx.push(base + s, base + s1, next + s1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius * 1.02);
  return geo;
}

/* ------------------------------------------------------------------ */
/* Shader                                                              */
/* ------------------------------------------------------------------ */

const DECL = /* glsl */ `
uniform sampler2D uBed;
uniform vec4 uBedWindow;      // minX, minZ, width, depth
uniform float uTime;
varying vec2 vWXZ;
varying float vBedH;

// Signed sqrt decode — mirror of the CPU-side encoder.
float decSigned( float e, float range ) {
  float s = e * 2.0 - 1.0;
  return sign( s ) * s * s * range;
}
vec4 sampleBed( vec2 p, out float inside ) {
  vec2 uv = ( p - uBedWindow.xy ) / uBedWindow.zw;
  // Feather the window edge rather than cutting it. A binary in/out test drops
  // every bed channel to its open-sea constant in one texel, which draws a
  // dead-straight seam right across the bay at the far edge of the baked map.
  // The feather is 14 m wide and the window clears the shoreline by more than
  // twice that, so the surf band never sees it.
  vec2 feather = vec2( 14.0 ) / uBedWindow.zw;
  vec2 e = smoothstep( vec2( 0.0 ), feather, uv ) *
           smoothstep( vec2( 0.0 ), feather, vec2( 1.0 ) - uv );
  inside = e.x * e.y;
  return texture2D( uBed, clamp( uv, vec2( 0.002 ), vec2( 0.998 ) ) );
}
`;

const VERT_DECL = /* glsl */ `
uniform float uWaveAmp;
`;

const VERT_BODY = /* glsl */ `
{
  vec4 seaWp = modelMatrix * vec4( transformed, 1.0 );
  vWXZ = seaWp.xz;

  float inside;
  vec4 bed = sampleBed( seaWp.xz, inside );
  float bedH = mix( -4.0, decSigned( bed.r, 4.0 ), inside );
  vBedH = bedH;
  float depth = max( -bedH, 0.0 );

  // Waves die in the shallows (the bottom kills them) and are damped out with
  // distance so a 3 m quad never carries a 2 m wave and aliases into strobing.
  float amp = smoothstep( 0.10, 1.7, depth );
  amp *= smoothstep( 300.0, 40.0, distance( cameraPosition, seaWp.xyz ) );

  float t = uTime;
  float w = 0.0;
  w += sin( dot( seaWp.xz, vec2(  0.62, 0.78 ) ) * 1.05 + t * 1.10 ) * 0.032;
  w += sin( dot( seaWp.xz, vec2( -0.85, 0.53 ) ) * 1.71 + t * 1.55 ) * 0.020;
  w += sin( dot( seaWp.xz, vec2(  0.31, -0.95 ) ) * 2.90 + t * 2.15 ) * 0.011;

  // A slow whole-bay breathe so the waterline itself creeps in and out.
  float tide = sin( t * 0.29 ) * 0.024 * smoothstep( 0.0, 0.6, depth );
  transformed.y += ( w * amp + tide ) * uWaveAmp;
}
`;

const FRAG_DECL = /* glsl */ `
uniform sampler2D uSwell;
uniform sampler2D uChop;
uniform sampler2D uDetail;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoamColor;
uniform vec3 uSkyTint;
uniform vec3 uSunDir;         // world space, pointing toward the sun
uniform vec3 uSunColor;
float gFoam;
float gDepth;
float gFar;
`;

/** Colour, transparency and foam. Runs in place of `<map_fragment>`. */
const FRAG_COLOR = /* glsl */ `
vec2 P = vWXZ;
float t = uTime;

float inside;
vec4 bed = sampleBed( P, inside );
float bedH = mix( -4.0, decSigned( bed.r, 4.0 ), inside );
float shoreD = mix( -8.0, decSigned( bed.g, 8.0 ), inside );
float slope = mix( 0.55, bed.b, inside );
float placeN = bed.a;

float depth = max( -bedH, 0.0 );
// Horizontal metres from the waterline, positive out to sea.
float s = max( -shoreD, 0.0 );

// One distance term drives every anti-aliasing decision below. Ripple normal
// maps minify catastrophically at grazing angles — the fix is not a sharper
// filter but folding the lost detail into roughness, which is energy
// conserving and, unlike a mip bias, cannot re-alias.
gFar = smoothstep( 5.0, 45.0, length( vViewPosition ) );

// ---- body colour -------------------------------------------------------
float dt = smoothstep( 0.05, 2.3, depth );
vec3 col = mix( uShallow, uDeep, dt );
col = mix( col, uDeep * vec3( 0.88, 0.95, 1.02 ), smoothstep( 2.2, 12.0, depth ) );
// The shallows pick up the sand they are lying on, which is what keeps the
// turquoise from reading as a swimming pool.
col = mix( col * vec3( 1.16, 1.09, 0.92 ), col, smoothstep( 0.0, 0.9, depth ) );
// Very large-scale value drift. The far sea loses its ripple normals to the
// anti-aliasing above, and without something at a 50 m wavelength to replace
// them the horizon flattens into a single printed gradient.
float macro = texture2D( uDetail, P * 0.019 + vec2( 0.0016, 0.0009 ) * t ).b;
float macro2 = texture2D( uDetail, P * 0.047 - vec2( 0.0031, 0.0022 ) * t ).r;
col *= 0.92 + macro * 0.13 + macro2 * 0.06;

// ---- caustics ----------------------------------------------------------
float ca1 = texture2D( uDetail, P * 0.62 + vec2(  0.013, 0.008 ) * t ).a;
float ca2 = texture2D( uDetail, P * 0.39 - vec2(  0.010, 0.016 ) * t ).a;
float caustic = pow( clamp( ca1 * ca2 * 2.3, 0.0, 1.0 ), 1.7 );
col += caustic * vec3( 0.26, 0.40, 0.33 ) * ( 1.0 - dt ) * 0.85;

// ---- shoreline foam ----------------------------------------------------
// Two out-of-phase swells plus a per-place offset: the wash arrives at
// different points of the beach at different times, which is the difference
// between surf and a pulsing outline.
float tide = sin( t * 0.55 + placeN * 6.3 ) * 0.55 + sin( t * 0.31 + placeN * 2.1 + 2.4 ) * 0.45;
float reach = mix( 2.10, 0.75, clamp( slope * 1.4, 0.0, 1.0 ) ) * ( 0.58 + 0.42 * tide );
reach = max( reach, 0.22 );

float wash = smoothstep( reach, reach * 0.15, s );

float fnA = texture2D( uDetail, P * 0.50 + vec2( 0.004, 0.052 ) * t ).r;
float fnB = texture2D( uDetail, P * 1.55 - vec2( 0.031, 0.088 ) * t ).r;
float fn = fnA * 0.6 + fnB * 0.4;

float body = smoothstep( 0.50 - wash * 0.70, 0.86 - wash * 0.70, fn ) * wash;
// A permanent lace of bubbles clinging to the waterline itself.
float lace = smoothstep( 0.40, 0.0, s ) * smoothstep( 0.26, 0.70, fnB );
// The bright leading edge of the wash.
float crest = smoothstep( 0.20, 0.0, abs( s - reach * 0.72 ) ) * smoothstep( 0.24, 0.58, fnA );
// Sets of breakers marching shoreward. Lines of constant shore-distance are
// parallel to the waterline whatever shape the bay is, so this costs one sine
// and reads as real surf rather than as a scrolling texture.
float march = sin( s * 1.75 - t * 1.15 + placeN * 5.4 );
float breaker = smoothstep( 0.62, 0.99, march ) * smoothstep( 7.0, 1.2, s )
              * smoothstep( 0.30, 0.75, fnB ) * 0.55;
// Torn-off patches drifting back out over the shallows.
float streak = texture2D( uDetail, P * vec2( 0.9, 0.22 ) + vec2( 0.0, 0.10 ) * t ).b;
float drift = smoothstep( 3.6, 0.4, s ) * smoothstep( 0.70, 0.96, fnA * 0.5 + streak * 0.6 ) * 0.40;

float foam = clamp( max( max( body, lace * 0.95 ), max( max( crest * 0.9, drift ), breaker ) ), 0.0, 1.0 );
foam *= step( 0.001, depth );

col = mix( col, uFoamColor, foam );

// ---- transparency ------------------------------------------------------
// Shallow water is a wash of colour over wet sand; deep water is opaque. The
// low alpha at the very edge is also what hides the geometric intersection
// line between the surface and the beach.
float alphaW = mix( 0.52, 0.96, smoothstep( 0.02, 0.85, depth ) );
float alpha = max( alphaW, foam * 0.97 );

gFoam = foam;
gDepth = depth;

diffuseColor = vec4( col, alpha );
`;

const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mix( roughness, 0.80, gFoam );
// Glassy right at the shore where the water is a thin film, choppier offshore.
roughnessFactor = mix( roughnessFactor * 0.55, roughnessFactor, smoothstep( 0.0, 0.5, gDepth ) );
// Distance detail traded for roughness — see gFar.
roughnessFactor = mix( roughnessFactor, 0.46, gFar * 0.96 );
`;

const FRAG_NORMAL = /* glsl */ `
{
  // ---- domain warp -------------------------------------------------------
  // Two normal layers on an unrotated world-space grid put their baked
  // directional crests on the same two axes, and the tile boundaries line up
  // into the diagonal corduroy lattice that was showing across the whole
  // midground. The cure is threefold: warp the sample position by a very
  // large-scale noise so no tile edge is ever straight, rotate each layer by a
  // different irrational angle so no two crest directions can beat, and put the
  // layer scales at non-harmonic ratios.
  float dist = length( vViewPosition );
  vec2 wA = texture2D( uDetail, vWXZ * 0.0072 + vec2(  0.00090, 0.00061 ) * uTime ).bg - 0.5;
  vec2 wB = texture2D( uDetail, vWXZ * 0.0231 - vec2(  0.00135, 0.00194 ) * uTime ).br - 0.5;
  vec2 Pw = vWXZ + wA * 11.0 + wB * 2.6;

  // 21.8 deg, 104.8 deg, -52.0 deg.
  mat2 r1 = mat2(  0.9285, -0.3714,  0.3714,  0.9285 );
  mat2 r2 = mat2( -0.2554, -0.9668,  0.9668, -0.2554 );
  mat2 r3 = mat2(  0.6157,  0.7880, -0.7880,  0.6157 );

  vec3 nA = texture2D( uSwell, r1 * Pw * 0.0417 + vec2(  0.0193,  0.0108 ) * uTime ).xyz * 2.0 - 1.0;
  vec3 nB = texture2D( uChop,  r2 * Pw * 0.1123 - vec2(  0.0131,  0.0246 ) * uTime ).xyz * 2.0 - 1.0;
  vec3 nC = texture2D( uChop,  r3 * Pw * 0.2971 + vec2( -0.0287,  0.0165 ) * uTime ).xyz * 2.0 - 1.0;
  // Each layer's xy is expressed in its own rotated frame; multiplying the
  // vector from the left applies the transpose, i.e. the inverse rotation, and
  // brings it back onto world X/Z where the tangent frame below expects it.
  vec2 aXY = nA.xy * r1;
  vec2 bXY = nB.xy * r2;
  vec2 cXY = nC.xy * r3;

  // ---- distance fade -----------------------------------------------------
  // Finer layers minify first, so they are retired first. Past ~35 m only the
  // long swell survives and the horizon settles into calm haze instead of
  // aliasing into a grid.
  float fadeBroad = 1.0 - smoothstep(  8.0, 60.0, dist ) * 0.90;
  float fadeMid   = 1.0 - smoothstep(  5.0, 30.0, dist ) * 0.97;
  float fadeFine  = 1.0 - smoothstep(  2.5, 14.0, dist );

  float damp = 1.0 - gFar * 0.55;
  float shelter = mix( 0.30, 1.0, smoothstep( 0.04, 0.75, gDepth ) );
  vec2 nxy = ( aXY * 0.50 * fadeBroad + bXY * 0.30 * fadeMid + cXY * 0.16 * fadeFine )
           * damp * shelter * ( 1.0 - gFoam * 0.5 );

  vec3 mn = normalize( vec3( nxy, 1.0 ) );
  // The ripple UVs run along world +X / +Z, so the tangent frame is those two
  // axes brought into view space and orthogonalised against the interpolated
  // normal — no tangent attribute, no seam.
  vec3 T = ( viewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz;
  vec3 B = ( viewMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz;
  T = normalize( T - normal * dot( normal, T ) );
  B = normalize( B - normal * dot( normal, B ) - T * dot( T, B ) );
  normal = normalize( T * mn.x + B * mn.y + normal * mn.z );
}
`;

const FRAG_GLITTER = /* glsl */ `
{
  vec3 L = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  vec3 V = normalize( vViewPosition );
  vec3 H = normalize( L + V );
  float ndh = max( dot( normal, H ), 0.0 );
  // The lobe widens with distance for the same reason roughness rises: a
  // 240-power highlight on a sub-pixel ripple is a strobe, not a sparkle.
  float lobe = pow( ndh, mix( 230.0, 34.0, gFar ) );

  // The sparkle field is sampled at a distance-compensated world scale, so each
  // glint keeps covering a few pixels instead of mipping away exactly where
  // real sun glitter is strongest.
  float sc = mix( 1.40, 0.045, gFar );
  float sp1 = texture2D( uDetail, vWXZ * sc + vec2( 0.031, 0.019 ) * uTime ).g;
  float sp2 = texture2D( uDetail, vWXZ * sc * 2.4 - vec2( 0.022, 0.048 ) * uTime ).g;
  float sparkle = smoothstep( 0.52, 0.95, sp1 * 0.6 + sp2 * 0.55 );

  totalEmissiveRadiance += uSunColor * lobe * ( 0.22 + sparkle * 1.15 ) * 0.95 * ( 1.0 - gFoam * 0.75 );
  // Foam is a diffuse white solid, but wet foam still catches a broad sheen.
  totalEmissiveRadiance += uSunColor * gFoam * pow( ndh, 12.0 ) * 0.10;

  // Stylised Fresnel sky lift. Real water gets most of its brightness toward
  // the horizon from the sky it reflects; the PMREM alone is too dim at this
  // environment intensity to carry it, and without it the bay reads as ink.
  float F = pow( clamp( 1.0 - max( dot( normal, V ), 0.0 ), 0.0, 1.0 ), 4.0 );
  totalEmissiveRadiance += uSkyTint * F * ( 1.0 - gFoam ) * 0.55;
}
`;

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildWater(ctx: GameContext): void {
  const bed = bakeSeabed((x, z) => ctx.collision.groundHeight(x, z));

  const swell = waterSwellNormal();
  const chop = waterChopNormal();
  const detail = waterDetailTexture();
  // The sea is the one surface always read at a grazing angle across hundreds
  // of metres; it needs the whole anisotropic budget.
  for (const t of [swell, chop, detail]) {
    t.anisotropy = 16;
    t.needsUpdate = true;
  }

  const uniforms = {
    uBed: { value: bed },
    uBedWindow: { value: new THREE.Vector4(BED.minX, BED.minZ, BED.width, BED.depth) },
    uTime: { value: 0 },
    uWaveAmp: { value: 1 },
    uSwell: { value: swell },
    uChop: { value: chop },
    uDetail: { value: detail },
    uShallow: { value: new THREE.Color(COLOR_SHALLOW).convertSRGBToLinear() },
    uDeep: { value: new THREE.Color(COLOR_DEEP).convertSRGBToLinear() },
    uFoamColor: { value: new THREE.Color(COLOR_FOAM).convertSRGBToLinear() },
    uSkyTint: { value: new THREE.Color(0xbfe0f2).convertSRGBToLinear().multiplyScalar(0.9) },
    uSunDir: { value: ctx.env.sunDirection.clone().multiplyScalar(-1) },
    uSunColor: { value: ctx.env.sunColor.clone() },
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.23,
    metalness: 0.0,
    ior: 1.33,
    specularIntensity: 1.0,
    envMapIntensity: 0.80,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    dithering: true,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + DECL + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DECL + FRAG_DECL)
      .replace('#include <map_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_GLITTER);
  };
  mat.customProgramCacheKey = () => 'pallet-sea-v2';

  const mesh = new THREE.Mesh(buildSeaDisc(SEA.radius, SEA.rings, SEA.spokes), mat);
  mesh.name = 'Sea';
  mesh.position.y = 0;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Transparent surfaces sort by distance to their origin; the disc's origin is
  // the town centre, which would place it in front of props it is behind. A
  // fixed render order puts the sea after the opaque pass and before nothing
  // else, which is exactly where it belongs.
  mesh.renderOrder = 2;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  ctx.scene.add(mesh);

  ctx.tick(() => {
    uniforms.uTime.value = ctx.env.windTime.value;
  });
}
