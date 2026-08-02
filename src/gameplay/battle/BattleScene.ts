import * as THREE from 'three';
import type { GameContext } from '../../core/Context';
import { bakeColorMap, cached, mixHex, NOISE } from '../../core/TextureLab';
import { tileableFbm } from '../../core/Noise';
import { softDotTexture } from './BattleFX';

/**
 * BattleScene — the Stadium-style arena, buried at y = -120 in the same scene
 * (the LabInterior trick, one level deeper). Everything here is invisible and
 * every light disabled until a battle activates it.
 *
 * Composition: a floating elliptical stage under three theatrical lights,
 * ringed by darkness, a dusk-gradient dome, and a shimmering ring of crowd
 * lights far enough out to read as a stadium bowl without costing geometry.
 */

export const ARENA_Y = -120;
export const ARENA_CENTER = new THREE.Vector3(0, ARENA_Y, 0);
/** Creature pads, 3.5m apart. The player's mon stands south (+Z). */
export const PAD_PLAYER = new THREE.Vector3(0, ARENA_Y, 1.75);
export const PAD_WILD = new THREE.Vector3(0, ARENA_Y, -1.75);

const STAGE_RX = 5.6; // platform half-width  (x)
const STAGE_RZ = 4.4; // platform half-depth  (z)

export interface BattleArena {
  group: THREE.Group;
  setActive(v: boolean): void;
  update(dt: number, elapsed: number): void;
}

/* ------------------------------------------------------------------ */
/* Field texture                                                       */
/* ------------------------------------------------------------------ */

/**
 * The painted battlefield, baked once. Drawn in "pad space": the disc maps the
 * stage ellipse, so markings are specified in metres and scaled into uv.
 */
