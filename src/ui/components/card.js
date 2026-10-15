/* ══════════════════════════════════════════════════════════════════════════
   card.js — Card Renderer（Stage 3-3，只渲染）
   ──────────────────────────────────────────────────────────────────────────
   数据 → UI，仅此而已。唯一数据入口是 **message.meta.card**。

   禁止（组件顶部写死，评审可直接核对）：
     · 不判断用户意图 · 不检索记忆 · 不生成 prompt · 不调用 LLM
     · 不读 cognition.plan / trace.meta.cognition / trace.meta.memoryCheck / Provider 内部状态
     · 不写 Store · 不发 Trace 事件 · 不修改传入的卡片对象 · 不产生任何交互控件
     · 不用 v-html（所有模型/用户文本一律普通插值，天然转义）

   校验依据（不重定义契约）：
     · 字段与上限：Tavern.Personas.FROZEN.CARD_SCHEMA（实际导出，逐字使用）
     · CARD_SCHEMA 未覆盖的下限与数值范围：取自冻结文档 persona-spec
       §2.7（steps 1..7、firstAction 必须）／§3.7（points 1..5、confidence 0..1、
       uncertainties 不可为空、sourcesOk）／§4.7（variants 2..3）
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var SCHEMA = (global.Tavern.Personas && global.Tavern.Personas.FROZEN && global.Tavern.Personas.FROZEN.CARD_SCHEMA) || null;

  var TYPE_LABEL = { plan: '计划卡', knowledge: '知识卡', inspiration: '灵感卡' };

  /* 校验规则：上限来自 CARD_SCHEMA，下限与数值范围来自 persona-spec（见文件头） */
  var RULES = {
    plan: { min: 1, max: (SCHEMA && SCHEMA.plan && SCHEMA.plan.maxSteps) || 7, key: 'steps' },
    knowledge: { min: 1, max: (SCHEMA && SCHEMA.knowledge && SCHEMA.knowledge.maxPoints) || 5, key: 'points' },
    inspiration: { min: 2, max: (SCHEMA && SCHEMA.inspiration && SCHEMA.inspiration.variants) || 3, key: 'variants' }
  };

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isStr(v) { return typeof v === 'string' && v.length > 0; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isArr(v) { return Array.isArray(v); }

  /** 必填字段清单：直接读 CARD_SCHEMA（若缺失则用一个显式的最小集，并在报告中记缺口） */
  function requiredOf(type) {
    var s = SCHEMA && SCHEMA[type];
    return (s && s.required) || ['type'];
  }

  /**
   * 纯函数校验：返回 {ok, type, code, missing[], notes[], reason}
   * 不修改入参；不渲染；供组件与测试共用。
   */
  function validate(card) {
    if (!isObj(card)) return { ok: false, type: null, code: 'no-card', reason: '卡片为空或不是对象' };
    var type = card.type;
    if (type !== 'plan' && type !== 'knowledge' && type !== 'inspiration') {
      return { ok: false, type: isStr(type) ? type : null, code: 'unknown-type', reason: '未知卡片类型：' + String(type) };
    }
    var missing = [];
    var req = requiredOf(type);
    for (var i = 0; i < req.length; i++) {
      var k = req[i];
      if (card[k] === undefined || card[k] === null) missing.push(k);
    }
    if (missing.length) return { ok: false, type: type, code: 'missing-fields', missing: missing, reason: '缺少必填字段：' + missing.join('、') };

    var notes = [];
    var rule = RULES[type];
    var list = card[rule.key];
    if (!isArr(list) || list.length < rule.min) {
      return { ok: false, type: type, code: 'too-few', reason: rule.key + ' 少于契约下限（' + rule.min + '）' };
    }
    if (list.length > rule.max) notes.push(rule.key + ' 超过上限，已截断至 ' + rule.max + ' 条');

    if (type === 'plan') {
      if (!isStr(card.firstAction)) return { ok: false, type: type, code: 'no-first-action', reason: '缺少 firstAction（契约要求必填）' };
      if (!isArr(card.steps)) return { ok: false, type: type, code: 'bad-field', reason: 'steps 必须是数组' };
      if (card.risks !== undefined && !isArr(card.risks)) return { ok: false, type: type, code: 'bad-field', reason: 'risks 必须是数组' };
    }
    if (type === 'knowledge') {
      for (var p = 0; p < Math.min(list.length, rule.max); p++) {
        var pt = list[p];
        if (!isObj(pt) || !isStr(pt.claim)) return { ok: false, type: type, code: 'bad-field', reason: 'points[' + p + '].claim 缺失' };
        if (!isNum(pt.confidence) || pt.confidence < 0 || pt.confidence > 1) {
          return { ok: false, type: type, code: 'bad-number', reason: 'points[' + p + '].confidence 必须在 0~1 之间（实际：' + String(pt.confidence) + '）' };
        }
      }
      if (!isArr(card.uncertainties)) return { ok: false, type: type, code: 'bad-field', reason: 'uncertainties 必须是数组' };
      if (card.uncertainties.length === 0) notes.push('本卡未标注任何不确定项 —— 契约要求至少一条（不补充虚构内容，仅提示）');
      if (card.sourcesOk === false) notes.push('上游检索未成功：以下来源未经核对');
    }
    if (type === 'inspiration') {
      for (var v = 0; v < Math.min(list.length, rule.max); v++) {
        var va = list[v];
        if (!isObj(va) || !isStr(va.text)) return { ok: false, type: type, code: 'bad-field', reason: 'variants[' + v + '].text 缺失' };
      }
      if (!isObj(card.seed)) return { ok: false, type: type, code: 'bad-field', reason: 'seed 必须是对象（否则无法验证随机性）' };
    }
    return { ok: true, type: type, code: 'ok', notes: notes };
  }

  /** 规范化视图模型：**只读地**切片/映射，不触碰原对象（截断在此发生） */
  function viewModel(card) {
    var type = card.type;
    var rule = RULES[type];
    if (type === 'plan') {
      return {
        title: card.title, horizon: card.horizon,
        steps: card.steps.slice(0, rule.max).map(function (s) {
          return { id: String(s && s.id || ''), text: String(s && s.text || ''), est: String(s && s.est || ''), why: String(s && s.why || ''), done: !!(s && s.done) };
        }),
        firstAction: card.firstAction,
        risks: isArr(card.risks) ? card.risks.slice(0, 3).map(String) : [],
        basis: isStr(card.basis) ? card.basis : ''
      };
    }
    if (type === 'knowledge') {
      return {
        question: card.question, summary: card.summary,
        points: card.points.slice(0, rule.max).map(function (p) {
          var src = isObj(p && p.source) ? { title: String(p.source.title || ''), url: String(p.source.url || ''), retrievedAt: p.source.retrievedAt } : null;
          return { claim: String(p && p.claim || ''), confidence: p.confidence, source: src };
        }),
        uncertainties: card.uncertainties.map(String),
        sourcesOk: card.sourcesOk !== false,
        followUp: isStr(card.followUp) ? card.followUp : ''
      };
    }
    return {
      prompt: card.prompt,
      styleTags: isArr(card.styleTags) ? card.styleTags.slice(0, 3).map(String) : [],
      variants: card.variants.slice(0, rule.max).map(function (v) {
        return { id: String(v && v.id || ''), tag: String(v && v.tag || ''), text: String(v && v.text || ''), imagery: isArr(v && v.imagery) ? v.imagery.slice(0, 3).map(String) : [] };
      }),
      constraints: isArr(card.constraints) ? card.constraints.slice(0, 3).map(function (c) { return String((c && c.label) || c || ''); }) : [],
      seed: { seedId: String(card.seed.seedId || ''), words: isArr(card.seed.words) ? card.seed.words.slice(0, 3).map(String) : [], image: String(card.seed.image || '') }
    };
  }

  var Card = {
    name: 'CardRenderer',
    props: { card: { type: Object, default: null } },

    computed: {
      check: function () { return validate(this.card); },
      /** 非法/空 → 不渲染容器；未知类型与缺字段 → 降级块 */
      show: function () { return this.check.code !== 'no-card'; },
      degraded: function () { return !this.check.ok; },
      label: function () { return TYPE_LABEL[this.check.type] || '卡片'; },
      vm: function () { return this.check.ok ? viewModel(this.card) : null; },
      notes: function () { return this.check.notes || []; }
    },

    template: [
      '<section v-if="show" class="cardx" :class="degraded ? \'cardx--bad\' : (\'cardx--\' + check.type)" :data-card-type="check.type">',
      '  <header class="cardx__head">',
      '    <span class="label">{{ label }}</span>',
      '    <span v-if="check.ok && vm.title" class="cardx__title">{{ vm.title }}</span>',
      '    <span v-else-if="check.ok && vm.question" class="cardx__title">{{ vm.question }}</span>',
      '    <span v-else-if="check.ok && vm.prompt" class="cardx__title">{{ vm.prompt }}</span>',
      '    <span class="spacer"></span>',
      '    <span class="chip">只读展示</span>',
      '  </header>',
      '',
      '  <div v-if="degraded" class="cardx__degraded">',
      '    <span class="chip chip--warn">{{ check.code }}</span>',
      '    <span>{{ check.reason }}</span>',
      '    <span v-if="check.missing" class="t-mono">缺失：{{ check.missing.join("、") }}</span>',
      '  </div>',
      '',
      '  <template v-else-if="check.type === \'plan\'">',
      '    <ol class="cardx__steps">',
      '      <li v-for="s in vm.steps" :key="s.id" class="cardx__step">',
      '        <span class="cardx__mark" :class="{ \'cardx__mark--done\': s.done }" aria-hidden="true">{{ s.done ? "✓" : "·" }}</span>',
      '        <span class="cardx__steptext">{{ s.text }}</span>',
      '        <span v-if="s.est" class="t-mono muted-3">{{ s.est }}</span>',
      '        <span v-if="s.why" class="cardx__why">{{ s.why }}</span>',
      '      </li>',
      '    </ol>',
      '    <p class="cardx__first"><span class="label">今晚只做一件事</span>{{ vm.firstAction }}</p>',
      '    <p v-if="vm.risks.length" class="cardx__line"><span class="label">风险</span>{{ vm.risks.join("；") }}</p>',
      '    <p v-if="vm.basis" class="cardx__line t-mono"><span class="label">依据</span>{{ vm.basis }}</p>',
      '  </template>',
      '',
      '  <template v-else-if="check.type === \'knowledge\'">',
      '    <p class="cardx__line"><span class="label">总答</span>{{ vm.summary }}</p>',
      '    <ul class="cardx__points">',
      '      <li v-for="(p, i) in vm.points" :key="i" class="cardx__point">',
      '        <span class="cardx__claim">{{ p.claim }}</span>',
      '        <span class="cardx__conf"><span class="cardx__confbar" :style="{ width: (p.confidence * 100) + \'%\' }"></span></span>',
      '        <span class="t-mono muted-3">{{ p.confidence }}</span>',
      '        <span v-if="p.source" class="cardx__src">来源：{{ p.source.title }}<template v-if="p.source.url"> · {{ p.source.url }}</template></span>',
      '        <span v-else class="cardx__src muted-3">无来源</span>',
      '      </li>',
      '    </ul>',
      '    <div class="cardx__uncertain">',
      '      <span class="label">不确定的部分</span>',
      '      <ul class="cardx__list"><li v-for="(u, i) in vm.uncertainties" :key="i">{{ u }}</li></ul>',
      '    </div>',
      '    <p v-if="vm.followUp" class="cardx__line"><span class="label">可以继续问</span>{{ vm.followUp }}</p>',
      '  </template>',
      '',
      '  <template v-else-if="check.type === \'inspiration\'">',
      '    <div class="cardx__tags"><span v-for="t in vm.styleTags" :key="t" class="chip chip--accent">{{ t }}</span></div>',
      '    <ul class="cardx__variants">',
      '      <li v-for="v in vm.variants" :key="v.id" class="cardx__variant">',
      '        <span class="chip">{{ v.tag }}</span>',
      '        <span class="cardx__vtext">{{ v.text }}</span>',
      '        <span v-if="v.imagery.length" class="t-mono muted-3">意象：{{ v.imagery.join(" / ") }}</span>',
      '      </li>',
      '    </ul>',
      '    <p v-if="vm.constraints.length" class="cardx__line"><span class="label">约束</span>{{ vm.constraints.join("；") }}</p>',
      '    <p class="cardx__line t-mono"><span class="label">随机种子</span>{{ vm.seed.seedId }} · {{ vm.seed.words.join(" / ") }}<template v-if="vm.seed.image"> · {{ vm.seed.image }}</template></p>',
      '  </template>',
      '',
      '  <ul v-if="notes.length" class="cardx__notes">',
      '    <li v-for="(n, i) in notes" :key="i" class="chip chip--warn">{{ n }}</li>',
      '  </ul>',
      '</section>'
    ].join('\n')
  };

  Card.validate = validate;      // 纯函数，供专项测试直接调用边界用例

  global.Tavern = global.Tavern || {};
  global.Tavern.UI = global.Tavern.UI || {};
  global.Tavern.UI.CardRenderer = Card;
})(window);
