#!/usr/bin/env node
/**
 * capture.mjs — deterministic screenshot harness for visual QA.
 *
 * Boots the game in headless Chromium with real GPU rasterisation, drives the
 * camera to a set of fixed shot positions, waits for the frame to settle, and
 * writes PNGs. Every visual review in this project reads these files, so the
 * shot list is the contract: same camera, same time of day, same seed, every
 * run. A change in a screenshot means a change in the art, never in the tool.
 *
 * Usage:
 *   node tools/capture.mjs                       # all shots -> shots/
 *   node tools/capture.mjs --shots exterior_wide,lab_door
 *   node tools/capture.mjs --out shots/round3 --width 1920 --height 1080
 *   node tools/capture.mjs --list
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * The shot list.
 *
 * `pos` is the player's feet position; the harness adds eye height. `yaw` is
 * radians, 0 = facing -Z. `pitch` positive looks up. These are chosen to cover
 * every surface a reviewer needs to judge: silhouettes, material response,
 * shadow contact, foliage density, and the two hero moments (town reveal and
 * the starter table).
 */
/*
 * Coordinates are derived from the built world, not guessed:
 *   terrain    x[-32,32]  z[-36,36]
 *   buildings  x[-13,14]  z[-19,7]     lab north (z~-14), houses z~0..6
 *   shoreline  z ~ -26 and northward
 *   treeline   x ~ +/-30
 *   lab interior floor y=-60, starter table at z=-13.4
 * Yaw convention: forward = (-sin(yaw), 0, -cos(yaw)). yaw 0 faces -Z (north).
 */
const SHOTS = [
  { id: 'town_reveal',   pos: [0, 0, 16],       yaw: 0.0,   pitch: -0.02, desc: 'South of town looking north up the path to Oak\'s lab — the establishing shot.' },
  { id: 'exterior_wide', pos: [0, 0, 25],       yaw: 0.0,   pitch: 0.01,  desc: 'Wide view of the whole town from the south approach.' },
  { id: 'player_house',  pos: [-2.5, 0, 7.0],   yaw: 0.85,  pitch: 0.03,  desc: 'Player house frontage — roof tiles, cladding, window glass.' },
  { id: 'rival_house',   pos: [2.5, 0, 7.0],    yaw: -0.85, pitch: 0.03,  desc: 'Rival house frontage.' },
  { id: 'lab_door',      pos: [0, 0, -4.5],     yaw: 0.0,   pitch: 0.10,  desc: 'Oak\'s lab entrance — the largest structure, read at close range.' },
  { id: 'grass_close',   pos: [-4.0, 0, 11.0],  yaw: 0.35,  pitch: -0.58, desc: 'Camera down at the turf — grass blades, ground material, contact AO.' },
  // Third framing. x=-15 sat inside the west treeline; x=-9 sat directly under
  // a canopy, so the frame filled with close-up leaf cards that read as
  // translucent sheets. This one stands on the open path south of the houses and
  // looks west across the garden fence, which is what the shot is meant to show.
  { id: 'fence_detail',  pos: [2.5, 0, 12.0],   yaw: 1.62,  pitch: -0.06, desc: 'Fence, props and town-edge dressing at conversational distance.' },
  { id: 'treeline',      pos: [-18.0, 0, -2.0], yaw: 1.10,  pitch: 0.14,  desc: 'Tree canopy and foliage translucency against the sky.' },
  { id: 'water_edge',    pos: [0, 0, -24.0],    yaw: 0.0,   pitch: -0.05, desc: 'Shoreline — water shading, foam, and the horizon.' },
  // Offset west and pushed further out to sea: standing on the axis at z=-25
  // put the lab's north wall ~6m away, filling the frame instead of reading as
  // a reverse establishing shot.
  { id: 'town_from_sea', pos: [-14.0, 0, -30.0], yaw: 2.75, pitch: 0.04, desc: 'Looking back south-east at the town from the beach — reverse establishing shot.' },
  { id: 'lab_interior',  pos: [0, -60, -8.0],   yaw: 0.0,   pitch: 0.0,   desc: 'Inside the lab, facing the starter table.', interior: true },
  { id: 'starter_table', pos: [0, -60, -11.4],  yaw: 0.0,   pitch: -0.14, desc: 'The three Poke Balls, close. The hero beauty shot.', interior: true },
  { id: 'backlit',       pos: [0, 0, 4.0],      yaw: -2.57, pitch: 0.20,  desc: 'Facing toward the sun — bloom, rim light, atmospheric scattering.' },

  // Staged shots: `stage` runs in the page before the grab, so the reveal can
  // be posed deterministically instead of depending on interaction timing.
  { id: 'starters_out',  pos: [0, -60, -11.4],  yaw: 0.0,   pitch: -0.10, interior: true,
    desc: 'All three starters released on the table — the hero shot of the whole game.',
    stage: 'all_released' },
  { id: 'starter_hero',  pos: [0, -60, -12.1],  yaw: 0.0,   pitch: -0.16, interior: true,
    desc: 'Close on the released trio — creature modelling and materials at reading distance.',
    stage: 'all_released' },
];

