import * as THREE from 'three';
import { EVENTS, type GameContext } from '../core/Context';
import { makeRng, rangeOf, pick, clamp, lerp } from '../core/Noise';
import { roundedBox } from '../fx/Sculpt';
import {
  labFloorMaps,
  labPlasterMaps,
  beadboardMaps,
  hardwoodMaps,
  paintedTrimMaps,
  brushedMetalMaps,
  wovenMaps,
  bookSpineMaps,
  paperMaps,
  terracottaMaps,
  potSoilMaps,
  leafMaps,
  terminalScreenTexture,
  whiteboardTexture,
  nameplateTexture,
  windowBackdropTexture,
  shaftTexture,
  glowTexture,
  contactTexture,
  interiorMaterial,
  interiorPhysical,
  mergeGeos,
  place,
  worldUV,
  shiftUV,
  tintGeo,
} from '../fx/LabMaterials';

/**
 * Oak's Laboratory — interior.
 *
 * ## Where the room lives
 *
 * The room is built 60 m below the town rather than inside the lab shell. That
 * removes every hard problem at once: no portal rendering, no interior/exterior
 * geometry fighting for the same cubic metres, no need to punch a hole in the
 * building the Buildings pass owns, and no chance of the outdoor sun leaking
 * through a seam. The player is teleported down through a fade, the outdoor
 * rig is dimmed, and `collision.groundHeight` is wrapped so the floor of the
 * room is the ground plane while you are inside its footprint.
 *
 * ## Lighting
 *
 * ART_DIRECTION §4 gives Atmosphere sole ownership of lights, with one stated
 * exception: an interior cannot be lit by a directional sun, so the three
 * fixtures in here are ours. They are switched off (and their shadow map
 * frozen) whenever the player is outside, so the cost outdoors is exactly zero.
 * The rig is a hero spot over the starter table, two warm fills, and a lot of
 * emissive geometry — the emissives do most of the *looking* expensive, the
 * three real lights do the shading.
 *
 * ## Ownership
 *
 * This module builds the room, the table and the pedestals. It does **not**
 * build the Poké Balls or the choice logic; it publishes
 * `scene.userData.starterAnchors` (left / centre / right) and
 * `scene.userData.labCenter` for the gameplay pass that does.
 */

/* ------------------------------------------------------------------ */
/* Room metrics                                                        */
/* ------------------------------------------------------------------ */

/** Floor plane of the interior, in world space. */
const FLOOR_Y = -60;

/** Inner faces of the room. */
const IX = 7.0;
const IZ0 = -18.4; // north
const IZ1 = -6.6; // south
const H = 3.7; // floor to ceiling
const WT = 0.36; // wall thickness

const OX = IX + WT;
const OZ0 = IZ0 - WT;
const OZ1 = IZ1 + WT;

const DOOR_X = 0.2;
const DOOR_W = 1.8;
const DOOR_H = 2.5;

/** Sill / head of the side-wall windows. */
const WIN_LO = 1.15;
const WIN_HI = 2.55;
const WIN_Z = [-15.4, -9.6];
const WIN_HW = 0.75;

/** Starter table. */
const TABLE_Z = -13.4;
const TABLE_TOP = 0.925; // centre of the slab
const TABLE_SLAB = 0.095;
const TOP_SURFACE = TABLE_TOP + TABLE_SLAB / 2;

const Y = (v: number) => FLOOR_Y + v;

/* ------------------------------------------------------------------ */
/* Small geometry helpers                                              */
/* ------------------------------------------------------------------ */

/** Rounded box with the fillet clamped so thin plates never invert. */
function bx(w: number, h: number, d: number, r = 0.035, seg = 3): THREE.BufferGeometry {
  return roundedBox(w, h, d, Math.min(r, Math.min(w, h, d) * 0.44), seg);
}

function cyl(rt: number, rb: number, h: number, seg = 16, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
}

function lathe(pts: [number, number][], seg = 20): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    pts.map(([x, y]) => new THREE.Vector2(Math.max(x, 1e-4), y)),
    seg,
  );
}

interface PlayerLike {
  teleport(pos: THREE.Vector3, yaw?: number): void;
  state: { position: THREE.Vector3; yaw: number };
}

