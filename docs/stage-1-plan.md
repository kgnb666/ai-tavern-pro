# AI Tavern Pro — Stage 1 实施计划

> **版本** `s1.0` · 2026-10-12 · **依赖** `stage-0-architecture.md` `v1.0` + `persona-spec.md` `p1.0` + `design-token.md` `t1.0`
> **本计划不修改任何 Stage-0 契约。** 若实施中发现契约不足，走 `persona-spec.md` §6.2 变更流程，禁止就地改。
> **Stage 1 Gate（引自 Stage-0 §6）**：**零 AI 也像完整产品**（10 秒体验达标）+ 构建产物单文件且离线可用。

---

## 0. 边界与前置

### 0.1 前置冻结物（已就绪）

| 冻结物 | 文件 | 对 Stage 1 的作用 |
| --- | --- | --- |
| 架构与分层 | `stage-0-architecture.md` | §2.1 的 IIFE 命名空间分层与依赖方向 |
| 事件契约 | 同上 §2.4 | Stage 1 的 Mock 必须发**同名事件**，提前验证 UI 对契约的依赖 |
| 三个 Agent 的文案与参数 | `persona-spec.md` | Agent 卡的展示内容、tools/cards 的展示位 |
| 视觉系统 | `design-token.md` | T2 的唯一输入 |

### 0.2 目标（Stage 1 结束时的状态）

用户能在**没有任何 AI** 的情况下：推门进入酒馆 → 看到三个有性格的角色 → 进入对话房间 → 看到一段（Mock）对话与步骤时间轴，并且**相信这是个完整产品**。

### 0.3 非目标（明确不做）

不接 LLM、不接 Worker、不写 Agent 逻辑、不实现真实记忆持久化、不实现真实 SSE、不做 Growth 屏与 Memory Board 的完整功能（仅保留路由占位）。

### 0.4 与 persona-spec 的一致性要求

Agent 卡上出现的所有文案（定位、能力标签、工具名、签名符号）**必须逐字来自 `persona-spec.md`**，不得在 UI 里另写一套宣传语 —— 否则 Stage 3 接入真实引擎时会出现"文案对不上"的返工。

---

## 1. 任务分解

优先级：**P0 = Gate 必需**；**P1 = 加分，时间紧张时首先砍**。

| # | 任务 | P | 依赖 | 可并行 | 交付物 | DoD（完成定义） |
| --- | --- | --- | --- | --- | --- | --- |
| **T1** | `build.js` 单文件流水线 | P0 | — | 否（最先） | 零依赖 Node 脚本 + `AI-Tavern.html` | `node build.js --release` 产出单文件；产物内**无任何运行时 CDN 请求**（DevTools Network 面板零外部请求可证）；缺文件或占位标记不匹配时非零退出 |
| **T2** | 设计系统落地 | P0 | T1 | 与 T3 并行 | `src/styles/tokens.css` + `base.css` + `components.css` | `design-token.md` 全部冻结 token 落地为 CSS 变量；组件样式**零裸值**（用脚本 grep 抽查）；T2 完成后 `design-token.md` 版本递增为 `t1.1` 并追加 component 级 token |
| **T3** | 应用壳与路由 | P0 | T1、T2 | 与 T2 并行 | `src/index.html` + `boot.js` + 各屏骨架 | Entry → TavernWorld → ConversationRoom 三屏可切换；MemoryBoard / Growth 有占位路由；**375px 断点在此阶段就做好**（三栏转 Tab）；`Vue.createApp` 与 `Tavern.*` 全局命名空间无冲突（见 R15） |
| **T4** | Canvas 氛围层 | P0 | T3 | 是 | `src/ui/atmosphere.js` | 余烬粒子 ≤ 300（< 900px 时 ≤ 160）；**无逐帧对象分配**；`visibilitychange` 暂停；`prefers-reduced-motion` 时整层关闭；烛光呼吸与暗角按 `design-token` §8 |
| **T5** | 三张 Agent 卡 + 肖像 SVG | P0 | T2、T3 | 是 | 内联 SVG × 3 + 卡片组件 | 三张卡视觉可区分（强调色 / 形态 / 签名符号均不同）；肖像为手写内联 SVG（零外部图片）；卡片内容逐字来自 `persona-spec.md` §2.1/§3.1/§4.1 |
| **T6** | MockProvider 与对话流骨架 | P0 | T3 | 是 | `src/data/mock.js` + `src/core/llm.js`（接口空壳） | Mock 与 Gateway **同接口可互换**（`Tavern.LLM`）；Mock 发出的步骤事件名与 Stage-0 §2.4 契约**逐字一致**；页面带可见 `MOCK` 角标；三 Agent 各 1 段 4~6 轮对话 |
| **T7** | 静态 Trace 面板骨架 | **P1** | T6 | 是 | Trace 时间轴组件 | 6 个步骤的 pending/active/done/skipped 四种形态（按 `design-token` §1.6 的颜色 + 形态 + 文案三重要求）均可渲染；节点可展开显示占位 JSON。**不含真实事件实现**（属 Stage 3） |
| **T8** | 自检与验收 | P0 | 全部 | 否 | 验收报告 + 截图 | §6 的 A-1~A-10 全部有结论；未通过项要么整改要么记录为已知偏差 |

