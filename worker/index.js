/**
 * AI Tavern Pro — AI Gateway（Cloudflare Worker）
 * 依据：docs/stage-2-gateway-contract.md g1.1
 *
 * 职责边界（服务端只做这五件事）：
 *   1. 端点与 CORS/Origin 白名单、限流、每日预算护栏
 *   2. 模型路由：mode → {model, thinking, reasoning_effort, max_tokens 下限}
 *   3. 上游 SSE 解析 → 归一化成四种帧（reasoning / content / usage / error）
 *   4. 错误归一化（读文本 → 试 JSON → 提取 request_id）与脱敏
 *   5. 安全日志（白名单字段；绝不记正文、Authorization、原始响应体、密钥）
 *
 * 密钥只从 Worker Secret 读取（env.LLM_API_KEY）。本文件与产物中零密钥。
 *
 * 关于 reasoning：DR-009 要求"不展示、不持久化、不进普通日志"。本文件把上游的
 * reasoning_content **原样转发**（客户端只取度量后丢弃），Worker 侧不落任何日志。
 * ⚠ 待裁决的优化：既然客户端永远不展示，可以只转发度量而省掉正文（实测深潜模式
 *    约 90% 的输出 token 是推理）。是否需要，由用户决定，见交付报告。
 */

/* 交付页面（可选形态：先复制 dist/AI-Tavern.html → worker/page.html）。
   Cloudflare 侧由 Text 模块规则内联；Node 自托管（deploy/server.js）无 .html 加载器，
   动态导入失败则 PAGE 为 null、该路由退化为 404——页面由 nginx 直供，不影响 /v1 API。 */
let PAGE = null;
try { PAGE = (await import('./page.html')).default; } catch (e) { PAGE = null; }

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no'
};

/** 模型路由表：服务端唯一真源（客户端只传 mode/task，不得指定模型） */
const ROUTES = {
  quick: { model: 'deepseek-flash', thinking: { type: 'disabled' }, effort: null, minMaxTokens: 600, defaultMaxTokens: 900 },
  deep: { model: 'deepseek-flash', thinking: { type: 'enabled' }, effort: 'high', minMaxTokens: 1500, defaultMaxTokens: 2600 },
  deep_pro: { model: 'deepseek-v4-pro', thinking: { type: 'enabled' }, effort: 'high', minMaxTokens: 1500, defaultMaxTokens: 2600 },
  extract: { model: 'deepseek-flash', thinking: { type: 'disabled' }, effort: null, minMaxTokens: 200, defaultMaxTokens: 400, json: true, noStream: true }
};

const LIMITS = { maxMessages: 40, maxCharsPerMessage: 6000, maxTotalChars: 40000 };

/** 客户端已断开（由"写失败"判定，见流式段的 write()） */
class ClientGone extends Error { constructor() { super('client_gone'); this.name = 'ClientGone'; } }

/* ── 日志：只允许白名单字段进入日志（构造新对象，不做透传） ───────────── */
function logEvent(fields) {
  const allow = ['event', 'endpoint', 'agentId', 'mode', 'task', 'httpStatus', 'code',
    'latencyMs', 'promptTokens', 'completionTokens', 'reasoningTokens', 'requestId',
    'origin', 'ip', 'reason', 'bytes', 'frames', 'truncated', 'empty'];
  const out = {};
  for (const k of allow) if (fields[k] !== undefined) out[k] = fields[k];
  console.log(JSON.stringify(out));
}

/** 错误脱敏：擦除密钥形态的子串（防止上游回显请求头时泄露） */
function redact(s) {
  return String(s || '')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => (m.length > 40 ? m.slice(0, 6) + '***' : m))
    .slice(0, 200);
}

/** 归一化上游错误：① 读文本 ② 试 JSON ③ 失败保留安全文本 ④ 提取 request_id ⑤ 不信任 Content-Type */
function normalizeUpstreamError(status, rawText, headers) {
  let json = null;
  try { json = JSON.parse(rawText); } catch (e) { /* 上游可能是纯文本（实测 401 无 Content-Type） */ }
  const err = (json && json.error) || {};
  const msg = String(err.message || rawText || '');
  const m = msg.match(/request_id[:：]\s*([A-Za-z0-9-]+)/i);
  const requestId = (json && (json.request_id || err.request_id)) || (m && m[1]) ||
    (headers && headers.get && headers.get('x-ds-trace-id')) || null;

  let code = 'upstream_error';
  if (status === 401 || status === 403) code = 'auth';
  else if (status === 400 || status === 422) code = 'bad_request';
  else if (status === 429) code = 'rate_limited';
  else if (status >= 500) code = 'upstream_5xx';

  return { code, httpStatus: status, requestId, message: redact(msg), retryable: code === 'rate_limited' || code === 'upstream_5xx' };
}

