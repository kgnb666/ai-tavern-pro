/* ══════════════════════════════════════════════════════════════════════════
   tools.js — ToolRegistry（Stage 3-4a：只负责"选择 + 执行 + 返回结构化结果"）
   ──────────────────────────────────────────────────────────────────────────
   唯一入口：
     ToolRegistry.execute({ agent, intent, userText }) →
       { calls:[ { name, args, result, ms, ok, source:'registry' } ] }
     失败时也必须返回结构：{ calls:[], ok:false, error, ms } —— **绝不 throw 到 UI**

   读取权限（严格）：只消费 `agent.tools`（工具清单）。
     禁止读：人格文案 / 关系状态 / memory / prompt 内容。
   禁止：生成 prompt、改 persona、改 card、写 Store、发事件、渲染 UI。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var REGISTRY = Object.create(null);
  var DEFAULT_TIMEOUT = 3000;

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  function ms(t0) { return Math.round((now() - t0) * 100) / 100; }

  /** 注册一个工具：{ name, desc, timeoutMs?, when(ctx)->bool, run(args, {signal})->Promise<any> } */
  function register(tool) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.run !== 'function') {
      throw new Error('[ToolRegistry] 工具需要 { name, run }');
    }
    REGISTRY[tool.name] = {
      name: tool.name,
      desc: tool.desc || '',
      source: tool.source || 'registry',
      timeoutMs: tool.timeoutMs || DEFAULT_TIMEOUT,
      when: typeof tool.when === 'function' ? tool.when : function () { return true; },
      run: tool.run
    };
    return REGISTRY[tool.name];
  }

  function has(name) { return !!REGISTRY[name]; }
  function list() { return Object.keys(REGISTRY); }

  /** 需要超时保护：ToolRegistry 只负责"到点就中止并如实上报"，不吞失败 */
  function withTimeout(tool, args) {
    var t0 = now();
    var ctrl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    var timer = null;
    var timedOut = false;
    var work = Promise.resolve().then(function () { return tool.run(args, { signal: ctrl ? ctrl.signal : null }); });
    var guard = new Promise(function (_res, rej) {
      timer = setTimeout(function () {
        timedOut = true;
        if (ctrl) { try { ctrl.abort('tool_timeout'); } catch (e) {} }
        rej(new Error('timeout'));
      }, tool.timeoutMs);
    });
    return Promise.race([work, guard]).then(function (result) {
      clearTimeout(timer);
      return { ok: true, result: result, ms: ms(t0) };
    }, function (err) {
      clearTimeout(timer);
      return { ok: false, error: timedOut ? 'timeout' : String((err && err.message) || err), ms: ms(t0) };
    });
  }

  /**
   * 冻结 API。任何异常都在此被收拢成结构化结果 —— UI 永远不会收到 throw。
   * 触发条件由各工具自己的 when(ctx) 决定；未注册的工具（清单里有但没实现）一律跳过，
   * 不产生"看起来执行了"的假调用。
   */
  function execute(input) {
    var t0 = now();
    var calls = [];
    var allowed;
    try {
      allowed = (input && input.agent && input.agent.tools) || [];
      if (!Array.isArray(allowed)) allowed = [];
      var ctx = {
        agentId: (input && input.agent && input.agent.id) || null,
        intent: (input && input.intent) || null,
        userText: String((input && input.userText) || '')
      };
      var picked = [];
      for (var i = 0; i < allowed.length; i++) {
        var tool = REGISTRY[allowed[i]];
        if (!tool) continue;                       // 清单里有、但本阶段未实现 → 跳过
        var want = false;
        try { want = !!tool.when(ctx); } catch (e) { want = false; }
        if (want) picked.push(tool);
      }
      if (!picked.length) return Promise.resolve({ calls: [], ms: ms(t0) });

      // 串行执行：工具之间不共享状态，串行更易读、也避免并发打上游
      var chain = Promise.resolve();
      picked.forEach(function (tool) {
        chain = chain.then(function () {
          var args = { query: ctx.userText, intent: ctx.intent && ctx.intent.name };
          return withTimeout(tool, args).then(function (r) {
            calls.push({
              name: tool.name, args: args,
              result: r.ok ? r.result : null,
              error: r.ok ? null : r.error,
              ms: r.ms, ok: r.ok, source: tool.source
            });
          });
        });
      });
      return chain.then(function () { return { calls: calls, ms: ms(t0) }; });
    } catch (e) {
      return Promise.resolve({ calls: calls, ok: false, error: String((e && e.message) || e), ms: ms(t0) });
    }
  }

  /* ── wiki_lookup：真实 Wikipedia 检索（两步：全文本检索 → 取首条摘要） ──
     接口实测（2026-10-13）：
       · Action API 检索：/w/api.php?action=query&list=search&srsearch=…&format=json&origin=*
         返回 query.search[] = {title, snippet, …}；snippet **含 HTML 标签**，必须剥离
       · REST 摘要：/api/rest_v1/page/summary/<title> → {title, extract(纯文本), content_urls.desktop.page}
     两个端点的 `access-control-allow-origin: *` 均已实测，浏览器可直连，无需 Worker 代理。 */
  var WIKI = {
    SEARCH: 'https://zh.wikipedia.org/w/api.php',
    SUMMARY: 'https://zh.wikipedia.org/api/rest_v1/page/summary/',
    TIMEOUT: 3000            // persona-spec §3.5 冻结的超时
  };
  var MAX_SUMMARY = 600;     // 摘要上限：控制 prompt 体积与注入面

  function toolErr(code) { var e = new Error(code); e.code = code; return e; }
  function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

  function readJson(res) {
    if (!res || !res.ok) return Promise.reject(toolErr('http_' + ((res && res.status) || 'unknown')));
    return res.text().then(function (t) {
      try { return JSON.parse(t); } catch (e) { throw toolErr('bad_json'); }
    });
  }

  /** run(args, {signal})：失败一律 reject 结构化 code，由 ToolRegistry 收拢成 {ok:false,error,ms} */
  function wikiLookup(query, opts) {
    var q = String(query || '').trim();
    if (!q) return Promise.reject(toolErr('empty_query'));
    var signal = (opts && opts.signal) || undefined;
    var searchUrl = WIKI.SEARCH + '?action=query&list=search&srsearch=' +
      encodeURIComponent(q) + '&srlimit=1&format=json&origin=*';
    return fetch(searchUrl, { signal: signal })
      .then(readJson)
      .then(function (j) {
        var hits = (j && j.query && j.query.search) || [];
        if (!hits.length) throw toolErr('no_result');
        return fetch(WIKI.SUMMARY + encodeURIComponent(hits[0].title), { signal: signal }).then(readJson);
      })
      .then(function (sum) {
        var extract = stripTags(sum && sum.extract);
        if (!extract) throw toolErr('no_extract');
        var url = (sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page) || null;
        if (!url) throw toolErr('no_url');       // 不凭猜测构造来源 URL
        return { title: String(sum.title || ''), summary: extract.slice(0, MAX_SUMMARY), url: url, source: 'wikipedia' };
      });
  }

  register({
    name: 'wiki_lookup',
    desc: '在 Wikipedia 检索并取首条摘要（真实网络请求；只返回纯文本与真实来源 URL）',
    timeoutMs: WIKI.TIMEOUT,
    when: function (ctx) {
      var t = String(ctx.userText || '');
      if (/是什么|什么是|怎么理解|什么意思|解释|原理|定义|介绍|科普|区别|百科/.test(t)) return true;
      return !!(ctx.intent && ctx.intent.name === 'knowledge');
    },
    run: function (args, o) { return wikiLookup(args.query, o); }
  });

  global.Tavern = global.Tavern || {};
  global.Tavern.ToolRegistry = Object.freeze({
    LABEL: '工具调用',
    DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
    register: register,
    has: has,
    list: list,
    execute: execute
  });
})(window);
