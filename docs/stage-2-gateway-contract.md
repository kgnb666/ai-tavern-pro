# Stage 2 网关契约（实施前审查稿）

> **版本** `g1.1` · 2026-10-13 · **状态：已批准，进入实施**
>
> **决策记录**
> | 编号 | 决定 | 生效范围 |
> | --- | --- | --- |
> | **DR-008** | gzip 预算 90 KB → **95 KB**（**硬上限，非目标值**；raw 300 KB 不变）。**（v1.4 起现行：gzip 100 KB / raw 305 KB，见 stage-0 变更记录）** 条件：每阶段报告实测字节与余量；不得借机膨胀；优先原生 `fetch`/`ReadableStream`/`TextDecoder`，不引入大型 SDK；超出即**停止并报告**，不得自行放宽、不得删减核心可靠性机制、不得静默放行；预算依据是**最终产物的实际字节**，不得用压缩比外推 | stage-0 v1.2 §5.1 R4 + `build.js` BUDGET（v1.4 预算修订） |
> | **DR-009** | `sink.reasoning(delta)` **批准为可选加性扩展**；同时**修正产品语义**：原始思维链**不展示、不持久化、不进普通日志**。可展示的是**真实阶段进度**与**Dev Drawer 中的定义化度量** | 本文档 §1.2 / §2 / §7.2 |
> **依赖**：`stage-0-architecture.md` **v1.1**（§1.2 已按本阶段批准的修订更新）· `persona-spec.md` p1.0 · `design-token.md` t1.0
> **本次授权范围**：契约修订、实施前审查、必要的设计文档更新。**不含** Worker 开发、真实模型调用、部署。
> **本文档是 Stage 2 的开发前置契约**：未经批准不开始实现。

---

## 0. 先报告：现有代码与任务描述的差异（以实际代码为准）

审查了 `src/core/provider.js`、`src/core/turn.js`、`src/core/eventbus.js`、`src/core/store.js`、`src/providers/mock.js`。以下为**实测差异**，不是假定：

| 编号 | 差异 | 实际情况 | 影响 |
| --- | --- | --- | --- |
| **D1** | `provider.js` 的 sink 文档只列了 5 个方法（`phase/chunk/memory/status/final`），**实际有 6 个**——`sink.tool` 已在 `turn.js` 中实现且 `mock.js` 正在使用 | 文档滞后于实现 | 属文档缺陷，本次一并修正；不影响运行 |
| **D2** | 文档的 request 结构未列 `signal`，但 `turn.js` 实际会传入 `AbortController.signal`，`mock.js` 已在用 | 文档滞后 | 同上 |
| **D3** | **`mode` 是硬编码的**：`turn.js` 在 `ctx.mode` 与 `request.mode` 两处写死 `'deep'` | 「快速／深潜」目前**没有任何管线** | 任务 A 的两模式设计需要新增透传（小改动，但要动 `turn.js`） |
| **D4** | `mock.js` 的状态增量**硬编码 `energy: -8`**，注释写「完整管线 = deep」 | 若 mode 变成变量，快速轮会报出错误的能量增量（persona-spec §1.5 规定快速 −3） | 引入 mode 后必须同步给 mock 加分支，否则违反 §1.5 |
| **D5** | `trace:token` 的冻结契约本就支持 `kind: 'content' \| 'reasoning'`，但代码**只发过 `content`**；`ctx.ttft` 记的是"首个 content 分块" | 没有任何 reasoning 通道 | 需新增 `sink.reasoning`（见 §1.2）；且 `ttft` 语义需拆成两个 |
| **D6** | `trace:turn:end` 的 `usage` 只有 `{chars, chunks, tokensEstimated}`（mock 无真实 token） | 真实模型能拿到真 token 数，但没有承载字段 | 需要加性扩展（见 §1.4） |
| **D7** | `turn.js` 的错误处理只区分 `AbortError` 与"其它"，`meta.error` 是**字符串** | 无法区分超时／HTTP 错误／限流／断流 | 需引入错误分类（见 §3） |

**未发现与冻结契约冲突的地方**：TraceBus 的 8 个事件名与 payload 结构、Store 的切片、`core/turn.js` 作为唯一桥接层，均与 Stage-0 一致。

