/* AI Tavern Pro — 自托管网关（Node ≥18）：原样加载 worker/index.js，零代码分叉。
   形态：nginx `tavern.myiskg.com/v1/*` → 127.0.0.1:8787 → 本进程 → api.deepseek.com（大陆直连）。
   密钥只来自环境变量（LLM_API_KEY），不写文件、不进日志（worker 侧日志本就脱敏白名单）。
   缺失的 Cloudflare 绑定自动降级：KV → 内存聚合（worker 内已守卫）；页面路由 → 404（页面由 nginx 直供）。
   启动：node server.js（PORT 默认 8787；systemd 单元见 tavern-gateway.service）。 */
'use strict';
const http = require('node:http');

(async () => {
  let worker;
  try { ({ default: worker } = await import('./worker/index.js')); }          // 部署布局：/opt/ai-tavern/{server.js, worker/index.js} 同级
  catch (e) { ({ default: worker } = await import('../worker/index.js')); }   // 仓库内直跑：deploy/server.js → ../worker/index.js
  const PORT = Number(process.env.PORT || 8787);
  const env = {
    LLM_API_KEY: process.env.LLM_API_KEY || '',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080',
    RATE_PER_MIN: process.env.RATE_PER_MIN || '20',
    RATE_GLOBAL_PER_MIN: process.env.RATE_GLOBAL_PER_MIN || '240',
    DAILY_TOKEN_BUDGET: process.env.DAILY_TOKEN_BUDGET || '300000',
    UPSTREAM_TIMEOUT_MS: process.env.UPSTREAM_TIMEOUT_MS || '90000',
    UPSTREAM_BASE: process.env.UPSTREAM_BASE || 'https://api.deepseek.com'
    // TAVERN_KV 不提供：预算/计数退化为内存聚合（worker 内 `if (!env.TAVERN_KV)` 守卫）
  };
  const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };

  http.createServer(async (rq, rs) => {
    try {
      const req = new Request('http://127.0.0.1:' + PORT + (rq.url || '/'), {
        method: rq.method,
        headers: rq.headers,
        body: (rq.method === 'GET' || rq.method === 'HEAD') ? undefined : rq,
        duplex: 'half'
      });
      const res = await worker.fetch(req, env, ctx);
      rs.writeHead(res.status, Object.fromEntries(res.headers));
      rs.socket.setNoDelay(true);                       // SSE 逐帧即时下发
      if (res.body) {
        const reader = res.body.getReader();
        rq.on('close', () => { try { reader.cancel(); } catch (e) {} });   // 客户端断开 → 上游随 worker 逻辑中止
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          rs.write(Buffer.from(r.value));
        }
      }
      rs.end();
    } catch (e) {
      try { rs.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); rs.end(JSON.stringify({ error: { code: 'adapter_error', message: String((e && e.message) || e) } })); } catch (e2) { /* 已断开 */ }
    }
  }).listen(PORT, '127.0.0.1', () => console.log('tavern gateway on 127.0.0.1:' + PORT));
})().catch((e) => { console.error('gateway start failed:', e); process.exit(1); });
