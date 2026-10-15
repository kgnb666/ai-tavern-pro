/* ══════════════════════════════════════════════════════════════════════════
   store.js — 应用状态与动作
   ──────────────────────────────────────────────────────────────────────────
   状态切片逐字对应 stage-0-architecture.md §2.3。
   本阶段（Stage 1）明确不做的事：
     · 不写 LocalStorage（持久化与降级属 Stage 4，见 stage-1-plan §0.3）
     · 不发任何 Trace 事件（无引擎）
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  if (typeof global.Vue === 'undefined' || !global.Vue.reactive) {
    // vendor 未加载时给出可执行提示，而不是静默崩溃
    console.error('[Store] 未找到 Vue（vendor 未内联或未加载）。请运行 node build.js --release');
    return;
  }

  var Vue = global.Vue;
  var P = global.Tavern.Personas;

  var ROUTES = ['entry', 'world', 'room', 'memory', 'growth'];

  /* ── 初始状态 ─────────────────────────────────────────────────────── */

  function emptyAgents() {
    var out = {};
    for (var i = 0; i < P.AGENTS.length; i++) {
      var id = P.AGENTS[i].id;
      var init = P.INITIAL_RUNTIME[id];
      out[id] = {
        level: init.level,
        xp: init.xp,
        mood: init.mood,
        affinity: init.affinity,
        energy: init.energy,
        energyAt: Date.now(),          // Stage 7：能量懒结算的时间锚（会话级，不持久化）
        talks: init.talks,
        unlocked: init.unlocked.slice()
      };
    }
    return out;
  }

  /* Stage 6-1：信任维度初始状态（按 agent 键控；agentId 即键） */
  function emptyRelationship() {
    var out = {};
    for (var i = 0; i < P.AGENTS.length; i++) out[P.AGENTS[i].id] = { trust: 0, updatedAt: 0 };
    return out;
  }

  /* Stage 6-2：待决事件（会话级，按 agent 键控；同 agent 最多一条）
     Stage 6-3：notice 为成长提示（仅用户可见的一句话，自动消失）
     Stage 6-4：lastTriggeredEvents 为事件级冷却表（eventId → 触发时的 talks） */
  function emptyEvents() {
    var out = {};
    for (var i = 0; i < P.AGENTS.length; i++) out[P.AGENTS[i].id] = { pending: null, lastTriggeredEvents: {}, notice: null };
    return out;
  }

  var state = Vue.reactive({
    session: {
      route: 'entry',
      entered: false,
      online: false,      // Stage 1 不探活；Stage 2 由 /v1/health 决定
      mode: 'deep',          // 默认深潜（与 Stage 1-2 的可观察行为一致）；UI 可选 快速/自动/深潜
    },
    agents: emptyAgents(),
    relationship: emptyRelationship(),
    events: emptyEvents(),
    conversations: { bartender: [], oracle: [], muse: [] },
    summaries: {
      bartender: { text: '', coversUpTo: 0 },
      oracle: { text: '', coversUpTo: 0 },
      muse: { text: '', coversUpTo: 0 }
    },
    memories: [],                       // Stage 4 接入
    trace: { activeTurnId: null, agentId: null, steps: [], tokens: 0, meta: {}, running: false },
    ui: { panel: 'trace', activeAgentId: null, mobileTab: 'conv' },

  });

  /* ── 读取辅助 ─────────────────────────────────────────────────────── */

  function agentById(id) {
    for (var i = 0; i < P.AGENTS.length; i++) if (P.AGENTS[i].id === id) return P.AGENTS[i];
    return null;
  }

  function affinityStage(affinity) {
    var stages = P.FROZEN.AFFINITY_STAGES;
    for (var i = 0; i < stages.length; i++) {
      if (affinity >= stages[i].min && affinity <= stages[i].max) return stages[i];
    }
    return stages[0];
  }

  /** XP 门槛表（persona-spec §2.8：Lv1 0 / Lv2 30 / Lv3 80 / Lv4 160 / Lv5 280） */
  var XP_STEPS = [0, 30, 80, 160, 280];

  function levelProgress(id) {
    var a = state.agents[id];
    var lv = a.level;
    var lo = XP_STEPS[lv - 1] || 0;
    var hi = XP_STEPS[lv] != null ? XP_STEPS[lv] : lo + 100;
    var pct = hi > lo ? Math.max(0, Math.min(100, ((a.xp - lo) / (hi - lo)) * 100)) : 100;
    return { lo: lo, hi: hi, pct: pct, next: hi };
  }

  var MOOD_LABEL = {
    neutral: '平静', warm: '温和', amused: '有点想笑', thoughtful: '沉思',
    concerned: '关切', tired: '有点累', energized: '来了兴致'
  };

  /* ── 动作（组件只调用动作，不直接改状态） ─────────────────────────── */

  function routeTo(route) {
    if (ROUTES.indexOf(route) === -1) {
      throw new Error('[Store] 未知路由 "' + route + '"，允许：' + ROUTES.join(' / '));
    }
    state.session.route = route;
    global.Tavern.EventBus.emit('ui:route', { route: route });
  }

  function enterTavern() {
    state.session.entered = true;
    routeTo('world');
  }

  function openAgent(id) {
    if (!agentById(id)) throw new Error('[Store] 未知 Agent "' + id + '"');
    state.ui.activeAgentId = id;
    routeTo('room');
  }

  function setMode(mode) {
    if (mode !== 'quick' && mode !== 'deep' && mode !== 'auto') throw new Error('[Store] mode 只能是 quick|deep|auto');
    state.session.mode = mode;
    return mode;
  }

  function openPanel(panel) {
    state.ui.panel = panel;
    state.ui.mobileTab = panel;
    global.Tavern.EventBus.emit('ui:panel', { panel: panel });
  }

  /* ── 对话与轮次（Stage 1-2） ──────────────────────────────────────── */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function findMessage(agentId, id) {
    var list = state.conversations[agentId];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function appendMessage(agentId, msg) {
    if (!state.conversations[agentId]) throw new Error('[Store] 未知 Agent：' + agentId);
    state.conversations[agentId].push(msg);
    return msg;
  }

  function patchMessage(agentId, id, patch) {
    var m = findMessage(agentId, id);
    if (!m) return null;
    for (var k in patch) m[k] = patch[k];
    return m;
  }

  function appendChunk(agentId, id, delta) {
    var m = findMessage(agentId, id);
    if (!m) return null;
    m.content += delta;
    return m;
  }

  function startTurn(turnId, agentId) {
    state.trace.running = true;          // 整轮生命周期（含"已发出、上游尚未返回"的窗口）
    state.trace.activeTurnId = turnId;
    state.trace.steps = [];
    state.trace.tokens = 0;
    state.trace.agentId = agentId;
    state.trace.meta = {};
  }

  /** 一轮结束时清除 running；必须与 startTurn 成对，否则 UI 会永远卡在"进行中" */
  function endTurn() { state.trace.running = false; }

  function findStep(stepId) {
    var steps = state.trace.steps;
    for (var i = 0; i < steps.length; i++) if (steps[i].stepId === stepId) return steps[i];
    return null;
  }

  /** 新增或更新一个步骤；beforeStepId 用于把真实后发生的步骤插到指定步骤之前 */
  function upsertStep(step, beforeStepId) {
    var existing = findStep(step.stepId);
    if (existing) {
      for (var k in step) existing[k] = step[k];
      return existing;
    }
    if (beforeStepId) {
      var steps = state.trace.steps;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].stepId === beforeStepId) { steps.splice(i, 0, step); return step; }
      }
    }
    state.trace.steps.push(step);
    return step;
  }

  function markActiveStepsSkipped(reason) {
    var steps = state.trace.steps;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].status === 'active') {
        steps[i].status = 'skipped';
        steps[i].reason = reason;
        steps[i].detail = Object.assign({}, steps[i].detail || {}, { skippedReason: reason });
      }
    }
  }

  function addChars(n) { state.trace.tokens += n; }

  /* Stage 7：能量懒结算——按真实流逝时间补点（ENERGY_RULES.regenPerMinutes / cap）。
     纯本地真实时间、不引入定时器；结算点 = turn.end（先补后扣）与成长档案读取时。 */
  function tickEnergy(agentId) {
    var a = state.agents[agentId];
    if (!a) return 0;
    var cfg = P.FROZEN.ENERGY_RULES;
    var step = cfg.regenPerMinutes * 60000;
    var n = Math.floor((Date.now() - (a.energyAt || Date.now())) / step);
    if (n > 0) {
      a.energyAt += n * step;
      a.energy = Math.min(cfg.cap, a.energy + n);
    }
    return a.energy;
  }

  function tickAllEnergy() {
    for (var i = 0; i < P.AGENTS.length; i++) tickEnergy(P.AGENTS[i].id);
  }

  /** 长会话压缩落点（Stage 9，§1.6.4）：只由 turn.js 调用；text 累积、上限 800 字（超限弃旧留新） */
  function setSummary(agentId, text, coversUpTo) {
    var s = state.summaries[agentId];
    if (!s) return null;
    var t = String(text || '');
    var kept = s.text ? (s.text + '\n' + t) : t;
    if (kept.length > 800) {
      kept = kept.slice(kept.length - 800);
      var nl = kept.indexOf('\n');
      if (nl >= 0) kept = kept.slice(nl + 1);   // 截掉可能的半行（仅当存在换行）
    }
    s.text = kept;
    s.coversUpTo = coversUpTo;
    return s;
  }

  /** 轮次级元信息（记忆检索结果、耗时分解等），只在 UI 展示，不持久化 */
  function setTurnMeta(patch) {
    for (var k in patch) state.trace.meta[k] = patch[k];
    return state.trace.meta;
  }

  /** 信任增量（Stage 6-1）：clamp 0–100、变更时更新 updatedAt，返回实际生效值（静默，不发事件） */
  function applyTrust(agentId, delta) {
    var r = state.relationship[agentId];
    if (!r) return 0;
    var t0 = r.trust;
    r.trust = clamp(t0 + delta, 0, 100);
    var applied = r.trust - t0;
    if (applied !== 0) r.updatedAt = Date.now();
    return applied;
  }

  /** 剧情关系阶段（Stage 6-1 薄封装：读 affinity 单一真源 → 五级词表） */
  function relationshipStage(agentId) {
    var a = state.agents[agentId];
    return P.relationshipStage(a ? a.affinity : 0);
  }

  /** 信任档薄封装（低/普通/较高；阈值定义在 personas.trustLabel，单一真源） */
  function trustLabel(agentId) {
    var r = state.relationship[agentId];
    return P.trustLabel(r ? r.trust : 0);
  }

  /** 置入待决事件（Stage 6-2；同 agent 覆盖式唯一待决） */
  function setPendingEvent(agentId, eventId) {
    var e = state.events[agentId];
    if (!e) return null;
    e.pending = eventId;
    return eventId;
  }

  /** 记录事件触发轮次（Stage 6-4 冷却：事件级、talks 计量；无记录=首次直接放行） */
  function markEventTriggered(agentId, eventId, talks) {
    var e = state.events[agentId];
    if (e) e.lastTriggeredEvents[eventId] = talks;
  }

  /** 成长提示（Stage 6-3）：仅承载一句用户可见的话，5 秒后自动消失（不改任何数值规则） */
  function setNotice(agentId, text) {
    var e = state.events[agentId];
    if (!e) return;
    e.notice = text;
    setTimeout(function () {
      if (state.events[agentId].notice === text) state.events[agentId].notice = null;
    }, 5000);
  }

  /** 选择事件选项（Stage 6-2 唯一入口）：effects 只经既有 applyTrust / applyStatusPatch 落地，静默。
      冷却于触发时记账（Stage 6-4），解析不清除。 */
  function resolveEvent(agentId, choiceIndex) {
    var e = state.events[agentId];
    if (!e || !e.pending) return null;
    var def = global.Tavern.Events.byId(e.pending);
    e.pending = null;
    if (!def) return null;
    var ch = def.choices[choiceIndex];
    if (!ch) return null;
    var fx = ch.effects || {}, patch = {};
    if (fx.trust) applyTrust(agentId, fx.trust);
    if (fx.affinity != null) patch.affinity = fx.affinity;
    if (fx.mood) patch.mood = fx.mood;
    var applied = (patch.affinity != null || patch.mood) ? applyStatusPatch(agentId, patch) : null;
    return { choice: ch.text, applied: applied };
  }

  /** 把 Provider 上报的状态增量落到 Agent 运行时；返回实际生效的增量（供 UI 显示） */
  function applyStatusPatch(agentId, patch) {
    var a = state.agents[agentId];
    if (!a) return null;
    var applied = {};
    if (patch.energy != null) {
      var e0 = a.energy;
      a.energy = clamp(a.energy + patch.energy, 0, P.FROZEN.ENERGY_RULES.cap);
      applied.energy = a.energy - e0;
      applied.energyFrom = e0;
      applied.energyTo = a.energy;
    }
    if (patch.xp != null) {
      a.xp = Math.max(0, a.xp + patch.xp);
      applied.xp = patch.xp;
      var lv = levelForXp(a.xp);
      if (lv > a.level) {
        applied.levelFrom = a.level;
        applied.levelTo = lv;
        a.level = lv;
      }
    }
    if (patch.affinity != null) {
      a.affinity = clamp(a.affinity + patch.affinity, 0, 100);
      applied.affinity = patch.affinity;
    }
    if (patch.talks != null) a.talks += patch.talks;
    if (patch.mood && P.FROZEN.MOODS.indexOf(patch.mood) !== -1) {
      applied.moodFrom = a.mood;
      applied.moodTo = patch.mood;
      a.mood = patch.mood;
    }
    return applied;
  }

  /** XP → 等级：门槛来自 persona-spec §2.8（0 / 30 / 80 / 160 / 280） */
  function levelForXp(xp) {
    var lv = 1;
    for (var i = 0; i < XP_STEPS.length; i++) if (xp >= XP_STEPS[i]) lv = i + 1;
    return lv;
  }

  var api = Object.freeze({
    ROUTES: Object.freeze(ROUTES),
    XP_STEPS: Object.freeze(XP_STEPS.slice()),
    MOOD_LABEL: Object.freeze(MOOD_LABEL),
    state: state,
    agentById: agentById,
    affinityStage: affinityStage,
    levelProgress: levelProgress,
    routeTo: routeTo,
    enterTavern: enterTavern,
    openAgent: openAgent,
    openPanel: openPanel,
    setMode: setMode,
    appendMessage: appendMessage,
    patchMessage: patchMessage,
    appendChunk: appendChunk,
    startTurn: startTurn,
    endTurn: endTurn,
    upsertStep: upsertStep,
    findStep: findStep,
    markActiveStepsSkipped: markActiveStepsSkipped,
    addChars: addChars,
    tickEnergy: tickEnergy,
    tickAllEnergy: tickAllEnergy,
    setSummary: setSummary,
    setTurnMeta: setTurnMeta,
    applyStatusPatch: applyStatusPatch,
    applyTrust: applyTrust,
    relationshipStage: relationshipStage,
    trustLabel: trustLabel,
    setPendingEvent: setPendingEvent,
    markEventTriggered: markEventTriggered,
    setNotice: setNotice,
    resolveEvent: resolveEvent,
    levelForXp: levelForXp
  });

  global.Tavern.Store = api;
})(window);
