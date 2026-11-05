import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { editImage, generateImage, readImage, retouchImage, status, submit } from '../src/index.mjs';

const token = 'mock-token';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1b8AAAAASUVORK5CYII=';
const defaultModel = 'Qwen/Qwen-Image-2.1-Turbo';
const parameters = { model: defaultModel, prompt: 'a ring', size: '1024x1024', token };

async function imageFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'suva-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'input.png');
  await writeFile(file, Buffer.from(image.split(',')[1], 'base64'));
  return file;
}

test('默认生图和珠宝精修保留旧版请求体，普通编辑支持多张原图', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1/images/generations');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('authorization'), 'Bearer ' + token);
    assert.equal(headers.get('X-ModelScope-Async-Mode'), 'true');
    requests.push(JSON.parse(options.body));
    return Response.json({ task_id: 'task-' + requests.length });
  });
  const file = await imageFile(t);
  const prompt = '梦幻森林中的一座灯塔';
  assert.equal(await generateImage({ prompt, token }), 'task-1');
  assert.equal(await retouchImage({ file, token }), 'task-2');
  assert.equal(await editImage({ files: [file, file], recipe: 'edit-plain', prompt, token }), 'task-3');
  assert.deepEqual(requests[0], { model: defaultModel, prompt, size: '1024x1024' });
  assert.deepEqual(requests[1], { model: defaultModel, prompt: '精修图片中的饰品\n保留原有材质、颜色与镶嵌结构',
    size: '1024x1024', loras: 'yuyou80/refine_jewel_qwen2.1', image_url: [image] });
  assert.deepEqual(requests[2].image_url, [image, image]);
  assert.equal(requests[2].model, 'Qwen/Qwen-Image-Edit-2509');
  assert.ok(!('loras' in requests[2]));
});

test('原图超过上限或格式错误时拒绝读取', async (t) => {
  const file = await imageFile(t);
  await writeFile(file, 'bad');
  await assert.rejects(readImage(file), /PNG/);
  await truncate(file, 5 * 1024 * 1024 + 1);
  await assert.rejects(readImage(file), /5 MiB/);
});

test('已明确拒绝的 429 或 503 使用 15、30、60 秒退避', async (t) => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (done, ms) => { delays.push(ms); done(); });
  const responses = [
    Response.json({}, { status: 429 }),
    Response.json({ accepted: false }, { status: 503 }),
    Response.json({}, { status: 429 }),
    Response.json({ task_id: 'abc' }),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  assert.equal(await submit(parameters), 'abc');
  assert.deepEqual(delays, [15_000, 30_000, 60_000]);
});

test('提交结果不明时只提交一次，余额不足优先于限流', async (t) => {
  const results = [
    new Error('network broke'),
    Response.json({}, { status: 503 }),
    Response.json({}),
    Response.json({ error: { message: 'Insufficient balance' } }, { status: 429 }),
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const result = results[calls++];
    if (result instanceof Error) throw result;
    return result;
  });
  for (const code of ['unknown_submit', 'unknown_submit', 'unknown_submit', 'insufficient_balance']) {
    await assert.rejects(submit(parameters), { code });
  }
  assert.equal(calls, 4);
});

test('查询原任务区分排队、成功、失败和不可信的下载地址', async (t) => {
  const url = 'https://modelscope.cn/result.png';
  const replies = [
    { task_status: 'PENDING' },
    { task_status: 'SUCCEED', output_images: [url] },
    { task_status: 'FAILED' },
    { task_status: 'FAILED', error: { code: 'InsufficientBalance' } },
    { task_status: 'SUCCEED', output_images: ['https://attacker.invalid/x'] },
  ];
  t.mock.method(globalThis, 'fetch', async (endpoint, options) => {
    assert.equal(new URL(endpoint).pathname, '/v1/tasks/task-1');
    assert.equal(new Headers(options.headers).get('X-ModelScope-Task-Type'), 'image_generation');
    return Response.json(replies.shift());
  });
  const input = { id: 'task-1', token };
  assert.equal((await status(input)).state, 'pending');
  assert.deepEqual(await status(input), { state: 'succeeded', url });
  assert.equal((await status(input)).code, 'task_failed');
  assert.equal((await status(input)).code, 'insufficient_balance');
  await assert.rejects(status(input), { code: 'download' });
});
