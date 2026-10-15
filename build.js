#!/usr/bin/env node
/**
 * AI Tavern Pro — 单文件构建脚本
 * 依据：docs/stage-1-plan.md §3（build.js 规格）
 *
 * 零依赖：只使用 node: 内置模块（需要 Node 18+，本机 v24）。
 *
 * 用法：
 *   node build.js                  release 构建 → dist/AI-Tavern.html（默认，安全）
 *   node build.js --release        同上（显式）
 *   node build.js --dev            开发构建：vendor 走 CDN，便于快速迭代（产物不可交付）
 *   node build.js --fetch-vendor   下载 vendor 并写入/更新 src/vendor/lock.json
 *
 * release 构建会执行：vendor sha256 校验 → 注入 → 体积报告 → 外部引用扫描（发现即非零退出）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');

const ROOT = __dirname;
const TEMPLATE = 'src/index.html';
const OUT = 'dist/AI-Tavern.html';
const VENDOR_FILE = 'src/vendor/vue.global.prod.js';          // 构建期编译器（不进产物）
const VENDOR_RUNTIME = 'src/vendor/vue.runtime.global.prod.js'; // 产物内联的运行时
const LOCK_FILE = 'src/vendor/lock.json';

/** 冻结的内联顺序（stage-1-plan.md §3：vendor → styles → data → core → ui → boot） */
const CSS_ORDER = [
  'src/styles/tokens.css',
  'src/styles/base.css',
  'src/styles/components.css',
  'src/styles/screens.css',
];
const JS_ORDER = [
  'src/data/personas.js',
  'src/data/mock-scripts.js',
  'src/data/events.js',
  'src/core/eventbus.js',
  'src/core/cognition.js',
  'src/core/memory.js',
  'src/core/persona.js',
  'src/core/tools.js',
  'src/core/provider.js',
  'src/core/store.js',
  'src/core/turn.js',
  'src/providers/mock.js',
  'src/providers/gateway.js',
  'src/ui/components/portrait.js',
  'src/ui/components/card.js',
  'src/ui/components/trace-live.js',
  'src/ui/components/transcript.js',
  'src/ui/screens/entry.js',
  'src/ui/screens/world.js',
  'src/ui/screens/room.js',
  'src/ui/screens/memory-board.js',
  'src/ui/screens/growth.js',
  'src/ui/shell.js',
  'src/boot.js',
];
const MARKERS = ['BUILD_META', 'STYLES', 'VENDOR', 'APP'];

/** 体积预算（冻结值来自 stage-0 R4 与 stage-1-plan §3；超限即拒绝 release 构建） */
const BUDGET = { raw: 330 * 1024, gzip: 104 * 1024 };   // raw 328->330KB / gzip 103->104KB（Stage 9：§1.6.4 收尾，委派裁决）

/** 冻结文档版本（写入产物，便于评审追溯产物对应哪一版契约） */
const SPEC_VERSIONS = {
  architecture: 'stage-0-architecture v1.0',
  persona: 'persona-spec p1.0',
  tokens: 'design-token t1.0',
  plan: 'stage-1-plan s1.0',
};

