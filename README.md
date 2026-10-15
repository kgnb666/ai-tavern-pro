# AI Tavern Pro

> A place where AI Agents think, remember and evolve.
> 一个让 AI Agent **思考、记忆与进化**的地方 —— 沉浸式酒馆，三位人格各异的 Agent。

**交付形态**：单文件 `dist/AI-Tavern.html`（零 CDN、零外部资源引用、`file://` 双击即玩）+ 网关 Worker（`worker/`）+ 设计文档（`docs/`）。

---

## 30 秒了解

| 时间 | 你会看到 |
| --- | --- |
| 10 秒 | 奇幻酒馆场景（Cyber Fantasy Tavern：酒馆 × AI 未来感 × RPG 界面）——刻意不是聊天框 |
| 1 分钟 | 右侧 **Agent Trace** 面板逐条亮起真实步骤：意图识别 → 回答策略 → 记忆检索 → 人设组装 → 工具 → 生成 →（深潜）自检 → 记忆抽取 |
| 5 分钟 | 选 Agent → 对话 → 触发记忆写入 → **记忆台**看真实记录 → **成长档案**看等级 / 关系 / 能量 / 认知档案 |

## Agent 公式 → 实现映射

| 公式 | 实现位置 | 可见证据 |
| --- | --- | --- |
| **Persona** | `src/core/persona.js` 八块 prompt（顺序冻结） | Trace 面板 `persona.apply` 步骤 |
| **Memory** | `src/core/memory.js`：双路写入（Quick 本地启发式 / Deep Evaluator 抽取）/ 冻结公式检索 / 命中巩固 / 冲突合并 / 淘汰 / 长会话压缩 | 记忆台面板（真实数据，可与存储逐条对账） |
| **Planning** | `src/core/cognition.js` 本地纯计算（意图 / 策略 / 模式建议，确定性） | `intent.detect` / `plan.generate` 步骤，标注"本地纯计算" |
| **Tools** | `src/core/tools.js` ToolRegistry（wiki 真实检索 + 本地工具） | `tool.call` 步骤 + 卡片来源审计 |
| **Evaluation** | Deep 轮生成后：**自检**（质量检查）+ **抽取**（记忆提取）——两次调用均后置、非阻塞 | Trace 面板 `reflection` 步骤；记忆台「深潜评估」记录 |

## 架构（单向依赖：data ← core ← ui ← boot）

```
[浏览器 · 单文件产物]
  boot.js ── 启动与探活：成功 → 在线网关；失败 → 离线模拟（页面永远可完整演示）
    │
  ui/      ── Vue 3（构建期内联 runtime-only）+ Design Token 手写 CSS
    │   screens:    entry / world / room / memory-board / growth
    │   components: transcript / trace-live / card / portrait
    │
  core/    ── 编排层（不碰网络）
    │   turn.js（唯一编排器）· cognition · memory · persona · tools
    │   store.js（唯一状态真源）· eventbus（8 个冻结 trace 事件）· provider.js（相位契约）
    │
  data/    ── personas（三 Agent 规格）· events · mock-scripts
    │
  providers/
      gateway.js ── 真实模型（流式 SSE / 自检 / 抽取）
      mock.js    ── 离线模拟（每步显式标注，无假状态）

[Cloudflare Worker · worker/] ── 密钥保管 + 路由 + 限流 + SSE 归一化 + 预算护栏
                                   （不承载编排：提示词与 persona 全部在 HTML 里）
```

## 三条工程红线（贯穿全部实现）

1. **密钥绝不进前端** —— 浏览器只持有网关端点；`LLM_API_KEY` 只存在于 Worker secrets。
2. **不伪造 Agent 步骤** —— 可以演进度，不能演状态；离线模拟的每一步都显式标注为模拟。
3. **失败必须有可见降级** —— 断流 / 超时 / 解析失败 / 自检失败都会在 Trace 与气泡上如实标记，绝不静默。

## 运行

- **离线**：双击 `dist/AI-Tavern.html`（Mock Provider 不调用任何外部 API；模拟延迟为已标注值）。
- **在线**：打开页面后自动探活网关（`/v1/health`）——成功即接入真实模型，失败自动回退离线。
- **构建**：`node build.js`（零依赖；含体积双门禁 + 产物可解析性 + 外部引用扫描）。

## 部署（可访问链接）

**推荐形态：自有服务器前置**（页面由大陆服务器直供，`/v1/*` 反代到 Cloudflare Worker；浏览器全程同源、零 CORS、Worker 零改动）——完整步骤见 [`deploy/README.md`](deploy/README.md)。

```
浏览器 ── https://tavern.myiskg.com（腾讯轻量云 · nginx）
            ├─ /                       → 本机静态 AI-Tavern.html（单文件产物）
            └─ /v1/*                   → 反代 → Cloudflare Worker（密钥仍在 Worker）
```

备选形态 **Worker 同源托管**（把页面内联进 Worker 直供；已实现并本地 workerd 实测通过）：

```bash
node build.js                                 # 1) 构建（含体积门禁）
cp dist/AI-Tavern.html worker/page.html       # 2) 复制为 Worker 页面模块
cd worker && npx wrangler login               # 3) 一次性登录（浏览器授权）
cd worker && npx wrangler deploy              # 4) 部署
```

- 完成后访问 `https://<worker 域名>/` 即打开应用；`/v1/*` 是同一域上的网关端点（同源请求不受 CORS 约束）。
- 本地验证：`cd worker && npx wrangler dev`（本地 workerd 完整回放，无需登录；已验证根路径 / 健康检查 / 404 三路由）。
- 若把该域名托管到 Cloudflare，还可给 Worker 绑定自定义域名（`worker/wrangler.toml` 内有注释态 `[[routes]]` 模板；同时把 `src/boot.js` 的 `DEFAULT_API` 改为该域名重建）。

## 演示

- **3 分钟演示脚本**：[`docs/demo-script.md`](docs/demo-script.md)

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/stage-0-architecture.md` | 架构与契约（当前 **v1.5**：DR-008 预算 330KB/104KB、DR-009 推理展示边界、决策四调用预算） |
| `docs/persona-spec.md` | 三 Agent 人设规格、记忆生命周期（§1.6 写入/检索/巩固/淘汰/合并/压缩）、通用红线 U1–U10 |
| `docs/design-token.md` | 视觉唯一真源（颜色 / 排版 / 动效 / 对比度门槛） |
| `docs/stage-1-plan.md` · `docs/stage-2-gateway-contract.md` | 阶段计划与网关契约（错误归一化矩阵、CORS、预算护栏） |

## 质量保障

- **19 套浏览器端测试 / 300+ 断言**（本地 Chrome + CDP；脚本为开发资产，不进交付仓库），覆盖：对话流 E2E、卡片渲染与来源审计、工具协议、记忆全生命周期（写入 / 检索 / 巩固 / 淘汰 / 冲突合并 / 压缩）、人设装配、关系 / 事件 / 成长、Deep 自检与抽取、离线 / 在线双链路。
- **构建期双门禁**：raw 与 gzip 体积硬上限 + 产物可解析性 + 外部资源引用零容忍。
- 关键机制带**负向验证**：先证明测试能抓住缺陷（例如自检管线的一处异常穿透曾被新测试精确复现），修复后回归全绿。
