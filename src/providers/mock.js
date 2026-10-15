/* ══════════════════════════════════════════════════════════════════════════
   mock.js — MockProvider：不调用任何 LLM 的模拟引擎（Stage 1-2）
   ──────────────────────────────────────────────────────────────────────────
   ── 诚实边界（这是本文件最重要的约定）──
   每一轮里发生的事，分三类：

   ① 真实计算（computeMs 为 performance.now() 实测）：
        · 意图分类：真实的关键词打分，输出词表与 persona-spec §1.4 的意图集一致
        · 记忆检索：只检索**本会话真实历史消息**，不编造任何记忆（红线 U1）
        · 卡片生成：模板 + 真实数据（用户原话、命中记忆、真实掷骰结果）
        · 掷骰：真实随机数，结果进入计划卡的 basis
        · 分块：真实按标点/长度切分，节奏由 turnId 派生的确定性 PRNG 决定
   ② 模拟延迟（simMs，显式标注）：本文件唯一"假装"的东西是**时间**。
      真实推理不存在，所以用 LATENCY 模型占位，且该模型 id 会随每轮上报，
      面板上 computeMs 与 simMs 分开显示，不混为一谈。
   ③ 不做的事：不产生任何未被真实计算支撑的事件（禁止假 thinking 动画、
      禁止假完成状态）；kind:'mock' 的标识必须在所有展示位置可见。

   Stage 3 接入真实引擎时，本文件整体退化为「离线剧本模式」的 Provider，
   不作为默认 Provider；Stage 2 的 GatewayClient 与它同接口。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var P = global.Tavern.Provider;
  var S = global.Tavern.MockScripts;

  /* ── ② 模拟延迟模型（id 会上报，面板可见） ─────────────────────────── */
  var LATENCY_MODEL_ID = 'mock-latency@v1';
  var LATENCY = {
    'turn.start': [15, 35],
    'intent.created': [70, 140],
    'memory.checked': [45, 110],
    'plan.created': [130, 240],
    'turn.end': [25, 55]
  };
  var CHUNK = { min: 2, max: 6, msPerCharMin: 6, msPerCharMax: 16 };

  /* 记忆匹配器参数（id 上报到面板，便于核对"命中的判定标准是什么"） */
  var MATCHER = {
    id: 'mock-keyword@v1',
    threshold: 0.12,
    requireOverlap: true,
    maxHits: 3,
    weights: { overlap: 0.8, recency: 0.2 }
  };

  /* ── 确定性随机（同一 turnId + 同一输入 → 同一节奏，报告可复现） ──── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFrom(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function abortError() { var e = new Error('本轮已被中断'); e.name = 'AbortError'; return e; }
  function between(rnd, pair) { return Math.round(pair[0] + rnd() * (pair[1] - pair[0])); }
  function trim(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

  /* ── ① 真实计算：意图分类 ──────────────────────────────────────────
     输出词表与 persona-spec §1.4 的意图集一致：plan / decide / analyze / knowledge / chitchat */
  var KEYWORDS = {
    plan: ['计划', '安排', '规划', '目标', '步骤', '怎么开始', '怎么做', '学起来', '准备', '路线', '落地', '推进'],
    decide: ['该不该', '要不要', '还是', '纠结', '取舍', '值不值', '放弃', '选哪', '选择'],
    analyze: ['为什么', '原因', '分析', '对比', '区别', '差异', '利弊', '评估', '拆解'],
    knowledge: ['是什么', '什么是', '怎么理解', '什么意思', '解释', '原理', '定义', '介绍', '科普']
  };

  function classify(text) {
    var t = String(text).toLowerCase();
    var scores = {}, matched = {}, total = 0, best = 'chitchat', bestScore = 0;
    for (var intent in KEYWORDS) {
      var s = 0, hit = [];
      var list = KEYWORDS[intent];
      for (var i = 0; i < list.length; i++) {
        var k = list[i];
        if (t.indexOf(k) !== -1) { s += k.length; hit.push(k); }   // 命中越长的词，得分越高
      }
      scores[intent] = s; matched[intent] = hit; total += s;
      if (s > bestScore) { bestScore = s; best = intent; }
    }
    var confidence = bestScore === 0 ? 0.35 : Math.min(0.95, 0.45 + bestScore / (total + bestScore) * 0.5);
    return {
      intent: bestScore === 0 ? 'chitchat' : best,
      confidence: Math.round(confidence * 100) / 100,
      matched: matched[bestScore === 0 ? 'plan' : best] || [],
      scores: scores,
      method: 'keyword-score@v1'
    };
  }

  /* ── ① 真实计算：记忆检索（只用本会话真实历史，绝不编造） ─────────── */
  function tokenize(text) {
    var s = String(text).toLowerCase().replace(/[，。！？、；：""''（）《》【】,.!?;:()\[\]{}<>\s\-—*~]+/g, '');
    var grams = [];
    for (var i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));   // 中文二元组
    var words = String(text).toLowerCase().match(/[a-z0-9]{2,}/g) || [];    // 英文/数字词元
    return grams.concat(words);
  }

  function checkMemory(text, agentId, history) {
    var prior = (history || []).filter(function (m) { return m.role === 'user' && m.content && m.content.trim(); });
    var q = tokenize(text);
    var qset = {};
    q.forEach(function (g) { qset[g] = 1; });

    var scored = prior.map(function (m, idx) {
      var t = tokenize(m.content), tset = {}, overlap = 0;
      t.forEach(function (g) { tset[g] = 1; });
      for (var g in qset) if (tset[g]) overlap++;
      var denom = Math.max(3, Math.min(Object.keys(qset).length, Object.keys(tset).length));
      var overlapRatio = overlap / denom;
      var recency = prior.length <= 1 ? 1 : idx / (prior.length - 1);        // 越近越高
      return {
        id: m.id, text: trim(m.content, 26), at: m.at,
        score: Math.round((MATCHER.weights.overlap * overlapRatio + MATCHER.weights.recency * recency) * 100) / 100,
        overlap: overlap
      };
    })
      // 必须有词面重叠才算候选：否则「最近说过的一句」会因为新鲜度得分而冒充命中，
      // 那等于任何问题都命中最近一条 —— 记忆展示立刻不可信。
      // 新鲜度只参与排序，不单独构成命中。
      .filter(function (x) { return x.overlap > 0 && x.score >= 0.12; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, MATCHER.maxHits);

    return {
      hits: scored,
      poolSize: prior.length,
      candidateCount: prior.length,
      threshold: MATCHER.threshold,
      requireOverlap: MATCHER.requireOverlap,
      matcher: MATCHER.id,
      note: '只检索本会话真实历史消息；不生成、不编造记忆；无词面重叠不算命中'
    };
  }

  /* ── ① 真实计算：掷骰（结果映射到决策取向，而非无意义数字） ───────── */
  function rollDice(rnd) {
    var value = 1 + Math.floor(rnd() * 6);
    var stance = value <= 2 ? '先别动，信息不够' : (value <= 4 ? '可以做，但要压小' : '值得做，前提是可逆');
    return { value: value, faces: 6, rationale: stance };
  }

  /* ── ① 真实计算：卡片生成（模板 + 真实数据） ─────────────────────── */
  function deepFill(node, ctx) {
    if (typeof node === 'string') {
      return node.replace(/\{(\w+)\}/g, function (m, key) { return ctx[key] != null ? ctx[key] : m; });
    }
    if (Array.isArray(node)) return node.map(function (n) { return deepFill(n, ctx); });
    if (node && typeof node === 'object') {
      var out = {};
      for (var k in node) out[k] = deepFill(node[k], ctx);
      return out;
    }
    return node;
  }

  function buildCard(agentId, ctx) {
    var tpl = S.CARDS[agentId];
    if (!tpl) return null;
    return deepFill(tpl, ctx);
  }

  /* ── ① 真实计算：回复文本组装（模板 + 真实数据） ────────────────── */
  var BRANCH_OF = {
    plan: 'action', decide: 'action', analyze: 'action',
    knowledge: 'inform', chitchat: 'chat'
  };

  function composeReply(agentId, intent, mem, card, userText) {
    var branch = BRANCH_OF[intent.intent] || 'chat';
    var tpl = (S.REPLIES[agentId] || {})[branch] || '';
    var memLine;
    if (mem.hits.length) {
      memLine = S.MEMORY_LINES.hit.replace('{memory}', mem.hits[0].text);
    } else {
      memLine = mem.poolSize === 0 ? S.MEMORY_LINES.missFirst : S.MEMORY_LINES.missNone;
    }
    return deepFill(tpl, {
      topic: trim(userText, 24),
      memLine: memLine,
      firstAction: trim(card && card.firstAction || '', 40),
      image: card && card.seed && card.seed.image || '',
      seeds: card && card.seed ? card.seed.words.join(' / ') : ''
    });
  }

  /* ── ① 真实分块流式（节奏来自确定性 PRNG + 标点偏好） ───────────── */
  function splitChunks(text, rnd) {
    var chunks = [], i = 0, punct = '，。！？、；：\n—~*';
    while (i < text.length) {
      var n = CHUNK.min + Math.floor(rnd() * (CHUNK.max - CHUNK.min + 1));
      var end = Math.min(text.length, i + n);
      for (var k = end; k > i + 1 && k < i + n + 2; k++) {
        if (punct.indexOf(text[k - 1]) !== -1) { end = k; break; }   // 尽量在标点处断
      }
      chunks.push(text.slice(i, end));
      i = end;
    }
    return chunks;
  }

  var CHUNK_GAP_BASE = 70;   // 每块之间的固定底座 + 与块长成正比的抖动

  /* ── 阶段执行器：真实计算 + 已声明的模拟延迟 ─────────────────────── */
  function phase(name, sink, rnd, signal, compute, detailExtra) {
    var wall0 = now();
    sink.phase(name, 'active', { startedAt: new Date().toISOString() });
    return Promise.resolve()
      .then(function () {
        var c0 = now();
        var out = compute ? compute() : {};
        var computeMs = Math.round((now() - c0) * 100) / 100;
        var simMs = between(rnd, LATENCY[name] || [20, 60]);
        return sleep(simMs).then(function () {
          if (signal && signal.aborted) throw abortError();
          var detail = {};
          for (var k in (out || {})) detail[k] = out[k];
          for (var k2 in (detailExtra || {})) detail[k2] = detailExtra[k2];
          detail.computeMs = computeMs;
          detail.simMs = simMs;
          detail.simulated = true;
          detail.latencyModel = LATENCY_MODEL_ID;
          detail.wallMs = Math.round(now() - wall0);
          sink.phase(name, 'done', detail);
          return detail;
        });
      });
  }

  /* ── Provider ─────────────────────────────────────────────────────── */
  var Mock = {
    id: 'mock@1.0',
    kind: 'mock',
    meta: {
      label: '模拟引擎 · 无 LLM 调用',
      isMock: true,
      version: '1.0',
      matcher: MATCHER.id,
      latencyModel: LATENCY_MODEL_ID,
      note: '真实计算（意图/检索/卡片/掷骰）+ 显式标注的模拟延迟；不调用任何外部 API'
    },

    chat: function (request, sink) {
      P.validateRequest(request);
      var rnd = mulberry32(seedFrom(request.turnId + '|' + request.agentId + '|' + request.userText));
      var signal = request.signal;
      var t0 = now();
      var intent = null, mem = null, card = null, dice = null, reply = '';
      var chunkCount = 0;

      function guard() { if (signal && signal.aborted) throw abortError(); }

      return phase('turn.start', sink, rnd, signal, function () {
        return { mode: request.mode, pipeline: 'full', provider: Mock.id, userChars: request.userText.length };
      })
        .then(function () {
          guard();
          return phase('intent.created', sink, rnd, signal, function () {
            intent = classify(request.userText);
            return { intent: intent.intent, confidence: intent.confidence, matched: intent.matched, scores: intent.scores, method: intent.method };
          });
        })
        .then(function () {
          guard();
          return phase('memory.checked', sink, rnd, signal, function () {
            mem = checkMemory(request.userText, request.agentId, request.history);
            return { hits: mem.hits.length, poolSize: mem.poolSize, threshold: mem.threshold, matcher: mem.matcher };
          });
        })
        .then(function () {
          guard();
          sink.memory(mem.hits, {
            turnId: request.turnId, matcher: mem.matcher, poolSize: mem.poolSize,
            threshold: mem.threshold, requireOverlap: mem.requireOverlap
          });
          if (request.agentId === 'bartender') {
            var d0 = now();
            dice = rollDice(rnd);
            sink.tool({ name: 'dice', args: { faces: 6, purpose: intent.intent }, result: dice, ms: Math.round((now() - d0) * 100) / 100, simulated: false });
          }
          var diceBasis = dice ? 'dice:' + dice.value + '/6' : 'dice:n/a';
          var memBasis = mem.hits.length ? 'mem:' + mem.hits[0].id : 'mem:none(session)';
          card = buildCard(request.agentId, {
            topic: trim(request.userText, 40),
            topicShort: trim(request.userText, 18),
            basis: diceBasis + ' + ' + memBasis
          });
          return phase('plan.created', sink, rnd, signal, function () {
            return {
              cardType: card ? card.type : 'none',
              cardVersion: card ? card.v : null,
              basis: card && card.basis || null,
              sourcesOk: card && card.type === 'knowledge' ? card.sourcesOk : null,
              fields: card ? Object.keys(card) : []
            };
          });
        })
        .then(function () {
          guard();
          sink.phase('response.chunk', 'active', { streaming: true });
          var c0 = now();
          reply = composeReply(request.agentId, intent, mem, card, request.userText);
          var composeMs = Math.round((now() - c0) * 100) / 100;
          var chunks = splitChunks(reply, rnd);
          var i = 0, streamSimMs = 0;
          function next() {
            if (signal && signal.aborted) return Promise.reject(abortError());
            if (i >= chunks.length) return Promise.resolve();
            var c = chunks[i++];
            chunkCount++;
            sink.chunk(c);
            var gap = CHUNK_GAP_BASE + Math.round(c.length * (CHUNK.msPerCharMin + rnd() * (CHUNK.msPerCharMax - CHUNK.msPerCharMin)));
            streamSimMs += gap;
            return sleep(gap).then(next);
          }
          return next().then(function () {
            sink.phase('response.chunk', 'done', {
              chars: reply.length,
              chunks: chunkCount,
              computeMs: composeMs,
              simMs: streamSimMs,
              simulated: true,
              latencyModel: LATENCY_MODEL_ID + ':chunk',
              pacing: 'gap = f(分块长度, 确定性 PRNG)；同一 turnId+输入 → 同一节奏（可复现）',
              wallMs: Math.round(now() - c0)
            });
          });
        })
        .then(function () {
          guard();
          // 只报"表现层"提示。能量/XP/亲和度/发言数是冻结规则下的**每轮结算**，
          // 由 core/turn.js 按 mode 在唯一位置应用一次（快速 −3 / 深潜 −8），
          // Provider 自报会与桥接层重复扣减。
          var patch = { mood: intent.intent === 'chitchat' ? 'warm' : 'thoughtful' };
          if (request.agentId === 'muse') patch.mood = 'energized';
          return phase('turn.end', sink, rnd, signal, function () {
            return { statusHint: patch, reason: '数值结算在 core/turn.js（按 mode）；本 Provider 只报 mood' };
          }).then(function () { sink.status(patch); });
        })
        .then(function () {
          var wallMs = Math.round(now() - t0);
          var out = {
            reply: reply,
            provider: Mock.id,
            providerKind: 'mock',
            mode: request.mode,
            intent: intent,
            memory: mem,
            card: card,
            toolCalls: dice ? [{ name: 'dice', args: { faces: 6 }, result: dice }] : [],
            chunks: chunkCount,
            wallMs: wallMs,
            simulatedLatencyModel: LATENCY_MODEL_ID,
            aborted: false
          };
          sink.final(reply, out);
          return out;
        });
    }
  };

  global.Tavern = global.Tavern || {};
  global.Tavern.Providers = global.Tavern.Providers || {};
  global.Tavern.Providers.Mock = Mock;
  /* 暴露给自检与面板展示，便于核对"模拟了什么" */
  global.Tavern.Providers.Mock._internals = Object.freeze({
    LATENCY_MODEL_ID: LATENCY_MODEL_ID,
    LATENCY: Object.freeze(LATENCY),
    CHUNK: Object.freeze(CHUNK),
    classify: classify,
    checkMemory: checkMemory,
    splitChunks: splitChunks
  });
})(window);
