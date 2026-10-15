# AI Tavern Pro — Stage 0 架构设计

> A place where AI Agents think, remember and evolve.
> 交付物：单 HTML 文件（`AI-Tavern.html`）+ 可访问链接 + 说明文档
> 本阶段不写业务代码，只冻结架构与契约。

**版本：v1.5**（2026-10-15）

### 变更记录

| 版本 | 日期 | 变更 | 依据 |
| --- | --- | --- | --- |
| v1.0 | 2026-10-12 | 初版冻结 | — |
| **v1.1** | 2026-10-13 | **§1.2 决策三**改为"默认单模型 + 显式 thinking 参数"；模型名由 `deepseek-chat` / `deepseek-reasoner` 修正为 `deepseek-flash` / `deepseek-v4-pro`；§3.3 模式表补 thinking / max_tokens 映射；§3.4 Bartender 行同步；§4.2 SSE 帧加性扩展；§4.3 预算护栏由"每请求写 KV"改为"内存聚合 + 低频落盘"（KV 免费额度仅 1000 写/天）；§6 Stage 2 行的冒烟实测已完成 | Stage 2-1 实测（`/models` 返回、json_object 与 thinking 组合、错误响应形态、延迟与 token 构成）+ 用户批准的契约修订 |

| **v1.2** | 2026-10-13 | **DR-008**：gzip 预算 90 KB → **95 KB**（硬上限，非目标值；raw 300 KB 不变）；**DR-009**：`sink.reasoning` 加性扩展获批准，同时确立 **reasoning 展示边界**（原始思维链不展示、不持久化、不进普通日志） | 用户裁决 |
| **v1.3** | 2026-10-13 | **D-6 / DR-010**：`CognitionService` 由"一次 LLM 调用"改为**本地纯计算**（确定性、零网络、零成本）；其职责收窄为 **intent detection / answer-strategy planning / mode recommendation** 三件；`memoryQueries[]`、`toolCalls[]`、`needsDeep` **移出 Cognition**（归 Stage 4 记忆层与工具层）；Deep 模式的 LLM 调用数由 3 降为 **2**（生成 → 反思） | Stage 3-1 批准（用户） |
| **v1.4** | 2026-10-14 | **DR-008 预算修订**：gzip 95 KB → **100 KB**、raw 300 KB → **305 KB**（**硬上限随之更新**；因 Stage 3-4b 工具上下文与 Stage 4 记忆闭环的功能字节，经三次授权上调）。执行条件与 R4 的现值同步更新；产物 meta 与代码自始一致 | 用户三次裁决（Stage 3-4b Step 1 / Stage 4 Step 1 / Stage 4 Step 2） |
| **v1.5** | 2026-10-15 | **DR-008 预算修订（现行值）**：gzip 100 KB → **104 KB**、raw 305 KB → **330 KB**（硬上限随之更新；因 Stage 6 体验层与 Stage 7–9 记忆进化的功能字节，经 Stage 4–9 多次用户授权上调）。**LLM 调用数口径**：Deep 2 → **3**（生成 → 自检 → Evaluator 抽取；评估阶段按决策四后置非阻塞——Stage 6-6 与 Stage 8 使原设计完整落地） | 用户历次裁决（Stage 6-2 / 6-3 / 6-6 / Stage 7 / 8 / 9） |

> v1.1/v1.2/v1.3/v1.4 的所有改动分别用 `【v1.1】`/`【v1.2】`/`【v1.3】`/`【v1.4】` 标记。**契约修订须经批准**，不得就地改（原 §6.2 规则不变）。

### DR-008 执行条件（与预算同等效力）

1. **gzip 104 KB / raw 330 KB 是硬上限，不是目标值**【v1.5】（历史值见变更记录；v1.4–v1.5 前为 gzip 100 KB / raw 305 KB）。每个阶段必须报告 raw、gzip **实测字节数**与剩余空间。
2. **不得借调整预算之名继续膨胀**。优先使用原生 `fetch` / `ReadableStream` / `TextDecoder`，**不引入大型 SDK**。
3. **若仍超出上述硬上限：立即停止并报告**，不得自行放宽预算、删减核心可靠性机制、或静默放行。
4. **预算依据是最终构建产物的实际字节数**，不得用"压缩比"外推（3.74:1 是当前内容的实测值，不是对未来代码的保证）。

---

## 0. 结论摘要

| 决策项 | 结论 | 一句话理由 |
| --- | --- | --- |
| 交付形态 | 单 HTML（`AI-Tavern.html`），无运行时 CDN 依赖 | CDN 在国内会挂，评审双击本地文件也要能跑 |
| 开发形态 | `src/` 多文件 + 30 行零依赖 `build.js` 拼装 | 开发可维护 / 交付单文件，两者不冲突 |
| 前端框架 | Vue 3 global build（构建时内联），UI 层可替换 | 三个异步面板需要响应式；引擎层与框架解耦 |
| 样式方案 | 手写 CSS + Design Token，**不用 Tailwind CDN** | 视觉是定制的，Tailwind Play CDN 是 100KB 运行时且不可离线内联 |
| Agent 编排位置 | **客户端**（浏览器里跑 Agent Loop） | 思考过程必须可视化，编排在客户端每一步才是"真事件" |
| Worker 角色 | 密钥保管 + 路由 + 限流 + SSE 归一化，**不承载编排** | 密钥不暴露，但提示词/persona 应留在 HTML 里（评审要看） |
| LLM 主用 | DeepSeek（`deepseek-flash`，可选 `deepseek-v4-pro`）**【v1.2】** | 国内可直连；思考是**参数**而非模型；推理**度量**进思考面板，**原文不展示**（DR-009） |
| 记忆 | LocalStorage，双轨（情景摘要 + 语义事实）+ 打分检索 | 单用户量级不需要向量库；接口留好 embeddings 升级位 |
| 每轮 LLM 调用数 | Quick 1 次 / Deep **3 次**【v1.5】（生成 → 自检 → 抽取；评估阶段按决策四后置非阻塞） | 6 次串行调用 = 20~40 秒，会杀死 5 分钟体验 |
| 可视化原则 | **每个被画出来的步骤都必须对应一次真实计算或状态变更** | 这是本笔试真正被评分的东西，禁止假动画 |

