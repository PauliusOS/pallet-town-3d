import * as THREE from 'three';
import type { EnvironmentState } from '../core/Context';
import { Simplex, tileableFbm, worley, clamp, smoothstep, lerp, makeRng } from '../core/Noise';
import { bakeColorMap, bakeNormalMap, bakeScalarMap, cached, mixHex, hexToRgb } from '../core/TextureLab';

/**
 * Foliage shading — the part of the vegetation system that decides whether the
 * town reads as Animal Crossing or as a pile of green spheres.
 *
 * Three effects stack, and all three are needed; drop any one and the canopy
 * flattens out:
 *
 *  1. **Wrap diffuse.** Leaves are thin and scatter sideways, so the terminator
 *     on a canopy is nothing like the terminator on a rock. We replace the
 *     Standard material's `RE_Direct` with a wrapped-Lambert version. Doing it
 *     inside `RE_Direct` rather than bolting an additive term onto the end of
 *     the chain matters: `directLight.color` arrives *already multiplied by the
 *     shadow*, so the wrap and the transmission are correctly occluded by the
 *     rest of the tree instead of glowing through it.
 *
 *  2. **Back-lit transmission.** The classic DICE approximation — a
 *     view-dependent lobe pointing away from the light, distorted by the
 *     normal. Modulated by a per-vertex *thickness* channel so the thin outer
 *     shell of the canopy lights up and the dense interior stays dark.
 *
 *  3. **Interior occlusion baked to vertex colour.** Every canopy vertex is
 *     darkened toward the cluster's core and toward its underside. This is the
 *     single cheapest trick in stylised rendering: it turns a painted ball into
 *     a volume, and it is what the eye actually reads as "there are leaves
 *     behind those leaves".
 *
 * On top of that, one shared wind function displaces everything — trees,
 * bushes, grass, flowers — in *world* space from one clock, with a per-instance
 * phase so nothing sways in lockstep.
 *
 * Attribute contract for any geometry using these materials:
 *   `aFlex`  vec2, per vertex   — x: wind compliance 0..1, y: thickness 0..1
 *   `aWind`  vec2, per instance — x: phase offset, y: amplitude multiplier
 */

/* ------------------------------------------------------------------ */
/* Noise bases                                                         */
/* ------------------------------------------------------------------ */

const LEAF = new Simplex(0x1eaf01);
const BLADE = new Simplex(0x8bade5);
const BARK = new Simplex(0xba2c01);

/* ------------------------------------------------------------------ */
/* Shader source                                                       */
/* ------------------------------------------------------------------ */

const WIND_GLSL = /* glsl */ `
attribute vec2 aFlex;
attribute vec2 aWind;
uniform float uWindTime;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uWindScale;
varying float vFolThick;

/**
 * World-space sway. Two incommensurate gust waves travelling along the wind
 * direction (so a gust visibly crosses the treeline instead of every tree
 * pulsing together), plus a fast lateral flutter for leaf chatter. The vertical
 * term is negative-biased: a swinging branch traces an arc, it does not stretch.
 */
vec3 foliageWind( vec3 wp, float flex, float phase, float mul ) {
  float t = uWindTime * 0.9 + phase;
  float travel = dot( wp.xz, uWindDir ) * 0.24;
  float g = sin( t * 1.00 - travel ) * 0.62 + sin( t * 1.73 - travel * 1.63 + 2.1 ) * 0.38;
  float f = sin( t * 5.9 + phase * 2.7 + wp.y * 3.4 ) * 0.55
          + sin( t * 9.3 + phase * 4.1 + wp.x * 2.2 ) * 0.45;
  float amp = uWindStrength * uWindScale * mul * flex;
  vec3 dir  = vec3( uWindDir.x, 0.0, uWindDir.y );
  vec3 side = vec3( -uWindDir.y, 0.0, uWindDir.x );
  vec3 off = dir * ( g * amp ) + side * ( f * amp * 0.26 );
  off.y -= abs( g ) * amp * 0.17;
  off.y += f * amp * 0.09;
  return off;
}
`;

const WIND_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 folWorld = modelMatrix * mvPosition;
// Texturing samples the *rest* position: if the triplanar lookup followed the
// sway, the leaf pattern would swim across the canopy every gust.
vFolWPos = folWorld.xyz;
folWorld.xyz += foliageWind( folWorld.xyz, aFlex.x, aWind.x, 0.35 + aWind.y );
mvPosition = viewMatrix * folWorld;
gl_Position = projectionMatrix * mvPosition;
`;

/* ---- triplanar --------------------------------------------------- */

/**
 * A metaball canopy has no sane UV unwrap. Box projection — the obvious cheap
 * answer — smears badly wherever the surface normal crosses between projection
 * axes, and on a lumpy sphere that boundary runs right through the middle of
 * every silhouette, printing a topographic-map swirl across the hero asset.
 *
 * Triplanar removes it entirely, and because the lookup is in *world* space
 * every instance of the same canopy geometry samples a different part of the
 * texture, so instancing stops being visible for free.
 */
const TRIPLANAR_DECL = /* glsl */ `
uniform float uTriScale;
varying vec3 vFolWPos;
varying vec3 vFolWNrm;

