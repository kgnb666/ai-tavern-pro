/* ══════════════════════════════════════════════════════════════════════════
   boot.js — 挂载与自检
   ──────────────────────────────────────────────────────────────────────────
   自检项（stage-1-plan 的 R15 实测 + Stage 1 骨架健康度）：
     1. Vue 与 Tavern.* 全局命名空间共存（R15）
     2. 三层命名空间完整性（Personas / EventBus / Store / UI）
     3. 事件契约可执行性（8 个 trace 事件 + 11 个已知事件；未知事件名必须抛错）
     4. 路由可往返（含状态复原）
     5. persona 冻结参数可读（三 Agent、mood 枚举、记忆参数）
     6. 运行时零外部请求（performance resource timing 实测）
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var doc = global.document;

  /* 网关端点：可用 ?api=<url> 覆盖；?mock=1 强制离线模拟；file:// 打开时无法跨域调网关 → 自动离线 */
  var DEFAULT_API = 'https://tavern.myiskg.com';
  function qs() { try { return new URLSearchParams(global.location.search); } catch (e) { return null; } }
  function apiBase() {
    var q = qs();
    var v = q && q.get('api');
    return (v || DEFAULT_API).replace(/\/+$/, '');
  }
  function forcedMock() { var q = qs(); return !!(q && q.get('mock') === '1'); }
  function canReachGateway() { return global.location.protocol === 'http:' || global.location.protocol === 'https:'; }

  function showFatal(title, detail) {
    var box = doc.getElementById('fatal');
    if (!box) return;
    box.hidden = false;
    box.innerHTML =
      '<h1 class="t-h2">酒馆没能开门</h1>' +
      '<p class="t-body-sm">' + title + '</p>' +
      (detail ? '<code>' + String(detail).replace(/[<>&]/g, '') + '</code>' : '');
    box.style.position = 'fixed';
    box.style.inset = '0';
    box.style.background = 'var(--bg-tavern)';
    box.style.zIndex = 'var(--z-modal)';
  }

  /* ── 外部请求实测（决定 Gate 的硬指标） ───────────────────────────── */
  function externalRequests() {
    try {
      if (!global.performance || !performance.getEntriesByType) return null;
      return performance.getEntriesByType('resource')
        .map(function (e) { return e.name; })
        .filter(function (u) {
          if (/^(data:|blob:)/i.test(u)) return false;   // 内联资源
          if (/^file:/i.test(u)) return false;           // 本地文件页的内嵌资源
          if (u.indexOf(apiBase()) === 0) return false;  // **唯一允许的外部请求**：我们自己的网关端点
          if (!location.host) return true;               // file:// 打开：其余任何 http(s) 都是外部
          return u.indexOf(location.origin) !== 0;
        });
    } catch (err) {
      return null;   // 环境不支持 → 记为「未知」而非「通过」
    }
  }

  /* ── 自检 ─────────────────────────────────────────────────────────── */
  function selfTest() {
    var T = global.Tavern;
    var results = [];
    var add = function (name, ok, note) { results.push({ name: name, ok: ok, note: note || '' }); };

    // 1. R15：Vue 与 Tavern.* 共存
    var vueOk = typeof global.Vue === 'object' && typeof global.Vue.createApp === 'function';
    add('R15 · Vue 可用', vueOk, vueOk ? 'Vue ' + (global.Vue.version || '?') : 'window.Vue 缺失');
    add('R15 · window.Tavern 未被 Vue 覆盖', typeof T === 'object' && !!(T.Personas && T.EventBus && T.Store && T.UI),
      'Vue 与 Tavern 命名空间互不干扰');

    // 2. 命名空间完整性（逐项报出缺失，而不是只说一句"不完整"）
    var needTop = ['Personas', 'MockScripts', 'EventBus', 'Provider', 'Store', 'Turn', 'Providers', 'UI'];
    var needUI = ['Portrait', 'TraceLive', 'Transcript', 'ScreenEntry', 'ScreenWorld', 'ScreenRoom', 'ScreenMemoryBoard', 'ScreenGrowth', 'AppShell'];
    var missing = [];
    needTop.forEach(function (k) { if (!T[k]) missing.push(k); });
    needUI.forEach(function (k) { if (!T.UI || !T.UI[k]) missing.push('UI.' + k); });
    add('命名空间完整', missing.length === 0,
      missing.length ? '缺失：' + missing.join(', ') : needTop.length + ' 个顶层导出 + ' + needUI.length + ' 个 UI 组件');

    // 3. 事件契约可执行
    var evOk = T.EventBus.TRACE_EVENTS.length === 8 && T.EventBus.UI_EVENTS.length === 3;
    var throwsOnUnknown = false;
    try { T.EventBus.emit('trace:not-a-real-event', {}); } catch (e) { throwsOnUnknown = true; }
    add('事件契约（8 trace + 3 ui）', evOk, '与 stage-0 §2.4 一致');
    add('未知事件名被拒绝', throwsOnUnknown, 'append 新事件必须先改契约文档');

    // 4. 路由往返（改完复原）
    var S = T.Store;
    var before = S.state.session.route;
    var beforeAgent = S.state.ui.activeAgentId;
    var routeOk = false;
    try {
      S.routeTo('memory'); routeOk = S.state.session.route === 'memory';
      S.openAgent('oracle'); routeOk = routeOk && S.state.ui.activeAgentId === 'oracle';
    } catch (e) { routeOk = false; }
    S.state.session.route = before;
    S.state.ui.activeAgentId = beforeAgent;
    add('路由往返（memory / room）', routeOk, '状态已复原');

    // 5. persona 冻结参数
    var P = T.Personas;
    add('persona 冻结参数', P.AGENTS.length === 3 && P.FROZEN.MOODS.length === 7 &&
      P.FROZEN.QUOTA.bartender === 45 && P.FROZEN.RETRIEVAL.threshold === 0.35,
      'spec ' + P.SPEC_VERSION + ' · ' + P.AGENTS.map(function (a) { return a.id; }).join('/'));

    // 6. Provider 契约与"阶段 → 事件"映射完整性
    var prov = T.Provider.current();
    var phases = T.Provider.PHASES;
    var unmapped = phases.filter(function (p) { return !T.Provider.PHASE_TRANSPORT[p]; });
    add('Provider 已注册', !!prov, prov ? prov.id + ' · ' + prov.meta.label : '未注册');
    add('阶段→冻结事件映射完整', unmapped.length === 0,
      phases.length + ' 个阶段，未映射 ' + unmapped.length + ' 个');
    add('Provider 身份可被 UI 展示', !!(prov && typeof prov.meta.isMock === 'boolean' && typeof prov.meta.label === 'string'),
      prov ? (prov.id + ' · isMock=' + prov.meta.isMock) : '未注册');

    // 7. 运行时外部请求
    var ext = externalRequests();
    add('除网关外零外部请求', ext !== null && ext.length === 0,
      ext === null ? '环境不支持 resource timing（未知）'
        : (ext.length === 0 ? '实测 0 条意外跨源资源（网关端点已列入白名单）' : ext.join(' , ')));

    var failed = results.filter(function (r) { return !r.ok; }).length;
    return { ok: failed === 0, failed: failed, results: results };
  }

  function report(test) {
    var head = test.ok
      ? '%c[Tavern 自检] 全部通过 ✅'
      : '%c[Tavern 自检] ' + test.failed + ' 项未通过 ❌';
    console.group(head, 'font-weight:bold');
    test.results.forEach(function (r) {
      console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.note ? '  — ' + r.note : ''));
    });
    console.log('  提示：控制台输入 Tavern.__selfTest() 可随时重跑。');
    console.groupEnd();
  }

  /* ── 启动 ─────────────────────────────────────────────────────────── */
  function boot() {
    if (typeof global.Vue === 'undefined' || !global.Vue.createApp) {
      showFatal('未找到内联的 Vue（vendor 缺失）。请重新构建：node build.js --release');
      return;
    }
    if (!global.Tavern || !global.Tavern.UI || !global.Tavern.UI.AppShell) {
      showFatal('应用脚本未完整加载（Tavern.UI.AppShell 缺失）。');
      return;
    }

    doc.documentElement.setAttribute('data-build', (global.__TAVERN_BUILD__ || {}).hash || 'dev');

    // Provider 选择：探活成功 → 在线网关；失败 / ?mock=1 / file:// → 离线模拟（一定要能用）
    var P = global.Tavern.Provider;
    var Providers = global.Tavern.Providers || {};
    return chooseProvider(Providers).then(function (chosen) {
      try {
        P.register(chosen.provider);
      } catch (err) {
        showFatal('Provider 注册失败：' + (err && err.message), err && err.stack);
        return;
      }
      global.Tavern.Store.state.session.online = chosen.online;
      global.Tavern.Store.state.session.endpoint = chosen.online ? apiBase() : null;
      mountAndCheck();
    });
  }

  function chooseProvider(Providers) {
    var Mock = Providers.Mock;
    if (!Mock) return Promise.reject(new Error('缺少 MockProvider'));
    if (forcedMock() || !canReachGateway() || !Providers.Gateway) {
      return Promise.resolve({ provider: Mock, online: false, reason: forcedMock() ? 'forced' : 'no-http-context' });
    }
    var base = apiBase();
    var to = (global.AbortSignal && AbortSignal.timeout) ? AbortSignal.timeout(2500) : undefined;
    return fetch(base + '/v1/health', { signal: to })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) { Providers.Gateway.setEndpoint(base); return { provider: Providers.Gateway, online: true }; }
        return { provider: Mock, online: false, reason: 'health-not-ok' };
      })
      .catch(function () { return { provider: Mock, online: false, reason: 'probe-failed' }; });
  }

  function mountAndCheck() {
    try {
      var app = global.Vue.createApp(global.Tavern.UI.AppShell);
      app.mount('#app');
    } catch (err) {
      showFatal('挂载失败：' + (err && err.message), err && err.stack);
      return;
    }

    // 进入后台时全局暂停动画（design-token §6.4-6）
    doc.addEventListener('visibilitychange', function () {
      doc.documentElement.classList.toggle('is-paused', doc.hidden);
    });

    // 未捕获错误 → 显示可读面板，不留白屏
    global.addEventListener('error', function (e) {
      showFatal('运行时错误：' + (e.message || '未知'), e.error && e.error.stack);
    });
    global.addEventListener('unhandledrejection', function (e) {
      showFatal('未处理的异步错误', e.reason && (e.reason.stack || e.reason.message || e.reason));
    });

    var test = selfTest();
    report(test);

    // 把自检结论写进 DOM：让 Gate 可被无头浏览器/CI 直接读取，不必抓控制台
    try {
      var ext = externalRequests();
      var root = doc.documentElement;
      root.setAttribute('data-app-mounted', 'true');
      root.setAttribute('data-vue', String(global.Vue.version || '?'));
      root.setAttribute('data-provider', global.Tavern.Provider.current().id);
      root.setAttribute('data-provider-kind', global.Tavern.Provider.current().kind);
      root.setAttribute('data-selftest', test.ok ? 'pass' : 'fail');
      root.setAttribute('data-selftest-failed', String(test.failed));
      root.setAttribute('data-external-requests', ext === null ? 'unknown' : String(ext.length));
      root.setAttribute('data-selftest-detail', JSON.stringify(test.results.map(function (r) {
        return (r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.note ? ' | ' + r.note : '');
      })));
    } catch (e) { /* 自检结论写不进去不应影响页面 */ }

    global.Tavern.__selfTest = selfTest;
    global.Tavern.__externalRequests = externalRequests;
    global.Tavern.__build = global.__TAVERN_BUILD__ || null;
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