---

## 1. 推荐最终技术架构

### 1.1 架构总览

```
┌──────────────────────── 浏览器：AI-Tavern.html（单文件） ────────────────────────┐
│                                                                                 │
│  View Layer        TavernWorld / ConversationRoom / TracePanel / MemoryBoard    │
│  (Vue 3)           / AgentGrowth / DevDrawer                                    │
│        ▲ watch / subscribe                                                      │
│  Store Layer       AppState（reactive） + actions + persistence（debounced）      │
│        ▲ emit                                                                    │
│  Engine Layer      TurnController（状态机）                                       │
│                    ├── CognitionService   （本地纯计算：意图 / 回答策略 / 模式建议）│
│                    ├── MemoryService      （retrieve / write / consolidate）      │
│                    ├── ToolRegistry       （dice, clock, wiki, inspo, ...）       │
│                    ├── PersonaService     （persona + 关系状态 + 记忆 → prompt）   │
│                    ├── Generator          （流式生成）                            │
│                    └── Evaluator          （自评 + 记忆提取 + XP，非阻塞）          │
│                          ▲                                                       │
│  TraceBus          统一事件流：step / token / memory:hit / tool:call / status     │
│                                                                                 │
│  GatewayClient     fetch + AbortController + 手写 SSE 解析器                      │
│  MemoryStore       LocalStorage Adapter（版本化 schema / 配额 / 降级为内存）        │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │  HTTPS · POST /v1/chat (SSE)
                                   ▼
┌──────────────────── Cloudflare Worker：tavern-api.<domain> ────────────────────┐
│  CORS 白名单 → 握手/令牌 → 限流 → 每日 Token 预算 → agentId 路由表 →            │
│  请求裁剪与上限 → 上游流式请求 → SSE 归一化 → 指标日志（不记正文）               │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   ▼
                   DeepSeek API（主） / OpenAI 兼容接口（备）
```

### 1.2 四个关键决策及理由

**决策一：Agent 编排放客户端，不放 Worker。**

这是整个架构里最重要的一个选择，因为它是产品目标倒推出来的：

- 本项目的核心卖点是"**让用户看见 Agent 在思考**"。如果编排在服务端，前端只能收到一个最终字符串，要么没有思考过程，要么只能靠假动画演——而假动画是这次笔试最容易翻车的地方。
- 编排在客户端后，"意图解析完成""命中 3 条记忆""调用了 dice 工具""自评 4.2 分"全都是真实发生的事件，UI 只是事件的投影。整个展示层变成纯函数式渲染，不需要任何表演。
- LocalStorage 记忆本来就在客户端，服务端编排反而要每轮把记忆全量上传，多一次往返、多一份隐私面。
- 唯一代价：提示词和 persona 在 HTML 里公开可见。对笔试而言这不是缺点——**Persona 工程本身就是被考察的能力**，把它藏起来等于把加分项删掉。

风险对冲：Worker 保留 `agentId → {provider, model, params}` 的路由表，所以换模型、调参、切供应商不需要重新构建 HTML。

**决策二：Worker 是"端点型"网关，不是裸代理。**

裸代理（把任意 body 转发给上游）等于把 API Key 交给全世界。设计成端点型：

- 客户端只能调用少量语义化端点（`/v1/chat`、`/v1/extract`、`/v1/health`、`/v1/tool/wiki`）。
- 每个端点有独立的 `max_tokens` 上限和允许的模型集合，客户端无法用 `/v1/extract` 去打一个大 completion。
- 上游响应统一归一化成**一种 SSE 事件格式**，前端只需要一个解析器，provider 差异被完全吸收。

**决策三【v1.1】：Provider 首选 DeepSeek；"思考"是参数而不是模型。**

v1.0 曾按 `deepseek-chat` / `deepseek-reasoner` 两个模型分工。**Stage 2-1 实测推翻了这个前提**：

- `GET /models` 实际只返回 **`deepseek-flash`**（V4.1-Flash，1M 上下文、384K 最大输出、支持图片输入）与 **`deepseek-v4-pro`**（V4-Pro，纯文本）。**`deepseek-chat` 与 `deepseek-reasoner` 已不在模型列表中。**
- 推理不再是独立模型，而是**参数**：`thinking: {type:'enabled'|'disabled'}` + `reasoning_effort: low|high|max`，且**默认开启、默认 high**。
- `reasoning_content` 仍然存在（仅 thinking 模式），仍然**先于正文到达**——它的价值是让我们给出**真实的推理度量**（首帧耗时、帧数、字节数、推理 token 数），而**不是**展示原文（见下方 DR-009 边界）。"真实"与"不越界展示"并不冲突。

