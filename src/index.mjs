import { open } from 'node:fs/promises';
import { loadConfig, resolve } from './config.mjs';
import { submit, status } from './modelscope.mjs';

export { submit, status };

const imageLimit = 5 * 1024 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');

export async function readImage(file) {
  const source = await open(file, 'r');
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size > imageLimit) throw new Error('请选择 5 MiB 以内的 PNG、JPEG 或 WebP 原图。');
    const bytes = await source.readFile();
    let mime;
    if (bytes.subarray(0, 8).equals(pngSignature)) mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
    else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
    if (!mime || bytes.length > imageLimit) throw new Error('请选择 5 MiB 以内的 PNG、JPEG 或 WebP 原图。');
    return 'data:' + mime + ';base64,' + bytes.toString('base64');
  } finally {
    await source.close();
  }
}

async function submitImage(mode, options) {
  const { files = [], config, token, ...input } = options;
  if (!Array.isArray(files)) throw new Error('files 必须是原图路径数组。');
  const settings = typeof config === 'object' && config !== null ? config : await loadConfig(config);
  const resolved = resolve(settings, { ...input, mode, imageCount: files.length });
  const images = await Promise.all(files.map(readImage));
  return submit({ ...resolved, images, token });
}

export function generateImage(options) {
  return submitImage('generate', options);
}

export function editImage(options) {
  return submitImage('edit', options);
}

export function retouchImage({ file, ...options }) {
  return editImage({ ...options, files: file ? [file] : [], recipe: 'retouch-jewel' });
}

export function getTask(id, { token } = {}) {
  return status({ id, token });
}
