/* ══════════════════════════════════════════════════════════════════════════
   trace-live.js — 实时 Trace 面板（取代 Stage 1-1 的静态骨架）
   ──────────────────────────────────────────────────────────────────────────
   数据来源：**只有真实事件**。面板不订阅 EventBus，而是渲染 Store 中的
   trace 状态（由 core/turn.js 依据 Provider 上报写入），保持"UI 是状态的投影"。

   面板上每一处数字都能溯源：
     · 阶段耗时 = 该阶段从开始到 done 的真实墙钟（computeMs 实测 + simMs 已声明）
     · computeMs / simMs 分开显示 —— 模拟延迟不混入真实耗时
     · 记忆检索显示候选数与 matcher id；未命中就是未命中
     · 没有"自我评估"节点：MockProvider 不做评估，就不画这个节点（禁止假步骤）
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var GLYPH = { pending: '○', active: '●', done: '✓', skipped: '/', error: '!' };

  var LEGEND = [
    { state: 'pending', glyph: '○', text: '未开始' },
    { state: 'active', glyph: '●', text: '进行中' },
    { state: 'done', glyph: '✓', text: '已完成（附真实耗时）' },
    { state: 'skipped', glyph: '/', text: '未执行（必须写原因）' },
    { state: 'error', glyph: '!', text: '失败（附原因）' }
  ];

  var TraceLive = {
    name: 'TraceLive',

    data: function () {
      return { legend: LEGEND, glyph: GLYPH, open: {} };
    },

    computed: {
      store: function () { return global.Tavern.Store; },
      trace: function () { return this.store.state.trace; },
      steps: function () { return this.trace.steps; },
      busy: function () { return global.Tavern.Turn.isBusy(); },
      provider: function () { return global.Tavern.Provider.current(); },
      metum: function () { return this.trace.meta || {}; },
      cognition: function () { return this.metum.cognition || null; },
      memoryCheck: function () { return this.metum.memoryCheck || null; },
      latency: function () { return this.metum.latency || null; },
      hasTurn: function () { return !!this.trace.activeTurnId; },
      turnLabel: function () {
        return this.hasTurn ? this.trace.activeTurnId : '（还没有轮次）';
      },
      charCount: function () { return this.trace.tokens; }
    },

    methods: {
      pretty: function (v) {
        try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
      },
      toggle: function (id) { this.open[id] = !this.open[id]; },
      isOpen: function (id) { return !!this.open[id]; },
      ms: function (v) { return (v == null) ? '—' : (v + 'ms'); }
    },

    template: [
      '<section class="panel" aria-label="Agent 运行轨迹（真实事件驱动）">',
      '  <div class="panel__head">',
      '    <h3 class="panel__title">Agent Trace</h3>',
      '    <span class="chip" :class="busy ? \'chip--accent\' : \'\'">{{ busy ? \'运行中\' : (hasTurn ? \'已完成\' : \'待命\') }}</span>',
      '  </div>',
      '',
      '  <div class="trace-meta">',
      '    <div class="row"><span class="label">Provider</span><span class="spacer"></span>',
      '      <span class="t-mono" :class="provider.meta.isMock ? \'accented\' : \'\'">{{ provider.id }}</span></div>',
      '    <div class="row"><span class="label">轮次</span><span class="spacer"></span><span class="t-mono">{{ turnLabel }}</span></div>',
      '    <div class="row"><span class="label">输出字符</span><span class="spacer"></span><span class="t-mono">{{ charCount }}</span></div>',
      '    <div v-if="latency" class="row"><span class="label">正文首字</span><span class="spacer"></span><span class="t-mono">{{ ms(latency.contentTtft || latency.ttft) }}</span></div>',
      '    <div v-if="latency && latency.reasoningFrames" class="row"><span class="label">推理首帧</span><span class="spacer"></span><span class="t-mono">{{ ms(latency.reasoningTtft) }}</span></div>',
      '    <div v-if="latency" class="row"><span class="label">整轮耗时</span><span class="spacer"></span><span class="t-mono">{{ ms(latency.total) }}</span></div>',
      '  </div>',
      '',
      '  <div v-if="!steps.length" class="empty">',
      '    <span>还没有轮次。</span>',
      '    <span class="t-meta">发送一句话，这里会逐条亮起真实的执行步骤。</span>',
      '  </div>',
      '',
      '  <ol v-else class="trace">',
      '    <li v-for="s in steps" :key="s.stepId" class="trace-node" :data-state="s.status">',
      '      <span class="trace-node__glyph" aria-hidden="true">{{ glyph[s.status] }}</span>',
      '      <span class="trace-node__label">',
      '        {{ s.label }}',
      '        <span v-if="s.reason" class="trace-node__why">· {{ s.reason }}</span>',
      '        <button class="trace-node__more" @click="toggle(s.stepId)"',
      '          :aria-expanded="isOpen(s.stepId)">{{ isOpen(s.stepId) ? \'收起\' : \'原始数据\' }}</button>',
      '      </span>',
      '      <span class="trace-node__ms">{{ s.ms == null ? (s.status === \'active\' ? \'…\' : \'\') : s.ms + \'ms\' }}</span>',
      '',
      '      <div v-if="isOpen(s.stepId)" class="trace-detail">',
      '        <pre class="json">{{ pretty(s.detail) }}</pre>',
      '      </div>',
      '    </li>',
      '  </ol>',
      '',
      '  <div v-if="cognition" class="trace-memory">',
      '    <span class="label">认知（本地纯计算 · {{ cognition.intent.method }}）</span>',
      '    <div class="room__counts">',
      '      <span class="chip chip--accent">意图 {{ cognition.intent.name }} · {{ cognition.intent.confidence }}</span>',
      '      <span class="chip">建议 {{ cognition.suggestedMode === "deep" ? "深潜" : "快速" }}</span>',
      '    </div>',
      '    <span class="label">建议理由</span>',
      '    <ul class="trace-memory__list">',
      '      <li v-for="r in cognition.reasons" :key="r" class="t-mono">{{ r }}</li>',
      '    </ul>',
      '    <span class="label">回答策略（Agent 怎么答你）</span>',
      '    <ul class="trace-memory__list">',
      '      <li v-for="p in cognition.plan.steps" :key="p.id" class="t-mono">{{ p.text }} — {{ p.why }}</li>',
      '    </ul>',
      '    <p class="t-meta">确定性计算：同一输入必得同一结论。认知只给建议，最终模式以用户选择优先。</p>',
      '  </div>',
      '',
      '  <div v-if="latency && latency.reasoningFrames" class="trace-memory">',
      '    <span class="label">推理度量</span>',
      '    <span class="chip">{{ latency.reasoningFrames }} 帧</span>',
      '    <span class="chip">{{ latency.reasoningBytes }} 字符</span>',
      '    <span class="chip">首帧 {{ ms(latency.reasoningTtft) }}</span>',
      '    <span class="chip chip--info" title="DR-009：原始思维链不展示、不持久化、不进日志">原文已丢弃</span>',
      '    <p class="t-meta">以上是"模型确实在推理"的度量。推理原文不展示也不保存 —— 它是模型的草稿纸，不是给你的解释。</p>',
      '  </div>',
      '',
      '  <div v-if="memoryCheck" class="trace-memory">',
      '    <span class="label">记忆检索</span>',
      '    <span class="chip" :class="memoryCheck.count ? \'chip--success\' : \'\'">',
      '      命中 {{ memoryCheck.count }} / 候选 {{ memoryCheck.poolSize }}',
      '    </span>',
      '    <span class="chip">{{ memoryCheck.matcher }}</span>',
      '    <ul v-if="memoryCheck.hits.length" class="trace-memory__list">',
      '      <li v-for="h in memoryCheck.hits" :key="h.id" class="t-mono">',
      '        {{ h.score }} · {{ h.text }}',
      '      </li>',
      '    </ul>',
      '    <p v-else class="t-meta">未命中：本会话里还没有和这次相关的历史（只检索真实会话，不编造记忆）。</p>',
      '  </div>',
      '',
      '  <div class="panel__head" style="margin-top:var(--sp-4)">',
      '    <h4 class="t-meta">状态图例</h4>',
      '    <span class="chip">design-token §1.6</span>',
      '  </div>',
      '  <ul class="trace trace--legend">',
      '    <li v-for="l in legend" :key="l.state" class="trace-node" :data-state="l.state">',
      '      <span class="trace-node__glyph" aria-hidden="true">{{ l.glyph }}</span>',
      '      <span class="trace-node__label">{{ l.text }}</span>',
      '      <span class="trace-node__ms">{{ l.state }}</span>',
      '    </li>',
      '  </ul>',
      '',
      '  <p class="t-meta" style="margin-top:var(--sp-4)">',
      '    面板不订阅事件总线，渲染的是 Store 里的 trace 状态（由桥接层依据 Provider 上报写入）。',
      '    computeMs 为实测计算耗时，simMs 为已声明的模拟延迟 —— 两者在「原始数据」里分开显示。',
      '  </p>',
      '</section>'
    ].join('\n')
  };

  global.Tavern.UI = global.Tavern.UI || {};
  global.Tavern.UI.TraceLive = TraceLive;
})(window);