**修订后的路由策略：默认单模型 + 模式显式配置 thinking**

| 模式 | model | thinking | max_tokens 下限 | 实测特征 |
| --- | --- | --- | --- | --- |
| 快速 | `deepseek-flash` | **显式关闭** | ≥ 600 | 945ms、无 reasoning 帧 |
| 深潜 | `deepseek-flash` | **显式开启** | ≥ 1500 | 2408ms、reasoning 194 tokens |
| 深潜（可选升级） | `deepseek-v4-pro` | 显式开启 | ≥ 1500 | 6463ms、reasoning 422 tokens；是否采用待 Stage 2 实测定 |

三条由此得出的硬约束（均来自实测）：

1. **不得依赖默认值**：不显式关闭 thinking，每轮默认 2.4 倍延迟、输出约 90% 是推理 token。
2. **`max_tokens` 必须给足**：实测 `max_tokens=300` + thinking 开启 → HTTP **200 但正文为空**（reasoning_tokens 恰好等于 300）。这是**静默失败**，客户端无法从状态码察觉。
3. **只允许 `json_object`**：实测 `json_schema` 返回 400 `unavailable now`。

其余不变：地域因素（OpenAI 在国内需代理且**大陆/港澳不在其支持地区列表**，故不采用；DeepSeek 直连）、以及成本量级——**成本数字按实测下调**：一轮快速约 60 输入 / 15~30 输出 token，一轮深潜约 40~60 输入 / 200~450 输出 token（其中约 90% 是推理）。v1.0 写的"2~4k 输入"是高估。

**【v1.2 / DR-009】reasoning 的展示边界（产品语义纠正）**

v1.0/v1.1 隐含了一个错误推断："`reasoning_content` 可以拿到" ⇒ "应该把它逐字显示给用户"。**这是错的**：原始思维链是模型的草稿纸，不是最终答案，也不应被当作面向用户的解释。

| 允许 | 禁止 |
| --- | --- |
| 展示**真实的思考进度**——即当前正在执行的真实阶段（理解请求／检索记忆／推理规划／生成回复），这些是事实描述，不是编造的模型心声 | 把 `reasoning_content` **逐字展示**给用户（含 Trace 面板正文） |
| 在 **Dev Drawer** 显示经过定义的**度量**：`reasoningTtft`、`contentTtft`、reasoning tokens、帧数、字节数 | reasoning 原文进入**聊天气泡**、**默认持久化**或**普通日志** |
| 在需要用户可读的解释时，使用**单独生成的摘要字段**（Stage 3+，由独立调用产出） | 直接把原始 reasoning 当作摘要转发 |
| reasoning 不可用时正常降级（不显示这一块） | **假装模型输出了思考过程**（空思考区、假进度条） |

落地方式：`sink.reasoning(delta)` 保留（内容确实在事件流里），但客户端**只提取度量、丢弃文本**——不渲染、不落库、不进日志。这正是"没有假步骤"红线在思考链上的对称要求：不演，也不越界展示。

**决策四：每轮调用压缩到 1~3 次，把"思考"从串行变成并行。**

原始流程写的是 6 个阶段串行，如果每个阶段都发一次 LLM 请求，用户要等 20~40 秒。实际设计：

- **【v1.3】CognitionService 改为本地纯计算**：`{intent, plan, suggestedMode, reasons}`，确定性、零网络、零成本（原设计为"一次 JSON 调用"，实测与实现表明本地即可胜任，且能保证"同输入同结论"）。记忆检索计划与工具选择**移出认知**（归 Stage 4 与工具层）。
- **本地能算的立刻算**：记忆检索、工具执行（dice/clock/inspo）都是纯本地毫秒级操作，它们的 trace 事件在发出第一个网络请求之前就已经真实产生了。用户 300ms 内就能看到面板在动。
- **生成阶段流式**：首字到达即开始打字，思考面板的事件按导演节奏回放——**回放的是已经真实发生的事件**，不是编的。
- **评估阶段后置**：回复落地之后才发第三次调用（自评 + 记忆提取 + XP），它永远不阻塞用户。

硬规则：**任何用户正在等待的东西，都不允许依赖 Evaluator 的结果。**

---

## 2. 前端架构设计

### 2.1 单文件内部的分层

`AI-Tavern.html` 内部用**顺序 IIFE 命名空间**组织，而不是一个巨型 script：

```html
<script>/* 1. CONFIG   */ Tavern.Config   = {...}  // persona、工具描述、文案、设计 token
</script>
<script>/* 2. CORE     */ Tavern.EventBus = {...}  // 无依赖
                          Tavern.MemoryStore = {...}
                          Tavern.Gateway = {...}
</script>
<script>/* 3. ENGINE   */ Tavern.Tools, Tavern.MemoryService, Tavern.Cognition,
                          Tavern.Persona, Tavern.Evaluator, Tavern.TurnController
</script>
<script>/* 4. STORE    */ Tavern.Store    = {...}
</script>
<script>/* 5. UI       */ Vue.createApp(Tavern.UI).mount('#app')
</script>
<script>/* 6. BOOT     */ Tavern.Boot.init()
</script>
```

依赖方向严格单向：`Config ← Core ← Engine ← Store ← UI ← Boot`，任何一层不得反向引用。导出面 `Object.freeze`。这样做的好处是评审用浏览器直接读文件时，从顶部注释就能看懂架构，而不用在 8000 行里找入口。

### 2.2 页面模块（Screen / Route）

