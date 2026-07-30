import * as THREE from 'three';
import { bakeColorMap, bakeNormalMap, bakeScalarMap, cached, mixHex, NOISE } from '../core/TextureLab';
import { tileableFbm, worley, clamp, smoothstep } from '../core/Noise';

/**
 * Materials for the starter Pokemon and the Poke Balls.
 *
 * Creature skin is the hardest material in the project to get right. Real
 * skin is dominated by subsurface scattering, and a plain MeshStandardMaterial
 * has none — which is exactly why untreated cartoon characters read as vinyl
 * toys. The patches below add the two cues that matter most at this scale:
 * wrap-around diffuse (light bleeds past the terminator instead of stopping
 * dead at it) and a fresnel rim that picks up the sky.
 */

export interface SkinOptions {
  /** Base albedo. */
  color: number;
  /** Colour the light turns as it scatters through the surface. */
  subsurface?: number;
  /** 0..1 — how far light wraps past the terminator. */
  wrap?: number;
  /** Rim light strength. */
  rim?: number;
  roughness?: number;
  /** Adds a faint mottled pore/scale breakup. */
  detail?: 'none' | 'pores' | 'scales';
  detailScale?: number;
}

/**
 * Builds a creature-skin material.
 *
 * The shader patch runs after Three's lighting has produced `outgoingLight`,
 * adding the scattered and rim terms on top. Doing it post-hoc rather than
 * replacing the BRDF keeps shadows, the environment map and tone mapping all
 * working exactly as they do everywhere else in the scene.
 */
