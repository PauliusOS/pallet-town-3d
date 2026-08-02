#!/usr/bin/env node
/**
 * shoot-battle.mjs — deterministic screenshot harness for the battle system.
 *
 * Boots the game headless, drives `scene.userData.battleDebug` through a
 * scripted battle, and freezes the battle clock (`setTimeScale(0)`) at named
 * markers so the same frame is captured every run.
 *
 * Usage:
 *   node tools/shoot-battle.mjs                        # all shots -> shots/battle
 *   node tools/shoot-battle.mjs --shots battle_intro,attack_impact
 *   node tools/shoot-battle.mjs --url http://127.0.0.1:5323/ --out shots/battle_r2
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    out: 'shots/battle',
    width: 1600,
    height: 900,
    shots: null,
    url: 'http://127.0.0.1:5323/?auto',
    settle: 1400,
  };
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
  if (!args.url.includes('auto') && !args.url.includes('capture')) {
    args.url += (args.url.includes('?') ? '&' : '?') + 'auto';
  }
  return args;
}

const args = parseArgs(process.argv);

/**
 * The battle shot list. Each shot is a small script of steps:
 *   teleport   — place the player in the overworld
 *   start      — begin a battle (opts are deterministic)
 *   waitState  — poll battleDebug.state() for a substring
 *   freezeAt   — waitState + a settle-frame count, then timeScale 0
 *   frames     — let N frames render
 *   ts         — set timeScale
 *   act        — run an arbitrary named action
 *
 * Battles are chained: `endBattle` fully unwinds one before the next starts.
 */
const SHOTS = [
  {
    id: 'grass_shelf',
    desc: 'Overworld view of the tall-grass shelf from the town side.',
    steps: [{ teleport: { pos: [0.8, 0, 15.5], yaw: Math.PI, pitch: -0.05 } }, { frames: 24 }],
  },
  {
    id: 'grass_wade',
    desc: 'Standing inside the tall grass, blades at waist height.',
    steps: [{ teleport: { pos: [-6, 0, 22], yaw: 2.6, pitch: -0.18 } }, { frames: 24 }],
  },
  {
    id: 'battle_intro',
    desc: 'Wild mon reveal — low dramatic framing under the rim light.',
    steps: [
      { start: { wild: 'pidgey', seed: 7 } },
      { freezeAt: { state: 'intro:intro-reveal', ms: 700 } },
    ],
  },
  {
    id: 'battle_sendout',
    desc: 'Poke Ball send-out burst on the player pad.',
    steps: [
      { ts: 1 },
      { freezeAt: { state: ':send-out-burst', ms: 140 } },
    ],
  },
  {
    id: 'battle_wide',
    desc: 'Idle wide two-shot with full battle UI.',
    steps: [{ ts: 1 }, { waitState: 'menu:menu' }, { frames: 50 }, { freeze: true }],
  },
  {
    id: 'battle_menu',
    desc: 'Action menu focused (FIGHT/RUN).',
    steps: [{ ts: 1 }, { frames: 12 }, { freeze: true }],
  },
  {
    id: 'battle_moves',
    desc: 'Move list open with type chips and PP.',
    steps: [
      { ts: 1 },
      { act: 'openMoves' },
      { waitState: 'moves:moves' },
      { frames: 16 },
      { freeze: true },
    ],
  },
  {
    id: 'attack_windup',
    desc: 'Attacker punch-in during the wind-up.',
    steps: [
      { ts: 1 },
      { act: 'useMove', index: 2 }, // ember
      { freezeAt: { state: ':windup', ms: 240 } },
    ],
  },
  {
    id: 'attack_impact',
    desc: 'Impact frame — hit flash, impact star, screen shake.',
    steps: [{ ts: 1 }, { freezeAt: { state: ':impact', ms: 30 } }],
  },
  {
    id: 'hp_drain',
    desc: 'Enemy HP bar mid-drain.',
    steps: [{ ts: 1 }, { freezeAt: { state: ':drain', ms: 140 } }],
  },
  {
    id: 'faint',
    desc: 'The wild mon topples — low-angle faint shot.',
    steps: [
      { ts: 1 },
      { act: 'grindToFaint' },
      { freezeAt: { state: ':faint', ms: 560 } },
    ],
  },
  {
    id: 'victory',
    desc: 'Victory beat — the winner celebrates.',
    steps: [{ ts: 1 }, { freezeAt: { state: 'outcome:victory', ms: 600 } }],
  },
  {
    id: 'super_effective',
    desc: "Super-effective hit — message + heavy FX (fresh battle vs bulbasaur).",
    steps: [
      { ts: 1 },
      { act: 'endBattle' },
      { waitState: 'idle:' },
      { start: { wild: 'bulbasaur', seed: 21 } },
      { act: 'skipToMenu' },
      { waitState: 'menu:menu' },
      { act: 'useMove', index: 2 }, // ember vs grass
      { freezeAt: { state: ':message-eff', ms: 140 } },
    ],
  },
];