| # | 模块 | 目标 | 关键内容 |
| --- | --- | --- | --- |
| 1 | **Entry（推门）** | 0~2s 建立沉浸感 | 标题卡 + "推开酒馆的门" 单一交互。这次点击同时解锁 WebAudio 手势策略，为后续环境音留口 |
| 2 | **Tavern World（选人）** | 10s 内"像完整产品" | Canvas 氛围层、三张 Agent 卡（肖像 SVG / 定位 / 实时状态环 / 擅长领域）、底部"今夜酒馆"滚动条（预设的环境事件文案，成本极低但让世界"活着"） |
| 3 | **Conversation Room（主场景）** | 1~5 分钟核心 | 三栏 RPG 布局，见下 |
| 4 | **Memory Board（记忆台）** | 5 分钟体验第三拍 | 记忆条目流（来源、强度条、写入/命中时间），命中时"记忆脉冲"动画；可手动编辑/删除（真实可控感，演示价值极高） |
| 5 | **Growth（成长档案）** | 收尾 | 等级/XP/亲密度/解锁特质、"认知档案"（由记忆汇总生成的自述）、Oracle 抽到的卡牌收藏 |
| 6 | **Dev Drawer（⌘/Ctrl+`）** | 面向工程型评审 | 每次 LLM 调用的原始 prompt/usage/延迟分解/JSON 原文 |

**Conversation Room 三栏结构（桌面上）**

```
┌──────────────┬───────────────────────────────────┬──────────────────────────┐
│ Agent 卡      │  对话流（流式打字 + 气泡）           │  Agent Trace（纵向时间轴）  │
│ · 肖像 SVG    │  · 用户气泡 / Agent 气泡            │  ○ 理解请求      ✓ 120ms  │
│ · 心情环      │  · 结构化"卡片"产物：计划卡 /        │  ○ 检索记忆      ✓ 命中 3  │
│ · Lv / XP     │    知识卡 / 灵感卡（可折叠、可复制）  │  ○ 推理规划      ● 进行中  │
│ · 亲密度      │  · 快捷意图 Chips                  │  ○ 工具调用      dice→4    │
│ · 技能条      │  · 输入框 + 模式开关（快捷/深潜）     │  ○ 生成回复      ▂▃▅ 流式 │
│              │                                   │  ○ 自我评估      ✓ 4.2/5  │
│              │                                   │  ── 每个节点可展开看原始 JSON │
└──────────────┴───────────────────────────────────┴──────────────────────────┘
```

窄屏（< 900px）降级：Agent 卡收到顶部横条，Trace 面板变成对话流下方的**可切换 Tab**（Trace / Memory / Status），不牺牲信息，只牺牲并置。

### 2.3 状态管理

不用 Pinia / Redux。一个 `reactive` 的 store + 显式 action + 防抖持久化：

```
AppState = {
  session:    { route, online, mode, bootedAt }
  agents:     { [agentId]: AgentRuntime }     // level/xp/mood/affinity/energy/talks/unlocked
  conversations:{ [agentId]: Message[] }
  summaries:  { [agentId]: { text, coversUpTo } }
  memories:   MemoryEntry[]
  trace:      { activeTurnId, steps[], tokens }
  ui:         { panel, drawers, animating, reducedMotion }
  settings:   { provider, temperature, deepMode, demoMode }
}
```

规则：

- 组件**只读** state，只调用 action（`actions.send(input)`、`actions.forget(id)`）；任何组件里不出现直接赋值。
- Engine 层不 import store，只往 `TraceBus` 发事件；Store 订阅 TraceBus 后写入 state。**这是引擎可测试、UI 可替换的关键切口。**
- 持久化按 slice 打标脏位，300ms 防抖，只写脏片；`visibilitychange`/`pagehide` 时强制 flush。
- 键名统一前缀 `tavern.v1.*`。**注意 GitHub Pages 是 `*.github.io` 共享 origin**，不命名空间化就可能和其他项目串数据。

### 2.4 数据结构（冻结契约）

```jsonc
{
  "schemaVersion": 1,
  "user": {
    "name": "", "background": "CS Student",
    "interests": ["AI", "Backend"], "traits": {}, "updatedAt": 0
  },
  "agents": {
    "bartender": { "level": 1, "xp": 0, "mood": "neutral", "affinity": 0,
                   "energy": 100, "talks": 0, "unlocked": [] }
  },
  "conversations": {
    "bartender": [ { "id": "m_1", "role": "user", "content": "", "at": 0,
                     "meta": { "mode": "deep", "intent": "planning" } } ]
  },
  "summaries": { "bartender": { "text": "", "coversUpTo": 0 } },
  "memories": [
    { "id": "mem_1", "agentId": "bartender", "type": "preference|fact|goal|event",
      "text": "用户偏好后端方向", "tags": ["career"], "strength": 0.6,
      "createdAt": 0, "lastHitAt": 0, "hits": 2, "source": "turn:12" }
  ],
  "meta": { "lastVisit": 0, "streak": 0, "totalTurns": 0, "tokensUsed": 0 }
}
```

**配额与淘汰**（LocalStorage 上限约 5MB，实际按 200KB 预算）：记忆上限 120 条、每个 Agent 消息上限 80 条、超过则触发 consolidate（旧消息 → 摘要文本，低强度记忆按 `strength × recency` 淘汰）。超限或写入失败时逐级降级：裁剪 → 转内存模式 → 顶部提示条，绝不白屏。

**Trace 事件契约（Engine ↔ UI 唯一接口）**

```
trace:turn:start   { turnId, agentId, mode }
trace:step         { turnId, stepId, status: pending|active|done|skipped|error, ms?, detail? }
trace:token        { turnId, kind: content|reasoning, delta }
trace:memory:hit   { turnId, ids[], scores[] }
trace:memory:write { ids[] }
trace:tool:call    { name, args, result, ms }
trace:status       { agentId, patch: { mood?, energy?, xp?, affinity? } }
trace:turn:end     { turnId, usage, latencyMs: {cognition, ttft, total, eval} }
```

前端所有可视化都只消费这些事件。事件名一旦冻结，UI 和引擎可以并行开发——这条是让后续 vibe coding 不失控的核心保险。

---

## 3. Agent Engine 设计

### 3.1 模块划分

| 模块 | 职责 | 是否调 LLM | 是否阻塞回复 |
| --- | --- | --- | --- |
| `TurnController` | 一轮对话的状态机与总编排，持有 `AbortController` | 否 | — |
| `CognitionService`【v1.3】 | 意图识别、**回答策略**规划、模式建议（本地纯计算，确定性） | **否** | 是（<1ms） |
| `MemoryService` | 检索打分、写入、冲突合并、摘要压缩 | 否（consolidate 时是） | 否 |
| `ToolRegistry` | 工具注册表，统一 `{name, description, schema, run(args)}` | 否 | 否 |
| `PersonaService` | persona spec + 关系状态 + 心情 + 命中记忆 → system prompt | 否 | 否 |
| `Generator` | 流式生成可见回复 | 是（流式） | 是 |
| `Evaluator` | 自评打分、抽取值得记忆的事实、发放 XP | 是 | **否（后置）** |
| `TraceBus` | 类型化事件总线 | 否 | 否 |

### 3.2 状态机与调用流程

```
idle
 └─(用户输入 / 快捷 Chip)→ parsing
      ├─ 本地同步：情绪/能量预估、输入规范化、注入 user profile   [trace:step ✓ 瞬时]
      ├─ MemoryService.retrieve(queries)  ← 本地打分            [trace:memory:hit ✓ ~1ms]
      ├─ ToolRegistry 预执行确定型工具（dice/clock）              [trace:tool:call ✓ ~0ms]
      ↓
   recalling → planning        ← CognitionService【v1.3】本地纯计算（零网络，<1ms）
      ↓  产出 { intent, plan[], toolCalls[], deep, replySketch }
   acting                      ← 执行剩余工具（wiki 等网络工具）  [trace:tool:call]
      ↓
   composing                   ← PersonaService 组装 prompt
      ↓
   streaming                   ← Generator 流式 token → trace:token
      ↓ （回复落地，UI 解锁输入框）
   reflecting                  ← Evaluator（异步，可被下一轮打断）
      ├─ trace:status 更新 mood/energy/xp
      ├─ MemoryService.write(新事实)
      └─ trace:turn:end
   done | degraded | error