**关于 T7 的范围说明**：Stage-0 §6 的 Stage 1 交付清单里写的是"路由/布局壳"，未明确列出 Trace 面板。本计划把**静态** Trace 面板放在 T7/P1，理由是三栏布局的骨架如果不含右栏，Stage 3 接入真实事件时极可能要重排布局。若时间紧张，砍掉 T7 **不会影响 Gate**（10 秒体验由 Entry + TavernWorld 承担）。

---

## 2. `src/` 目录提案（本阶段不创建，Stage 1 实施时建立）

```
AI Tavern Pro/
├─ AI-Tavern.html            ← 产物，由 build.js 生成，禁止手改
├─ build.js                  ← 零依赖 Node 脚本
├─ src/
│  ├─ index.html             ← 壳模板，含 /*INJECT:name*/ 占位标记
│  ├─ styles/
│  │   ├─ tokens.css         ← design-token.md 的唯一落地
│  │   ├─ base.css           ← reset / 排印 / 滚动条 / focus ring
│  │   ├─ components.css     ← 卡片 / 按钮 / 输入框 / 面板 / Chip
│  │   └─ screens.css        ← 各屏布局与响应式断点
│  ├─ vendor/                ← 构建期内联的依赖（含 lock.json）
│  ├─ data/
│  │   ├─ personas.js        ← persona-spec.md 的可执行形态（仅文案与参数）
│  │   └─ mock.js            ← Stage 1 专用假数据，Stage 2 删除
│  ├─ core/                  ← eventbus.js / store.js / llm.js(空壳) / memory.js(空壳)
│  ├─ ui/                    ← 按屏拆分的组件 + atmosphere.js
│  └─ boot.js
└─ docs/
```

依赖方向严格遵守 Stage-0 §2.1：`data ← core ← ui ← boot`，**任何反向引用视为 bug**。

---

## 3. `build.js` 规格

| 项 | 规格 |
| --- | --- |
| 依赖 | **零**（仅 `node:fs` / `node:path`），无 package.json |
| 输入 | `src/index.html`（占位标记）+ 冻结的内联顺序表 |
| 输出 | 根目录 `AI-Tavern.html` |
| **内联顺序（冻结）** | vendor → tokens → base → components → screens → data → core → ui → boot |
| 模式 | `--dev`：vendor 走线上 CDN，本地迭代快；`--release`：**强制内联 vendor**，交付用 |
| 体积报告 | 每个分块字节数 + 总字节数 + gzip 估算，输出到终端 |
| 架构注释 | 在产物顶部注入 Stage-0 §2.1 的分层图（评审直接读文件能看到架构） |
| 版本戳 | `<!-- AI-Tavern Pro · build <sha256 前8位> · <日期> -->` |
| 失败策略 | 占位标记不匹配、文件缺失、vendor 校验失败 → 非零退出 |
| 不做 | 不压缩、不混淆、无 watch。产物可读性对评审有价值；体积靠 gzip 与自律 |
| vendor 治理 | 来源与版本记在 `src/vendor/lock.json`（版本 + sha256），构建时校验；唯一 vendor 是 Vue 3 global prod |

