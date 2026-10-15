/* ══════════════════════════════════════════════════════════════════════════
   entry.js — 屏 1：推门（stage-0 §2.2）
   目标：0~2 秒建立沉浸感。回车与按钮等价，键盘也可进入。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var CONCEPT = ['Persona', 'Memory', 'Planning', 'Tools', 'Evaluation'];

  var ScreenEntry = {
    name: 'ScreenEntry',
    data: function () {
      return { concept: CONCEPT };
    },
    computed: {
      build: function () { return global.__TAVERN_BUILD__ || {}; }
    },
    mounted: function () {
      global.addEventListener('keydown', this.onKey);
    },
    unmounted: function () {
      global.removeEventListener('keydown', this.onKey);
    },
    methods: {
      enter: function () { global.Tavern.Store.enterTavern(); },
      onKey: function (e) {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) this.enter();
      }
    },
    template: [
      '<section class="screen entry">',
      '  <p class="entry__eyebrow">TAVERN · SHENZHEN NODE · {{ build.hash || "dev" }}</p>',
      '  <h1 class="entry__title">推开这扇门</h1>',
      '  <p class="entry__sub">',
      '    一家属于 AI Agent 的酒馆。三位常客各有性格、各有记忆，',
      '    你能看见它们在回答之前，先把事情想了一遍。',
      '  </p>',
      '  <div class="entry__concept">',
      '    <span class="label">Agent</span>',
      '    <span class="t-mono accented" aria-hidden="true">=</span>',
      '    <span v-for="c in concept" :key="c" class="chip chip--accent">{{ c }}</span>',
      '  </div>',
      '  <button class="btn btn--primary btn--lg entry__door" @click="enter">',
      '    推门进入 <span aria-hidden="true">→</span>',
      '  </button>',
      '  <p class="entry__hint">按回车也可以 · 聊过的事，会被记住</p>',
      '</section>'
    ].join('\n')
  };

  global.Tavern = global.Tavern || {};
  global.Tavern.UI = global.Tavern.UI || {};
  global.Tavern.UI.ScreenEntry = ScreenEntry;
})(window);
