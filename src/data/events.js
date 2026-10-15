/* ══════════════════════════════════════════════════════════════════════════
   events.js — 轻量事件数据（Stage 6-2；纯数据：无网络、无 LLM、无副作用）
   ──────────────────────────────────────────────────────────────────────────
   condition 为本地可判定描述子：{kind:'keyword', words:[…]} | {kind:'turns', every:N}
   effects 只允许 {trust, affinity, mood}（mood 需在冻结 MOODS 白名单内），
   由 Store.resolveEvent 经既有 applyTrust / applyStatusPatch 落地。
   matchFor 为唯一匹配实现；keyword 优先（数组序），turns 通道 talks % every === 0。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var EVENTS = [
    {
      id: 'ev_bt_tired', agentId: 'bartender',
      condition: { kind: 'keyword', words: ['累', '疲惫', '压力'] },
      title: '深夜的一杯',
      text: '你看起来有点累。要不要把这周的事摊开，我们一起拆一拆？',
      choices: [
        { text: '摊开聊聊', effects: { trust: 1, affinity: 1 } },
        { text: '先喝一杯再说', effects: { mood: 'warm' } }
      ]
    },
    {
      id: 'ev_bt_dice', agentId: 'bartender',
      condition: { kind: 'turns', every: 4 },
      title: '骰子的赌约',
      text: '来赌一把？骰子给我一个数字，你给我一个真问题。',
      choices: [
        { text: '来', effects: { trust: 1, mood: 'amused' } },
        { text: '改天', effects: { mood: 'thoughtful' } }
      ]
    },
    {
      id: 'ev_or_source', agentId: 'oracle',
      condition: { kind: 'keyword', words: ['为什么', '不懂', '困惑'] },
      title: '提问的契约',
      text: '这个问题值得一个来源。若我给出带出处的答案，你愿意听完再追问一次吗？',
      choices: [
        { text: '愿意听完', effects: { trust: 1 } },
        { text: '先要结论', effects: { mood: 'thoughtful' } }
      ]
    },
    {
      id: 'ev_or_notes', agentId: 'oracle',
      condition: { kind: 'turns', every: 4 },
      title: '一页旧笔记',
      text: '我在旧笔记里翻到一条线索，与你之前问过的东西有关。想听吗？',
      choices: [
        { text: '想听', effects: { trust: 1, affinity: 1 } },
        { text: '下次吧', effects: { mood: 'neutral' } }
      ]
    },
    {
      id: 'ev_mu_seed', agentId: 'muse',
      condition: { kind: 'keyword', words: ['无聊', '灵感', '没意思'] },
      title: '灵感的赌局',
      text: '我们抽三个意象，换你写一句话——敢不敢？',
      choices: [
        { text: '敢', effects: { trust: 1, mood: 'energized' } },
        { text: '围观一下', effects: { mood: 'amused' } }
      ]
    },
    {
      id: 'ev_mu_sign', agentId: 'muse',
      condition: { kind: 'turns', every: 4 },
      title: '熄掉的招牌',
      text: '门口那块招牌亮了又暗。给它起个新名字，怎么样？',
      choices: [
        { text: '我来起', effects: { trust: 1, affinity: 1 } },
        { text: '你来吧', effects: { mood: 'warm' } }
      ]
    }
  ];

  function byId(id) {
    for (var i = 0; i < EVENTS.length; i++) if (EVENTS[i].id === id) return EVENTS[i];
    return null;
  }

  /** 唯一匹配实现：返回应触发的事件或 null（调用方负责 pending/aborted 守卫） */
  function matchFor(agentId, userText, talks) {
    var t = String(userText || '');
    for (var i = 0; i < EVENTS.length; i++) {
      var e = EVENTS[i];
      if (e.agentId !== agentId) continue;
      var c = e.condition || {};
      if (c.kind === 'keyword') {
        for (var j = 0; j < (c.words || []).length; j++) if (t.indexOf(c.words[j]) !== -1) return e;
      } else if (c.kind === 'turns' && c.every > 0 && talks > 0 && talks % c.every === 0) {
        return e;
      }
    }
    return null;
  }

  global.Tavern = global.Tavern || {};
  global.Tavern.Events = Object.freeze({
    LIST: Object.freeze(EVENTS),
    byId: byId,
    matchFor: matchFor
  });
})(window);