---

## 1. Provider 接口与 Gateway 契约【任务 B】

### 1.1 现有 sink 面（实测，6 个方法）

| sink 方法 | 现有行为（`turn.js`） | Stage 2 是否改动 |
| --- | --- | --- |
| `phase(phase, status, detail)` | 阶段名 → 冻结事件映射；边界阶段走 `trace:turn:start/end` | 不改 |
| `chunk(delta)` | 首块到达时建气泡；发 `trace:token{kind:'content'}`；累计 chars | 不改 |
| `memory(hits, meta)` | 落 `trace.meta.memoryCheck`；命中发 `trace:memory:hit` | 不改 |
| `tool(call)` | 插 `tool.call` 步骤；发 `trace:tool:call` | 不改 |
| `status(patch)` | `Store.applyStatusPatch` + `trace:status` | 不改（mock 需加 mode 分支，见 D4） |
| `final(replyText, meta)` | 落消息 meta；无内容时留显式空回复 | 加性扩展 meta 字段 |

### 1.2 需要新增的最小能力：`sink.reasoning(delta)`

**建议（纯加性，兼容既有实现）**

```
sink.reasoning(delta: string)     // 可选方法：Provider 不实现则完全不产生 reasoning 事件
```

**影响分析**

| 层面 | 影响 | 是否触碰冻结契约 |
| --- | --- | --- |
| `core/turn.js` | 新增 `sink.reasoning` 分支，但**只累加度量**（帧数／字节数／首帧耗时），**不发任何承载原文的事件** —— 端到端不产生按帧的 reasoning 事件 | **否**，且比 v1.0 方案更保守：原文根本不进 TraceBus，少一处可能被误显示／误持久化的面 |
| 消息存储 | **【DR-009 修正】不写入任何持久化字段**。只累积**度量**：`reasoningBytes`、`reasoningFrames`、`reasoningTtft`（首帧耗时）。原文随事件流到达即丢弃 | 否 —— 且**不新增 meta 字段**，比 v1.0 的方案更轻 |
| UI | Stage 2 **不新建面板、不显示原文**：在「生成回复」步骤的展开区显示**度量**（推理帧数／字节数／首帧耗时／推理 token 数，后者来自 usage 帧） | 否 |
| `MockProvider` | **不实现该方法 → 行为与现在完全一致**（现有 33 项测试零回退） | 否 |
| 体积 | 客户端约 +0.4 KB raw | — |

**替代方案（未采用）**：新增一个 `trace:reasoning` 事件 —— 会新增冻结事件名，需要 Stage-0 协议修订，收益为零。**不采用。**

### 1.3 请求契约（客户端 → Worker）

沿用 Stage-0 §4.1 的端点型设计，**客户端不指定模型**（模型策略在服务端，避免客户端成为策略真源）：

```jsonc
POST /v1/chat
{
  "agentId": "bartender|oracle|muse",
  "mode":    "quick|deep",              // 由 GatewayProvider 显式传入，不得依赖默认值
  "task":    "cognition|generate|extract",
  "stream":  true,
  "messages": [ { "role": "system|user|assistant", "content": "..." } ],
  "client":  { "v": 1, "turnId": "turn_xxx" }   // 仅用于日志关联，不含用户正文
}
```

**Worker 侧路由表（服务端唯一真源，初值来自 Stage 2-1 实测）**

| mode | model | thinking | reasoning_effort | max_tokens 下限 | 实测依据 |
| --- | --- | --- | --- | --- | --- |
| `quick` | `deepseek-flash` | `{type:'disabled'}` | 不设置 | **≥ 600** | 实测 945ms、json_object 可解析、无 reasoning 帧 |
| `deep` | `deepseek-flash` | `{type:'enabled'}` | `high`（默认） | **≥ 1500** | 实测 2408ms、reasoning 194 tokens、json_object 可解析 |
| `deep`（可选升级） | `deepseek-v4-pro` | `{type:'enabled'}` | `high` | ≥ 1500 | 实测 6463ms、reasoning 422 tokens；**是否采用待 Stage 2 实测定** |

