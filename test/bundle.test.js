import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const root = new URL('..', import.meta.url).pathname;

test('the committed Symbiote bundle matches src/core', () => {
  execFileSync(process.execPath, [`${root}scripts/bundle.js`, '--check'], { stdio: 'pipe' });
});

test('the bundle runs standalone, with only browser globals', async () => {
  const ctx = {
    CompressionStream, DecompressionStream, TextEncoder, TextDecoder, btoa, atob, setTimeout, clearTimeout, console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(`${root}symbiote/taleforge.js`, 'utf8'), ctx);
  const TF = ctx.TaleForge;
  assert.ok(TF && TF.buildSlabs && TF.generatePlan && TF.traceImage);
  const plan = JSON.parse(readFileSync(`${root}examples/plans/dungeon.json`, 'utf8'));
  const build = await TF.buildSlabs(plan, new TF.Kit(TF.demoCatalog(), { style: 'dungeon' }));
  const slab = await TF.decodeSlab(build.chunks[0].text);
  assert.equal(slab.placements.length, build.placements.length);
  assert.match(build.svg, /^<svg/);
});
