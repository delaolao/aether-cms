# 部署说明：AI 自动标签（Ollama / jieba）与双实例环境

本文档面向 aether-cms 的「**编辑器 '✨ 推荐标签'**」功能，以及两个实例（xl / xq）在单台服务器上的部署。所有敏感值用占位符，请替换为实际值。

## 一、功能概述

- 编辑器工具栏「✨ 推荐标签」→ 调后端 `POST /api/suggest-tags`（需登录）。
- 后端 `core/utils/tag-suggester.js` 支持两种后端，通过 `.env` 切换：
  - **`ollama`**：调用本地 Ollama 的 `qwen2.5:1.5b`，质量最高（语义短语）。
  - **`jieba`**：`jieba-wasm` 切词 + 词性过滤 + 词频/标题加权，离线免费、毫秒级。
- 选择逻辑：`AI_BACKEND=ollama` 且 `OLLAMA_URL` 已设 → 用 Ollama；Ollama 失败/超时 → **自动回退 jieba**；无需配置时默认 jieba。

## 二、服务器端：Ollama 部署

- 架构：aarch64（鲲鹏 920）、纯 CPU、多 NUMA。
- 安装（官方脚本，自动识别 arm64）：
  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ```
- 拉取模型：
  ```bash
  ollama pull qwen2.5:1.5b
  ```
- 系统服务配置 `/etc/systemd/system/ollama.service.d/override.conf`（**最终版**）：

  ```ini
  [Service]
  Environment="OLLAMA_HOST=127.0.0.1:11434"
  Environment="OLLAMA_MODELS=/data/ollama/models"
  Environment="OLLAMA_KEEP_ALIVE=-1"
  # 注意：OLLAMA_NUM_THREADS 在此版本被忽略，不用设；线程由请求里的 options.num_thread 控制
  ```
  生效：
  ```bash
  sudo mkdir -p /data/ollama/models && sudo chown -R ollama:ollama /data/ollama
  sudo systemctl daemon-reload && sudo systemctl enable ollama && sudo systemctl restart ollama
  ```

> 要点（已踩坑）：小模型 + 多 NUMA 服务器上，**llama.cpp 线程过多会病态地慢**（76 核空转、0.08 tok/s）。`OLLAMA_NUM_THREADS` 环境变量不被此版本读取，必须靠请求里的 `options.num_thread` 限制。aether 端已默认传 `4`，实测 24 tok/s（秒级）。

## 三、两个实例的 `.env` 模板

> `COOKIE_SECRET` 用你自己生成的那串（不要用这里的占位符）；两个实例的 secret 建议不同。

**实例 1：心理研训中心（xl，8091）**

```bash
PORT=8091
COOKIE_SECRET=<你的随机长串>

AI_BACKEND=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:1.5b
AI_OLLAMA_TIMEOUT=90000
AI_OLLAMA_NUM_THREADS=4

NODE_ENV=production
```

**实例 2：学前研训中心（xq，8092）**

```bash
PORT=8092
COOKIE_SECRET=<另一个随机长串>

AI_BACKEND=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:1.5b
AI_OLLAMA_TIMEOUT=90000
AI_OLLAMA_NUM_THREADS=4

NODE_ENV=production
```

> 生成 COOKIE_SECRET：
> ```bash
> node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
> ```

### 配置项说明

| 变量 | 说明 |
|---|---|
| `AI_BACKEND` | `ollama` / `jieba`；不填 = 有 `OLLAMA_URL` 用 ollama，否则 jieba |
| `OLLAMA_URL` | 本地 Ollama 地址（默认 11434） |
| `OLLAMA_MODEL` | 模型名，需与 `ollama list` 一致 |
| `AI_OLLAMA_TIMEOUT` | 等待 Ollama 返回的毫秒数（默认 90000），超时则回退 jieba |
| `AI_OLLAMA_NUM_THREADS` | 每次请求传给 llama.cpp 的线程数（默认 4；多 NUMA 小模型建议 2~8） |

## 四、aether 代码部署清单（需同步到两个实例）

- 新增：`core/utils/tag-suggester.js`
- 修改：`core/api/content-api.js`、`core/admin/views/contents/editor.html`、`core/admin/static/js/editor/modules/editor-enhancements.js`、`core/admin/static/js/i18n.js`、`package.json`、`package-lock.json`、`.env.example`

```bash
# 服务器上装依赖（jieba-wasm，用于回退）
cd /data/te_se_zi_yuan/xl/aether-cms && npm install
cd /data/te_se_zi_yuan/xq/aether-cms && npm install
# 改 `.env`（见上）后重启实例：
tmux kill-session -t xl-aether; tmux new-session -d -s xl-aether -c /data/te_se_zi_yuan/xl/aether-cms 'node index.js'
tmux kill-session -t xq-aether; tmux new-session -d -s xq-aether -c /data/te_se_zi_yuan/xq/aether-cms 'node index.js'
```

## 五、验证

```bash
# Ollama 模型列表
ollama list
# 模型是否驻留（UNTTL=Forever 表示常驻）
ollama ps
# 单次调用（限线程4，模拟 aether 请求）
curl -s -m 60 -w "\n耗时: %{time_total}s\n" \
  http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:1.5b","prompt":"给这篇文章 3 个标签：人工智能在医疗影像诊断中的应用","stream":false,"format":"json","options":{"num_thread":4}}'
```
- 期望：返回 `{"标签":[...]}`，热态约 1~4 秒。

浏览器：后台编辑器点「✨ 推荐标签」→ 返回**语义短语**；若返回的是 jieba 的单字词，说明回退到了 jieba（多为 Ollama 超时/失败）。

## 六、常见问题

1. **标签是 jieba 的单字词** → 说明走了回退。查看 Ollama 是否被请求：`journalctl -u ollama --since "2 minutes ago" -n 20`；若为空，检查实例 `.env` 是否配了 `AI_BACKEND=ollama`/`OLLAMA_URL`，且 `.env` 改动后**已重启实例**。
2. **很慢** → 确认请求带了 `num_thread`（`grep num_thread core/utils/tag-suggester.js`）；线程可改 2 或 8 试。
3. **`OLLAMA_NUM_THREADS` 设了没效果** → 该版本忽略它；用请求里的 `num_thread`（`AI_OLLAMA_NUM_THREADS`）。
4. **日志很吵** → 可在 override.conf 加 `Environment="OLLAMA_DEBUG=0"`（但个别版本语义不稳，慎用）。
5. **服务器忙时（moodle/chamilo 等争 IO）** → Ollama 可能很慢；建议平时用 jieba（默认），高峰时点推荐走模型。