```

`degraded` 是**一等状态**，不是异常分支：任何一步失败都降级继续，并在 Trace 面板上把该步骤标成 `skipped` 并写明原因（例如"知识检索超时，本次凭已有知识回答"）。宁可显示"这一步没做成"，也不要假装做成。

### 3.3 两个模式与自动策略

| 模式 | 调用次数 | 延迟目标 | thinking 配置【v1.1】 | 触发条件 |
| --- | --- | --- | --- | --- |
| **Quick** | 1（直接流式生成） | 可见首字 ≤ 1.2s，整体 ≤ 6s | **显式 `disabled`**，`max_tokens ≥ 600` | 寒暄、闲聊、追问细节 |
| **Deep** | 3（认知 → 生成 → 反思） | 认知 ≤ 3s，可见首字 ≤ 1.5s（生成阶段） | **显式 `enabled` + effort `high`**，`max_tokens ≥ 1500` | 意图 ∈ {plan, decide, analyze}，或 Agent=bartender，或用户手动开启"深潜模式" |

**【v1.1】延迟目标按实测校准**：深潜模式下**推理首帧约 0.6s、可见正文首帧约 2.2s**（实测 `deepseek-flash`）。因此"首字"必须区分两种语义——`reasoningTtft`（模型开始推理的时刻）与 `contentTtft`（用户开始读到答案的时刻）。思考面板展示的是**真实阶段进度**（理解请求／生成回复…），`reasoningTtft` 则是"模型确实在推理"的度量证据；两者都不涉及展示推理原文（DR-009）。1500 这个 `max_tokens` 下限是**插值推断**（300 实测失败、2000 实测成功），需在 Stage 2 实测确认。

模式在 UI 上显式可见、可强制切换。用户能感知到"我刚才让它深思了一次，而且它真的多花了时间"——这个可感知的成本差本身就是"真实 AI 感"的来源。

### 3.4 三个 Agent 的真实差异（不能只是换 prompt 文案）

| Agent | 工具集 | 输出产物 | 差异化机制 |
| --- | --- | --- | --- |
| **Bartender** 规划 | `dice`（决策骰，**带理由**）、`clock`（时间预算）、`task_break` | **计划卡**：结构化 checklist，可勾选可导出 | **【v1.1】以深潜模式运行**（`thinking:enabled`），推理**度量**（`reasoningTtft`／推理 token 数）进思考面板，**原文按 DR-009 丢弃**；维护"用户长期目标"记忆并主动回访 |
| **Oracle** 知识 | `wiki_lookup`（真实网络检索）、`memory_search`（事实权重更高）、`summarize` | **知识卡**：带来源、置信度、以及明确的"我不确定的部分" | 必须给出来源；置信度低时主动声明不确定，这是"诚实 Agent"的展示位 |
| **Muse** 创意 | `inspo_seed`（随机词/意象/约束）、`rhyme_bank`、`constraint_gen` | **灵感卡**：3 个变体 + 风格标签 + 约束滑杆重生成 | 用随机种子驱动多样性，同一 prompt 多次生成结果差异可验证 |

工具实现：除 `wiki_lookup` 走 Worker 代理（或直连 Wikipedia REST API，需验证 CORS）外，其余都是 HTML 内纯函数。**每个工具的 `args` 与 `result` 必须在 Trace 面板可展开查看**——工具调用被看见，才叫 Agent，不叫聊天机器人。

---

## 4. API 架构设计

### 4.1 端点

| 方法 | 路径 | 用途 | 备注 |
| --- | --- | --- | --- |
| POST | `/v1/chat` | 主对话，SSE 流式 | 按 `agentId` + `mode` 路由模型 |
| POST | `/v1/extract` | 小 JSON 任务（自评/记忆抽取） | `max_tokens` 硬上限 400，便宜模型 |
| GET | `/v1/health` | 客户端开机探活 | 决定进入在线/离线模式 |
| POST | `/v1/handshake` | 签发短时令牌（Stage 3+） | 可选，防脚本盗刷 |
| GET | `/v1/tool/wiki?title=` | Wikipedia 代理 + 边缘缓存 1h | 可选，视 CORS 实测结果 |

### 4.2 请求 / 响应

```jsonc
// POST /v1/chat
{ "agentId": "bartender", "mode": "deep", "stream": true,
  "task": "cognition|generate",                       // 同一端点两种任务，路由不同模型
  "messages": [ { "role": "system|user|assistant", "content": "..." } ],
  "client": { "v": 1, "turnId": "t_18" }              // 用于指标关联，不含用户正文
}
```

**归一化 SSE（单一格式，前端只有一个解析器）**

```
data: {"type":"reasoning","delta":"先确认用户诉求..."}
data: {"type":"content","delta":"好，我们"}
data: {"type":"usage","prompt":58,"completion":213,"reasoning":192,"cached":0,
       "finishReason":"stop","truncated":false,"empty":false}        【v1.1】新增四个字段
