/* ══════════════════════════════════════════════════════════════════════════
   gateway.js — GatewayProvider：真实模型（经 Cloudflare Worker 网关）
   ──────────────────────────────────────────────────────────────────────────
   依据：docs/stage-2-gateway-contract.md g1.1
     · 上游 SSE 的解析与错误归一化在 **Worker 侧**完成；本文件只消费归一化后的
       四种帧（reasoning / content / usage / error），因此客户端体积与分支都更小。
     · 浏览器**永远不持有密钥**：只持有 Worker 端点。
     · DR-009：reasoning 帧只上报给 sink 用于**计算度量**，原文由 core/turn.js 立即丢弃。
       本文件不发承载原文的事件、不写日志、不落存储。

   prompt 由上层组装后经 request.context.prompt 传入：本文件**不拼 persona**、
   不判断 agent、不生成 system prompt，只负责模型通信。

   只上报真实发生的事：live Provider **不产生** intent/memory/plan 这些阶段事件
   （那些属于 Stage 3 的本地认知步骤）。真实步骤只有：开始一轮 / 生成回复 / 收束本轮。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var P = global.Tavern.Provider;

  var TIMEOUTS = { firstByteMs: 35000, reflectMs: 15000 };     // 首个字节（含 reasoning 帧）；reflectMs：Deep 收尾自检（第二次调用）上限
  var state = { endpoint: '' };

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  /** 结构化错误：turn.js 依据 kind 决定步骤状态与用户文案（契约 §3 错误矩阵） */
  function GatewayError(kind, message, extra) {
    var e = new Error(message || kind);
    e.name = 'GatewayError';
    e.kind = kind;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  var Gateway = {
    id: 'gateway@1.0',
    kind: 'live',
    meta: {
      label: '真实模型 · 经网关',
      isMock: false,
      version: '1.0',
      note: '密钥只在 Worker；浏览器只持有网关端点。上游解析与错误归一化在服务端完成。'
    },

    timeouts: TIMEOUTS,                          // 诊断/测试可读；调小 reflectMs 可验证超时降级
    /** 由 boot 在探活成功后调用 */
    setEndpoint: function (url) { state.endpoint = String(url || '').replace(/\/+$/, ''); },
    endpoint: function () { return state.endpoint; },
    isReady: function () { return !!state.endpoint; },

    /** Stage 8（§1.6.3）：Evaluator 记忆抽取——Deep 轮回复落地后的第 3 次调用（后置、非阻塞）。
        复用 Worker extract 路由；成功返回 {memories:[…]}（空数组 = 模型判定无事可记），
        任何失败（网络/超时/解析/中止）返回 null（调用方回退原文写入）。降级边界：绝不 throw。 */
    evaluate: function (req) {
      var r = req || {};
      if (!state.endpoint) return Promise.resolve(null);
      if (r.signal && r.signal.aborted) return Promise.resolve(null);
      var c = new AbortController();
      var t = setTimeout(function () { c.abort(); }, TIMEOUTS.reflectMs);
      var onAb = function () { c.abort(); };
      if (r.signal) r.signal.addEventListener('abort', onAb);
      function fin(v) {
        clearTimeout(t);
        if (r.signal) r.signal.removeEventListener('abort', onAb);
        return v;
      }
      return fetch(state.endpoint + '/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: r.agentId, task: 'extract', stream: false,
          messages: [
            { role: 'system', content: String(r.system || '') },
            { role: 'user', content: '【用户】' + String(r.userText || '') + '\n【回复】' + String(r.replyText || '') }
          ],
          client: { v: 1, turnId: r.turnId }
        }),
        signal: c.signal
      }).then(function (res) {
        if (!res.ok) return fin(null);
        return res.text().then(function (raw) {
          var j = null, v = null;
          try { j = JSON.parse(raw); v = JSON.parse(j && j.content); } catch (e) { v = null; }
          if (!v || !Array.isArray(v.memories)) return fin(null);
          var out = [];
          for (var i = 0; i < v.memories.length && out.length < 3; i++) {
            var m = v.memories[i] || {};
            var txt = String(m.text || '').trim().slice(0, 80);
            if (!txt) continue;
            var ty = (m.type === 'preference' || m.type === 'goal' || m.type === 'fact' || m.type === 'event') ? m.type : 'fact';
            out.push({ text: txt, type: ty });
          }
          return fin({ memories: out });
        });
      }).catch(function () { return fin(null); });
    },

    chat: function (request, sink) {
      P.validateRequest(request);
      if (!state.endpoint) {
        return Promise.reject(GatewayError('network', '网关端点未配置'));
      }
      var mode = request.mode === 'quick' ? 'quick' : 'deep';
      // 只消费上层组装好的 prompt（本 Provider 不拼 persona、不判断 agent、不生成 system）
      var ctxPrompt = (request.context && request.context.prompt) || null;
      var messages = (ctxPrompt && ctxPrompt.messages && ctxPrompt.messages.length)
        ? ctxPrompt.messages
        : [{ role: 'user', content: request.userText }];   // 未装配时退化，仍不拼 persona
      var t0 = now();
      var ctrl = new AbortController();
      var firstByteSeen = false;
      var firstByteFired = false;
      var timer = setTimeout(function () { firstByteFired = true; ctrl.abort(); }, TIMEOUTS.firstByteMs);
      var onUserAbort = null;
      if (request.signal) {
        if (request.signal.aborted) { clearTimeout(timer); return Promise.reject(abortErr()); }
        onUserAbort = function () { ctrl.abort(); };
        request.signal.addEventListener('abort', onUserAbort);
      }

      function cleanup() {
        clearTimeout(timer);
        if (request.signal && onUserAbort) request.signal.removeEventListener('abort', onUserAbort);
      }
      function abortErr() { var e = new Error('本轮已被中断'); e.name = 'AbortError'; return e; }

      var body = {
        agentId: request.agentId,
        mode: mode,
        task: 'generate',
        stream: true,
        messages: messages,
        client: { v: 1, turnId: request.turnId }
      };

      var ctx = { text: '', chunks: 0, usage: null, finishReason: null, doneFrame: false,
        reasoningBytes: 0, reasoningFrames: 0, ttftContent: null, ttftReasoning: null };

      sink.phase('turn.start', 'active', { mode: mode });
      sink.phase('turn.start', 'done', { mode: mode, endpoint: state.endpoint, messages: body.messages.length, wallMs: 0 });

      return fetch(state.endpoint + '/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (raw) {
            var info = {};
            try { info = JSON.parse(raw).error || {}; } catch (e) { info = { message: String(raw).slice(0, 200) }; }
            cleanup();
            throw GatewayError(info.code || 'http_error', info.message || ('HTTP ' + res.status), {
              httpStatus: res.status, requestId: info.requestId || null, retryable: !!info.retryable,
              userMessage: info.message
            });
          });
        }
        sink.phase('response.chunk', 'active', { streaming: true, mode: mode });

        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return finish(false);
            if (!firstByteSeen) { firstByteSeen = true; clearTimeout(timer); }
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop();
            for (var i = 0; i < lines.length; i++) {
              var s = lines[i].trim();
              if (!s || s.charAt(0) === ':') continue;               // 心跳/注释
              if (s === 'data: [DONE]') { ctx.doneFrame = true; continue; }
              if (s.indexOf('data:') !== 0) continue;
              var j;
              try { j = JSON.parse(s.slice(5).trim()); } catch (e) { continue; }

              if (j.type === 'reasoning' && typeof j.delta === 'string') {
                if (ctx.ttftReasoning === null) ctx.ttftReasoning = Math.round(now() - t0);
                ctx.reasoningBytes += j.delta.length;
                ctx.reasoningFrames++;
                // 只把 delta 交给 sink 用于度量；原文由 turn.js 丢弃（DR-009）
                if (sink.reasoning) sink.reasoning(j.delta);
              } else if (j.type === 'content' && typeof j.delta === 'string') {
                if (ctx.ttftContent === null) ctx.ttftContent = Math.round(now() - t0);
                ctx.text += j.delta;
                ctx.chunks++;
                sink.chunk(j.delta);
              } else if (j.type === 'usage') {
                ctx.usage = j;
                ctx.finishReason = j.finishReason || null;
              } else if (j.type === 'error') {
                cleanup();
                throw GatewayError(j.code || 'upstream_error', j.message || '上游错误', {
                  httpStatus: j.httpStatus || null, requestId: j.requestId || null, retryable: !!j.retryable, userMessage: j.message
                });
              }
            }
            return pump();
          });
        }

        /* Stage 6-6：Deep 收尾自检（第二次调用，复用 Worker 的 extract 路由）。
           降级边界：任何失败（超时/HTTP/解析/网络/中止）都收敛为 { status, reason }，
           绝不 throw、绝不改写回复、绝不影响 turn.end 已完成的结算。 */
        function reflect() {
          if (!ctx.text) return Promise.resolve({ status: 'skipped', reason: 'empty_reply' });
          if (!ctx.doneFrame) return Promise.resolve({ status: 'skipped', reason: 'stream_cut' });
          if (request.signal && request.signal.aborted) return Promise.resolve({ status: 'skipped', reason: 'aborted' });
          var sys = (request.context && request.context.reflect && request.context.reflect.system) || '';
          if (!sys) return Promise.resolve(null);
          var rT = setTimeout(function () { ctrl.abort(); }, TIMEOUTS.reflectMs);
          if (request.signal && onUserAbort) request.signal.addEventListener('abort', onUserAbort);
          var t1 = now();
          function done(o) {
            clearTimeout(rT);
            if (request.signal && onUserAbort) request.signal.removeEventListener('abort', onUserAbort);
            o.wallMs = Math.round(now() - t1);
            return o;
          }
          return fetch(state.endpoint + '/v1/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              agentId: request.agentId, task: 'extract', stream: false,
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: '【用户】' + request.userText + '\n【回复】' + ctx.text }
              ],
              client: { v: 1, turnId: request.turnId }
            }),
            signal: ctrl.signal
          }).then(function (res) {
            if (!res.ok) return done({ status: 'error', reason: 'http', httpStatus: res.status });
            return res.text().then(function (raw) {
              var j = null, v = null;
              try { j = JSON.parse(raw); v = JSON.parse(j && j.content); } catch (e) { v = null; }
              if (!v || typeof v.ok !== 'boolean') return done({ status: 'error', reason: 'invalid_json' });
              return done({
                status: 'done', ok: !!v.ok,
                issues: Array.isArray(v.issues) ? v.issues.slice(0, 5).map(String) : [],
                usage: (j && j.usage) || null
              });
            });
          }).catch(function () {
            /* 冻结补丁（P1）：双参 .then(onOk, onFail) 不捕获 onOk 内部拒绝——res.text() 读正文
               失败会穿透成整轮失败；.catch 形态使所有失败都收敛为降级对象（降级边界，绝不 throw）。 */
            if (request.signal && request.signal.aborted) return done({ status: 'skipped', reason: 'aborted' });
            return done({ status: 'error', reason: ctrl.signal.aborted ? 'timeout' : 'network' });
          });
        }

        function finish(sawDone) {
          cleanup();
          var empty = ctx.text.length === 0;
          var truncated = ctx.finishReason === 'length' && !empty;
          var cut = !ctx.doneFrame;                     // 未收到 [DONE] 即断流
          var detail = {
            mode: mode,
            chars: ctx.text.length,
            chunks: ctx.chunks,
            ttftMs: ctx.ttftContent,
            ttftContentMs: ctx.ttftContent,
            ttftReasoningMs: ctx.ttftReasoning,
            reasoningFrames: ctx.reasoningFrames,
            reasoningBytes: ctx.reasoningBytes,
            finishReason: ctx.finishReason,
            truncated: truncated,
            empty: empty,
            streamCut: cut,
            usage: ctx.usage ? {
              prompt: ctx.usage.prompt, completion: ctx.usage.completion,
              reasoning: ctx.usage.reasoning, cached: ctx.usage.cached
            } : null,
            simulated: false,
            wallMs: Math.round(now() - t0)
          };
          // 空正文（实测可能：HTTP 200 但推理吃光预算）与断流都必须显式上报，由桥接层标为 skipped
          sink.phase('response.chunk', 'done', detail);
          sink.phase('turn.end', 'done', { mode: mode, reason: 'client-side accounting in turn.js', wallMs: 0 });
          if (cut && !ctx.text) {
            throw GatewayError('stream_cut', '连接在产出正文前中断', { retryable: true });
          }
          /* Stage 6-6：Deep 收尾自检（Generate → Reflection → Final）；quick 轮不产生节点。
             截断/空正文/中止轮不发起调用，但保留可见的 skipped 原因（见 reflect）。 */
          var rp = mode === 'deep' ? reflect() : Promise.resolve(null);
          return rp.then(function (rf) {
            sink.final(ctx.text, {
              reply: ctx.text, provider: Gateway.id, providerKind: 'live', mode: mode,
              usage: detail.usage, finishReason: ctx.finishReason, truncated: truncated,
              empty: empty, streamCut: cut, latency: detail, wallMs: detail.wallMs, reflect: rf
            });
            return detail;
          });
        }

        return pump();
      }).catch(function (err) {
        cleanup();
        if (request.signal && request.signal.aborted) throw abortErr();
        if (firstByteFired) {
          throw GatewayError('client_timeout', '上游没有在超时时间内响应', { retryable: true });
        }
        if (err && err.name === 'GatewayError') throw err;
        if (err && err.name === 'AbortError') throw abortErr();
        throw GatewayError('network', String(err && err.message || err), { retryable: true });
      });
    }
  };

  global.Tavern = global.Tavern || {};
  global.Tavern.Providers = global.Tavern.Providers || {};
  global.Tavern.Providers.Gateway = Gateway;
})(window);
