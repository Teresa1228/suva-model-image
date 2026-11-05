import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const base = fileURLToPath(new URL('../',import.meta.url));

async function setup(options={}) {
  const dir = await mkdtemp(path.join(tmpdir(),'suva-cli-'));
  const log = path.join(dir,'log'), provider = path.join(dir,'provider.json');
  await writeFile(log,'');
  await writeFile(provider,JSON.stringify({log,...options}));
  await mkdir(path.join(dir,'P'));
  const cfg = JSON.parse(await readFile(path.join(base,'config/default.json')));
  const ref = Object.values(cfg.loras)[0];
  const baseModel = cfg.recipes[cfg.defaults.generateRecipe].model;
  cfg.defaults.pollMax = 1;
  cfg.defaults.pollIntervalMs = 1;
  cfg.models[baseModel].cost = 0.5;
  const styles = Array.from({length:10},(_,i)=>'s'+(i+1));
  for(const s of styles) cfg.loras[s] = {...ref,id:'demo/'+s,trigger:s};
  cfg.recipeSets.ten = {mode:'generate',model:baseModel,loras:styles,delayMs:8,onError:'continue'};
  await writeFile(path.join(dir,'models.json'),JSON.stringify(cfg));
  const cli = async (...args) => (await exec(process.execPath,['--import',path.join(base,'fixtures/mock-provider.mjs'),path.join(base,'bin/cli.mjs'),...args],{
    env:{...process.env,MODELSCOPE_TOKEN:'test',SUVA_IMAGE_HOME:dir,TEST_PROVIDER:provider},timeout:16000})).stdout;
  const batch = (...args) => cli('batch','树','--recipe-set','ten','--project','P',...args);
  const logs = async()=> (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const id = async()=> (await readdir(path.join(dir,'P')))[0];
  return {dir,provider,log,cli,batch,logs,id,styles};
}
test('dry-run 与预算预检不会联网或创建任务',async()=>{
  const t = await setup();
  const preview=JSON.parse((await t.batch('--dry-run')).trim());
  assert.equal(preview.estimatedCost,5);
  assert.deepEqual(preview.requests.map(r=>r.body.loras),t.styles.map(s=>'demo/'+s));
  await assert.rejects(t.batch('--max-cost','4'));
  assert.deepEqual(await t.logs(),[]);
  assert.deepEqual(await readdir(path.join(t.dir,'P')),[]);
});
test('10 个 LoRA 实际顺序执行，失败可继续，已结束的任务恢复时不会重复提交',async()=>{
  const t = await setup({fail:'s4'});
  await t.batch();
  const rows = await t.logs();
  const posts = rows.filter(r=>r.body);
  assert.deepEqual(posts.map(r=>r.body.loras),t.styles.map(s=>'demo/'+s));
  for(let i=1;i<posts.length;i++){
    const prior = rows.slice(0,rows.indexOf(posts[i])).at(-1);
    assert.ok(!prior.body && posts[i].time-prior.time>=7);
  }
  const id = await t.id();
  const summary = JSON.parse(await readFile(path.join(t.dir,'P',id,'summary.json')));
  assert.equal(summary.children.filter(c=>c.state==='succeeded').length,9);
  await t.cli('resume',id,'--project','P');
  assert.equal((await t.logs()).filter(r=>r.body).length,10);
});
test('stop 在确定失败后停止；提交断线不重发原任务',async()=>{
  const failed = await setup({fail:'s2'});
  await failed.batch('--on-error','stop').catch(()=>{});
  assert.equal((await failed.logs()).filter(r=>r.body).length,2);
  const unknown=await setup({unknown:'demo/s2'});
  await unknown.batch().catch(()=>{});
  await unknown.cli('resume',await unknown.id(),'--project','P').catch(()=>{});
  assert.equal((await unknown.logs()).filter(r=>r.body?.loras==='demo/s2').length,1);
});
test('旧单任务从魔搭 ID 继续，旧配置缺失也可恢复',async()=>{
  const t = await setup(), key='aabbccdd-1234-4321-abcd-aabbccddeeff';
  const dir = path.join(t.dir,'P',key);
  await mkdir(dir);
  await writeFile(path.join(dir,'task.json'),JSON.stringify({key,id:'legacy',command:'generate',state:'pending'}));
  await t.cli('resume',key,'--project','P');
  assert.equal((await t.logs()).filter(r=>r.body).length,0);
  assert.ok((await readdir(dir)).includes('result.png'));
});
test('批次恢复先查询尚在途的子任务，再执行剩余项；不重跑已完成项',async()=>{
  const t = await setup({pending:'s3'});
  await assert.rejects(t.batch());
  assert.deepEqual((await t.logs()).filter(r=>r.body).map(r=>r.body.loras),['demo/s1','demo/s2','demo/s3']);
  await writeFile(t.provider,JSON.stringify({log:t.log}));
  await t.cli('resume',await t.id(),'--project','P');
  const rows=await t.logs();
  assert.deepEqual(rows.filter(r=>r.body).map(r=>r.body.loras),t.styles.map(s=>'demo/'+s));
  assert.equal(rows.filter(r=>r.path.endsWith('/v1/tasks/s3')).length,2);
});
