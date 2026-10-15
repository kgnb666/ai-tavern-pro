/* ══════════════════════════════════════════════════════════════════════════
   cognition.js — Agent 控制层的本地认知（Stage 3-1）
   ──────────────────────────────────────────────────────────────────────────
   职责边界（三件事，多一件都不做）：
     1. Intent Detection   意图识别
     2. Plan Generation    **回答策略**规划（"我怎么回答你"，不是用户的任务计划）
     3. Mode Recommendation 模式建议（只建议，不决定 —— 最终 mode 由 turn.js 的 resolveMode 裁决）

   硬约束：
     · **纯本地计算**：不 fetch、不调 API、不碰 Worker、不读 memory 表
     · **确定性**：不使用随机数与时间。同一输入必须给出完全一致的输出
     · 不是 Provider：Provider 不感知本模块的存在（src/providers/* 中零引用）
     · 不新增事件：只由 turn.js 用既有 trace:step 上报本模块拥有的两个 stepId

   调用关系：UI → Turn.send → Cognition.run → resolveMode → Provider.chat
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var STEPS = ['intent.detect', 'plan.generate'];
  var LABEL = { 'intent.detect': '识别意图', 'plan.generate': '生成回答策略' };

  /* ── 1. 意图识别：确定性加权关键词打分 ────────────────────────────
     命中越长的词权重越高（"该不该"比"选"更有信息量）。命中数为 0 时回落 chitchat。 */
  var KEYWORDS = {
    planner: ['计划', '规划', '安排', '目标', '步骤', '怎么开始', '怎么做', '路线', '落地', '推进', '准备', '学起来'],
    decider: ['该不该', '要不要', '还是', '纠结', '取舍', '值不值', '放弃', '选哪', '选择'],
    analyst: ['为什么', '原因', '分析', '对比', '区别', '差异', '利弊', '评估', '拆解'],
    knowledge: ['是什么', '什么是', '怎么理解', '什么意思', '解释', '原理', '定义', '介绍', '科普']
  };
  var ORDER = ['planner', 'decider', 'analyst', 'knowledge'];   // 平分时按此顺序取先者（确定性）

  function classify(text) {
    var t = String(text || '').toLowerCase();
    var scores = {}, matched = {}, total = 0, best = null, bestScore = 0;
    for (var i = 0; i < ORDER.length; i++) {
      var name = ORDER[i], list = KEYWORDS[name], hit = [], sc = 0;
      for (var k = 0; k < list.length; k++) {
        if (t.indexOf(list[k]) !== -1) { sc += list[k].length; hit.push(list[k]); }
      }
      scores[name] = sc;
      matched[name] = hit;
      total += sc;
      if (sc > bestScore) { bestScore = sc; best = name; }
    }
    var confidence = bestScore === 0 ? 0.35 : Math.min(0.95, 0.45 + (bestScore / (total + bestScore)) * 0.5);
    return {
      name: bestScore === 0 ? 'chitchat' : best,
      confidence: Math.round(confidence * 100) / 100,
      matched: matched[bestScore === 0 ? 'planner' : best] || [],
      scores: scores,
      method: 'keyword-score@v1'
    };
  }

  /* ── 2. 回答策略：每种意图一套固定的作答骨架（不是用户的任务计划，也不生成卡片） ── */
  var PLANS = {
    planner: [
      { id: 'clarify', text: '确认目标', why: '用户存在规划需求' },
      { id: 'suggest', text: '给出执行建议', why: 'planner 策略：给判断而非选项堆砌' },
      { id: 'risk', text: '标出最坏情况', why: '让建议可以被反驳' }
    ],
    decider: [
      { id: 'weigh', text: '列出权衡维度', why: '决策需要可比较的维度' },
      { id: 'judge', text: '给出一个明确判断', why: '不把选择权原样退回给用户' },
      { id: 'premise', text: '说明判断成立的前提', why: '判断必须可被证伪' }
    ],
    analyst: [
      { id: 'split', text: '拆解问题', why: '分析先降维' },
      { id: 'keyvar', text: '指出关键变量', why: '变量决定结论' },
      { id: 'verify', text: '给出验证方式', why: '结论要能被检验' }
    ],
    knowledge: [
      { id: 'known', text: '先给确定的部分', why: '知识型回答先划边界' },
      { id: 'uncertain', text: '标注不确定处', why: '信心水平必须可见' },
      { id: 'source', text: '给出来源或检索路径', why: '可追溯比说得满更重要' }
    ],
    chitchat: [
      { id: 'catch', text: '接住话题', why: '闲聊先共鸣' },
      { id: 'light', text: '给一个轻回应', why: '不追问、不施压' },
      { id: 'open', text: '留一个开放问题', why: '把话头交回用户' }
    ]
  };

  function planFor(intent, ctx) {
    var steps = PLANS[intent] || PLANS.chitchat;
    return {
      steps: steps.map(function (s) { return { id: s.id, text: s.text, why: s.why }; }),
      basis: 'intent=' + intent + ' · 输入 ' + ctx.chars + ' 字 · ' + (ctx.historyCount ? ('历史 ' + ctx.historyCount + ' 条') : '无历史')
    };
  }

  /* ── 3. 模式建议：只给建议，不决定。最终 mode 由 turn.js 的 resolveMode 裁决 ── */
  var DEEP_INTENTS = ['planner', 'decider', 'analyst'];

  function recommend(intent, ctx) {
    var reasons = [], deep = false;
    if (ctx.agentId === 'bartender') { deep = true; reasons.push('该 Agent 固定深潜'); }
    if (DEEP_INTENTS.indexOf(intent.name) !== -1) { deep = true; reasons.push('意图=' + intent.name + ' 需要推理'); }
    if (ctx.chars >= 40) { deep = true; reasons.push('输入 ' + ctx.chars + ' 字（≥40）'); }
    if (ctx.historyCount > 0) { deep = true; reasons.push('存在 ' + ctx.historyCount + ' 条历史上下文'); }
    if (!deep) reasons.push('闲聊且输入较短 → 快速即可');
    return { suggestedMode: deep ? 'deep' : 'quick', reasons: reasons };
  }

  /* ── 对外接口（冻结面）：run 是唯一入口，纯函数 ─────────────────── */
  function run(input) {
    var text = String((input && input.text) || '');
    var history = (input && input.history) || [];
    var agentId = (input && input.agentId) || '';
    var ctx = { chars: text.length, historyCount: history.length, agentId: agentId };

    var intent = classify(text);
    var plan = planFor(intent.name, ctx);
    var rec = recommend(intent, ctx);

    return {
      intent: intent,
      plan: plan,
      suggestedMode: rec.suggestedMode,
      reasons: rec.reasons
    };
  }

  global.Tavern = global.Tavern || {};
  global.Tavern.Cognition = Object.freeze({
    STEPS: Object.freeze(STEPS.slice()),
    LABEL: Object.freeze(LABEL),
    DEEP_INTENTS: Object.freeze(DEEP_INTENTS.slice()),
    run: run,
    classify: classify          // 供自检与确定性测试直接调用
  });
})(window);