/** 客户端可见文案：按 code 映射，绝不回显上游原文 */
const USER_MESSAGE = {
  auth: '网关配置异常，请稍后再试',
  bad_request: '本轮请求不被上游接受',
  rate_limited: '酒馆此刻有点忙，稍后重试',
  upstream_5xx: '上游故障，已重试仍失败',
  network: '网络不可达',
  upstream_timeout: '上游超时',
  budget: '今日额度已用尽，已切到离线模式',
  too_large: '输入过长'
};
const userText = (code) => USER_MESSAGE[code] || '本轮未能完成';

/* ── 限流 + 预算（内存聚合 + 低频落盘；KV 免费额度仅 1000 写/天） ─────── */
const mem = {
  buckets: new Map(),
  global: { count: 0, resetAt: 0 },
  budget: { day: null, tokens: 0, requests: 0, lastFlush: 0, pending: 0, flushedOnce: false }
};

function rateAllow(ip, limitPerMin, globalLimitPerMin) {
  const now = Date.now();
  if (mem.global.resetAt < now) { mem.global = { count: 0, resetAt: now + 60000 }; }
  if (mem.global.count >= globalLimitPerMin) return false;
  const b = mem.buckets.get(ip) || { count: 0, resetAt: now + 60000 };
  if (b.resetAt < now) { b.count = 0; b.resetAt = now + 60000; }
  b.count++;
  mem.buckets.set(ip, b);
  if (mem.buckets.size > 2000) mem.buckets.clear();   // 防内存膨胀
  if (b.count > limitPerMin) return false;
  mem.global.count++;
  return true;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

async function budgetLoad(env) {
  if (!env.TAVERN_KV) return;
  const day = todayKey();
  if (mem.budget.day === day && mem.budget.flushedOnce) return;
  mem.budget.day = day;
  try {
    const raw = await env.TAVERN_KV.get('budget:' + day);
    if (raw) {
      const v = JSON.parse(raw);
      if (!mem.budget.flushedOnce) { mem.budget.tokens = v.tokens || 0; mem.budget.requests = v.requests || 0; }
    }
  } catch (e) { /* 读失败不阻塞：预算护栏是尽力而为 */ }
  mem.budget.flushedOnce = true;
}

async function budgetFlush(env, force) {
  if (!env.TAVERN_KV || !mem.budget.day) return;
  const now = Date.now();
  // 写节流：≥120s 或累积 ≥50 次请求才落盘 → 最坏 720 写/天，低于 KV 免费额度 1000 写/天
  if (!force && (now - mem.budget.lastFlush < 120000) && mem.budget.pending < 50) return;
  mem.budget.lastFlush = now;
  mem.budget.pending = 0;
  try {
    await env.TAVERN_KV.put('budget:' + mem.budget.day, JSON.stringify({ tokens: mem.budget.tokens, requests: mem.budget.requests }), { expirationTtl: 172800 });
  } catch (e) { /* 写失败不影响请求 */ }
}

function budgetExceeded(env) {
  const cap = Number(env.DAILY_TOKEN_BUDGET || 0);
  return cap > 0 && mem.budget.tokens >= cap;
}

/* ── CORS ─────────────────────────────────────────────────────────── */
function corsFor(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  // 故意不放行 'null'：那等于对任何本地文件开放（stage-0 R3）
  if (origin && allowed.indexOf(origin) !== -1) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
  }
  return { 'Vary': 'Origin' };
}

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {})
});