vec3 triBlend( vec3 n ) {
  vec3 b = pow( abs( n ), vec3( 4.0 ) );
  return b / max( b.x + b.y + b.z, 1e-4 );
}
`;

const TRIPLANAR_MAP = /* glsl */ `
{
  vec3 bl = triBlend( vFolWNrm );
  vec2 uvX = vFolWPos.zy * uTriScale;
  vec2 uvY = vFolWPos.xz * uTriScale;
  vec2 uvZ = vFolWPos.xy * uTriScale;
  vec4 tri = texture2D( map, uvX ) * bl.x + texture2D( map, uvY ) * bl.y + texture2D( map, uvZ ) * bl.z;
  diffuseColor *= tri;
}
`;

const TRIPLANAR_NORMAL = /* glsl */ `
{
  // Whiteout blend: each plane's tangent normal is added to the world normal's
  // in-plane components before the three are mixed, which keeps detail on faces
  // the projection is grazing instead of washing them flat.
  vec3 bl = triBlend( vFolWNrm );
  vec2 uvX = vFolWPos.zy * uTriScale;
  vec2 uvY = vFolWPos.xz * uTriScale;
  vec2 uvZ = vFolWPos.xy * uTriScale;
  vec3 nX = texture2D( normalMap, uvX ).xyz * 2.0 - 1.0;
  vec3 nY = texture2D( normalMap, uvY ).xyz * 2.0 - 1.0;
  vec3 nZ = texture2D( normalMap, uvZ ).xyz * 2.0 - 1.0;
  nX.xy *= normalScale;
  nY.xy *= normalScale;
  nZ.xy *= normalScale;
  vec3 wn = normalize( vFolWNrm );
  nX = vec3( nX.xy + wn.zy, abs( nX.z ) * wn.x );
  nY = vec3( nY.xy + wn.xz, abs( nY.z ) * wn.y );
  nZ = vec3( nZ.xy + wn.xy, abs( nZ.z ) * wn.z );
  vec3 worldN = normalize( nX.zyx * bl.x + nY.xzy * bl.y + nZ.xyz * bl.z );
  normal = normalize( ( viewMatrix * vec4( worldN, 0.0 ) ).xyz );
}
`;

const FOLIAGE_FRAG_DECL = /* glsl */ `
uniform float uWrap;
uniform vec3  uWrapTint;
uniform vec3  uTransColor;
uniform float uTransPower;
uniform float uTransStrength;
uniform float uTransDistort;
uniform vec3  uSunDir;
uniform float uHaloStrength;
uniform float uHaloPower;
uniform float uMapContrast;
varying float vFolThick;
`;

const FOLIAGE_RE_DIRECT = /* glsl */ `
/**
 * Wrapped-diffuse + transmissive replacement for RE_Direct_Physical.
 * directLight.color is already shadow-attenuated at the call site, so both
 * added terms respect the shadow map for free.
 */
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  float dotNL = dot( geometryNormal, directLight.direction );

  // Wrap: light bleeds around the limb instead of stopping dead at 90 degrees.
  float wrapped = saturate( ( dotNL + uWrap ) / ( 1.0 + uWrap ) );
  // The wrapped tail is light that has been *through* a leaf, so it is warmer
  // and greener than the light that bounced off one.
  vec3 tint = mix( uWrapTint, vec3( 1.0 ), saturate( dotNL ) );
  vec3 irradiance = wrapped * directLight.color * tint;

  // Specular keeps the hard terminator — a waxy leaf highlight should not wrap.
  reflectedLight.directSpecular += saturate( dotNL ) * directLight.color *
    BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material );

  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );

  // Back-lit transmission (DICE approximation): a lobe pointing away from the
  // light, smeared by the surface normal, gated by how thin the canopy is here.
  vec3 transLight = normalize( directLight.direction + geometryNormal * uTransDistort );
  float back = pow( saturate( dot( geometryViewDir, -transLight ) ), uTransPower );
  float thick = vFolThick * vFolThick;
  reflectedLight.directDiffuse += directLight.color * uTransColor *
    ( back * uTransStrength * thick ) * material.diffuseContribution;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Foliage
`;

const FOLIAGE_HALO = /* glsl */ `
#include <emissivemap_fragment>
{
  // Ambient forward-scatter halo. Independent of the shadow map on purpose:
  // the sky itself is a huge source behind the canopy, so the thin outer leaves
  // keep a faint warm glow even where the sun disc is occluded.
  vec3 sunView = normalize( ( viewMatrix * vec4( -uSunDir, 0.0 ) ).xyz );
  vec3 viewDirV = normalize( vViewPosition );
  float toward = saturate( dot( -viewDirV, sunView ) );
  float halo = pow( toward, uHaloPower ) * uHaloStrength * vFolThick;
  totalEmissiveRadiance += uTransColor * halo * diffuseColor.rgb;
}
`;

/* ------------------------------------------------------------------ */
/* Material factory                                                    */
/* ------------------------------------------------------------------ */

export interface FoliageMaterialOptions {
  color: number;
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  normalScale?: number;
  roughness?: number;
  /** Per-material wind amplitude. Trunks ~0.1, canopies ~1, grass ~1.6. */
  windScale: number;
  /** Diffuse wrap amount. 0 = Lambert, 0.6 = very soft. */
  wrap?: number;
  transStrength?: number;
  transColor?: number;
  transPower?: number;
  haloStrength?: number;
  /** World-space texture frequency. > 0 switches map + normalMap to triplanar. */
  triplanar?: number;
  /**
   * How much of the albedo map's range to keep, 0..1. Below 1 the sample is
   * mixed toward white, lifting the surface's mean value while preserving its
   * variation. Bark needs this: `barkMaps` is authored as a full-range albedo,
   * and a full-range dark map under a stylised sky turns every trunk into a
   * black cut-out the moment the sun is not square on it.
   */
  mapContrast?: number;
  alphaTest?: number;
  side?: THREE.Side;
  depthWrite?: boolean;
  alphaToCoverage?: boolean;
  vertexColors?: boolean;
}

/** Materials that need their wind uniforms refreshed if the weather changes. */
const registry: {
  uniforms: Record<string, THREE.IUniform>;
  env: EnvironmentState;
}[] = [];

export function createFoliageMaterial(
  env: EnvironmentState,
  o: FoliageMaterialOptions,
): THREE.MeshStandardMaterial {
  // Optional maps are attached only when present. Passing `undefined` for a
  // texture parameter is not ignored by Three — it warns once per material,
  // which buried the console in ~20 lines of noise on every load and made real
  // warnings easy to miss.
  const params: THREE.MeshStandardMaterialParameters = {
    color: o.color,
    roughness: o.roughness ?? 0.82,
    metalness: 0.0,
    side: o.side ?? THREE.DoubleSide,
    vertexColors: o.vertexColors ?? true,
    alphaTest: o.alphaTest ?? 0,
    depthWrite: o.depthWrite ?? true,
    dithering: true,
  };
  if (o.map) params.map = o.map;
  if (o.normalMap) params.normalMap = o.normalMap;
  if (o.roughnessMap) params.roughnessMap = o.roughnessMap;

  const mat = new THREE.MeshStandardMaterial(params);
  if (o.normalMap && o.normalScale !== undefined) {
    mat.normalScale.set(o.normalScale, o.normalScale);
  }
  if (o.alphaToCoverage) mat.alphaToCoverage = true;

  const uniforms: Record<string, THREE.IUniform> = {
    uWindTime: env.windTime,
    uWindDir: { value: env.windDirection.clone().normalize() },
    uWindStrength: { value: env.windStrength },
    uWindScale: { value: o.windScale },
    uWrap: { value: o.wrap ?? 0.42 },
    uWrapTint: { value: new THREE.Color(1.06, 1.0, 0.74) },
    uTransColor: { value: new THREE.Color(o.transColor ?? 0x9ad85a) },
    uTransPower: { value: o.transPower ?? 3.0 },
    uTransStrength: { value: o.transStrength ?? 1.5 },
    uTransDistort: { value: 0.38 },
    uSunDir: { value: env.sunDirection.clone() },
    uHaloStrength: { value: o.haloStrength ?? 0.16 },
    uHaloPower: { value: 4.0 },
    uTriScale: { value: o.triplanar ?? 0 },
    uMapContrast: { value: o.mapContrast ?? 1 },
  };
  registry.push({ uniforms, env });

  const tri = (o.triplanar ?? 0) > 0;
  const lift = !!o.map && (o.mapContrast ?? 1) < 1;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WIND_GLSL + (tri ? TRIPLANAR_DECL : ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFolThick = aFlex.y;')
      .replace('#include <project_vertex>', tri ? WIND_PROJECT : WIND_PROJECT.replace('vFolWPos = folWorld.xyz;', ''));

    if (tri) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
{
  vec3 folN = objectNormal;
  #ifdef USE_INSTANCING
    folN = mat3( instanceMatrix ) * folN;
  #endif
  vFolWNrm = normalize( mat3( modelMatrix ) * folN );
}`,
      );
    }

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' + FOLIAGE_FRAG_DECL + (tri ? TRIPLANAR_DECL : ''),
      )
      .replace(
        '#include <lights_physical_pars_fragment>',
        '#include <lights_physical_pars_fragment>\n' + FOLIAGE_RE_DIRECT,
      )
      .replace('#include <emissivemap_fragment>', FOLIAGE_HALO);

    if (tri) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_fragment>', TRIPLANAR_MAP)
        .replace('#include <normal_fragment_maps>', o.normalMap ? TRIPLANAR_NORMAL : '');
    } else if (lift) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `
        {
          vec4 folTexel = texture2D( map, vMapUv );
          folTexel.rgb = mix( vec3( 1.0 ), folTexel.rgb, uMapContrast );
          diffuseColor *= folTexel;
        }`,
      );
    }
  };
  mat.customProgramCacheKey = () =>
    tri ? 'foliage-tri-v1' : lift ? 'foliage-lift-v1' : 'foliage-wrap-v2';

  return mat;
}

