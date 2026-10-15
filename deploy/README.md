# 部署记录与运维手册 — tavern.myiskg.com

> **形态**：浏览器 ── `https://tavern.myiskg.com`（腾讯轻量云 129.204.61.68 · 现有 `myiskg-edge` nginx 容器）
> 　├─ `/`　　　→ `/var/www/myiskg/tavern/AI-Tavern.html`（静态单文件产物）
> 　└─ `/v1/*`　→ `127.0.0.1:8787`（systemd `tavern-gateway`：**原样运行 `worker/index.js`**）
> 　　　　　　　　→ `api.deepseek.com`（大陆直连）。密钥只在 `/opt/ai-tavern/tavern.env`（600）。

## 部署状态（2026-10-15 · 已交付闭环）

- ✅ **交付链接：https://tavern.myiskg.com/**（页面 200 / 337,775B；证书 CN=tavern.myiskg.com，2027-01-13 到期、自动续期已挂）
- ✅ 网关 `tavern-gateway`：active；`/v1/health` → `ok:true`（真实密钥；白名单含 http/https 两 origin）
- ✅ 并站 myiskg-edge：80+443 同内容（**不做 http→https 强跳**，见 nginx-tavern.conf 顶部说明）
- ✅ **生产在线套件 20/20**（对 `https://tavern.myiskg.com/` 直跑；桌面 1440×900 与移动视口 390×844 各一轮；G4 超长输入错误、G6 生成期中止均为真实链路）
- 📋 测试资产修复记录：cdp-live 的 G4 超长消息会残留进会话历史（>6000 字符 → 后续每轮真实链路 400）；G6 已修为「重载取净会话 + 等待 `response.chunk:active` 才点停止」，断言只加强未放松

## 目录布局（服务器）

```
/opt/ai-tavern/
  server.js                 # Node 适配器（原样加载 worker/index.js）
  worker/index.js           # 网关本体（与仓库 worker/index.js 一致，零分叉）
  worker/package.json       # {"type":"module"}（Node 18 无 ESM 自动探测，必需）
  tavern.env                # LLM_API_KEY=…（600；轮换密钥只改这里）
  tavern-gateway.service    # systemd 单元副本
/home/ubuntu/myiskg-edge/edge-nginx.conf   # 边缘 nginx 配置（tavern 块已并入）
/var/www/myiskg/tavern/AI-Tavern.html      # 页面（经 /var/www/myiskg 只读挂载入容器）
```

## 常用运维

```bash
sudo systemctl status tavern-gateway                  # 状态
sudo systemctl restart tavern-gateway                 # 重启（改 server.js/worker 后）
sudo journalctl -u tavern-gateway -n 50 --no-pager    # 日志（白名单字段，无正文/密钥）
curl -sS http://127.0.0.1:8787/v1/health              # 绕过 nginx 直连网关
```

**更新页面**（本机执行）：`node build.js` → `scp dist/AI-Tavern.html ubuntu@129.204.61.68:/tmp/` → 服务器 `sudo cp /tmp/AI-Tavern.html /var/www/myiskg/tavern/`（静态文件替换即时生效）。
**更新网关**：scp 新的 `worker/index.js` 到 `/opt/ai-tavern/worker/` → `sudo systemctl restart tavern-gateway`。

## 已踩过的三个坑（勿重蹈）

1. **bash 双引号会展开 `$uri`**：拼接 nginx 配置片段必须用单引号或转义 `\$`（否则 try_files 只剩一个参数）。
2. **Node 18 无 ESM 自动探测**：`worker/index.js` 是 ESM，必须靠 `worker/package.json` 的 `{"type":"module"}`（本机 Node 24 自动探测所以本地不暴露该问题）。
3. **单文件 bind mount 的 inode 坑**：`edge-nginx.conf` 被容器固定绑定在启动时的 inode 上——用 `cp`/`scp`/`sed -i` 替换文件后容器仍读旧内容；改配置后**必须 `sudo docker restart myiskg-edge`**（或原地改写 + 容器内 `nginx -s reload`）。

## 证书（DNS 生效后执行）

```bash
sudo certbot certonly --webroot -w /home/ubuntu/myiskg-edge/acme-webroot -d tavern.myiskg.com
# 然后把 deploy/nginx-tavern.conf 的 443/证书/301 部分并入 edge-nginx.conf，docker restart myiskg-edge
```
（现有 `myiskg.com` 证书是 SAN 列表、不含 tavern，故单独签发；不影响其它子域。）

## 备选形态

同一份 `worker/index.js` 亦可部署到 Cloudflare（`cd worker && npx wrangler login && npx wrangler deploy`，页面路由已实现并本地 workerd 验证）——网络可达时作冗余入口。