/** 交付产物的红线：这些模式一旦出现即为外部资源引用 */
const FORBIDDEN = [
  { re: /<link\b/gi, why: '<link> 标签（外部样式/资源）' },
  { re: /<script\b[^>]*\bsrc\s*=/gi, why: '<script src>（外部脚本）' },
  { re: /<img\b/gi, why: '<img> 标签（外部图片）' },
  { re: /<(?:iframe|object|embed|video|audio|source|track|picture)\b/gi, why: '嵌入类标签' },
  { re: /@import\b/gi, why: 'CSS @import' },
  { re: /url\(\s*['"]?(?:https?:)?\/\//gi, why: 'CSS url() 指向外部协议' },
];

// ─────────────────────────────── 工具

const fail = (msg) => {
  console.error('\n✗ 构建失败：' + msg + '\n');
  process.exit(1);
};
const bytes = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

function readFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) fail('缺少文件：' + rel + '\n  期望路径：' + abs);
  return fs.readFileSync(abs, 'utf8');
}

/** 内联保护：script/style 里出现对应闭合标签会撕开单文件结构 */
function guardChunk(rel, content, kind) {
  const closer = kind === 'css' ? '</style' : '</script';
  if (content.toLowerCase().includes(closer)) {
    fail(
      rel + ' 含有字面量 `' + closer + '>`，会撕开单文件结构。\n' +
      '  请改写为转义形式（JS 中写 "<\\/script"）。'
    );
  }
}

/**
 * release 专用压缩：去掉整行注释与空行，并折叠行首/行尾空白。
 * 安全性依据：JS/CSS 中行首空白无语义，且本项目**没有任何跨行的字符串或模板字面量**
 * （构建前对 src 下全部 js 做反引号计数校验，结果为 0），
 * 因此折叠空白不可能改坏字面量。不碰行尾注释（可能落在字符串里）。
 * 源码（src/**）保持完整注释与缩进，可读性不受影响。
 *
 * 标题压缩（DR-008 批准的纯注释压缩，"集中处理"方案）：
 *   · 文件顶部标题块 → 不再单独占一行，只汇入一行索引（文件名仍可检索）；
 *   · 承载实质说明的块 → 留在原位，判定见 KEEP_RE（冻结契约 / 错误处理 /
 *     安全约束 / 测试 / 架构边界 / 顺序 / 降级 / 决策编号 / 实测数据）；
 *   · 其余章节标记 → 仅源码保留，产物不再输出。
 */
const KEEP_RE = /冻结|错误|安全|契约|测试|边界|顺序|降级|DR-\d|D-\d|去重|实测|异常|只允许引用|只由本文件调用/;

function squeeze(chunk) {
  const kept = [];
  let removed = 0;
  let block = null;   // 正在收集的多行块注释
  let seen = 0;       // 本 chunk 内已完成的块数（1 = 文件标题块）
  let title = null;   // 文件标题 → 由调用方汇入全局索引行

  const shortTitle = (s) => {
    let t = String(s).split(/—|：|·|\(|（/)[0].trim();
    if (t.length > 26) t = t.slice(0, 26);
    return t || 'section';
  };

  /* 行尾注释剥除（Stage 4 预算整理）：安全前提已逐条取证——
     ① 注释段前不得出现反斜杠（排除转义引号/正则转义，当前 48 条全通过、0 跳过）；
     ② `//` 之前该行的单/双引号必须各自成对（项目无跨行字符串，不成对 ⇒ 保守跳过）。
     两条同时成立时，`//` 必为注释起点。KEEP_RE 只管块注释，不受本步影响。 */
  const stripTrail = (s) => {
    const i = s.indexOf(' //');
    if (i === -1) return s;
    const head = s.slice(0, i);
    if (!head.trim() || head.indexOf('\\') !== -1) return s;
    let q1 = 0, q2 = 0;
    for (let k = 0; k < head.length; k++) {
      const c = head[k];
      if (c === "'") q1++; else if (c === '"') q2++;
    }
    return (q1 % 2 === 0 && q2 % 2 === 0) ? head.replace(/\s+$/, '') : s;
  };

  const flushBlock = () => {
    if (!block) return;
    // 压成**单行注释**：取首个有内容的一行（跳过 ═ ─ * 这类纯装饰行）并补上闭合符。
    // ⚠ 绝不能只留首行而不闭合 —— 那样整个脚本会被注释吞掉（本阶段实际踩过这个坑：
    //    产物里 35 个 /* 只剩 1 个 */，Tavern 直接未定义）。构建末尾的解析校验专门防它。
    let pick = '';
    for (const raw of block.body) {
      const s = String(raw).replace(/^[\s*═─\-]+/, '').replace(/[\s*═─\-]+$/, '').trim();
      if (s) { pick = s; break; }
    }
    if (pick) {
      seen++;
      if (seen === 1) {
        title = shortTitle(pick);                                    // 文件标题 → 索引行
      } else if (KEEP_RE.test(pick) || KEEP_RE.test(block.body.join(' '))) {
        kept.push('/* ' + shortTitle(pick) + ' */');                 // 实质说明留在原位
      }
    }
    removed += block.body.length;
    block = null;
  };

  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (block) {
      const close = t.indexOf('*/');
      if (close === -1) { block.body.push(line); continue; }
      const head = t.slice(0, close).replace(/^[\s*]+/, '').trim();
      if (head) block.body.push(head);
      flushBlock();
      continue;
    }
    if (t === '' || /^\/\/.*$/.test(t) || /^\/\*.*\*\/$/.test(t)) { removed++; continue; }
    if (/^\/\*/.test(t)) {
      const head = t.replace(/^\/\*+/, '').trim();
      block = { body: head ? [head] : [] };
      continue;
    }
    kept.push(stripTrail(t));
  }
  flushBlock();
  return { code: kept.join('\n'), removed, title };
}

// ─────────────────────────────── vendor

function loadLock() {
  const raw = readFile(LOCK_FILE);
  let lock;
  try { lock = JSON.parse(raw); } catch (e) { fail(LOCK_FILE + ' 不是合法 JSON：' + e.message); }
  if (!lock.vendor || !lock.vendor.vueFull || !lock.vendor.vueRuntime) {
    fail(LOCK_FILE + ' 缺少 vendor.vueFull / vendor.vueRuntime 条目');
  }
  return lock;
}

/** 校验单个 vendor 文件：存在性 + sha256 + 版本号 */
function verifyOne(key, cfg) {
  const abs = path.join(ROOT, 'src/vendor/' + cfg.file);
  if (!fs.existsSync(abs)) {
    fail('vendor 缺失：' + cfg.file + '\n  请先运行：node build.js --fetch-vendor');
  }
  const buf = fs.readFileSync(abs);
  const got = sha256(buf);
  if (got !== cfg.sha256) {
    fail(
      'vendor 校验失败（' + key + ' / ' + cfg.file + '，sha256 不匹配）\n' +
      '  期望：' + cfg.sha256 + '\n  实际：' + got + '\n' +
      '  请重新运行：node build.js --fetch-vendor'
    );
  }
  if (buf.length !== cfg.bytes) fail('vendor 体积与 lock.json 不一致：' + key + ' 期望 ' + cfg.bytes + '，实际 ' + buf.length);
  const head = buf.toString('utf8', 0, 120);
  const m = head.match(/v(\d+\.\d+\.\d+)/);
  if (m && m[1] !== cfg.version) {
    fail('vendor 版本不一致：lock.json 记 ' + cfg.version + '，文件头为 ' + m[1]);
  }
  return { buf, cfg };
}

function verifyVendor(lock) {
  return {
    full: verifyOne('vueFull（构建期编译器）', lock.vendor.vueFull),
    rt: verifyOne('vueRuntime（产物内联）', lock.vendor.vueRuntime)
  };
}

async function fetchVendor() {
  const lock = fs.existsSync(path.join(ROOT, LOCK_FILE)) ? loadLock() : null;
  const specs = [
    { key: 'vueFull', file: 'vue.global.prod.js', role: '构建期模板编译器（含 compiler），不入产物', dist: 'vue.global.prod.js', cfg: lock && lock.vendor.vueFull },
    { key: 'vueRuntime', file: 'vue.runtime.global.prod.js', role: '产物内联的运行时（无模板编译器；模板由构建期编译为 render 函数）', dist: 'vue.runtime.global.prod.js', cfg: lock && lock.vendor.vueRuntime }
  ];

  const next = {
    generatedBy: 'build.js --fetch-vendor',
    frozenAt: new Date().toISOString().slice(0, 10),
    note: 'vendor 仅在构建期获取；release 产物只内联 vueRuntime（运行版），vueFull 只作为构建期模板编译器使用，不进产物。build.js 每次 release 都会校验两者的 sha256。',
    vendor: {}
  };
  const versions = [];

  for (const s of specs) {
    const urls = s.cfg ? [s.cfg.source, s.cfg.sourceAlt] : [
      'https://registry.npmmirror.com/vue/latest/files/dist/' + s.dist,
      'https://unpkg.com/vue@3/dist/' + s.dist
    ];
    let buf = null, used = null;
    for (const url of urls) {
      if (!url) continue;
      try {
        console.log('→ 下载 ' + url);
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) { console.log('  HTTP ' + res.status + '，换下一个镜像'); continue; }
        buf = Buffer.from(await res.arrayBuffer());
        used = url;
        break;
      } catch (e) { console.log('  失败：' + e.message + '，换下一个镜像'); }
    }
    if (!buf) fail('所有镜像均下载失败：' + s.file + '。请检查网络，或手动放置后编辑 lock.json。');

    const head = buf.toString('utf8', 0, 120);
    const vmMatch = head.match(/v(\d+\.\d+\.\d+)/);
    const version = vmMatch ? vmMatch[1] : 'unknown';
    versions.push({ key: s.key, version });
    const digest = sha256(buf);
    fs.mkdirSync(path.join(ROOT, 'src/vendor'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'src/vendor/' + s.file), buf);

    next.vendor[s.key] = {
      file: s.file,
      package: 'vue',
      version,
      bytes: buf.length,
      sha256: digest,
      license: 'MIT',
      role: s.role,
      source: used,
      sourceAlt: 'https://unpkg.com/vue@' + version + '/dist/' + s.dist,
      ...(s.key === 'vueRuntime' ? { devCdn: 'https://unpkg.com/vue@' + version + '/dist/vue.global.prod.js' } : {})
    };
    console.log('✓ ' + s.key + ' = ' + version + '  bytes = ' + bytes(buf.length) + '  sha256 = ' + digest.slice(0, 16) + '…');
  }

  if (versions.length === 2 && versions[0].version !== versions[1].version) {
    fail('两个 vendor 版本不一致：' + versions.map((v) => v.key + '=' + v.version).join(' / ') +
      '\n  编译器与运行时必须同版本，否则 render 函数可能与运行时 helper 不匹配。');
  }
  fs.writeFileSync(path.join(ROOT, LOCK_FILE), JSON.stringify(next, null, 2) + '\n');
  console.log('✓ lock.json 已更新');
}

