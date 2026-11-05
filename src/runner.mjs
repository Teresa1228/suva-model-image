import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { readImage } from './index.mjs';
import { status, submit } from './modelscope.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const save = async (file, value) => {
  const tmp = file + '.' + randomUUID();
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
};

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// Register each contender before checking for live peers. Unique claims let us
// ignore a dead owner's claim without ever deleting a successor's active lock.
async function withLock(dir, fn) {
  const locks = path.join(dir, '.locks');
  await mkdir(locks, { recursive: true });
  const own = process.pid + '-' + randomUUID();
  await mkdir(path.join(locks, own));
  try {
    for (const name of await readdir(locks)) {
      if (name === own) continue;
      const pid = Number(name.split('-')[0]);
      if (Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid)) continue;
      throw new Error('已有进程正在执行这个任务，请稍后再恢复');
    }
    return await fn();
  } finally {
    await rm(path.join(locks, own), { recursive: true, force: true });
  }
}

function childName(index, label) {
  const safe = String(label || 'task').replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 64);
  return String(index).padStart(2, '0') + '-' + safe;
}

async function initTask(dir, plan, meta) {
  const sources = [];
  for (const [index, file] of (plan.files || []).entries()) {
    const source = 'source-' + (index + 1) + path.extname(file);
    await copyFile(file, path.join(dir, source));
    await readImage(path.join(dir, source));
    sources.push(source);
  }
  await save(path.join(dir, 'task.json'), {
    schema: 2, ...meta, state: 'ready', sources, prompt: plan.userPrompt ?? plan.prompt,
    finalPrompt: plan.prompt, model: plan.model, loras: plan.loras ?? null, size: plan.size,
    recipe: plan.recipe ?? null, cost: plan.cost ?? null, error: null,
  });
}

function imageExt(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('结果不是支持的图片格式');
}

async function download(dir, url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('结果下载失败 (HTTP ' + response.status + ')');
  const bytes = Buffer.from(await response.arrayBuffer());
  const output = 'result.' + imageExt(bytes);
  const tmp = path.join(dir, output + '.' + randomUUID());
  await writeFile(tmp, bytes);
  await rename(tmp, path.join(dir, output));
  return output;
}

