/* ══════════════════════════════════════════════════════════════════════════
   memory.js — MemoryService：记忆检索（Stage 3-2b，只做 search）
   ──────────────────────────────────────────────────────────────────────────
   唯一职责：从**两个真实来源**检索与当前输入相关的记忆，返回带分数与依据的命中列表。
     来源 1：冻结的台账 `state.memories`（Stage 0 §2.4 字段；本阶段通常为空，Stage 4 才写入）
     来源 2：**本会话的真实历史**（用户之前真的说过的话）——标注 source:'session'

   评分**逐字采用** persona-spec §1.6.1 的冻结公式与参数，不得自定：
     score = w1·关键词匹配 + w2·标签匹配 + w3·有效强度 + w4·新鲜度
     有效强度 = strength × e^(−λ × 距上次命中的天数)
     门槛 0.35 · topK 5 · 必须有词面重叠才算命中 · type=goal 且 strength>0.5 恒定入选
     w 与 λ 按 Agent 取值（personas.js 的 memory.w / memory.lambda）

   硬约束：
     · 纯本地：不调网络、不写 Store、不读 UI
     · 单向：可读 cognition 的结论（只用于排序 tie-break 与展示），**绝不反向影响 Cognition**
     · search 属 Stage 3-2b；write / MemoryStore 属 Stage 4 Step 1（只做写入基础设施）；
       consolidate（记忆整理）与检索接入 `state.memories` 属后续步骤
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var LABEL = '检索记忆';
  var P = global.Tavern.Personas;

  var THRESHOLD = 0.35;
  var TOP_K = 5;
  var PIN_STRENGTH = 0.5;          // type=goal 且 strength>此值时恒定入选
  var SESSION_STRENGTH = 0.4;      // 会话历史作为候选时的等效强度（真实数据、显式标注）

  /** 检索参数按 Agent 取（冻结值，见 persona-spec §1.6） */
  function paramsFor(agentId) {
    var list = P.AGENTS;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === agentId) {
        return { w: list[i].memory.w, lambda: list[i].memory.lambda, quota: list[i].memory.quota };
      }
    }
    return { w: [0.35, 0.20, 0.30, 0.15], lambda: 0.02, quota: 40 };
  }

  /** 中文二元组 + 英文/数字词元（确定性，无随机） */
  function tokenize(text) {
    var s = String(text || '').toLowerCase().replace(/[，。！？、；：""''（）《》【】,.!?;:()\[\]{}<>\s\-—*~]+/g, '');
    var grams = [];
    for (var i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
    var words = String(text || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];
    return grams.concat(words);
  }

  function daysSince(ts) {
    var t = typeof ts === 'number' && ts > 0 ? ts : Date.now();
    return Math.max(0, (Date.now() - t) / 86400000);
  }

  function effStrength(strength, lastAt, lambda) {
    return (typeof strength === 'number' ? strength : 0) * Math.exp(-lambda * daysSince(lastAt));
  }

  /**
   * 把四类来源统一成候选：{id, text, type, tags, strength, lastAt, source}
   * 主源 = MemoryStore（持久记忆，Stage 4 Step 2 接入，st 为 matchStore 结果；
   * strength 取 importance 占位——重要性算法属后续阶段）；兼容旧 state.memories 台账；
   * 会话历史来自本次会话的真实用户消息。
   */
  function candidates(input, st) {
    var out = [];
    var store = st || [];
    for (var k = 0; k < store.length; k++) {
      var r = store[k];
      out.push({
        id: r.id, text: storeText(r), type: r.type || 'event', tags: [],
        strength: (typeof r.strength === 'number') ? r.strength : (typeof r.importance === 'number' ? r.importance : SESSION_STRENGTH),
        lastAt: r.lastHitAt || r.createdAt, source: 'store',
        summary: r.summary || '', content: (r.userText || '') + (r.assistantText ? '\n' + r.assistantText : '')
      });
    }
    var ledger = input.memories || [];
    for (var i = 0; i < ledger.length; i++) {
      var m = ledger[i];
      if (!m || m.agentId !== input.agentId) continue;
      out.push({
        id: m.id, text: m.text || '', type: m.type || 'fact', tags: m.tags || [],
        strength: m.strength || 0, lastAt: m.lastHitAt || m.createdAt, source: 'ledger'
      });
    }
    var hist = input.history || [];
    for (var j = 0; j < hist.length; j++) {
      var h = hist[j];
      if (!h || h.role !== 'user' || !h.content) continue;
      out.push({
        id: h.id, text: h.content, type: 'event', tags: [],
        strength: SESSION_STRENGTH, lastAt: h.at, source: 'session'
      });
    }
    return out;
  }

  function search(input) {
    var q = input || {};
    var pr = paramsFor(q.agentId);
    var sh = matchStore(q.agentId, q.text);
    var pool = candidates(q, sh);
    var qset = {}, qlist = tokenize(q.text);
    for (var a = 0; a < qlist.length; a++) qset[qlist[a]] = 1;
    var qn = Object.keys(qset).length;

    var scored = [];
    for (var i = 0; i < pool.length; i++) {
      var c = pool[i];
      var tlist = tokenize(c.text), tset = {}, overlap = 0, tagHit = 0;
      for (var b = 0; b < tlist.length; b++) tset[tlist[b]] = 1;
      for (var g in qset) if (tset[g]) overlap++;
      for (var t = 0; t < c.tags.length; t++) if (qset[String(c.tags[t]).toLowerCase()] || String(q.text).indexOf(c.tags[t]) !== -1) tagHit++;
      var denom = Math.max(3, Math.min(qn, Object.keys(tset).length));
      var kw = overlap / denom;
      var tg = c.tags.length ? tagHit / c.tags.length : 0;
      var st = effStrength(c.strength, c.lastAt, pr.lambda);
      var fresh = 1 / (1 + daysSince(c.lastAt) * 0.5);
      var score = pr.w[0] * kw + pr.w[1] * tg + pr.w[2] * st + pr.w[3] * fresh;
      // 必须有词面重叠才算候选（Stage 1-2 的实测教训：否则"最近说过的一句"会冒充命中）
      var pinned = c.type === 'goal' && c.strength > PIN_STRENGTH;
      if (overlap > 0 || pinned) {
        scored.push({
          id: c.id, text: String(c.text).slice(0, 60), type: c.type, tags: c.tags,
          source: c.source, overlap: overlap, kw: Math.round(kw * 100) / 100,
          score: Math.round(score * 1000) / 1000, pinned: pinned,
          belowThreshold: !pinned && score < THRESHOLD,
          // 供 memory 块渲染的规范化字段（story 条目无 summary/content → 回退 text）
          summary: c.summary || String(c.text).slice(0, 120),
          content: c.content || String(c.text).slice(0, 240)
        });
      }
    }

    // 排序：先按分数，再按与意图的类型亲和做 tie-break（不参与打分，只影响并列顺序）
    var affinity = affinityFor(q.intent);
    scored.sort(function (x, y) {
      if (y.score !== x.score) return y.score - x.score;
      var ax = x.type === affinity ? 1 : 0, ay = y.type === affinity ? 1 : 0;
      if (ay !== ax) return ay - ax;
      return String(x.id) < String(y.id) ? -1 : 1;
    });

    var hits = scored.filter(function (s) { return !s.belowThreshold; }).slice(0, TOP_K);

    return {
      hits: hits,
      poolSize: pool.length,
      candidateCount: scored.length,
      threshold: THRESHOLD,
      topK: TOP_K,
      requireOverlap: true,
      matcher: 'frozen-score@v1',
      params: { w: pr.w, lambda: pr.lambda, quota: pr.quota },
      intentHint: q.intent ? { name: q.intent.name, used: 'ordering-only' } : null,
      sources: { ledger: q.memories ? q.memories.length : 0, session: (q.history || []).length, store: sh.length },
      note: '评分逐字采用 persona-spec §1.6.1 的冻结公式与参数；只检索真实数据，不编造记忆；store 为主源（Stage 4 Step 2）'
    };
  }

  /** 意图 → 类型亲和（只用于并列排序，不参与打分，因此不影响冻结公式） */
  function affinityFor(intent) {
    if (!intent) return null;
    if (intent.name === 'planner' || intent.name === 'decider') return 'goal';
    if (intent.name === 'knowledge' || intent.name === 'analyst') return 'fact';
    return null;
  }

  /* ── MemoryStore：本地持久化抽象（Stage 4 Step 1）──────────────────
     安全约束：业务代码一律经由本接口读写，禁止直接触碰 localStorage；
     环境不可用（隐私模式/非浏览器）时降级为本会话内存存储，接口语义不变；
     存储写入失败不静默降级——如实 reject（由 Turn 记入 trace:memory:write）。
     Stage 4 Step 2：search 以 store 为主源（与 find 共用 matchStore 同一套匹配语义）。 */
  var LS_KEY = 'tavern.memories.v1';
  var memFallback = null;      // localStorage 不可用时的内存降级（本会话有效）

  function load() {
    if (memFallback) return memFallback;
    try {
      var raw = global.localStorage.getItem(LS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return (memFallback = []); }
  }
  function persist(arr) {
    if (memFallback) { memFallback = arr; return; }   // 环境无 localStorage：内存降级是既定行为
    global.localStorage.setItem(LS_KEY, JSON.stringify(arr));   // 写入失败如实 reject（trace 记 error），不静默降级
  }

  function storeText(r) { return (r.summary || '') + ' ' + (r.userText || '') + ' ' + (r.assistantText || ''); }

  // 同步匹配核心：find()（Promise 封装）与 search()（同步接口不可改）共用，保证同一套匹配语义
  function matchStore(agentId, query) {
    var q = String(query || '').trim();
    if (!q) return [];
    var grams = tokenize(q), set = {};
    for (var i = 0; i < grams.length; i++) set[grams[i]] = 1;
    return load().filter(function (r) {
      if (!r || r.agentId !== agentId) return false;
      var hay = storeText(r);
      if (hay.indexOf(q) !== -1) return true;
      var tl = tokenize(hay);
      for (var j = 0; j < tl.length; j++) if (set[tl[j]]) return true;
      return false;
    });
  }

  /* ── 记忆整理（Stage 4 Step 3/5）：近重复合并 + 冻结 quota 淘汰 ──────
     合并：保留既有记录（id 稳定）；createdAt 取最新；importance/强化字段取较高；两侧文本保留。
     上限：按 Agent 的冻结 quota（personas.js memory.quota，取自配置、不硬编码）；达到上限时
     先淘汰候选（§1.6.4：有效强度<0.15 且 hits==0；heuristic 优先、有效强度升序、只删必要数量），
     腾位则正常写入；无候选则拒绝写入。淘汰纯静默（结果经既有 memory:write 事件体现）。 */
  var DUP_SIM = 0.8, EVICT_ES = 0.15;

  function simMem(a, b) {
    var ua = String(a.userText || ''), ub = String(b.userText || '');
    if (ua && ua === ub) return 1;
    var A = {}, B = {}, ta = tokenize(a.summary || ''), tb = tokenize(b.summary || ''), i;
    for (i = 0; i < ta.length; i++) A[ta[i]] = 1;
    for (i = 0; i < tb.length; i++) B[tb[i]] = 1;
    var ka = Object.keys(A), kb = Object.keys(B), inter = 0;
    if (!ka.length || !kb.length) return 0;
    for (i = 0; i < ka.length; i++) if (B[ka[i]]) inter++;
    return inter / (ka.length + kb.length - inter);
  }
  /* Stage 9（§1.6.4 冲突合并）：二元组 Jaccard（与 simMem 同源；供否定剥离比较与本地摘要去重复用） */
  function jac(sa, sb) {
    var A = {}, B = {}, ta = tokenize(sa), tb = tokenize(sb), i;
    for (i = 0; i < ta.length; i++) A[ta[i]] = 1;
    for (i = 0; i < tb.length; i++) B[tb[i]] = 1;
    var ka = Object.keys(A), kb = Object.keys(B), inter = 0;
    if (!ka.length || !kb.length) return 0;
    for (i = 0; i < ka.length; i++) if (B[ka[i]]) inter++;
    return inter / (ka.length + kb.length - inter);
  }
  var NEG_RE = /不|没有|没|有/g;
  /** 冲突判定（§1.6.4，Stage 9）：同 type + 第一人称否定差异——恰一方含否定词，且剥离否定词后仍等价 */
  function negFlip(a, b) {
    var ta = String(a.summary || ''), tb = String(b.summary || '');
    var na = /[不没]/.test(ta), nb = /[不没]/.test(tb);
    if (na === nb) return false;
    var sa = ta.replace(NEG_RE, ''), sb = tb.replace(NEG_RE, '');
    if (!sa || !sb) return false;
    return jac(sa, sb) >= DUP_SIM;
  }
  function joinKeep(a, b) { return [a, b].filter(Boolean).join(' ｜ '); }
  function strengthOf(r) { return (typeof r.strength === 'number') ? r.strength : ((typeof r.importance === 'number') ? r.importance : 0); }
  function mergeInto(old, rec) {
    old.createdAt = Math.max(old.createdAt || 0, rec.createdAt || 0);
    old.importance = Math.max(old.importance || 0, rec.importance || 0);
    // Stage 4 Step 4：强化字段合并一律取 max（批准规则，避免重复合并虚增强度/命中数）
    old.hits = Math.max(old.hits || 0, rec.hits || 0);
    old.lastHitAt = Math.max(old.lastHitAt || 0, rec.lastHitAt || 0);
    old.strength = Math.max(strengthOf(old), strengthOf(rec));
    old.summary = clip(joinKeep(old.summary, rec.summary), LIMITS.summary);
    old.userText = clip(joinKeep(old.userText, rec.userText), LIMITS.user);
    old.assistantText = clip(joinKeep(old.assistantText, rec.assistantText), LIMITS.assistant);
    return old;
  }

  /* 淘汰候选（Stage 4 Step 5，§1.6.4 冻结）：同 Agent 内「有效强度<0.15 且 hits==0」，
     heuristic 来源优先，其后按有效强度升序（复用 effStrength 冻结公式，零新增权重）；
     返回被移除的记录或 null——调用方在全部计算完成后单次写盘，保证不半删除。 */
  function evictOne(arr, agentId) {
    var lam = paramsFor(agentId).lambda, cand = [];
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!r || r.agentId !== agentId || (r.hits || 0) > 0) continue;
      var es = effStrength(strengthOf(r), r.lastHitAt || r.createdAt, lam);
      if (es < EVICT_ES) cand.push({ i: i, h: r.source === 'heuristic' ? 0 : 1, es: es });
    }
    if (!cand.length) return null;
    cand.sort(function (a, b) { return (a.h - b.h) || (a.es - b.es); });
    return arr.splice(cand[0].i, 1)[0];
  }

  /* Quick 启发式候选（§1.6.3 冻结，Stage 5-A 落地）：五触发词 → preference|goal|fact，
     去掉首个"我"、去尾部语气词、截断 40 字、importance 0.35（strength 上限）、
     source:'heuristic'；本地零调用；无触发 → 不产出（只追加候选，不改既有人工写入）。 */
  var HEUR = [['我喜欢', 'preference'], ['我不想', 'preference'], ['我打算', 'goal'], ['我在学', 'goal'], ['我是', 'fact']];
  function writeHeuristic(input) {
    var agentId = String((input && input.agentId) || '');
    if (!agentId) return Promise.reject(new Error('invalid_input: agentId 缺失'));
    var text = String(input.userText || '');
    var hit = HEUR.filter(function (h) { return text.indexOf(h[0]) !== -1; })[0];
    if (!hit) return Promise.resolve(null);
    var seg = text.split(/[！？。；!?;\n]/).filter(function (s) { return s.indexOf(hit[0]) !== -1; })[0]
      .replace(/^我|[吧呢啊哦嘛呀]+$/g, '').trim();
    var t = clip(redact(escapeMem(seg)), 40);
    if (!t) return Promise.resolve(null);
    return MemoryStore.save({
      id: newMemId(), agentId: agentId, createdAt: Date.now(), type: hit[1], importance: 0.35,
      summary: t, userText: t, assistantText: '', source: 'heuristic'
    });
  }

  /* 本地摘要（§3.5 summarize 的纯本地规则抽取；Stage 9：§1.6.4 长会话压缩复用）。
     按句切分 → 二元组去重 → 取前 maxPoints 个要点；返回 {points, dropped}。零调用、确定性。 */
  function summarize(text, maxPoints) {
    var segs = String(text || '').split(/[。！？；!?;\n]/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 2; });
    var cap = Math.max(1, Math.min(10, maxPoints || 6)), out = [], dropped = 0;
    for (var i = 0; i < segs.length; i++) {
      var dup = false;
      for (var j = 0; j < out.length; j++) if (jac(out[j], segs[i]) >= DUP_SIM) { dup = true; break; }
      if (dup) continue;
      if (out.length >= cap) { dropped++; continue; }
      out.push(segs[i]);
    }
    return { points: out, dropped: dropped };
  }

  var MemoryStore = {
    LABEL: '记忆存储',
    KEY: LS_KEY,
    save: function (rec) {
      return Promise.resolve().then(function () {
        if (!rec || !rec.id || !rec.agentId) throw new Error('invalid_record');
        var arr = load(), merged = null;
        function pushQuota() {
          var cnt = 0;
          for (var j = 0; j < arr.length; j++) if (arr[j] && arr[j].agentId === rec.agentId) cnt++;
          var quota = paramsFor(rec.agentId).quota;
          if (cnt >= quota && !evictOne(arr, rec.agentId)) {
            throw new Error('capacity_exceeded: ' + rec.agentId + ' 已达上限 ' + quota + ' 条（无满足淘汰条件的候选：有效强度<0.15 且 hits=0）');
          }
          arr.push(rec);
        }
        /* 冲突合并（§1.6.4，Stage 9）：同 type + 否定差异 → 新陈述胜出、旧记录 strength×0.5 原地保留
           （两条并存：用户偏好会变，但"曾经是"也是信息）。必须先行于近重复合并——
           否定翻转的 Jaccard≈0.857 ≥ 0.8，否则会被并成一条。 */
        for (var c = 0; c < arr.length; c++) {
          if (arr[c] && arr[c].agentId === rec.agentId && arr[c].id !== rec.id && arr[c].type === rec.type && negFlip(arr[c], rec)) {
            arr[c].strength = Math.round(strengthOf(arr[c]) * 0.5 * 100) / 100;
            pushQuota();
            persist(arr);
            return rec;
          }
        }
        for (var i = 0; i < arr.length; i++) {          // 近重复 → 合并进既有记录（不新增、语义保留）
          var r = arr[i];
          if (r && r.agentId === rec.agentId && r.id !== rec.id && simMem(r, rec) >= DUP_SIM) { merged = mergeInto(r, rec); break; }
        }
        if (!merged) pushQuota();
        persist(arr);
        return merged || rec;
      });
    },
    /* 命中巩固（§1.6.2 冻结规则）：命中即写回 —— hits+1 / lastHitAt=now / strength=min(1, s+0.03)。
       只原地更新这三个字段：不改文本、不新增记录、不触发容量门禁、不参与合并。 */
    reinforce: function (agentId, ids) {
      return Promise.resolve().then(function () {
        var want = ids || [];
        if (!want.length) return 0;
        var arr = load(), n = 0, now = Date.now();
        for (var i = 0; i < arr.length; i++) {
          var r = arr[i];
          if (!r || r.agentId !== agentId || want.indexOf(r.id) === -1) continue;
          r.hits = (r.hits || 0) + 1;
          r.lastHitAt = now;
          r.strength = Math.min(1, Math.round((strengthOf(r) + 0.03) * 100) / 100);
          n++;
        }
        if (n) persist(arr);
        return n;
      });
    },
    list: function (agentId) {
      return Promise.resolve().then(function () {
        return load().filter(function (r) { return r && r.agentId === agentId; });
      });
    },
    find: function (agentId, query) {
      return Promise.resolve().then(function () { return matchStore(agentId, query); });
    },
    /** 有效强度（Stage 7 记忆台/档案展示用）：与检索同源的冻结公式（λ 按 Agent 配置） */
    eff: function (rec, agentId) {
      var lam = paramsFor(agentId).lambda;
      return effStrength(strengthOf(rec), (rec && (rec.lastHitAt || rec.createdAt)) || 0, lam);
    }
  };

  /* ── MemoryService.write：接收 → 规范化 → 存储（Stage 4 Step 1）─────
     安全约束：入库前 HTML 转义、按上限截断（summary≤500 / user≤1000 / assistant≤2000）、
     过滤密钥类敏感串（sk-… / Bearer … / keyword:value）。不生成 prompt、不碰 Store/UI、
     不做重要性算法（importance 取 metadata 或占位默认 0.5，算法属后续阶段）。 */
  var LIMITS = { summary: 500, user: 1000, assistant: 2000 };
  var IMPORTANCE_DEFAULT = 0.5;
  function newMemId() { return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

  function escapeMem(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function clip(s, n) {
    var t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  // 敏感串过滤（关键词级，防误存）：密钥形状 + keyword:value 两类
  function redact(s) {
    return String(s)
      .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[已过滤]')
      .replace(/bearer\s+[A-Za-z0-9._-]{8,}/gi, '[已过滤]')
      .replace(/((?:api[_-]?key|apikey|token|password|passwd|secret|密钥|密码)\s*[:=：]\s*)[^\s，。；,;]{3,}/gi, '$1[已过滤]');
  }
  function clean(s, n) { return clip(redact(escapeMem(s)), n); }

  function write(input) {
    var q = input || {};
    var agentId = String(q.agentId || '');
    if (!agentId) return Promise.reject(new Error('invalid_input: agentId 缺失'));
    var u = clean(String(q.userText || '').trim(), LIMITS.user);
    var a = clean(String(q.assistantText || '').trim(), LIMITS.assistant);
    if (!u && !a) return Promise.resolve(null);            // 空输入：不写，也不算错误
    var md = q.metadata || {};
    var imp = (typeof md.importance === 'number' && md.importance >= 0 && md.importance <= 1) ? md.importance : IMPORTANCE_DEFAULT;
    var rec = {
      id: newMemId(),
      agentId: agentId,
      createdAt: Date.now(),
      type: (typeof md.type === 'string' && md.type) ? md.type : 'event',
      importance: imp,
      summary: clip([u, a].filter(Boolean).join(' ｜ '), LIMITS.summary),
      userText: u,
      assistantText: a,
      source: (typeof md.source === 'string' && md.source) ? md.source : 'manual'   // Stage 8：manual / eval:<turnId> / heuristic 三路
    };
    // 返回 save 的结果：合并发生时返回既有记录（id 与存储一致），不返回未入库的入参 id
    return MemoryStore.save(rec);
  }

  global.Tavern = global.Tavern || {};
  global.Tavern.MemoryStore = Object.freeze(MemoryStore);
  global.Tavern.MemoryService = Object.freeze({
    LABEL: LABEL,
    THRESHOLD: THRESHOLD,
    TOP_K: TOP_K,
    LIMITS: Object.freeze(LIMITS),
    search: search,
    write: write,
    writeHeuristic: writeHeuristic,
    summarize: summarize,
    paramsFor: paramsFor,
    tokenize: tokenize          // 供自检与确定性测试
  });
})(window);
