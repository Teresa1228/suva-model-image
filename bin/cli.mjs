#!/usr/bin/env node
import { mkdir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, resolve } from '../src/config.mjs';
import { readImage } from '../src/index.mjs';
import { startRun, resumeRun } from '../src/runner.mjs';

const root = path.resolve(process.env.SUVA_IMAGE_HOME || path.join(homedir(), '.suva-model-image'));
const help = `suva-model-image project list | project create 名称 | doctor
suva-model-image models list | loras list | recipes list | config check
suva-model-image generate "描述" --project 名称
suva-model-image edit 图片... --prompt "要求" --project 名称
suva-model-image retouch 原图 [--prompt "要求"] --project 名称
suva-model-image batch "描述" (--recipe-set S | --loras a,b,c) [--image 原图] --project 名称
suva-model-image resume 本地任务或批次ID --project 名称
选项: --model M --recipe R --lora L[:权重] --size WxH --config 文件 --dry-run
批量选项: --delay 毫秒 --on-error stop|continue --max-cost 魔粒`;
const string = { type: 'string' };
const repeated = { type: 'string', multiple: true };
const flag = { type: 'boolean' };

function projectFolder(name) {
  if (!name?.trim() || !/^[\p{L}\p{N}_ -]{1,80}$/u.test(name)) throw Error('请指定有效工程名');
  return path.join(root, name);
}
function number(value, label, integer = false) {
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(n) || n < 0 || (integer && (!Number.isSafeInteger(n) || n > 2147483647))) throw Error(label + ' 必须为有效非负数');
  return n;
}
function argsCount(args, min, max) {
  if (args.length < min || args.length > max) throw Error('参数数量不正确。\n' + help);
}
async function main() {
  const { values: v, positionals: [cmd, ...args] } = parseArgs({allowPositionals: true, options: {
    project:string, prompt:string, recipe:string, model:string, lora:repeated, size:string, config:string,
    'recipe-set':string, loras:string, image:repeated, delay:string, 'on-error':string, 'max-cost':string,
    'dry-run':flag, force:flag, help:flag
  }});
  if (!cmd || v.help) return console.log(help);
  if (cmd === 'doctor') return console.log('Node ' + process.version + '；凭据' + (process.env.MODELSCOPE_TOKEN ? '已配置' : '未配置') + '；工程目录 ' + root);
  if (cmd === 'project') {
    if (args[0] === 'list' && args.length === 1) {
      const entries = await readdir(root,{withFileTypes:true}).catch(e => { if(e.code === 'ENOENT') return []; throw e; });
      return console.log(entries.filter(e => e.isDirectory()).map(e => e.name).join('\n'));
    }
    if (args[0] !== 'create' || args.length !== 2) throw Error(help);
    const folder = projectFolder(args[1]);
    await mkdir(root,{recursive:true});
    await mkdir(folder);
    return console.log(folder);
  }
  if (cmd === 'resume') {
    argsCount(args,1,1);
    if(v['dry-run']) throw Error('resume 会继续已有任务；不能用于 dry-run');
    return output(await resumeRun({folder:projectFolder(v.project),key:args[0]}));
  }
  const cfg = await loadConfig(v.config);
  if (cmd === 'config' && args[0] === 'check') return console.log('配置校验通过');
  if (['recipes','models','loras'].includes(cmd) && args[0] === 'list') {
    return console.log(JSON.stringify(cmd === 'recipes' ? {recipes:cfg.recipes,recipeSets:cfg.recipeSets} : cfg[cmd],null,2));
  }
  if (!['batch','edit','generate','retouch'].includes(cmd)) throw Error(help);
  const batch = cmd === 'batch';
  if (!batch && ['recipe-set','loras','image','delay','on-error'].some(k=>v[k] !== undefined)) throw Error('该参数仅用于 batch');
  argsCount(args,1,cmd === 'edit' ? Infinity : 1);
  const set = v['recipe-set'] ? cfg.recipeSets[v['recipe-set']] : undefined;
  if (v['recipe-set'] && !set) throw Error('未登记的批量配方 ' + v['recipe-set']);
  const files = (batch ? v.image || [] : ['edit','retouch'].includes(cmd) ? args : []).map(f=>path.resolve(f));
  const mode = batch ? (set?.mode || (files.length ? 'edit' : 'generate')) : cmd === 'generate' ? 'generate' : 'edit';
  const userPrompt = v.prompt ?? (['generate','batch'].includes(cmd) ? args[0] : undefined);
  if (v.lora && v.loras) throw Error('请选择 --lora 或 --loras');
  const explicit = v.lora || v.loras?.split(',').map(s=>s.trim());
  const styles = batch ? explicit ?? set?.loras : [];
  if (batch && (!Array.isArray(styles) || !styles.length || styles.some(s => typeof s !== 'string' || !s.trim()))) throw Error('batch 需要非空 LoRA 列表或 --recipe-set');
  const recipe = v.recipe ?? (cmd === 'retouch' ? 'retouch-jewel' : undefined);
  const delayMs = number(v.delay ?? set?.delayMs ?? 5000,'delay',true);
  const onError = v['on-error'] ?? set?.onError ?? 'stop';
  if (!['stop','continue'].includes(onError)) throw Error('on-error 必须是 stop 或 continue');
  const plans = (batch ? styles : [null]).map(label => {
    const resolved = resolve(cfg,{mode,recipe,model:v.model ?? set?.model,loras:batch ? [label] : explicit,
      size:v.size ?? set?.size,prompt:userPrompt,force:v.force,imageCount:files.length});
    return {...resolved,files,label,userPrompt:userPrompt ?? null};
  });
  const images = [];
  for (const file of files) {
    const data = await readImage(file);
    images.push({file, mime:data.substring(5,data.indexOf(';')), bytes:(await stat(file)).size});
  }
  const unknown = plans.some(p=>p.cost == null);
  const estimate = unknown ? null : plans.reduce((n,p)=>n+p.cost,0);
  const folder = v.project ? projectFolder(v.project) : null;
  if (folder && !(await stat(folder)).isDirectory()) throw Error('无效的工程目录');
  const preview = {submissions:plans.length,estimatedCost:estimate,delayMs:batch ? delayMs : 0,
    requests:plans.map(p=>({label:p.label,recipe:p.recipe,cost:p.cost,warnings:p.warnings,
      body:{model:p.model,prompt:p.prompt,size:p.size,...(p.loras && {loras:p.loras}),...(images.length && {image_url:images})}}))};
  console.log(JSON.stringify(preview));
  if (v['max-cost'] !== undefined && (number(v['max-cost'],'max-cost') < estimate || unknown)) throw Error('预计消耗未知或超过 --max-cost，未提交');
  if (v['dry-run']) return;
  if (!folder) throw Error('请指定已有工程 --project');
  if (!process.env.MODELSCOPE_TOKEN?.trim()) throw Error('请配置 MODELSCOPE_TOKEN');
  output(await startRun({folder,plans,command:cmd,recipeSet:v['recipe-set'] ?? null,delayMs,onError,
    pollMax:cfg.defaults.pollMax ?? 90,pollIntervalMs:cfg.defaults.pollIntervalMs ?? 3000}));
}
function output(result) {
  console.log(typeof result === 'string' ? result : JSON.stringify(result));
  if (result?.state === 'stopped') process.exitCode = 1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