/** Re-reads wind/sun state from the environment. Cheap; call on weather change. */
export function refreshFoliageUniforms(): void {
  for (const r of registry) {
    (r.uniforms.uWindDir.value as THREE.Vector2).copy(r.env.windDirection).normalize();
    r.uniforms.uWindStrength.value = r.env.windStrength;
    (r.uniforms.uSunDir.value as THREE.Vector3).copy(r.env.sunDirection);
  }
}

/* ------------------------------------------------------------------ */
/* Geometry attribute helpers                                          */
/* ------------------------------------------------------------------ */

/**
 * Writes the `aFlex` attribute (wind compliance + leaf thickness) that every
 * foliage material expects.
 *
 * `flex` is normally a function of height so a trunk base is rigid and a leaf
 * tip is loose; `thick` drives the transmission and should approach 1 on the
 * thin outer shell of a canopy and 0 deep inside it.
 */
export function setFlex(
  geo: THREE.BufferGeometry,
  fn: (x: number, y: number, z: number, i: number) => [number, number],
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const data = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const [f, t] = fn(pos.getX(i), pos.getY(i), pos.getZ(i), i);
    data[i * 2] = f;
    data[i * 2 + 1] = t;
  }
  geo.setAttribute('aFlex', new THREE.BufferAttribute(data, 2));
  return geo;
}

/** Attaches the per-instance wind phase / amplitude buffer to an InstancedMesh. */
export function setInstanceWind(
  mesh: THREE.InstancedMesh,
  phases: Float32Array,
): void {
  mesh.geometry.setAttribute('aWind', new THREE.InstancedBufferAttribute(phases, 2));
}

/* ------------------------------------------------------------------ */
/* Geometry merge                                                      */
/* ------------------------------------------------------------------ */

/**
 * Minimal indexed merge over the attribute set this subsystem uses. Written
 * locally rather than pulled from the examples' BufferGeometryUtils because we
 * need it to be strict about which attributes survive — a merge that silently
 * drops `aFlex` produces a tree that will not move, and the failure is
 * invisible in a still frame.
 */
export function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = ['position', 'normal', 'uv', 'color', 'aFlex'];
  const sizes: Record<string, number> = { position: 3, normal: 3, uv: 2, color: 3, aFlex: 2 };
  const present = names.filter((n) => geos.every((g) => !!g.attributes[n]));

  let total = 0;
  let idxTotal = 0;
  for (const g of geos) {
    total += (g.attributes.position as THREE.BufferAttribute).count;
    idxTotal += g.index ? g.index.count : (g.attributes.position as THREE.BufferAttribute).count;
  }

  const out = new THREE.BufferGeometry();
  const buffers: Record<string, Float32Array> = {};
  for (const n of present) buffers[n] = new Float32Array(total * sizes[n]);
  const indices = new Uint32Array(idxTotal);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const count = (g.attributes.position as THREE.BufferAttribute).count;
    for (const n of present) {
      const src = g.attributes[n] as THREE.BufferAttribute;
      const s = sizes[n];
      const dst = buffers[n];
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < s; c++) dst[(vOff + i) * s + c] = src.getComponent(i, c);
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[iOff + i] = g.index.getX(i) + vOff;
    } else {
      for (let i = 0; i < count; i++) indices[iOff + i] = vOff + i;
    }
    iOff += g.index ? g.index.count : count;
    vOff += count;
  }

  for (const n of present) out.setAttribute(n, new THREE.BufferAttribute(buffers[n], sizes[n]));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}

/* ------------------------------------------------------------------ */
/* Canopy leaf-mass texture                                            */
/* ------------------------------------------------------------------ */

/**
 * The leaf mass a canopy is skinned with. Two Worley scales give clumps of
 * clumps; the fine one is what the eye reads as individual leaf groups at
 * conversational distance, the coarse one keeps the canopy from looking evenly
 * stippled from across the town.
 */
function leafHeight(u: number, v: number): number {
  const big = worley(u, v, 5, 3);
  const mid = worley(u * 1.0 + 0.31, v + 0.17, 12, 91);
  const fine = worley(u + 0.61, v * 1.0 + 0.44, 27, 17);
  const n = tileableFbm(LEAF, u, v, 24, 4);
  return clamp(
    0.30 +
      smoothstep(0.60, 0.05, big.f1) * 0.30 +
      smoothstep(0.42, 0.04, mid.f1) * 0.26 +
      smoothstep(0.30, 0.02, fine.f1) * 0.20 +
      n * 0.12,
    0,
    1,
  );
}

export interface LeafMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/**
 * Baked leaf-mass maps. `warm` shifts the whole set toward yellow-green
 * (maples, autumn-touched trees) or blue-green (conifers, shaded species) so a
 * treeline built from four species does not read as one repeated texture.
 */
