const origin = 'https://api-inference.modelscope.cn';
const taskIdPattern = /^[-\w]{1,160}$/;
const backoffMs = [15_000, 30_000, 60_000];
const trustedHost = /(?:^|\.)modelscope\.(?:cn|ai)$|^modelscope(?:-[a-z0-9-]+)?\.oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/;
const maxEncodedImageLength = Math.ceil(5 * 1024 * 1024 / 3) * 4;
const imagePattern = /^data:image\/(?:png|jpeg|webp);base64,[a-z\d+/]+={0,2}$/i;

function fault(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function balanceError(reply) {
  const fields = [reply?.code, reply?.message, reply?.error?.code, reply?.error?.message, reply?.error, reply?.task_status_message];
  return fields.some(field => typeof field === 'string' &&
    /insufficient[\s_-]*(?:balance|credit|funds)|(?:余额|魔粒|积分)不足/i.test(field));
}

function httpFault(status, reply, submitting) {
  if (status === 402 || balanceError(reply)) return fault('insufficient_balance', '魔搭提示账户余额不足。', status);
  if (status === 429) return fault('http_429', '魔搭拒绝了请求，已达到限流上限（HTTP 429）。', status);
  if (status >= 500) {
    // A gateway error alone does not prove the generation was never queued.
    if (submitting && reply?.accepted !== false) return fault('unknown_submit', '魔搭返回 HTTP ' + status + '，提交结果未知，请勿自动重发。', status);
    return fault('http_5xx', '魔搭服务暂时不可用（HTTP ' + status + '）。', status);
  }
  if (submitting && (status === 408 || status < 400)) return fault('unknown_submit', '未能确认提交结果，请勿自动重发。', status);
  return fault('http_4xx', '魔搭拒绝了请求（HTTP ' + status + '）。', status);
}

async function request(path, token, headers, body) {
  const credential = token ?? process.env.MODELSCOPE_TOKEN;
  if (typeof credential !== 'string' || !credential.trim()) throw fault('config', '请通过安全凭据配置 MODELSCOPE_TOKEN。');
  const submitting = body !== undefined;
  const options = {
    method: submitting ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + credential.trim(), ...headers },
    redirect: 'error',
  };
  if (submitting) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(60_000) });
    } catch {
      if (submitting) throw fault('unknown_submit', '提交时连接中断，结果未知，请勿自动重发。');
      throw fault('network', '查询连接中断，可以继续查询原任务。');
    }
    const reply = await response.json().catch(() => null);
    // Even an unusual HTTP status must not cause a second POST for an existing task.
    if (submitting && typeof reply?.task_id === 'string' && taskIdPattern.test(reply.task_id)) return reply;
    if (response.ok) {
      if (!reply?.task_status && balanceError(reply)) throw fault('insufficient_balance', '魔搭提示账户余额不足。', response.status);
      if (reply) return reply;
      throw fault(submitting ? 'unknown_submit' : 'provider_response', '魔搭返回了无法识别的响应。', response.status);
    }
    const error = httpFault(response.status, reply, submitting);
    if (attempt >= backoffMs.length || !['http_429', 'http_5xx'].includes(error.code)) throw error;
    await new Promise(done => setTimeout(done, backoffMs[attempt]));
  }
}

export async function submit({ model, prompt, images = [], loras, size, token }) {
  if (typeof model !== 'string' || !model.trim() || typeof prompt !== 'string' || !prompt.trim()) {
    throw fault('config', '模型和提示词不能为空。');
  }
  if (!Array.isArray(images) || images.some(image => typeof image !== 'string' ||
    image.length - image.indexOf(',') - 1 > maxEncodedImageLength || !imagePattern.test(image))) {
    throw fault('config', '原图必须是 5 MiB 以内的内嵌 PNG、JPEG 或 WebP。');
  }
  const body = { model, prompt, size };
  if (images.length) body.image_url = images;
  if (typeof loras === 'string' ? loras.length > 0 : loras && Object.keys(loras).length) body.loras = loras;
  const result = await request('/v1/images/generations', token, { 'X-ModelScope-Async-Mode': 'true' }, body);
  if (typeof result?.task_id !== 'string' || !taskIdPattern.test(result.task_id)) {
    throw fault('unknown_submit', '魔搭未返回有效任务编号，提交结果未知，请勿自动重发。');
  }
  return result.task_id;
}

export async function status({ id, token }) {
  if (typeof id !== 'string' || !taskIdPattern.test(id)) throw fault('config', '魔搭任务编号无效。');
  const result = await request('/v1/tasks/' + id, token, { 'X-ModelScope-Task-Type': 'image_generation' });
  switch (result?.task_status) {
    case 'PENDING':
    case 'QUEUED':
    case 'RUNNING':
    case 'PROCESSING':
      return { state: 'pending' };
    case 'CANCELED':
    case 'CANCELLED':
      return { state: 'failed', error: '魔搭任务已取消。', code: 'task_failed' };
    case 'FAILED':
      return balanceError(result)
        ? { state: 'failed', error: '魔搭提示账户余额不足。', code: 'insufficient_balance' }
        : { state: 'failed', error: '魔搭图片任务失败。', code: 'task_failed' };
    case 'SUCCEED': {
      const value = Array.isArray(result.output_images) && result.output_images[0];
      const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : null;
      if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || !trustedHost.test(url.hostname)) {
        throw fault('download', '魔搭未返回可信的结果图片地址。');
      }
      return { state: 'succeeded', url: url.href };
    }
    default:
      throw fault('provider_response', '魔搭返回未知任务状态，可以继续查询原任务。');
  }
}
