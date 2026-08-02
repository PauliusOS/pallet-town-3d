import * as THREE from 'three';
import type { GameContext } from '../core/Context';
import { EVENTS } from '../core/Context';
import { makeRng, rangeOf, clamp } from '../core/Noise';
import {
  createFoliageMaterial,
  grassCardTexture,
  curvedCard,
  mergeGeos,
  setFlex,
} from '../fx/FoliageMaterials';
import { PlayerData } from '../gameplay/battle/PlayerData';
import type { SpeciesId } from '../gameplay/battle/data';

/**
 * WildGrass — the encounter zone on the south shelf.
 *
 * Visually: waist-high blades, darker and denser than the lawn, in two lobes
 * either side of the south path so the player has to wade in deliberately.
 * Mechanically: while the player's feet are inside a lobe and moving, every
 * metre walked rolls a seeded encounter check (~one per 9m), with a cooldown
 * and a grace distance after each battle.
 */

/* The shelf: z in [19.5, 24.6], with a gap where the south path runs. */
const Z0 = 19.4;
const Z1 = 23.8;
const X_MIN = -13.5;
const X_MAX = 13.5;

/** Approximate main-path x at a given z through the shelf. */
function pathX(z: number): number {
  return 0.9 + (z - 19) * 0.08;
}

const PATH_HALF = 2.3;

/** Inside either tall-grass lobe? */
export function inWildGrass(x: number, z: number): boolean {
  if (z < Z0 || z > Z1 || x < X_MIN || x > X_MAX) return false;
  return Math.abs(x - pathX(z)) > PATH_HALF;
}

/**
 * 0 inside the tall-grass lobes (plus a buffer), ramping to 1 outside.
 * Vegetation multiplies its scatter densities by this so the encounter zone
 * reads as a deliberate clearing in front of the south treeline rather than
 * grass buried under bushes.
 */
export function wildGrassClearance(x: number, z: number, buffer = 1.1): number {
  const dz = Math.max(Z0 - z, z - Z1);
  const dxOut = Math.max(X_MIN - x, x - X_MAX);
  const dPath = PATH_HALF - Math.abs(x - pathX(z)); // > 0 inside the path corridor
  const outside = Math.max(dz, dxOut, dPath);
  return clamp(outside / buffer, 0, 1);
}

const ENCOUNTER_PER_METER = 0.115; // ~one encounter per 8.7m walked
const COOLDOWN_SECONDS = 1.2;
const GRACE_METERS = 3;

interface PlayerLike {
  state: { position: THREE.Vector3; speed: number };
}

function getPlayer(): PlayerLike | null {
  const g = (globalThis as unknown as { __GAME__?: { player?: PlayerLike } }).__GAME__;
  return g?.player ?? null;
}

