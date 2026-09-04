# 更新日志 (CHANGELOG)

本项目是 [aether-cms](https://github.com/LebCit/aether-cms) 的增强分支，整合了 [hblog-ng](https://github.com/halit/hblog-ng) 的 Obsidian 渲染与知识图谱能力。以下记录自集成以来新增的功能与修复。

> 版本号遵循语义化。

## [0.5.0] - 2026-09-04

### 🆕 新增功能

- **标签词云 (Tag Cloud)**：`/tag-cloud` 前台页 + 公开 `/api/tags` 接口，按所有已发布文章的标签频次生成视觉词云；每个标签是独立的胶囊芯片并错峰缓慢漂浮，点击跳转到对应标签的文章列表。
- **后台标签云**：后台侧边栏新增「标签云」入口，`/aether/tag-cloud` 在后台框架内直接展示，与知识图谱一致，支持中英文界面。
- **Obsidian 富渲染**：`[[wikilinks]]`、`![[embeds]]`、KaTeX 公式、Callout、`[video:]`、`[asciinema:]`、`[file:]`、`#标签`，前台渲染与后台预览一致。
- **知识图谱**：`/notes/graph` 零依赖 canvas 力导向图，支持节点拖拽、空白平移（边界停住）、滚轮缩放、双击复位、搜索/类型筛选、点击跳转；后台内嵌 `/aether/graph`。
- **统一内容路由**：所有已发布内容走 `/notes/<slug>`；保存时自动解析 wikilink 生成双向「反向链接 + 相关笔记」。
- **后台中英文界面 (i18n)**：设置 → 界面语言切换，覆盖登录、侧边栏、仪表盘、内容列表、媒体、主题、用户、设置、编辑器等。
- **自定义发布时间**：新建/编辑文章时可选任意发布时间，列表与文章页按发布时间显示与排序。
- **主题无关扩展资源**：扩展样式与图谱脚本集中到 `/assets/`，由全局钩子注入；切换任意主题，Wiki 链接/Callout/公式/视频/图谱/标签云样式保持一致，`/notes/graph` 套用当前主题框架。
- **用户安全**：密码哈希改用 Node 内置 `scrypt`（移除 argon2 原生依赖，兼容旧 glibc 服务器）；登录限流、会话管理。

### 🐛 修复

- **KaTeX 控制台刷屏**：数学公式（`$...$`/`$$...$$`）中出现中文顿号"、"等非 LaTeX 字符时，不再输出 `unicodeTextInMathMode` 警告（`strict: false`），公式仍正常渲染；后台预览同步修复。
- **Cookie 密钥硬编码**：签名密钥改为从 `COOKIE_SECRET` 环境变量读取（未设置时给出明显警告并回退到开发值），新增 `.env.example`。
- **编辑器预览渲染**：预览改为服务端 `/api/preview` 渲染（与前台一致），修复 `[[wikilinks]]` / callout / 公式在预览中显示原始文本的问题。
- **Admin 静态资源缓存**：`/core/admin/static/` 的 JS/CSS 返回 `no-cache`，杜绝"改动后浏览器仍用旧 JS"。
- **中文分类/标签**：不再用 `slugify` 清空非 ASCII，中文分类/标签原样保存、显示。
- **中文路径 404**：对 `category`/`tag`/`notes`/custom 路由参数做 URL 解码（litenode 不解码百分号编码），修复 `/category/安可测评` 等中文路径 404。
- **PeerTube 视频**：识别 PeerTube 观看页 `/w/<id>`、`/videos/watch/<id>` 并自动转为 `/videos/embed/<id>` iframe 嵌入。
- **Knowledge Graph 交互**：区分「拖动节点」与「点击跳转」（改为基于指针位移判定）；新增画布平移（边界钳制）、双击复位视图。
- **知识图谱独立页无主题框架**：`/notes/graph` 改为以"普通页面"方式渲染进当前主题布局，非默认主题也保留站点导航/页脚。
- **登录/编辑器默认管理员**：首次运行自动创建 `admin/admin`（scrypt 哈希）。

---