- **`reasoning_effort` 只在 thinking 开启时设置**，且只在 `/models` 报 `effort.supported_levels` 含该值时设置（当前为 `low|high|max`）。
- **`max_tokens` 是"最低保护阈值"，不保证任务完成**：实测 `max_tokens=300` + thinking 开启 → HTTP 200 但**正文为空**（推理吃光预算，`reasoning_tokens` 恰好等于 300）。1500 这个下限是**插值推断**（300 失败、2000 成功），**需在 Stage 2 实测确认**，不是已测结论。
- **双层强制**：客户端 GatewayProvider 与 Worker 都强制下限（防御性冗余）。
- 结构化 JSON 一律 `response_format: {type:'json_object'}`；**`json_schema` 实测返回 400 `unavailable now`，禁止使用**。

### 1.4 响应契约（Worker → 客户端，归一化 SSE）

沿用 Stage-0 §4.2 的四类帧，**仅做加性扩展**（旧客户端遇未知字段应忽略）：

```
data: {"type":"reasoning","delta":"…"}
data: {"type":"content","delta":"…"}
data: {"type":"usage","prompt":58,"completion":213,"reasoning":192,"cached":0,
       "finishReason":"stop","truncated":false,"empty":false}       ← v1.1 新增字段
data: {"type":"error","code":"upstream_timeout","retryable":true,
       "httpStatus":504,"requestId":"…","message":"…"}              ← v1.1 新增字段
data: [DONE]
```

**为什么把 `finishReason/truncated/empty` 放进 `usage` 帧而不是新增 `done` 帧**：少一个帧类型 = 客户端少一个分支；且这三个字段与 usage 同时可得（同一次上游响应）。**替代方案**（新增 `{"type":"done",…}`）帧无额外收益，不采用。

### 1.5 GatewayProvider 的职责边界

| 做 | 不做 |
| --- | --- |
| 组装请求、维护 `AbortController`、超时 | 不拼 prompt（由 PersonaService 负责） |
| 消费归一化 SSE，分发到 sink | **不做上游 SSE 解析**（在 Worker 侧，见 §5 体积论证） |
| 检测 `finishReason/truncated/empty` 并上报 | 不判断业务语义（意图/记忆） |
| 把错误归一化成结构化对象后抛出 | 不直接操作 Store / UI（`turn.js` 是唯一桥） |
| 探活 `/v1/health` 的能力（由 boot 调用） | 不持有密钥（浏览器永远不知道密钥） |

---

## 2. thinking 与正文流的处理方案【任务 B·3】

### 2.1 两条路径的实测特征（Stage 2-1 数据）

| 特征 | 快速（thinking 关） | 深潜（thinking 开） |
| --- | --- | --- |
| 首字（可见正文） | 945ms 级 | **2214ms**（实测） |
| 首个 reasoning 帧 | 无 | **592ms**（实测） |
| 整轮 | 1.0~3.0s（抖动主导） | 1.8~2.5s（flash）／6.5s（v4-pro） |
| 输出 token 构成 | 全部是正文 | **约 90% 是推理**（实测 212/235） |
| `reasoning_content` | 字段不存在 | 独立字段，先于 content 到达 |

### 2.2 客户端分流规则

```
收到 type=reasoning → sink.reasoning(delta) → **只累加度量（帧数/字节/首帧耗时）** → 原文立即丢弃
                     （不入 Store、不入日志、不发承载原文的事件、不渲染）
收到 type=content    → sink.chunk(delta)    → trace:token{kind:'content'} → 气泡（唯一来源）
```

**硬规则（DR-009 强化）**

1. **reasoning 永远不得渲染进回复气泡**：气泡内容必须是 `content` 的唯一来源。
2. **reasoning 原文也不得逐字渲染到任何用户可见区域**（含 Trace 面板正文）——它是模型的草稿纸，不是解释。
3. 用户看到的"思考进度"是**真实阶段名**（理解请求／检索记忆／推理规划／生成回复），描述的是**当前确实在执行的事**，不是编造的模型心声。
4. reasoning **不可用时正常降级**：不渲染这一块。**绝不显示空思考区或假进度条**。
5. 需要用户可读的解释时，走**单独生成的摘要字段**（Stage 3+ 由独立调用产出），不做原文转发。

### 2.3 TTFT 拆成两个语义（修正 D5）

