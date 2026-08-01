#!/usr/bin/env node
/**
 * shoot-creature.mjs — turntable capture for the creature viewer.
 *
 * Renders each requested subject from several angles onto a neutral studio
 * set. Reviewing characters here rather than in-game is deliberate: the town's
 * grade and clutter mask precisely the modelling faults these shots exist to
 * expose.
 *
 *   node tools/shoot-creature.mjs                              # everything
 *   node tools/shoot-creature.mjs --subject charmander
 *   node tools/shoot-creature.mjs --subject all --angles front,side
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = { out: 'shots/creatures', width: 1000, height: 1000, url: 'http://127.0.0.1:5173/viewer.html', bg: 'studio' };
let subjects = ['bulbasaur', 'charmander', 'squirtle', 'pidgey', 'rattata', 'pokeball', 'pokeball_open', 'all'];
let angles = ['front', 'three_quarter', 'side', 'back'];

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--subject') subjects = process.argv[++i].split(',');
  else if (a === '--url') args.url = process.argv[++i];
  else if (a === '--angles') angles = process.argv[++i].split(',');
  else if (a === '--out') args.out = process.argv[++i];
  else if (a === '--width') args.width = Number(process.argv[++i]);
  else if (a === '--height') args.height = Number(process.argv[++i]);
  else if (a === '--bg') args.bg = process.argv[++i];
}

const outDir = resolve(ROOT, args.out);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: args.width, height: args.height }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

for (const subject of subjects) {
  // 'all' is a lineup shot; a single three-quarter read is the useful one.
  const angleList = subject === 'all' ? ['three_quarter', 'front'] : angles;

  for (const angle of angleList) {
    const url = `${args.url}?subject=${subject}&angle=${angle}&bg=${args.bg}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const ok = await page
      .waitForFunction(() => window.__VIEWER__ !== undefined, { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      console.error(`  FAILED ${subject}/${angle} — viewer never became ready`);
      console.error(errors.slice(-5).join('\n'));
      continue;
    }

    // Settle, grab, and read stats. Retried because Vite hot-reloads the page
    // whenever a source file changes, and sculptors edit sources while their
    // own captures are in flight; without this the harness fails spuriously
    // and reads as a broken model.
    let tris = 0;
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      try {
        await page.waitForFunction(() => window.__VIEWER__ !== undefined, { timeout: 60000 });
        await page.waitForTimeout(900);
        await page.evaluate(
          () => new Promise((res) => { let n = 0; const s = () => (++n >= 20 ? res() : requestAnimationFrame(s)); requestAnimationFrame(s); }),
        );
        const buf = await page.screenshot({ type: 'png' });
        writeFileSync(resolve(outDir, `${subject}_${angle}.png`), buf);
        tris = await page.evaluate(() => window.__VIEWER__.triangles());
        done = true;
      } catch (err) {
        if (!/Execution context was destroyed|Target closed|detached/i.test(String(err))) throw err;
        console.log(`    (page reloaded, retrying ${subject}/${angle})`);
      }
    }
    if (!done) {
      console.error(`  FAILED ${subject}/${angle} — page kept reloading`);
      continue;
    }
    console.log(`  ${subject}_${angle}`.padEnd(30), `${(tris / 1000).toFixed(1)}k tris`);
  }
}

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  console.log(errors.slice(0, 10).map((e) => '  ' + e).join('\n'));
}

await browser.close();
console.log(`\nWrote creature shots to ${args.out}/`);
