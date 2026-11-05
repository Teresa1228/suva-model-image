import { appendFileSync, readFileSync } from 'node:fs';
let currentId;
globalThis.fetch = async (url, options = {}) => {
  const trace = JSON.parse(readFileSync(process.env.TEST_PROVIDER, 'utf8'));
  const path = String(url);
  const body = options.body && JSON.parse(options.body);
  appendFileSync(trace.log, JSON.stringify({path,body,time:Date.now()})+'\n');
  if (options.method === 'POST') {
    currentId = body.loras || 'plain';
    if (currentId === trace.unknown) throw new Error('connection lost');
    return Response.json({task_id:currentId.split('/').pop()});
  }
  if (path.includes('/v1/tasks/')) {
    const id = path.split('/').pop();
    if (trace.fail === id) return Response.json({task_status:'FAILED'});
    if (trace.pending === id) return Response.json({task_status:'RUNNING'});
    return Response.json({task_status:'SUCCEED',output_images:['https://modelscope.cn/result.png']});
  }
  return new Response(Buffer.from('89504e470d0a1a0a0000','hex'),{headers:{'Content-Type':'image/png'}});
};