| 指标 | 定义 | 用途 |
| --- | --- | --- |
| `reasoningTtft` | 首个 reasoning 帧耗时 | 证明"用户多快看到有东西在动" |
| `contentTtft` | 首个 content 帧耗时（= 现在的 `ctx.ttft`） | 用户真正开始读到答案的时间 |

两个都写进 `trace:turn:end.latencyMs`（加性字段）。UI 上"首字延迟"标签改为区分显示，避免把 592ms 说成"首字"。

### 2.4 空正文与截断的判定与展示

| 判定 | 条件 | 步骤状态 | 用户可见 |
| --- | --- | --- | --- |
| 正常 | `finishReason='stop'` 且 content 非空 | `done` | 正常气泡 |
| **截断** | `finishReason='length'` 且 content 非空 | `done` + `detail.truncated` | 气泡尾部「回答被截断」chip |
| **空正文** | content 为空（无论 finishReason） | **`skipped`** + 原因「上游未产出正文：`finishReason=length`，token 预算不足」 | 不显示空气泡；消息位留显式说明 |
| 断流 | stream 结束无 `[DONE]` | `skipped` + 原因「连接中断，已收到 N 字」 | 保留已收到文本 + 「未完成」chip |

**为什么用 `skipped` 而不是新增状态**：冻结的步骤状态集是 `pending|active|done|skipped|error`，`skipped` 的语义就是"没做成，且**必须写原因**"（design-token §1.6 强制）。空正文与断流正是这个语义，且**零协议变更**。

### 2.5 为什么把 SSE 解析与错误归一化放在 Worker

不是为了省事，是为了**体积**（§5 有实测数字）：客户端每少一个解析分支就少一份字节，而 Worker 代码不计入 HTML 体积。副作用是 Worker 更复杂、多一层调试——代价可接受，且这本就是 Stage-0 §4.2 的原意（"上游响应统一归一化成一种 SSE 事件格式，前端只需要一个解析器"）。

---

## 3. 错误状态矩阵【任务 C·4】

统一归一化规则（任务 C 的 1~6 条落在 Worker 侧实现，客户端只消费结果）：

```
1. 一律 body 读成文本 → 2. 尝试 JSON.parse → 3. 失败则保留安全截断的文本（≤200 字）
→ 4. 尽最大努力提取 request_id（JSON 的 error.request_id / message 里的 `(request_id: …)` / 响应头 x-ds-trace-id）
→ 5. 任何情况下不假设 Content-Type 可靠（实测：无鉴权 401 是纯文本且**没有 Content-Type**）
→ 6. 用户可见文案与日志一律经过脱敏（§4）
```

| # | 场景 | 上游/本地表现（实测或推断） | 归一化 code | retryable | 客户端呈现 · 步骤状态 |
| --- | --- | --- | --- | --- | --- |
| E1 | 用户点"停止" | 本地 `AbortError` | `aborted` | 否 | 步骤 `skipped`「本轮被中断」；保留已收文本；气泡标「已中断」 |
| E2 | 客户端无首字超时（30s） | `AbortSignal.timeout` | `client_timeout` | 是 | 「上游没有响应」+ 可重试；步骤 `skipped` |
| E3 | Worker 上游超时 | SSE `error` | `upstream_timeout` | 是 | 「上游超时，已重试一次」/ 最终失败文案 |
| E4 | 断网 / DNS 失败 | `fetch` TypeError | `network` | 是 | 顶部切离线提示条；本回合显式失败 |
| E5 | 鉴权失败（**实测** 401；两种体） | 纯文本 `Authentication Fails (governor)` **或** OpenAI 风格 JSON | `auth` | 否 | 用户只看到「网关配置异常，请稍后」；**绝不回显上游原文**；Dev Drawer 显示 code + requestId |
| E6 | 参数不被接受（**实测** 400 / 422） | JSON，含 `request_id`，422 会列出合法变体 | `bad_request` | 否 | 「本轮请求不被上游接受」；Dev Drawer 显示脱敏后的上游消息（≤200 字） |
| E7 | 限流 429 | JSON | `rate_limited` | 是（退避 1 次） | 「酒馆此刻有点忙」 |
| E8 | 上游 5xx | 任意形态 | `upstream_5xx` | 是（重试 1 次） | 「上游故障，已重试」 |
| E9 | 每日预算耗尽（Worker 本地判定） | `429 {degraded:"budget"}` | `budget` | 否 | **切换离线剧本模式** + 常驻提示条 |
| E10 | 空正文（`finishReason=length`） | 200 但 content 为空（**实测**） | `empty_truncated` | 是（自动放大 max_tokens 重试 1 次） | 步骤 `skipped` + 明确原因；不留空气泡 |
| E11 | JSON 被截断 | 200，正文非法 JSON（**实测** 5 次中 1 次） | `json_truncated` | 是 | 走 Stage-0 R5 四级容错解析；仍失败则该步 `skipped`，原文可展开 |
| E12 | 非 JSON 正文 | 200，正文非 JSON | `json_invalid` | 否 | 同上，但不再重试 |
| E13 | 流中途断流 | 无 `[DONE]` | `stream_cut` | 是 | 保留已收文本 + 「未完成」chip |
| E14 | 空流 | 200，零帧 | `empty_stream` | 是 | 步骤 `skipped` + 显式空回复说明（沿用 D-现有行为） |
| E15 | 触发长度上限（客户端侧） | 输入超长 | `input_too_long` | 否 | 输入框就地提示，不发请求 |

