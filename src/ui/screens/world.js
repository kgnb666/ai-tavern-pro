/* ══════════════════════════════════════════════════════════════════════════
   world.js — 屏 2：Tavern World（选人）
   目标：10 秒内让人判断「这是个产品」。卡片内容逐字来自 persona-spec.md。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var ScreenWorld = {
    name: 'ScreenWorld',
    components: { Portrait: global.Tavern.UI.Portrait },
    computed: {
      agents: function () { return global.Tavern.Personas.AGENTS; },
      topics: function () { return global.Tavern.Personas.DEMO_TOPICS; },
      store: function () { return global.Tavern.Store; },
      runtime: function () { return this.store.state.agents; },
      moodLabel: function () { return this.store.MOOD_LABEL; },
      stage: function () {
        var self = this;
        return function (id) { return self.store.relationshipStage(id); };
      },
      trust: function () {
        var self = this;
        return function (id) { return self.store.trustLabel(id); };
      }
    },
    methods: {
      sit: function (id) { this.store.openAgent(id); }
    },
    template: [
      '<section class="screen world">',
      '  <p class="stage-note">',
      '    <span>本地认知、记忆检索与工具调用都在本机真实发生；对话由所选 Provider 生成（当前引擎以气泡标识为准）。',
      '    等级与 XP 起初一律为 0：成长只能来自真实交互。</span>',
      '  </p>',
      '',
      '  <header class="world__head" style="margin-top:var(--sp-5)">',
      '    <p class="label">Tavern World</p>',
      '    <h1 class="t-h1">今夜酒馆</h1>',
      '    <p class="t-body-sm">三位常客各自记得不同的事。挑一个坐下。</p>',
      '  </header>',
      '',
      '  <div class="world__grid stagger">',
      '    <button',
      '      v-for="a in agents"',
      '      :key="a.id"',
      '      class="agent-card"',
      '      :data-agent="a.id"',
      '      :aria-label="\'与\' + a.name + \'坐下\'"',
      '      @click="sit(a.id)"',
      '    >',
      '      <div class="agent-card__portrait">',
      '        <Portrait :kind="a.portrait" />',
      '      </div>',
      '',
      '      <div class="stack" style="gap:var(--sp-1)">',
      '        <div class="row" style="align-items:baseline;gap:var(--sp-2);flex-wrap:wrap">',
      '          <span class="agent-card__name">{{ a.name }}</span>',
      '          <span class="agent-card__code muted-3">{{ a.code }}</span>',
      '          <span class="spacer"></span>',
      '          <span class="chip">',
      '            <span class="ring" :class="{ \'ring--tired\': runtime[a.id].mood === \'tired\', \'ring--energized\': runtime[a.id].mood === \'energized\' }" aria-hidden="true"></span>',
      '            {{ moodLabel[runtime[a.id].mood] }}',
      '          </span>',
      '        </div>',
      '        <p class="agent-card__title">{{ a.title }}</p>',
      '      </div>',
      '',
      '      <p class="agent-card__desc">{{ a.desc }}</p>',
      '',
      '      <div class="stack" style="gap:var(--sp-3)">',
      '        <div class="agent-card__tags">',
      '          <span v-for="c in a.capabilities" :key="c" class="chip chip--accent">{{ c }}</span>',
      '        </div>',
      '',
      '        <div class="stack" style="gap:var(--sp-2)">',
      '          <div class="bar">',
      '            <div class="bar__head">',
      '              <span class="label">Energy</span>',
      '              <span class="t-mono">{{ runtime[a.id].energy }}</span>',
      '            </div>',
      '            <div class="bar__track">',
      '              <div class="bar__fill" :style="{ width: runtime[a.id].energy + \'%\' }"></div>',
      '            </div>',
      '          </div>',
      '          <div class="row" style="gap:var(--sp-2);flex-wrap:wrap;align-items:center">',
      '            <span class="label">关系</span>',
      '            <span class="chip">{{ stage(a.id) }}</span>',
      '            <span class="chip">信任 {{ trust(a.id) }}</span>',
      '            <span class="t-mono muted-3">Lv {{ runtime[a.id].level }}</span>',
      '          </div>',
      '        </div>',
      '',
      '        <div class="stack" style="gap:var(--sp-2)">',
      '          <span class="label">Tools</span>',
      '          <div class="agent-card__tags">',
      '            <span v-for="t in a.tools" :key="t" class="chip">{{ t }}</span>',
      '          </div>',
      '        </div>',
      '',
      '        <div class="stack" style="gap:var(--sp-2)">',
      '          <span class="label">可以问她/他的事</span>',
      '          <div class="agent-card__tags">',
      '            <span v-for="t in topics[a.id]" :key="t" class="chip chip--accent">{{ t }}</span>',
      '          </div>',
      '        </div>',
      '      </div>',
      '    </button>',
      '  </div>',
      '',
      '  <footer class="world__foot">',
      '    <span class="pill">记忆台 / 成长档案已开放 · 零示例数据</span>',
      '    <span class="pill">肖像为内联 SVG · 本页零外部资源</span>',
      '  </footer>',
      '</section>'
    ].join('\n')
  };

  global.Tavern.UI.ScreenWorld = ScreenWorld;
})(window);