// ─────────────────────────────── 构建期模板编译（Stage 1-2.1）

/**
 * 运行版 Vue 不含模板编译器，因此 `template:` 字符串必须在本阶段编译成 render 函数。
 * 做法：把完整版 Vue 加载进一个 vm 沙箱当编译器用，拦截它内部 `new Function(code)` 的
 * 生成代码 —— 因为静态提升（hoistStatic）会把常量声明在 render 函数**外层**，
 * 只取 `fn.toString()` 会丢掉 `_hoisted_*`。捕获完整生成代码后用 IIFE 包住，
 * 在产物里重新建立 `_Vue` 与提升常量的作用域。
 *
 * 组件源码（src/**）不做任何改写：本文件是构建期转换，dev 构建仍走完整版 + 运行时编译。
 */
/**
 * 浏览器版编译器用 document.createElement('div').innerHTML 来解 HTML 实体，
 * 在 Node 里需要等价物。这里实现最小垫片：只做实体解码（命名实体 + 数字实体，
 * 未知实体原样保留 —— 例如模板里的 `&&` 不受影响）。
 * 仅构建期使用，不影响产物行为。
 */
function makeCompilerDocument() {
  const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
    middot: '\u00B7', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
    copy: '\u00A9', times: '\u00D7', rarr: '\u2192', laquo: '\u00AB', raquo: '\u00BB'
  };
  const decode = (s) => String(s).replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
  const unwrap = (html, name) => {
    const m = new RegExp('^<[a-zA-Z]+ ' + name + '="([\\s\\S]*?)">$').exec(html);
    return m ? m[1] : html;
  };
  const makeEl = () => {
    const el = {
      _html: '',
      get innerHTML() { return el._html; },
      set innerHTML(v) { el._html = String(v); },
      get textContent() { return decode(el._html); },
      getAttribute(name) { return decode(unwrap(el._html, name)); },
      get children() { return [el]; }
    };
    return el;
  };
  return { createElement: () => makeEl() };
}

