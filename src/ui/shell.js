/* ══════════════════════════════════════════════════════════════════════════
   shell.js — 应用壳：HUD 与路由
   路由表：entry / world / room / memory / growth（stage-0 §2.2 + stage-1-plan T3）
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var UI = global.Tavern.UI;

  var AppShell = {
    name: 'AppShell',
    components: {
      ScreenEntry: UI.ScreenEntry,
      ScreenWorld: UI.ScreenWorld,
      ScreenRoom: UI.ScreenRoom,
      ScreenMemoryBoard: UI.ScreenMemoryBoard,
      ScreenGrowth: UI.ScreenGrowth
    },
    computed: {
      state: function () { return global.Tavern.Store.state; },
      route: function () { return this.state.session.route; },
      entered: function () { return this.state.session.entered; },
      agentId: function () { return this.state.ui.activeAgentId; },
      agentName: function () {
        var a = this.agentId ? global.Tavern.Store.agentById(this.agentId) : null;
        return a ? a.name : '';
      },
      build: function () { return global.__TAVERN_BUILD__ || {}; },
      provider: function () {
        return global.Tavern.Provider.current() ||
          { id: 'none', meta: { isMock: false, label: '未注册', note: '尚未注册 Provider' } };
      },
      providerPillClass: function () { return this.provider.meta.isMock ? 'pill--mock' : 'pill--online'; },
      providerLabel: function () { return this.provider.meta.isMock ? '模拟引擎 · 无 LLM' : this.provider.id; },
      specLine: function () {
        var s = (this.build.spec || {});
        return [s.persona, s.tokens].filter(Boolean).join(' · ');
      }
    },
    methods: {
      go: function (route) { global.Tavern.Store.routeTo(route); },
      is: function (route) { return this.route === route; }
    },
    template: [
      '<div class="app">',
      '  <a class="sr-only" href="#main">跳到主内容</a>',
      '',
      '  <header class="hud">',
      '    <div class="hud__brand">',
      '      <span class="hud__mark">AI Tavern Pro</span>',
      '      <span class="hud__sub">think · remember · evolve</span>',
      '    </div>',
      '',
      '    <span class="spacer"></span>',
      '',
      '    <nav v-if="entered" class="hud__nav" aria-label="主导航">',
      '      <button class="btn btn--ghost" :class="{ \'btn--primary\': is(\'world\') || is(\'room\') }" @click="go(\'world\')">酒馆</button>',
      '      <button class="btn btn--ghost" :class="{ \'btn--primary\': is(\'memory\') }" @click="go(\'memory\')">记忆台</button>',
      '      <button class="btn btn--ghost" :class="{ \'btn--primary\': is(\'growth\') }" @click="go(\'growth\')">成长</button>',
      '    </nav>',
      '',
      '    <div class="hud__right">',
      '      <span v-if="route === \'room\' && agentName" class="pill">{{ agentName }}</span>',
      '      <span class="pill" :class="providerPillClass" :title="provider.meta.note">',
      '        <span class="pill__dot" aria-hidden="true"></span> {{ providerLabel }}',
      '      </span>',
      '      <span class="pill hud__pill--gw" :class="state.session.online ? \'pill--online\' : \'pill--offline\'" :title="state.session.online ? \'探活成功：真实模型已接通\' : \'探活失败：离线模拟\'">',
      '        <span class="pill__dot" aria-hidden="true"></span> {{ state.session.online ? \'网关已接入\' : \'网关未接入\' }}',
      '      </span>',
      '      <span class="pill hud__pill--build" :title="specLine">build {{ build.hash || "dev" }}</span>',
      '    </div>',
      '  </header>',
      '',
      '  <main class="main" id="main">',
      '    <ScreenEntry v-if="route === \'entry\'" />',
      '    <ScreenWorld v-else-if="route === \'world\'" />',
      '    <ScreenRoom v-else-if="route === \'room\' && agentId" />',
      '    <ScreenMemoryBoard v-else-if="route === \'memory\'" />',
      '    <ScreenGrowth v-else-if="route === \'growth\'" />',
      '    <ScreenWorld v-else />',
      '  </main>',
      '</div>'
    ].join('\n')
  };

  UI.AppShell = AppShell;
})(window);