**E1/E10/E11/E13 是实测确认存在的失败模式**，其余为按实测契约推断。E10/E11 正是 Stage-0 R5 那套容错解析**必须保留**的理由——本次实测给了它证据。

---

## 4. 安全与密钥管理方案【任务 C·5】

| 项 | 规则 |
| --- | --- |
| 密钥存放 | **仅** Worker Secret（`wrangler secret put LLM_API_KEY`）与本地开发文件 `.dev.vars`（**必须 gitignore**） |
| 明文禁止 | 源码 / HTML 产物 / 配置文件 / Git / 日志 / 错误消息 / 聊天记录 |
| 客户端 | 只持有 Worker URL，**永远不持有密钥**；产物里 grep 不到任何 `sk-` 前缀 |
| 日志白名单 | `ts · endpoint · agentId · mode · task · httpStatus · code · latencyMs · promptTokens · completionTokens · reasoningTokens · requestId · origin` |
| 日志黑名单 | 用户/助手正文、`Authorization` 头、完整请求体、完整上游响应体、密钥 |
| 错误脱敏 | 客户端可见文案一律用映射后的中文 + code；上游原文只在 Dev Drawer 出现，且**先做密钥模式擦除**（`sk-[A-Za-z0-9_-]{8,}` → `sk-***`）并截断 200 字 |
| CORS | 严格 Origin 白名单（最终 Pages 域 + `http://localhost:*` 仅开发）；不回显未列出的 Origin；**不放行 `null`**（Stage-0 R3） |
| 限流 | IP + 令牌双维度；**KV 写入受限**（见下） |
| 预算护栏 | **修订**：免费额度 KV 只有 1000 写/天（实测文档值），"每请求写 KV"不可行 → 改为**isolate 内存聚合 + 每 ≥60s 或每 N 次落盘一次**，或改用 Durable Object（免费 100K 请求/天） |
| 轮换 | 交付前换新密钥并在 DeepSeek 控制台吊销旧 key；冒烟脚本的密钥来源仅环境变量/文件 |
| 当前风险 | `C:\Users\宋舜江\Desktop\key.txt` 是**明文密钥**，建议删除；若初始化 Git，第一步必须写 `.gitignore`（忽略 `.dev.vars`、`*.key`、`.env*`） |

---

## 5. 体积预算评估【任务 D·6】

**当前基线（实测，非估算）**

| 项 | raw | gzip |
| --- | --- | --- |
| 产物合计 | 282,749 B（276.1 KB） | 87,589 B（85.5 KB） |
| 预算 | 307,200 B | 92,160 B |
| **余量** | 24,451 B | **4,571 B（5.0%）** |
| 其中 vendor（Vue runtime-only） | 109,374 B | 40,3xx B |
| **我方内容** | 169,375 B | 47,2xx B（**比 3.74:1，实测**） |