**体积预算**：`AI-Tavern.html` ≤ **305KB** 未压缩，gzip ≤ **100KB**（Stage-0 R4 / DR-008，**v1.4 现行硬上限**；v1.2 为 300/95KB）。每完成一个任务跑一次 build 报告；**超过 260KB 即暂停新增样式，先还债**。

---

## 4. Mock 数据规格与「不得伪装」规则

### 4.1 规格

| 项 | 要求 |
| --- | --- |
| 对话 | 三 Agent 各 1 段，4~6 轮，内容体现各自 persona（烬给计划、棱镜给带不确定性的知识、薇奥拉给 3 个变体） |
| 卡片 | 每段 Mock 至少产出 1 张对应卡片（复用 `persona-spec` §2.7/§3.7/§4.7 的字段） |
| 步骤 | 每轮 6 步：理解请求 / 检索记忆 / 推理规划 / 工具调用 / 生成回复 / 自我评估 |
| 记忆 | 3 条示例记忆（含 1 条 `heuristic` 弱记忆，用于验证"弱记忆角标"UI） |
| 状态 | 三 Agent 的初始 `level/xp/mood/affinity/energy`，其中至少一个处于 `tired`（验证 mood 视觉） |

### 4.2 「不得伪装」三条规则（对齐 Stage-0 红线二）

1. Mock 时期的所有演示页面**必须带可见 `MOCK` 角标**。
2. Mock 必须走**与真实引擎同名的事件**（验证事件契约），不得为 UI 方便另造事件。
3. **Stage 2 起，`src/data/mock.js` 整体删除**，不作为开关保留。最终交付版本中唯一允许存在的"预设内容"是**明确标注的离线剧本模式**，且它必须自报家门（`design-token`/`persona-spec` §1.3 的"上游不可用"行）。

---

## 5. Stage 1 必须为 Stage 2 预留的接口

| 预留项 | 规格 | 为什么现在做 |
| --- | --- | --- |
| `Tavern.LLM` 抽象 | `MockProvider` 与 `GatewayClient` **同接口**：`chat({agentId, mode, task, messages, stream, onEvent})` | 让 Stage 2 只替换实现，不动 UI |
| SSE 解析器接入点 | `core/llm.js` 中留出 `parseSSE(chunk)` 的调用位，空实现 | 避免 Stage 2 时改动 UI 数据流 |
| `/v1/health` 探活位 | 顶部状态条的一个位置（Stage 1 只渲染"在线"静态态） | 离线模式是常用态，位置要早定型 |
| Trace 事件适配层 | Mock 事件 → Store 的映射函数单独一层 | Stage 2 换成真实事件时只改这一层 |
| `?tour=1` 与 `?demo=1` 参数 | `boot.js` 里解析但仅记录，不实现 | 参数名一旦公开就要保持兼容 |

---

## 6. 验收清单（Gate 通过标准，均可测）

