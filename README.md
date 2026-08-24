# Aether CMS × hblog-ng 整合版

基于 [aether-cms](https://github.com/LebCit/aether-cms)（GPL-3.0）并整合 [hblog-ng](https://github.com/halit/hblog-ng)（MIT）能力的内容发布系统：

**「文件即内容」的 Markdown 发布 + 后台可视化编辑 + Obsidian 式知识图谱**。所有内容以 `.md` 文件存储，动态发布（保存即生效），无数据库依赖。

> 本仓库是 aether-cms 的增强分支（fork），把 hblog-ng 的 Obsidian 渲染与知识图谱能力移植进 aether-cms，并补充了中英文界面、自定义发布时间、主题无关资源等改进。

---

## ✨ 功能清单

### 内容编辑与发布
- 后台编辑器（`/aether`）：标题/副标题/正文 + Markdown 实时预览
- 工具栏一键插入：**图片**（媒体库选择）、**视频嵌入**（YouTube / Vimeo / 本地 / asciinema）、**原始 HTML/iframe**、**Wiki 链接**、**Callout**
- 输入 `[[` 自动联想已发布文章（Obsidian 式补全）
- 媒体库：图片/文档上传、删除、元信息编辑
- 分类 / 标签 / 相关文章 / SEO 设置 / 摘要 / 作者
- **自定义发布时间**：新建/编辑时可选任意发布时间，列表与文章页按发布时间显示与排序

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
- 后台内嵌图谱页 `/aether/graph`

### 界面与多语言
- 后台**中英文界面切换**（设置 → 界面语言），语言包可扩展
- 登录、侧边栏、仪表盘、内容列表、媒体库、主题、用户、设置页等均支持 i18n

### 主题无关的增强样式
- 扩展样式集中在 `/assets/aether-extras.css`，由全局钩子注入每个前台页面
- **切换任意主题，Wiki 链接/Callout/公式/视频/知识图谱样式保持一致**；`/notes/graph` 在任何主题下都套用当前主题的站点框架

### 用户与安全
- 纯文件存储（JSON），**无数据库**；用户/会话/设置存于 `content/data/`
- 角色：**admin** / **editor**（用户管理、静态生成等仅 admin）
- 密码哈希使用 Node 内置 **scrypt**（无原生依赖，兼容旧 glibc 服务器）
- 登录限流（连续失败 5 次锁定 15 分钟）、会话 24 小时过期

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

静态导出（可选）：

```bash
npm run build -- --output dist
```

---

## 📁 目录结构（关键部分）

```
core/lib/markdown/          Obsidian 渲染器（marked 扩展）与关系引擎
core/routes/notes.js        /notes/graph 与 /notes/:slug 统一内容路由
core/admin/                 后台界面（编辑器、媒体库、主题、用户、i18n）
core/app.js                 全局钩子（charset、主题无关样式注入）
assets/aether-extras.css     主题无关的扩展样式
assets/knowledge-graph.js    知识图谱运行时（零依赖 canvas）
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