**纯构建侧剩余可压缩（实测统计）**：分块横幅 20 个 = 4,942 B + 架构注释块 1,124 B + 56 处空行 ≈ **6.1 KB raw ≈ 1.6 KB gzip**（按实测 3.74:1 折算）。这是**不动任何语义**能拿到的全部。

**Stage 2 新增估算（标注：估算，未实施）**

| 方案 | 客户端新增内容 | 估算 raw | 估算 gzip | 落点 |
| --- | --- | --- | --- | --- |
| **甲：解析在客户端** | gateway(请求+SSE 解析+错误归一化+超时+finish 判定) ~13KB、turn/store +2KB、UI +5KB | ~20 KB | **+5.3 KB** | 92.9 KB ❌ 超 |
| **乙：解析与归一化在 Worker** | gateway(请求+归一化事件消费+超时+finish 判定) ~7KB、turn/store +2KB、UI 最小 +1KB | ~10 KB | **+2.7 KB** | 90.3 KB ❌ 勉强超 |
| **乙 + 构建压缩** | 同上 + 横幅/架构块压缩 | — | −1.6 KB | **88.7 KB ✅ 余量 1.4 KB** |

**结论（不预先放宽预算）**：**只有"方案乙 + 构建压缩"能在不删除功能、不弱化错误处理的前提下满足冻结预算**，且余量仅约 1.4 KB。Stage 3 必然再次触顶。

**裁决结果：采纳方案 A（DR-008）** —— gzip 上限 **95 KB**（硬上限），raw 保持 300 KB；执行条件见文首决策记录与 stage-0 v1.2。

**实施路线由此确定**：采用**方案乙**（上游 SSE 解析与错误归一化放在 Worker），**并且不做"靠比例外推"的预算推算**——每一轮构建都以产物实际字节为准，超限立即停止报告。

**Stage 2 落地后的实测余量预计**：约 6 KB gzip（按方案乙估算 +2.7 KB、构建压缩 −1.6 KB，落在 ~88.7 KB）。**这是估算，须由构建输出证实**。

---

## 6. 最小文件清单【7】

**客户端（影响 HTML 体积）**

| 文件 | 动作 | 职责 | 估算 |
| --- | --- | --- | --- |
| `src/providers/gateway.js` | **新增** | GatewayProvider：组装请求、消费归一化 SSE、超时/abort、finish/截断判定 | ~7 KB（方案乙） |
| `src/core/turn.js` | 修改 | `sink.reasoning` 分支（**只留度量、丢弃原文**）、**mode 从入口透传到 Provider 与 Worker**（D3）、结构化错误落 meta（D7）、双 TTFT、**能量/XP/亲和度规则收敛到本文件唯一处应用**（§7.2 G9） | ~+2 KB |
| `src/core/provider.js` | 修改 | 文档补齐 `tool`/`signal`（D1/D2）、声明 `sink.reasoning` 为可选能力 | ~+0.5 KB |
| `src/providers/mock.js` | 修改 | 按 mode 分支能量增量（D4，persona-spec §1.5） | ~+0.3 KB |
| `src/ui/components/transcript.js` | 修改 | 截断/空正文/中断 chip；错误文案 | ~+1 KB |
| `src/ui/components/trace-live.js` | 修改 | **【DR-009 修正】不展示 reasoning 原文**：只显示真实阶段进度 + 度量（reasoningTtft／帧数／字节数）；reasoning 缺失时整块不渲染 | ~+1 KB |
| `src/ui/screens/room.js` | 修改 | **模式开关（快速／深潜）——mode 的调用入口**，必须一路透传到 Provider 与 Worker 路由 | ~+1 KB |
| `src/boot.js` | 修改 | Provider 选择：探活成功→Gateway；失败或 `?mock=1`→**Mock 保持可用** | ~+0.5 KB |
| `build.js` | 修改 | `JS_ORDER` 增 `gateway.js`；squeeze 增强（横幅/架构块） | −1.6 KB gzip |

**服务端（不影响 HTML 体积）**

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `worker/index.js` | 新增 | 端点、CORS、限流、预算、路由表、上游 SSE 解析与归一化、错误映射、脱敏日志 |
| `worker/wrangler.toml` | 新增 | 名称、兼容日期、vars（非密钥）、KV/DO 绑定 |
| `.dev.vars.example` | 新增 | 本地开发密钥占位（真文件必须 gitignore） |
| `.gitignore` | 新增（若初始化 Git） | 排除 `.dev.vars`、`*.key`、`.env*`、`key.txt` |