export function creatureSkin(opts: SkinOptions): THREE.MeshPhysicalMaterial {
  const {
    color,
    subsurface = 0xff8a6a,
    wrap = 0.55,
    rim = 0.4,
    roughness = 0.52,
    detail = 'pores',
    detailScale = 6,
  } = opts;

  const mat = new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness: 0,
    // A whisper of clearcoat gives the soft waxy sheen that reads as "living
    // surface" rather than "matte plastic". Too much and it becomes a bath toy.
    clearcoat: 0.28,
    clearcoatRoughness: 0.62,
    sheen: 0.35,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(subsurface).multiplyScalar(0.5),
  });

  if (detail !== 'none') {
    mat.normalMap = creatureDetailNormal(detail, detailScale);
    mat.normalScale = new THREE.Vector2(0.32, 0.32);
    mat.roughnessMap = cached(`skin.rough.${detail}`, () =>
      bakeScalarMap(512, (u, v) => 0.42 + (tileableFbm(NOISE.fabric, u, v, 22, 3) * 0.5 + 0.5) * 0.3),
    );
  }

  const sub = new THREE.Color(subsurface);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSubsurface = { value: sub };
    shader.uniforms.uWrap = { value: wrap };
    shader.uniforms.uRim = { value: rim };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform vec3  uSubsurface;
        uniform float uWrap;
        uniform float uRim;
        `,
      )
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `
        {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(vViewPosition);

          // --- Wrapped diffuse -----------------------------------------
          // Re-evaluate the key light with a wrapped N.L so the terminator
          // softens and picks up the scatter colour, the way light bleeding
          // through an ear or a cheek behaves.
          //
          // Only light 0 contributes. Scattering is dominated by the brightest
          // source, and summing every light double-counts the fill into a
          // washed-out glow — the classic mistake with fake subsurface.
          vec3 scatter = vec3(0.0);
          #if ( NUM_DIR_LIGHTS > 0 )
            vec3  ssL       = normalize(directionalLights[0].direction);
            float ssNdl     = dot(N, ssL);
            float ssWrapped = max(0.0, (ssNdl + uWrap) / (1.0 + uWrap));
            float ssDirect  = max(0.0, ssNdl);
            // Only the light that wraps PAST the terminator is scatter.
            scatter = directionalLights[0].color * uSubsurface *
                      max(0.0, ssWrapped - ssDirect) * 1.35;
          #endif

          // --- Fresnel rim ---------------------------------------------
          // Picks up the sky, which separates the silhouette from the
          // background without a cartoon outline pass.
          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.2);
          vec3 rimColor = mix(vec3(0.72, 0.86, 1.0), uSubsurface, 0.35);

          // Both terms are additive, so they must be bounded. Unclamped they
          // pushed pale surfaces (Squirtle's cream plastron, the sclera) past
          // white under a warm interior key, which flattened them into
          // featureless discs and fed the bloom pass. Capping the added energy
          // keeps the scatter readable as shading rather than as glow.
          vec3 added = scatter * diffuseColor.rgb + rimColor * fres * uRim;
          added = min(added, vec3(0.35));
          gl_FragColor.rgb += added;
        }
        #include <dithering_fragment>
        `,
      );
  };

  // Distinct key so materials with different patches never share a program.
  mat.customProgramCacheKey = () => `skin|${wrap}|${rim}|${detail}`;

  return mat;
}

/** Fine pore / scale breakup so skin is never a perfectly smooth surface. */
export function creatureDetailNormal(kind: 'pores' | 'scales', scale: number): THREE.Texture {
  return cached(`skin.normal.${kind}.${scale}`, () =>
    bakeNormalMap(
      {
        size: 512,
        height: (u, v) => {
          if (kind === 'scales') {
            const w = worley(u, v, Math.round(scale * 4), 7);
            return clamp(0.5 + smoothstep(0.0, 0.22, w.f2 - w.f1) * 0.5, 0, 1);
          }
          const fine = tileableFbm(NOISE.fabric, u, v, scale * 12, 3);
          const pore = worley(u, v, Math.round(scale * 8), 3);
          return clamp(0.55 + fine * 0.28 - smoothstep(0.18, 0.0, pore.f1) * 0.3, 0, 1);
        },
      },
      1.1,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Eyes                                                                */
/* ------------------------------------------------------------------ */

export interface EyeOptions {
  radius: number;
  irisColor: number;
  pupilColor?: number;
  /** Fraction of the eyeball the iris covers. Bigger = cuter. */
  irisScale?: number;
  /** Adds the crescent lower-lid catchlight that reads as friendly. */
  catchlight?: boolean;
}

/**
 * Builds an eye.
 *
 * Appeal in a cartoon character lives almost entirely in the eyes, and two
 * details decide whether they read as a face or as googly eyes glued to a ball.
 *
 * The first is the **limbal ring**: a hard dark band around the iris. Without
 * it, a bright key light plus any bloom washes the iris and pupil out to a
 * blank white disc — which is exactly what happened in the warmly-lit lab, where
 * every character went blank-eyed while looking fine under studio lighting. The
 * ring is drawn with an unlit material so no amount of exposure can lift it.
 *
 * The second is the **catchlight**: a small bright bead sitting proud of the
 * cornea. Painting it into a texture makes it static and dead; real geometry
 * catches the light and travels as the head turns.
 *
 * The eyeball's own specular is deliberately restrained. A full clearcoat at
 * near-zero roughness produces a pinpoint highlight so intense it blooms into a
 * white blob that swallows the whole iris.
 */
export function makeEye(opts: EyeOptions): THREE.Group {
  const { radius, irisColor, pupilColor = 0x120f0e, irisScale = 0.66, catchlight = true } = opts;
  const g = new THREE.Group();
  g.name = 'Eye';

  const sclera = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 20),
    new THREE.MeshPhysicalMaterial({
      // Slightly off-white and a touch rougher, so the sclera does not clip.
      color: 0xf2ece4,
      roughness: 0.34,
      clearcoat: 0.5,
      clearcoatRoughness: 0.18,
    }),
  );
  g.add(sclera);

  // Iris, limbal ring and pupil are shallow spherical caps sitting just proud
  // of the sclera, so they curve with the eyeball instead of floating as decals.
  const irisR = radius * irisScale;
  const capAngle = (r: number) => Math.asin(clamp(r / radius, 0, 1));

  // Limbal ring first, very slightly larger than the iris, unlit so it holds.
  const limbal = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.004, 28, 18, 0, Math.PI * 2, 0, capAngle(irisR * 1.1)),
    new THREE.MeshBasicMaterial({ color: 0x1b1412 }),
  );
  limbal.rotation.x = Math.PI / 2;
  g.add(limbal);

  // The iris is unlit too. A lit iris loses its hue the moment the key light is
  // strong, and hue is the only thing distinguishing these three characters'
  // eyes from each other.
  const iris = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.008, 24, 18, 0, Math.PI * 2, 0, capAngle(irisR)),
    new THREE.MeshBasicMaterial({ color: irisColor }),
  );
  iris.rotation.x = Math.PI / 2;
  g.add(iris);

  const pupilR = irisR * 0.52;
  const pupil = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.014, 20, 14, 0, Math.PI * 2, 0, capAngle(pupilR)),
    new THREE.MeshBasicMaterial({ color: pupilColor }),
  );
  pupil.rotation.x = Math.PI / 2;
  g.add(pupil);

  // Primary catchlight, offset up-left as in every animated character since the
  // 1930s. Unlit so it survives shadow, but kept small and just under pure
  // white — at full white and larger it was the brightest thing in frame and
  // bloomed across the whole eye.
  const hi = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.15, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xf6f8fb }),
  );
  hi.position.set(-radius * 0.32, radius * 0.34, radius * 0.94);
  g.add(hi);

  if (catchlight) {
    // Secondary bounce light, lower-right, dimmer — implies a sky above and
    // a bright ground below.
    const hi2 = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.085, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xcfe0f5, transparent: true, opacity: 0.6 }),
    );
    hi2.position.set(radius * 0.32, -radius * 0.28, radius * 0.94);
    g.add(hi2);
  }

  g.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });

  return g;
}

/* ------------------------------------------------------------------ */
/* Poke Ball materials                                                 */
/* ------------------------------------------------------------------ */

/** Glossy injection-moulded shell, with a faint orange-peel normal. */
export function pokeBallShell(color: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.18,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    normalMap: cached('ball.orangepeel', () =>
      bakeNormalMap(
        {
          size: 256,
          height: (u, v) => 0.5 + tileableFbm(NOISE.paint, u, v, 90, 3) * 0.5,
        },
        0.35,
      ),
    ),
    normalScale: new THREE.Vector2(0.12, 0.12),
  });
}

/** Brushed metal for the equatorial band and the button bezel. */
export function pokeBallMetal(color = 0x2a2724): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.32,
    metalness: 0.92,
    roughnessMap: cached('ball.brushed', () =>
      bakeScalarMap(256, (u, v) => 0.24 + (tileableFbm(NOISE.stone, u * 0.06, v * 8, 60, 2) * 0.5 + 0.5) * 0.22),
    ),
  });
}

/** Painted spot / patch texture used for Bulbasaur's markings. */
export function spottedSkin(base: number, spot: number, cells = 7): THREE.Texture {
  return cached(`skin.spots.${base}.${spot}.${cells}`, () =>
    bakeColorMap({
      size: 512,
      color: (u, v) => {
        const w = worley(u, v, cells, 19);
        // Only some cells become spots, and their edges are soft and uneven.
        const isSpot = (w.id % 100) / 100 < 0.42;
        const warp = tileableFbm(NOISE.paint, u, v, 9, 3) * 0.09;
        const edge = smoothstep(0.34, 0.16, w.f1 + warp);
        return mixHex(base, spot, isSpot ? edge : 0);
      },
    }),
  );
}