data: {"type":"error","code":"upstream_timeout","retryable":true,
       "httpStatus":504,"requestId":"…","message":"…"}               【v1.1】新增三个字段
data: [DONE]
```

**【v1.1】为什么把 `finishReason/truncated/empty` 放进 `usage` 帧**：与 usage 同一次响应可得，少一个帧类型就少一个客户端分支。错误帧新增 `httpStatus`/`requestId`/`message`，是为了让客户端的错误归一化（见 `stage-2-gateway-contract.md` §3）有据可依。**均为加性扩展，旧客户端忽略未知字段即可。**

### 4.3 Worker 内部管线

```
OPTIONS 预检 → Origin 白名单校验 → 令牌校验 → 限流（IP + 令牌双维度）
  → 每日 Token 预算检查 → schema 校验 + 字段白名单 + 长度上限
  → agentId/mode → {provider, model, params} 路由 → 上游流式请求
  → SSE 归一化（含错误映射）→ 指标日志（仅计数/延迟/token，绝不落正文）
```

- **CORS**：只回声白名单内的 Origin，`Allow-Headers: content-type, authorization`，预检缓存 24h。
- **密钥**：`wrangler secret put LLM_API_KEY`，代码与 HTML 中零出现；交付后**轮换一次**。
- **预算护栏【v1.1 修订】**：每日 token 上限计数。v1.0 写的"每请求写 KV"**不可行**——Cloudflare 免费额度下 KV 只有 **1000 写/天**（读 100K/天），按每请求一次写，1000 次请求后护栏本身先失效。改为 **isolate 内存聚合 + 每 ≥60s 或每 N 次落盘一次**，或改用 Durable Object（免费 100K 请求/天）。耗尽时返回 429 + `{"degraded":"budget"}`，前端自动切离线剧本模式并挂出提示条。公开链接被刷不至于烧钱或白屏。
- **中断处理**：客户端 `AbortController` 取消时，Worker 需停止上游读取并释放连接（新回合打断旧回合是常态）。
- **部署**：Worker 绑自定义域名 `tavern-api.<yourdomain>`，**不要用 `*.workers.dev`**——该子域在国内可达性不稳定，评审点开就是白屏。HTML 部署到 Cloudflare Pages（或 GitHub Pages），并把最终 origin 加进白名单。

---

## 5. 单 HTML 实现风险与解决方案

### 5.1 风险登记表

| # | 风险 | 影响 | 概率 | 解决方案 |
| --- | --- | --- | --- | --- |
| R1 | CDN 在国内被墙/超时（Vue、字体、Tailwind CDN） | 页面直接白屏 | **高** | 构建时把 vendor 代码**内联进 HTML**，运行时零 CDN；字体只用系统栈（`PingFang SC / Microsoft YaHei / Noto Sans SC`），显示字体仅 latin 子集 base64 内联 |
| R2 | `workers.dev` 国内不可达 | AI 全挂 | 中 | 绑自定义域名；`/v1/health` 探活失败即切离线模式，页面仍然完整可演示 |
| R3 | 评审双击本地文件打开（`file://`，Origin 为 `null`） | fetch 被 CORS 拒 | **高** | 检测协议：非 http(s) 时顶部提示"请通过链接访问以启用 AI"，同时完整运行离线演示；白名单**不放行 `null`**（放行等于对任何本地文件开放） |
| R4 | 单文件体积失控（>1MB、难以维护） | 交付质量与迭代速度崩 | 高 | `src/*` 开发 + `build.js` 拼装；CSS/JS 分文件但每个文件有 banner 注释；交付目标 **≤ 305 KB（gzip 后 ≤ 100 KB）【DR-008：v1.2 90→95KB；v1.4 现行 100/305KB，硬上限】**；构建脚本**超标即拒绝 release**，只有显式 `--allow-over-budget` 才能产出且产物内记录偏差；每阶段报告实测字节与余量 |
| R5 | LLM 返回非法 JSON（Cognition/Evaluator） | 该轮流程断裂 | **高** | JSON mode + 容错解析四级降级：`JSON.parse` → 剥 ``` 代码块 → 花括号配平扫描 → 正则兜底 → 仍失败则将该步标 `skipped` 继续；一次修复重试 |
| R6 | 首字延迟过长（reasoner 尤其明显） | 用户以为卡死 | 高 | 本地 trace 步骤即时可见（记忆检索/工具毫秒级真实发生）+ 骨架 shimmer + 8s 看门狗提示"改用快速模式"；生成阶段必须流式 |
| R7 | SSE 解析边界（分块切断 `data:`、CRLF、keep-alive 注释、`[DONE]`） | token 丢字/死循环 | 中 | 手写增量 buffer 解析器，保留未完成行；Worker 侧设 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no` |
| R8 | LocalStorage 不可用/被清/超额（Safari 隐私模式） | 记忆全丢或写失败 | 中 | Adapter 全 try/catch + 配额探测 + 逐级降级（裁剪→内存模式→提示条）；schema 版本化 + 迁移函数；导出/导入 JSON 兜底 |
| R9 | Canvas + `backdrop-filter` 性能拖垮低端机 | 掉帧、风扇狂转 | 中 | 粒子 ≤ 300、无逐帧分配、`transform/opacity` only、慎用大面积 blur；帧时间探针自动降级"低性能模式"；`visibilitychange` 暂停；遵守 `prefers-reduced-motion` |
| R10 | 移动端三栏布局崩坏 | 手机评审体验差 | 中 | < 900px 转 Tab 布局；点击区 ≥ 44px；`100dvh` 替代 `100vh`；无 hover-only 交互 |
| R11 | 公开链接被刷 / 成本失控 | 烧钱、被停用 | 中 | 限流 + 每日预算 + 429 后自动离线模式；密钥可随时轮换 |
| R12 | 提示注入（用户输入"忽略以上指令"） | persona 崩坏人设 | 中 | 角色边界块 + 工具结果用 `<untrusted>` 包裹 + Evaluator 检查 personaFidelity 并在 UI 上标注"人设漂移"（**把它变成展示项而不是漏洞**） |
| R13 | 每次重建都要重新填 Key / 重新贴代码 | 迭代缓慢 | 中 | `build.js` 从 `.env.local`（gitignore）注入本地开发配置；仓库内永不含密钥 |
| R14 | 工期超预期，视觉与功能互相挤占 | 交不出完整作品 | **高** | 视觉系统在 Stage 1 冻结（设计 token 定稿后不改）；MVP 清单外的一切进 Stage 6 拉伸池 |

