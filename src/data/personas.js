/* ══════════════════════════════════════════════════════════════════════════
   personas.js — persona-spec.md (p1.0) 的可执行形态
   ──────────────────────────────────────────────────────────────────────────
   本文件只含「文案 + 冻结参数」，不含任何 Agent 逻辑（无 prompt 组装、无检索、
   无工具执行）。Stage 3 的 PersonaService / MemoryService 消费本文件的常量，
   因此这里出现的每个数值都必须与 persona-spec.md 逐字一致；改契约 → 改文档 →
   再改本文件。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var SPEC_VERSION = 'p1.0';

  /* ── 冻结枚举与阈值（persona-spec §1.4 / §1.5 / §1.6 / §1.8） ─────── */

  var MOODS = ['neutral', 'warm', 'amused', 'thoughtful', 'concerned', 'tired', 'energized'];

  var ENERGY_RULES = {
    quickTurn: -3,
    deepTurn: -8,
    toolNetworkCall: -1,
    regenPerMinutes: 6,   // +1 / 6 分钟
    cap: 100,
    tiredBelow: 20
  };

  var RETRIEVAL = {
    threshold: 0.35,      // 可检索门槛
    topK: 5,
    pinnedGoalMinStrength: 0.5,
    reinforceOnHit: 0.03,
    hitCap: 1.0
  };

  var QUOTA = { bartender: 45, oracle: 40, muse: 25, totalCap: 120 };
  var LIMITS = { messagesPerAgent: 80, compactOldest: 40, replyMaxParagraphs: 6, replyMaxChars: 400 };
  var AFFINITY_STAGES = [
    { min: 0, max: 19, stage: '陌生', address: '您 / 客人' },
    { min: 20, max: 49, stage: '熟客', address: '你' },
    { min: 50, max: 79, stage: '常客', address: '你 / 昵称' },
    { min: 80, max: 100, stage: '老友', address: '昵称' }
  ];

  /* 剧情关系阶段（Stage 6-1）：只服务「展示 + Prompt 措辞」；
     AFFINITY_STAGES（上表，冻结）继续负责称呼/address 派生，两者互不干扰。 */
  var RELATIONSHIP_STAGES = [
    { min: 0, max: 19, stage: '陌生' },
    { min: 20, max: 39, stage: '熟悉' },
    { min: 40, max: 59, stage: '朋友' },
    { min: 60, max: 79, stage: '亲密' },
    { min: 80, max: 100, stage: '羁绊' }
  ];
  function relationshipStage(affinity) {
    var v = typeof affinity === 'number' ? affinity : 0;
    for (var i = 0; i < RELATIONSHIP_STAGES.length; i++) {
      if (v >= RELATIONSHIP_STAGES[i].min && v <= RELATIONSHIP_STAGES[i].max) return RELATIONSHIP_STAGES[i].stage;
    }
    return RELATIONSHIP_STAGES[0].stage;
  }
  /* 信任档（Stage 6-1）：0-29 低 / 30-69 普通 / 70-100 较高 —— 三个消费者共用一处定义 */
  function trustLabel(trust) {
    var v = typeof trust === 'number' ? trust : 0;
    return v >= 70 ? '较高' : (v >= 30 ? '普通' : '低');
  }
  var UNIVERSAL_FORBIDDEN = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10'];

  /* ── 三个 Agent（persona-spec §2 / §3 / §4） ──────────────────────── */

  var AGENTS = [
    {
      id: 'bartender',
      name: '烬',
      code: 'EMBER',
      accentVar: 'ember',
      glyph: '—',
      title: '规划型 · 会先替你算一遍再开口',
      archetype: '酒保 × 参谋',
      desc: '先问清一件事，再给一个可以反驳的判断。宁可给你一个你不同意的明确建议，也不给你一堆没用的选项。',
      signatureLines: ['先擦根火柴。', '我给你的不是答案，是一个可以反驳的判断。', '牌已经翻开了，剩下的是你的。'],
      capabilities: ['Reasoning', 'Planning', 'Decision Making'],
      tools: ['dice', 'clock', 'task_break'],
      cardType: 'plan',
      forbidden: ['B1', 'B2', 'B3', 'B4', 'B5'],
      memory: { w: [0.35, 0.20, 0.30, 0.15], lambda: 0.010, quota: 45, prefers: 'goal > preference > event' },
      portrait: 'flame'
    },
    {
      id: 'oracle',
      name: '棱镜',
      code: 'PRISM',
      accentVar: 'prism',
      glyph: '~',
      title: '知识型 · 把一件事折成光谱给你看',
      archetype: '占星者 × 档案管理员',
      desc: '先给出确信度，再给出内容。她习惯区分「我确定 / 我推测 / 我不知道」——不知道比说错更体面。',
      signatureLines: ['先说我能确定的那一半。', '这一条我只有七分把握，标给你。', '剩下的不在我手上，在灯照不到的地方。'],
      capabilities: ['Knowledge Retrieval', 'Summarization', '置信度标注'],
      tools: ['wiki_lookup', 'memory_search', 'summarize'],
      cardType: 'knowledge',
      forbidden: ['O1', 'O2', 'O3', 'O4', 'O5', 'O6'],
      memory: { w: [0.30, 0.30, 0.25, 0.15], lambda: 0.020, quota: 40, prefers: 'fact > preference' },
      portrait: 'prism'
    },
    {
      id: 'muse',
      name: '薇奥拉',
      code: 'VIOLA',
      accentVar: 'viola',
      glyph: '*',
      title: '创意型 · 给你三个方向，然后看你眼睛往哪边亮',
      archetype: '即兴乐手 × 涂鸦者',
      desc: '先给素材，再给框架。不给正确答案，给可以继续长的东西——但三个方向必须真的不同。',
      signatureLines: ['先来三个，都不负责。', '这个太乖了，我换个野一点的。', '别问为什么，先听一遍。'],
      capabilities: ['Creativity', 'Content Generation', '约束生成'],
      tools: ['inspo_seed', 'rhyme_bank', 'constraint_gen'],
      cardType: 'inspiration',
      forbidden: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'],
      memory: { w: [0.25, 0.25, 0.20, 0.30], lambda: 0.060, quota: 25, prefers: 'preference > event' },
      portrait: 'stroke'
    }
  ];

  /* ── Stage 0 §2.4 的 Agent 运行时初始态 ───────────────────────────── */
  /* 未获得的成长一律为 0：等级与 XP 不做任何预填（成长只能来自真实交互）。 */
  var INITIAL_RUNTIME = {
    bartender: { level: 1, xp: 0, mood: 'neutral', affinity: 0, energy: 100, talks: 0, unlocked: [] },
    oracle: { level: 1, xp: 0, mood: 'thoughtful', affinity: 0, energy: 88, talks: 0, unlocked: [] },
    muse: { level: 1, xp: 0, mood: 'tired', affinity: 0, energy: 18, talks: 0, unlocked: [] }
  };

  /* ── 卡片字段清单（persona-spec §2.7 / §3.7 / §4.7） ──────────────── */
  /* Stage 1 只用于展示字段名与校验规则；Stage 3 由生成端真正产出这些结构。 */
  var CARD_SCHEMA = {
    plan: {
      type: 'plan',
      maxSteps: 7,
      required: ['title', 'horizon', 'steps', 'firstAction', 'basis', 'checkable'],
      fields: ['title', 'horizon', 'steps[{id,text,est,why,done}]', 'risks[]', 'firstAction', 'basis', 'checkable'],
      degrade: '缺 firstAction → 降级为普通文本；steps 越界 → 截断并记 note'
    },
    knowledge: {
      type: 'knowledge',
      maxPoints: 5,
      required: ['question', 'summary', 'points', 'uncertainties', 'sourcesOk'],
      fields: ['question', 'summary', 'points[{claim,confidence,source}]', 'uncertainties[]', 'sourcesOk', 'followUp'],
      degrade: 'uncertainties 为空 → 前端强制注入一条并计 O2；未出现在本次检索返回中的 url → 前端剥除且置信度压至 0.4'
    },
    inspiration: {
      type: 'inspiration',
      variants: 3,
      required: ['prompt', 'styleTags', 'variants', 'seed', 'canRegenerate'],
      fields: ['prompt', 'styleTags[]', 'variants[{id,tag,text,imagery}]', 'constraints[]', 'seed{seedId,words,image}', 'canRegenerate'],
      degrade: '变体 3-gram 重叠 > 0.6 → 自动重生成一次；seed 缺失 → 视为 M5 违规'
    }
  };

  /* ── 演示用关注点标签（Stage 1 只在 Agent 卡上展示，无逻辑含义） ───── */
  var DEMO_TOPICS = {
    bartender: ['拆解目标', '两难选择', '本周计划'],
    oracle: ['概念追问', '来源与置信度', '知识边界'],
    muse: ['命名', '设定', '三个方向']
  };

  global.Tavern = global.Tavern || {};
  global.Tavern.Personas = Object.freeze({
    SPEC_VERSION: SPEC_VERSION,
    AGENTS: Object.freeze(AGENTS),
    INITIAL_RUNTIME: Object.freeze(INITIAL_RUNTIME),
    DEMO_TOPICS: Object.freeze(DEMO_TOPICS),
    RELATIONSHIP_STAGES: Object.freeze(RELATIONSHIP_STAGES),
    relationshipStage: relationshipStage,
    trustLabel: trustLabel,
    FROZEN: Object.freeze({
      MOODS: Object.freeze(MOODS),
      ENERGY_RULES: Object.freeze(ENERGY_RULES),
      RETRIEVAL: Object.freeze(RETRIEVAL),
      QUOTA: Object.freeze(QUOTA),
      LIMITS: Object.freeze(LIMITS),
      AFFINITY_STAGES: Object.freeze(AFFINITY_STAGES),
      UNIVERSAL_FORBIDDEN: Object.freeze(UNIVERSAL_FORBIDDEN),
      CARD_SCHEMA: Object.freeze(CARD_SCHEMA)
    })
  });
})(window);