const ACTIONS = {
  openMoves: () => {
    window.__GAME__.world.root.userData.battleDebug.choose('fight');
  },
  useMove: (index) => {
    window.__GAME__.world.root.userData.battleDebug.move(index ?? 0);
  },
  skipToMenu: () => {
    window.__GAME__.world.root.userData.battleDebug.skipToMenu();
  },
  grindToFaint: () => {
    // Fast-forward turns until the wild mon faints. resolveTurn only queues
    // while in menu, so poll from inside the page.
    const dbg = window.__GAME__.world.root.userData.battleDebug;
    dbg.setTimeScale(8);
    const drive = () => {
      const st = dbg.state();
      if (st.includes(':faint') || st.startsWith('outcome') || st.startsWith('idle')) {
        dbg.setTimeScale(1);
        return;
      }
      if (st.startsWith('menu')) dbg.resolveTurn();
      requestAnimationFrame(drive);
    };
    drive();
  },
  endBattle: () => {
    // Fully unwind the current battle by running away at high speed.
    const dbg = window.__GAME__.world.root.userData.battleDebug;
    dbg.setTimeScale(20);
    const drive = () => {
      const st = dbg.state();
      if (st.startsWith('idle')) {
        dbg.setTimeScale(1);
        return;
      }
      if (st.startsWith('menu')) dbg.choose('run');
      requestAnimationFrame(drive);
    };
    drive();
  },
};

if (args.list) {
  for (const s of SHOTS) console.log(`${s.id.padEnd(18)} ${s.desc}`);
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

const ready = await page
  .waitForFunction(
    () => window.__GAME__ !== undefined || document.querySelector('#app pre') !== null,
    null,
    { timeout: 150000 },
  )
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

await page.waitForTimeout(args.settle);

const frames = (n) =>
  page.evaluate(
    (count) =>
      new Promise((res) => {
        let i = 0;
        const step = () => (++i >= count ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );

async function runStep(step) {
  if (step.teleport) {
    await page.evaluate(({ pos, yaw, pitch }) => {
      const g = window.__GAME__;
      const T = g.THREE;
      g.player.teleport(new T.Vector3(pos[0], pos[1], pos[2]), yaw);
      g.player.state.pitch = pitch ?? 0;
      g.player.update(1 / 60);
      g.player.update(1 / 60);
    }, step.teleport);
    return;
  }
  if (step.start) {
    await page.evaluate((opts) => {
      window.__GAME__.world.root.userData.battleDebug.start(opts);
    }, step.start);
    return;
  }
  if (step.waitState) {
    await page.waitForFunction(
      (want) => window.__GAME__.world.root.userData.battleDebug.state().includes(want),
      step.waitState,
      { timeout: 60000 },
    );
    return;
  }
  if (step.frames) {
    await frames(step.frames);
    return;
  }
  if (step.freezeAt) {
    // Atomic in-page freeze: at unthrottled headless frame rates the node
    // round-trip after waitState overshoots the marker by dozens of frames.
    await page.evaluate(
      ({ want, ms }) =>
        new Promise((res, rej) => {
          const dbg = window.__GAME__.world.root.userData.battleDebug;
          let matchedAt = -1;
          const t0 = performance.now();
          const tick = () => {
            const now = performance.now();
            if (now - t0 > 60000) {
              rej(new Error(`freezeAt timeout: ${want}, last state ${dbg.state()}`));
              return;
            }
            if (matchedAt < 0 && dbg.state().includes(want)) matchedAt = now;
            if (matchedAt >= 0 && now - matchedAt >= ms) {
              dbg.setTimeScale(0);
              res(undefined);
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        }),
      { want: step.freezeAt.state, ms: step.freezeAt.ms ?? 0 },
    );
    await frames(6); // settle SMAA on the frozen frame
    return;
  }
  if (step.freeze) {
    await page.evaluate(() => window.__GAME__.world.root.userData.battleDebug.setTimeScale(0));
    await frames(6); // let SMAA/adaptive-res settle on the frozen frame
    return;
  }
  if (step.ts !== undefined) {
    await page.evaluate((k) => window.__GAME__.world.root.userData.battleDebug.setTimeScale(k), step.ts);
    return;
  }
  if (step.act) {
    await page.evaluate(ACTIONS[step.act], step.index ?? undefined);
    return;
  }
}

const manifest = [];

for (const shot of selected) {
  try {
    for (const step of shot.steps) await runStep(step);
    const buf = await page.screenshot({ type: 'png' });
    writeFileSync(resolve(outDir, `${shot.id}.png`), buf);

    const stats = await page.evaluate(() => {
      const g = window.__GAME__;
      const info = g.engine.renderer.info;
      const c = g.engine.camera;
      return {
        state: g.world.root.userData.battleDebug.state(),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        fps: Math.round(g.engine.fps),
        cam: c.position.toArray().map((v) => Math.round(v * 100) / 100),
        camOk: [c.position, c.quaternion].every((o) => o.toArray().every(Number.isFinite)),
      };
    });
    manifest.push({ id: shot.id, desc: shot.desc, file: `${args.out}/${shot.id}.png`, stats });
    console.log(
      `  ${shot.id.padEnd(18)} ${stats.state.padEnd(22)} ${stats.drawCalls} calls  ${(stats.triangles / 1000).toFixed(0)}k tris`,
    );
  } catch (err) {
    console.error(`  ${shot.id} FAILED: ${String(err).slice(0, 300)}`);
    manifest.push({ id: shot.id, error: String(err) });
  }
}

writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify({ shots: manifest, consoleErrors }, null, 2));

if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  console.log(consoleErrors.slice(0, 15).map((e) => '  ' + e).join('\n'));
}

await browser.close();
console.log(`\nWrote ${manifest.length} shot(s) to ${args.out}/`);
