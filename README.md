# Aether CMS × hblog-ng 整合版

基于 [aether-cms](https://github.com/LebCit/aether-cms)（GPL-3.0）并整合 [hblog-ng](https://github.com/halit/hblog-ng)（MIT）能力的内容发布系统：

**「文件即内容」的 Markdown 发布 + 后台可视化编辑 + Obsidian 式知识图谱**。所有内容以 `.md` 文件存储，动态发布（保存即生效），无数据库依赖。

> 本仓库是 aether-cms 的增强分支（fork），把 hblog-ng 的 Obsidian 渲染与知识图谱能力移植进 aether-cms，并补充了中英文界面、自定义发布时间、主题无关资源等改进。

---

## ✨ 功能清单

### 内容编辑与发布
- 后台编辑器（`/aether`）：标题/副标题/正文 + Markdown 实时预览
- **列表缩略内容智能清洗**：文章以 `[video:…|标题]` 等扩展语法开头时，卡片摘要自动提取可读文字（保留视频标题、丢弃 URL 与指令），而不是显示原始 Markdown
- **卡片媒体角标**：列表卡片标题后显示 🎬 含视频 / ⌨️ 含终端录制 / 📎 含附件，便于快速识别内容形态
- 工具栏一键插入：**图片**（媒体库选择）、**视频嵌入**（YouTube / Vimeo / 本地 / asciinema）、**原始 HTML/iframe**、**Wiki 链接**、**Callout**
- 输入 `[[` 自动联想已发布文章（Obsidian 式补全）
- 媒体库：图片/文档上传、删除、元信息编辑
- 分类 / 标签 / 相关文章 / SEO 设置 / 摘要 / 作者
- **自定义发布时间**：新建/编辑时可选任意发布时间，列表与文章页按发布时间显示与排序

### 视频资源（PeerTube 集成）
- **视频封面卡**：列表卡片显示 PeerTube 缩略图 + 播放角标 + 时长徽标（元数据本地缓存，渲染时零网络请求）
- **点击加载门面**：文章页不再直接插入第三方 iframe，先显示封面与 ▶，点击后才载入播放器（更快、省流量、无第三方 Cookie；禁用 JS 时回退 iframe）
- **视频库 `/videos`**：聚合全站含视频的内容，支持按标签筛选与分页
- **分享与收录**：自动注入 OpenGraph（`video.other` / `og:video` / 封面图）、Twitter Card 与 JSON-LD（`Article` + `VideoObject`）
- **兼容哔哩哔哩**：`BV…` / `av…` / `b23.tv` 链接自动转为播放器嵌入（封面用占位样式）
- 配置：`.env` 中的 `PEERTUBE_URL` 等（见 `.env.example`）；元数据缓存于 `content/cache/peertube/`
- ⚠️ 若服务器**无法访问 `PEERTUBE_URL` 的公网域名**（内网没有回环 NAT / split-DNS），请额外设置 `PEERTUBE_API_URL` 指向 PeerTube 的**局域网地址**用于服务端取元数据，访客端仍使用公网域名播放

### 站内搜索 `/search`
- **服务端搜索页**，零依赖、零前端索引文件：直接对已发布内容（文章 + 页面）打分排序，本地实测 10 篇内容耗时 **5 ms**
- **排序规则**：整句命中标题 > 标题 > 标签 > 副标题 > 分类 > 正文（正文命中次数累加）；多关键词默认 **AND**（全部命中），若无结果自动**放宽为任意命中**并明确提示
- **精确短语**：用 `"引号"` 包住可整体匹配；中文单字可搜，单个拉丁字母会被忽略；最多取 6 个关键词
- **每页 12 条**（`SEARCH_PER_PAGE` 可调），分页链接保留查询与筛选
- **筛选与排序**：类型（文章/页面）、标签、分类（带命中计数）；排序支持 相关度 / 最新 / 阅读最多（阅读数来自自建统计）
- **结果可解释**：每条结果标注命中位置（如「标题、正文 3 处」）、`YYYY-MM-DD` 日期、分类、阅读数与**高亮摘要**（正文首个命中处 ±70 字符）
- **无关键词时**展示全站统计、热门标签、分类与最新内容；**无结果时**给出缩短关键词、用引号精确匹配等建议 + 热门标签兜底
- **实时联想**（可选增强）：`assets/search-suggest.js` 复用公开 API `/api/public/posts?q=`，输入即出下拉建议（↑↓ 选择、回车跳转、Esc 关闭）；关闭 JS 或接口不可用时表单照常工作
- 搜索页带 `robots: noindex, follow`（避免结果页被搜索引擎收录），并已加入主题的「搜索 →」导航（与「视频库 →」「标签云 →」并列）
- JSON 形式（便于调试/聚合）：`/search?q=…&format=json` 返回 `total / relaxed / facets / results[]`（含 `score`、`hits`、`snippet`、`views`）
- ⚠️ `/search` 路径由内置搜索页占用；若你有同名的自定义页面，请改用其他 slug

### 视频自动播放与顺序连播
- **打开文章即自动播放**：第一个视频进入视口时自动开始（首屏有视频则立即开始；视频在折叠线以下时，等滚动到它再开始，避免白白下载）
- **多视频顺序连播**：当前视频结束后自动滚动到下一个继续播放，直到全部播完
- **页面左下角控制条**：`⏸ 停止连播 / ▶ 自动连播`、`第 n/N 个`、`🔊 开声 / 🔇 静音`、`⏭ 下一个`、`↺ 重新播放`（时长计时到点时会额外出现 `✋ 取消`）；访客的选择存在浏览器本地，优先于站点默认值
- **默认静音起步**：浏览器禁止带声音的自动播放，点「🔊 开声」会在**当前进度续播**并带声音（不需要重看开头）
- 结束检测：**主用缓存的视频时长**推算结束时刻（届时先弹 5 秒倒计时，可点「✋ 取消」留在当前视频）；本地文件视频（`[video:file.mp4]`）用原生 `ended` 事件精确推进；若播放器确实上报 `postMessage` 事件则自动改用精确推进
- 说明：PeerTube 的 embed 页面**不会**向父页面发送普通事件（官方 Embed API 需要 `?api=1` + `@peertube/embed-api` jschannel 客户端，本项目不引入该依赖），所以时长计时是主要机制
- 省流量模式（`saveData`/2G）下不自动播放；切到后台标签页时暂停推进计时；自动开始不抢焦点、不打断阅读位置
- 哔哩哔哩视频可以自动开始，但没有时长/结束事件，队列走到它时需要点「⏭ 下一个」
- 配置：`.env` 中的 `VIDEO_AUTOPLAY`（默认开启；设为 `false` 则默认不自动播放，控制条仍可供访客自行开启）、`VIDEO_AUTOPLAY_MUTED`
- 排查：URL 追加 `?aether-video-debug=1` 可在控制条看到最近的播放器事件，控制台会打印完整 payload
- ⚠️ 静态导出页不含自动播放（运行时由服务端钩子注入，同分享条/OG 的限制）；主题若要在导出页支持，可在布局里自行引入 `/assets/video-playlist.js`

### 附件与分享
- **附件清单块**：正文中的 `[file:路径|名称]` 自动汇总为文章底部「附件下载」区块，显示类型图标、文件名、体积与下载按钮；文件不存在时标注「文件缺失」并置灰
- **分享栏**：文章详情页自动生成分享条，支持**复制链接**、**二维码**（本地同步生成 SVG，不请求任何第三方服务）、**微信 / 企业微信**（弹层展示二维码）、**QQ / QQ 空间**、**打印 / 另存 PDF**（打印样式已优化）；含视频的文章额外提供「🎞️ 原视频」入口
- 分享栏与附件块均由全局钩子注入，**切换任意主题都生效**；不含 Twitter/X 等受限平台
- 配置：`.env` 中的 `SHARE_BAR_ENABLED`

### 开放接口（只读 API / oEmbed）
- `GET /api/public/site`：站点信息（标题、描述、URL、语言、导航）
- `GET /api/public/posts`：已发布文章列表，支持 `limit` / `offset` / `tag` / `category` / `q` / `hasVideo` / `hasAttachment`
- `GET /api/public/posts/:slug`：单篇内容（加 `?html=1` 返回渲染后的 HTML）
- `GET /oembed?url=…`：标准 oEmbed，文章返回 `rich`，PeerTube 视频返回 `video`
- 所有响应带 `Access-Control-Allow-Origin: *` 并支持 `OPTIONS` 预检；**仅返回已发布内容**，不暴露文件路径；内置**按 IP 限流**（默认 120 次/分钟）
- 配置：`.env` 中的 `PUBLIC_API_ENABLED`、`PUBLIC_API_RATE_LIMIT`

### Markdown 富语法渲染（移植自 hblog-ng）
- `[[WikiLink]]`、`[[目标#锚点|显示文字]]`、`![[图片嵌入]]`
- KaTeX 数学公式：`$行内$` / `$$块级$$`
- Obsidian Callout：`> [!WARNING]` / `> [!INFO]` / `> [!TIP]` 等
- `[video:URL|标题]` 视频、`[asciinema:id]` 终端录制、`[file:路径|名称]` 附件
- `#标签` → 标签页；原始 HTML（如 `<iframe>`）直接透传
- GFM：表格、任务列表、代码高亮、脚注

### 内容组织与知识图谱（Obsidian 式）
- 所有已发布内容统一在 **`/notes/<slug>`** 路由下
- 保存时自动解析 `[[wikilinks]]` 生成**双向关系**：文章页显示「反向链接 + 相关笔记」
- **知识图谱页 `/notes/graph`**：零依赖 canvas 力导向图，支持节点拖拽、空白平移（边界停住）、滚轮缩放、双击复位、搜索筛选、点击跳转
- **标签云 `/tag-cloud`**：按所有已发布文章的标签频次生成词云（胶囊芯片 + 缓慢漂浮），点击跳转到对应标签的文章列表；后台内嵌 `/aether/tag-cloud`
- 后台内嵌图谱页 `/aether/graph`

### 界面与多语言
- 后台**中英文界面切换**（设置 → 界面语言），语言包可扩展
- 登录、侧边栏、仪表盘、内容列表、媒体库、主题、用户、设置页等均支持 i18n

### 访问统计（自建 first-party，无第三方脚本）
- 前台文章/页面显示**阅读次数**（文章页、首页/分类/标签列表卡片、自定义列表页均显示）
- **知识图谱按节点显示阅读量**：`/notes/graph` 与后台 `/aether/graph` 的节点卡片显示 `👁 N`，页首统计含总阅读数
- **图谱热度可视化与筛选**：节点卡片大小/描边/暖色底随阅读量递增（对数缩放，热门节点更醒目、≥100 次转橙），画布右下角显示图例；工具栏新增「全部阅读量 / 阅读 Top 5/10/20 / 有阅读 / 未被阅读」筛选
- 后台 **`/aether/analytics`**：总览 PV/UV、日均、累计；PV/UV **趋势图**（零依赖 canvas）；**文章访问排行**（Top 20 + 完整 CSV 导出）；**访问终端**（设备 / 系统 / 浏览器）；**外部来源站点**；**最近访问明细**（时间 / 页面 / 掩码 IP / 终端）
- 非文章页面显示**可读名称**而非编码路径：`首页`、`标签：小学`、`标签筛选：小学 × 数学`、`分类：技术`、`知识图谱`、`标签云`，且均可点击跳转
- 存储为**纯文件**，无数据库：`content/data/analytics/views-YYYY-MM-DD.jsonl`（明细）+ `summary.json`（汇总）
- **隐私友好**：只记录**掩码 IP**（IPv4 保留前三段、IPv6 保留前 3 组）与**加盐哈希**，不保存完整 IP；原始明细按保留期自动清理
- 自动过滤爬虫/机器人；默认**不统计已登录用户**（避免作者自己浏览污染数据）；同一访客对同一页面 30 分钟内只计一次
- 相关 `.env` 配置：`ANALYTICS_ENABLED`、`ANALYTICS_DIR`、`ANALYTICS_SALT`、`ANALYTICS_RETENTION_DAYS`、`ANALYTICS_TRUST_PROXY`、`ANALYTICS_EXCLUDE_ADMINS`、`ANALYTICS_DEDUP_MINUTES`
- ⚠️ 部署在 nginx/CDN 之后时，需设 `ANALYTICS_TRUST_PROXY=true` 才能取到真实访客 IP（只在反代后开启，否则 IP 可被伪造）
- ⚠️ `npm run build` 静态导出页无法回写统计，阅读计数仅在动态模式可用

### 主题无关的增强样式
- 扩展样式集中在 `/assets/aether-extras.css`，由全局钩子注入每个前台页面
- **切换任意主题，Wiki 链接/Callout/公式/视频/知识图谱样式保持一致**；`/notes/graph` 在任何主题下都套用当前主题的站点框架

### 用户与安全
- 纯文件存储（JSON），**无数据库**；用户/会话/设置存于 `content/data/`
- 角色：**admin** / **editor**（用户管理、静态生成等仅 admin）
- 密码哈希使用 Node 内置 **scrypt**（无原生依赖，兼容旧 glibc 服务器）
- 登录限流（连续失败 5 次锁定 15 分钟）、会话 24 小时过期
- **敏感路径拦截**：`/.env`、`/.git/**`、`/content/data/**`、`/content/cache/**`、上传目录的 `*.metadata.json`、`/core/**`（后台静态资源除外）、`package*.json`、`README/CHANGELOG/LICENSE/DEPLOYMENT-*` 等一律返回 404，避免「文件即内容」架构把配置与草稿目录直接暴露为静态文件

### 性能与导出
- 动态发布（保存即生效），可选 `npm run build` 静态导出（含图谱页、`/notes/` 路径）
- RSS / Atom / JSON Feed、sitemap、robots、SEO 元信息

---

## 🚀 快速开始

要求：Node.js ≥ 18（建议 20+）

```bash
npm install
npm start
```

- 前台站点：`http://localhost:8080`
- 知识图谱：`http://localhost:8080/notes/graph`
- 管理后台：`http://localhost:8080/aether`（默认账号 `admin` / `admin`，**首次登录后请立即修改**）

端口可用环境变量修改：

```bash
PORT=3000 npm start
# 或创建 .env：PORT=3000
```

会话签名密钥（生产环境必填，未设置会有安全警告）：

```bash
# .env
COOKIE_SECRET=一串足够长的随机字符串
# 可用 node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" 生成
```

参考 `.env.example`。

静态导出（可选）：

```bash
npm run build -- --output dist
```

---

## 📁 目录结构（关键部分）

```
core/lib/markdown/          Obsidian 渲染器（marked 扩展）与关系引擎
core/lib/analytics/         访问统计（UA 解析、JSONL+汇总存储、采集中间件）
core/utils/analytics-utils.js 统计聚合、趋势/排行/分布计算与 CSV 导出
core/routes/notes.js        /notes/graph 与 /notes/:slug 统一内容路由
core/routes/videos.js       /videos 视频库聚合页
core/routes/search.js       /search 站内搜索（打分/高亮/筛选/分页/JSON）
core/api/public-api.js      只读公开 API 与 oEmbed 端点（含 CORS 与限流）
core/lib/media/peertube.js  PeerTube 元数据抓取与本地缓存
core/lib/media/social-meta.js  OpenGraph / Twitter Card / JSON-LD 注入
core/lib/media/attachments.js  [file:] 附件清单块
core/lib/media/share-bar.js    分享栏与二维码（零第三方请求）
core/admin/                 后台界面（编辑器、媒体库、主题、用户、i18n）
core/app.js                 全局钩子（charset、样式、分享栏、敏感路径拦截）
assets/aether-extras.css     主题无关的扩展样式
assets/share-bar.js          分享栏前端交互（复制/弹层/打印）
assets/video-facade.js       视频门面点击加载（唯一 iframe 加载器）
assets/video-playlist.js     自动播放与顺序连播调度（控制条/队列）
assets/search-suggest.js     搜索框实时联想（复用公开 API，可降级）
assets/knowledge-graph.js    知识图谱运行时（零依赖 canvas）
assets/tag-cloud.js          标签云运行时（零依赖）
content/data/               内容与用户数据（.md + JSON，已被 .gitignore 排除）
content/themes/             主题（默认主题含图谱模板与知识关联区块）
```

---

## 🔧 部署（生产）

**进程守护（pm2）：**

```bash
npm install -g pm2
pm2 start index.js --name aether-cms
pm2 save
pm2 startup
```

**nginx 反代示例：**

```nginx
server {
    listen 80;
    server_name your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 📄 许可证与致谢

本项目遵循 **GNU General Public License v3.0 or later (GPL-3.0-or-later)**，基于以下开源项目构建：

- **[aether-cms](https://github.com/LebCit/aether-cms)**（GPL-3.0-or-later，作者 LebCit）—— 文件式 CMS 主体：后台、内容管理、主题系统、静态生成。
- **[hblog-ng](https://github.com/halit/hblog-ng)**（MIT，作者 Halit Alptekin）—— Obsidian 知识图谱博客的渲染扩展与图谱物理模拟，已移植进本项目；移植代码（marked 扩展、知识图谱 canvas 模拟、wiki 关系引擎）保留其 MIT 版权声明并随整体以 GPL-3.0 分发。

> 说明：MIT 组件可并入 GPL 项目；整合后整体代码按 **GPL-3.0** 对外分发。使用/再分发时请保留 LICENSE 与本说明中的版权归属。

第三方依赖（marked、katex、litenode 等）保留各自许可证。
