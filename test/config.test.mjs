import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig, resolve } from '../src/config.mjs';

const bundled = new URL('../config/default.json', import.meta.url);
const generate = { mode: 'generate', prompt: '一盏路灯' };

async function customFile(t, change) {
  const config = await loadConfig(bundled);
  change(config);
  const dir = await mkdtemp(join(tmpdir(), 'suva-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'models.json');
  await writeFile(file, JSON.stringify(config));
  return file;
}

test('an explicit JSON configuration supplies the upstream model, size and cost', async t => {
  const file = await customFile(t, config => {
    config.models['qwen21-turbo'].id = 'owner/alternate-model';
    config.models['qwen21-turbo'].cost = 0.5;
    config.models['qwen21-turbo'].sizes.push('768x1024');
    config.recipes['gen-default'].size = '768x1024';
  });
  const config = await loadConfig(file);
  const plan = resolve(config, generate);
  assert.equal(plan.model, 'owner/alternate-model');
  assert.equal(plan.size, '768x1024');
  assert.equal(plan.cost, 0.5);
  assert.equal(resolve(config, { ...generate, size: '1024x1024' }).size, '1024x1024');
});

test('stacked LoRAs preserve weights and reject invalid totals and excessive counts', async () => {
  const config = await loadConfig(bundled);
  config.loras.ink = { id: 'studio/ink', baseFamily: 'qwen-image-2.1' };
  const plan = resolve(config, { ...generate, loras: ['refine-jewel:0.65', 'ink:0.35'] });
  assert.deepEqual(plan.loras, { 'yuyou80/refine_jewel_qwen2.1': 0.65, 'studio/ink': 0.35 });
  assert.throws(() => resolve(config, { ...generate, loras: ['refine-jewel:0.65', 'ink:0.5'] }), /权重之和/);
  assert.throws(() => resolve(config, { ...generate, loras: ['refine-jewel:-0.5', 'ink:0.5'] }), /权重/);
  const seven = Array.from({ length: 7 }, (_, i) => 'studio/style-' + i + ':' + 1 / 7);
  assert.throws(() => resolve(config, { ...generate, loras: seven }), /6/);
});

test('force permits family mismatch and reports it but cannot bypass a prohibited LoRA field', async () => {
  const config = await loadConfig(bundled);
  config.loras.ink = { id: 'studio/ink', baseFamily: 'different-family' };
  const opts = { ...generate, loras: ['ink'] };
  assert.throws(() => resolve(config, opts), { code: 'incompatible' });
  const plan = resolve(config, { ...opts, force: true });
  assert.equal(plan.loras, 'studio/ink');
  assert.match(plan.warnings.join('\n'), /不兼容/);
  assert.throws(() => resolve(config, { ...opts, mode: 'edit', imageCount: 1, force: true }), { code: 'incompatible' });
});

test('plain edit allows one through three inputs, generation and jewelry retouch enforce their own counts', async () => {
  const config = await loadConfig(bundled);
  const edit = { mode: 'edit', prompt: '同一系列构图' };
  for (const imageCount of [1, 2, 3]) assert.equal(resolve(config, { ...edit, imageCount }).recipe, 'edit-plain');
  for (const imageCount of [0, 4]) assert.throws(() => resolve(config, { ...edit, imageCount }));
  assert.throws(() => resolve(config, { ...generate, imageCount: 1 }));
  assert.equal(resolve(config, { mode: 'retouch', imageCount: 1 }).recipe, 'retouch-jewel');
  assert.throws(() => resolve(config, { mode: 'retouch', imageCount: 2 }));
});

test('unregistered upstream IDs report limitations and unknown cost, unresolved aliases fail', async () => {
  const config = await loadConfig(bundled);
  const plan = resolve(config, { ...generate, model: 'studio/model', loras: ['studio/style'] });
  assert.equal(plan.model, 'studio/model');
  assert.equal(plan.loras, 'studio/style');
  assert.equal(plan.cost, null);
  assert.match(plan.warnings.join('\n'), /studio\/model/);
  assert.match(plan.warnings.join('\n'), /studio\/style/);
  assert.throws(() => resolve(config, { ...generate, model: 'unregistered-alias' }), { code: 'config' });
});

test('loading validates references in unused recipes and sequential sets', async t => {
  const cases = [
    config => { config.recipes.unused = { mode: 'generate', model: 'unregistered' }; },
    config => { config.recipes.unused = { mode: 'generate', model: 'qwen21-turbo', loras: ['studio/unregistered'] }; },
    config => { config.recipeSets.unused = { mode: 'generate', model: 'qwen21-turbo', loras: ['missing-alias'] }; },
  ];
  for (const change of cases) {
    const file = await customFile(t, change);
    await assert.rejects(loadConfig(file), { code: 'config' });
  }
});