| # | 项 | 通过标准 | 测法 |
| --- | --- | --- | --- |
| A-1 | **10 秒测试** | 找 5 位非本人试看，≥ 4 人第一反应包含"像个产品/游戏"（不出现"这是聊天页"） | 现场观察 + 记录原话 |
| A-2 | **离线完整** | 断网 + 直接双击打开 `file://`，均能完成 Entry → 选人 → 进房间 → 看到 Mock 对话与 Trace，控制台无报错 | 断网 + 双击产物 |
| A-3 | **对比度实测** | `design-token.md` §1.3 / §1.4 的每一组在真实渲染页面上复测，偏差 ≤ 0.05 | DevTools 取色 + 公式复算，留截图 |
| A-4 | 帧率 | 桌面 60fps；移动端 ≥ 50fps；10 秒录制内无 > 50ms 长任务 | Chrome Performance 录制 |
| A-5 | `prefers-reduced-motion` | 开启后无位移类动画，粒子层关闭，功能完整 | 系统设置切换后复测 |
| A-6 | 响应式 | 375×812 与 1440×900 两视口均无横向滚动、无重叠/截断 | 双视口截图 |
| A-7 | 键盘 | Tab 可遍历全部可交互元素，focus 可见，Esc 关闭抽屉/弹层 | 纯键盘走一遍 |
| A-8 | 体积 | 产物 ≤ 305KB，gzip ≤ 100KB（DR-008 v1.4） | build 报告截图 |
| A-9 | 单文件完整性 | 产物中无 `src/` 相对引用、无运行时外部 URL | 产物内 grep + Network 面板 |
| A-10 | 截图交付 | Entry / TavernWorld / ConversationRoom 三屏 × 桌面 + 移动，共 6 张 | 截图归档 |

---

## 7. 本阶段风险与对策

| 风险 | 对策 | 触发点 |
| --- | --- | --- |
| R1 CDN 不可达 | 已由 T1 的 `--release` 内联解决；**T1 的 DoD 里就包含"零外部请求"验证**，不留到 Stage 5 | T1 |
| R4 体积失控 | 每任务跑 build 报告；> 260KB 暂停新样式 | 每任务 |
| R9 性能 | 粒子预算与降级开关**在 T4 内做完**，不推给 Stage 5 | T4 |
| R10 移动端 | 断点与 Tab 布局**在 T3 做**，不推迟 | T3 |
| R14 工期 | T7 为 P1：压力大先砍 T7；其次砍 T5 的第三个肖像（保留剪影占位） | 全程 |
| **R15（新增）** | **Vue global 内联后与 IIFE 命名空间共存**：Vue 加载必须用 IIFE 包裹并显式挂到局部变量，避免与 `Tavern.*` 冲突；`createApp` 的挂载点与 Dev Drawer 的全局快捷键需验证不打架 | **T3 实测项，必须验证** |
| **R16（新增）** | **文案与 persona-spec 漂移**：UI 里为好看而改写了 Agent 的定位描述 → Stage 3 返工 | T5 完成后用 diff 抽查一次 Agent 卡文案 |

---

## 8. 交付物

1. `AI-Tavern.html`（单文件，`--release` 构建）。
2. 6 张截图（A-10）。
3. 体积报告（A-8）。
4. 验收清单勾选表（A-1~A-10，含未通过项的整改记录或已知偏差说明）。
5. **200 字以内的决策记录**：本阶段做过的取舍与理由（面试口述用，Stage-0 §6.2 第 3 条）。

---

## 9. 与 Stage 2 的衔接

Stage 2 需要的输入（Stage 1 必须已经准备好）：`Tavern.LLM` 抽象接口、SSE 接入位、健康态渲染位、Trace 事件适配层。

Stage 2 的第一个任务是 **C-1 冒烟实测**（`persona-spec.md` §0）：实测 `deepseek-reasoner` 当前是否支持 `response_format: json_object` 与 function calling，据此裁决模型路由。**该项只影响路由表，不影响 Stage 1 的任何产出。**

---

## 10. 时间盒（"天" = 一个 vibe coding 会话单元，按实际节奏缩放）

| 任务 | 时间盒 | 累计（P0 路径） |
| --- | --- | --- |
| T1 | 0.5 | 0.5 |
| T2 | 1 | 1.5 |
| T3 | 1 | 2.5 |
| T4 | 1 | 3.5 |
| T5 | 1 | 4.5 |
| T6 | 0.5 | 5.0 |
| T8 | 0.5 | 5.5 |
| T7（P1） | 1 | — |

**P0 路径约 5.5 个会话单元；含 T7 约 6.5。** 每个任务结束都必须能跑出 build 报告，不允许"三个任务后一起测" —— 单文件构建的风险必须在 T1 就被清掉，不能积累到最后。