/**
 * Named staging routines, evaluated inside the page.
 * Keeping them here rather than in the game keeps the shot list self-contained.
 */
const STAGES = {
  all_released: () => {
    const dbg = window.__GAME__.world.root.userData.starterDebug;
    if (!dbg) return 'no starterDebug';
    for (let i = 0; i < 3; i++) dbg.setRelease(i, 1);
    return 'released 3';
  },
};

/**
 * Runs before every shot.
 *
 * The lab's ambient intro fires whenever the camera comes within 2.8m of the
 * starter table, which is exactly where the interior shots are framed — so
 * without this the dialogue panel covers the bottom third of the three hero
 * shots and stays open into the next one. Reviewers need to see the room and
 * the creatures; the dialogue has its own shot.
 */
const CLEAR_DIALOGUE = () => {
  const hud = window.__GAME__.hud;
  if (hud && hud.dialogue && hud.dialogue.isOpen) hud.dialogue.close();
};

function parseArgs(argv) {
  const args = { out: 'shots', width: 1600, height: 900, shots: null, url: 'http://127.0.0.1:5173/', settle: 1400 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--width') args.width = Number(argv[++i]);
    else if (a === '--height') args.height = Number(argv[++i]);
    else if (a === '--shots') args.shots = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--settle') args.settle = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.list) {
  for (const s of SHOTS) console.log(`${s.id.padEnd(16)} ${s.desc}`);
  process.exit(0);
}

const outDir = resolve(ROOT, args.out);
mkdirSync(outDir, { recursive: true });

const selected = args.shots ? SHOTS.filter((s) => args.shots.includes(s.id)) : SHOTS;
if (selected.length === 0) {
  console.error(`No shots matched: ${args.shots?.join(',')}`);
  process.exit(1);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    // Real GPU rasterisation in headless. Without these the WebGL context
    // either fails outright or falls back to a software path whose output
    // does not match what a player sees.
    '--use-gl=angle',
    '--use-angle=metal',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-frame-rate-limit',
    '--force-device-scale-factor=1',
  ],
});

const page = await browser.newPage({
  viewport: { width: args.width, height: args.height },
  deviceScaleFactor: 1,
});

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

console.log(`> ${args.url}`);
await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// Wait for the game to publish its handle, or surface the boot error.
const ready = await page
  .waitForFunction(() => window.__GAME__ !== undefined || document.querySelector('#app pre') !== null, {
    timeout: 90000,
  })
  .then(() => true)
  .catch(() => false);

if (!ready) {
  console.error('TIMEOUT: game never became ready.');
  console.error(consoleErrors.slice(0, 20).join('\n'));
  await browser.close();
  process.exit(2);
}

const bootError = await page.evaluate(() => {
  const pre = document.querySelector('#app pre');
  return pre ? pre.textContent : null;
});
if (bootError) {
  console.error('BOOT ERROR:\n' + bootError);
  await browser.close();
  process.exit(3);
}

