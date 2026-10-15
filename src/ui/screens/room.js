/* ══════════════════════════════════════════════════════════════════════════
   room.js — 屏 3：Conversation Room（三栏 RPG 布局骨架）
   对话引擎、真实 Trace 事件、记忆 / 关系 / 事件卡均已接入；本文件只做布局与状态展示。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* persona-spec §3.5：三个 Agent 中唯一的真实网络工具 */
  var NET_TOOLS = ['wiki_lookup'];

  var ScreenRoom = {
    name: 'ScreenRoom',
    components: {
      Portrait: global.Tavern.UI.Portrait,
      TraceLive: global.Tavern.UI.TraceLive,
      Transcript: global.Tavern.UI.Transcript
    },
    data: function () {
      return { netTools: NET_TOOLS };
    },
    computed: {
      store: function () { return global.Tavern.Store; },
      agentId: function () { return this.store.state.ui.activeAgentId; },
      agent: function () { return this.store.agentById(this.agentId); },
      runtime: function () { return this.store.state.agents[this.agentId]; },
      stageName: function () { return this.store.relationshipStage(this.agentId); },
      trustLabel: function () { return this.store.trustLabel(this.agentId); },
      progress: function () { return this.store.levelProgress(this.agentId); },
      moodLabel: function () { return this.store.MOOD_LABEL[this.runtime.mood]; },
      provider: function () { return global.Tavern.Provider.current(); },
      providerChipClass: function () { return this.provider.meta.isMock ? 'chip--warn' : 'chip--success'; },
      stageNote: function () {
        if (this.provider.meta.isMock) {
          return '对话流已接通模拟 Provider：意图分类、记忆检索、卡片生成、掷骰与分块流式都是本机真实计算，唯一被模拟的是延迟（见轨迹面板）。带上 ?api= 或部署网关后可切到真实模型。';
        }
        return '对话流已接通真实模型（经 Cloudflare Worker 网关）：密钥只在服务端，上游 SSE 解析与错误归一化在服务端完成。推理原文按 DR-009 丢弃，只保留度量。';
      },
      isQuick: function () { return this.store.state.session.mode === 'quick'; },
      isAuto: function () { return this.store.state.session.mode === 'auto'; },
      autoClass: function () { return this.isAuto ? 'btn btn--primary' : 'btn'; },
      quickClass: function () { return this.isQuick ? 'btn btn--primary' : 'btn'; },
      deepClass: function () { return this.isQuick ? 'btn' : 'btn btn--primary'; },
      memory: function () { return this.agent.memory; },
      weights: function () {
        var w = this.memory.w;
        return '关键词 ' + w[0] + ' / 标签 ' + w[1] + ' / 强度 ' + w[2] + ' / 新鲜度 ' + w[3];
      },
      mobileTab: function () { return this.store.state.ui.mobileTab; },
      msgCount: function () {
        return this.store.state.conversations[this.agentId].length;
      }
    },
    methods: {
      tab: function (name) { this.store.openPanel(name); },
      back: function () { this.store.routeTo('world'); },
      isNet: function (t) { return this.netTools.indexOf(t) !== -1; },
      useQuick: function () { this.store.setMode('quick'); },
      useAuto: function () { this.store.setMode('auto'); },
      useDeep: function () { this.store.setMode('deep'); }
    },
    template: [
      '<section class="screen room" :data-agent="agentId">',
      '',
      '  <nav class="room__tabs" aria-label="面板切换">',
      '    <button class="btn" :class="{ \'btn--primary\': mobileTab === \'conv\' }" @click="tab(\'conv\')">对话</button>',
      '    <button class="btn" :class="{ \'btn--primary\': mobileTab === \'agent\' }" @click="tab(\'agent\')">状态</button>',
      '    <button class="btn" :class="{ \'btn--primary\': mobileTab === \'trace\' }" @click="tab(\'trace\')">轨迹</button>',
      '    <span class="spacer"></span>',
      '    <button class="btn btn--ghost" @click="back">← 回酒馆</button>',
      '  </nav>',
      '',
      '  <!-- ── 左栏：Agent 状态 ─────────────────────────────────────── -->',
      '  <div class="room__col room__col--agent" :class="{ \'is-active\': mobileTab === \'agent\' }">',
      '    <section class="panel">',
      '      <div class="room__agenthead">',
      '        <div class="agent-card__portrait"><Portrait :kind="agent.portrait" /></div>',
      '        <div class="stack" style="gap:2px;min-width:0">',
      '          <span class="t-h2">{{ agent.name }}</span>',
      '          <span class="agent-card__code muted-3">{{ agent.code }}</span>',
      '          <span class="t-meta">{{ moodLabel }} · {{ stageName }}</span>',
      '        </div>',
      '      </div>',
      '      <p class="t-body-sm" style="margin-top:var(--sp-3)">{{ agent.title }}</p>',
      '    </section>',
      '',
      '    <section class="panel">',
      '      <div class="panel__head"><h3 class="panel__title">状态</h3></div>',
      '      <div class="stack" style="gap:var(--sp-4)">',
      '        <div class="bar">',
      '          <div class="bar__head"><span class="label">Energy</span><span class="t-mono">{{ runtime.energy }} / 100</span></div>',
      '          <div class="bar__track"><div class="bar__fill" :style="{ width: runtime.energy + \'%\' }"></div></div>',
      '        </div>',
      '        <div class="row" style="gap:var(--sp-2);flex-wrap:wrap;align-items:center">',
      '          <span class="label">关系</span>',
      '          <span class="chip">{{ stageName }}</span>',
      '        </div>',
      '        <div class="row" style="gap:var(--sp-2);flex-wrap:wrap;align-items:center">',
      '          <span class="label">信任</span>',
      '          <span class="chip">{{ trustLabel }}</span>',
      '        </div>',
      '        <div class="bar">',
      '          <div class="bar__head"><span class="label">Level {{ runtime.level }} · XP</span>',
      '            <span class="t-mono">{{ runtime.xp }} / {{ progress.next }}</span>',
      '          </div>',
      '          <div class="bar__track"><div class="bar__fill" :style="{ width: progress.pct + \'%\' }"></div></div>',
      '        </div>',
      '        <div class="row" style="gap:var(--sp-2);flex-wrap:wrap">',
      '          <span class="chip">本会话发言 {{ msgCount }}</span>',
      '          <span class="chip">解锁 {{ runtime.unlocked.length }}</span>',
      '        </div>',
      '      </div>',
      '    </section>',
      '',
      '    <section class="panel">',
      '      <div class="panel__head"><h3 class="panel__title">能力与工具</h3></div>',
      '      <div class="stack" style="gap:var(--sp-3)">',
      '        <div class="agent-card__tags">',
      '          <span v-for="c in agent.capabilities" :key="c" class="chip chip--accent">{{ c }}</span>',
      '        </div>',
      '        <div class="stack" style="gap:var(--sp-1)">',
      '          <div v-for="t in agent.tools" :key="t" class="row" style="gap:var(--sp-2);align-items:baseline">',
      '            <span class="t-mono">{{ t }}</span>',
      '            <span class="spacer"></span>',
      '            <span class="chip" :class="{ \'chip--info\': isNet(t) }">{{ isNet(t) ? \'网络\' : \'本地\' }}</span>',
      '          </div>',
      '        </div>',
      '        <p class="t-meta">工具的入参与返回会被完整记录在轨迹面板中 —— 调用被看见，才叫 Agent。</p>',
      '      </div>',
      '    </section>',
      '',
      '    <section class="panel">',
      '      <div class="panel__head"><h3 class="panel__title">记忆策略</h3><span class="chip">persona-spec §1.6</span></div>',
      '      <div class="stack" style="gap:var(--sp-2)">',
      '        <div class="row"><span class="label">检索权重</span><span class="spacer"></span><span class="t-mono muted">{{ weights }}</span></div>',
      '        <div class="row"><span class="label">衰减 λ</span><span class="spacer"></span><span class="t-mono muted">{{ memory.lambda }} / 天</span></div>',
      '        <div class="row"><span class="label">配额</span><span class="spacer"></span><span class="t-mono muted">{{ memory.quota }} 条</span></div>',
      '        <div class="row"><span class="label">优先写入</span><span class="spacer"></span><span class="t-mono muted">{{ memory.prefers }}</span></div>',
      '        <p class="t-meta">三位 Agent 的记忆参数各不相同 —— 它们记住的东西本来就不一样。</p>',
      '      </div>',
      '    </section>',
      '  </div>',
      '',
      '  <!-- ── 中栏：对话流 ─────────────────────────────────────────── -->',
      '  <div class="room__col room__col--conv">',
      '    <p class="stage-note">',
      '      <span class="chip chip--warn">{{ provider.meta.label }}</span>',
      '      <span>{{ stageNote }}</span>',
      '    </p>',
      '',
      '    <section class="panel" style="min-height:420px">',
      '      <div class="panel__head">',
      '        <h3 class="panel__title">与 {{ agent.name }} 的对话</h3>',
      '        <span class="chip" :class="providerChipClass">{{ provider.id }}</span>',
      '        <span class="spacer"></span>',
      '        <button :class="quickClass" @click="useQuick" title="关闭 thinking：更快、更省，没有推理度量">快速</button>',
      '        <button :class="autoClass" @click="useAuto" title="由本地认知决定（用户未显式选择时生效）">自动</button>',
      '        <button :class="deepClass" @click="useDeep" title="深潜：推理只出度量（不展示原文）；收尾多一次自我检查（只报告问题，不改写回复）">深潜</button>',
      '      </div>',
      '      <Transcript :agent-id="agentId" />',
      '    </section>',
      '  </div>',
      '',
      '  <!-- ── 右栏：Agent Trace ────────────────────────────────────── -->',
      '  <div class="room__col room__col--trace" :class="{ \'is-active\': mobileTab === \'trace\' }">',
      '    <TraceLive />',
      '  </div>',
      '</section>'
    ].join('\n')
  };

  global.Tavern.UI.ScreenRoom = ScreenRoom;
})(window);