### 5.2 三条不可协商的工程红线

1. **密钥不进 HTML，不进仓库，交付后轮换。**
2. **没有假步骤**：任何展示出来的思考步骤，背后都必须有真实计算或真实状态变更；做不到就显示 `skipped` 并说明原因。
3. **永远有下一步**：任何失败路径都要有可见降级（离线模式、快速模式、重试），页面不允许出现无响应状态。

---

## 6. 后续 Stage 划分建议

| Stage | 名称 | 交付内容 | 验收门（Gate） |
| --- | --- | --- | --- |
| **0** | 架构与契约（本文档） | 架构文档、接口契约、风险登记表、设计 token 草案、MVP 清单冻结 | 契约签名冻结；三个 Agent 的 persona 初稿可评审 |
| **1** | 骨架与设计系统 | `build.js` 单文件流水线、路由/布局壳、Canvas 氛围层、三张 Agent 卡（**mock 数据**）、入场动画 | **零 AI 也像完整产品**（10s 体验达标）；构建产物单文件且离线可用 |
| **2** | 网关与流式对话 | Worker 部署 + 自定义域、`/v1/health`、`/v1/chat` 流式、**上游 SSE 解析与错误归一化（在 Worker 侧）**、快速/深潜模式（显式 thinking）、错误降级阶梯、Dev Drawer | 见 `stage-2-gateway-contract.md` §7.3（含 **G1~G9 九组**验收：流式／推理度量与正文分流（**不展示原文**）／真实 usage／六种故障降级／空正文与截断／中止释放连接（**上游侧证据**）／密钥不可搜／展示边界／能量恰扣一次）<br>~~reasoner 约束冒烟实测~~ **【v1.1】已于 Stage 2-1 完成，结论见 §1.2 决策三** |
| **3** | Agent Engine 与 Trace 可视化 | **CognitionService（3-1 已完成：本地纯计算）**、MemoryService、ToolRegistry、TraceBus、Trace 时间轴、Deep 模式、三类产物卡片 | 思考步骤全部为真实事件；每一轮都能在 Dev Drawer 复现完整的调用链（认知步骤为本地确定性计算，LLM 调用 2 次） |
| **4** | 记忆与成长 | 持久化 + 迁移、记忆台、命中脉冲、摘要压缩、XP/等级/亲密度、首访播种（3 条预设记忆让评审第一轮就有上下文）、导出/导入 | 关掉页面再打开，Agent 记得上一轮的事；记忆可手动增删且立即生效 |
| **5** | 打磨与交付 | 性能与移动端、无障碍、离线剧本模式、低性能模式、交互文案终稿、部署与链接、`README` + 3 分钟演示脚本、密钥轮换、最终内联构建 | 链接在手机/桌面/国内网络三处实测通过；单文件 < 300KB；README 含架构图 |
| **6** | 拉伸（仅在富裕时做） | WebAudio 环境音、embeddings 记忆检索、三 Agent 同场对话、夜间事件演化、导出"我的酒馆卡"图片 | 每项独立，任一项可砍不影响交付 |