function makeTemplateCompiler() {
  const full = readFile('src/vendor/vue.global.prod.js');
  const rtPath = path.join(ROOT, VENDOR_RUNTIME);
  if (!fs.existsSync(rtPath)) fail('缺少运行版 vendor：' + VENDOR_RUNTIME);

  const captured = [];
  const sandbox = { console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, document: makeCompilerDocument() };
  vm.createContext(sandbox);
  const CtxFunction = vm.runInContext('Function', sandbox);
  const note = (args) => {
    const body = args[args.length - 1];
    if (typeof body === 'string' && body.indexOf('function render') !== -1) captured.push(body);
  };
  sandbox.Function = new Proxy(CtxFunction, {
    construct(t, a) { note(a); return Reflect.construct(t, a); },
    apply(t, th, a) { note(a); return Reflect.apply(t, th, a); }
  });
  vm.runInContext(full, sandbox, { filename: 'vue.global.prod.js (compile-time)' });
  const Vue = sandbox.Vue;
  if (!Vue || typeof Vue.compile !== 'function') fail('构建期编译器不可用：完整版 Vue 未导出 compile');

  const rtSandbox = { console: sandbox.console };
  vm.createContext(rtSandbox);
  vm.runInContext(fs.readFileSync(rtPath, 'utf8'), rtSandbox, { filename: 'vue.runtime.global.prod.js (helper check)' });
  const VueRt = rtSandbox.Vue;
  if (!VueRt) fail('运行版 Vue 未能加载');

  return {
    runtimeVersion: VueRt.version || '?',
    helperMissing: [],
    /** 编译一个模板，返回：完整生成代码 + 用到的 helper 是否都在运行版中存在 */
    compile(tpl, blame) {
      captured.length = 0;
      try {
        Vue.compile(tpl);
      } catch (e) {
        fail(blame + ' 模板编译失败：' + e.message);
      }
      if (!captured.length) fail(blame + ' 模板编译未捕获生成代码（编译器行为可能已变化）');
      const gen = captured[captured.length - 1];
      const re = /const\s*\{([^}]+)\}\s*=\s*_Vue/g;
      let m;
      const used = [];
      while ((m = re.exec(gen))) {
        m[1].split(',').forEach((p) => {
          const name = p.split(':')[0].trim();
          if (!name) return;
          used.push(name);
          if (typeof VueRt[name] === 'undefined') this.helperMissing.push(blame + ' → ' + name);
        });
      }
      return { code: gen, helpers: used };
    }
  };
}

/**
 * 把某个源文件里的 `template:` 换成对编译产物的引用。
 *
 * 为什么不是内联 `render: (function(){ ... })()`：
 * 编译器生成的 render 函数使用 `with (_ctx)`，而本项目的源文件都是 `'use strict'`
 * 的 IIFE —— 严格模式里 `with` 是语法错误。Vue 官方靠 `new Function`（创建出来的是
 * 非严格函数）绕开。这里不用 eval：把编译产物放进**非严格脚本顶层的工厂函数**里
 * （见 makeRenderFactories），源文件只留一个引用，既不 eval 也不做字符串转义。
 *
 * 工厂函数的严格性由它**定义处**决定，与调用处无关，因此从严格 IIFE 里调用是安全的。
 */