**冻结契约触碰情况**：**零新增事件名、零改 payload 结构**。仅两处加性扩展（`usage` 增字段、`meta` 增字段），均已在 §1.2/§1.4 标注。

---

## 7. 回归测试计划与 Gate 标准【8】

### 7.1 回归（必须零回退）

1. **Stage 1-2 的 33 项端到端验收全部通过**（Mock 路径）——这是硬门槛，任一失败即回滚。
2. 产物自检 `data-selftest=pass`（11 项），并新增一项「Provider 能力探测」：当前 provider id/kind、支持的 mode 映射、`sink.reasoning` 是否存在。
3. 外部请求：产物仍 0 跨源（除显式配置的 Worker 域）；`file://` 打开仍能进离线 Mock 模式。

### 7.2 新增验收（真实 Worker + 真实模型，浏览器实测）

| 组 | 项 | 通过标准 |
| --- | --- | --- |
| G1 流式 | 快速模式 | 气泡逐字增长（采样 ≥5 个递增点）；`finishReason=stop`；usage 含真实 prompt/completion |
| G2 思考进度 | 深潜模式 | reasoning 帧先到、content 帧后到；**气泡只由 content 产生**；`reasoningTtft < contentTtft` 且都以**度量**形式可读；**与 G8 一致**：页面任何用户可见区域搜不到 reasoning 原文 |
| G3 用量 | 两项 | `reasoningTokens` 真实非零；Dev Drawer 显示与上游一致 |
| G4 降级 | 六种故障：断网／401／429／500／超时／预算耗尽 | 页面**均不白屏**，各自显示对应中文文案；无密钥/原文泄露 |
| **G8 展示边界【DR-009】** | 深潜模式实测 | 页面**任何用户可见区域都搜不到 reasoning 原文片段**；Trace 面板只有阶段名与度量；思考进度在 reasoning 缺失时**整块不渲染**（非空占位） |
| **G9 能量归一处【DR-009 相关】** | 快速 / 深潜 各一轮 | 快速能量 **−3**、深潜 **−8**，且**每轮恰扣一次**（不重复、不遗漏）——由 Store 快照前后差值与 trace:status 事件数双重核对 |
| G5 空与截断 | 空正文、JSON 截断 | 检测到并显示（不留空气泡、不标 `done`）；容错解析生效 |
| G6 中止 | 点停止 | 步骤标 `skipped`、不留 `streaming`、**Worker 日志可见上游连接释放** |
| G7 密钥 | 全链路 grep | 产物 HTML、Worker 源码、日志、错误消息、Dev Drawer 中**均搜不到密钥** |

### 7.3 Gate 标准（全部满足才算 Stage 2 通过）

1. §7.1 全部通过，**零回退**；
2. §7.2 的 G1~G7 全部通过；
3. 体积：raw ≤ 300 KB 且 **gzip ≤ 95 KB（DR-008 硬上限）**。构建输出必须给出**实测字节数与余量**；超标即停止并报告，构建脚本已强制拒绝 release；
4. 安全：`grep -r "sk-" dist/ worker/` 无命中；`.dev.vars` 不在版本控制内；
5. 契约：`PHASE_TRANSPORT` 完整、未知事件名仍被拒绝、TraceBus 事件名与 v1.1 一致；
6. 交付：Stage 2 结束时产出可截图证据 + 200 字决策记录（沿用 Stage-0 §6.2 固定动作）。

---

## 8. 待你裁决的两件事

1. **§5 体积选项 A / B / C**（我推荐 A：gzip 提到 95 KB）。
2. **`sink.reasoning` 的加性扩展**（§1.2）是否批准——它是 Stage 2 展示"真思考链"的唯一入口，且是纯加性、零冻结事件变更。

批准这两项后，Stage 2 的实现顺序是：Worker（含归一化与错误映射）→ GatewayProvider → `turn.js` reasoning/mode 接线 → UI 最小增量 → 回归 + Gate。
