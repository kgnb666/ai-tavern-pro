/* ══════════════════════════════════════════════════════════════════════════
   transcript.js — 对话流：用户消息 / 流式回复 / 输入框
   ──────────────────────────────────────────────────────────────────────────
   诚实约束：
     · 回复气泡在**第一个分块真正到达**时才出现 —— 在此之前不显示任何
       "思考中"占位（进度由 Trace 面板的真实事件承担）；
     · 每条回复下方展示它自己的元信息（Provider 标识、真实意图与置信度、
       真实记忆命中数、卡片类型、真实墙钟耗时），不允许隐藏 mock 身份；
     · 流式渲染严格跟随真实分块到达，不做匀速打字机。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var Transcript = {
    name: 'Transcript',
    // 数据单入口：卡片只能来自 message.meta.card（组件自己也只读 props.card）
    components: { Card: global.Tavern.UI.CardRenderer },
    props: { agentId: { type: String, required: true } },

    data: function () {
      return { draft: '', picked: null };
    },

    computed: {
      store: function () { return global.Tavern.Store; },
      messages: function () { return this.store.state.conversations[this.agentId]; },
      busy: function () { return global.Tavern.Turn.isBusy(); },
      agent: function () { return this.store.agentById(this.agentId); },
      starters: function () {
        var s = global.Tavern.MockScripts.STARTERS[this.agentId] || {};
        var topics = global.Tavern.Personas.DEMO_TOPICS[this.agentId] || [];
        var out = [];
        for (var i = 0; i < topics.length; i++) {
          if (s[topics[i]]) out.push({ label: topics[i], text: s[topics[i]] });
        }
        return out;
      },
      provider: function () { return global.Tavern.Provider.current(); },
      pendingEvent: function () {
        var e = this.store.state.events[this.agentId];
        return (e && e.pending) ? global.Tavern.Events.byId(e.pending) : null;
      },
      notice: function () {
        var e = this.store.state.events[this.agentId];
        return e ? e.notice : null;
      },
      canSend: function () { return !this.busy && this.draft.trim().length > 0; },
      providerNote: function () {
        var p = this.provider;
        if (p.meta.isMock) {
          return '当前 Provider：' + p.meta.label + '（' + p.id + '）· 不调用任何外部 API。真实发生的是：关键词意图分类、本会话记忆检索、卡片生成、掷骰与分块流式；延迟为已标注的模拟值（' + p.meta.latencyModel + '）。';
        }
        return '当前 Provider：' + p.meta.label + '（' + p.id + '）· 密钥只在服务端。本轮真实发生的是：真实模型的流式生成（含真实 usage 与推理度量）；意图分类、记忆检索、工具调用与卡片生成都在本机完成，并随提示词一起送达；深潜轮收尾多一次自我检查（只报告问题、不改写回复）。';
      }
    },

    methods: {
      fill: function (text) {
        if (this.busy) return;
        this.draft = text;
        this.$nextTick(function () {
          var el = this.$el && this.$el.querySelector('.room__input');
          if (el) el.focus();
        });
      },
      send: function () {
        if (!this.canSend) return;
        var text = this.draft;
        this.draft = '';
        // mode 从调用入口一路透传：UI → Turn → Provider → Worker 路由
        global.Tavern.Turn.send(this.agentId, text, { mode: this.store.state.session.mode });
      },
      mode: function () { return this.store.state.session.mode; },
      setMode: function (m) { this.store.setMode(m); },
      stop: function () { global.Tavern.Turn.abort(); },
      pick: function (ci) {
        var self = this;
        var c = this.pendingEvent && this.pendingEvent.choices[ci];
        this.store.resolveEvent(this.agentId, ci);
        if (!c) return;
        var fx = c.effects || {};
        var note = fx.trust > 0 && fx.affinity > 0 ? '信任与关系都进了一步'
          : fx.trust > 0 ? '信任在上升' : fx.affinity > 0 ? '关系更近了一点' : '这一笔记下了';
        this.picked = { text: c.text, note: note };
        setTimeout(function () { self.picked = null; }, 2600);
      },
      onEnter: function (e) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.send(); }
      },
      intentLine: function (m) {
        var i = m.meta && m.meta.intent;
        return i ? (i.intent + ' · 置信度 ' + i.confidence + ' · 命中词 ' + (i.matched.length ? i.matched.join('/') : '无')) : '';
      },
      memLine: function (m) {
        var mem = m.meta && m.meta.memory;
        if (!mem) return '';
        return mem.hits.length ? ('记忆命中 ' + mem.hits.length + ' 条（' + mem.hits[0].score + '）')
          : ('记忆未命中（候选 ' + mem.poolSize + ' 条）');
      }
    },

    template: [
      '<div class="transcript">',
      '  <div v-if="!messages.length" class="empty">',
      '    <span>{{ agent.name }}还没开口。</span>',
      '    <span class="t-meta">说一句，或者点下面的标签 —— 每一轮都会在右侧留下真实的执行轨迹。</span>',
      '  </div>',
      '',
      '  <div v-for="m in messages" :key="m.id" class="turn" :class="\'turn--\' + m.role">',
      '    <div class="bubble" :class="m.role === \'user\' ? \'bubble--user\' : \'bubble--agent\'">',
      '      <p v-if="m.content" class="bubble__text">{{ m.content }}<span v-if="m.meta.streaming" class="caret" aria-hidden="true"></span></p>',
      '      <p v-else-if="m.role === \'assistant\' && m.meta.empty" class="t-meta">',
      '        （这一轮没有产出内容{{ m.meta.aborted ? \'：被中途停止\' : \'\' }}{{ m.meta.error ? \'：\' + (m.meta.error.userMessage || m.meta.error.kind) : \'\' }}）',
      '      </p>',
      '      <p v-else-if="m.role === \'assistant\' && m.meta.streaming" class="t-meta">正在接收第一个分块…</p>',
      '',
      '      <!-- 卡片产物：唯一数据入口是 message.meta.card；没有 card 时不渲染任何容器 -->',
      '      <Card v-if="m.meta.card" :card="m.meta.card" />',
      '',
      '      <div v-if="m.role === \'assistant\' && !m.meta.streaming" class="bubble__foot">',
      '        <span class="chip" :class="m.meta.isMock ? \'chip--warn\' : \'chip--success\'">{{ m.meta.providerLabel }}</span>',
      '        <span v-if="m.meta.intent" class="chip">意图 {{ m.meta.intent.intent }} · {{ m.meta.intent.confidence }}</span>',
      '        <span v-if="m.meta.memory" class="chip">记忆 {{ m.meta.memory.hits.length }} 条命中 / 候选 {{ m.meta.memory.poolSize }}</span>',
      '        <span v-if="m.meta.card" class="chip">卡片 {{ m.meta.card.type }}</span>',
      '        <span v-if="m.meta.toolCalls && m.meta.toolCalls.length" class="chip">工具 {{ m.meta.toolCalls[0].name }}={{ m.meta.toolCalls[0].result.value }}/6</span>',
      '        <span v-if="m.meta.wallMs" class="chip">本机耗时 {{ m.meta.wallMs }}ms</span>',
      '        <span v-if="m.meta.aborted" class="chip chip--danger">已中断</span>',
      '        <span v-if="m.meta.incomplete" class="chip chip--warn">不完整</span>',
      '        <span v-if="m.meta.truncated" class="chip chip--warn">回答被截断</span>',
      '        <span v-if="m.meta.error" class="chip chip--danger" :title="m.meta.error.kind + (m.meta.error.requestId ? \' / \' + m.meta.error.requestId : \'\')">{{ m.meta.error.userMessage || m.meta.error.kind }}</span>',
      '      </div>',
      '    </div>',
      '  </div>',
      '',
      '  <div class="transcript__starters">',
      '    <span class="label">可以这样开口</span>',
      '    <div class="room__counts">',
      '      <button v-for="s in starters" :key="s.label" class="chip" :disabled="busy"',
      '        :title="s.text" @click="fill(s.text)">{{ s.label }}</button>',
      '    </div>',
      '  </div>',
      '',
      '  <div v-if="pendingEvent" class="event-card">',
      '    <p class="event-card__title">{{ pendingEvent.title }}</p>',
      '    <p class="event-card__text t-meta">{{ pendingEvent.text }}</p>',
      '    <div class="event-card__choices">',
      '      <button v-for="(c, ci) in pendingEvent.choices" :key="ci" class="btn btn--ghost" @click="pick(ci)">{{ c.text }}</button>',
      '    </div>',
      '  </div>',
      '  <p v-if="picked" class="t-meta">已选择「{{ picked.text }}」· {{ picked.note }}</p>',
      '  <p v-if="notice" class="t-meta">{{ notice }}</p>',
      '  <div class="room__composer">',
      '    <input class="room__input" type="text" v-model="draft" :disabled="busy"',
      '      :placeholder="busy ? \'正在回复…（可点右侧停止）\' : \'说点什么，回车发送\'"',
      '      :aria-label="\'给\' + agent.name + \'发消息\'" @keydown="onEnter">',
      '    <button v-if="!busy" class="btn btn--primary" :disabled="!canSend" @click="send">发送</button>',
      '    <button v-else class="btn btn--ghost" @click="stop">停止</button>',
      '  </div>',
      '',
      '  <p class="composer-note t-meta">{{ providerNote }}</p>',
      '</div>'
    ].join('\n')
  };

  global.Tavern.UI = global.Tavern.UI || {};
  global.Tavern.UI.Transcript = Transcript;
})(window);
