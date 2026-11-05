import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const bundled = new URL('../config/default.json', import.meta.url);
const modes = ['generate', 'edit'];
const idPattern = /^[\w.-]+\/[\w.-]+$/;
const sizePattern = /^[1-9]\d{0,5}x[1-9]\d{0,5}$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const own = (table, key) => Object.hasOwn(table, key) ? table[key] : undefined;

function check(condition, message, code = 'config') {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function integer(value, min, label) {
  check(Number.isSafeInteger(value) && value >= min, label + ' 必须是大于等于 ' + min + ' 的整数');
}

function modelOrLora(table, key, label, warnings) {
  check(hasText(key), '缺少' + label);
  const spec = own(table, key) ?? Object.values(table).find(item => item.id === key);
  if (spec) return spec;
  check(idPattern.test(key), label + '别名不存在：' + key);
  check(warnings, label + ' 未登记：' + key);
  warnings.push(label + ' ' + key + ' 未登记，无法校验兼容性');
  return { id: key };
}

function parseLoras(selection) {
  if (selection == null) return [];
  if (isRecord(selection)) return Object.entries(selection);
  const values = Array.isArray(selection) ? selection : [selection];
  return values.map(value => {
    check(hasText(value), 'LoRA 必须是别名或模型 ID');
    const parts = value.split(':');
    check(parts.length <= 2 && (parts.length === 1 || hasText(parts[1])), 'LoRA 权重格式无效');
    return [parts[0], parts.length === 2 ? Number(parts[1]) : undefined];
  });
}

function resolveSelection(config, options, registeredOnly) {
  const retouch = options.mode === 'retouch';
  const mode = retouch ? 'edit' : options.mode;
  check(modes.includes(mode), '操作必须为 generate、edit 或 retouch');
  check(!retouch || !options.recipe || options.recipe === 'retouch-jewel', 'retouch 固定使用 retouch-jewel 配方');
  const recipeName = retouch ? 'retouch-jewel' : options.recipe ?? config.defaults[mode + 'Recipe'];
  const recipe = own(config.recipes, recipeName);
  check(recipe && recipe.mode === mode, '配方不存在或不支持此操作：' + recipeName);
  const warnings = [];
  const registryWarnings = registeredOnly ? undefined : warnings;
  const model = modelOrLora(config.models, options.model ?? recipe.model, '模型', registryWarnings);
  check(!model.capabilities || model.capabilities.includes(mode), '模型不支持 ' + mode, 'incompatible');
  const count = options.imageCount ?? 0;
  integer(count, 0, 'imageCount');
  check(mode === 'generate' ? count === 0 && !recipe.requireImage : count > 0, '原图数量与操作不符');
  check(model.maxImages == null || count <= model.maxImages, '原图超过模型允许的张数 maxImages=' + model.maxImages);
  const size = options.size ?? recipe.size ?? config.defaults.size;
  check(typeof size === 'string' && sizePattern.test(size), '尺寸格式应为 WxH');
  check(!model.sizes || model.sizes.includes(size), '模型不支持尺寸 ' + size);
  if (!model.sizes) warnings.push('模型未登记尺寸白名单，请确认 ' + size + ' 可用');
  const pairs = parseLoras(options.loras ?? recipe.loras);
  check(pairs.length <= 6, '同时叠加最多 6 个 LoRA');
  check(!pairs.length || model.allowLoraField !== false, '模型禁止附加 LoRA', 'incompatible');

  const weights = {};
  const prefixes = [];
  let prompt = options.prompt ?? recipe.defaultPrompt ?? '';
  check(hasText(prompt), '请提供图片提示词');
  prompt = prompt.trim();
  for (const [key, override] of pairs) {
    const lora = modelOrLora(config.loras, key, 'LoRA', registryWarnings);
    check(!Object.hasOwn(weights, lora.id), '不能重复叠加同一个 LoRA');
    const weight = override ?? lora.weight ?? 1;
    check(Number.isFinite(weight) && weight > 0 && weight <= 1, 'LoRA 权重必须在 (0,1] 内');
    weights[lora.id] = weight;
    if (lora.baseFamily && model.family && lora.baseFamily !== model.family) {
      const warning = 'LoRA ' + key + ' 与模型家族不兼容';
      check(options.force === true, warning, 'incompatible');
      warnings.push(warning);
    }
    const hasPrefix = value => prompt.includes(value) || prefixes.some(item => item.trim() === value);
    if (lora.trigger && lora.triggerMode !== 'none' && !hasPrefix(lora.trigger)) {
      prefixes.push(lora.trigger + (lora.triggerMode === 'prefix' ? '' : '\n'));
    }
    if (lora.promptPrefix && !hasPrefix(lora.promptPrefix)) prefixes.push(lora.promptPrefix + '\n');
  }
  const ids = Object.keys(weights);
  if (ids.length > 1) {
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    check(Math.abs(total - 1) <= 0.001 + 1e-12, 'LoRA 权重之和必须为 1（误差 ±0.001）');
  } else if (ids.length && weights[ids[0]] !== 1) {
    warnings.push('单个 LoRA 按 ID 发送，权重仅对多个 LoRA 叠加有效');
  }
  return {
    model: model.id, loras: ids.length > 1 ? weights : ids[0] ?? null,
    size, prompt: prefixes.join('') + prompt, cost: model.cost ?? null, recipe: recipeName, warnings,
  };
}

export function resolve(config, options) {
  return resolveSelection(config, options, false);
}

function validate(config) {
  check(isRecord(config) && config.version === 1, '配置 version 必须为 1');
  for (const field of ['defaults', 'models', 'loras', 'recipes']) check(isRecord(config[field]), field + ' 必须是对象');
  if (config.recipeSets === undefined) config.recipeSets = {};
  check(isRecord(config.recipeSets), 'recipeSets 必须是对象');

  for (const table of ['models', 'loras', 'recipes', 'recipeSets']) {
    for (const [key, spec] of Object.entries(config[table])) {
      check(hasText(key) && /^[\p{L}\p{N}_.-]+$/u.test(key) && !['.', '..','__proto__','constructor','prototype'].includes(key),
        '配置别名无效：' + key);
      check(isRecord(spec), table + '.' + key + ' 必须是对象');
    }
  }
  for (const [aliases, family] of [['models', 'family'], ['loras', 'baseFamily']]) {
    const ids = new Set();
    for (const [name, spec] of Object.entries(config[aliases])) {
      check(typeof spec.id === 'string' && idPattern.test(spec.id) && !ids.has(spec.id), name + ' 的 ID 无效或重复');
      ids.add(spec.id);
      check(hasText(spec[family]), name + ' 缺少 ' + family);
    }
  }
  for (const [name, model] of Object.entries(config.models)) {
    check(Array.isArray(model.capabilities) && model.capabilities.length && model.capabilities.every(item => modes.includes(item)), name + ' capabilities 无效');
    if (model.maxImages !== undefined) integer(model.maxImages, model.capabilities.includes('edit') ? 1 : 0, name + '.maxImages');
    if (model.allowLoraField !== undefined) check(typeof model.allowLoraField === 'boolean', name + ' allowLoraField 无效');
    if (model.sizes !== undefined) check(Array.isArray(model.sizes) && model.sizes.length && model.sizes.every(size => typeof size === 'string' && sizePattern.test(size)), name + ' sizes 无效');
    check(model.cost == null || (Number.isFinite(model.cost) && model.cost >= 0), name + ' cost 无效');
  }
  for (const [name, lora] of Object.entries(config.loras)) {
    if (lora.weight !== undefined) check(Number.isFinite(lora.weight) && lora.weight > 0 && lora.weight <= 1, name + ' weight 无效');
    if (lora.triggerMode !== undefined) check(['prefix-newline','prefix','none'].includes(lora.triggerMode), name + ' triggerMode 无效');
    for (const field of ['promptPrefix', 'trigger']) if (lora[field] !== undefined) check(typeof lora[field] === 'string', name + '.' + field + ' 无效');
  }
  const defaults = config.defaults;
  check(typeof defaults.size === 'string' && sizePattern.test(defaults.size), 'defaults.size 无效');
  for (const mode of modes) check(own(config.recipes, defaults[mode + 'Recipe'])?.mode === mode, '默认配方不存在或模式不符：' + mode);
  defaults.pollMax ??= 90;
  defaults.pollIntervalMs ??= 3000;
  integer(defaults.pollMax, 1, 'pollMax');
  integer(defaults.pollIntervalMs, 0, 'pollIntervalMs');

  const validateEntry = (recipe, opts) => resolveSelection(config, {
    mode: recipe.mode, imageCount: recipe.mode === 'edit' ? 1 : 0, prompt: '配置校验', ...opts,
  }, true);
  for (const [name, recipe] of Object.entries(config.recipes)) {
    check(modes.includes(recipe.mode) && hasText(recipe.model), name + ' 的模式或模型无效');
    if (recipe.defaultPrompt !== undefined) check(hasText(recipe.defaultPrompt), name + ' defaultPrompt 无效');
    if (recipe.requireImage !== undefined) check(typeof recipe.requireImage === 'boolean', name + ' requireImage 无效');
    validateEntry(recipe, { recipe: name });
  }
  for (const [name, set] of Object.entries(config.recipeSets)) {
    check(modes.includes(set.mode) && hasText(set.model), name + ' 的模式或模型无效');
    check(Array.isArray(set.loras) && set.loras.length > 0 && set.loras.every(hasText), name + ' 需要 LoRA 列表');
    if (set.delayMs !== undefined) integer(set.delayMs, 0, name + '.delayMs');
    if (set.onError !== undefined) check(['stop', 'continue'].includes(set.onError), name + ' onError 无效');
    for (const lora of set.loras) validateEntry(set, { model: set.model, loras: [lora], size: set.size });
  }
  return config;
}

export async function loadConfig(file) {
  const candidate = file ?? path.join(process.env.SUVA_IMAGE_HOME || path.join(homedir(), '.suva-model-image'), 'models.json');
  let raw;
  try {
    raw = await readFile(candidate, 'utf8');
  } catch (error) {
    if (file != null || error.code !== 'ENOENT') throw Object.assign(new Error('无法读取模型配置：' + candidate), { code: 'config', cause: error });
    raw = await readFile(bundled, 'utf8');
  }
  let config;
  try { config = JSON.parse(raw); }
  catch (cause) { throw Object.assign(new Error('模型配置 JSON 格式错误'), { code: 'config', cause }); }
  return validate(config);
}