function fieldTexture(): THREE.Texture {
  return cached('battle.field', () =>
    bakeColorMap({
      size: 1024,
      color: (u, v) => {
        // Position in metres from stage centre.
        const x = (u - 0.5) * 2 * STAGE_RX;
        const z = (v - 0.5) * 2 * STAGE_RZ;
        const rr = Math.hypot(x / STAGE_RX, z / STAGE_RZ); // 0 centre, 1 rim

        const grain = tileableFbm(NOISE.grass, u * 3, v * 3, 14, 4) * 0.5 + 0.5;
        const mottle = tileableFbm(NOISE.soil, u * 2 + 5, v * 2 + 9, 7, 3) * 0.5 + 0.5;

        // Base: worn pitch green, darkening toward the rim.
        let col = mixHex(0x4e7c3a, 0x39602c, grain * 0.7 + rr * 0.3);

        // Centre field: packed sandy dirt inside a rounded-rect.
        const inX = Math.abs(x) / 3.4;
        const inZ = Math.abs(z) / 2.7;
        const inField = Math.max(inX, inZ);
        if (inField < 1) {
          const t = Math.min(1, (1 - inField) * 6);
          const dirt = mixHex(0xb99a68, 0x9a7c50, mottle);
          col = [
            col[0] + (dirt[0] - col[0]) * t,
            col[1] + (dirt[1] - col[1]) * t,
            col[2] + (dirt[2] - col[2]) * t,
          ];
        }

        // Painted lines, chalk-white with worn edges.
        const line = (d: number, w: number) => Math.max(0, 1 - Math.abs(d) / w);
        let chalk = 0;
        // Boundary rounded-rect at the dirt edge.
        chalk = Math.max(chalk, line(inField - 1, 0.012) * 0.9);
        // Centre line across the field.
        if (inField < 1) chalk = Math.max(chalk, line(z, 0.05) * 0.75);
        // Centre circle.
        const rc = Math.hypot(x, z);
        if (inField < 1.02) chalk = Math.max(chalk, line(rc - 1.05, 0.055) * 0.85);
        // Poke-ball dot at dead centre.
        chalk = Math.max(chalk, rc < 0.16 ? 0.85 : 0);
        // Two pad circles where the combatants stand.
        for (const pz of [1.75, -1.75]) {
          const rp = Math.hypot(x, z - pz);
          chalk = Math.max(chalk, line(rp - 0.85, 0.05) * 0.8);
        }
        if (chalk > 0) {
          const wear = 0.48 + grain * 0.42;
          const white = mixHex(0xe9e2ce, 0xc9c2ac, mottle);
          const t = Math.min(1, chalk * wear);
          col = [
            col[0] + (white[0] - col[0]) * t,
            col[1] + (white[1] - col[1]) * t,
            col[2] + (white[2] - col[2]) * t,
          ];
        }

        // Rim vignette: the stage darkens as it falls out of the light.
        const edge = Math.max(0, (rr - 0.72) / 0.28);
        const dim = 1 - edge * edge * 0.55;
        return [col[0] * dim, col[1] * dim, col[2] * dim];
      },
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Backdrop dome                                                       */
/* ------------------------------------------------------------------ */

function duskDome(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {},
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        // Deep indigo night above, a narrow warm dusk band pinned just above
        // the stage horizon, near-black below. Values are deliberately tiny:
        // the whole dome must sit stops below the lit stage so the arena
        // reads as an island of light in darkness.
        vec3 zenith = vec3(0.005, 0.007, 0.020);
        vec3 band   = vec3(0.085, 0.030, 0.042);
        vec3 floorC = vec3(0.002, 0.002, 0.005);
        float bandW = exp(-pow((h - 0.505) * 16.0, 2.0));
        vec3 c = mix(floorC, zenith, smoothstep(0.35, 0.9, h));
        c += band * bandW;
        // Faint vertical shafts, like stadium lights hitting haze.
        float a = atan(vDir.z, vDir.x);
        c += vec3(0.030, 0.026, 0.038) * pow(max(0.0, sin(a * 6.0 + 0.7)), 24.0) * bandW * 1.4;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(58, 3), mat);
  dome.name = 'BattleDome';
  dome.frustumCulled = false;
  dome.renderOrder = -999;
  return dome;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildBattleArena(ctx: GameContext): void {
  const group = new THREE.Group();
  group.name = 'BattleArena';
  group.position.copy(ARENA_CENTER);
  group.visible = false;
  ctx.scene.add(group);

  group.add(duskDome());

  /* ---- Stage ------------------------------------------------------- */
  // Top: an elliptical disc carrying the painted field.
  const top = new THREE.Mesh(
    new THREE.CircleGeometry(1, 72),
    new THREE.MeshStandardMaterial({
      map: fieldTexture(),
      roughness: 0.9,
      metalness: 0,
    }),
  );
  top.scale.set(STAGE_RX, STAGE_RZ, 1);
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.001;
  top.receiveShadow = true;
  group.add(top);

  // Body: a stepped stone drum under the field, darkening downward.
  const drumMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4c, roughness: 0.85 });
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.94, 0.7, 72), drumMat);
  drum.scale.set(STAGE_RX + 0.12, 1, STAGE_RZ + 0.12);
  drum.position.y = -0.35;
  drum.receiveShadow = true;
  group.add(drum);

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 0.86, 1.6, 72),
    new THREE.MeshStandardMaterial({ color: 0x23262f, roughness: 0.95 }),
  );
  plinth.scale.set(STAGE_RX - 0.3, 1, STAGE_RZ - 0.3);
  plinth.position.y = -1.5;
  group.add(plinth);

  // A pale kerb ring around the field edge — catches the key light and gives
  // the stage a clean bright rim against the darkness.
  const kerb = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.055, 12, 96),
    new THREE.MeshStandardMaterial({ color: 0xcfc6ae, roughness: 0.55 }),
  );
  kerb.rotation.x = Math.PI / 2;
  kerb.scale.set(STAGE_RX + 0.03, STAGE_RZ + 0.03, 1);
  kerb.position.y = 0.02;
  kerb.receiveShadow = true;
  kerb.castShadow = false;
  group.add(kerb);

  /* ---- Crowd shimmer ------------------------------------------------ */
  // Two rings of additive points far out in the dark: the impression of a
  // stadium bowl full of people without a single polygon of seating.
  const CROWD = 900;
  const crowdPos = new Float32Array(CROWD * 3);
  const crowdCol = new Float32Array(CROWD * 3);
  const crowdPhase = new Float32Array(CROWD);
  {
    // Deterministic — never Math.random.
    let s = (ctx.seed ^ 0xbeef) >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
    const warm = new THREE.Color(0xffd9a0);
    const cool = new THREE.Color(0x9fb8ff);
    const c = new THREE.Color();
    for (let i = 0; i < CROWD; i++) {
      const a = rnd() * Math.PI * 2;
      const tier = rnd();
      const r = 17 + tier * 14 + rnd() * 2.5;
      crowdPos[i * 3] = Math.cos(a) * r * 1.15;
      crowdPos[i * 3 + 1] = 1.2 + tier * 8.5 + rnd() * 1.1;
      crowdPos[i * 3 + 2] = Math.sin(a) * r;
      c.copy(rnd() < 0.6 ? warm : cool).multiplyScalar(0.35 + rnd() * 0.65);
      crowdCol[i * 3] = c.r;
      crowdCol[i * 3 + 1] = c.g;
      crowdCol[i * 3 + 2] = c.b;
      crowdPhase[i] = rnd() * Math.PI * 2;
    }
  }
  const crowdGeo = new THREE.BufferGeometry();
  crowdGeo.setAttribute('position', new THREE.BufferAttribute(crowdPos, 3));
  crowdGeo.setAttribute('color', new THREE.BufferAttribute(crowdCol, 3));
  const crowdMat = new THREE.PointsMaterial({
    size: 0.22,
    map: softDotTexture(),
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    fog: false,
  });
  const crowd = new THREE.Points(crowdGeo, crowdMat);
  crowd.frustumCulled = false;
  group.add(crowd);

  /* ---- Floodlight banks --------------------------------------------- */
  // Four glowing panels high above the bowl. Purely scenographic — the actual
  // light comes from the rig below — but they explain where it comes from.
  const floodMat = new THREE.MeshBasicMaterial({ color: 0xfff2cc, fog: false });
  floodMat.color.multiplyScalar(2.2); // over-range so bloom catches them
  const floodGeo = new THREE.PlaneGeometry(3.0, 1.3);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const mx = Math.cos(a) * 24;
    const mz = Math.sin(a) * 21;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.16, 13, 8),
      new THREE.MeshStandardMaterial({ color: 0x101724, roughness: 0.9 }),
    );
    mast.position.set(mx, 6.5, mz);
    group.add(mast);
    const panel = new THREE.Mesh(floodGeo, floodMat);
    panel.position.set(mx, 13.4, mz);
    group.add(panel);
    // Aim down at the stage centre (lookAt works in world space).
    panel.lookAt(ARENA_CENTER);
  }

  /* ---- Light rig ---------------------------------------------------- */
  const lights: THREE.Light[] = [];

  // Warm key from high south-east: models both combatants from camera side.
  const key = new THREE.SpotLight(0xffe3b8, 900, 40, 0.62, 0.45, 2);
  key.name = 'BattleKey';
  key.position.set(7.5, 12, 9);
  key.target.position.set(0, 0, -0.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 6;
  key.shadow.camera.far = 26;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  key.shadow.blurSamples = 12;
  group.add(key);
  group.add(key.target);
  lights.push(key);

  // Cool fill: soft ambient so shadows stay blue-dark, never black.
  const fill = new THREE.HemisphereLight(0x39456e, 0x191420, 1.5);
  fill.name = 'BattleFill';
  group.add(fill);
  lights.push(fill);

  // Hard rim from the north — the silhouette light. This is the one that
  // makes the wild mon read dramatic in the intro.
  const rim = new THREE.SpotLight(0xa8c4ff, 700, 40, 0.7, 0.5, 2);
  rim.name = 'BattleRim';
  rim.position.set(-4, 9, -11);
  rim.target.position.set(0, 0.4, 0.6);
  rim.castShadow = false;
  group.add(rim);
  group.add(rim.target);
  lights.push(rim);

  // Warm bounce up off the stage so undersides are not pure void.
  const bounce = new THREE.PointLight(0xc4903e, 30, 9, 2);
  bounce.name = 'BattleBounce';
  bounce.position.set(0, 1.2, 0);
  group.add(bounce);
  lights.push(bounce);

  for (const l of lights) l.visible = false;

  /* ---- Fog exemption ------------------------------------------------ */
  // The outdoor FogExp2 would wash the dome and crowd toward sky-blue.
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const fogged = m as THREE.Material & { fog?: boolean };
      if (fogged && fogged.fog) {
        fogged.fog = false;
        fogged.needsUpdate = true;
      }
    }
  });

  /* ---- Outdoor rig handles (dimmed while a battle runs) -------------- */
  const sun = ctx.scene.getObjectByName('SunKey') as THREE.DirectionalLight | null;
  const skyFill = ctx.scene.getObjectByName('SkyFill') as THREE.HemisphereLight | null;
  const groundBounce = ctx.scene.getObjectByName('GroundBounce') as THREE.DirectionalLight | null;
  // The outdoor sky dome rides the camera and the cloud billboards render on
  // top of the arena's own dome (both depthWrite: false) — hide them outright.
  const skyDome = () => ctx.scene.getObjectByName('SkyDome');
  const cloudLayer = () => ctx.scene.getObjectByName('CloudLayer');
  const orig = {
    sun: sun?.intensity ?? 0,
    skyFill: skyFill?.intensity ?? 0,
    bounce: groundBounce?.intensity ?? 0,
    env: ctx.stage.environmentIntensity,
  };

  let active = false;
  let shadowKick = 0;

  const arena: BattleArena = {
    group,
    setActive(v: boolean) {
      if (active === v) return;
      active = v;
      group.visible = v;
      for (const l of lights) l.visible = v;
      const dome = skyDome();
      const clouds = cloudLayer();
      if (dome) dome.visible = !v;
      if (clouds) clouds.visible = !v;
      if (v) {
        orig.sun = sun?.intensity ?? orig.sun;
        orig.skyFill = skyFill?.intensity ?? orig.skyFill;
        orig.bounce = groundBounce?.intensity ?? orig.bounce;
        orig.env = ctx.stage.environmentIntensity;
        if (sun) {
          sun.intensity = 0;
          sun.shadow.autoUpdate = false;
        }
        if (skyFill) skyFill.intensity = 0.06;
        if (groundBounce) groundBounce.intensity = 0;
        ctx.stage.environmentIntensity = 0.16;
        shadowKick = 5;
      } else {
        if (sun) {
          sun.intensity = orig.sun;
          sun.shadow.autoUpdate = true;
          sun.shadow.needsUpdate = true;
        }
        if (skyFill) skyFill.intensity = orig.skyFill;
        if (groundBounce) groundBounce.intensity = orig.bounce;
        ctx.stage.environmentIntensity = orig.env;
      }
    },
    update(_dt: number, elapsed: number) {
      if (!active) return;
      if (shadowKick > 0) {
        key.shadow.needsUpdate = true;
        shadowKick--;
      }
      // Crowd shimmer: slow phased twinkle. Rewriting colours would churn the
      // buffer; opacity swell plus a slow rotation is enough at this distance.
      crowdMat.opacity = 0.78 + Math.sin(elapsed * 1.7) * 0.1 + Math.sin(elapsed * 4.3 + 1.2) * 0.06;
      crowd.rotation.y = Math.sin(elapsed * 0.043) * 0.02;
    },
  };

  ctx.scene.userData.battleArena = arena;
}