export function buildWildGrass(ctx: GameContext): void {
  const group = new THREE.Group();
  group.name = 'WildGrass';
  ctx.scene.add(group);

  const ground = (x: number, z: number) => ctx.collision.groundHeight(x, z);

  /* ---------------------------------------------------------------- */
  /* Blades                                                            */
  /* ---------------------------------------------------------------- */

  // Deeper green than the lawn, heavier wind, stronger translucency: from the
  // town it should read as a distinct band of wild ground, not more lawn.
  const tex = grassCardTexture('wildgrass', ctx.seed ^ 0x7a11, 9);
  const mat = createFoliageMaterial(ctx.env, {
    color: 0xc6dc8e,
    map: tex,
    roughness: 0.82,
    windScale: 2.6,
    wrap: 0.62,
    transColor: 0xb2e858,
    transStrength: 3.2,
    transPower: 2.0,
    haloStrength: 0.22,
    alphaTest: 0.34,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
  });

  /** A tall tuft: 4-5 long curved blades. ~0.75m. */
  function tallTuft(seed: number, height: number): THREE.BufferGeometry {
    const rng = makeRng(seed);
    const cards = 5;
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < cards; i++) {
      const h = height * rangeOf(rng, 0.8, 1.22);
      const card = curvedCard(h * rangeOf(rng, 0.34, 0.5), h, rangeOf(rng, 0.12, 0.26) * h, rangeOf(rng, -0.06, 0.06) * h, 3);
      card.rotateX(rangeOf(rng, 0.06, 0.22));
      card.rotateY((i / cards) * Math.PI * 2 + rangeOf(rng, -0.4, 0.4));
      card.translate(rangeOf(rng, -0.05, 0.05), 0, rangeOf(rng, -0.05, 0.05));
      parts.push(card);
    }
    const geo = mergeGeos(parts);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const maxY = geo.boundingBox!.max.y || 1;
    // Root-to-tip shading bake (vertexColors is on in the material).
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = clamp(pos.getY(i) / maxY, 0, 1);
      const v = 0.48 + t * 0.52;
      col[i * 3] = v * 0.97;
      col[i * 3 + 1] = v;
      col[i * 3 + 2] = v * 0.82;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    setFlex(geo, (_x, y) => {
      const t = clamp(y / maxY, 0, 1);
      return [Math.pow(t, 1.4), 0.4 + t * 0.6];
    });
    geo.computeBoundingSphere();
    return geo;
  }

  const variants = [tallTuft(ctx.seed ^ 0xaa01, 0.72), tallTuft(ctx.seed ^ 0xaa02, 0.6)];

  // Scatter on a jittered grid, chunked for frustum culling.
  const CELL = 0.34;
  const CHUNK = 7;
  const cols = Math.ceil((X_MAX - X_MIN) / CHUNK);
  type Spot = { x: number; z: number };
  const chunks = new Map<number, Spot[]>();
  const rng = makeRng(ctx.seed ^ 0x9d5f);
  const nx = Math.ceil((X_MAX - X_MIN) / CELL);
  const nz = Math.ceil((Z1 - Z0) / CELL);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = X_MIN + (i + rng()) * CELL;
      const z = Z0 + (j + rng()) * CELL;
      if (!inWildGrass(x, z)) continue;
      // Feather the outer edge so the band has a broken, natural outline.
      const edge = Math.min(z - Z0, Z1 - z, x - X_MIN, X_MAX - x, Math.abs(x - pathX(z)) - PATH_HALF);
      if (rng() > clamp(edge * 2.4, 0.12, 1)) continue;
      const ci = Math.floor((x - X_MIN) / CHUNK) + cols * Math.floor((z - Z0) / CHUNK);
      let list = chunks.get(ci);
      if (!list) chunks.set(ci, (list = []));
      list.push({ x, z });
    }
  }

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const p3 = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  chunks.forEach((list, ci) => {
    const v = ci % variants.length;
    const cRng = makeRng(ctx.seed ^ (ci * 2654435761));
    const mesh = new THREE.InstancedMesh(variants[v].clone(), mat, list.length);
    const phases = new Float32Array(list.length * 2);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const sc = rangeOf(cRng, 0.72, 1.32);
      euler.set(rangeOf(cRng, -0.08, 0.08), cRng() * Math.PI * 2, rangeOf(cRng, -0.08, 0.08), 'ZYX');
      q.setFromEuler(euler);
      p3.set(s.x, ground(s.x, s.z) - 0.04, s.z);
      scl.set(sc * rangeOf(cRng, 0.85, 1.2), sc * rangeOf(cRng, 0.9, 1.25), sc);
      m4.compose(p3, q, scl);
      mesh.setMatrixAt(i, m4);
      const warm = rangeOf(cRng, -1, 1);
      col.setRGB(1 + warm * 0.08, 1 + rangeOf(cRng, -0.06, 0.06), 1 - warm * 0.12);
      mesh.setColorAt(i, col);
      phases[i * 2] = cRng() * Math.PI * 2;
      phases[i * 2 + 1] = rangeOf(cRng, 0.8, 1.3);
    }
    mesh.geometry.setAttribute('aWind', new THREE.InstancedBufferAttribute(phases, 2));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = `WildGrass_${ci}`;
    mesh.computeBoundingSphere();
    group.add(mesh);
  });

  /* ---------------------------------------------------------------- */
  /* Rustle burst                                                      */
  /* ---------------------------------------------------------------- */

  const BURST = 26;
  const burstGeo = new THREE.BufferGeometry();
  burstGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BURST * 3), 3));
  const burstMat = new THREE.PointsMaterial({
    color: 0xbcd76a,
    size: 0.055,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const burst = new THREE.Points(burstGeo, burstMat);
  burst.frustumCulled = false;
  burst.visible = false;
  group.add(burst);
  const burstDirs: THREE.Vector3[] = [];
  {
    const bRng = makeRng(ctx.seed ^ 0x5eaf);
    for (let i = 0; i < BURST; i++) {
      const a = bRng() * Math.PI * 2;
      burstDirs.push(new THREE.Vector3(Math.cos(a) * rangeOf(bRng, 0.4, 1), rangeOf(bRng, 0.8, 1.8), Math.sin(a) * rangeOf(bRng, 0.4, 1)));
    }
  }
  let burstT = -1;
  const burstOrigin = new THREE.Vector3();

  function rustle(x: number, y: number, z: number): void {
    burstOrigin.set(x, y + 0.15, z);
    burstT = 0;
    burst.visible = true;
  }

  /* ---------------------------------------------------------------- */
  /* Encounter logic                                                   */
  /* ---------------------------------------------------------------- */

  let wasInside = false;
  let walked = 0;
  let cooldown = 0;
  let grace = 0;
  let counter = 0;
  let alwaysOn = false;
  const lastPos = new THREE.Vector3(NaN, 0, NaN);

  ctx.events.on('battle:end', () => {
    cooldown = COOLDOWN_SECONDS;
    grace = GRACE_METERS;
    walked = 0;
    lastPos.set(NaN, 0, NaN);
  });

  ctx.scene.userData.wildGrassDebug = {
    setAlwaysOn: (v: boolean) => {
      alwaysOn = Boolean(v);
    },
    inZone: () => wasInside,
  };

  function rollEncounter(px: number, pz: number): void {
    counter++;
    const eRng = makeRng((ctx.seed ^ (counter * 2654435761)) >>> 0);
    const species: SpeciesId = eRng() < 0.55 ? 'pidgey' : 'rattata';
    const level = 3 + Math.floor(eRng() * 3); // 3..5
    const seed = Math.floor(eRng() * 0xffffffff) >>> 0;
    rustle(px, ctx.collision.groundHeight(px, pz), pz);
    ctx.events.emit('ui:tick');
    ctx.events.emit('battle:encounter', { species, level, seed });
  }

  ctx.tick((dt) => {
    // Rustle particle update runs even during the battle transition.
    if (burstT >= 0) {
      burstT += dt;
      const life = 0.55;
      if (burstT > life) {
        burstT = -1;
        burst.visible = false;
      } else {
        const t = burstT / life;
        const posAttr = burstGeo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < BURST; i++) {
          const d = burstDirs[i];
          posAttr.setXYZ(
            i,
            burstOrigin.x + d.x * t * 0.9,
            burstOrigin.y + d.y * t * 0.7 - t * t * 1.6,
            burstOrigin.z + d.z * t * 0.9,
          );
        }
        posAttr.needsUpdate = true;
        burstMat.opacity = 0.9 * (1 - t);
      }
    }

    if (ctx.scene.userData.battleActive) return;
    if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);

    const player = getPlayer();
    if (!player) return;
    const pos = player.state.position;
    if (pos.y < -20) {
      lastPos.set(NaN, 0, NaN);
      return; // interior / arena
    }

    const inside = inWildGrass(pos.x, pos.z);
    if (inside && !wasInside) {
      ctx.events.emit(EVENTS.ENTER_ZONE, 'tall-grass');
    }
    wasInside = inside;

    // Distance walked this frame (teleports reset the tracker).
    let step = 0;
    if (Number.isFinite(lastPos.x)) {
      step = Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z);
      if (step > 2) step = 0;
    }
    lastPos.copy(pos);

    if (!inside || step <= 0) return;
    if (grace > 0) {
      grace = Math.max(0, grace - step);
      return;
    }
    if (cooldown > 0) return;
    if (!PlayerData.hasStarter && !alwaysOn) return;

    walked += step;
    while (walked >= 1) {
      walked -= 1;
      counter++;
      const roll = makeRng((ctx.seed ^ 0xeaf00d ^ (counter * 40503)) >>> 0)();
      if (roll < ENCOUNTER_PER_METER) {
        walked = 0;
        rollEncounter(pos.x, pos.z);
        break;
      }
    }
  });
}
