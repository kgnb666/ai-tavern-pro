/* ══════════════════════════════════════════════════════════════════════════
   memory-board.js — 记忆台（Stage 7）：Agent 真实记住的东西。
   数据主源 = MemoryStore.list（localStorage 台账）；不渲染示例数据——空态就应该是空的。
   有效强度与检索同源（MemoryStore.eff → frozen-score@v1 的衰减公式，λ 按 Agent 配置）。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var TYPE_LABEL = { preference: '偏好', goal: '目标', fact: '事实', event: '事件' };
  var SOURCE_LABEL = { manual: '对话写入', heuristic: '弱记忆 · 启发式' };

  var ScreenMemoryBoard = {
    name: 'ScreenMemoryBoard',
    data: function () {
      return {
        agentId: (global.Tavern.Store.state.ui.activeAgentId) || 'bartender',
        rows: [], loaded: false
      };
    },
    computed: {
      store: function () { return global.Tavern.Store; },
      agents: function () { return global.Tavern.Personas.AGENTS; },
      currentName: function () {
        var list = global.Tavern.Personas.AGENTS;
        for (var i = 0; i < list.length; i++) if (list[i].id === this.agentId) return list[i].name;
        return this.agentId;
      },
      quota: function () {
        var list = global.Tavern.Personas.AGENTS;
        for (var i = 0; i < list.length; i++) if (list[i].id === this.agentId) return list[i].memory.quota;
        return 0;
      }
    },
    mounted: function () { this.load(); },
    methods: {
      load: function () {
        var self = this;
        var aid = this.agentId;
        var MS = global.Tavern.MemoryStore;
        MS.list(aid).then(function (recs) {
          self.rows = recs.map(function (r) {
            return {
              id: r.id,
              type: TYPE_LABEL[r.type] || r.type,
              summary: r.summary || '',
              source: (r.source && r.source.indexOf('eval:') === 0) ? '深潜评估' : (SOURCE_LABEL[r.source] || r.source),
              hits: r.hits || 0,
              eff: Math.round(MS.eff(r, aid) * 100) / 100,
              at: new Date(r.createdAt || 0).toISOString().slice(0, 10)
            };
          }).sort(function (a, b) { return b.eff - a.eff || b.hits - a.hits; });
          self.loaded = true;
        });
      },
      pick: function (id) {
        if (id === this.agentId) return;
        this.agentId = id; this.rows = []; this.loaded = false;
        this.load();
      },
      back: function () { global.Tavern.Store.routeTo('world'); }
    },
    template: [
      '<section class="screen screen-pad" aria-label="记忆台">',
      '  <div class="stack" style="gap:var(--sp-2)">',
      '    <p class="label">Memory Board</p>',
      '    <h1 class="t-h1">记忆台</h1>',
      '    <p class="t-body-sm">这里显示「{{ currentName }}」真实记住的东西——没有示例数据。</p>',
      '  </div>',
      '',
      '  <div class="board__tabs">',
      '    <button v-for="a in agents" :key="a.id" class="btn btn--ghost"',
      '      :class="{ \'btn--primary\': a.id === agentId }" @click="pick(a.id)">{{ a.name }}</button>',
      '    <span class="spacer"></span>',
      '    <span class="t-mono t-meta">{{ rows.length }} / {{ quota }} 条 · 配额</span>',
      '  </div>',
      '',
      '  <p v-if="loaded && !rows.length" class="board__empty">',
      '    还没有记忆。去聊几轮——真实的写入会出现在这里，空态就应该是空的。',
      '  </p>',
      '  <div v-else class="board__list" aria-live="polite">',
      '    <div v-for="r in rows" :key="r.id" class="board__row">',
      '      <span class="chip chip--accent">{{ r.type }}</span>',
      '      <span class="board__sum">{{ r.summary }}</span>',
      '      <span class="t-meta t-mono board__meta">{{ r.source }} · 命中 {{ r.hits }} · 有效强度 {{ r.eff }} · {{ r.at }}</span>',
      '    </div>',
      '  </div>',
      '',
      '  <p class="stage-note">',
      '    <span>写入：每轮对话后真实落地；Quick 轮追加本地启发式候选（不调用 LLM，强度 ≤ 0.35，标注为「弱记忆」）。</span>',
      '    <span>读取与淘汰：关键词＋标签＋有效强度＋新鲜度打分（门槛 0.35，最多 5 条，type=goal 恒入选）；命中即巩固（strength +0.03）；有效强度 &lt; 0.15 且从未命中的会被淘汰。</span>',
      '  </p>',
      '',
      '  <div><button class="btn btn--ghost" @click="back">← 回酒馆</button></div>',
      '</section>'
    ].join('\n')
  };

  global.Tavern.UI.ScreenMemoryBoard = ScreenMemoryBoard;
})(window);