/* ── 主入口 ───────────────────────────────────────────────────────── */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const cors = corsFor(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // 页面托管（交付链接）：根路径同源返回单文件产物；页面与 API 同域 → 无需 CORS/白名单
    if (PAGE && (url.pathname === '/' || url.pathname === '/index.html') && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/v1/health') {
      const hasKey = !!env.LLM_API_KEY;
      return json({
        ok: hasKey,
        worker: 'tavern-gateway@1.0',
        models: { quick: ROUTES.quick.model, deep: ROUTES.deep.model, deepPro: ROUTES.deep_pro.model },
        modes: Object.keys(ROUTES),
        hasKey,
        budget: { cap: Number(env.DAILY_TOKEN_BUDGET || 0), usedTokens: mem.budget.tokens }
      }, 200, cors);
    }

    if (url.pathname === '/v1/diag') {
      // 运维自省：需要 DIAG_TOKEN（另一个 secret），否则视为不存在
      const t = request.headers.get('x-diag-token');
      if (!env.DIAG_TOKEN || t !== env.DIAG_TOKEN) return json({ error: { code: 'not_found' } }, 404, cors);
      let lastAbort = null;
      let counters = { aborts: 0, requests: 0 };
      if (env.TAVERN_KV) {
        try { lastAbort = JSON.parse((await env.TAVERN_KV.get('diag:lastAbort')) || 'null'); } catch (e) {}
        try { counters = JSON.parse((await env.TAVERN_KV.get('diag:counters')) || 'null') || counters; } catch (e) {}
      }
      return json({ ok: true, budget: mem.budget, counters, lastAbort }, 200, cors);
    }

    if (url.pathname !== '/v1/chat' || request.method !== 'POST') {
      return json({ error: { code: 'not_found' } }, 404, cors);
    }

    if (!rateAllow(ip, Number(env.RATE_PER_MIN || 20), Number(env.RATE_GLOBAL_PER_MIN || 240))) {
      logEvent({ event: 'rate_limited', endpoint: '/v1/chat', ip, origin, httpStatus: 429, code: 'rate_limited' });
      return json({ error: { code: 'rate_limited', message: userText('rate_limited'), retryable: true } }, 429, cors);
    }

    await budgetLoad(env);
    if (budgetExceeded(env)) {
      logEvent({ event: 'budget_blocked', endpoint: '/v1/chat', httpStatus: 429, code: 'budget' });
      return json({ error: { code: 'budget', degraded: 'budget', message: userText('budget'), retryable: false } }, 429, cors);
    }
    if (!env.LLM_API_KEY) {
      logEvent({ event: 'no_key', endpoint: '/v1/chat', httpStatus: 503, code: 'auth' });
      return json({ error: { code: 'auth', message: userText('auth'), retryable: false } }, 503, cors);
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: { code: 'bad_request', message: '请求体不是合法 JSON' } }, 400, cors); }

    const req = validate(body);
    if (req.error) {
      logEvent({ event: 'invalid_request', endpoint: '/v1/chat', httpStatus: 400, code: 'bad_request', reason: req.error });
      return json({ error: { code: 'bad_request', message: req.error } }, 400, cors);
    }

    const route = ROUTES[req.task === 'extract' ? 'extract' : (req.mode === 'quick' ? 'quick' : 'deep')];
    const upstreamBody = buildUpstreamBody(req, route, body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('upstream_timeout'), Number(env.UPSTREAM_TIMEOUT_MS || 90000));
    const t0 = Date.now();
    let upstreamRes;
    try {
      upstreamRes = await fetch((env.UPSTREAM_BASE || 'https://api.deepseek.com') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LLM_API_KEY },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = String(e && e.name) === 'AbortError';
      const code = aborted ? 'upstream_timeout' : 'network';
      logEvent({ event: 'upstream_failed', endpoint: '/v1/chat', agentId: req.agentId, mode: req.mode, code, latencyMs: Date.now() - t0 });
      return json({ error: { code, message: userText(code), retryable: true } }, 504, cors);
    }

    // 上游非 200：尚未开始流式，直接返回结构化错误（客户端按普通 HTTP 错误处理）
    if (!upstreamRes.ok) {
      clearTimeout(timer);
      const raw = await upstreamRes.text().catch(() => '');
      const e = normalizeUpstreamError(upstreamRes.status, raw, upstreamRes.headers);
      logEvent({
        event: 'upstream_error', endpoint: '/v1/chat', agentId: req.agentId, mode: req.mode,
        httpStatus: e.httpStatus, code: e.code, requestId: e.requestId, latencyMs: Date.now() - t0
      });
      const httpStatus = e.code === 'rate_limited' ? 429 : (e.code === 'bad_request' ? 400 : 502);
      const payload = { error: { code: e.code, message: userText(e.code), retryable: e.retryable, httpStatus: e.httpStatus, requestId: e.requestId } };
      // 诊断开关：仅当显式带 x-debug: 1 时回显**脱敏后**的上游片段（默认永不暴露）
      if (request.headers.get('x-debug') === '1') {
        payload.debug = { upstreamUrl: (env.UPSTREAM_BASE || 'https://api.deepseek.com') + '/chat/completions', body: redact(raw) };
      }
      return json(payload, httpStatus, cors);
    }

    // extract：非流式的小 JSON 任务
    if (route.noStream) {
      clearTimeout(timer);
      const raw = await upstreamRes.text();
      let usage = null, content = '';
      try { const j = JSON.parse(raw); usage = j.usage; content = j.choices[0].message.content; } catch (e) {}
      if (usage) countUsage(env, usage);
      logEvent({ event: 'extract_done', endpoint: '/v1/extract', agentId: req.agentId, httpStatus: 200, latencyMs: Date.now() - t0, promptTokens: usage && usage.prompt_tokens, completionTokens: usage && usage.completion_tokens });
      return json({ content, usage }, 200, cors);
    }

    /* ── 流式：解析上游 SSE → 归一化成四种帧 ─────────────────────────── */
    const encoder = new TextEncoder();
    let clientGone = false;
    let upstreamAbortedByClient = false;

    const stream = new ReadableStream({
      async start(ctrl) {
        const reader = upstreamRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let usage = null, finishReason = null, contentChars = 0, chunks = 0;
        let reasoningBytes = 0, reasoningFrames = 0, ttftReasoning = null, ttftContent = null;

        /* 写失败 = 客户端已离开。这是唯一可靠的断连信号：
           实测在 Cloudflare 上，客户端断开**不会**触发 ReadableStream 的 cancel()，
           因此必须靠"写失败"来发现；否则上游连接会一直挂着（用户的硬约束②）。 */
        const write = (bytes) => {
          try { ctrl.enqueue(bytes); return true; }
          catch (e) { clientGone = true; throw new ClientGone(); }
        };
        const send = (obj) => write(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'));

        const HEARTBEAT_MS = Number(env.SSE_HEARTBEAT_MS || 1000);
        try {
          while (true) {
            // 心跳竞速：既保证客户端有帧可读，也保证"每秒至少写一次"→ 断连最迟 1 秒被发现
            const r = await Promise.race([
              reader.read(),
              new Promise((res) => setTimeout(() => res({ heartbeat: true }), HEARTBEAT_MS))
            ]);
            if (r.heartbeat) { write(encoder.encode(': hb\n\n')); continue; }
            const { value, done } = r;
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              const s = line.trim();
              if (!s || s.startsWith(':') || s === 'data: [DONE]') continue;
              if (!s.startsWith('data:')) continue;
              let j;
              try { j = JSON.parse(s.slice(5).trim()); } catch (e) { continue; }
              chunks++;
              if (j.usage) usage = j.usage;
              const ch = j.choices && j.choices[0];
              if (ch && ch.finish_reason) finishReason = ch.finish_reason;
              const d = ch && ch.delta;
              if (!d) continue;
              if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
                if (ttftReasoning === null) ttftReasoning = Date.now() - t0;
                reasoningBytes += d.reasoning_content.length;
                reasoningFrames++;
                send({ type: 'reasoning', delta: d.reasoning_content });
              }
              if (typeof d.content === 'string' && d.content) {
                if (ttftContent === null) ttftContent = Date.now() - t0;
                contentChars += d.content.length;
                send({ type: 'content', delta: d.content });
              }
            }
          }

          // 收尾：usage 帧携带 finishReason/truncated/empty（契约 §1.4）
          if (usage) countUsage(env, usage);
          const truncated = finishReason === 'length' && contentChars > 0;
          const empty = contentChars === 0;
          send({
            type: 'usage',
            prompt: usage ? usage.prompt_tokens : null,
            completion: usage ? usage.completion_tokens : null,
            reasoning: usage && usage.completion_tokens_details ? usage.completion_tokens_details.reasoning_tokens : null,
            cached: usage ? (usage.prompt_cache_hit_tokens || 0) : null,
            finishReason: finishReason,
            truncated, empty,
            ttftReasoningMs: ttftReasoning, ttftContentMs: ttftContent
          });
          write(encoder.encode('data: [DONE]\n\n'));
          logEvent({
            event: 'turn_done', endpoint: '/v1/chat', agentId: req.agentId, mode: req.mode, httpStatus: 200,
            latencyMs: Date.now() - t0, promptTokens: usage && usage.prompt_tokens,
            completionTokens: usage && usage.completion_tokens,
            reasoningTokens: usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens,
            bytes: contentChars, frames: chunks, truncated, empty
          });
        } catch (err) {
          if (clientGone) {
            /* ── 客户端断开：主动释放上游，并**验证**它真的被释放 ──────────────
               证据链：abort 上游 signal → reader.read() 立即 reject → upstreamReleased=true。
               这条日志就是"真实释放"的可复核服务端证据（不是前端按钮状态）。 */
            try { controller.abort('client_abort'); } catch (e) {}
            let upstreamReleased = false;
            try { await reader.read(); } catch (e) { upstreamReleased = true; }
            logEvent({
              event: 'client_abort', endpoint: '/v1/chat', agentId: req.agentId, mode: req.mode,
              code: 'aborted', latencyMs: Date.now() - t0, bytes: contentChars,
              upstreamReleased, reason: 'client_disconnected'
            });
            budgetFlush(env, false);
          } else {
            const isAbort = String(err && err.name) === 'AbortError' || controller.signal.aborted;
            try {
              send({ type: 'error', code: isAbort ? 'upstream_timeout' : 'upstream_error', message: userText(isAbort ? 'upstream_timeout' : 'upstream_5xx'), retryable: true });
            } catch (e) { /* 客户端同时断开，忽略 */ }
            logEvent({ event: 'stream_failed', endpoint: '/v1/chat', agentId: req.agentId, mode: req.mode, code: isAbort ? 'upstream_timeout' : 'upstream_error', latencyMs: Date.now() - t0, bytes: contentChars });
          }
        } finally {
          clearTimeout(timer);
          try { ctrl.close(); } catch (e) {}
        }
      },
      cancel(reason) {
        // 次要路径：Cloudflare 上实测不会触发（见 write() 注释），保留作为兜底
        clientGone = true;
        upstreamAbortedByClient = true;
        controller.abort('client_abort');
        // 用 waitUntil 保证 KV 写入不被 isolate 回收打断（这是可复核的服务端证据）
        const rec = recordAbort(env, { at: Date.now(), reason: String(reason || 'client_cancel') });
        if (ctx && ctx.waitUntil) ctx.waitUntil(rec);
      }
    });

    return new Response(stream, { status: 200, headers: Object.assign({}, SSE_HEADERS, cors) });
  }
};

