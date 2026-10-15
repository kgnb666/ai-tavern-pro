/* ══════════════════════════════════════════════════════════════════════════
   provider.js — Provider 抽象接口（Stage 1-2）
   ──────────────────────────────────────────────────────────────────────────
   定义"谁能产出回复"的契约，使 MockProvider（本阶段）与 GatewayClient
   （Stage 2，走 Worker + LLM）可以互换，UI 与 Turn 桥不需改动。

   ── 关于事件名的边界说明（重要）──
   Stage 1-2 指令给出的 6 个语义阶段：
       turn.start · intent.created · memory.checked · plan.created
       response.chunk · turn.end
   它们被原样保留为**阶段标识**（phase id / Trace 面板文案 / stepId），
   但**不作为线上事件名**，因为：

     · stage-0-architecture.md §2.4 冻结的事件名是 trace:turn:start / trace:step /
       trace:memory:hit / trace:token / trace:turn:end 等 8 个；
     · TraceBus 对未知事件名直接抛错（Stage 1-1 建立的白名单），
       而本阶段要求"事件必须经过 TraceBus"。

   两者只能通过"阶段名 → 冻结事件名"的映射共存。映射写在 PHASE_TRANSPORT 中，
   改线上事件名属于 Stage-0 契约修订，须走变更流程，不得在此处就地改。
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* 6 个语义阶段（指令原文，原样保留） */
  var PHASES = [
    'turn.start',
    'intent.created',
    'memory.checked',
    'plan.created',
    'response.chunk',
    'turn.end'
  ];

  /* 阶段 → Stage-0 §2.4 冻结的传输事件名 */
  var PHASE_TRANSPORT = {
    'turn.start': 'trace:turn:start',
    'intent.created': 'trace:step',
    'memory.checked': 'trace:step',      // 命中时额外发 trace:memory:hit
    'plan.created': 'trace:step',
    'response.chunk': 'trace:token',
    'turn.end': 'trace:turn:end'
  };

  /* 阶段面板文案（Trace 面板显示这些，而非事件名） */
  var PHASE_LABEL = {
    'turn.start': '开始一轮',
    'intent.created': '理解请求',
    'memory.checked': '检索记忆',
    'plan.created': '推理规划',
    'response.chunk': '生成回复',
    'turn.end': '收束本轮'
  };

  /* Provider 必须实现的成员 */
  var REQUIRED = ['id', 'kind', 'meta', 'chat'];

  function validate(p, where) {
    if (!p || typeof p !== 'object') throw new Error('[Provider] ' + (where || '') + ' 不是对象');
    for (var i = 0; i < REQUIRED.length; i++) {
      if (p[REQUIRED[i]] == null) {
        throw new Error('[Provider] ' + (where || '') + ' 缺少必需成员：' + REQUIRED[i]);
      }
    }
    if (typeof p.chat !== 'function') throw new Error('[Provider] chat 必须是函数');
    if (p.kind !== 'mock' && p.kind !== 'live') {
      throw new Error('[Provider] kind 只能是 mock 或 live，实际为 ' + p.kind);
    }
    if (!p.meta || typeof p.meta.label !== 'string' || typeof p.meta.isMock !== 'boolean') {
      throw new Error('[Provider] meta 必须包含 { label: string, isMock: boolean }');
    }
    return true;
  }

  /**
   * chat(request, sink) → Promise<TurnResult>
   *
   * request: {
   *   turnId: string,
   *   agentId: 'bartender'|'oracle'|'muse',
   *   mode: 'quick'|'deep',            // 快速 / 深潜（服务端据此配置 thinking 与 token 预算）
   *   history: Message[],              // 该 Agent 的历史消息（真实会话数据）
   *   userText: string,
   *   signal: AbortSignal|null,        // 用户中断；Provider 必须把它接到自己的 fetch 上
   *   state: object                    // 只读快照（agents/conversations），供检索使用
   * }
   *
   * sink（由调用方提供，Provider 通过它上报）:
   *   sink.phase(phase, status, payload)   status: 'active'|'done'
   *   sink.chunk(text)                     流式正文增量（回复气泡的唯一来源）
   *   sink.reasoning(text)                 **可选**：推理增量，仅用于计算度量；
   *                                        DR-009 规定桥接层立即丢弃原文，不渲染/不持久化/不进日志
   *   sink.memory(hits, meta)
   *   sink.tool(call)                      一次真实工具调用 { name, args, result, ms }
   *   sink.status(patch)                   只接受表现层提示（mood）；数值结算由桥接层按 mode 统一负责
   *   sink.final(replyText, meta)
   *
   * 约定：
   *   · Provider 只上报事实，不改动 UI 状态、不发 TraceBus 事件（由 core/turn.js 负责）；
   *   · Provider 若声明 kind:'mock'，其 meta.label 必须出现在所有展示其输出的位置；
   *   · 真实耗时用 performance.now() 实测；模拟延迟必须显式标注 simMs，不得混入耗时。
   */
  function validateRequest(req) {
    if (!req || !req.turnId || !req.agentId) throw new Error('[Provider] request 缺少 turnId/agentId');
    if (typeof req.userText !== 'string') throw new Error('[Provider] request.userText 必须是字符串');
    if (!Array.isArray(req.history)) throw new Error('[Provider] request.history 必须是数组');
    return true;
  }

  var registry = { current: null };

  function register(provider) {
    validate(provider, 'register');
    registry.current = provider;
    return provider;
  }

  function current() { return registry.current; }

  function requireCurrent() {
    if (!registry.current) {
      throw new Error('[Provider] 尚未注册 Provider。Stage 1-2 应调用 Tavern.Provider.register(Tavern.Providers.Mock)');
    }
    return registry.current;
  }

  global.Tavern = global.Tavern || {};
  global.Tavern.Provider = Object.freeze({
    PHASES: Object.freeze(PHASES.slice()),
    PHASE_TRANSPORT: Object.freeze(PHASE_TRANSPORT),
    PHASE_LABEL: Object.freeze(PHASE_LABEL),
    REQUIRED: Object.freeze(REQUIRED.slice()),
    validate: validate,
    validateRequest: validateRequest,
    register: register,
    current: current,
    requireCurrent: requireCurrent
  });
})(window);