// Let texture bakes, shader compiles and the first shadow update finish.
await page.waitForTimeout(args.settle);

const manifest = [];

/** Waits until the game handle exists again after a reload. */
async function waitForGame(timeout = 90000) {
  await page.waitForFunction(() => window.__GAME__ !== undefined, { timeout });
  await page.waitForTimeout(args.settle);
}

/**
 * Captures one shot.
 *
 * Retries on "Execution context was destroyed": Vite hot-reloads the page
 * whenever a source file changes, and several agents edit sources while
 * captures are running. Without this the harness fails spuriously and a
 * reviewer reads it as a broken build.
 */
async function captureShot(shot, attempt = 0) {
  try {
    await page.evaluate(
      ({ pos, yaw, pitch }) => {
        const g = window.__GAME__;
        const T = g.THREE;
        g.player.teleport(new T.Vector3(pos[0], pos[1], pos[2]), yaw);
        g.player.state.pitch = pitch;
        // Two manual updates: one to apply the transform, one to let any
        // per-frame smoothing settle onto the new pose.
        g.player.update(1 / 60);
        g.player.update(1 / 60);
      },
      shot,
    );

    if (shot.stage && STAGES[shot.stage]) {
      // Settle BEFORE staging. A teleport into the lab lands the player at the
      // interior floor height, but the outdoor ground sampler clamps them back
      // up until the interior's own tick notices and claims them — so staging
      // on the same frame as the teleport posed the scene while the camera was
      // still outdoors, and the shot came back empty.
      await page.evaluate(
        () => new Promise((res) => { let n = 0; const s = () => (++n >= 14 ? res() : requestAnimationFrame(s)); requestAnimationFrame(s); }),
      );

      const staged = await page.evaluate(STAGES[shot.stage]);
      if (typeof staged === 'string' && staged.startsWith('no ')) {
        console.log(`    (stage ${shot.stage}: ${staged})`);
      }
      // The release animation drives creature scale from its target, so give
      // it a few more frames to settle into the posed state before grabbing.
      await page.evaluate(
        () => new Promise((res) => { let n = 0; const s = () => (++n >= 10 ? res() : requestAnimationFrame(s)); requestAnimationFrame(s); }),
      );
    }

    // Render several frames so temporal effects (SMAA history, adaptive
    // resolution, wind phase) reach steady state before the grab.
    await page.evaluate(
      () =>
        new Promise((res) => {
          let n = 0;
          const step = () => (++n >= 12 ? res() : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
    );
    // Dismiss last, after the proximity trigger has had its frames to fire.
    await page.evaluate(CLEAR_DIALOGUE);
    await page.waitForTimeout(220);

    const buf = await page.screenshot({ type: 'png' });
    writeFileSync(resolve(outDir, `${shot.id}.png`), buf);

    const stats = await page.evaluate(() => {
      const g = window.__GAME__;
      const info = g.engine.renderer.info;
      return {
        fps: Math.round(g.engine.fps),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        textures: info.memory.textures,
        geometries: info.memory.geometries,
        programs: info.programs ? info.programs.length : 0,
      };
    });

    manifest.push({ ...shot, file: `${args.out}/${shot.id}.png`, stats });
    console.log(
      `  ${shot.id.padEnd(16)} ${stats.drawCalls} calls  ${(stats.triangles / 1000).toFixed(0)}k tris  ${stats.fps} fps`,
    );
  } catch (err) {
    const reloaded = /Execution context was destroyed|Target closed|detached/i.test(String(err));
    if (reloaded && attempt < 3) {
      console.log(`    (page reloaded mid-shot, retrying ${shot.id})`);
      await waitForGame();
      return captureShot(shot, attempt + 1);
    }
    throw err;
  }
}

for (const shot of selected) {
  await captureShot(shot);
}

writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify({ shots: manifest, consoleErrors }, null, 2));

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  console.log(consoleErrors.slice(0, 15).map((e) => '  ' + e).join('\n'));
}

await browser.close();
console.log(`\nWrote ${manifest.length} shot(s) to ${args.out}/`);
