/* ══════════════════════════════════════════════════════════════════════════
   growth.js — 成长档案（Stage 7）：真实状态的三 Agent 档案。
   等级只加深度、不减能力；能量按真实流逝时间懒结算（ENERGY_RULES.regenPerMinutes）。
   认知档案 = 由真实记忆的本地汇总（零 LLM）；未实现的解锁如实标注「规划」。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var TYPE_LABEL = { preference: '偏好', goal: '目标', fact: '事实', event: '事件' };

  var ScreenGrowth = {
    name: 'ScreenGrowth',
    data: function () { return { archives: {} }; },
    computed: {
      store: function () { return global.Tavern.Store; },
      agents: function () { return global.Tavern.Personas.AGENTS; }
    },
    mounted: function () {
      global.Tavern.Store.tickAllEnergy();   // 能量先按真实时间结算一次（不引入定时器）
      this.loadArchives();
    },
    methods: {
      rt: function (id) { return this.store.state.agents[id]; },
      stage: function (id) { return this.store.relationshipStage(id); },
      trust: function (id) { return this.store.trustLabel(id); },
      progress: function (id) { return this.store.levelProgress(id); },
      mood: function (id) { return this.store.MOOD_LABEL[this.rt(id).mood] || this.rt(id).mood; },
      archive: function (id) { return this.archives[id] || '档案读取中…'; },
      back: function () { global.Tavern.Store.routeTo('world'); },
      loadArchives: function () {
        var self = this;
        var MS = global.Tavern.MemoryStore;
        this.agents.forEach(function (a) {
          MS.list(a.id).then(function (recs) {
            if (!recs.length) { self.archives[a.id] = '档案还没成型——聊几轮，真实记忆会在这里汇总。'; return; }
            var cnt = {};
            recs.forEach(function (r) { var k = TYPE_LABEL[r.type] || r.type; cnt[k] = (cnt[k] || 0) + 1; });
            var parts = [];
            for (var k in cnt) parts.push(k + ' ' + cnt[k]);
            var top = recs.slice().sort(function (x, y) { return MS.eff(y, a.id) - MS.eff(x, a.id); })
              .slice(0, 2).map(function (r) { return '「' + String(r.summary || '').slice(0, 24) + '」'; });
            self.archives[a.id] = '她记得你 ' + recs.length + ' 件事（' + parts.join(' · ') + '）。最牢的：' + top.join('、') + '。';
          });
        });
      }
    },
    template: [
      '<section class="screen screen-pad" aria-label="成长档案">',
      '  <div class="stack" style="gap:var(--sp-2)">',
      '    <p class="label">Growth</p>',
      '    <h1 class="t-h1">成长档案</h1>',
      '    <p class="t-body-sm">真实状态，逐一可溯源：等级只加深度、不减能力——任何等级都不会锁住功能。</p>',
      '  </div>',
      '',
      '  <div v-for="a in agents" :key="a.id" class="panel grow__card">',
      '    <div class="panel__head">',
      '      <h3 class="panel__title">{{ a.name }}</h3>',
      '      <span class="chip chip--accent">Lv {{ rt(a.id).level }}</span>',
      '      <span class="chip">{{ stage(a.id) }}</span>',
      '      <span class="chip">信任 {{ trust(a.id) }}</span>',
      '      <span class="chip">心情：{{ mood(a.id) }}</span>',
      '    </div>',
      '    <div class="bar">',
      '      <div class="bar__head"><span class="label">XP</span><span class="t-mono">{{ rt(a.id).xp }} / {{ progress(a.id).next }}</span></div>',
      '      <div class="bar__track"><div class="bar__fill" :style="{ width: progress(a.id).pct + \'%\' }"></div></div>',
      '    </div>',
      '    <div class="bar">',
      '      <div class="bar__head"><span class="label">Energy</span><span class="t-mono">{{ rt(a.id).energy }} / 100</span></div>',
      '      <div class="bar__track"><div class="bar__fill" :style="{ width: rt(a.id).energy + \'%\' }"></div></div>',
      '    </div>',
      '    <p class="t-meta t-mono">发言 {{ rt(a.id).talks }} 轮 · 能量每 6 分钟回复 1 点（按真实流逝时间）</p>',
      '    <p class="t-meta grow__archive">{{ archive(a.id) }}</p>',
      '  </div>',
      '',
      '  <p class="stage-note">',
      '    <span>解锁（规划）：入场动画、计划卡徽记、主动回访——全部是观感与深度；达成情况以真实状态为准，未实现的不会假标记。</span>',
      '  </p>',
      '',
      '  <div><button class="btn btn--ghost" @click="back">← 回酒馆</button></div>',
      '</section>'
    ].join('\n')
  };

  global.Tavern.UI.ScreenGrowth = ScreenGrowth;
})(window);