function getPlayer(): PlayerLike | null {
  const g = (globalThis as unknown as { __GAME__?: { player?: PlayerLike } }).__GAME__;
  return g?.player ?? null;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildLabInterior(ctx: GameContext): void {
  const rng = makeRng(ctx.seed ^ 0x1ab1);

  const root = new THREE.Group();
  root.name = 'LabInterior';
  root.visible = false;
  ctx.scene.add(root);

  /* ---------------- materials ---------------------------------------- */

  const matFloor = interiorPhysical('lab.floor', labFloorMaps(), {
    // Waxed, not lacquered: a high clearcoat with enough roughness that the
    // pendant smears into a long streak instead of a mirror dot.
    clearcoat: 0.85,
    clearcoatRoughness: 0.19,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.9,
  });
  // The plaster and the ceiling carry a whisper of warm emissive. It is not a
  // light — it is the bounce term a room this size would have and that three
  // downward cones cannot produce, and without it the upper half of every wall
  // falls to a cold grey that fights the whole "warm and cosy" brief.
  const matPlaster = interiorMaterial('lab.wall', labPlasterMaps('wall', 0xefe6d2), {
    roughness: 1,
    metalness: 0,
    emissive: 0xffd9a8,
    emissiveIntensity: 0.055,
    envMapIntensity: 1.1,
  });
  const matCeiling = interiorMaterial('lab.ceil', labPlasterMaps('ceil', 0xf3e7cf), {
    roughness: 1,
    metalness: 0,
    emissive: 0xffd6a0,
    emissiveIntensity: 0.1,
    envMapIntensity: 0.9,
  });
  const matBead = interiorMaterial('lab.bead', beadboardMaps('lab', 0x9fbcd6), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 1.2,
  });
  const matTrim = interiorMaterial('lab.trim', paintedTrimMaps('warm', 0xfaf3e4), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 1.2,
  });
  const matWoodDark = interiorMaterial('lab.walnut', hardwoodMaps('walnut', 0x6b4c33, 0xa07a58, 1), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 1.3,
  });
  const matWoodLight = interiorMaterial('lab.oak', hardwoodMaps('oak', 0x82603f, 0xb08d68, 0.5), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 1.1,
  });
  const matMetal = interiorMaterial('lab.steel', brushedMetalMaps(), {
    roughness: 1,
    metalness: 0.92,
    envMapIntensity: 2.0,
  });
  const matBrass = interiorMaterial('lab.brass', brushedMetalMaps(), {
    color: 0xd8ad63,
    roughness: 1,
    metalness: 0.95,
    envMapIntensity: 2.4,
  });
  const matEnamel = interiorPhysical('lab.enamel', paintedTrimMaps('blue', 0x4a86c4), {
    roughness: 1,
    metalness: 0,
    clearcoat: 0.5,
    clearcoatRoughness: 0.2,
    side: THREE.DoubleSide,
    envMapIntensity: 1.4,
  });
  const matCounter = interiorPhysical('lab.counter', labPlasterMaps('counter', 0xdfe3e0), {
    roughness: 0.34,
    metalness: 0,
    clearcoat: 0.45,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.4,
  });
  const matRug = interiorMaterial('lab.rug', wovenMaps('rug', 0xb4573f, 0xe6d2ae, 80), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.7,
  });
  const matRugTrim = interiorMaterial('lab.rugtrim', wovenMaps('rugtrim', 0x3f5f4a, 0xd8c79c, 70), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.7,
  });
  const matBook = interiorMaterial('lab.book', bookSpineMaps(), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.8,
  });
  // Knocked down from paper-white: under the hero spot an 0.9-albedo sheet
  // clips to flat white and reads as a hole in the frame.
  const matPaper = interiorMaterial('lab.paper', paperMaps(), {
    color: 0xd2ccbd,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.9,
  });
  const matPot = interiorMaterial('lab.pot', terracottaMaps(), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 1.0,
  });
  const matSoil = interiorMaterial('lab.soil', potSoilMaps(), { roughness: 1, metalness: 0 });
  const matLeaf = interiorMaterial('lab.leaf', leafMaps(), {
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    envMapIntensity: 1.0,
  });
  const matLabel = interiorPhysical('lab.label', paintedTrimMaps('label', 0xbcae92), {
    roughness: 0.42,
    metalness: 0,
    clearcoat: 0.5,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.4,
  });

  // The engraved faces of the three nameplates, atlassed side by side.
  const plateTex = nameplateTexture();
  const matPlateFace = new THREE.MeshPhysicalMaterial({
    map: plateTex,
    roughness: 0.36,
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.16,
    envMapIntensity: 1.3,
  });
  matPlateFace.name = 'lab.plateface';

  // Deep navy felt: the cradles have to separate the ball from the walnut top
  // without going black, and a woven map at this scale reads as pile.
  const matFelt = interiorMaterial('lab.felt', wovenMaps('felt', 0x2f4f74, 0x4a739c, 150), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.7,
  });
  const matRubber = interiorMaterial('lab.rubber', paintedTrimMaps('rubber', 0x2b2723), {
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.6,
  });

  const boardTex = whiteboardTexture();
  const matBoard = interiorPhysical('lab.board', null, {
    map: boardTex,
    color: 0xdfd9cd,
    roughness: 0.32,
    metalness: 0,
    clearcoat: 0.45,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.1,
  });

  const screenTex = terminalScreenTexture();
  screenTex.repeat.set(1, 1);
  const matScreen = new THREE.MeshStandardMaterial({
    map: screenTex,
    emissiveMap: screenTex,
    emissive: 0xffffff,
    emissiveIntensity: 2.1,
    color: 0x0a1420,
    roughness: 0.24,
    metalness: 0,
  });
  matScreen.name = 'lab.screen';

  const matGlass = interiorPhysical('lab.glass', null, {
    color: 0xf2fbff,
    transmission: 0.96,
    thickness: 0.03,
    ior: 1.5,
    roughness: 0.055,
    metalness: 0,
    side: THREE.DoubleSide,
    envMapIntensity: 2.2,
  });
  const matLiquid = interiorPhysical('lab.liquid', null, {
    vertexColors: true,
    transmission: 0.82,
    thickness: 0.16,
    ior: 1.34,
    roughness: 0.1,
    metalness: 0,
    attenuationDistance: 0.5,
    envMapIntensity: 1.4,
  });

  const matWinGlass = interiorPhysical('lab.wglass', null, {
    color: 0xdff0ff,
    roughness: 0.1,
    metalness: 0,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    envMapIntensity: 2.4,
  });

  const backdropTex = windowBackdropTexture();
  const matBackdrop = new THREE.MeshBasicMaterial({
    map: backdropTex,
    side: THREE.DoubleSide,
    toneMapped: true,
    fog: false,
  });
  matBackdrop.color.setRGB(2.35, 2.4, 2.5);

  const matPanel = new THREE.MeshStandardMaterial({
    color: 0x3a3630,
    emissive: 0xffe9c0,
    emissiveIntensity: 2.2,
    roughness: 0.45,
    metalness: 0,
  });
  const matBulb = new THREE.MeshStandardMaterial({
    color: 0x4a4034,
    emissive: 0xffd79a,
    emissiveIntensity: 5.2,
    roughness: 0.4,
    metalness: 0,
  });
  const matShelfGlow = new THREE.MeshStandardMaterial({
    color: 0x3a3630,
    emissive: 0xffdca6,
    emissiveIntensity: 0.95,
    roughness: 0.5,
    metalness: 0,
  });
  const matCaseGlow = new THREE.MeshStandardMaterial({
    color: 0x4a423a,
    emissive: 0xffe6bc,
    emissiveIntensity: 1.5,
    roughness: 0.5,
    metalness: 0,
  });
  // The vitrine sits directly behind the starter table, so its interior is the
  // backdrop of the hero shot: it gets a lit lining of its own. A papered
  // lining rather than flat paint — this surface is 3 m from the camera in the
  // beauty shot and an untextured field there is instantly readable as one.
  const matCaseBack = interiorMaterial('lab.caseback', wovenMaps('caseback', 0x7a5f43, 0xa9885f, 190), {
    color: 0xbba98c,
    emissive: 0xffd9a0,
    emissiveIntensity: 0.12,
    roughness: 0.86,
    metalness: 0,
    envMapIntensity: 0.5,
  });

  // Contact occlusion decals. Only the pendant casts a real shadow map, so the
  // "this object is standing on the floor" cue (ART_DIRECTION §9) is painted:
  // one multiply-blended quad per footprint, merged into one draw call.
  const matContact = new THREE.MeshBasicMaterial({
    map: contactTexture(),
    transparent: true,
    blending: THREE.MultiplyBlending,
    // three only wires up the ZERO/SRC_COLOR blend func on the premultiplied
    // path; without this flag it logs an error per draw and leaves whatever
    // blend state the previous material set, so the decals render as opaque
    // grey patches.
    premultipliedAlpha: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    opacity: 0.85,
  });

  const matShaft = new THREE.MeshBasicMaterial({
    map: shaftTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.2,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
  });
  const matGlow = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.34,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
  });
  const matCeilGlow = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: 0xffd9a2,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.42,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
  });
  // The three starter daises sit directly under the hero spot. On the shared
  // white counter stone (0xdfe3e0, clearcoat 0.45) they clipped to flat white
  // and lost every trace of material — no bevel, no texture, no edge. A warmer,
  // duller, darker stone with a whisper of its own emissive reads as a lit
  // display stand at the same brightness rank without ever reaching 1.0.
  const matDais = interiorPhysical('lab.dais', labPlasterMaps('dais', 0xc9b697), {
    color: 0xd8c6a6,
    roughness: 0.58,
    metalness: 0,
    clearcoat: 0.22,
    clearcoatRoughness: 0.4,
    emissive: 0xffcf96,
    emissiveIntensity: 0.09,
    envMapIntensity: 0.8,
  });
  // Its light pool, likewise: additive white over a white dais was most of the
  // clipping. Warm, weak, and small enough to stay inside the stone.
  const matDaisGlow = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: 0xffc98a,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.15,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
  });
  const matScreenGlow = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    color: 0x8ad8e0,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.34,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true,
  });

  /* ---------------- geometry buckets --------------------------------- */

  const B = {
    plaster: [] as THREE.BufferGeometry[],
    ceiling: [] as THREE.BufferGeometry[],
    bead: [] as THREE.BufferGeometry[],
    trim: [] as THREE.BufferGeometry[],
    walnut: [] as THREE.BufferGeometry[],
    oak: [] as THREE.BufferGeometry[],
    steel: [] as THREE.BufferGeometry[],
    brass: [] as THREE.BufferGeometry[],
    enamel: [] as THREE.BufferGeometry[],
    counter: [] as THREE.BufferGeometry[],
    dais: [] as THREE.BufferGeometry[],
    paper: [] as THREE.BufferGeometry[],
    pot: [] as THREE.BufferGeometry[],
    soil: [] as THREE.BufferGeometry[],
    leaf: [] as THREE.BufferGeometry[],
    rubber: [] as THREE.BufferGeometry[],
    felt: [] as THREE.BufferGeometry[],
    plateFace: [] as THREE.BufferGeometry[],
    contact: [] as THREE.BufferGeometry[],
    glass: [] as THREE.BufferGeometry[],
    liquid: [] as THREE.BufferGeometry[],
    winGlass: [] as THREE.BufferGeometry[],
    backdrop: [] as THREE.BufferGeometry[],
    panel: [] as THREE.BufferGeometry[],
    bulb: [] as THREE.BufferGeometry[],
    shelfGlow: [] as THREE.BufferGeometry[],
    label: [] as THREE.BufferGeometry[],
    caseGlow: [] as THREE.BufferGeometry[],
    caseBack: [] as THREE.BufferGeometry[],
  };

  /* ================================================================== */
  /* SHELL                                                              */
  /* ================================================================== */

  // ---- floor ---------------------------------------------------------
  {
    const g = new THREE.PlaneGeometry(OX * 2, OZ1 - OZ0);
    g.rotateX(-Math.PI / 2);
    place(g, 0, Y(0), (OZ0 + OZ1) / 2);
    worldUV(g, 1 / 1.6);
    const m = new THREE.Mesh(g, matFloor);
    m.name = 'LabFloor';
    m.receiveShadow = true;
    root.add(m);
  }

  /**
   * Paints a soft occlusion pool on the floor under a footprint.
   *
   * `pad` is how far the darkening spreads beyond the object; the texture's
   * falloff means the quad has to be noticeably larger than the object or the
   * shadow reads as a hard rectangle.
   */
  function contact(cx: number, cz: number, hx: number, hz: number, pad = 0.34, rot = 0): void {
    const g = new THREE.PlaneGeometry((hx + pad) * 2, (hz + pad) * 2);
    g.rotateX(-Math.PI / 2);
    if (rot) g.rotateY(rot);
    g.translate(cx, Y(0.014), cz);
    B.contact.push(g);
  }

  // ---- ceiling -------------------------------------------------------
  {
    const g = new THREE.PlaneGeometry(OX * 2, OZ1 - OZ0);
    g.rotateX(Math.PI / 2);
    place(g, 0, Y(H), (OZ0 + OZ1) / 2);
    worldUV(g, 0.9);
    B.ceiling.push(g);
  }

  // ---- walls ---------------------------------------------------------
  const wall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = bx(w, h, d, 0.05, 3);
    place(g, x, y, z);
    worldUV(g, 1.0);
    B.plaster.push(g);
  };

  // north
  wall(OX * 2, H, WT, 0, Y(H / 2), IZ0 - WT / 2);
  // south: two returns plus a header over the doorway
  const dL = DOOR_X - DOOR_W / 2;
  const dR = DOOR_X + DOOR_W / 2;
  wall(dL + OX, H, WT, (-OX + dL) / 2, Y(H / 2), IZ1 + WT / 2);
  wall(OX - dR, H, WT, (dR + OX) / 2, Y(H / 2), IZ1 + WT / 2);
  wall(DOOR_W, H - DOOR_H, WT, DOOR_X, Y((DOOR_H + H) / 2), IZ1 + WT / 2);

  // east / west: sill band, head band, and the piers between windows
  const zLen = OZ1 - OZ0;
  const zMid = (OZ0 + OZ1) / 2;
  for (const sx of [-1, 1]) {
    const x = sx * (IX + WT / 2);
    wall(WT, WIN_LO, zLen, x, Y(WIN_LO / 2), zMid);
    wall(WT, H - WIN_HI, zLen, x, Y((WIN_HI + H) / 2), zMid);
    const cuts = [OZ0, WIN_Z[0] - WIN_HW, WIN_Z[0] + WIN_HW, WIN_Z[1] - WIN_HW, WIN_Z[1] + WIN_HW, OZ1];
    for (let i = 0; i < cuts.length; i += 2) {
      const a = cuts[i];
      const b = cuts[i + 1];
      wall(WT, WIN_HI - WIN_LO, b - a, x, Y((WIN_LO + WIN_HI) / 2), (a + b) / 2);
    }
  }

  // ---- wainscot, skirting, chair rail, cornice ------------------------
  const runs: { w: number; d: number; x: number; z: number }[] = [
    { w: IX * 2, d: 0, x: 0, z: IZ0 }, // north
    { w: IX * 2, d: 0, x: 0, z: IZ1 }, // south
    { w: 0, d: IZ1 - IZ0, x: -IX, z: (IZ0 + IZ1) / 2 },
    { w: 0, d: IZ1 - IZ0, x: IX, z: (IZ0 + IZ1) / 2 },
  ];
  for (const r of runs) {
    const horiz = r.w > 0;
    const sign = horiz ? (r.z < -12.5 ? 1 : -1) : r.x < 0 ? 1 : -1;
    const len = horiz ? r.w : r.d;
    const put = (bucket: THREE.BufferGeometry[], thick: number, height: number, yy: number) => {
      const g = horiz
        ? bx(len, height, thick, 0.018, 2)
        : bx(thick, height, len, 0.018, 2);
      const off = (thick / 2) * sign;
      place(g, r.x + (horiz ? 0 : off), Y(yy), r.z + (horiz ? off : 0));
      worldUV(g, 1);
      bucket.push(g);
    };
    // beadboard dado
    put(B.bead, 0.035, 0.885, 0.6125);
    // skirting
    put(B.trim, 0.055, 0.17, 0.085);
    // chair rail
    put(B.trim, 0.075, 0.09, 1.10);
    // stepped cornice
    put(B.trim, 0.11, 0.10, H - 0.22);
    put(B.trim, 0.055, 0.14, H - 0.075);
  }

  // ---- ceiling beams --------------------------------------------------
  for (const bz of [-7.8, -10.4, -13.0, -15.6, -18.2]) {
    const g = bx(IX * 2 + 0.1, 0.26, 0.22, 0.035, 3);
    place(g, 0, Y(H - 0.13), bz);
    worldUV(g, 1);
    B.oak.push(g);
    // corbels where each beam lands on the wall
    for (const sx of [-1, 1]) {
      const c = bx(0.16, 0.34, 0.3, 0.05, 3);
      place(c, sx * (IX - 0.08), Y(H - 0.4), bz);
      worldUV(c, 1);
      B.oak.push(c);
    }
  }

  /* ================================================================== */
  /* WINDOWS + DOOR                                                     */
  /* ================================================================== */

  for (const sx of [-1, 1]) {
    for (const wz of WIN_Z) {
      const xInner = sx * IX;
      const xMid = sx * (IX + WT / 2);
      const xOuter = sx * (IX + WT);
      const cy = Y((WIN_LO + WIN_HI) / 2);
      const hh = (WIN_HI - WIN_LO) / 2;

      // reveal lining
      for (const [w, h, z, y] of [
        [WT + 0.06, 0.07, wz, WIN_LO - 0.02],
        [WT + 0.06, 0.07, wz, WIN_HI + 0.02],
      ] as const) {
        const g = bx(w, h, WIN_HW * 2 + 0.16, 0.02, 2);
        place(g, xMid, Y(y), z);
        worldUV(g, 1);
        B.trim.push(g);
      }
      for (const s of [-1, 1]) {
        const g = bx(WT + 0.06, WIN_HI - WIN_LO + 0.14, 0.08, 0.02, 2);
        place(g, xMid, cy, wz + s * (WIN_HW + 0.04));
        worldUV(g, 1);
        B.trim.push(g);
      }
      // proud sill on the inside
      {
        const g = bx(0.2, 0.07, WIN_HW * 2 + 0.34, 0.025, 3);
        place(g, sx * (IX - 0.07), Y(WIN_LO - 0.06), wz);
        worldUV(g, 1);
        B.oak.push(g);
      }
      // mullion + transom
      {
        const g = bx(0.06, WIN_HI - WIN_LO, 0.055, 0.02, 2);
        place(g, xMid, cy, wz);
        worldUV(g, 1);
        B.trim.push(g);
        const t = bx(0.06, 0.05, WIN_HW * 2, 0.018, 2);
        place(t, xMid, Y(WIN_HI - 0.44), wz);
        worldUV(t, 1);
        B.trim.push(t);
      }
      // glazing
      {
        const g = new THREE.PlaneGeometry(WIN_HW * 2, hh * 2);
        g.rotateY((sx * Math.PI) / 2);
        place(g, xInner - sx * 0.01, cy, wz);
        B.winGlass.push(g);
      }
      // what you see through it
      {
        const g = new THREE.PlaneGeometry(WIN_HW * 2 + 0.5, hh * 2 + 0.4);
        g.rotateY((sx * Math.PI) / 2);
        place(g, xOuter + sx * 0.05, cy, wz);
        B.backdrop.push(g);
      }
    }
  }

  // ---- door leaf, frame and furniture --------------------------------
  {
    const zf = IZ1 + 0.02;
    for (const s of [-1, 1]) {
      const g = bx(0.1, DOOR_H + 0.1, WT + 0.06, 0.022, 2);
      place(g, DOOR_X + s * (DOOR_W / 2 + 0.05), Y(DOOR_H / 2), IZ1 + WT / 2);
      worldUV(g, 1);
      B.trim.push(g);
    }
    const head = bx(DOOR_W + 0.2, 0.11, WT + 0.06, 0.022, 2);
    place(head, DOOR_X, Y(DOOR_H + 0.055), IZ1 + WT / 2);
    worldUV(head, 1);
    B.trim.push(head);

    // leaf: stile-and-rail with a glazed upper light
    const leaf = (w: number, h: number, x: number, y: number) => {
      const g = bx(w, h, 0.055, 0.016, 2);
      place(g, x, Y(y), zf);
      worldUV(g, 1);
      B.walnut.push(g);
    };
    const lw = DOOR_W - 0.06;
    leaf(0.14, DOOR_H - 0.06, DOOR_X - lw / 2 + 0.07, DOOR_H / 2); // stiles
    leaf(0.14, DOOR_H - 0.06, DOOR_X + lw / 2 - 0.07, DOOR_H / 2);
    leaf(lw, 0.14, DOOR_X, 0.07); // bottom rail
    leaf(lw, 0.16, DOOR_X, DOOR_H - 0.09); // top rail
    leaf(lw, 0.2, DOOR_X, 1.14); // lock rail
    leaf(lw - 0.24, 1.0, DOOR_X, 0.6); // lower panel
    {
      // glazed upper light, backed by the same daylight card as the windows
      const g = new THREE.PlaneGeometry(lw - 0.3, 1.06);
      place(g, DOOR_X, Y(1.79), zf - 0.03);
      B.winGlass.push(g);
      const b = new THREE.PlaneGeometry(lw + 0.2, 1.5);
      place(b, DOOR_X, Y(1.79), IZ1 + WT + 0.06);
      B.backdrop.push(b);
      const mull = bx(0.05, 1.06, 0.05, 0.016, 2);
      place(mull, DOOR_X, Y(1.79), zf);
      worldUV(mull, 1);
      B.walnut.push(mull);
    }
    // handle + escutcheon
    {
      const rose = cyl(0.045, 0.045, 0.02, 14);
      rose.rotateX(Math.PI / 2);
      place(rose, DOOR_X + lw / 2 - 0.22, Y(1.02), zf - 0.04);
      B.brass.push(rose);
      const lever = bx(0.13, 0.032, 0.032, 0.015, 2);
      place(lever, DOOR_X + lw / 2 - 0.28, Y(1.02), zf - 0.07);
      B.brass.push(lever);
    }
  }

  /* ================================================================== */
  /* THE STARTER TABLE                                                  */
  /* ================================================================== */

  {
    // slab with a moulded lip
    const top = bx(2.78, TABLE_SLAB, 1.2, 0.032, 4);
    place(top, 0, Y(TABLE_TOP), TABLE_Z);
    worldUV(top, 0.7);
    B.walnut.push(top);

    const lip = bx(2.86, 0.05, 1.28, 0.022, 3);
    place(lip, 0, Y(TABLE_TOP - 0.07), TABLE_Z);
    worldUV(lip, 0.7);
    B.walnut.push(lip);

    const apron = bx(2.36, 0.16, 0.88, 0.03, 3);
    place(apron, 0, Y(0.78), TABLE_Z);
    worldUV(apron, 0.8);
    B.walnut.push(apron);

    // turned legs — a real profile, not a cylinder
    const legProfile: [number, number][] = [
      [0.0, 0.0],
      [0.075, 0.0],
      [0.075, 0.05],
      [0.058, 0.09],
      [0.068, 0.13],
      [0.05, 0.2],
      [0.047, 0.44],
      [0.062, 0.5],
      [0.052, 0.56],
      [0.05, 0.66],
      [0.072, 0.72],
      [0.072, 0.83],
      [0.0, 0.83],
    ];
    for (const lx of [-1.22, 1.22]) {
      for (const lz of [-0.44, 0.44]) {
        const g = lathe(legProfile, 14);
        place(g, lx, Y(0), TABLE_Z + lz);
        worldUV(g, 1.4);
        B.walnut.push(g);
      }
    }
    // stretchers and a lower shelf that reads as storage
    for (const lz of [-0.44, 0.44]) {
      const s = bx(2.32, 0.06, 0.075, 0.02, 2);
      place(s, 0, Y(0.21), TABLE_Z + lz);
      worldUV(s, 1);
      B.walnut.push(s);
    }
    const shelf = bx(2.3, 0.045, 0.8, 0.018, 2);
    place(shelf, 0, Y(0.26), TABLE_Z);
    worldUV(shelf, 0.8);
    B.walnut.push(shelf);

    // brass corner caps at the top of each leg
    for (const lx of [-1.22, 1.22]) {
      for (const lz of [-0.44, 0.44]) {
        const g = cyl(0.079, 0.079, 0.028, 14);
        place(g, lx, Y(0.815), TABLE_Z + lz);
        B.brass.push(g);
      }
    }

    /* --- the three pedestals ---------------------------------------- */
    const anchors: THREE.Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      const px = (i - 1) * 0.72;

      // A pale stone dais, not another piece of walnut: on a dark timber top
      // the ball positions have to be the light shapes or the eye slides off
      // them, and this is the one place in the game the player must look.
      const dais = lathe(
        [
          [0.0, 0.0],
          [0.158, 0.0],
          [0.166, 0.013],
          [0.163, 0.033],
          [0.148, 0.046],
          [0.126, 0.055],
          [0.104, 0.057],
          [0.0, 0.057],
        ],
        30,
      );
      place(dais, px, Y(TOP_SURFACE), TABLE_Z);
      worldUV(dais, 2.4);
      B.dais.push(dais);

      const ring = new THREE.TorusGeometry(0.158, 0.012, 8, 34);
      ring.rotateX(Math.PI / 2);
      place(ring, px, Y(TOP_SURFACE + 0.016), TABLE_Z);
      B.brass.push(ring);

      // felt-lined well the ball sits in: a shallow dish plus a raised bolster
      const well = lathe(
        [
          [0.0, 0.016],
          [0.055, 0.006],
          [0.082, 0.0],
          [0.094, 0.014],
          [0.0955, 0.03],
          [0.0, 0.03],
        ],
        26,
      );
      place(well, px, Y(TOP_SURFACE + 0.052), TABLE_Z);
      worldUV(well, 6);
      B.felt.push(well);
      const bolster = new THREE.TorusGeometry(0.083, 0.016, 8, 28);
      bolster.rotateX(Math.PI / 2);
      place(bolster, px, Y(TOP_SURFACE + 0.072), TABLE_Z);
      B.felt.push(bolster);

      // A small warm pool on the dais so each position reads as "lit for you".
      const pedGlow = new THREE.PlaneGeometry(0.52, 0.52);
      pedGlow.rotateX(-Math.PI / 2);
      place(pedGlow, px, Y(TOP_SURFACE + 0.062), TABLE_Z);
      root.add(makeMesh(pedGlow, matDaisGlow, false, false));

      // angled nameplate, engraved face atlassed from one texture
      const plate = bx(0.25, 0.016, 0.082, 0.007, 2);
      place(plate, px, Y(TOP_SURFACE + 0.013), TABLE_Z + 0.33, -0.16);
      worldUV(plate, 4);
      B.label.push(plate);
      {
        const face = new THREE.PlaneGeometry(0.232, 0.07);
        face.rotateX(-Math.PI / 2);
        const uv = face.attributes.uv as THREE.BufferAttribute;
        for (let k = 0; k < uv.count; k++) {
          uv.setX(k, (uv.getX(k) * 0.98 + 0.01 + i) / 3);
        }
        uv.needsUpdate = true;
        place(face, px, Y(TOP_SURFACE + 0.0215), TABLE_Z + 0.33, -0.16);
        B.plateFace.push(face);
      }
      const plateEdge = bx(0.272, 0.008, 0.098, 0.004, 2);
      place(plateEdge, px, Y(TOP_SURFACE + 0.006), TABLE_Z + 0.33, -0.16);
      B.brass.push(plateEdge);

      anchors.push(new THREE.Vector3(px, Y(TOP_SURFACE + 0.078 + 0.04), TABLE_Z));
    }

    ctx.scene.userData.starterAnchors = anchors;
    ctx.scene.userData.labCenter = new THREE.Vector3(0, FLOOR_Y, TABLE_Z);
    ctx.scene.userData.labFloorY = FLOOR_Y;

    // a clipboard and a coffee mug so the table is a working surface
    {
      const cb = bx(0.26, 0.014, 0.34, 0.006, 2);
      place(cb, -1.05, Y(TOP_SURFACE + 0.007), TABLE_Z + 0.06, 0, 0.28);
      worldUV(cb, 2);
      B.paper.push(cb);
      const clip = bx(0.12, 0.02, 0.04, 0.008, 2);
      place(clip, -1.02, Y(TOP_SURFACE + 0.022), TABLE_Z - 0.09, 0, 0.28);
      B.steel.push(clip);

      const mug = lathe(
        [
          [0.0, 0.0],
          [0.036, 0.0],
          [0.04, 0.012],
          [0.042, 0.09],
          [0.038, 0.095],
          [0.034, 0.02],
          [0.0, 0.018],
        ],
        18,
      );
      place(mug, 1.12, Y(TOP_SURFACE), TABLE_Z + 0.1);
      worldUV(mug, 4);
      B.counter.push(mug);
      const handle = new THREE.TorusGeometry(0.028, 0.008, 7, 16, Math.PI * 1.25);
      handle.rotateY(Math.PI / 2);
      place(handle, 1.16, Y(TOP_SURFACE + 0.055), TABLE_Z + 0.1, 0, 0, -0.4);
      B.counter.push(handle);
    }
  }

  // ---- rug ------------------------------------------------------------
  {
    const g = new THREE.CircleGeometry(1.72, 44);
    g.rotateX(-Math.PI / 2);
    g.scale(1.25, 1, 0.92);
    place(g, 0, Y(0.009), TABLE_Z + 0.25);
    worldUV(g, 0.55);
    const m = new THREE.Mesh(g, matRug);
    m.receiveShadow = true;
    root.add(m);

    const r = new THREE.RingGeometry(1.72, 1.94, 48);
    r.rotateX(-Math.PI / 2);
    r.scale(1.25, 1, 0.92);
    place(r, 0, Y(0.007), TABLE_Z + 0.25);
    worldUV(r, 0.55);
    const rm = new THREE.Mesh(r, matRugTrim);
    rm.receiveShadow = true;
    root.add(rm);
  }

  /* ================================================================== */
  /* NORTH WALL: bookcases, display cabinet, whiteboard                 */
  /* ================================================================== */

  /**
   * Where books can go. `a0..a1` runs along the shelf, `cross` is the fixed
   * coordinate on the other horizontal axis, and `axis` says which is which.
   */
  interface ShelfSpan {
    a0: number;
    a1: number;
    y: number;
    cross: number;
    axis: 'x' | 'z';
  }
  const shelfSpans: ShelfSpan[] = [];

  /** A carcass bookcase against the north wall. */
  function bookcase(x0: number, x1: number, height: number, depth: number) {
    const zc = IZ0 + depth / 2 + 0.05;
    const w = x1 - x0;
    const cx = (x0 + x1) / 2;
    // sides
    for (const s of [-1, 1]) {
      const g = bx(0.05, height, depth, 0.014, 2);
      place(g, cx + s * (w / 2 - 0.025), Y(height / 2), zc);
      worldUV(g, 1);
      B.walnut.push(g);
    }
    // back
    const back = bx(w - 0.08, height - 0.1, 0.03, 0.01, 2);
    place(back, cx, Y(height / 2), zc - depth / 2 + 0.02);
    worldUV(back, 1);
    B.walnut.push(back);
    // plinth
    const plinth = bx(w, 0.12, depth + 0.03, 0.02, 2);
    place(plinth, cx, Y(0.06), zc);
    worldUV(plinth, 1);
    B.walnut.push(plinth);
    // cornice
    const corn = bx(w + 0.08, 0.1, depth + 0.07, 0.022, 2);
    place(corn, cx, Y(height + 0.05), zc);
    worldUV(corn, 1);
    B.walnut.push(corn);
    const crown = bx(w + 0.14, 0.05, depth + 0.12, 0.018, 2);
    place(crown, cx, Y(height + 0.125), zc);
    worldUV(crown, 1);
    B.walnut.push(crown);
    // shelves
    const n = Math.max(3, Math.round((height - 0.2) / 0.42));
    for (let i = 0; i <= n; i++) {
      const y = 0.12 + ((height - 0.24) * i) / n;
      const g = bx(w - 0.1, 0.035, depth - 0.04, 0.012, 2);
      place(g, cx, Y(y), zc + 0.01);
      worldUV(g, 1);
      B.walnut.push(g);
      if (i < n) {
        shelfSpans.push({ a0: x0 + 0.1, a1: x1 - 0.1, y: Y(y + 0.018), cross: zc + 0.01, axis: 'x' });
      }
      // Concealed warm strip under the shelf above. Without it the recess is a
      // black slot no room light can reach, and 300 books go to waste.
      if (i > 0) {
        const strip = bx(w - 0.28, 0.022, 0.045, 0.008, 2);
        place(strip, cx, Y(y - 0.03), zc + depth / 2 - 0.09);
        B.shelfGlow.push(strip);
      }
    }
  }

  bookcase(-6.75, -4.35, 2.3, 0.36);
  bookcase(-4.25, -2.15, 2.3, 0.36);

  /** Glass-fronted display cabinet, centred behind the starter table. */
  {
    const x0 = -1.75;
    const x1 = 1.75;
    const cx = 0;
    const w = x1 - x0;
    const depth = 0.46;
    const height = 2.42;
    const zc = IZ0 + depth / 2 + 0.05;

    for (const s of [-1, 1]) {
      const g = bx(0.08, height, depth, 0.018, 2);
      place(g, cx + s * (w / 2 - 0.04), Y(height / 2), zc);
      worldUV(g, 1);
      B.walnut.push(g);
    }
    const back = bx(w - 0.12, height - 0.14, 0.035, 0.01, 2);
    place(back, cx, Y(height / 2), zc - depth / 2 + 0.022);
    worldUV(back, 1);
    B.caseBack.push(back);
    const plinth = bx(w + 0.06, 0.16, depth + 0.05, 0.028, 3);
    place(plinth, cx, Y(0.08), zc);
    worldUV(plinth, 1);
    B.walnut.push(plinth);
    const corn = bx(w + 0.14, 0.13, depth + 0.09, 0.028, 3);
    place(corn, cx, Y(height + 0.065), zc);
    worldUV(corn, 1);
    B.walnut.push(corn);
    const crown = bx(w + 0.22, 0.06, depth + 0.15, 0.02, 2);
    place(crown, cx, Y(height + 0.16), zc);
    worldUV(crown, 1);
    B.walnut.push(crown);

    // glass shelves with a warm strip light above each
    for (let i = 0; i < 4; i++) {
      const y = 0.34 + i * 0.5;
      const g = bx(w - 0.16, 0.022, depth - 0.09, 0.008, 2);
      place(g, cx, Y(y), zc + 0.01);
      B.glass.push(g);
      const strip = bx(w - 0.34, 0.022, 0.05, 0.008, 2);
      place(strip, cx, Y(y + 0.46), zc + 0.09);
      B.caseGlow.push(strip);

      // specimens on the shelf: specimen jars, fossils, small pots
      const cnt = 5 + Math.floor(rng() * 3);
      for (let k = 0; k < cnt; k++) {
        const ox = lerp(x0 + 0.28, x1 - 0.28, (k + 0.5 + (rng() - 0.5) * 0.5) / cnt);
        const oz = zc + rangeOf(rng, -0.06, 0.09);
        const kind = rng();
        if (kind < 0.45) {
          const hgt = rangeOf(rng, 0.17, 0.29);
          const rad = rangeOf(rng, 0.058, 0.082);
          const jar = lathe(
            [
              [0, 0],
              [rad, 0],
              [rad, hgt * 0.82],
              [rad * 0.72, hgt * 0.92],
              [rad * 0.74, hgt],
              [rad * 0.6, hgt],
              [rad * 0.6, hgt * 0.94],
              [0, hgt * 0.94],
            ],
            14,
          );
          place(jar, ox, Y(y + 0.011), oz);
          B.glass.push(jar);
          const liq = cyl(rad * 0.9, rad * 0.9, hgt * 0.6, 14);
          place(liq, ox, Y(y + 0.011 + hgt * 0.3), oz);
          tintGeo(liq, pick(rng, [0xf25d7a, 0xffd447, 0x5fc8d2, 0xb57fe0, 0x8fd257]));
          B.liquid.push(liq);
        } else if (kind < 0.68) {
          // a mineral chunk on a little stand
          const g2 = bx(rangeOf(rng, 0.13, 0.21), rangeOf(rng, 0.09, 0.16), 0.14, 0.025, 2);
          place(g2, ox, Y(y + 0.09), oz, rangeOf(rng, -0.2, 0.2), rangeOf(rng, -0.6, 0.6));
          worldUV(g2, 3);
          B.pot.push(g2);
          const base2 = bx(0.16, 0.03, 0.13, 0.01, 2);
          place(base2, ox, Y(y + 0.026), oz);
          worldUV(base2, 3);
          B.walnut.push(base2);
        } else if (kind < 0.86) {
          const g2 = lathe(
            [
              [0, 0],
              [0.075, 0],
              [0.09, 0.06],
              [0.062, 0.15],
              [0.07, 0.18],
              [0, 0.18],
            ],
            16,
          );
          place(g2, ox, Y(y + 0.011), oz);
          worldUV(g2, 3);
          B.pot.push(g2);
        } else {
          // a small stack of leaning field notebooks
          for (let q = 0; q < 3; q++) {
            const g2 = bx(0.13, 0.035, 0.17, 0.008, 2);
            place(g2, ox + q * 0.006, Y(y + 0.03 + q * 0.036), oz, 0, rangeOf(rng, -0.12, 0.12));
            worldUV(g2, 3);
            B.walnut.push(g2);
          }
        }
      }
    }

    // glazed doors with a central stile
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(w / 2 - 0.14, height - 0.42);
      place(g, cx + s * (w / 4), Y(height / 2 + 0.06), zc + depth / 2 + 0.01);
      B.glass.push(g);
      const fr = bx(0.05, height - 0.36, 0.05, 0.016, 2);
      place(fr, cx + s * (w / 2 - 0.09), Y(height / 2 + 0.06), zc + depth / 2 + 0.01);
      worldUV(fr, 1);
      B.walnut.push(fr);
      const knob = new THREE.SphereGeometry(0.022, 12, 8);
      place(knob, cx + s * 0.09, Y(1.2), zc + depth / 2 + 0.05);
      B.brass.push(knob);
    }
    const midStile = bx(0.07, height - 0.36, 0.05, 0.016, 2);
    place(midStile, cx, Y(height / 2 + 0.06), zc + depth / 2 + 0.012);
    worldUV(midStile, 1);
    B.walnut.push(midStile);
    for (const yy of [0.19, height - 0.11]) {
      const rail = bx(w - 0.1, 0.08, 0.05, 0.016, 2);
      place(rail, cx, Y(yy + 0.06), zc + depth / 2 + 0.012);
      worldUV(rail, 1);
      B.walnut.push(rail);
    }
  }

  // ---- whiteboard + low cabinet run ----------------------------------
  {
    const x0 = 2.25;
    const x1 = 6.1;
    const cx = (x0 + x1) / 2;
    const w = x1 - x0;

    const frame = bx(w + 0.12, 1.46, 0.09, 0.024, 3);
    place(frame, cx, Y(1.94), IZ0 + 0.055);
    worldUV(frame, 1);
    B.trim.push(frame);
    const board = new THREE.PlaneGeometry(w, 1.34);
    place(board, cx, Y(1.94), IZ0 + 0.105);
    root.add(makeMesh(board, matBoard, false, true));

    const tray = bx(w * 0.5, 0.05, 0.11, 0.018, 2);
    place(tray, cx - w * 0.16, Y(1.19), IZ0 + 0.11);
    worldUV(tray, 1);
    B.trim.push(tray);
    for (let i = 0; i < 4; i++) {
      const p = cyl(0.011, 0.011, 0.11, 8);
      p.rotateZ(Math.PI / 2);
      place(p, cx - w * 0.28 + i * 0.09, Y(1.235), IZ0 + 0.11);
      tintGeo(p, [0x2b3a4a, 0xc0392b, 0x3b6ea5, 0x4a9d4a][i]);
      B.liquid.push(p);
    }

    // low cabinet under the board
    const ch = 0.88;
    const cd = 0.52;
    const zc = IZ0 + cd / 2 + 0.05;
    const carc = bx(w + 0.12, ch, cd, 0.03, 3);
    place(carc, cx, Y(ch / 2), zc);
    worldUV(carc, 1);
    B.walnut.push(carc);
    const ctop = bx(w + 0.24, 0.05, cd + 0.09, 0.02, 2);
    place(ctop, cx, Y(ch + 0.025), zc);
    worldUV(ctop, 1);
    B.counter.push(ctop);
    for (let i = 0; i < 3; i++) {
      const dw = (w + 0.02) / 3 - 0.05;
      const dxp = cx - (w + 0.02) / 3 + i * ((w + 0.02) / 3);
      const door = bx(dw, ch - 0.16, 0.035, 0.015, 2);
      place(door, dxp, Y(ch / 2), zc + cd / 2 + 0.016);
      worldUV(door, 1);
      B.walnut.push(door);
      const hd = bx(0.14, 0.022, 0.022, 0.01, 2);
      place(hd, dxp, Y(ch - 0.18), zc + cd / 2 + 0.05);
      B.brass.push(hd);
    }
  }

  /* ================================================================== */
  /* WEST WALL: laboratory bench run                                    */
  /* ================================================================== */

  {
    const bx0 = -17.6;
    const bx1 = -7.9; // z range of the run
    const depth = 0.68;
    const xc = -IX + depth / 2 + 0.04;
    const len = bx1 - bx0;
    const zc = (bx0 + bx1) / 2;
    const bh = 0.9;

    const carc = bx(depth, bh, len, 0.03, 3);
    place(carc, xc, Y(bh / 2), zc);
    worldUV(carc, 1);
    B.walnut.push(carc);
    const top = bx(depth + 0.11, 0.055, len + 0.06, 0.022, 2);
    place(top, xc + 0.03, Y(bh + 0.028), zc);
    worldUV(top, 1);
    B.counter.push(top);
    // upstand at the wall
    const up = bx(0.05, 0.1, len + 0.06, 0.018, 2);
    place(up, -IX + 0.03, Y(bh + 0.06), zc);
    worldUV(up, 1);
    B.counter.push(up);
    // toe recess
    const toe = bx(depth - 0.12, 0.12, len, 0.02, 2);
    place(toe, xc - 0.06, Y(0.06), zc);
    worldUV(toe, 1);
    B.rubber.push(toe);

    // doors and drawers
    const nDoors = 7;
    for (let i = 0; i < nDoors; i++) {
      const dz = bx0 + 0.28 + (len - 0.56) * (i / (nDoors - 1));
      const dw = len / nDoors - 0.08;
      if (i % 3 === 1) {
        for (let k = 0; k < 3; k++) {
          const dr = bx(0.035, 0.2, dw, 0.014, 2);
          place(dr, xc + depth / 2 + 0.018, Y(0.24 + k * 0.24), dz);
          worldUV(dr, 1);
          B.walnut.push(dr);
          const hd = bx(0.022, 0.022, 0.16, 0.01, 2);
          place(hd, xc + depth / 2 + 0.05, Y(0.24 + k * 0.24), dz);
          B.brass.push(hd);
        }
      } else {
        const door = bx(0.035, bh - 0.22, dw, 0.014, 2);
        place(door, xc + depth / 2 + 0.018, Y(bh / 2 + 0.02), dz);
        worldUV(door, 1);
        B.walnut.push(door);
        const hd = bx(0.022, 0.16, 0.022, 0.01, 2);
        place(hd, xc + depth / 2 + 0.05, Y(bh / 2 + 0.02), dz + dw / 2 - 0.07);
        B.brass.push(hd);
      }
    }

    const deck = bh + 0.055;

    // --- sink -----------------------------------------------------------
    {
      const sz = -16.1;
      const basin = bx(0.42, 0.2, 0.5, 0.05, 3);
      place(basin, xc + 0.02, Y(deck - 0.09), sz);
      worldUV(basin, 2);
      B.steel.push(basin);
      const inner = bx(0.34, 0.18, 0.42, 0.05, 3);
      place(inner, xc + 0.02, Y(deck - 0.05), sz);
      worldUV(inner, 2);
      B.rubber.push(inner);
      // gooseneck tap
      const stem = cyl(0.017, 0.02, 0.3, 12);
      place(stem, -IX + 0.13, Y(deck + 0.15), sz);
      B.steel.push(stem);
      const arc = new THREE.TorusGeometry(0.11, 0.016, 8, 18, Math.PI * 0.72);
      arc.rotateY(Math.PI / 2);
      place(arc, -IX + 0.13, Y(deck + 0.3), sz, 0, 0, 0.3);
      B.steel.push(arc);
      for (const s of [-1, 1]) {
        const hv = cyl(0.02, 0.022, 0.06, 10);
        place(hv, -IX + 0.13, Y(deck + 0.03), sz + s * 0.12);
        B.steel.push(hv);
        const lv = bx(0.09, 0.016, 0.016, 0.008, 2);
        place(lv, -IX + 0.16, Y(deck + 0.06), sz + s * 0.12, 0, 0, 0.2);
        B.steel.push(lv);
      }
    }

    // --- glassware --------------------------------------------------------
    const glassKinds: (() => { glass: THREE.BufferGeometry; liquid: THREE.BufferGeometry | null })[] = [
      // beaker
      () => {
        const h = rangeOf(rng, 0.13, 0.18);
        const r = rangeOf(rng, 0.05, 0.065);
        return {
          glass: lathe(
            [
              [0, 0],
              [r, 0],
              [r, h],
              [r * 1.06, h],
              [r * 0.94, h],
              [r * 0.94, 0.006],
              [0, 0.006],
            ],
            18,
          ),
          liquid: cyl(r * 0.92, r * 0.92, h * rangeOf(rng, 0.35, 0.62), 18),
        };
      },
      // conical flask
      () => {
        const h = rangeOf(rng, 0.17, 0.23);
        const r = rangeOf(rng, 0.065, 0.085);
        return {
          glass: lathe(
            [
              [0, 0],
              [r, 0],
              [r * 0.95, h * 0.12],
              [r * 0.34, h * 0.72],
              [r * 0.3, h],
              [r * 0.36, h],
              [r * 0.26, h * 0.72],
              [r * 0.88, h * 0.14],
              [0, 0.008],
            ],
            20,
          ),
          liquid: cyl(r * 0.6, r * 0.9, h * 0.3, 18),
        };
      },
      // round-bottom flask on a stand
      () => {
        const r = rangeOf(rng, 0.07, 0.085);
        const pts: [number, number][] = [];
        for (let i = 0; i <= 14; i++) {
          const a = Math.PI * (1 - i / 14) * 0.86 + 0.2;
          pts.push([Math.sin(a) * r, r - Math.cos(a) * r]);
        }
        pts.push([r * 0.22, r * 2.1], [r * 0.24, r * 2.5], [0, r * 2.5]);
        return { glass: lathe(pts, 20), liquid: new THREE.SphereGeometry(r * 0.82, 16, 10) };
      },
      // graduated cylinder
      () => {
        const h = rangeOf(rng, 0.2, 0.28);
        const r = rangeOf(rng, 0.028, 0.038);
        return {
          glass: lathe(
            [
              [0, 0],
              [r * 1.7, 0],
              [r * 1.7, 0.012],
              [r, 0.03],
              [r, h],
              [r * 0.9, h],
              [r * 0.9, 0.03],
              [0, 0.02],
            ],
            16,
          ),
          liquid: cyl(r * 0.88, r * 0.88, h * rangeOf(rng, 0.4, 0.75), 16),
        };
      },
    ];

    const glassZ = [-14.9, -14.55, -13.9, -13.2, -12.75, -12.2, -11.3, -10.85, -10.2];
    for (const gz of glassZ) {
      const kind = glassKinds[Math.floor(rng() * glassKinds.length)];
      const { glass, liquid } = kind();
      const gx = xc + rangeOf(rng, -0.16, 0.14);
      place(glass, gx, Y(deck), gz, 0, rangeOf(rng, 0, Math.PI));
      B.glass.push(glass);
      if (liquid) {
        glass.computeBoundingBox();
        const bb = glass.boundingBox!;
        place(liquid, gx, bb.min.y + (bb.max.y - bb.min.y) * 0.24, gz);
        tintGeo(liquid, pick(rng, [0xf25d7a, 0xffd447, 0x5fc8d2, 0xb57fe0, 0x8fd257, 0x4a86c4]));
        B.liquid.push(liquid);
      }
    }

    // test-tube rack
    {
      const rz = -11.85;
      const rack = bx(0.16, 0.05, 0.44, 0.014, 2);
      place(rack, xc + 0.16, Y(deck + 0.025), rz);
      worldUV(rack, 2);
      B.oak.push(rack);
      const rackTop = bx(0.16, 0.035, 0.44, 0.012, 2);
      place(rackTop, xc + 0.16, Y(deck + 0.19), rz);
      worldUV(rackTop, 2);
      B.oak.push(rackTop);
      for (const s of [-1, 1]) {
        const post = bx(0.03, 0.2, 0.03, 0.01, 2);
        place(post, xc + 0.16, Y(deck + 0.11), rz + s * 0.19);
        worldUV(post, 2);
        B.oak.push(post);
      }
      for (let i = 0; i < 6; i++) {
        const tz = rz - 0.17 + i * 0.068;
        const tube = lathe(
          [
            [0, 0],
            [0.013, 0.014],
            [0.014, 0.15],
            [0.0155, 0.155],
            [0.0125, 0.155],
            [0.011, 0.014],
            [0, 0.002],
          ],
          12,
        );
        place(tube, xc + 0.16, Y(deck + 0.03), tz);
        B.glass.push(tube);
        const liq = cyl(0.0115, 0.0115, rangeOf(rng, 0.03, 0.08), 10);
        place(liq, xc + 0.16, Y(deck + 0.06), tz);
        tintGeo(liq, pick(rng, [0xf25d7a, 0xffd447, 0x5fc8d2, 0xb57fe0, 0x8fd257]));
        B.liquid.push(liq);
      }
    }

    // a squat analytical machine at the north end of the bench
    {
      const mz = -17.0;
      const body = bx(0.5, 0.42, 0.66, 0.05, 3);
      place(body, xc + 0.02, Y(deck + 0.21), mz);
      worldUV(body, 1.4);
      B.counter.push(body);
      const lid = bx(0.46, 0.06, 0.6, 0.03, 3);
      place(lid, xc + 0.02, Y(deck + 0.45), mz, 0, 0, 0);
      worldUV(lid, 1.4);
      B.steel.push(lid);
      const face = bx(0.02, 0.14, 0.3, 0.008, 2);
      place(face, xc + 0.26, Y(deck + 0.26), mz);
      B.panel.push(face);
      for (let i = 0; i < 3; i++) {
        const kn = cyl(0.024, 0.024, 0.03, 12);
        kn.rotateZ(Math.PI / 2);
        place(kn, xc + 0.26, Y(deck + 0.1), mz - 0.15 + i * 0.15);
        B.rubber.push(kn);
      }
      // cable from the machine to the floor
      B.rubber.push(cableGeo(
        new THREE.Vector3(xc - 0.16, Y(deck + 0.08), mz + 0.3),
        new THREE.Vector3(xc + 0.02, Y(deck - 0.5), mz + 0.52),
        new THREE.Vector3(xc + 0.16, Y(0.02), mz + 0.66),
        0.014,
      ));
    }

    // stacked papers along the bench
    for (const pz of [-15.3, -13.55, -11.0]) {
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const g = bx(0.3, 0.014, 0.24, 0.004, 2);
        place(g, xc + rangeOf(rng, -0.08, 0.1), Y(deck + 0.008 + i * 0.014), pz + rangeOf(rng, -0.04, 0.04), 0, rangeOf(rng, -0.16, 0.16));
        worldUV(g, 2.2);
        B.paper.push(g);
      }
    }
  }

  /* ================================================================== */
  /* EAST WALL: computer terminal + storage                             */
  /* ================================================================== */

  {
    const deskZ0 = -12.6;
    const deskZ1 = -8.6;
    const zc = (deskZ0 + deskZ1) / 2;
    const len = deskZ1 - deskZ0;
    const depth = 0.72;
    const xc = IX - depth / 2 - 0.04;
    const dh = 0.76;

    const top = bx(depth + 0.08, 0.06, len, 0.024, 3);
    place(top, xc, Y(dh), zc);
    worldUV(top, 0.9);
    B.walnut.push(top);
    // trestle legs
    for (const s of [-1, 1]) {
      const leg = bx(0.09, dh - 0.03, 0.09, 0.02, 2);
      place(leg, xc, Y((dh - 0.03) / 2), zc + s * (len / 2 - 0.16));
      worldUV(leg, 1);
      B.steel.push(leg);
      const foot = bx(depth - 0.06, 0.045, 0.14, 0.018, 2);
      place(foot, xc, Y(0.022), zc + s * (len / 2 - 0.16));
      worldUV(foot, 1);
      B.steel.push(foot);
      const arm = bx(depth - 0.06, 0.05, 0.1, 0.018, 2);
      place(arm, xc, Y(dh - 0.06), zc + s * (len / 2 - 0.16));
      worldUV(arm, 1);
      B.steel.push(arm);
    }
    const rail = bx(0.06, 0.06, len - 0.5, 0.02, 2);
    place(rail, xc, Y(0.28), zc);
    worldUV(rail, 1);
    B.steel.push(rail);

    // ---- monitor -------------------------------------------------------
    const mz = -10.4;
    const shellBody = bx(0.36, 0.5, 0.62, 0.05, 3);
    place(shellBody, xc + 0.06, Y(dh + 0.31), mz, 0, 0.34);
    worldUV(shellBody, 1.6);
    B.counter.push(shellBody);
    const bezel = bx(0.05, 0.42, 0.54, 0.03, 3);
    place(bezel, xc - 0.14, Y(dh + 0.32), mz, 0, 0.34);
    worldUV(bezel, 1.6);
    B.counter.push(bezel);
    {
      const g = new THREE.PlaneGeometry(0.46, 0.34);
      g.rotateY(-Math.PI / 2);
      place(g, xc - 0.17, Y(dh + 0.32), mz, 0, 0.34);
      root.add(makeMesh(g, matScreen, false, false));
      // A card of spill so the display throws colour onto the desk.
      const glow = new THREE.PlaneGeometry(1.15, 0.95);
      glow.rotateY(-Math.PI / 2);
      place(glow, xc - 0.2, Y(dh + 0.32), mz, 0, 0.34);
      const gm = makeMesh(glow, matScreenGlow, false, false);
      root.add(gm);
    }
    const stand = cyl(0.05, 0.09, 0.14, 14);
    place(stand, xc + 0.06, Y(dh + 0.04), mz);
    B.counter.push(stand);
    const base = lathe(
      [
        [0, 0],
        [0.16, 0],
        [0.17, 0.014],
        [0.1, 0.03],
        [0, 0.03],
      ],
      18,
    );
    place(base, xc + 0.06, Y(dh + 0.03), mz);
    B.counter.push(base);

    // ---- keyboard ------------------------------------------------------
    const kb = bx(0.2, 0.03, 0.46, 0.01, 2);
    place(kb, xc - 0.19, Y(dh + 0.045), mz - 0.02, 0, 0.3);
    worldUV(kb, 2);
    B.counter.push(kb);
    const keys = bx(0.16, 0.014, 0.4, 0.006, 2);
    place(keys, xc - 0.19, Y(dh + 0.062), mz - 0.02, -0.06, 0.3);
    worldUV(keys, 6);
    B.rubber.push(keys);

    // ---- tower + cables -------------------------------------------------
    const tower = bx(0.24, 0.52, 0.5, 0.035, 3);
    place(tower, xc + 0.1, Y(0.27), mz + 0.9);
    worldUV(tower, 1.2);
    B.counter.push(tower);
    const vent = bx(0.02, 0.3, 0.36, 0.01, 2);
    place(vent, xc - 0.02, Y(0.3), mz + 0.9);
    B.rubber.push(vent);
    const led = cyl(0.012, 0.012, 0.02, 10);
    led.rotateZ(Math.PI / 2);
    place(led, xc - 0.02, Y(0.46), mz + 0.78);
    B.bulb.push(led);

    B.rubber.push(cableGeo(
      new THREE.Vector3(xc + 0.16, Y(dh + 0.12), mz + 0.14),
      new THREE.Vector3(xc + 0.24, Y(0.42), mz + 0.6),
      new THREE.Vector3(xc + 0.1, Y(0.03), mz + 0.68),
      0.012,
    ));
    B.rubber.push(cableGeo(
      new THREE.Vector3(xc - 0.24, Y(dh + 0.03), mz - 0.2),
      new THREE.Vector3(xc + 0.2, Y(dh - 0.3), mz + 0.3),
      new THREE.Vector3(xc + 0.14, Y(0.02), mz + 1.12),
      0.011,
    ));

    // paper piles and a mug on the desk
    for (const pz of [-11.6, -9.4]) {
      for (let i = 0; i < 3; i++) {
        const g = bx(0.3, 0.014, 0.23, 0.004, 2);
        place(g, xc + rangeOf(rng, -0.1, 0.12), Y(dh + 0.04 + i * 0.014), pz + rangeOf(rng, -0.05, 0.05), 0, rangeOf(rng, -0.2, 0.2));
        worldUV(g, 2.2);
        B.paper.push(g);
      }
    }

    // ---- east storage unit (north of the window, never in front of it) ---
    {
      const x0 = -18.25;
      const x1 = -16.35;
      const depth2 = 0.4;
      const xc2 = IX - depth2 / 2 - 0.05;
      const w = x1 - x0;
      const zc2 = (x0 + x1) / 2;
      const height = 2.16;

      for (const s of [-1, 1]) {
        const g = bx(depth2, height, 0.05, 0.014, 2);
        place(g, xc2, Y(height / 2), zc2 + s * (w / 2 - 0.025));
        worldUV(g, 1);
        B.walnut.push(g);
      }
      const back = bx(0.03, height - 0.1, w - 0.08, 0.01, 2);
      place(back, IX - 0.06, Y(height / 2), zc2);
      worldUV(back, 1);
      B.walnut.push(back);
      const plinth = bx(depth2 + 0.03, 0.12, w, 0.02, 2);
      place(plinth, xc2, Y(0.06), zc2);
      worldUV(plinth, 1);
      B.walnut.push(plinth);
      const corn = bx(depth2 + 0.08, 0.1, w + 0.08, 0.022, 2);
      place(corn, xc2, Y(height + 0.05), zc2);
      worldUV(corn, 1);
      B.walnut.push(corn);
      for (let i = 0; i <= 5; i++) {
        const y = 0.12 + ((height - 0.24) * i) / 5;
        const g = bx(depth2 - 0.04, 0.035, w - 0.1, 0.012, 2);
        place(g, xc2 - 0.01, Y(y), zc2);
        worldUV(g, 1);
        B.walnut.push(g);
        if (i < 5) {
          shelfSpans.push({ a0: x0 + 0.1, a1: x1 - 0.1, y: Y(y + 0.018), cross: xc2 - 0.01, axis: 'z' });
        }
      }
    }

    // ---- steel filing cabinet under the north window ---------------------
    {
      const fz = -13.75;
      const fd = 0.6;
      const fxc = IX - fd / 2 - 0.05;
      const fh = 0.98;
      const body = bx(fd, fh, 1.05, 0.03, 3);
      place(body, fxc, Y(fh / 2), fz);
      worldUV(body, 1.2);
      B.steel.push(body);
      const capTop = bx(fd + 0.05, 0.045, 1.1, 0.018, 2);
      place(capTop, fxc, Y(fh + 0.022), fz);
      worldUV(capTop, 1.2);
      B.steel.push(capTop);
      for (let i = 0; i < 3; i++) {
        const dr = bx(0.03, 0.27, 0.98, 0.014, 2);
        place(dr, fxc - fd / 2 - 0.014, Y(0.19 + i * 0.3), fz);
        worldUV(dr, 1.4);
        B.rubber.push(dr);
        const hd = bx(0.03, 0.035, 0.24, 0.012, 2);
        place(hd, fxc - fd / 2 - 0.04, Y(0.19 + i * 0.3), fz);
        B.steel.push(hd);
      }
      // stuff on top: a stack of trays and a small potted succulent
      for (let i = 0; i < 3; i++) {
        const tray = bx(0.42, 0.035, 0.6, 0.014, 2);
        place(tray, fxc, Y(fh + 0.07 + i * 0.06), fz + 0.1, 0, rangeOf(rng, -0.06, 0.06));
        worldUV(tray, 1.6);
        B.rubber.push(tray);
        const sheets = bx(0.3, 0.02, 0.44, 0.006, 2);
        place(sheets, fxc, Y(fh + 0.09 + i * 0.06), fz + 0.1);
        worldUV(sheets, 2.2);
        B.paper.push(sheets);
      }
    }
  }

  /* ================================================================== */
  /* BOOKS                                                              */
  /* ================================================================== */

  {
    const bookGeo = bx(0.044, 0.26, 0.19, 0.008, 2);
    worldUV(bookGeo, 1 / 0.26);
    shiftUV(bookGeo, 0.5, 0.5);

    interface BookXf {
      m: THREE.Matrix4;
      c: THREE.Color;
    }
    const xf: BookXf[] = [];
    // Bound cloth and leather, not a paint chart: low-chroma burgundy, navy,
    // moss, ochre and grey with a single warmer accent that appears rarely.
    const palette = [
      0x6d3830, 0x35485f, 0x46583c, 0x7a6238, 0x4a3b4a, 0x3d5450, 0x7d5a44, 0x424a4e,
      0x8a6a4c, 0x554564, 0x2f4a3f, 0x6b3f36, 0x9a7b52, 0x394252,
    ];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();

    for (const span of shelfSpans) {
      const axis = span.axis;
      const a0 = span.a0;
      const a1 = span.a1;
      const total = a1 - a0;
      if (total < 0.2) continue;
      // Fill 55–95% of the run so shelves are never uniformly packed.
      const fill = rangeOf(rng, 0.5, 0.95);
      let cursor = a0 + rangeOf(rng, 0.01, 0.1);
      const limit = a0 + total * fill;
      let leaning = false;
      while (cursor < limit) {
        const th = rangeOf(rng, 0.7, 1.9);
        const hs = rangeOf(rng, 0.72, 1.1);
        const ds = rangeOf(rng, 0.82, 1.0);
        const w = 0.044 * th;
        if (cursor + w > limit) break;
        // Occasional gap, occasional leaning book at the end of a group.
        const lean: number = !leaning && rng() > 0.9 ? rangeOf(rng, 0.22, 0.42) : 0;
        leaning = lean !== 0;
        const hh = 0.26 * hs;
        const yy = span.y + (hh / 2) * Math.cos(lean) + 0.002;
        if (axis === 'x') {
          p.set(cursor + w / 2 + Math.sin(lean) * hh * 0.4, yy, span.cross);
          e.set(0, 0, lean);
        } else {
          p.set(span.cross, yy, cursor + w / 2 + Math.sin(lean) * hh * 0.4);
          e.set(0, -Math.PI / 2, lean);
        }
        q.setFromEuler(e);
        s.set(th, hs, ds);
        m.compose(p, q, s);
        xf.push({
          m: m.clone(),
          c: new THREE.Color(pick(rng, palette)).offsetHSL(
            rangeOf(rng, -0.02, 0.02),
            rangeOf(rng, -0.1, 0.06),
            rangeOf(rng, -0.05, 0.07),
          ),
        });
        cursor += w + (rng() > 0.93 ? rangeOf(rng, 0.04, 0.13) : 0.002);
      }

      // A few books laid flat in the leftover space.
      if (rng() > 0.45 && total * (1 - fill) > 0.32) {
        const n = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const hs = rangeOf(rng, 0.8, 1.05);
          const cx = a1 - 0.2 - rangeOf(rng, 0, 0.1);
          const yy = span.y + 0.023 + i * 0.046;
          if (axis === 'x') {
            p.set(cx, yy, span.cross + rangeOf(rng, -0.02, 0.02));
            e.set(Math.PI / 2, rangeOf(rng, -0.1, 0.1), Math.PI / 2);
          } else {
            p.set(span.cross + rangeOf(rng, -0.02, 0.02), yy, cx);
            e.set(Math.PI / 2, rangeOf(rng, -0.1, 0.1) - Math.PI / 2, Math.PI / 2);
          }
          q.setFromEuler(e);
          s.set(rangeOf(rng, 1.0, 1.6), hs, rangeOf(rng, 0.88, 1.0));
          m.compose(p, q, s);
          xf.push({ m: m.clone(), c: new THREE.Color(pick(rng, palette)) });
        }
      }
    }

    if (xf.length > 0) {
      const inst = new THREE.InstancedMesh(bookGeo, matBook, xf.length);
      inst.name = 'LabBooks';
      for (let i = 0; i < xf.length; i++) {
        inst.setMatrixAt(i, xf[i].m);
        inst.setColorAt(i, xf[i].c);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.castShadow = false;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      root.add(inst);
    }
  }

  /* ================================================================== */
  /* LOOSE DRESSING                                                     */
  /* ================================================================== */

  // ---- wheeled stool ---------------------------------------------------
  {
    const sx = -4.55;
    const sz = -12.35;
    const rot = 0.7;
    const seat = lathe(
      [
        [0, 0],
        [0.19, 0.005],
        [0.2, 0.03],
        [0.185, 0.06],
        [0.1, 0.072],
        [0, 0.07],
      ],
      22,
    );
    place(seat, sx, Y(0.62), sz);
    worldUV(seat, 2);
    B.rubber.push(seat);
    const pad = lathe(
      [
        [0, 0],
        [0.175, 0.0],
        [0.178, 0.022],
        [0.1, 0.04],
        [0, 0.042],
      ],
      22,
    );
    place(pad, sx, Y(0.69), sz);
    worldUV(pad, 3);
    B.paper.push(pad);
    const post = cyl(0.028, 0.036, 0.42, 12);
    place(post, sx, Y(0.41), sz);
    B.steel.push(post);
    const collar = cyl(0.05, 0.05, 0.05, 12);
    place(collar, sx, Y(0.3), sz);
    B.steel.push(collar);
    for (let i = 0; i < 5; i++) {
      const a = rot + (i / 5) * Math.PI * 2;
      const leg = bx(0.26, 0.035, 0.05, 0.015, 2);
      place(leg, sx + Math.cos(a) * 0.15, Y(0.15), sz + Math.sin(a) * 0.15, 0, -a, -0.12);
      worldUV(leg, 2);
      B.steel.push(leg);
      const wheel = new THREE.TorusGeometry(0.034, 0.017, 8, 14);
      wheel.rotateY(-a + Math.PI / 2);
      place(wheel, sx + Math.cos(a) * 0.27, Y(0.038), sz + Math.sin(a) * 0.27);
      B.rubber.push(wheel);
    }
  }

  // ---- potted plants ---------------------------------------------------
  plant(6.05, -17.55, 1.0, 0);
  plant(-5.9, -7.55, 0.86, 1);
  plant(4.2, -7.35, 0.62, 2);

  function plant(px: number, pz: number, scale: number, variant: number) {
    const potH = 0.36 * scale;
    const potR = 0.26 * scale;
    const pot = lathe(
      [
        [0, 0],
        [potR * 0.66, 0],
        [potR * 0.7, 0.03 * scale],
        [potR * 0.95, potH * 0.86],
        [potR, potH],
        [potR * 1.06, potH],
        [potR * 1.06, potH - 0.05 * scale],
        [potR * 0.92, potH - 0.06 * scale],
        [potR * 0.88, 0.05 * scale],
        [0, 0.04 * scale],
      ],
      24,
    );
    place(pot, px, Y(0), pz);
    worldUV(pot, 1.6);
    B.pot.push(pot);

    const soil = lathe(
      [
        [0, 0.03 * scale],
        [potR * 0.7, 0.01 * scale],
        [potR * 0.86, 0],
        [potR * 0.9, -0.02 * scale],
        [0, -0.02 * scale],
      ],
      20,
    );
    place(soil, px, Y(potH - 0.04 * scale), pz);
    worldUV(soil, 3);
    B.soil.push(soil);

    const nLeaves = variant === 2 ? 11 : 16;
    for (let i = 0; i < nLeaves; i++) {
      const a = (i / nLeaves) * Math.PI * 2 + rng() * 0.5;
      const len = rangeOf(rng, 0.42, 0.86) * scale;
      const wid = len * rangeOf(rng, 0.2, 0.3);
      const tilt = rangeOf(rng, 0.5, 1.15);
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.quadraticCurveTo(wid * 0.55, len * 0.35, wid * 0.16, len);
      shape.quadraticCurveTo(-wid * 0.2, len * 0.4, 0, 0);
      const g = new THREE.ShapeGeometry(shape, 10);
      // curl the blade so it is not a flat card
      const gp = g.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < gp.count; k++) {
        const yv = gp.getY(k) / len;
        gp.setZ(k, -yv * yv * len * 0.32 + Math.abs(gp.getX(k)) * 0.5);
      }
      g.computeVertexNormals();
      const uvv = new Float32Array(gp.count * 2);
      for (let k = 0; k < gp.count; k++) {
        uvv[k * 2] = gp.getX(k) / (wid * 1.4) + 0.5;
        uvv[k * 2 + 1] = gp.getY(k) / len;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uvv, 2));
      place(g, px + Math.cos(a) * potR * 0.3, Y(potH - 0.02 * scale), pz + Math.sin(a) * potR * 0.3, tilt, -a + Math.PI / 2, 0);
      B.leaf.push(g);
    }
  }

  // ---- crates by the door ---------------------------------------------
  {
    const spots: [number, number, number, number][] = [
      [-6.0, -7.1, 0.52, 0.3],
      [-6.15, -7.35, 0.44, -0.5],
      [5.55, -8.35, 0.48, 0.18],
    ];
    let stackY = 0;
    for (let i = 0; i < spots.length; i++) {
      const [cx, cz, sz2, r] = spots[i];
      stackY = i === 1 ? spots[0][2] : 0;
      const g = bx(sz2, sz2 * 0.72, sz2 * 0.85, 0.028, 3);
      place(g, cx, Y(stackY + sz2 * 0.36), cz, 0, r);
      worldUV(g, 1.6);
      B.oak.push(g);
      for (const s of [-1, 1]) {
        const band = bx(sz2 + 0.012, 0.05, 0.03, 0.012, 2);
        place(band, cx, Y(stackY + sz2 * 0.36), cz, 0, r);
        band.translate(Math.sin(r) * s * sz2 * 0.4, 0, Math.cos(r) * s * sz2 * 0.4);
        B.steel.push(band);
      }
    }
  }

  // ---- noticeboard by the door ----------------------------------------
  {
    const nx = -2.6;
    const frame = bx(1.5, 0.98, 0.07, 0.022, 2);
    place(frame, nx, Y(1.72), IZ1 - 0.04);
    worldUV(frame, 1);
    B.oak.push(frame);
    const cork = bx(1.36, 0.86, 0.03, 0.012, 2);
    place(cork, nx, Y(1.72), IZ1 - 0.075);
    worldUV(cork, 2);
    B.pot.push(cork);
    for (let i = 0; i < 7; i++) {
      const g = bx(rangeOf(rng, 0.16, 0.26), rangeOf(rng, 0.2, 0.3), 0.008, 0.003, 2);
      place(g, nx + rangeOf(rng, -0.52, 0.52), Y(1.72 + rangeOf(rng, -0.28, 0.28)), IZ1 - 0.095, 0, 0, rangeOf(rng, -0.14, 0.14));
      worldUV(g, 2.6);
      B.paper.push(g);
      const pin = new THREE.SphereGeometry(0.012, 8, 6);
      place(pin, nx + rangeOf(rng, -0.5, 0.5), Y(1.72 + rangeOf(rng, -0.2, 0.28)), IZ1 - 0.105);
      B.brass.push(pin);
    }
  }

  // ---- coat pegs -------------------------------------------------------
  {
    const px = 3.3;
    const rail = bx(0.9, 0.1, 0.05, 0.018, 2);
    place(rail, px, Y(1.8), IZ1 - 0.03);
    worldUV(rail, 1);
    B.oak.push(rail);
    for (let i = 0; i < 4; i++) {
      const peg = cyl(0.018, 0.022, 0.1, 10);
      peg.rotateX(Math.PI / 2);
      place(peg, px - 0.32 + i * 0.21, Y(1.79), IZ1 - 0.08);
      B.brass.push(peg);
    }
    // a lab coat hanging on one of them
    const coat = bx(0.42, 0.9, 0.14, 0.06, 3);
    place(coat, px - 0.11, Y(1.28), IZ1 - 0.16, 0.04);
    worldUV(coat, 1.4);
    B.counter.push(coat);
    const shoulder = bx(0.36, 0.12, 0.13, 0.05, 3);
    place(shoulder, px - 0.11, Y(1.72), IZ1 - 0.14);
    worldUV(shoulder, 1.4);
    B.counter.push(shoulder);
  }

  /* ================================================================== */
  /* CONTACT OCCLUSION                                                  */
  /* ================================================================== */

  // North wall run
  contact(-5.55, IZ0 + 0.23, 1.2, 0.18, 0.3);
  contact(-3.2, IZ0 + 0.23, 1.05, 0.18, 0.3);
  contact(0, IZ0 + 0.28, 1.78, 0.24, 0.34);
  contact(4.175, IZ0 + 0.31, 2.05, 0.27, 0.32);
  // Side runs
  contact(-IX + 0.38, -12.75, 0.36, 4.86, 0.3);
  contact(IX - 0.4, -10.6, 0.38, 2.02, 0.3);
  contact(IX - 0.25, -17.3, 0.22, 0.97, 0.3);
  contact(IX - 0.35, -13.75, 0.32, 0.55, 0.28);
  // The starter table: a deeper pool, because it is the one thing with a real
  // shadow and the painted contact has to agree with it.
  contact(0, TABLE_Z, 1.3, 0.55, 0.42);
  // Loose furniture
  contact(-4.55, -12.35, 0.3, 0.3, 0.22);
  contact(6.05, -17.55, 0.27, 0.27, 0.2);
  contact(-5.9, -7.55, 0.24, 0.24, 0.18);
  contact(4.2, -7.35, 0.18, 0.18, 0.16);
  contact(-6.05, -7.2, 0.3, 0.28, 0.2);
  contact(5.55, -8.35, 0.26, 0.24, 0.2);

  /* ================================================================== */
  /* LIGHT FIXTURES                                                     */
  /* ================================================================== */

  const panelSpots: [number, number][] = [
    [-3.9, -15.8],
    [3.9, -15.0],
    [-3.8, -9.3],
    [3.8, -9.9],
  ];
  for (const [fx, fz] of panelSpots) {
    const housing = bx(1.42, 0.11, 0.44, 0.03, 3);
    place(housing, fx, Y(H - 0.34), fz);
    worldUV(housing, 1.4);
    B.steel.push(housing);
    const panelG = bx(1.3, 0.05, 0.34, 0.02, 2);
    place(panelG, fx, Y(H - 0.4), fz);
    B.panel.push(panelG);
    for (const s of [-1, 1]) {
      const rod = cyl(0.012, 0.012, 0.28, 8);
      place(rod, fx + s * 0.52, Y(H - 0.14), fz);
      B.steel.push(rod);
      const cap = cyl(0.045, 0.045, 0.025, 10);
      place(cap, fx + s * 0.52, Y(H - 0.012), fz);
      B.steel.push(cap);
    }
    // Warm halo painted onto the ceiling itself. The fills are downward cones
    // and never touch the plaster overhead, so without this the ceiling stays
    // the cold blue of the sky fill and the whole room reads chilly.
    const halo = new THREE.PlaneGeometry(3.0, 2.4);
    halo.rotateX(Math.PI / 2);
    place(halo, fx, Y(H - 0.02), fz);
    root.add(makeMesh(halo, matCeilGlow, false, false));
  }

  // hero pendant over the starter table
  {
    const hy = H - 0.62;
    const rod = cyl(0.016, 0.016, 0.62, 10);
    place(rod, 0, Y(H - 0.31), TABLE_Z);
    B.steel.push(rod);
    const canopy = lathe(
      [
        [0, 0],
        [0.1, 0],
        [0.11, 0.02],
        [0.06, 0.05],
        [0, 0.05],
      ],
      16,
    );
    place(canopy, 0, Y(H - 0.05), TABLE_Z);
    B.steel.push(canopy);

    const shade = cyl(0.17, 0.5, 0.34, 30, true);
    place(shade, 0, Y(hy - 0.17), TABLE_Z);
    worldUV(shade, 1.6);
    B.enamel.push(shade);
    const rim = new THREE.TorusGeometry(0.5, 0.022, 8, 32);
    rim.rotateX(Math.PI / 2);
    place(rim, 0, Y(hy - 0.34), TABLE_Z);
    B.brass.push(rim);
    const collar2 = cyl(0.075, 0.09, 0.07, 14);
    place(collar2, 0, Y(hy + 0.02), TABLE_Z);
    B.brass.push(collar2);
    const bulb = new THREE.SphereGeometry(0.085, 16, 12);
    place(bulb, 0, Y(hy - 0.19), TABLE_Z);
    B.bulb.push(bulb);
    const disc = new THREE.CircleGeometry(0.47, 28);
    disc.rotateX(Math.PI / 2);
    place(disc, 0, Y(hy - 0.335), TABLE_Z);
    B.panel.push(disc);

    const glow = new THREE.PlaneGeometry(2.0, 2.0);
    glow.rotateX(Math.PI / 2);
    place(glow, 0, Y(hy - 0.4), TABLE_Z);
    root.add(makeMesh(glow, matGlow, false, false));

    const halo = new THREE.PlaneGeometry(2.6, 2.6);
    halo.rotateX(Math.PI / 2);
    place(halo, 0, Y(H - 0.02), TABLE_Z);
    root.add(makeMesh(halo, matCeilGlow, false, false));
  }

  /* ================================================================== */
  /* DAYLIGHT SHAFTS                                                    */
  /* ================================================================== */

  {
    // Sun is south-east and 38° up, so light entering the east windows
    // travels west, north and down. Two crossed cards per beam.
    const dir = new THREE.Vector3(-0.527, -0.616, -0.586).normalize();
    // The shaft texture is opaque at v = 1, so +Y of each card must point back
    // at the window; the beam then dissolves before it reaches the floor.
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().negate(),
    );
    for (const wz of WIN_Z) {
      const start = new THREE.Vector3(IX - 0.08, Y((WIN_LO + WIN_HI) / 2), wz);
      const len = 3.4;
      const mid = start.clone().addScaledVector(dir, len / 2);
      for (let k = 0; k < 2; k++) {
        const g = new THREE.PlaneGeometry(WIN_HW * 2.0, len, 1, 6);
        if (k === 1) g.rotateY(Math.PI / 2);
        g.applyQuaternion(q);
        g.translate(mid.x, mid.y, mid.z);
        root.add(makeMesh(g, matShaft, false, false));
      }
      // pool of light where the beam meets the floor
      const t = (WIN_LO + WIN_HI) / 2 / 0.616;
      const hit = start.clone().addScaledVector(dir, t);
      const pool = new THREE.PlaneGeometry(2.7, 3.1);
      pool.rotateX(-Math.PI / 2);
      pool.translate(hit.x, Y(0.02), hit.z);
      root.add(makeMesh(pool, matGlow, false, false));
    }
  }

  /* ================================================================== */
  /* MESH ASSEMBLY                                                      */
  /* ================================================================== */

  function makeMesh(
    g: THREE.BufferGeometry,
    m: THREE.Material,
    cast: boolean,
    receive: boolean,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    return mesh;
  }

  const emit = (
    list: THREE.BufferGeometry[],
    mat: THREE.Material,
    name: string,
    cast = true,
    receive = true,
  ) => {
    const usable = list.filter((g) => g.attributes.position && g.attributes.position.count > 0);
    if (usable.length === 0) return;
    const mesh = new THREE.Mesh(mergeGeos(usable), mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    root.add(mesh);
  };

  emit(B.plaster, matPlaster, 'LabWalls', false, true);
  emit(B.ceiling, matCeiling, 'LabCeiling', false, true);
  emit(B.bead, matBead, 'LabWainscot', false, true);
  emit(B.trim, matTrim, 'LabTrim');
  emit(B.walnut, matWoodDark, 'LabWalnut');
  emit(B.oak, matWoodLight, 'LabOak');
  emit(B.steel, matMetal, 'LabSteel');
  emit(B.brass, matBrass, 'LabBrass');
  emit(B.enamel, matEnamel, 'LabEnamel', false, false);
  emit(B.counter, matCounter, 'LabCounter');
  emit(B.dais, matDais, 'LabDaises');
  emit(B.paper, matPaper, 'LabPaper');
  emit(B.label, matLabel, 'LabLabels');
  emit(B.pot, matPot, 'LabPots');
  emit(B.soil, matSoil, 'LabSoil', false, true);
  emit(B.leaf, matLeaf, 'LabLeaves', true, false);
  emit(B.rubber, matRubber, 'LabRubber');
  emit(B.felt, matFelt, 'LabFelt', false, true);
  emit(B.plateFace, matPlateFace, 'LabNameplates', false, true);
  emit(B.glass, matGlass, 'LabGlass', false, false);
  emit(B.liquid, matLiquid, 'LabLiquid', false, false);
  emit(B.winGlass, matWinGlass, 'LabWindowGlass', false, false);
  emit(B.backdrop, matBackdrop, 'LabBackdrop', false, false);
  emit(B.panel, matPanel, 'LabPanels', false, false);
  emit(B.bulb, matBulb, 'LabBulbs', false, false);
  emit(B.shelfGlow, matShelfGlow, 'LabShelfGlow', false, false);
  emit(B.caseGlow, matCaseGlow, 'LabCaseGlow', false, false);
  emit(B.caseBack, matCaseBack, 'LabCaseBack', false, false);

  // The scene fog is an outdoor aerial-perspective term keyed to the sky, and
  // the renderer applies it to every fog-enabled material regardless of where
  // the camera is. Indoors it washed the far wall out to a flat grey haze eight
  // metres from the player, which is both physically wrong and the thing that
  // was killing the depth of the room. Nothing in here is ever more than ~14 m
  // from the camera, so the whole interior simply opts out.
  // Contact pools last, so they multiply over the rug and the floor but sort
  // beneath the additive light pools.
  if (B.contact.length) {
    const cm = new THREE.Mesh(mergeGeos(B.contact), matContact);
    cm.name = 'LabContact';
    cm.renderOrder = -1;
    root.add(cm);
  }

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const fogged = m as THREE.Material & { fog?: boolean };
      if (fogged && fogged.fog) {
        fogged.fog = false;
        fogged.needsUpdate = true;
      }
    }
  });

  /* ================================================================== */
  /* LIGHTS                                                             */
  /* ================================================================== */

  const lights: THREE.Light[] = [];

  // Hero: a tight warm cone on the starter table. This is the only shadow
  // caster in the room, and the only one that needs to be — everything the
  // player looks at during the choice sits inside its frustum.
  const hero = new THREE.SpotLight(0xffdcaa, 30, 8, 0.8, 0.5, 2);
  hero.name = 'LabHeroSpot';
  hero.position.set(0, Y(H - 0.95), TABLE_Z);
  hero.target.position.set(0, Y(0.6), TABLE_Z);
  hero.castShadow = true;
  hero.shadow.mapSize.set(1024, 1024);
  hero.shadow.camera.near = 0.35;
  hero.shadow.camera.far = 6.5;
  hero.shadow.bias = -0.0006;
  hero.shadow.normalBias = 0.024;
  hero.shadow.radius = 2.4;
  hero.shadow.blurSamples = 10;
  hero.shadow.autoUpdate = false;
  root.add(hero);
  root.add(hero.target);
  lights.push(hero);

  // Fills are wide downward spots rather than point lights: a point light this
  // close to a ceiling burns a white disc into it that no exposure can fix,
  // whereas a cone aimed down never touches the plaster above it.
  const makeFill = (name: string, colour: number, power: number, fx: number, fz: number) => {
    const l = new THREE.SpotLight(colour, power, 24, 1.45, 0.6, 2);
    l.name = name;
    l.position.set(fx, Y(H - 0.45), fz);
    l.target.position.set(fx, Y(0), fz);
    l.castShadow = false;
    root.add(l);
    root.add(l.target);
    lights.push(l);
    return l;
  };
  makeFill('LabFillA', 0xffd2a0, 86, -3.9, -15.8);
  makeFill('LabFillB', 0xffd9b0, 78, 3.9, -15.0);

  for (const l of lights) l.visible = false;

  /* ================================================================== */
  /* COLLISION                                                          */
  /* ================================================================== */

  const yLo = Y(0);
  const yHi = Y(H);
  const addBox = (cx: number, cz: number, hx: number, hz: number, top: number, tag: string) =>
    ctx.collision.addBox(cx, cz, hx, hz, yLo, Y(top), 0, tag);

  // walls
  addBox(0, IZ0 - WT / 2, OX, WT / 2, H, 'lab.wall.n');
  addBox(0, IZ1 + WT / 2, OX, WT / 2, H, 'lab.wall.s');
  addBox(-IX - WT / 2, -12.5, WT / 2, (OZ1 - OZ0) / 2, H, 'lab.wall.w');
  addBox(IX + WT / 2, -12.5, WT / 2, (OZ1 - OZ0) / 2, H, 'lab.wall.e');
  // furniture
  addBox(0, TABLE_Z, 1.44, 0.66, 1.0, 'lab.table');
  addBox(-4.45, IZ0 + 0.28, 2.35, 0.3, 2.45, 'lab.bookcase');
  addBox(0, IZ0 + 0.32, 1.85, 0.34, 2.5, 'lab.cabinet');
  addBox(4.17, IZ0 + 0.36, 2.0, 0.36, 0.95, 'lab.lowcab');
  addBox(-IX + 0.4, -12.75, 0.42, 4.9, 0.98, 'lab.bench');
  addBox(IX - 0.42, -10.6, 0.44, 2.0, 0.85, 'lab.desk');
  addBox(IX - 0.25, -17.3, 0.28, 0.95, 2.2, 'lab.eaststore');
  addBox(IX - 0.35, -13.75, 0.35, 0.56, 1.05, 'lab.filing');
  addBox(6.05, -17.55, 0.3, 0.3, 0.9, 'lab.plant1');
  addBox(-5.9, -7.55, 0.26, 0.26, 0.8, 'lab.plant2');

  /* ================================================================== */
  /* INTERIOR / EXTERIOR STATE                                          */
  /* ================================================================== */

  const outdoorGround = ctx.collision.groundHeight;
  let inside = false;

  const inFootprint = (x: number, z: number, inset = 0.25) =>
    x > -IX + inset && x < IX - inset && z > IZ0 + inset && z < IZ1 - inset;

  ctx.collision.groundHeight = (x, z) => (inside && inFootprint(x, z, -0.2) ? FLOOR_Y : outdoorGround(x, z));

  // Outdoor rig, dimmed while inside. Atmosphere owns these; we only ever
  // change their intensity and restore the exact values we found.
  const sun = ctx.scene.getObjectByName('SunKey') as THREE.DirectionalLight | null;
  const skyFill = ctx.scene.getObjectByName('SkyFill') as THREE.HemisphereLight | null;
  const bounce = ctx.scene.getObjectByName('GroundBounce') as THREE.DirectionalLight | null;
  const orig = {
    sun: sun?.intensity ?? 0,
    skyFill: skyFill?.intensity ?? 0,
    skyFillSky: skyFill?.color.clone() ?? new THREE.Color(),
    skyFillGround: skyFill?.groundColor.clone() ?? new THREE.Color(),
    bounce: bounce?.intensity ?? 0,
    env: ctx.stage.environmentIntensity,
  };

  let shadowKick = 0;

  function setInside(v: boolean): void {
    if (inside === v) return;
    inside = v;
    root.visible = v;
    for (const l of lights) l.visible = v;
    if (v) {
      if (sun) {
        sun.intensity = 0;
        sun.shadow.autoUpdate = false;
      }
      if (skyFill) {
        // Re-tint rather than add a fourth light: indoors the "sky" is warm
        // bounced lamplight off a cream ceiling and the "ground" is the floor.
        skyFill.intensity = 1.12;
        skyFill.color.setHex(0xffd9ab);
        skyFill.groundColor.setHex(0x9a7a58);
      }
      if (bounce) bounce.intensity = 0;
      ctx.stage.environmentIntensity = 0.3;
      shadowKick = 4;
    } else {
      if (sun) {
        sun.intensity = orig.sun;
        sun.shadow.autoUpdate = true;
        sun.shadow.needsUpdate = true;
      }
      if (skyFill) {
        skyFill.intensity = orig.skyFill;
        skyFill.color.copy(orig.skyFillSky);
        skyFill.groundColor.copy(orig.skyFillGround);
      }
      if (bounce) bounce.intensity = orig.bounce;
      ctx.stage.environmentIntensity = orig.env;
    }
  }

  /* ---------------- fade overlay -------------------------------------- */

  const fader = document.createElement('div');
  fader.id = 'lab-fade';
  fader.style.cssText =
    'position:fixed;inset:0;background:#0d0b0a;opacity:0;pointer-events:none;z-index:40;' +
    'transition:opacity 260ms ease-in-out';
  document.body.appendChild(fader);

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const fade = async (to: number, ms: number) => {
    fader.style.transitionDuration = `${ms}ms`;
    fader.style.opacity = String(to);
    await wait(ms + 20);
  };

  /* ---------------- doorway ------------------------------------------- */

  const INTERIOR_SPAWN = new THREE.Vector3(DOOR_X, FLOOR_Y, IZ1 - 1.35);
  const doorAnchor = new THREE.Vector3(0.2, 0, -7.3);
  const exteriorReturn = new THREE.Vector3(0.2, 0, -5.9);

  function resolveDoor(): void {
    const ud = ctx.scene.userData as Record<string, unknown>;
    const found = (ud.labDoor ?? ud.labDoorAnchor ?? ud.labEntrance ?? null) as THREE.Vector3 | null;
    if (found && typeof (found as THREE.Vector3).x === 'number') {
      doorAnchor.set(found.x, found.y, found.z);
    }
    doorAnchor.y = outdoorGround(doorAnchor.x, doorAnchor.z) + 1.35;
    exteriorReturn.set(doorAnchor.x, 0, doorAnchor.z + 1.5);
    exteriorReturn.y = outdoorGround(exteriorReturn.x, exteriorReturn.z);
  }
  resolveDoor();
  ctx.events.on(EVENTS.WORLD_READY, () => resolveDoor());

  let busy = false;

  async function travel(enter: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    ctx.events.emit(EVENTS.CINEMATIC, true);
    await fade(1, 240);
    const p = getPlayer();
    setInside(enter);
    if (p) {
      if (enter) p.teleport(INTERIOR_SPAWN.clone(), 0);
      else p.teleport(exteriorReturn.clone(), Math.PI);
    }
    await wait(120);
    await fade(0, 320);
    ctx.events.emit(EVENTS.CINEMATIC, false);
    busy = false;
  }

  ctx.interaction.register({
    id: 'lab.door.enter',
    position: doorAnchor,
    radius: 3.1,
    label: "Enter Oak's Laboratory",
    enabled: () => !inside && !busy,
    onInteract: () => void travel(true),
  });

  ctx.interaction.register({
    id: 'lab.door.exit',
    position: new THREE.Vector3(DOOR_X, Y(1.3), IZ1 - 0.3),
    radius: 2.6,
    label: 'Step outside',
    enabled: () => inside && !busy,
    onInteract: () => void travel(false),
  });

  /* ---------------- per-frame ----------------------------------------- */

  const screenBase = matScreen.emissiveIntensity;

  ctx.tick((dt, elapsed) => {
    const p = getPlayer();
    if (p && !busy) {
      const pos = p.state.position;
      const aboveGround = pos.y > FLOOR_Y + 20;
      if (!inside && aboveGround && inFootprint(pos.x, pos.z, 0.55)) {
        // Something dropped the player inside the lab's footprint at town
        // level — the shell is solid there, so the only sane reading is
        // "they meant to be in the lab". Snap without a fade so scripted
        // camera moves and the capture harness land on a settled frame.
        setInside(true);
        p.teleport(new THREE.Vector3(pos.x, FLOOR_Y, pos.z));
      } else if (inside && aboveGround) {
        setInside(false);
      }
    }

    if (!inside) return;

    if (shadowKick > 0) {
      hero.shadow.needsUpdate = true;
      shadowKick--;
    }

    // Terminal: a slow scroll plus a faint refresh flicker.
    screenTex.offset.y = (screenTex.offset.y - dt * 0.014) % 1;
    matScreen.emissiveIntensity =
      screenBase * (1 + Math.sin(elapsed * 5.1) * 0.018 + Math.sin(elapsed * 27.3) * 0.008);
  });
}

/* ------------------------------------------------------------------ */
/* Cables                                                              */
/* ------------------------------------------------------------------ */

/** A drooping cable through three points. */
function cableGeo(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  radius: number,
): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([a, b, c], false, 'catmullrom', 0.6);
  return new THREE.TubeGeometry(curve, 18, radius, 6, false);
}