/* ── 辅助 ─────────────────────────────────────────────────────────── */

function countUsage(env, usage) {
  const total = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  mem.budget.tokens += total;
  mem.budget.requests += 1;
  mem.budget.pending += 1;
  budgetFlush(env, false);
}

/** 中止证据落 KV（中止是低频事件，写入量可接受），供 /v1/diag 复核 */
function recordAbort(env, rec) {
  if (!env.TAVERN_KV) return;
  const p = (async () => {
    try {
      await env.TAVERN_KV.put('diag:lastAbort', JSON.stringify(rec), { expirationTtl: 3600 });
      let c = { aborts: 0, requests: 0 };
      try { c = JSON.parse((await env.TAVERN_KV.get('diag:counters')) || 'null') || c; } catch (e) {}
      c.aborts = (c.aborts || 0) + 1;
      await env.TAVERN_KV.put('diag:counters', JSON.stringify(c), { expirationTtl: 86400 });
    } catch (e) { /* 忽略 */ }
  })();
  return p;
}

function validate(body) {
  if (!body || typeof body !== 'object') return { error: '请求体必须是对象' };
  const agentId = String(body.agentId || '');
  if (['bartender', 'oracle', 'muse'].indexOf(agentId) === -1) return { error: 'agentId 非法' };
  const mode = body.mode === 'quick' ? 'quick' : 'deep';
  const task = body.task === 'extract' ? 'extract' : (body.task === 'cognition' ? 'cognition' : 'generate');
  const msgs = Array.isArray(body.messages) ? body.messages : null;
  if (!msgs || !msgs.length) return { error: 'messages 不能为空' };
  if (msgs.length > LIMITS.maxMessages) return { error: 'messages 过多' };
  let total = 0;
  for (const m of msgs) {
    if (!m || typeof m.content !== 'string') return { error: 'messages 元素必须是 {role, content}' };
    if (['system', 'user', 'assistant'].indexOf(m.role) === -1) return { error: 'role 非法' };
    if (m.content.length > LIMITS.maxCharsPerMessage) return { error: '单条消息过长' };
    total += m.content.length;
  }
  if (total > LIMITS.maxTotalChars) return { error: '输入过长' };
  return { agentId, mode, task, messages: msgs.map((m) => ({ role: m.role, content: m.content })) };
}

function buildUpstreamBody(req, route, body) {
  const wantJson = route.json || req.task === 'cognition' || body.responseFormat === 'json';
  const maxTokens = Math.max(route.minMaxTokens, Number(body.maxTokens || 0) || route.defaultMaxTokens);
  const out = {
    model: route.model,
    messages: req.messages,
    stream: !route.noStream,
    max_tokens: maxTokens,
    thinking: route.thinking
  };
  // reasoning_effort 只在 thinking 开启且路由声明了 effort 时设置
  if (route.thinking && route.thinking.type === 'enabled' && route.effort) out.reasoning_effort = route.effort;
  if (route.noStream) out.stream = false;
  if (wantJson) out.response_format = { type: 'json_object' };   // json_schema 实测不可用
  return out;
}