### 6.1 评审视角的反向设计（把交付物当作品打）

- **10 秒**：入场动画 + 三张有性格的 Agent 卡 + 环境在动。零文字也能看出"这是个产品"。
- **1 分钟**：发第一句话，右侧时间轴开始逐条点亮，用户立刻理解"这是 Agent 不是聊天框"。
- **5 分钟**：完成一次深潜模式（看到真实的推理度量与阶段进度）→ 打开记忆台看到刚被写入的记忆 → 看到 Agent 涨了 XP。三拍闭环。
- **额外一击：`?tour=1` 架构导览模式**——页面自己逐步高亮并解释「这里是 Persona 层 / 这里是记忆检索 / 这里刚刚发生了第 2 次 LLM 调用」。**一个能自我讲解架构的作品，在笔试里几乎没有对手。**建议排进 Stage 5。

### 6.2 每个 Stage 的固定动作

1. 结束即产出可截图/录屏的成果（这是真实进度，不是"代码写了"）。
2. 更新风险登记表：关闭的划掉，新发现的补上。
3. 一份 200 字以内的"本阶段决策与取舍"记录，用于面试口述。
4. 任何契约变更都要同步改本文档并标注版本——**契约漂移是这类项目在 vibe coding 下失控的头号原因。**

---

## 附录 A：技术选型否决清单（面试可直接引用）

| 候选 | 否决理由 | 何时该翻案 |
| --- | --- | --- |
| LangChain.js / LangGraph | 依赖体积大；它把 Agent Loop 封装成一个黑盒，而**这个 Loop 恰恰是本作品要展示的主体**；单文件内联困难、调试不透明。自研 Loop 约 200 行，全流程可观测 | 需要复杂多 Agent 图、并行分支、持久化工作流时 |
| React + Vite | 无技术问题，但为 6 个面板引入完整工具链，且最终仍要对抗"产出单 HTML"的约束。收益 < 成本 | 项目扩展到多页面/多人协作 |
| Tailwind Play CDN | 100KB+ 运行时 JIT，官方明确不建议生产；本作品视觉高度定制，实用类收益低；且运行时 CDN 违反 R1 的离线要求。手写 CSS + Token 反而更快更可控 | 引入正规构建（Tailwind CLI 预编译）时——但那已不是单文件场景 |
| 服务端 Agent 编排 | 思考过程无法真实可视化（见 §1.2 决策一） | 需要保护提示词 IP 或做多用户配额时 |
| IndexedDB | 异步 API + schema 管理成本翻倍；单用户数据量（≤200KB）用不上 | 记忆 > 2000 条或需要存二进制 |
| 向量检索 / embeddings | 单用户几百条记忆下，关键词 + 标签 + 时间衰减 + 强度的打分检索已足够且零网络调用；embeddings 引入新网络依赖与新失败面。MemoryService 接口已与检索实现解耦 | Stage 6 拉伸，或记忆规模上千 |
| 用户系统 / 数据库 / 多人 | 超出 MVP 边界，且不服务于"展示 Agent 理解"这一目标 | 不做 |

## 附录 B：视觉系统（Stage 1 冻结）

关键词 **Cyber Fantasy Tavern** = 奇幻酒馆的材质感 × AI 的冷光 × RPG 的信息密度。

- **色彩**：深木/暗铜为底（`#120c0a`、`#1d1512`、`#3a2a20`），霓虹魔法为强调（青 `#5fe3d4`、紫 `#a482ff`、琥珀 `#ffb45c`）；三 Agent 各有主色，贯穿卡片、气泡、思考轴。
- **材质**：宣纸噪点（SVG feTurbulence）、暗角晕影、烛光呼吸（非匀速缓动的强弱变化，比线性闪烁自然得多）。
- **动效**：入场"推门"+ 光溢出；面板滑动用 `cubic-bezier(.2,.8,.2,1)`；流式文字带光标；记忆命中时从记忆台向对话流拉一条光脉冲。**所有动效都必须可被 `prefers-reduced-motion` 关闭。**
- **角色**：不使用外部图片（体积/版权/离线三重风险）。三名 Agent 用**手写内联 SVG 剪影 + 分层渐变光晕**，配合状态环与呼吸动画，风格统一且零资源风险。
- **信息密度**：像 RPG 而不像聊天页——状态条、等级、能量、稀有度、卡牌边框、数值跳动。这是与"ChatGPT 复制页"最直观的分界线。