export function leafMaps(key: string, dark: number, light: number, size = 1024): LeafMaps {
  return {
    map: cached(`leaf.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const h = leafHeight(u, v);
          // Per-clump hue jitter: neighbouring leaf groups differ in value and
          // in warmth, which is what stops a canopy reading as one flat green.
          const cell = worley(u * 1.0 + 0.31, v + 0.17, 15, 91);
          const jit = ((cell.id % 1013) / 1013) * 2 - 1;
          const c = mixHex(dark, light, clamp((h - 0.22) * 2.1 + jit * 0.22, 0, 1));
          // A few sun-bleached leaves and a few deep gaps into the interior.
          // Both are needed: only highlights reads as fog, only shadow reads as
          // mud. The gap is deliberately shallow — the *lighting* supplies the
          // canopy's darkness, the albedo must not, or the tree turns to moss.
          const bleach = smoothstep(0.78, 0.99, h + jit * 0.1);
          const gap = smoothstep(0.30, 0.06, h);
          const warm = hexToRgb(0xe6f0a4);
          const deep = hexToRgb(0x2c5230);
          return [
            lerp(lerp(c[0], warm[0], bleach * 0.6), deep[0], gap * 0.6),
            lerp(lerp(c[1], warm[1], bleach * 0.6), deep[1], gap * 0.6),
            lerp(lerp(c[2], warm[2], bleach * 0.6), deep[2], gap * 0.6),
          ];
        },
      }),
    ),
    normalMap: cached(`leaf.${key}.normal`, () =>
      bakeNormalMap({ size: Math.min(size, 512), height: leafHeight }, 2.4),
    ),
    roughnessMap: cached('leaf.rough', () =>
      bakeScalarMap(256, (u, v) => clamp(0.90 - leafHeight(u, v) * 0.22, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Canopy shadow perforation                                           */
/* ------------------------------------------------------------------ */

/**
 * A hole mask for the canopy's *shadow* pass only.
 *
 * The canopy is a metaball blob, and a blob is airtight. However good its
 * silhouette and its transmission are, it casts the shadow of a boulder: one
 * solid slab of shade with a soft edge. So the forest floor came out as a single
 * flat wash of cool green with no sun in it anywhere, and the whole treeline shot
 * read as an overcast interior — which is the exact opposite of the 9:30am clear
 * sun the art direction asks for. Dappled light is not a nicety under a tree, it
 * is the main thing the eye uses to read "there is a canopy above me".
 *
 * Modelling the gaps for real is not an option: the mass has to stay opaque in
 * the beauty pass or the crown turns to lace and the interior occlusion stops
 * making sense. But the beauty pass and the shadow pass do not have to agree.
 * Handing the canopy mesh a `customDepthMaterial` carrying this mask as an
 * `alphaMap` punches holes in the depth render *only*, so the crown stays a solid
 * green mass and its shadow gains sun-flecks. It costs one extra program and no
 * extra draw calls, and it is the cheapest metre of dappled light available.
 *
 * The pattern is two tiers of Worley cell *interiors* — the holes are the middles
 * of the cells and the opaque walls are the cracks between them, which is the
 * right way round for foliage: leaves clump and the gaps are the spaces between
 * clumps. Authored coarse on purpose. At the canopy's box-projected UV scale one
 * tile is ~2.5 m, so five cells across is a ~50 cm gap, and a fleck of sun
 * smaller than ~20 cm is below the VSM blur radius and would smear back to grey.
 */
export function canopyPerforationMap(size = 256): THREE.Texture {
  return cached('canopy.perforation', () => {
    const tex = bakeScalarMap(size, (u, v) => {
      const big = worley(u, v, 5, 401);
      const mid = worley(u + 0.37, v + 0.19, 9, 613);
      // Ragged rims: an un-warped cell interior is an ellipse, and a shadow full
      // of ellipses reads as polka dots rather than as light through leaves.
      const warp = tileableFbm(LEAF, u * 1.6 + 21, v * 1.6, 9, 3) * 0.5 + 0.5;
      const hole = Math.max(
        smoothstep(0.34, 0.04, big.f1) * (0.72 + warp * 0.5),
        smoothstep(0.22, 0.02, mid.f1) * (0.45 + warp * 0.45),
      );
      return clamp(1 - hole, 0, 1);
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Bark                                                                */
/* ------------------------------------------------------------------ */

/**
 * Bark height field.
 *
 * `TextureLab.barkMaps` stretches its noise by 3.2 : 0.42 in u : v — roughly
 * 8 : 1 — and the trunks were then UV'd with barely two v repeats over a four
 * metre spine. The result was a single two-metre-tall smear per fissure, which
 * is the vertical streak the treeline shot is full of. Bark fissures are tall,
 * but they are *centimetres* wide and tens of centimetres long, not metres, and
 * critically they are *broken*: real bark is a field of plates separated by
 * cracks, not a set of continuous grooves.
 *
 * So three bands stack here:
 *  - `plate`: Worley cells, elongated 3 : 1 along the trunk, whose *edges* are
 *    the deep cracks. This is what gives bark its blocky, interrupted read.
 *  - `groove`: ridged fbm at 4 : 1, the fine vertical fibre inside each plate.
 *  - `check`: sparse horizontal checking across the plates, which is what stops
 *    the whole thing reading as corduroy.
 *
 * `roughShare` biases between a heavily fissured oak (1) and a smooth birch (0),
 * so one function serves every species in the wood.
 */
function barkHeight(u: number, v: number, roughShare: number): number {
  /**
   * Domain warp, applied *before* the cell lookup.
   *
   * An un-warped Worley field is a Voronoi tessellation: a mosaic of convex
   * cells of closely similar size whose centres are the high points. A field of
   * similar-sized convex bumps separated by grooves is, precisely, reptile
   * scales — and that is what the previous trunks read as at close range,
   * trading one procedural tell (a vertical smear) for another (crocodile
   * skin). Warping the lookup by two octaves of tileable fbm bends the cell
   * walls into the meandering, branching, unequal crack network real bark has,
   * and it is the single change that stops the pattern reading as a tessellation.
   *
   * The warp is itself tileable, so `wu` at u = 1 is exactly `wu` at u = 0 plus
   * one and the cell grid still closes at the seam.
   */
  const wu = u + tileableFbm(BARK, u * 1.1, v * 0.4, 5, 3) * 0.115;
  const wv = v + tileableFbm(BARK, u * 0.9 + 5.3, v * 0.5, 4, 3) * 0.075;
  /**
   * Plates are TALL and COARSE. 12 cells around the trunk by 3 along each
   * texture tile — at the trunk's texel density (~1 u tile per metre of
   * circumference, 1.5 v tiles per metre of height) that is a plate roughly
   * 8 cm wide and 22 cm tall, which is oak. The old 9-cell field at 2.4 : 0.8
   * gave 5 cm cells at barely 2 : 1, i.e. scales. Both scales multiply the cell
   * count to an integer so the field still tiles.
   */
  const plate = worley(wu * 2.0, wv * 0.5, 6, 21);
  // f2 - f1 is small at a cell boundary and large in a cell interior, so it is
  // the crack mask directly. Narrow and deep: bark cracks are canyons a few
  // millimetres wide, not the wide rounded valleys between scales.
  const crack = smoothstep(0.15, 0.0, plate.f2 - plate.f1);
  // A second, much larger plate tier. Real bark is plates within plates, and
  // one scale of cell is the other half of why a single Worley tier tessellates.
  const slab = worley(wu * 0.75 + 2.7, wv * 0.25 + 1.3, 4, 77);
  const seam = smoothstep(0.20, 0.02, slab.f2 - slab.f1);
  // Vertical fibre inside each plate — ridged fbm, stretched 6 : 1 along the
  // trunk. This is what carries the *direction* of bark, and it is now the
  // dominant band rather than a garnish on the cells.
  const groove = 1 - Math.abs(tileableFbm(BARK, u * 4.0, v * 0.66, 26, 4));
  const check = smoothstep(0.62, 0.92, Math.abs(tileableFbm(BARK, u * 0.5, v * 4.4, 16, 3)) * 2.2);
  const grain = tileableFbm(BARK, u * 1.4, v * 1.0, 40, 3);
  // Per-plate height offset, so neighbouring plates stand proud of each other
  // instead of all peaking at the same level.
  const lift = ((plate.id % 617) / 617 - 0.5) * 0.20;
  const rough =
    0.68 + groove * 0.32 + lift - crack * 0.80 - seam * 0.30 - check * 0.18 + grain * 0.07;
  // Smooth bark keeps the lenticel checking and loses the fissures entirely.
  const smooth = 0.80 - check * 0.34 + grain * 0.10 - crack * 0.12 - seam * 0.10;
  return clamp(lerp(smooth, rough, roughShare), 0, 1);
}

export interface BarkMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/**
 * Baked bark maps in a warm palette.
 *
 * `dark` is the crack, `light` is the sunlit face of a plate. The albedo is
 * authored around a *mid* value on purpose: a full-range bark albedo has to be
 * lifted toward white by the material to survive a stylised sky, and lifting is
 * what bleached the old trunks to grey card.
 */
export function barkSet(
  key: string,
  dark: number,
  light: number,
  roughShare = 1,
  size = 512,
): BarkMaps {
  const h = (u: number, v: number) => barkHeight(u, v, roughShare);
  return {
    map: cached(`bark2.${key}.albedo`, () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const t = h(u, v);
          const c = mixHex(dark, light, Math.pow(t, 0.85));
          // Warm-lichen bloom on the sun-facing plate faces and a green-grey
          // moss in the cracks. Both are hue variation *within* the surface,
          // which is what ART_DIRECTION §9 asks for and what a single brown
          // ramp can never give.
          const lichen = smoothstep(0.72, 0.98, t) *
            smoothstep(0.45, 0.85, tileableFbm(BARK, u + 3.1, v * 0.6, 6, 3) * 0.5 + 0.5);
          const moss = smoothstep(0.34, 0.02, t) *
            smoothstep(0.40, 0.90, tileableFbm(BARK, u * 0.8 + 7, v * 0.5, 5, 3) * 0.5 + 0.5);
          const lc = hexToRgb(0xc9b48d);
          const mc = hexToRgb(0x53703a);
          return [
            lerp(lerp(c[0], lc[0], lichen * 0.45), mc[0], moss * 0.42),
            lerp(lerp(c[1], lc[1], lichen * 0.45), mc[1], moss * 0.42),
            lerp(lerp(c[2], lc[2], lichen * 0.45), mc[2], moss * 0.42),
          ];
        },
      }),
    ),
    // 3.2 rather than the old 4.2. The relief now comes from *shape* — warped,
    // coarse, unequal plates with a per-plate height offset — and cranking the
    // normal on top of a fine field was the other half of the embossed-scales
    // read: every cell got a hard rim light of its own.
    normalMap: cached(`bark2.${key}.normal`, () => bakeNormalMap({ size, height: h }, 3.2)),
    roughnessMap: cached(`bark2.${key}.rough`, () =>
      bakeScalarMap(256, (u, v) => clamp(0.96 - h(u, v) * 0.20, 0, 1)),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Forest-floor litter card                                            */
/* ------------------------------------------------------------------ */

/**
 * A scrap of leaf litter and twigs, drawn as an alpha-cut card that lies almost
 * flat on the ground.
 *
 * The forest floor was flat green with hard-edged texture patches. Litter is the
 * cheapest possible fix — a handful of dead leaves and a twig per card, laid
 * down at a shallow angle so it reads as debris rather than as growth, and
 * coloured from the dirt palette so it also breaks up the turf's hue.
 */
export function litterTexture(key: string, seed: number, twigs = 2): THREE.Texture {
  return cached(`litter.${key}`, () => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d')!;
    const rng = makeRng(seed);

    // Dead leaves: rounded lozenges in warm browns and tired yellow-greens.
    const leaves = 7;
    for (let i = 0; i < leaves; i++) {
      const cxp = size * (0.16 + rng() * 0.68);
      const cyp = size * (0.16 + rng() * 0.68);
      const len = size * (0.13 + rng() * 0.14);
      const wid = len * (0.42 + rng() * 0.3);
      const ang = rng() * Math.PI;
      const t = rng();
      const a = mixHex(0x7a5433, 0xc09256, t);
      const b = mixHex(0xa8763f, 0xd9b268, rng());
      const g = c.createLinearGradient(cxp - len, cyp, cxp + len, cyp);
      g.addColorStop(0, `rgb(${(a[0] * 255) | 0},${(a[1] * 255) | 0},${(a[2] * 255) | 0})`);
      g.addColorStop(1, `rgb(${(b[0] * 255) | 0},${(b[1] * 255) | 0},${(b[2] * 255) | 0})`);
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(cxp, cyp, len, wid, ang, 0, Math.PI * 2);
      c.fill();
      // Midrib, so a 6-pixel smudge still reads as a leaf and not as a stain.
      c.strokeStyle = 'rgba(94,66,38,0.55)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(cxp - Math.cos(ang) * len * 0.9, cyp - Math.sin(ang) * len * 0.9);
      c.lineTo(cxp + Math.cos(ang) * len * 0.9, cyp + Math.sin(ang) * len * 0.9);
      c.stroke();
    }

    // Twigs: two-segment polylines, tapered by stroke width.
    for (let i = 0; i < twigs; i++) {
      const x0 = size * (0.1 + rng() * 0.8);
      const y0 = size * (0.1 + rng() * 0.8);
      const ang = rng() * Math.PI * 2;
      const len = size * (0.22 + rng() * 0.3);
      const x1 = x0 + Math.cos(ang) * len;
      const y1 = y0 + Math.sin(ang) * len;
      c.strokeStyle = `rgb(${(88 + rng() * 26) | 0},${(64 + rng() * 22) | 0},${(40 + rng() * 16) | 0})`;
      c.lineCap = 'round';
      c.lineWidth = 3 + rng() * 3;
      c.beginPath();
      c.moveTo(x0, y0);
      c.quadraticCurveTo(
        (x0 + x1) * 0.5 + (rng() - 0.5) * 20,
        (y0 + y1) * 0.5 + (rng() - 0.5) * 20,
        x1,
        y1,
      );
      c.stroke();
      // One side shoot — a straight stick reads as a dropped pencil.
      c.lineWidth *= 0.55;
      c.beginPath();
      c.moveTo((x0 + x1) * 0.5, (y0 + y1) * 0.5);
      c.lineTo(
        (x0 + x1) * 0.5 + Math.cos(ang + 0.9) * len * 0.32,
        (y0 + y1) * 0.5 + Math.sin(ang + 0.9) * len * 0.32,
      );
      c.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Grass blade card texture                                            */
/* ------------------------------------------------------------------ */

/**
 * An alpha-cut clump of blades drawn into a canvas.
 *
 * Drawn with 2D paths rather than sampled from a field because a blade needs a
 * clean, continuous, sub-pixel-accurate silhouette; a thresholded noise field
 * gives ragged edges that alpha-test turns into visible crawling fringe.
 */
export function grassCardTexture(key: string, seed: number, blades = 11): THREE.Texture {
  return cached(`grasscard.${key}`, () => {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d')!;
    c.clearRect(0, 0, size, size);

    const rng = makeRng(seed);
    type Blade = { x0: number; lean: number; h: number; w: number; tint: number; z: number };
    const list: Blade[] = [];
    for (let i = 0; i < blades; i++) {
      list.push({
        x0: 0.5 + (((i + 0.5) / blades) * 2 - 1) * 0.46 + (rng() - 0.5) * 0.06,
        lean: (rng() - 0.5) * 0.62,
        h: 0.46 + rng() * 0.5,
        w: 0.030 + rng() * 0.030,
        tint: rng(),
        z: rng(),
      });
    }
    // Back-to-front so the near blades overlap cleanly.
    list.sort((a, b) => a.z - b.z);

    for (const b of list) {
      const baseX = b.x0 * size;
      const baseY = size * 0.995;
      const tipX = (b.x0 + b.lean * 0.4) * size;
      const tipY = (1 - b.h) * size;
      const ctrlX = (b.x0 + b.lean * 0.1) * size;
      const ctrlY = baseY - b.h * size * 0.62;

      // Sample the spine, then offset by a tapering half-width to build the
      // outline. A stroked line cannot taper; a filled outline can.
      const steps = 16;
      const left: [number, number][] = [];
      const right: [number, number][] = [];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const mt = 1 - t;
        const px = mt * mt * baseX + 2 * mt * t * ctrlX + t * t * tipX;
        const py = mt * mt * baseY + 2 * mt * t * ctrlY + t * t * tipY;
        const dx = 2 * mt * (ctrlX - baseX) + 2 * t * (tipX - ctrlX);
        const dy = 2 * mt * (ctrlY - baseY) + 2 * t * (tipY - ctrlY);
        const len = Math.hypot(dx, dy) || 1;
        const w = b.w * size * Math.pow(1 - t, 0.62) * (0.55 + 0.45 * Math.sin(t * Math.PI));
        left.push([px - (dy / len) * w, py + (dx / len) * w]);
        right.push([px + (dy / len) * w, py - (dx / len) * w]);
      }

      const grad = c.createLinearGradient(0, baseY, 0, tipY);
      const dark = mixHex(0x549034, 0x6ca844, b.tint);
      const lit = mixHex(0x8fcc55, 0xc2e878, b.tint);
      const bot = mixHex(0x3c6b2c, 0x527f36, b.tint);
      grad.addColorStop(0, `rgb(${(bot[0] * 255) | 0},${(bot[1] * 255) | 0},${(bot[2] * 255) | 0})`);
      grad.addColorStop(0.45, `rgb(${(dark[0] * 255) | 0},${(dark[1] * 255) | 0},${(dark[2] * 255) | 0})`);
      grad.addColorStop(1, `rgb(${(lit[0] * 255) | 0},${(lit[1] * 255) | 0},${(lit[2] * 255) | 0})`);
      c.fillStyle = grad;

      c.beginPath();
      c.moveTo(left[0][0], left[0][1]);
      for (let s = 1; s <= steps; s++) c.lineTo(left[s][0], left[s][1]);
      for (let s = steps; s >= 0; s--) c.lineTo(right[s][0], right[s][1]);
      c.closePath();
      c.fill();

      // A single lighter rib down the centre — reads as a fold, and gives the
      // blade a direction when it is only four pixels wide on screen.
      c.strokeStyle = `rgba(${(lit[0] * 255) | 0},${(lit[1] * 255) | 0},${(lit[2] * 255) | 0},0.5)`;
      c.lineWidth = Math.max(1, b.w * size * 0.5);
      c.beginPath();
      c.moveTo(baseX, baseY);
      c.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
      c.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Leaf-cluster card texture (canopy and bush fringe)                  */
/* ------------------------------------------------------------------ */

/**
 * A clump of leaves with an alpha-cut, scalloped outer edge.
 *
 * This is the texture that stops a metaball canopy reading as moss. A blob,
 * however well displaced and however well shaded, always presents a *smooth*
 * silhouette against the sky, and the eye reads a smooth green silhouette as
 * a surface rather than as foliage. Skinning the outer shell of the blob with
 * a few hundred of these cards gives the crown a broken, leafy edge — which is
 * the actual difference between "green sphere" and "tree" in every stylised
 * renderer from Wind Waker to New Horizons.
 *
 * Drawn bottom-up in a fan so the base of the card is solid (it is buried in
 * the blob) and only the top three quarters is cut away.
 */
export function leafClusterTexture(
  key: string,
  seed: number,
  leaves = 15,
  scale = 1,
): THREE.Texture {
  return cached(`leafcluster.${key}`, () => {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d')!;
    const rng = makeRng(seed);

    type Leaf = { ang: number; len: number; wid: number; tint: number; depth: number };
    const list: Leaf[] = [];
    // Short and broad, not long and thin. A fan of slender leaves reads as a
    // palm frond or a starburst the moment it is silhouetted; what is wanted is
    // a rounded pad of foliage whose *edge* happens to be scalloped.
    for (let i = 0; i < leaves; i++) {
      const t = (i + 0.5) / leaves;
      list.push({
        ang: (t * 2 - 1) * 1.34 + (rng() - 0.5) * 0.4,
        len: (0.34 + rng() * 0.3) * (0.68 + 0.32 * Math.cos((t * 2 - 1) * 1.4)) * scale,
        wid: (0.085 + rng() * 0.055) * scale,
        tint: rng(),
        depth: 0.5 + rng() * 0.5,
      });
    }
    // Two filler tiers behind the rim leaves. Without them the middle of the
    // clump is daylight, and a canopy skinned with hollow clumps sparkles.
    for (let i = 0; i < leaves; i++) {
      list.push({
        ang: (rng() * 2 - 1) * 1.5,
        len: (0.16 + rng() * 0.26) * scale,
        wid: (0.085 + rng() * 0.06) * scale,
        tint: rng() * 0.6,
        depth: rng() * 0.5,
      });
    }
    list.sort((a, b) => a.depth - b.depth);

    const baseX = size * 0.5;
    const baseY = size * 1.02;

    // Solid pad at the root of the fan. The bottom of the card is buried in the
    // blob, so it must be opaque or the alpha test cuts a hole through the
    // canopy surface the card is supposed to be growing out of.
    {
      const g = c.createLinearGradient(0, size, 0, size * 0.62);
      g.addColorStop(0, 'rgb(52,86,42)');
      g.addColorStop(1, 'rgb(84,131,58)');
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(baseX, baseY, size * 0.42, size * 0.34, 0, 0, Math.PI * 2);
      c.fill();
    }

    for (const l of list) {
      const len = l.len * size;
      const tipX = baseX + Math.sin(l.ang) * len;
      const tipY = baseY - Math.cos(l.ang) * len;
      const nx = Math.cos(l.ang);
      const ny = Math.sin(l.ang);
      const w = l.wid * size;

      // Deeper leaves are darker: the clump gets internal occlusion for free,
      // which is what makes it read as several layers rather than one decal.
      const shade = 0.74 + l.depth * 0.26;
      const g = c.createLinearGradient(baseX, baseY, tipX, tipY);
      const a = mixHex(0x3f6d2f, 0x5d9441, l.tint);
      const b = mixHex(0x8ecb56, 0xc2e87c, l.tint);
      g.addColorStop(0, `rgb(${(a[0] * 255 * shade) | 0},${(a[1] * 255 * shade) | 0},${(a[2] * 255 * shade) | 0})`);
      g.addColorStop(0.55, `rgb(${(b[0] * 210 * shade) | 0},${(b[1] * 220 * shade) | 0},${(b[2] * 200 * shade) | 0})`);
      g.addColorStop(1, `rgb(${(b[0] * 255 * shade) | 0},${(b[1] * 255 * shade) | 0},${(b[2] * 255 * shade) | 0})`);
      c.fillStyle = g;

      // Rounded lozenge: two quadratics with the control points pushed out at
      // 40% of the length, which gives a leaf that is widest below its middle.
      c.beginPath();
      c.moveTo(baseX, baseY);
      c.quadraticCurveTo(
        baseX + (tipX - baseX) * 0.38 + nx * w,
        baseY + (tipY - baseY) * 0.38 + ny * w,
        tipX,
        tipY,
      );
      c.quadraticCurveTo(
        baseX + (tipX - baseX) * 0.38 - nx * w,
        baseY + (tipY - baseY) * 0.38 - ny * w,
        baseX,
        baseY,
      );
      c.closePath();
      c.fill();

      // Midrib. At four pixels on screen this is all that says "leaf" rather
      // than "blob", and it costs one stroke.
      c.strokeStyle = `rgba(${(b[0] * 255) | 0},${(b[1] * 255) | 0},${(b[2] * 255) | 0},${0.3 + l.depth * 0.3})`;
      c.lineWidth = Math.max(1, w * 0.24);
      c.beginPath();
      c.moveTo(baseX, baseY);
      c.lineTo(tipX * 0.97 + baseX * 0.03, tipY * 0.97 + baseY * 0.03);
      c.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Small leaf-card texture (ferns, weeds, bush skirts)                 */
/* ------------------------------------------------------------------ */

/** A single broad leaf with a visible midrib, alpha-cut. */
export function leafCardTexture(key: string, seed: number): THREE.Texture {
  return cached(`leafcard.${key}`, () => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d')!;
    const rng = makeRng(seed);

    const leaves = 5;
    for (let i = 0; i < leaves; i++) {
      const t = (i + 0.5) / leaves;
      const baseX = size * 0.5;
      const baseY = size * 0.99;
      const ang = (t * 2 - 1) * 1.02 + (rng() - 0.5) * 0.2;
      const len = size * (0.5 + rng() * 0.42);
      const tipX = baseX + Math.sin(ang) * len;
      const tipY = baseY - Math.cos(ang) * len;
      const wid = size * (0.055 + rng() * 0.05);

      const g = c.createLinearGradient(baseX, baseY, tipX, tipY);
      const a = mixHex(0x4a7d33, 0x63993c, rng());
      const b = mixHex(0x86c052, 0xb4dd70, rng());
      g.addColorStop(0, `rgb(${(a[0] * 255) | 0},${(a[1] * 255) | 0},${(a[2] * 255) | 0})`);
      g.addColorStop(1, `rgb(${(b[0] * 255) | 0},${(b[1] * 255) | 0},${(b[2] * 255) | 0})`);
      c.fillStyle = g;

      c.beginPath();
      c.moveTo(baseX, baseY);
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);
      c.quadraticCurveTo(
        baseX + (tipX - baseX) * 0.45 + nx * wid,
        baseY + (tipY - baseY) * 0.45 + ny * wid,
        tipX,
        tipY,
      );
      c.quadraticCurveTo(
        baseX + (tipX - baseX) * 0.45 - nx * wid,
        baseY + (tipY - baseY) * 0.45 - ny * wid,
        baseX,
        baseY,
      );
      c.closePath();
      c.fill();

      c.strokeStyle = 'rgba(210,232,160,0.42)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(baseX, baseY);
      c.lineTo(tipX, tipY);
      c.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ */
/* Petal texture                                                       */
/* ------------------------------------------------------------------ */

/** Soft radial petal shading — a gradient plus faint veins. */
export function petalMaps(size = 256): { map: THREE.Texture; normalMap: THREE.Texture } {
  const h = (u: number, v: number) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const veins = Math.abs(Math.sin(Math.atan2(v - 0.5, u - 0.5) * 9)) * 0.25;
    return clamp(1 - r * 0.7 + veins * (1 - r) + tileableFbm(BLADE, u, v, 12, 3) * 0.1, 0, 1);
  };
  return {
    map: cached('petal.albedo', () =>
      bakeColorMap({
        size,
        color: (u, v) => {
          const r = Math.hypot(u - 0.5, v - 0.5) * 2;
          // White base; the flower's own colour arrives via instanceColor, so
          // one texture serves all four palette accents.
          const t = clamp(0.62 + (1 - r) * 0.45 + tileableFbm(BLADE, u, v, 16, 3) * 0.12, 0, 1);
          return mixHex(0xd8cfc4, 0xfdfaf2, t);
        },
      }),
    ),
    normalMap: cached('petal.normal', () => bakeNormalMap({ size: 128, height: h }, 1.1)),
  };
}

/* ------------------------------------------------------------------ */
/* Tapered tube — trunks, limbs, stems                                 */
/* ------------------------------------------------------------------ */

export interface TubeProfile {
  /** Spine control points, world/local metres. */
  spine: THREE.Vector3[];
  /** Radius at parameter t (0 = base, 1 = tip). */
  radius: (t: number) => number;
  radial: number;
  rings: number;
  /** Per-angle radius modulation — root buttresses, bark ridges. */
  lobe?: (t: number, theta: number) => number;
  /** v tiling of the bark texture along the length. */
  vScale?: number;
}

/**
 * Builds a swept tube along a Catmull-Rom spine with a varying radius and an
 * optional angular lobe function.
 *
 * A cylinder cannot be a tree: it has no root flare, no lean, no taper, and no
 * asymmetry. Everything that makes a trunk read as grown rather than extruded
 * lives in the `radius` and `lobe` callbacks, so each species can be authored
 * as two small functions instead of a mesh.
 */
export function taperedTube(p: TubeProfile): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(p.spine, false, 'catmullrom', 0.5);
  const rings = p.rings;
  const radial = p.radial;
  const vScale = p.vScale ?? 1;

  const frames = curve.computeFrenetFrames(rings, false);
  const positions = new Float32Array((rings + 1) * (radial + 1) * 3);
  const normals = new Float32Array((rings + 1) * (radial + 1) * 3);
  const uvs = new Float32Array((rings + 1) * (radial + 1) * 2);

  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const v = new THREE.Vector3();

  let w = 0;
  let wn = 0;
  let wu = 0;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    curve.getPointAt(t, P);
    const fi = Math.min(i, frames.normals.length - 1);
    N.copy(frames.normals[fi]);
    B.copy(frames.binormals[fi]);
    const r0 = p.radius(t);
    for (let j = 0; j <= radial; j++) {
      const theta = (j / radial) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const r = r0 * (p.lobe ? p.lobe(t, theta) : 1);
      v.set(0, 0, 0).addScaledVector(N, cos * r).addScaledVector(B, sin * r);
      positions[w++] = P.x + v.x;
      positions[w++] = P.y + v.y;
      positions[w++] = P.z + v.z;
      const nl = v.length() || 1;
      normals[wn++] = v.x / nl;
      normals[wn++] = v.y / nl;
      normals[wn++] = v.z / nl;
      uvs[wu++] = (j / radial) * 2.2;
      uvs[wu++] = t * vScale;
    }
  }

  const indices: number[] = [];
  const stride = radial + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Curved card — grass blades, leaf fans, petals                       */
/* ------------------------------------------------------------------ */

/**
 * A quad that bends. Flat cards read as paper the moment the camera moves off
 * axis; three segments of curvature is enough to give a blade cluster a
 * believable arc and costs six triangles.
 */
export function curvedCard(
  width: number,
  height: number,
  bend: number,
  lean: number,
  segments = 3,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Quadratic arc: vertical at the base, leaning over at the tip.
    const y = height * t;
    const z = bend * t * t;
    const x = lean * t * t;
    const w = width * 0.5 * (1 - t * 0.42);
    positions.push(-w + x, y, z, w + x, y, z);
    uvs.push(0, t, 1, t);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Vertex colour bake                                                  */
/* ------------------------------------------------------------------ */

/**
 * Bakes canopy occlusion into vertex colours and returns the matching
 * thickness per vertex.
 *
 * Two gradients multiply: distance from the cluster core (interior leaves are
 * buried) and height within the canopy (undersides see only bounce). The
 * shadow colour is cooled toward blue-green rather than darkened toward grey —
 * ART_DIRECTION §3, and it is the difference between a canopy that looks lit
 * and one that looks dirty.
 */
export function bakeCanopyShading(
  geo: THREE.BufferGeometry,
  balls: { x: number; y: number; z: number; r: number }[],
  opts: { interior?: number; underside?: number; cool?: number } = {},
): Float32Array {
  const interior = opts.interior ?? 0.62;
  const underside = opts.underside ?? 0.34;
  const cool = opts.cool ?? 0.5;

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const thick = new Float32Array(count);

  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const spanY = Math.max(1e-3, bb.max.y - bb.min.y);

  const shadeTint = hexToRgb(0x5f8f9e); // cool blue-green for the deep interior

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    // "How far outside every blob am I" — the surface of a lone blob is fully
    // exposed, a vertex sitting in the crotch between two blobs is buried.
    let depth = 0;
    for (const b of balls) {
      const d = Math.hypot(x - b.x, y - b.y, z - b.z) / b.r;
      depth += Math.max(0, 1 - d * d);
    }
    // depth ~1 on the outer shell of a single blob, >1 where blobs overlap.
    const buried = clamp((depth - 0.85) / 1.05, 0, 1);

    const up = clamp((y - bb.min.y) / spanY, 0, 1);
    const ao =
      lerp(1, 1 - interior, buried) * lerp(1 - underside, 1, smoothstep(0.05, 0.72, up));

    const coolAmt = (1 - ao) * cool;
    colors[i * 3] = lerp(ao, shadeTint[0] * ao, coolAmt);
    colors[i * 3 + 1] = lerp(ao, shadeTint[1] * ao * 1.25, coolAmt);
    colors[i * 3 + 2] = lerp(ao, shadeTint[2] * ao * 1.1, coolAmt);

    // Thin where exposed, opaque where buried; biased up because the crown is
    // where the sun actually comes through.
    thick[i] = clamp((1 - buried) * (0.55 + up * 0.45), 0, 1);
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return thick;
}