async function runTask(dir, { pollMax = 90, pollIntervalMs = 3000 } = {}) {
  const record = path.join(dir, 'task.json');
  const task = await readJSON(record);
  if (task.schema == null) {
    // Version 0.1.0 had one fixed model and one optional jewelry adapter.
    // These values describe the original submission, independent of today's config.
    Object.assign(task, {
      schema: 2, model: 'Qwen/Qwen-Image-2.1-Turbo',
      loras: task.command === 'retouch' || task.retouch ? 'yuyou80/refine_jewel_qwen2.1' : null,
      sources: task.source ? [task.source] : [], size: '1024x1024',
    });
    await save(record, task);
  }
  async function update(changes) {
    Object.assign(task, changes);
    if (['succeeded', 'failed', 'unknown'].includes(changes.state)) task.finishedAt = Date.now();
    await save(record, task);
    return task;
  }
  if (task.output && task.state === 'succeeded') {
    try { await access(path.join(dir, task.output)); return task; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (task.state === 'failed' || task.state === 'unknown') return task;
  if (!task.id && task.state !== 'ready') {
    return update({ state: 'unknown', errorCode: 'unknown_submit', error: '提交后没有已确认的魔搭任务 ID，请人工核实原提交。' });
  }
  const token = process.env.MODELSCOPE_TOKEN;
  if (!token?.trim()) throw new Error('请配置 MODELSCOPE_TOKEN');
  if (!task.id) {
    const images = await Promise.all(task.sources.map(file => readImage(path.join(dir, file))));
    await update({ state: 'submitting', submittedAt: new Date().toISOString() });
    let id;
    try {
      id = await submit({ model: task.model, loras: task.loras, size: task.size, prompt: task.finalPrompt, images, token });
    } catch (error) {
      const unknown = !error.code || error.code === 'unknown_submit';
      return update({ state: unknown ? 'unknown' : 'failed', errorCode: error.code || 'unknown_submit', error: error.message });
    }
    await update({ id, state: 'pending', error: null });
  }
  for (let i = 0; i < pollMax; i++) {
    let result;
    try { result = await status({ id: task.id, token }); }
    catch (error) {
      return update({ state: 'pending', errorCode: error.code || 'status', error: error.message });
    }
    if (result.state === 'failed') {
      return update({ state: 'failed', errorCode: result.code || 'task_failed', error: result.error || '任务失败' });
    }
    if (result.state === 'succeeded') {
      let output;
      try { output = await download(dir, result.url); }
      catch (error) { return update({ state: 'pending', errorCode: 'download', error: error.message }); }
      return update({ state: 'succeeded', output, errorCode: null, error: null });
    }
    if (i + 1 < pollMax) await wait(pollIntervalMs);
  }
  return update({ state: 'pending', error: '仍在排队或生成中，请恢复原任务。' });
}

function singleResult(dir, task) {
  if (task.state === 'succeeded') return path.join(dir, task.output);
  throw new Error(task.error || '任务未完成');
}

async function runBatch(dir, batch) {
  const record = path.join(dir, 'batch.json');
  batch.state = 'running';
  await save(record, batch);
  const rows = [];
  let stop = false;
  for (const child of batch.children) {
    const childDir = path.join(dir, child.dir);
    let task = await readJSON(path.join(childDir, 'task.json'));
    if (!stop) {
      const startedEarlier = ['failed', 'unknown'].includes(task.state);
      if (task.state === 'ready' && batch.lastFinishedAt) {
        const remaining = batch.delayMs - (Date.now() - batch.lastFinishedAt);
        if (remaining > 0) await wait(remaining);
      }
      task = await runTask(childDir, batch);
      if (task.finishedAt) batch.lastFinishedAt = Math.max(batch.lastFinishedAt || 0, task.finishedAt);
      // Pending tasks still occupy a provider slot, so leave all later children ready.
      stop = task.state === 'pending' || (!startedEarlier && (task.state === 'unknown' ||
        (task.state === 'failed' && (batch.onError === 'stop' || task.errorCode === 'insufficient_balance'))));
    }
    child.state = task.state;
    let output = null;
    if (task.state === 'succeeded') {
      output = path.join(dir, child.dir + path.extname(task.output));
      await copyFile(path.join(childDir, task.output), output);
    }
    rows.push({ lora: child.lora, key: child.key, state: task.state, path: output, error: task.error ?? null });
    await save(record, batch);
  }
  batch.state = stop || rows.some(row => row.state === 'ready' || row.state === 'pending') ? 'stopped' : 'done';
  await save(record, batch);
  const summary = { batch: batch.batch, state: batch.state, children: rows };
  await save(path.join(dir, 'summary.json'), summary);
  return summary;
}

export async function startRun({ folder, plans, command, recipeSet, delayMs = 5000, onError = 'stop', pollMax = 90, pollIntervalMs = 3000 }) {
  if (!plans.length || (command !== 'batch' && plans.length !== 1)) throw new Error('任务列表无效');
  if (!process.env.MODELSCOPE_TOKEN?.trim()) throw new Error('请配置 MODELSCOPE_TOKEN');
  const key = randomUUID();
  const dir = path.join(folder, key);
  await mkdir(dir);
  return withLock(dir, async () => {
    if (command !== 'batch') {
      await initTask(dir, plans[0], { key, command, pollMax, pollIntervalMs, batch: null, index: null });
      console.log('本地任务 ID ' + key);
      return singleResult(dir, await runTask(dir, { pollMax, pollIntervalMs }));
    }
    const batch = {
      schema: 2, batch: key, recipeSet: recipeSet ?? null, prompt: plans[0].userPrompt ?? plans[0].prompt,
      delayMs, onError, pollMax, pollIntervalMs, state: 'ready', children: [],
    };
    for (const [i, plan] of plans.entries()) {
      const child = { key: randomUUID(), lora: plan.label, dir: childName(i + 1, plan.label), state: 'ready' };
      const childDir = path.join(dir, child.dir);
      await mkdir(childDir);
      await initTask(childDir, plan, { key: child.key, command: plan.files?.length ? 'edit' : 'generate', batch: key, index: i + 1 });
      batch.children.push(child);
    }
    await save(path.join(dir, 'batch.json'), batch);
    console.log('本地批次 ID ' + key);
    return runBatch(dir, batch);
  });
}

export async function resumeRun({ folder, key }) {
  if (!uuid.test(key)) throw new Error('本地任务 ID 无效');
  const dir = path.join(folder, key);
  await access(dir);
  return withLock(dir, async () => {
    let batch;
    try { batch = await readJSON(path.join(dir, 'batch.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (batch) return runBatch(dir, batch);
    const task = await readJSON(path.join(dir, 'task.json'));
    return singleResult(dir, await runTask(dir, task));
  });
}