function compileTemplatesIn(rel, code, compiler, stats) {
  const TPL_ARR = /template:\s*(\[[\s\S]*?\]\.join\('\\n'\))/;
  const TPL_STR = /template:\s*('(?:[^'\\]|\\.)*')/g;
  const key = rel.replace(/^src\/ui\//, '').replace(/\.js$/, '');

  const toRender = (exprText) => {
    let tpl;
    try {
      tpl = vm.runInNewContext(exprText, {});
    } catch (e) {
      fail(rel + ' 的模板表达式无法求值：' + e.message);
    }
    if (typeof tpl !== 'string') fail(rel + ' 的模板不是字符串');
    const r = compiler.compile(tpl, rel);
    stats.templates++;
    stats.renderBytes += r.code.length;
    stats.helpers += r.helpers.length;
    stats.renders[key] = r.code;
    return "render: __TAVERN_RENDERS__['" + key + "']()";
  };

  const before = code;
  const arr = code.match(TPL_ARR);
  if (arr) code = code.replace(arr[0], toRender(arr[1]));
  code = code.replace(TPL_STR, (mm, expr) => toRender(expr));

  if (code === before) stats.noTemplate.push(rel);
  return code;
}

/**
 * render 工厂块：放在 vendor 脚本元素内（该处是**非严格**脚本顶层），
 * 使 `with (_ctx)` 合法。factory 体在被调用时才解析 `Vue`，此时 vendor 已就绪。
 */
function makeRenderFactories(renders) {
  const keys = Object.keys(renders);
  if (!keys.length) return '';
  const parts = [
    '\n/* ──────────────────────────────── 构建期编译的 render 函数 ───────────────',
    '   来源：src/ui/** 里的 template 字符串，构建时由完整版 Vue 编译。',
    '   机器生成，请勿手改；改模板请改 src/ 后重新构建。',
    '   放在这里是因为编译器产物含 `with (_ctx)`，而应用层脚本是严格模式。',
    '   ─────────────────────────────────────────────────────────────────── */',
    'var __TAVERN_RENDERS__ = {};'
  ];
  for (const k of keys) {
    parts.push("__TAVERN_RENDERS__['" + k + "'] = function () {");
    parts.push(renders[k]);
    parts.push('};');
  }
  return parts.join('\n') + '\n';
}

// ─────────────────────────────── 扫描

