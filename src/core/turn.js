/* ══════════════════════════════════════════════════════════════════════════
   turn.js — Turn 桥：Provider 事件 → 冻结的 TraceBus 事件 → Store 状态
   ──────────────────────────────────────────────────────────────────────────
   本文件**不是** Agent Engine。它做三件事，且只做这三件事：

     1. 生命周期：建轮次、建 AbortController、串起 Provider 的异步产出；
     2. 传输：把 Provider 上报的语义阶段翻译成 stage-0 §2.4 冻结的 TraceBus
        事件（阶段名 → 事件名的映射表在 core/provider.js 的 PHASE_TRANSPORT）；
     3. 落库：把结果写进 Store（消息、trace 步骤、Agent 运行时状态）。

   它不做：意图推理、记忆打分、prompt 组装、工具选择 —— 那些在 Provider 里
   （本阶段是 MockProvider，Stage 3 换成真实引擎），或在 Stage 3 的 TurnController。

   Stage 3 的真实引擎会自带编排，本文件的"传输 + 落库"两层仍被复用（离线模式、
   自检、以及任何非 LLM 的 Provider 都走这条路），因此不会被丢弃。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var Store = global.Tavern.Store;
  var EB = global.Tavern.EventBus;
  var P = global.Tavern.Provider;

  /* 错误 code → 用户可见中文（契约 §3 错误矩阵；不泄露上游原文与任何凭证） */
  var ERR_TEXT = {
    aborted: '本轮被中断',
    client_timeout: '上游没有响应，可重试',
    upstream_timeout: '上游超时',
    network: '网络不可达',
    auth: '网关配置异常，请稍后再试',
    bad_request: '本轮请求不被上游接受',
    rate_limited: '酒馆此刻有点忙，稍后重试',
    upstream_5xx: '上游故障',
    upstream_error: '上游返回了无法处理的响应',
    budget: '今日额度已用尽，已切到离线模式',
    stream_cut: '连接中断，回答不完整',
    empty_truncated: '上游未产出正文（token 预算不足）',
    json_truncated: '上游返回的内容无法解析',
    json_invalid: '上游返回的内容无法解析',
    error: '本轮未能完成'
  };

  var seq = 0;
  function uid(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + (++seq); }
  function perfNow() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  var current = null;   // { turnId, agentId, controller, replyId, ttft, chunks, chars, phaseMs, ... }

  /* ── 阶段 → TraceBus 事件 ─────────────────────────────────────────── */

  /** 边界阶段（turn.start / turn.end）不建普通步骤节点，走各自的专用事件 */
  var BOUNDARY = { 'turn.start': true, 'turn.end': true };

  /* D-1 语义去重：Cognition 已经产出「意图」「回答策略」两个步骤后，
     Provider 的同义模拟阶段不再新增节点（Trace 中每种语义只出现一次）。
     合并方式：把 Provider 的 detail/耗时并入已存在的认知步骤，并在其上标记
     providerMerged —— 事实仍可在面板展开查看，事件流里不产生重复的 done。 */
  var SEMANTIC_ALIAS = {
    'intent.created': 'intent.detect',
    'plan.created': 'plan.generate',
    'memory.checked': 'memory.search'      // Provider 的模拟记忆阶段并入真实检索步骤
  };

  function emitStep(turnId, agentId, phase, status, detail, label) {
    var alias = SEMANTIC_ALIAS[phase];
    if (alias) {
      var already = Store.findStep(alias);
      if (already) {
        // 不新增节点，但**状态必须照实反映**：Provider 在这个阶段干活时该步骤回到
        // active（否则中途中断就看不到任何"被中断"的痕迹），完成后回到 done 并合并细节。
        if (status === 'active') {
          already.status = 'active';
          already.providerRunning = true;
        } else if (status === 'done') {
          already.status = 'done';
          already.providerRunning = false;
          already.providerDetail = detail || null;
          already.providerMs = detail && detail.wallMs;
          already.providerMerged = true;
        }
        return already;
      }
    }
    var step = {
      stepId: phase,
      label: label || P.PHASE_LABEL[phase] || phase,
      status: status,
      ms: status === 'done' ? (detail && detail.wallMs) : null,
      detail: detail || null
    };
    Store.upsertStep(step);
    EB.emit('trace:step', { turnId: turnId, agentId: agentId, stepId: phase, status: status, ms: step.ms, detail: detail || null });
    return step;
  }

  /* ── sink：Provider 往这里上报，只有本文件能碰 Store 与 TraceBus ──── */

  function makeSink(ctx) {
    return {
      phase: function (phase, status, detail) {
        var transport = P.PHASE_TRANSPORT[phase];
        if (!transport) throw new Error('[Turn] 未登记的阶段名：' + phase);

        if (phase === 'turn.start') {
          if (status === 'done') EB.emit('trace:turn:start', { turnId: ctx.turnId, agentId: ctx.agentId, mode: ctx.mode, detail: detail || null });
          return;
        }
        if (phase === 'turn.end') {
          if (status === 'done') {
            ctx.phaseMs.turnEnd = detail && detail.wallMs;
            /* 每轮的状态增量在**唯一位置、恰好一次**地应用。
               数值来自冻结规则（persona-spec §1.5/§1.7/§2.8），按 mode 取值；
               Provider 不再上报数值，避免双重扣减。 */
            var preAff = Store.state.agents[ctx.agentId].affinity;
            var preTrust = Store.state.relationship[ctx.agentId].trust;
            Store.tickAllEnergy();   // Stage 7：能量懒结算（真实时间；先补后扣，唯一结算位）
            var applied = Store.applyStatusPatch(ctx.agentId, {
              energy: ctx.mode === 'quick' ? -3 : -8,
              xp: ctx.mode === 'quick' ? 2 : 6,   // Stage 6-4：对齐冻结规格「完成一轮 +2（Deep +6）」
              affinity: 1,
              talks: 1
            });
            if (applied) EB.emit('trace:status', { agentId: ctx.agentId, patch: applied, raw: { mode: ctx.mode, source: 'turn.js' }, turnId: ctx.turnId });
            // Stage 6-1：信任结算（唯一规则函数；每轮恰好一次；静默——affinity +1 原样不动）
            var td = trustDeltaFrom(ctx.userText);
            if (td) Store.applyTrust(ctx.agentId, td);
            // Stage 6-2：事件触发（唯一入口；本分支即 done ⇒ aborted/error 不触发；单条待决；静默）
            // Stage 6-4：事件级冷却（talks 计量、8 轮；无记录=首次直接放行；解析不清除）
            var EVS = global.Tavern.Events;
            if (EVS && typeof EVS.matchFor === 'function' && !Store.state.events[ctx.agentId].pending) {
              var ev = EVS.matchFor(ctx.agentId, ctx.userText, Store.state.agents[ctx.agentId].talks);
              var lt = ev ? (Store.state.events[ctx.agentId].lastTriggeredEvents[ev.id] || 0) : 0;
              if (ev && (!lt || Store.state.agents[ctx.agentId].talks - lt >= 8)) {
                Store.setPendingEvent(ctx.agentId, ev.id);
                Store.markEventTriggered(ctx.agentId, ev.id, Store.state.agents[ctx.agentId].talks);
              }
            }
            // Stage 6-3：成长反馈（只比较跃迁前/后，只生成一句用户提示；不改任何数值规则）
            var GP = global.Tavern.Personas;
            var gs = [];
            if (GP.relationshipStage(Store.state.agents[ctx.agentId].affinity) !== GP.relationshipStage(preAff)) {
              gs.push('你们的关系来到了「' + GP.relationshipStage(Store.state.agents[ctx.agentId].affinity) + '」');
            }
            if (GP.trustLabel(Store.state.relationship[ctx.agentId].trust) !== GP.trustLabel(preTrust)) {
              gs.push('信任程度：' + GP.trustLabel(Store.state.relationship[ctx.agentId].trust));
            }
            if (gs.length) Store.setNotice(ctx.agentId, gs.join(' · '));
            /* Stage 9（§1.6.4）：长会话压缩——消息数超过 coversUpTo+80 时，把其后最旧 40 条经本地
               summarize 压缩进 summaries[id].text（上限 800 字）；coversUpTo 指向最后被压缩的序号。
               纯本地、零调用、失败静默（不影响结算）。 */
            try {
              var SM = global.Tavern.MemoryService;
              var conv = Store.state.conversations[ctx.agentId] || [];
              var sm = Store.state.summaries[ctx.agentId];
              var from = sm ? (sm.coversUpTo || 0) : 0;
              if (SM && sm && typeof SM.summarize === 'function' && conv.length - from > 80) {
                var segs = [];
                for (var ci = from; ci < from + 40 && ci < conv.length; ci++) {
                  var cm = conv[ci];
                  if (cm && cm.content) segs.push((cm.role === 'user' ? '用户：' : '回应：') + cm.content);
                }
                var sum = SM.summarize(segs.join('\n'), 8);
                Store.setSummary(ctx.agentId, sum.points.join('\n'), from + 40);
              }
            } catch (e) { /* 静默隔离：压缩失败不影响结算 */ }
            var lat = {
              intent: ctx.phaseMs['intent.created'] || null,
              memory: ctx.phaseMs['memory.checked'] || null,
              plan: ctx.phaseMs['plan.created'] || null,
              ttft: ctx.ttft,
              contentTtft: ctx.ttft,
              reasoningTtft: ctx.reasoningTtft,
              reasoningFrames: ctx.reasoningFrames,
              reasoningBytes: ctx.reasoningBytes,
              total: Math.round(perfNow() - ctx.t0)
            };
            Store.setTurnMeta({ latency: lat });
            EB.emit('trace:turn:end', {
              turnId: ctx.turnId, agentId: ctx.agentId, mode: ctx.mode,
              usage: Object.assign({ chars: ctx.chars, chunks: ctx.chunks, tokensEstimated: false }, ctx.usage || {}),
              latencyMs: lat,
              aborted: false
            });
          }
          return;
        }
        if (status === 'done' && phase === 'response.chunk' && detail && detail.empty) {
          emitStep(ctx.turnId, ctx.agentId, phase, 'skipped',
            Object.assign({}, detail, { skippedReason: '上游未产出正文（finish_reason=' + (detail.finishReason || '未知') + '）' }));
          return;
        }
        if (status === 'done' && phase === 'response.chunk' && detail && detail.streamCut) {
          emitStep(ctx.turnId, ctx.agentId, phase, 'skipped',
            Object.assign({}, detail, { skippedReason: '连接中断，已收到 ' + (detail.chars || 0) + ' 字' }));
          return;
        }
        if (status === 'done') ctx.phaseMs[phase] = detail && detail.wallMs;
        emitStep(ctx.turnId, ctx.agentId, phase, status, detail);
      },

      chunk: function (delta) {
        if (ctx.ttft == null) ctx.ttft = Math.round(perfNow() - ctx.t0);
        if (!ctx.replyId) {
          // 首个分块到达时才创建回复气泡：在此之前不显示任何"思考中"占位
          ctx.replyId = uid('msg');
          Store.appendMessage(ctx.agentId, {
            id: ctx.replyId, role: 'assistant', content: '', at: Date.now(),
            meta: { streaming: true, provider: ctx.providerId, providerLabel: ctx.providerLabel, isMock: ctx.isMock, turnId: ctx.turnId }
          });
        }
        ctx.chunks++;
        ctx.chars += delta.length;
        Store.appendChunk(ctx.agentId, ctx.replyId, delta);
        Store.addChars(delta.length);
        EB.emit('trace:token', { turnId: ctx.turnId, agentId: ctx.agentId, kind: 'content', delta: delta });
      },

      memory: function (hits, meta) {
        // 真实检索（MemoryService）已在 provider 之前把结果落库；Provider 的模拟结果
        // **不得覆盖它**，而是作为 providerCheck 并存（面板可展开对比，不丢事实）
        var existing = Store.state.trace.meta.memoryCheck;
        var providerCheck = { count: hits.length, poolSize: meta.poolSize, matcher: meta.matcher, hits: hits };
        if (existing) {
          Store.setTurnMeta({ memoryCheck: Object.assign({}, existing, { providerCheck: providerCheck }) });
        } else {
          Store.setTurnMeta({ memoryCheck: Object.assign({
            threshold: meta.threshold, requireOverlap: meta.requireOverlap
          }, providerCheck) });
        }
        if (hits.length > 0) {
          EB.emit('trace:memory:hit', {
            turnId: ctx.turnId,
            agentId: ctx.agentId,
            ids: hits.map(function (h) { return h.id; }),
            scores: hits.map(function (h) { return h.score; })
          });
        }
      },

      /* DR-009：reasoning 只用于计算度量，原文在此丢弃 —— 不入 Store、不入日志、
         不发承载原文的事件、不渲染。任何展示都必须是"真实阶段进度 + 度量"。 */
      reasoning: function (delta) {
        if (typeof delta !== 'string' || !delta) return;
        if (ctx.reasoningTtft == null) ctx.reasoningTtft = Math.round(perfNow() - ctx.t0);
        ctx.reasoningFrames++;
        ctx.reasoningBytes += delta.length;
      },

      tool: function (call) {
        // Provider 上报的工具调用 → 与 registry 调用**并存累加**，不覆盖（D-2）
        recordToolCall(ctx, {
          name: call.name, args: call.args, result: call.result, ms: call.ms,
          ok: true, source: 'mock'
        });
      },

      status: function (patch) {
        // Provider 只能给"表现层"提示（mood）；能量/XP/亲和度/发言数一律由 turn.end 统一结算，
        // 否则不同 Provider 会各自扣一次 → 双重扣减。
        if (patch && patch.mood) Store.applyStatusPatch(ctx.agentId, { mood: patch.mood });
      },

      final: function (replyText, meta) {
        /* Stage 6-6：Deep 收尾自检的步骤落点（唯一位置）。状态/原因来自真实结果；
           quick 轮 meta.reflect 为 null ⇒ 不产生节点（无假步骤）。 */
        var rf = meta && meta.reflect;
        if (rf) {
          var rStep = emitStep(ctx.turnId, ctx.agentId, 'reflection', rf.status, rf, '自我检查');
          if (rf.reason) rStep.reason = rf.reason;
        }
        if (ctx.replyId) {
          Store.patchMessage(ctx.agentId, ctx.replyId, {
            meta: {
              streaming: false,
              provider: ctx.providerId, providerLabel: ctx.providerLabel, isMock: ctx.isMock,
              turnId: ctx.turnId, mode: ctx.mode,
              intent: meta.intent, memory: meta.memory,
              // 唯一落卡片点：先过来源审计（桥接层），再写入 message.meta.card
              card: auditCardSources(meta.card, ctx.tools),
              toolCalls: meta.toolCalls, wallMs: meta.wallMs,
              simulatedLatencyModel: meta.simulatedLatencyModel
            }
          });
        } else {
          // 没有产出任何分块（例如中途被中断）：留一条显式的空回复，而不是静默消失
          Store.appendMessage(ctx.agentId, {
            id: uid('msg'), role: 'assistant', content: '', at: Date.now(),
            meta: { streaming: false, empty: true, aborted: !!meta.aborted, provider: ctx.providerId, isMock: ctx.isMock, turnId: ctx.turnId }
          });
        }
        ctx.final = meta;

        /* Stage 4 Step 1：回复完成后**异步**写入记忆（不 await：失败绝不影响回答）。
           只记成功的完整回复（被中断 / 空回复不写）；结果只经 trace:memory:write 上报。 */
        if (typeof replyText === 'string' && replyText && !(meta && meta.aborted)) {
          var MW = global.Tavern.MemoryService;
          var uv = ctx.userText || '';
          // memory:write 发射器（成功/失败两形状；人工写入与启发式候选共用，协议字段不变）
          var emitW = function (m) { EB.emit('trace:memory:write', { turnId: ctx.turnId, agentId: ctx.agentId, memoryId: m.id, type: m.type, importance: m.importance, status: 'done' }); };
          var emitE = function (e) { EB.emit('trace:memory:write', { turnId: ctx.turnId, agentId: ctx.agentId, status: 'error', reason: String((e && e.message) || e) }); };
          /* Stage 8（§1.6.3）：Deep×LIVE 的记忆写入改由 Evaluator 抽取（后置非阻塞第 3 次调用）取代原文直存；
             抽取失败（null）回退原文写入；模型判定无事可记（[]）则如实不写、不 +1。
             其余路径（Quick / Mock / 无 evaluate 能力）维持原有写入，逐字不变。 */
          var Prov = global.Tavern.Provider;
          var prov = (Prov && Prov.current) ? Prov.current() : null;
          var rawWrite = function () {
            if (!MW || typeof MW.write !== 'function') return;
            try {
              MW.write({
                agentId: ctx.agentId, userText: uv, assistantText: replyText,
                metadata: {
                  turnId: ctx.turnId, mode: ctx.mode, provider: ctx.providerId,
                  intent: (ctx.cognition && ctx.cognition.intent) ? ctx.cognition.intent.name : null
                }
              }).then(function (rec) {
                if (rec) emitW(rec);
                // Stage 6-4：真实写入成功 +1 XP（heuristic 不计；仍由本文件唯一持账，memory 模块不碰 XP）
                if (rec && rec.source !== 'heuristic') Store.applyStatusPatch(ctx.agentId, { xp: 1 });
              }, emitE);
            } catch (e) {
              emitE(e);
            }
          };
          if (ctx.mode === 'deep' && prov && typeof prov.evaluate === 'function') {
            try {
              prov.evaluate({
                agentId: ctx.agentId, turnId: ctx.turnId, userText: uv, replyText: replyText,
                system: EXTRACT_SYSTEM, signal: ctx.controller ? ctx.controller.signal : null
              }).then(function (r) {
                if (!r) { rawWrite(); return; }
                var list = r.memories || [], claimed = false;
                for (var i = 0; i < list.length; i++) {
                  (function (m) {
                    if (!MW || typeof MW.write !== 'function') return;
                    try {
                      MW.write({
                        agentId: ctx.agentId, userText: m.text, assistantText: '',
                        metadata: { type: m.type, importance: 0.85, source: 'eval:' + ctx.turnId }
                      }).then(function (rec) {
                        if (rec) emitW(rec);
                        if (rec && !claimed) { claimed = true; Store.applyStatusPatch(ctx.agentId, { xp: 1 }); }
                      }, emitE);
                    } catch (e) { emitE(e); }
                  })(list[i]);
                }
              }, function () { rawWrite(); });
            } catch (e) { rawWrite(); }
          } else {
            rawWrite();
          }
          // Stage 5（§1.6.3，B1 加法）：Quick 轮追加本地启发式候选；无触发/失败均静默
          if (ctx.mode === 'quick' && MW && typeof MW.writeHeuristic === 'function') {
            try {
              MW.writeHeuristic({ agentId: ctx.agentId, userText: uv }).then(function (hr) {
                if (hr) emitW(hr);
              }, function () {});
            } catch (e) { /* 静默隔离 */ }
          }
        }
      }
    };
  }

  /* ── 信任变化规则（Stage 6-1，唯一位置）：命中所列词即 +1/−1，单轮最多 ±1；
     无词不动、纯本地零调用、静默（不发事件）；正负同现时取正（保守取向）。 */
  var TRUST_UP = ['谢谢', '喜欢', '开心', '帮助', '信任', '辛苦'];
  var TRUST_DOWN = ['讨厌', '骗人', '生气', '失望', '滚'];
  function trustDeltaFrom(text) {
    var t = String(text || '');
    for (var i = 0; i < TRUST_UP.length; i++) if (t.indexOf(TRUST_UP[i]) !== -1) return 1;
    for (var j = 0; j < TRUST_DOWN.length; j++) if (t.indexOf(TRUST_DOWN[j]) !== -1) return -1;
    return 0;
  }

  /* ── Deep 收尾自检（Stage 6-6）：第二次调用（Provider 经 Worker extract 路由执行）
     的系统提示词。只做质量检查、只输出 JSON、不输出思考过程；由本层持有并
     经 request.context.reflect 传入 —— Provider 不生成 system prompt。
     失败降级在 Provider 侧收敛（超时/HTTP/解析/网络/中止都不影响回复与结算）。 */
  var REFLECT_SYSTEM = '你是回复质量检查器。对照用户消息检查这份助手回复：是否答非所问、是否自相矛盾、是否有无依据的事实断言、是否空洞重复。只输出一个 JSON 对象，不要输出其他内容：通过时 {"ok":true,"issues":[]}；发现问题时 {"ok":false,"issues":["简短问题描述"]}。不要改写回复，不要输出思考过程。';

  /* ── Evaluator 记忆抽取（Stage 8，§1.6.3）：Deep 轮后置非阻塞的第 3 次调用。
     只抽取关于用户的长期事实（偏好/目标/身份）；没有值得记住的就返回空数组。
     由本层持有并经 Provider.evaluate 传入 —— Provider 不生成 system prompt。 */
  var EXTRACT_SYSTEM = '你是记忆抽取器。判断这轮对话里是否有关于用户、值得长期记住的事实（偏好、目标、身份、稳定习惯）。只输出一个 JSON 对象：没有值得记住的内容时输出 {"memories":[]}；有时最多 3 条：{"memories":[{"text":"去掉第一人称的简短事实（不超过 40 字）","type":"preference 或 goal 或 fact"}]}。不要复述对话，不要编造，不要输出任何其他内容。';

  /* ── 工具调用的步骤记录（D-2 合并语义）────────────────────────────────
     真实工具（source:'registry'）与 Mock 的模拟工具（source:'mock'）共用同一个
     `tool.call` 步骤，但**累加到 detail.calls 数组**，绝不后写覆盖前写。
     去重键 recordId 防重复插入；耗时按真实调用相加；已判 skipped 的步骤不回写成 done。 */
  function recordToolCall(ctx, call) {
    var step = Store.findStep('tool.call');
    if (!step) {
      step = { stepId: 'tool.call', label: '工具调用', status: 'active', ms: null, detail: { calls: [] } };
      Store.upsertStep(step, 'plan.created');      // 插在规划之前（既有位置）
    }
    if (!step.detail || !Array.isArray(step.detail.calls)) step.detail = { calls: [] };
    var rid = call.recordId || (call.source + ':' + call.name);
    var dup = false;
    for (var i = 0; i < step.detail.calls.length; i++) {
      if (step.detail.calls[i].recordId === rid) { dup = true; break; }
    }
    if (!dup) {
      step.detail.calls.push({
        recordId: rid, name: call.name, args: call.args, result: call.result,
        error: call.error || null, ms: call.ms, ok: call.ok !== false, source: call.source
      });
    }
    var total = 0;
    for (var j = 0; j < step.detail.calls.length; j++) total += (step.detail.calls[j].ms || 0);
    step.ms = Math.round(total * 100) / 100;
    step.label = '工具调用 · ' + step.detail.calls.map(function (c) { return c.name; }).join(' + ');
    if (step.status !== 'skipped') step.status = 'done';   // 中止后保持 skipped（不吞痕迹）
    EB.emit('trace:tool:call', {
      turnId: ctx.turnId, agentId: ctx.agentId, name: call.name,
      args: call.args, result: call.result, ms: call.ms
    });
    return step;
  }

  /* ── 认知（本地纯计算）与模式裁决 ─────────────────────────────────── */

  /** 把 Cognition 的结论发成两条真实的 trace:step（active → done），并用它自己的中文标签 */
  function emitCognition(ctx, cog, cogMs) {
    var Cog = global.Tavern.Cognition;
    var L = Cog.LABEL;
    emitStep(ctx.turnId, ctx.agentId, 'intent.detect', 'active', null, L['intent.detect']);
    emitStep(ctx.turnId, ctx.agentId, 'intent.detect', 'done', {
      name: cog.intent.name, confidence: cog.intent.confidence, matched: cog.intent.matched,
      scores: cog.intent.scores, method: cog.intent.method,
      wallMs: cogMs, note: '本地纯计算（与策略规划同属一次 pass 的实测耗时）'
    }, L['intent.detect']);
    emitStep(ctx.turnId, ctx.agentId, 'plan.generate', 'active', null, L['plan.generate']);
    emitStep(ctx.turnId, ctx.agentId, 'plan.generate', 'done', {
      steps: cog.plan.steps, basis: cog.plan.basis,
      suggestedMode: cog.suggestedMode, reasons: cog.reasons,
      wallMs: cogMs, note: '回答策略（Agent 怎么答你），不是用户的任务计划；卡片属后续阶段'
    }, L['plan.generate']);
  }

  /** 模式裁决：用户显式选择 > bartender 强制 > Cognition 建议（auto） */
  function resolveMode(chosen, suggested, agentId) {
    if (chosen === 'quick' || chosen === 'deep') return chosen;
    if (agentId === 'bartender') return 'deep';
    return suggested === 'quick' ? 'quick' : 'deep';
  }

  /* ── 发送一轮 ─────────────────────────────────────────────────────── */

  function send(agentId, text, opts) {
    if (isBusy()) return { ok: false, reason: 'busy', message: '上一轮还没结束' };
    if (!text || !String(text).trim()) return { ok: false, reason: 'empty', message: '没有输入内容' };

    var provider = P.requireCurrent();
    var agent = Store.agentById(agentId);
    if (!agent) throw new Error('[Turn] 未知 Agent：' + agentId);

    var history = Store.state.conversations[agentId].slice();   // 本轮之前的真实历史
    var userText = String(text).trim();
    Store.appendMessage(agentId, { id: uid('msg'), role: 'user', content: userText, at: Date.now(), meta: {} });

    var turnId = uid('turn');
    var pick = opts && opts.mode;
    var chosen = (pick === 'quick' || pick === 'deep' || pick === 'auto') ? pick : 'deep';
    var ctx = {
      turnId: turnId, agentId: agentId, mode: chosen, userText: userText,
      t0: perfNow(), ttft: null, chunks: 0, chars: 0,
      reasoningTtft: null, reasoningFrames: 0, reasoningBytes: 0, usage: null,
      replyId: null, phaseMs: {}, final: null,
      providerId: provider.id, providerLabel: provider.meta.label, isMock: provider.meta.isMock
    };
    Store.startTurn(turnId, agentId);

    /* 认知在 startTurn 之后（后者会清空 steps）、在 provider 之前。
       纯本地、确定性、零网络；结论既进 Trace 也进 Store.trace.meta.cognition。 */
    var Cog = global.Tavern.Cognition;
    var cognition = null;
    if (Cog && typeof Cog.run === 'function') {
      var cogT0 = perfNow();
      cognition = Cog.run({ text: userText, history: history, agentId: agentId });
      var cogMs = Math.round((perfNow() - cogT0) * 100) / 100;
      emitCognition(ctx, cognition, cogMs);
      Store.setTurnMeta({ cognition: cognition });
    }
    var mode = resolveMode(chosen, cognition && cognition.suggestedMode, agentId);
    ctx.mode = mode;
    ctx.cognition = cognition;

    /* Memory 检索：本地纯计算，固定顺序 Cognition → Memory → Persona。
       它只**读**认知结论（用于并列排序与展示），绝不反向影响 Cognition。 */
    var Msvc = global.Tavern.MemoryService;
    var memory = null;
    if (Msvc && typeof Msvc.search === 'function') {
      emitStep(turnId, agentId, 'memory.search', 'active', null, Msvc.LABEL);
      var mT0 = perfNow();
      memory = Msvc.search({
        agentId: agentId, text: userText, history: history,
        memories: Store.state.memories, intent: cognition && cognition.intent
      });
      var mMs = Math.round((perfNow() - mT0) * 100) / 100;
      Store.setTurnMeta({
        memoryCheck: {
          count: memory.hits.length, poolSize: memory.poolSize, matcher: memory.matcher,
          threshold: memory.threshold, requireOverlap: memory.requireOverlap,
          hits: memory.hits, params: memory.params, sources: memory.sources,
          note: memory.note
        }
      });
      emitStep(turnId, agentId, 'memory.search', 'done', {
        hits: memory.hits.length, poolSize: memory.poolSize, candidateCount: memory.candidateCount,
        matcher: memory.matcher, threshold: memory.threshold, requireOverlap: memory.requireOverlap,
        sources: memory.sources, intentHint: memory.intentHint, wallMs: mMs
      }, Msvc.LABEL);
      // Stage 4 Step 2：真实检索命中也发冻结事件（字段与既有协议一致，不加新字段）
      if (memory.hits.length) {
        EB.emit('trace:memory:hit', {
          turnId: turnId, agentId: agentId,
          ids: memory.hits.map(function (h) { return h.id; }),
          scores: memory.hits.map(function (h) { return h.score; })
        });
      }
      // Stage 4 Step 4：命中巩固（§1.6.2 冻结规则）——fire-and-forget，失败静默隔离，
      // 不阻塞回答、不产生 UI 错误、不发任何事件（纯静默）。
      if (memory.hits.length) {
        var MS = global.Tavern.MemoryStore;
        if (MS && typeof MS.reinforce === 'function') {
          try { MS.reinforce(agentId, memory.hits.map(function (h) { return h.id; })).then(null, function () {}); }
          catch (e) { /* 静默隔离 */ }
        }
      }
    }

    /* 工具执行：固定顺序 Cognition → Memory → Tool → Persona。
       只由本文件调用 ToolRegistry；Cognition / MemoryService / UI 都不直接调它。
       工具失败不会冒泡成异常（registry 内部收拢），因此不会打断整轮。 */
    var Tsvc = global.Tavern.ToolRegistry;
    var toolP = (Tsvc && typeof Tsvc.execute === 'function')
      ? Tsvc.execute({ agent: agent, intent: cognition && cognition.intent, userText: userText })
      : Promise.resolve({ calls: [] });

    return toolP.then(function (toolResult) {
      ctx.tools = toolResult;
      var tCalls = (toolResult && toolResult.calls) || [];
      for (var ti = 0; ti < tCalls.length; ti++) recordToolCall(ctx, tCalls[ti]);

      /* Persona 组装：本地纯计算，不读记忆、不决定 mode、不判断意图。
         它只把「persona 配置 + 关系状态 + 认知结论 + 记忆命中 + 工具结果（都以数据形式传入）」拼成 prompt。
         注意：它**不调用** MemoryService / ToolRegistry —— 记忆与工具结果只是入参。
         本轮把工具结果传入：由 PersonaService 包成 <untrusted> 并入任务块（persona-spec §1.1 第 7 块）。 */
      var Psvc = global.Tavern.PersonaService;
    var promptCtx = null;
    if (Psvc && typeof Psvc.assemble === 'function') {
      emitStep(turnId, agentId, 'persona.apply', 'active', null, Psvc.LABEL);
      var pT0 = perfNow();
      var built = Psvc.assemble({
        agent: agent, cognition: cognition, memory: memory,
        state: { agents: Store.state.agents, summaries: Store.state.summaries, user: Store.state.user, relationship: Store.state.relationship },
        history: history, userText: userText,
        tools: (ctx.tools && ctx.tools.calls) || []
      });
      var pMs = Math.round((perfNow() - pT0) * 100) / 100;
      promptCtx = built.prompt;
      emitStep(turnId, agentId, 'persona.apply', 'done', {
        agentId: agentId, promptBlocks: built.applied || [], messageCount: promptCtx.messages.length,
        hasPersona: true, systemChars: promptCtx.system.length, wallMs: pMs,
        // 记忆注入信息**并入本步骤**（不设独立的 memory.inject 步骤）
        injectedMemoryIds: memory ? memory.hits.map(function (h) { return h.id; }) : [],
        injectedMemoryCount: memory ? memory.hits.length : 0
      }, Psvc.LABEL);
    }

    var signal = null;
    if (typeof global.AbortController === 'function') {
      ctx.controller = new global.AbortController();
      signal = ctx.controller.signal;
    }
    current = ctx;

    // Stage 6-6：Deep 收尾自检的提示词由本层持有；Provider 不生成 system prompt，mock 忽略该字段
    var context = promptCtx ? { prompt: promptCtx } : {};
    if (mode === 'deep') context.reflect = { system: REFLECT_SYSTEM };
    var request = {
      turnId: turnId, agentId: agentId, mode: mode,   // Provider 只看到一个 mode；不知道它来自 Cognition
      history: history, userText: userText, signal: signal,
      state: { agents: Store.state.agents, conversations: Store.state.conversations },
      // Provider 只消费 context.prompt；它不知道 PersonaService / Cognition 的存在
      context: context
    };

    return Promise.resolve()
      .then(function () { return provider.chat(request, makeSink(ctx)); })
      .then(function (meta) {
        current = null;
        Store.endTurn();
        return { ok: true, turnId: turnId, meta: meta };
      })
      .catch(function (err) {
        var aborted = err && err.name === 'AbortError';
        var kind = aborted ? 'aborted' : ((err && err.kind) || 'error');
        var userMsg = ERR_TEXT[kind] || ERR_TEXT.error;
        // 中断/失败时把仍在进行中的步骤显式标为 skipped 并写明原因（不允许留下假的"进行中"）
        Store.markActiveStepsSkipped(aborted ? '本轮被中断' : (userMsg + '（' + kind + '）'));
        if (ctx.replyId) {
          Store.patchMessage(ctx.agentId, ctx.replyId, {
            meta: {
              streaming: false, aborted: aborted, provider: ctx.providerId, isMock: ctx.isMock, turnId: ctx.turnId,
              // 结构化错误：不含上游原文中的敏感内容；requestId 仅用于排查
              error: aborted ? null : { kind: kind, userMessage: userMsg, httpStatus: (err && err.httpStatus) || null, requestId: (err && err.requestId) || null, retryable: !!(err && err.retryable) },
              // 已有正文但被打断：标为"不完整"，不冒充完整回答
              incomplete: (ctx.chars > 0 && (aborted || kind === 'stream_cut' || kind === 'client_timeout' || kind === 'network' || kind === 'upstream_timeout')) || undefined
            }
          });
        } else {
          // 尚未产出任何分块就失败：留一条显式空回复（不静默消失），错误同样用结构化对象，
          // 保证 UI 只消费映射后的中文文案，绝不渲染上游原文。
          Store.appendMessage(ctx.agentId, {
            id: uid('msg'), role: 'assistant', content: '', at: Date.now(),
            meta: {
              streaming: false, empty: true, aborted: aborted,
              error: aborted ? null : { kind: kind, userMessage: userMsg, httpStatus: (err && err.httpStatus) || null, requestId: (err && err.requestId) || null, retryable: !!(err && err.retryable) },
              provider: ctx.providerId, isMock: ctx.isMock, turnId: ctx.turnId
            }
          });
        }
        EB.emit('trace:turn:end', {
          turnId: ctx.turnId, agentId: ctx.agentId,
          usage: { chars: ctx.chars, chunks: ctx.chunks },
          latencyMs: { ttft: ctx.ttft, total: Math.round(perfNow() - ctx.t0) },
          aborted: !!aborted,
          error: aborted ? null : String(err && err.message || err)
        });
        current = null;
        Store.endTurn();
        return { ok: false, reason: aborted ? 'aborted' : 'error', turnId: ctx.turnId, message: err && err.message };
      });
    });   // 结束 toolP.then(...)：工具 → Persona → Provider 的串行链
  }

  /* ── 卡片来源审计（Stage 3-4b Step 2）：persona-spec §3.7 冻结降级 + O1 硬拦截 ──
     只在这里（桥接层）审计即将写入 message.meta.card 的卡片；ToolRegistry / Provider /
     CardRenderer 都不知情，也不改消息结构与 CARD_SCHEMA。冻结规则照原文执行：
     ① sourcesOk 由**真实检索结果**决定（不信任卡片自带的声明，双向纠正）；
     ② points[].source.url 未出现在本次检索返回中 → 该 URL 剥除（source 置 null），
        confidence 上限压到 0.4。纯函数：返回新卡片对象，不修改入参；非 knowledge 卡原样放行。 */
  var SOURCE_CONF_CAP = 0.4;
  function auditCardSources(card, toolResult) {
    if (!card || typeof card !== 'object' || card.type !== 'knowledge' || !Array.isArray(card.points)) return card;
    var calls = (toolResult && toolResult.calls) || [];
    var real = [];
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      if (c && c.source === 'registry' && c.name === 'wiki_lookup' && c.ok !== false && c.result && c.result.url) {
        real.push({ title: String(c.result.title || ''), url: String(c.result.url) });
      }
    }
    var points = [];
    for (var j = 0; j < card.points.length; j++) {
      var p = card.points[j];
      if (!p || !p.source) { points.push(p); continue; }   // 未声明来源 → 不越权改动
      var hit = null;
      for (var k = 0; k < real.length; k++) if (String(p.source.url || '') === real[k].url) { hit = real[k]; break; }
      if (hit) {
        // 声明命中真实检索 → 保留来源；标题/URL 以真实返回为准（模型给错标题也不放行）
        points.push(Object.assign({}, p, { source: { title: hit.title, url: hit.url, retrievedAt: p.source.retrievedAt } }));
      } else {
        var conf = (typeof p.confidence === 'number') ? Math.min(p.confidence, SOURCE_CONF_CAP) : p.confidence;
        points.push(Object.assign({}, p, { source: null, confidence: conf }));
      }
    }
    return Object.assign({}, card, { points: points, sourcesOk: real.length > 0 });
  }

  function abort() {
    if (!current || !current.controller) return false;
    current.controller.abort();
    return true;
  }

  /**
   * 是否有进行中的一轮。
   * 注意：不能只看"有没有 active 步骤" —— 在线 Provider 在"已发出、上游尚未返回"的
   * 2~4 秒里没有任何步骤，那样 busy 会是 false，于是停止按钮不出现、还能重复发送。
   * 因此用整轮生命周期标记 trace.running（startTurn 置位、endTurn 清除）。
   */
  function isBusy() {
    if (Store.state.trace.running) return true;
    var steps = Store.state.trace.steps;
    for (var i = 0; i < steps.length; i++) if (steps[i].status === 'active') return true;
    return false;
  }

  global.Tavern.Turn = Object.freeze({
    send: send,
    abort: abort,
    isBusy: isBusy,
    activeTurnId: function () { return Store.state.trace.activeTurnId; }
  });
})(window);