function scanExternal(html) {
  const violations = [];
  for (const { re, why } of FORBIDDEN) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      const line = html.slice(0, m.index).split('\n').length;
      violations.push({ why, text: m[0], line });
    }
  }
  // 仅报告：其余 http(s) 出现位置（应只存在于注释、许可证与 data URI 的 xmlns 中）
  const mentions = [];
  const mentionRe = /https?:\/\/[^\s"')<>]+/g;
  let mm;
  while ((mm = mentionRe.exec(html)) !== null) {
    const line = html.slice(0, mm.index).split('\n').length;
    const ctx = html.slice(Math.max(0, mm.index - 40), mm.index);
    mentions.push({ url: mm[0], line, inDataUri: /data:[^"')]*$/.test(ctx) });
  }
  return { violations, mentions };
}

// ─────────────────────────────── 构建

function build(mode) {
  const isRelease = mode !== 'dev';
  const lock = loadLock();

  // 1. vendor
  let vendorChunk, compiler = null, rtCfg = null;
  if (isRelease) {
    const v = verifyVendor(lock);
    rtCfg = v.rt.cfg;
    guardChunk('vue.runtime.global.prod.js', v.rt.buf.toString('utf8'), 'js');
    vendorChunk =
      '\n/* ──────────────────────────────── vendor: vue runtime-only ' + rtCfg.version +
      ' (MIT, sha256 ' + rtCfg.sha256.slice(0, 12) + '…) 构建期内联，运行时不请求网络\n' +
      '   本产物内联的是运行版（无模板编译器）；UI 模板已在构建期编译为 render 函数。\n' +
      '   dev 构建使用完整版 + 运行时编译，行为一致。 ──────── */\n' + v.rt.buf.toString('utf8') + '\n';
    compiler = makeTemplateCompiler();
  } else {
    const url = lock.vendor.vueRuntime.devCdn;
    vendorChunk =
      '\n/* ⚠ DEV 构建：vendor 来自 CDN，产物不可交付 */\n' +
      '/* eslint-disable */\n';
    vendorChunk += '__DEV_CDN__' + url + '__DEV_CDN__';
  }

  // 2. 收集分块（release 下 UI 层的模板在本步编译为 render）
  const parts = { css: [], js: [] };
  const report = [];
  const tplStats = { templates: 0, renderBytes: 0, helpers: 0, noTemplate: [], transformed: [], renders: {} };
  const squeezeStats = { removed: 0, bytes: 0 };
  const index = { css: [], js: [] };   // 各文件顶部标题 → 汇成一行索引（见 squeeze 注释）
  for (const rel of CSS_ORDER) {
    const c = readFile(rel);
    guardChunk(rel, c, 'css');
    const sq = isRelease ? squeeze(c) : { code: c, removed: 0, title: null };
    if (sq.title) index.css.push(sq.title);
    squeezeStats.removed += sq.removed;
    squeezeStats.bytes += Buffer.byteLength(c) - Buffer.byteLength(sq.code);
    parts.css.push(sq.code);
    report.push({ rel, n: Buffer.byteLength(c), built: Buffer.byteLength(sq.code) });
  }
  for (const rel of JS_ORDER) {
    let c = readFile(rel);
    const srcBytes = Buffer.byteLength(c);
    if (compiler && rel.indexOf('src/ui/') === 0) {
      c = compileTemplatesIn(rel, c, compiler, tplStats);
      tplStats.transformed.push(rel);
    }
    guardChunk(rel, c, 'js');
    const sq = isRelease ? squeeze(c) : { code: c, removed: 0, title: null };
    if (sq.title) index.js.push(sq.title);
    squeezeStats.removed += sq.removed;
    squeezeStats.bytes += Buffer.byteLength(c) - Buffer.byteLength(sq.code);
    parts.js.push(sq.code);
    report.push({ rel, n: srcBytes, built: Buffer.byteLength(sq.code) });
  }
  if (compiler && compiler.helperMissing.length) {
    fail('编译产物用到了运行版 Vue 中不存在的 helper：\n  ' + compiler.helperMissing.join('\n  ') +
      '\n  说明编译器与运行时版本不匹配，产物会在渲染时崩溃。');
  }
  // render 工厂与 vendor 同处一个脚本元素（非严格顶层），见 makeRenderFactories 注释
  if (compiler) {
    const factoriesRaw = makeRenderFactories(tplStats.renders);
    const fq = isRelease ? squeeze(factoriesRaw) : { code: factoriesRaw, removed: 0, title: null };
    squeezeStats.removed += fq.removed;
    squeezeStats.bytes += Buffer.byteLength(factoriesRaw) - Buffer.byteLength(fq.code);
    guardChunk('构建期 render 工厂', fq.code, 'js');
    // 该块由本构建生成（不属于任何 src 文件）：标题不进索引，仍留在原位说明来源
    vendorChunk += (fq.title ? '\n/* ' + fq.title + ' */\n' : '') + fq.code;
  }
  /* 索引行：把各文件顶部标题集中成一行（DR-008 方案 A），文件名仍可在产物里检索到。
     这不是删除而是搬家：标题正文属于文件定位信息，说明性正文仍在其原位或源码里。 */
  const idxLine = (label, names) => (names.length ? '/* ' + label + names.join(' ') + ' */\n' : '');
  const cssChunk = '\n' + idxLine('样式索引：', index.css) + parts.css.join('\n') + '\n';
  const jsChunk = '\n' + idxLine('脚本索引：', index.js) + parts.js.join('\n') + '\n';

  // 3. 模板与标记
  let html = readFile(TEMPLATE);
  for (const name of MARKERS) {
    const marker = '/*INJECT:' + name + '*/';
    const hits = html.split(marker).length - 1;
    if (hits !== 1) fail(TEMPLATE + ' 中标记 ' + marker + ' 出现 ' + hits + ' 次，应为 1 次');
  }

  // 4. 构建元信息（体积字段先留 0，注入完成后回填 —— 元信息本身也在产物里，
  //    必须先知道最终体积才能写准确，所以走两遍：注入 → 量 → 回填 → 再量）
  const srcHash = sha256(Buffer.from(vendorChunk + cssChunk + jsChunk + html));
  const builtAt = new Date().toISOString();
  const allowOver = process.argv.includes('--allow-over-budget');

  const meta =
    'window.__TAVERN_BUILD__ = Object.freeze(' +
    JSON.stringify({
      mode, hash: srcHash.slice(0, 8), hashFull: srcHash, builtAt, spec: SPEC_VERSIONS,
      budget: { raw: BUDGET.raw, gzip: BUDGET.gzip, actualRaw: 0, actualGzip: 0, over: false, overridden: false }
    }) +
    ');';

  // 5. 架构注释块（Stage 3-4a Step 2 压缩版）：只保留四类核心信息 —— 内部分层、职责边界、
  // 冻结契约版本、单文件不依赖外部静态资源；完整说明见 docs/stage-0-architecture.md。
  const arch = [
    '',
    '<!--',
    '  AI Tavern Pro · 单文件产物（勿手改；源码 src/，构建 node build.js）  ' +
      srcHash.slice(0, 8) + ' · ' + builtAt + ' · ' + mode,
    '  分层（依赖严格单向）：data ← core ← ui ← boot；core 不依赖 ui；引擎只经 TraceBus/Store 出岛',
    '  职责边界：Cognition 意图与策略 · MemoryService 检索 · PersonaService prompt 装配 ·',
    '  ToolRegistry 工具选择与执行 · Provider 只做模型通信 · CardRenderer 只读渲染（事件协议冻结）',
    '  契约版本：' + Object.values(SPEC_VERSIONS).join(' · '),
    '  本产物不含任何外部资源引用（无 CDN、无字体下载、无图片文件）。',
    '-->',
    '',
  ].join('\n');

  html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>' + arch);
  html = html.replace('/*INJECT:BUILD_META*/', meta);
  html = html.replace('/*INJECT:VENDOR*/', vendorChunk);
  html = html.replace('/*INJECT:STYLES*/', cssChunk);
  html = html.replace('/*INJECT:APP*/', jsChunk);

  if (mode === 'dev') {
    html = html.replace(/__DEV_CDN__([^_]+)__DEV_CDN__/, '<script src="$1"></script>');
  }

  // 6. 体积回填与实测（F1）：数字写进产物会改变产物大小、gzip 也随之变，
  //    单遍回填会让 meta 自述比磁盘实测小几字节。这里迭代到**不动点**：
  //    actualRaw / actualGzip / over / overridden 都是动态字段，必须一起收敛，
  //    否则回填后仍会漂 1 字节。收敛后 meta 与磁盘逐字节一致。
  let total = 0, gz = 0, converged = false;
  for (let i = 0; i < 8 && !converged; i++) {
    const overNow = total > BUDGET.raw || gz > BUDGET.gzip;
    html = html.replace(
      /"actualRaw":\d+,"actualGzip":\d+,"over":(?:true|false),"overridden":(?:true|false)/,
      '"actualRaw":' + total + ',"actualGzip":' + gz + ',"over":' + overNow + ',"overridden":' + (overNow && isRelease)
    );
    const t = Buffer.byteLength(html);
    const g = zlib.gzipSync(Buffer.from(html)).length;
    converged = (t === total && g === gz);
    total = t;
    gz = g;
  }
  if (!converged) fail('体积回填未收敛（meta 与磁盘无法保证一致）——这是构建器缺陷，请报告。');
  const overBudget = total > BUDGET.raw || gz > BUDGET.gzip;

  // 7. 扫描
  const { violations, mentions } = scanExternal(html);

  console.log('\n═══ AI Tavern Pro · build (' + mode + ') ═══\n');
  console.log('分块：');
  for (const r of report) {
    const builtNote = (r.built != null && r.built !== r.n)
      ? '  源码 ' + r.n + ' B → 编译后 ' + r.built + ' B'
      : '  (' + r.n + ' B)';
    console.log('  ' + pad(r.rel, 34) + pad(bytes(r.built != null ? r.built : r.n), 10) + builtNote);
  }
  console.log('  ' + pad('vendor: vue runtime-only', 34) + pad(bytes(Buffer.byteLength(vendorChunk)), 10) +
    (rtCfg ? '  (' + rtCfg.version + '，替代完整版可省 ' + bytes(lock.vendor.vueFull.bytes - rtCfg.bytes) + ')' : ''));
  console.log('  ' + pad('src/index.html (模板)', 34) + pad(bytes(Buffer.byteLength(readFile(TEMPLATE))), 10));
  if (isRelease) {
    console.log('\n构建期压缩（仅整行注释与空行，不动代码）：');
    console.log('  移除 ' + squeezeStats.removed + ' 行，原始体积减少 ' + bytes(squeezeStats.bytes) + '（源码不受影响）');
  }
  if (compiler) {
    console.log('\n构建期模板编译：');
    console.log('  ' + tplStats.templates + ' 个模板 → render 函数，共 ' + bytes(tplStats.renderBytes) +
      '（引用 runtime helper ' + tplStats.helpers + ' 处，已全部校验存在于运行版）');
    console.log('  未含模板的文件：' + (tplStats.noTemplate.length ? tplStats.noTemplate.join(', ') : '无'));
  }
  console.log('\n产物：');
  console.log('  ' + OUT);
  // 预算数字一律取自 BUDGET，禁止在报告里硬编码（否则改了预算报告会说谎）
  console.log('  未压缩  ' + bytes(total) + '  (' + total + ' B)   预算 ' + bytes(BUDGET.raw) +
    '  余量 ' + bytes(BUDGET.raw - total) + '  ' + (total <= BUDGET.raw ? '✅' : '❌ 超出'));
  console.log('  gzip    ' + bytes(gz) + '   预算 ' + bytes(BUDGET.gzip) +
    '  余量 ' + bytes(BUDGET.gzip - gz) + '  ' + (gz <= BUDGET.gzip ? '✅' : '❌ 超出'));
  console.log('  hash    ' + srcHash.slice(0, 8));
  if (overBudget) {
    console.log('');
    console.log('  ⚠ 体积超出冻结预算（stage-0 R4 / stage-1-plan §3）');
    console.log('    超限：raw ' + (total - BUDGET.raw > 0 ? '+' + bytes(total - BUDGET.raw) : '0') +
      '   gzip ' + (gz - BUDGET.gzip > 0 ? '+' + bytes(gz - BUDGET.gzip) : '0'));
    console.log('    这是契约层面的偏差，需要修订预算或减小体积，不得静默放行。');
  }

  console.log('\n外部引用扫描：');
  if (violations.length === 0) {
    console.log('  ✅ 未发现外部资源引用（<link>/<script src>/<img>/@import/url(http…) 均为 0）');
  } else {
    for (const v of violations) console.log('  ❌ 第 ' + v.line + ' 行：' + v.why + ' → ' + v.text);
  }
  if (mentions.length) {
    console.log('  ℹ 其他 http(s) 字面量 ' + mentions.length + ' 处（仅注释/许可证/data URI 命名空间，非请求）：');
    const shown = mentions.slice(0, 6);
    for (const m of shown) {
      console.log('     第 ' + m.line + ' 行  ' + (m.inDataUri ? '[data URI 内] ' : '') + m.url.slice(0, 78));
    }
    if (mentions.length > shown.length) console.log('     其余 ' + (mentions.length - shown.length) + ' 处略');
  } else {
    console.log('  ℹ 其他 http(s) 字面量 0 处');
  }

  console.log('\n规范一致性：禁止字面量 </script> 与 </style> 检查 —— ✅ 通过');

  // 产物必须能被解析：把每个内联 <script> 的内容交给 vm.Script **只解析不执行**。
  // 这道检查专防"注释/转义把整块脚本吞掉"这类灾难（源码单文件 --check 通过、产物却是坏的）。
  const inlineScripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]);
  inlineScripts.forEach((src, i) => {
    try {
      new vm.Script(src, { filename: 'inline-script-' + (i + 1) + '.js' });
    } catch (e) {
      fail('内联脚本 #' + (i + 1) + ' 无法解析，产物在浏览器里会整体失效：' + e.message);
    }
  });
  console.log('产物可解析性：' + inlineScripts.length + ' 个内联脚本全部通过 ✅\n');

  // 8. 门禁先于落盘（F2），再以「临时文件 + 原子替换」写出。
  //    先前的顺序是先写后判：超限/含外链的产物会留在交付路径上（实际误导过一次交付判断）。
  //    现在被拒绝的构建不写任何交付文件；dist/ 要么是旧的有效产物，要么是新产物，不存在半成品。
  const target = isRelease ? OUT : OUT.replace(/\.html$/, '.dev.html');
  const outPath = path.join(ROOT, target);
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });

  if (overBudget && isRelease && !allowOver) {
    fail('体积超出冻结预算，release 构建被拒绝（未写出任何交付文件）。\n' +
      '  这是设计决策，不是临时错误：请修订预算（stage-0 R4 / stage-1-plan §3）或减小体积。\n' +
      '  确需在偏差状态下产出（例如为了跑验收），显式加 --allow-over-budget，产物会在 build 元信息里标明 overridden。');
  }
  if (violations.length > 0 && isRelease) {
    fail('产物包含 ' + violations.length + ' 处外部资源引用，release 构建被拒绝（未写出任何交付文件）。');
  }

  const tmpPath = outPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpPath, html);
  fs.renameSync(tmpPath, outPath);

  if (violations.length > 0) {
    console.log('✓ 已写出 ' + target + '（DEV 构建含外部引用，仅供本地迭代，禁止交付）\n');
    return;
  }
  console.log('✓ 已写出 ' + target + '\n');
}

// ─────────────────────────────── 入口

const args = process.argv.slice(2);
const KNOWN_FLAGS = ['--release', '--dev', '--fetch-vendor', '--allow-over-budget'];
const unknown = args.filter((a) => KNOWN_FLAGS.indexOf(a) === -1);
if (unknown.length) {
  console.log('未知参数：' + unknown.join(' '));
  console.log('用法：node build.js [--release | --dev | --fetch-vendor] [--allow-over-budget]');
  process.exit(1);
}
if (args.includes('--fetch-vendor')) {
  fetchVendor().catch((e) => fail(e.stack || String(e)));
} else if (args.includes('--dev')) {
  build('dev');
} else if (args.includes('--release') || args.length === 0 || args.includes('--allow-over-budget')) {
  build('release');
}
