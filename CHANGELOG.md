# 更新日志 (CHANGELOG)

本项目是 [aether-cms](https://github.com/LebCit/aether-cms) 的增强分支，整合了 [hblog-ng](https://github.com/halit/hblog-ng) 的 Obsidian 渲染与知识图谱能力。以下记录自集成以来新增的功能与修复。

> 版本号遵循语义化。

## [0.16.3] - 2026-09-15

### 🔍 首次真机差异核对（xl 实例）：结果与处置

用 `tools/instance-fingerprint.mjs` 对 xl 实例做第一次全量核对（428 个文件 vs 仓库 262），三类结果全部查清：

**`MISSING_IN_REPO` 177 → 实为 1 + 176，都不是"热修"**

| 内容 | 数量 | 处置 |
|---|---|---|
| `.env`（COOKIE_SECRET） | 1 | **不该回收** —— 见下文的工具修复 |
| 后台装的主题 `clean_blog` / `editorial` / `midday` / `old_writer` / `pure` | 176 | 实例资产，按 `.gitignore` 设计不入库（记录来源即可） |

**`DIFFERS` 3 → 1 个真差异 + 1 个伪差异 + 1 个无意义差异**

| 文件 | 判定 | 说明 |
|---|---|---|
| `content/themes/default/partials/footer.html` | **真差异，已回收** | 线上 xl 与 xq 都多一层 `<div class="footer-row">`，仓库从未有过（`git log -S footer-row` 无记录，且全仓无该 class 的 CSS，属无效包裹）。已按线上内容回收，使仓库与生产一致；若确认多余，删掉后再同步两台即可 |
| `content/themes/default/screenshot.avif` | **伪差异** | 两侧字节完全相同，是"删全部 CR"与"仅替换 CRLF 对"两种归一化实现不一致造成的误报（AVIF 里有孤立 0x0D 字节）→ 见工具修复 |
| `.gitignore` | 无意义差异 | 服务器上是 403 B 的旧版；服务器不是 git 检出，该文件在那里不起作用，下次同步会被覆盖为当前 818 B 版本 |

**`MISSING_IN_INSTANCE` 11** —— 均为仓库更新、尚未部署到 xl（`docs/**`、`TAG-GOVERNANCE.md`、`DEPLOYMENT-AI-TAGS.md`、`tools/backup-content.ps1`、`tools/rotate-security.ps1`、`tools/sync-today-to-server.ps1`、`docs/XL-PROJECT.md`）。属正常，之后用同步脚本推上去。

### 🐛 工具修复：`.env` 会出现在"要回收"清单里 + 二进制伪差异 + 清单被淹没

首次真机使用暴露了三个问题，全部修掉：

1. **`.env` 被列为 `MISSING_IN_REPO`** —— 最危险的一条：只要照着"把实例有、仓库没有的文件回收一下"动手，`COOKIE_SECRET` 就进了 Git。现在按文件名排除 `.env` 及其变体（`.env.example` 例外，它是入库模板），并且**在解析指纹时也过滤一遍** —— 因为比对用的清单可能来自旧版工具或 Linux 上的纯 shell 兜底命令。本工具自己的 `*.fingerprint.txt` 输出同样排除（否则第二次运行会把上次结果当成新增文件）。
2. **二进制伪差异** —— 归一化从"仅替换 CRLF 对"改为"**删除所有 CR 字节**"（等价 `tr -d '\r'`），与 Linux 侧 shell 兜底命令逐字节一致。这样两种生成方式可以互相校验，也消除了孤立 0x0D 造成的误报。
3. **清单被淹没** —— 差异清单改为按前两级目录分组，单组超过 15 个文件只给计数（`content/themes/** 176 个文件（--verbose 展开）`），真正需要人看的少量文件仍然逐个列出。

新增 `--verbose` 开关。本地验证：真实的 xl 指纹复跑后 `需回收 176`（全部为主题）且 `.env` 消失；伪造含 `.env` / `.env.example` / `content/data/users.json` / `old.fingerprint.txt` / `core/app.js` 的五条清单，只有后两条被保留，前三条正确过滤。

## [0.16.2] - 2026-09-15

### 🐛 修复 `instance-fingerprint` 漏比主题：`content/themes/**` 必须参与核对

首次在服务器上使用前的自查发现：工具原先把**整个 `content/` 目录**排除，理由是"实例数据不入库"。但 `content/themes/**` 是**入库的代码/资源** —— 而且它正是 xl 拆分后最需要被发现差异的地方（模板定制）。带着这个缺陷去做拆分核对，会漏掉主题改动，等于把最该保护的东西漏在检查之外。

改为两类排除：

| 类型 | 内容 |
|---|---|
| 目录名（任何层级） | `node_modules`、`.git`、`cache`、`.npm-cache`、`release`、`_site`、`.backups`、`.tag-merge-backups` |
| 相对路径 | `content/data`（users.json / sessions.json / analytics）、`content/uploads`（图片与附件）、`content/cache` |

`content/themes/**` 参与比对；指纹头部新增 `# excludedPaths` 行，一眼能看出排除了什么。

本地验证（夹具 = 「仓库副本 CRLF」/「实例副本 LF + 改 1 个主题模板 + 新增 1 个模板」共 40/41 个文件）：

| 判定 | 结果 |
|---|---|
| 改动主题模板 | `DIFFERS content/themes/ember/templates/collection.html` ✅ |
| 新增主题模板 | `MISSING_IN_REPO content/themes/ember/templates/xl-extra.html` ✅ |
| 仅行尾不同的 39 个文件 | 零误报 ✅ |

顺带得到一个交叉验证：本仓指纹的文件数 **261** 与 GitHub `aether-cms-xl/main` 文件树里的 blob 数 **261** 一致。

## [0.16.1] - 2026-09-15

### 🐛 回收一处「只在服务器上存在」的修复：Tabulator 卡在 Loading

在为「把 xl 实例拆成独立项目」做前期核对时发现：服务器上的实例**不是 git 检出**（部署方式是 tar + scp 覆盖），所以就地手改过的文件既不在 `git status` 里，也没有任何提交记录。

核对方法：`/assets/**`、`/core/admin/static/**`、`/content/themes/**` 这些路径是**公网可直接访问**的，于是逐个抓下来与本地仓库**按行尾归一化后**比对 sha256：

| 路径 | 文件数 | 一致 | 不同 |
|---|---|---|---|
| `content/themes/ember/**`（xl 正在用 ember） | 17 | **17** | 0 |
| `assets/**` | 11 | **11** | 0 |
| `core/admin/static/**`（不含 vendors） | 87 | 86 | **1** |

唯一不同的是 `core/admin/static/js/table/modules/tabulator.js`：**线上 xl 与 xq 都有、仓库里没有**，且线上版本是本地版本的**严格超集**（多 15 行，无本地独有内容）：

```js
// Fixed height + non-virtual vertical rendering. Without these, Tabulator
// v6 can get into a resize ⇄ render feedback loop … which throws
// "Maximum call stack size exceeded" and leaves the table stuck on "Loading".
height: "calc(100vh - 320px)",
renderVertical: "basic",
// Never leave the table spinning forever if the data request fails.
ajaxError: function (error) { … this.alert("加载表格数据失败：…") }
```

已按线上实际内容回收进仓库（`git diff` = +15 行），并把该文件补进同步清单 —— 漏出清单的文件既推不出去也拉不回来，这正是它当初只能存在于服务器上的原因（与 `core/utils/tag-cloud-utils.js` 属同一类事故）。

### 🔧 新增 `tools/instance-fingerprint.mjs`：实例 ↔ 仓库差异核对

拆分/迁移任何实例之前的第一步。在服务器实例目录内生成指纹，拉回本地与仓库指纹比对，输出三类差异：

- `MISSING_IN_REPO` —— 实例有、仓库没有（**服务器侧改动，拆分前必须回收**）
- `DIFFERS` —— 两边都有但内容不同
- `MISSING_IN_INSTANCE` —— 仓库有、实例没有（仓库更新，或该文件从未部署到这台实例）

关键细节：本地工作副本是 CRLF、服务器是 LF，**直接比 sha256 会得到"每个文件都不同"**（本次实测：ember 主题 17 个文件全部"不同"，逐行核对后 17/17 完全一致）。工具对所有文件先做 CRLF→LF 归一化（latin1 逐字节映射，二进制文件语义一致）再算哈希。默认排除 `content/`（实例数据）、`node_modules/`（各机自装）、缓存与归档目录；有需回收项时退出码为 1，可直接当门禁用。

用法：

```bash
# 服务器上（实例目录内）
node tools/instance-fingerprint.mjs --root . --out /tmp/xl.fingerprint.txt
# 本机
scp admin@<host>:/tmp/xl.fingerprint.txt .
node tools/instance-fingerprint.mjs --root . --out xl-repo.fingerprint.txt
node tools/instance-fingerprint.mjs --compare xl.fingerprint.txt --against xl-repo.fingerprint.txt
```

本地验证：构造「仓库副本（CRLF）/ 实例副本（LF + 1 个改动文件 + 1 个新增文件）」两组 24/25 个文件，比对精确报出 `MISSING_IN_REPO 1`、`DIFFERS 1`、`MISSING_IN_INSTANCE 0`；23 个仅行尾不同的文件**零误报**，退出码 1。

## [0.16.0] - 2026-09-13

### ✨ 后台「系统维护」页 —— 只读体检（/aether/maintenance）

**问题**：维护能力全在 `tools/` 下的 CLI 里，日常最常用的其实是「看一眼现在有没有问题」，而这部分本来完全只读——却仍要 ssh 上去或在本地跑脚本。而且"在哪运行"并不统一：

| 工具 | 运行位置 | 为什么 |
|---|---|---|
| `tag-audit.mjs` | 本机或服务器 | 纯只读，可 `--dir content/data` 离线体检 |
| `tag-merge.mjs` | 内容文件所在机器 | 要改写 `.md` |
| `backup-content.ps1` | **本机** | ssh 上去打包 + scp 拉回本地（异地副本） |
| `sync-today-to-server.ps1` | **本机** | 推文件到服务器 |
| `rotate-security.ps1` | **服务器** | 改 `.env`、清会话、tmux 重启进程 |
| `reset-admin-password.mjs` | **服务器** | 忘密码时也得能进，故意留在 Web 之外 |

**方案**：把其中**只读**的那部分搬进后台，其余留在 CLI，并在页面上把边界写清楚（避免误以为"后台能维护一切"）。

`/aether/maintenance` 一页给出 10 段体检：实例信息 · 内容体量 · 字段完整度 · 标签 · 学段 · 上传与附件 · 配置文件健康 · 备份现状 · 访问统计 · 安全自检，并把需要人看一眼的项汇总成「需要留意」清单（error / warn 分级）。

实现要点：

- `core/lib/maintenance/site-doctor.js`：纯函数式只读体检。**不写任何文件、不改配置、不 spawn 子进程**；唯一副作用是向 `127.0.0.1:<本进程端口>` 发几个自我请求，用于确认 `/.env`、`/content/data/users.json`、`/core/app.js` 仍然是 404（端口取自 `req.socket.localPort`）。每段独立 try/catch，单项失败降级为一条提醒而不影响整份报告。
- `core/api/maintenance-api.js`：
  - `GET /api/maintenance/report` — JSON 报告（`authenticate` 中间件保护）
  - `GET /api/maintenance/backup.zip` — **就地**打包 `content/data` + `content/uploads` 供下载，内含 `BACKUP-MANIFEST.json`（与 CLI 备份口径对齐：实例路径、端口、PID、主题、条目清单与体量）；`?uploads=0|1`、`?analytics=0|1` 控制内容，默认不含 `analytics/views-*.jsonl`、超过 512 MB 直接拒绝并提示改用 CLI（adm-zip 在内存组装，且本页归档只是**就地临时副本**，异地留档仍需 `backup-content.ps1`）
  - 归档名带端口（`aether-content-port8095-….zip`）—— 三台实例目录同名，只看目录名会分不清
- `core/app.js`：`systems` 新增 `paths`（rootDir / contentDir / dataDir / uploadsDir / themesDir），维护页据此报告"自己看的是哪一份 content/"
- 后台页：`views/contents/maintenance.html` + `static/js/maintenance.js`（仅「重新体检」用 JSON 接口刷新结论条，「下载备份」是纯链接、无 JS 也能用）+ `static/css/maintenance.css`，侧边栏新增「🔧 系统维护」（`nav_maintenance` / `maint_*` 中英双语）
- **单实例视角**：三台实例是三个独立进程，本页只覆盖当前登录的这一台

本地验证（`PORT=8095`，临时造了测试夹具，验证后已全部回滚）：

| 场景 | 结果 |
|---|---|
| 报告生成 | 200，10 段齐全，耗时 73 ms |
| 未登录访问 | 页面 302 → `/aether/login`；两个 API 均 401 |
| 安全自检 | `/.env` 404 · `/content/data/users.json` 404 · `/core/app.js` 404 · `/` 200，全部符合预期 |
| 配置文件健康 | settings/users/sessions/menu/login-attempts/tag-aliases 全部可解析 |
| 孤儿上传 | 造 1 个未被引用的 png → 精确识别为 1（sidecar 不误报） |
| 引用但缺失 | 造 2 处坏链 → 识别为 2，并列出引用它的文章标题 |
| zip 归档 | `?uploads=1&analytics=0` → 18 个条目 + manifest（跳过 2 个 views 明细）；`?analytics=1` → 21 个；上传目录内容确实进包 |
| 状态分级 | 造出 error 后 `ok=false`，页面状态条转为红色并列出 4 条待办 |
| 学段分级 | 全站未用学段 → `info`（可选维度）；部分使用才 `warn` |

> 本页做不到的事已在页面底部写明：跨机同步、异地留档、密钥轮换/重启进程、口令重置、一次覆盖三台实例——这些仍然必须走 CLI。

## [0.15.5] - 2026-09-13

### ✨ 分类 × 学段的交叉筛选（「心理微课里所有小学文章」有 URL 了）

`/category/心理微课` 与 `/stage/小学` 各自只能看一个维度，「列出某分类下某学段的文章」原先无法用 URL 表达（只能进搜索页敲关键词）。现在两个页面互为镜像，**参数名就是维度名**：

```
/category/心理微课?stage=小学          ← 分类页里筛学段
/stage/小学?category=心理微课          ← 学段页里筛分类（与上一行等价）
/category/心理微课?stage=小学&tag=情绪管理    ← 再叠加标签（AND）
/stage/小学?category=心理微课&tag=情绪管理
```

两个页面都会多出一条**筛选面板**（复用标签工作台的样式与注入通道 `res.tagWorkbenchHtml`，因此不需要改任何主题模板）：分类页给出「学段」行（本分类下各学段篇数），学段页给出「学段 + 分类」两行，标签筛选生效时再加一行「标签」，右上角有「清除筛选」。

细节：

- **分页保留筛选**：`core/utils/pagination-utils.js` 的 `generatePaginationUrls` / `enhancedFormatPagination` 新增 `extraQuery`，动态站点的分页链接从 `?page=2` 变为 `?page=2&stage=小学`（原先分页会丢掉筛选条件）。
- **页头/标题**：`Category: 技术 · 小学`，`taxonomyTerm` 与 `<title>` 同步。
- **空白组合不假装失效**：某分类下没有该学段时，该学段 chip 仍以 `active` + 计数 `0` 显示（`ensureActiveChip`），列表显示「No posts found」而不是静默回到全量。
- **301 规范化保留筛选**：`/stage/%E5%B0%8F%E5%AD%A6?category=技术&page=2` → `/stage/小学?page=2&category=技术`。
- **去掉搜索空态的原地打转**：搜索页无关键词时，标签/分类 chips 从 `?tag=`/`?category=`（点进去还是同一页）改为直达 `/tag/:slug`、`/category/:slug`（学段在 0.15.4 已如此）。
- 新增 `core/utils/taxonomy-filter-utils.js`：`postStageOf` / `postCategoryOf` / `postTagsOf`、`filterPostsByStage|Category|Tag`、`countStages` / `countCategories`、`ensureActiveChip`、`buildTaxonomyUrl`、`buildChips`、`buildCrossFilterBarHtml`（纯函数，路由只负责取参数与渲染）。

本地验证（`PORT=8095`，临时给 5 篇演示文章加学段、验证后回滚；演示内容为「技术」7 篇 +「知识管理」3 篇）：

| 操作 | 结果 |
|---|---|
| `/category/技术` | 共 7 篇，面板出现「学段」行 |
| `/category/技术?stage=小学` | 共 2 篇（Markdown 语法速查 / KaTeX 数学公式渲染） |
| `/stage/小学?category=技术` | 共 2 篇（同上，两个方向一致） |
| `/category/技术?stage=高中` | 共 0 篇 + 「No posts found」，`高中` chip 仍为选中态 |
| `/stage/小学?category=技术&tag=markdown` | 三行面板（学段/分类/标签），共 2 篇 |
| 分页 | `?pageSize=1` 时下一页 = `?page=2&stage=小学`（学段页为 `?page=2&category=技术`），第 2 页仍是筛选内内容 |
| 301 | `/stage/小 学?category=技术&page=2` → `/stage/小学?page=2&category=技术` |
| 两套主题 | `default` 与 `ember` 均渲染出面板与正确卡片数（7 / 2 / 2） |

## [0.15.4] - 2026-09-13

### ✨ 学段（Stage）维度的前端入口补齐

后台编辑器早就有「学段」字段，但前端只有徽标能点。这次把「按学段检索/筛选」补成完整闭环：

| 入口 | 位置 | 说明 |
|---|---|---|
| `/stage` | 学段总览 | 列出所有学段与篇数（已在 0.15.2 提供） |
| `/stage/:name` | 学段列表页 | 某学段下的全部内容 |
| 🎓 徽标 | 文章页 / 列表卡片 | 点击直达 `/stage/该学段` |
| **搜索页「学段」筛选行** | `/search` | **本次新增**：与类型/排序/标签/分类并列的可点筛选条，带计数与 `active` 态 |
| **搜索空态的「学段」行** | `/search`（无关键词） | **本次新增**：直接指向 `/stage/:name`，避免落到「空查询 + 筛选」的原地打转页 |
| **搜索页「按学段浏览 →」** | `/search` 底部快捷入口 | **本次新增** |
| **`/stage` 导航链接** | 两套主题的 `partials/wiki-links.html` | **本次新增**：文章页、标签云、视频库页底部 |
| `?stage=` / `/api/stages` | 公开 API | 供外部聚合与脚本使用 |

实现要点：

- `core/routes/search.js`：文档新增 `stage`（写入 `doc.stage`，检索时按 `6 × weight` 计分并计入命中提示「学段」）；新增 `params.stage` 解析、`facets.stages` 统计、结果集过滤、结果条目的学段徽标链接、JSON 输出里的 `stage` 与 `facets.stages`，并把「（已应用筛选）」提示扩展到 `usedStage`。
- 关键词搜索时点学段标签 → `?q=…&stage=…`（可与 `tag`/`category`/`type`/`sort` 叠加）；没有关键词时点学段标签 → 直达 `/stage/:name`。

本地验证（`PORT=8095`，临时给 3 篇演示文章加 `stage` 后回滚）：

- `/search`（空态）出现「学段」行：`小学 2` / `初中 1`，链接为 `/stage/%E5%B0%8F%E5%AD%A6`。
- `/search?q=markdown&stage=小学` → 2 条结果，「（已应用筛选）」出现，结果带 🎓 徽标。
- `/search?q=markdown&stage=初中` → 无结果提示，筛选态仍保留。
- `/search?q=笔记&stage=初中&format=json` → `facets.stages=[{初中,1}]`，`results[].stage="初中"`。
- `/search?q=markdown&tag=markdown&stage=小学` → 2 条（标签 + 学段叠加生效）。
- 文章页 / 标签云 / 视频库底部均出现「按学段浏览 →」。

> 站点主导航（页头 `{{html_menu}}`）由后台菜单设置驱动，未硬编码；如需在页头加入口，在「后台 → 设置 → 菜单」新增指向 `/stage` 的菜单项即可。

## [0.15.3] - 2026-09-13

### 🐛 修复：同步清单漏掉 `core/utils/tag-cloud-utils.js`（工具侧，非应用代码）

真机现象很迷惑：别名文件已放到 `content/data/tag-aliases.json`、`core/lib/content/utils/tag-aliases.js`
与 `core/app.js` 里的导入都在服务器上，但 `/api/tags` 仍列出 `wiki`、`MarkDown` 仍是独立标签——
看起来像「别名机制没生效」。

根因：**同步清单漏了 `core/utils/tag-cloud-utils.js`**。别名归一是在多处分别调用的：

| 位置 | 作用 | 当时是否已同步 |
|---|---|---|
| `core/routes/taxonomy.js` | 标签页按别名解析 / 301 | ✅ 已同步 |
| `core/api/public-api.js` | 公开 API 的标签字段与 `?tag=` | ✅ 已同步 |
| `core/routes/search.js` | 搜索的标签面 | ✅ 已同步 |
| **`core/utils/tag-cloud-utils.js`** | **标签云与 `/api/tags` 的计数** | ❌ **漏了** |

所以只有标签云与 `/api/tags` 还在按原始标签计数 —— 症状与「完全没生效」很像。

- 修复：把它加进同步清单的 `$ModifiedFiles`（清单 70 → 71）
- 新增**清单完整性自检**：同步脚本会用 git 历史（默认最近 7 天，`-ManifestCheckDays` 可调）
  核对「改过的代码文件是否都在清单里」，缺项即在同步前告警并列出文件名；
  `-StrictManifest` 可改成直接中止，`-SkipManifestCheck` 跳过。避免同类「漏同步一个文件、功能只生效一半」再次发生。
- 说明：同步脚本 `tools/sync-today-to-server.ps1` 按设计**不入库**（内含私有服务器地址），
  因此这两处改动只存在于操作者本机；本条目记录的是现象、根因与自检机制。

---

## [0.15.2] - 2026-09-13

### 🆕 学段迁移后的旧链接兜底：`/tag/小学` → 301 `/stage/小学`

把「小学/初中/高中」从标签迁到 `stage` 字段后，`/tag/小学` 这类旧链接就没有对应标签了。现在 `/tag/:slug`
在**标签确实不存在**时，会再查一次学段清单：若存在同学段就 **301** 跳到 `/stage/<学段>`，否则照旧 404。
只在「标签查不到」这条罕见分支上多一次清点，正常标签页零开销。

本地实测（临时给一篇文章加 `stage: "小学"`，四个入口一起验证）：

```
/tag/小学      -> 301  Location=/stage/小学     ← 旧链接不再 404
/tag/教程      -> 200                          ← 正常标签页不受影响
/tag/zzz-...   -> 404                          ← 既非标签也非学段仍然 404
/stage/小学    -> 200
/tags/教程/obsidian -> 200                     ← 多标签组合路由不受影响
```

---

## [0.15.1] - 2026-09-13

### 🐛 修复：内容备份在「多个实例目录同名」时互相覆盖（用户首次实测发现）

首次真机运行时发现：三个实例目录都叫 `aether-cms`，而备份脚本用 `basename <实例目录>` 当实例名 →
三份归档与三份 manifest **完全同名**，后写的覆盖前面的，**远端只剩最后一个实例（xq）**，本机也只拉回 1 个归档，
校验表里那一行虽然写着 `aether-cms`，实际内容是 xq 的。

- 修复：归档名 / manifest 名 / 实例键统一改为「去掉开头斜杠、把 `/` 换成 `-`」的完整路径，
  例如 `/data/te_se_zi_yuan/xl/aether-cms` → `data-te_se_zi_yuan-xl-aether-cms`；
  manifest 里同时保留 `instance`（完整路径）与 `basename`（目录名）
- 修复：`-Prune` 的删除列表改为**汇总去重后**再删（一个时间戳目录含多个实例，同一目录会被多个实例键
  同时判定为「过旧」，原先会重复删除并在第二个键上抛错），并输出「本次拉回 N 个实例的 manifest」便于一眼看出是否被覆盖
- 修复：`-Restore` 的「恢复前备份」文件名也改用同一唯一键（原先同样是 `basename`，两个实例在同秒恢复会撞名）
- 校验表首列由 `实例` 改为 `实例目录`（显示完整路径，避免三个 `aether-cms` 分不清）

本地验证（3 实例 × 2 时间戳的合成备份）：校验表输出 3 条对比（`home-admin-aether-cms` /
`data-te_se_zi_yuan-xl-aether-cms` / `data-te_se_zi_yuan-xq-aether-cms`），
`-Prune -Keep 1` 只删一次旧的 `20260913-100000` 目录且不报错。

---

## [0.15.0] - 2026-09-13

### 🆕 学段维度（F：把「小学/初中/高中」从标签里独立出来）

线上实测：xl 站 `小学(7)/初中(3)/高中(3)` 是**维度**，却和 `情绪管理(1)` 这类话题标签挤在同一命名空间，标签云因此既不像分类也不像关键词；`初中生心理特点` 这种「带学段的话题」也无法用筛选表达。

- **新字段 `stage`**（单值，与 `category`/`tags` 平行）：`content-item-manager` 在创建与更新时写入；归一化复用标签规则（NFKC / 合并空白 / 去 `#` 与首尾符号 / 长度上限），`初 中` 与 `初中` 视为同一学段；更新时传空字符串即清除该字段
- **`/stage` 总览页 + `/stage/<学段>` 列表页**（`core/routes/stage.js`）：复用主题的分类页模板（`taxonomyRoute` → `collection.html`），所以卡片与标签页完全一致；顶部「按学段浏览」筛选条通过全局渲染钩子注入，**零主题改动**；非规范写法（`/stage/小 学`）**301** 到规范地址；未知学段 404
- **学段徽标**：文章卡片（首页 / 分类 / 标签 / 学段页）与文章页 meta 都显示 `🎓 学段`（默认与 ember 两个主题共 8 个模板，样式在 `assets/aether-extras.css`）
- **公开 API**：条目新增 `stage` 字段，支持 `?stage=<学段>` 过滤；新增公开端点 `GET /api/stages`（学段清单 + 篇数，按教育阶段排序）
- **后台编辑器**：新增「学段」输入框（`datalist` 自动补全既有学段，`GET /api/stages` 提供数据），保存时随 `metadata.stage` 提交
- **站内搜索**：学段纳入检索与打分（命中提示显示「学段」）
- **一次性迁移**（`tools/tag-merge.mjs --move-to-stage 小学,初中,高中`）：把已当作标签使用的学段搬进字段——只改 `tags:` 与 `stage:` 两行、其余字节不变，**已有 `stage` 的文章不会被覆盖**，照旧走备份 / 报告 / `--rollback`；幂等
- 未指定学段的旧内容不受影响（不出现在任何学段页里）

### 🐛 修复（本轮实测发现）

- **`contentManager` 门面缺方法**：`getPostsByStage` / `getStageFrequency` 只加在 `ContentQueryManager` 上，门面没有转发，导致 `/api/stages` 与 `/stage/*` 全部 500（`contentManager.getStageFrequency is not a function`）。已在 `content-manager.js` 补上转发。
- **迁移时「stage 行本来就正确」会吞掉 tags 的改动**：`--move-to-stage` 先移除学段标签、再写 `stage` 行，最初用 `stageResult.changed ? stageResult.text : tagResult.text` 组合两步结果——当 `stage` 行无需变化时（例如文章已有 `stage: "初中"`），tags 的改动被丢弃，文件完全没被改写。已改为始终串联两步结果。

### ✅ 验证证据

- 临时脚本（已删）26/26 通过：
  - **迁移**：预览不写盘 → `--apply` 后 `stage: "小学"` 写入且 `tags` 里不再有「小学」→ 已有 `stage: "初中"` 的文章**未被覆盖**且其学段标签被正确移除 → 无关文件逐字节不变 → manifest 记录 `moveToStage` 与学段前后值 → **幂等**（第二次 0 改动）→ `--rollback` 逐字节还原
  - **线上**（本地实例真实内容打上 `stage: "小学"`）：`GET /api/stages` 返回清单与篇数；`/stage` 总览 200；`/stage/小学` 200 且含筛选条、文章卡片与 `post-stage` 徽标；`/stage/小 学` → **301** 到 `/stage/小学`；未知学段 → 404；`/api/public/posts?stage=小学` 过滤生效且条目带 `stage`；文章页显示学段徽标
  - **编辑器**：`/aether/posts/edit` 渲染出 `#stageInput` 与 `#stageSuggestions` 自动补全
  - **搜索**：`q=小学` 命中该学段文章，`hits.stage = 1`

---

## [0.14.0] - 2026-09-13

### 🆕 `--emit-aliases`：一键生成可直接使用的别名文件（G1 的落地方式）

`tools/tag-audit.mjs` 新增 `--emit-aliases <文件>`：把体检结果直接变成可以丢进 `content/data/tag-aliases.json` 的文件，**不用改任何内容文件**就能合并同义标签、隐藏演示噪声标签。

- 默认只写**可无条件判定**的两类合并：归一化后同名（大小写/全半角/空格差异）与「覆盖完全相同的文章集合（≥2 篇）」
- `--aliases-drop-demo`：同时把演示/样板内容带来的噪声标签写进 `drop`
- `--aliases-include-review`：连语义近似候选也写进去（建议先人工过一遍 `notes`）
- 多站点时按站点分别输出 `<文件名>.<host>.json`
- **两道安全检查**（来自一次真实踩坑——最初的 drop 列表同时含 `markdown` 与 `MarkDown`，会让 `MarkDown → markdown` 这条别名失去意义）：
  1. 别名的规范名（含大小写等价形式）**不会被写进 `drop`**，并在 `notes` 里说明原因；
  2. 若某个待丢弃的标签**还被非演示文章使用**，`notes` 会列出这些文章标题并提示「丢弃后它们会失去该标签，如不接受请从 drop 里删掉」。
- `--quiet` 现在真正生效（之前只解析未使用）

### 📦 现成产物：`docs/tag-aliases/`

针对本仓库的两个站点，已经生成并**逐份用别名加载器验证过解析结果**的 4 个文件：

| 文件 | 合并 | 丢弃 |
|---|---|---|
| `xl.dleu.net.json` | `MarkDown → markdown` | — |
| `xl.dleu.net.plus-demo-drop.json` | 同上 | 7 个演示噪声标签 |
| `xq.dleu.net.json` | `MarkDown → markdown`、`cpu → 中央处理器` | — |
| `xq.dleu.net.plus-demo-drop.json` | 同上 | 8 个演示噪声标签 |

复制到实例的 `content/data/tag-aliases.json` 后 **2 秒内生效**（无需重启），删除即回滚；用法与重新生成方式见 `docs/tag-aliases/README.md`。

验证输出（把每份文件喂给 `configureTagAliases` 后看解析结果）：

```
xl.dleu.net.json                  别名 1 / 丢弃 0 | MarkDown→markdown  markdown→markdown  wiki→wiki  教程→教程
xl.dleu.net.plus-demo-drop.json   别名 1 / 丢弃 7 | MarkDown→markdown  wiki→(丢弃)  公式→(丢弃)  教程→教程
xq.dleu.net.json                  别名 2 / 丢弃 0 | cpu→中央处理器  中央处理器→中央处理器  教程→教程
xq.dleu.net.plus-demo-drop.json   别名 2 / 丢弃 8 | cpu→中央处理器  wiki→(丢弃)  王若琳→(丢弃)  教程→教程
```

---

## [0.13.0] - 2026-09-13

### 🆕 标签合并执行工具（B：方案 JSON → 人工确认 → 安全改写内容文件）

`tools/tag-merge.mjs`——把 `tag-audit.mjs --emit-plan` 产出的方案落到内容文件上：

- **只改 `tags:` 一行**：正则在 frontmatter 内定位 `tags:` 行并替换为规范数组，**文件其余字节（含正文、行尾风格 CRLF/LF、其它 frontmatter 字段）逐字节不变**——不是重新序列化整个 frontmatter
- **默认预览**：不加 `--apply` 时只打印「哪个文件、原标签 → 新标签」，一个字节都不写
- **备份与回滚**：每个被改动的文件先复制到 `content/.tag-merge-backups/<时间戳>/`，同时写入 `manifest.json`（回滚契约）与 `report.json`（含每个文件的前后标签）；`--rollback <目录>` 一条命令整批还原
- **原子写**：临时文件 + `rename`，失败不会留下半个文件
- **分级执行**：默认只执行 `autoMerge`（归一化重复，如 `MarkDown`→`markdown`）与 `strongMerge`（覆盖完全相同的文章集合，如 `cpu`→`中央处理器`）；`review`（语义近似候选）必须显式 `--only auto,strong,review`，演示噪声标签要 `--drop-demo`；被过滤掉的数量会在输出里明确提示
- **也支持直接用法**：`--from A,B --to C`、`--drop A,B`（两个合起来可替代方案文件）
- **`--also-alias`**：把本次合并写进 `content/data/tag-aliases.json`，这样老链接继续 301、任何漏网内容也会在读取时归一
- **防护**：映射冲突（同一标签 → 两个规范名）与环形映射都会报错中止；多站点方案必须用 `--source` 明确指定要改哪一个实例；幂等（重复执行无改动）

### ✅ 验证证据

- 临时脚本（已删）34/34 通过：用**真实本地内容的副本**（13 篇）+ 合成方案，覆盖
  预览不写盘（比对文件内容与备份目录均未产生）→ `--apply` 后 `tags:` 已合并且其它字节不变 →
  备份文件内容 = 原始内容 → `report.json` 记录前后标签 → `--also-alias` 写入别名表与 drop 列表 →
  **幂等**（第二次 0 改动、不新建备份）→ `--only review` 才纳入语义候选 →
  **`--rollback` 逐字节还原** → 冲突/环/多站点缺 `--source` 三种错误路径均按预期退出
- 真实内容实测（本地实例，只预览）：`--drop-demo` 精确列出 7 个将改动的文件与前后标签，
  并单独提示 3 组「一篇文章自产的一组标签」属信息、未处理

---

## [0.12.0] - 2026-09-13

### 🆕 标签别名归一（C：不改内容文件就能合并同义标签）

- **`content/data/tag-aliases.json`**（新）：
  ```json
  { "aliases": { "cpu": "中央处理器", "MarkDown": "markdown" }, "drop": ["wiki", "graph"] }
  ```
  - `aliases`：别名 → 规范名；**忽略大小写/全半角/空格**匹配；支持链式（`a`→`b`→`c`，带环检测与 10 跳上限）；自映射被忽略（`自己: 自己` 不占条目）
  - `drop`：整条丢弃的标签（例如上游演示文章带来的噪声），只影响展示与筛选，**内容文件不动**
  - 改动 **2 秒内自动生效**（按 mtime 重载），无需重启进程；删掉文件即完全回滚
  - 需要与保存时归一化区分：大小写/全半角/空格差异已由 `normalizeTagName` 处理，别名表用于**语义**合并或指定规范写法
- **生效范围**（统一走 `resolveTagName` / `canonicalizeTagList`）：
  - 标签云与 `/api/tags`（`core/utils/tag-cloud-utils.js`）——同义标签的计数合并成一条
  - 标签页：`/tag/<别名>` **301 永久跳转**到规范标签；`/tag/<规范名>` 会列出携带**任意别名**的文章（`content-query-manager.getPostsByTagCombination` 按规范 slug 比较）
  - 公开 API：返回的 `tags` 已归一，`?tag=<别名>` 与 `?tag=<规范名>` 结果一致
  - 站内搜索：标签面（facets）与 `?tag=` 过滤
  - sitemap 与 RSS：只出现规范标签 URL 与规范名，不再向搜索引擎暴露别名地址
- **实现要点**：`core/lib/content/utils/tag-aliases.js` 是唯一的解析入口（模块内缓存 + mtime/TTL 重载），`core/app.js` 启动时 `configureTagAliases({ dataDir })`。保存路径**不做**别名改写——那是 `tag-merge.mjs`（B）的职责，需要人工确认合并方案。
- **修复**：`res.redirect()` 在 LiteNode 中的签名是 `redirect(location, statusCode)`（URL 在前），最初写成 `redirect(301, url)` 会导致 `ERR_HTTP_INVALID_STATUS_CODE` 500；同时路由参数（`req.params.slug`）是**未解码**的百分号编码，必须先 `decodeURIComponent` 再解析别名，否则 `slugify('%E6%A6%82%E5%BF%B5')` 会把中文变成十六进制串。

### ✅ 验证证据

- 单元（38/38 通过，临时脚本已删）：精确/大小写/全半角/空格别名、链式 2 跳、自环不死循环、自映射忽略、`drop` 生效、slug 与名字双解析、`saveTagAliases` 原子写 + 备份 + 立即生效；`getTagFrequency` 把 `cpu` 与 `中央处理器` 合并为 `中央处理器(2)` 且 `wiki` 被 drop
- 线上实测（本地实例，真实内容 `概念` ↔ `知识管理`，`drop: ["媒体"]`）：标签云从 15 条变 13 条、`「概念」` 消失、`/tag/概念` → **301 `/tag/知识管理`**、规范标签页 200 且包含原带 `概念` 的文章、`/api/public/posts?tag=概念` 与 `?tag=知识管理` 均为 2 条一致、`/tag/媒体` → 404、sitemap 13 条标签 URL 全部为规范名；**删除别名文件后 2 秒内完全恢复**（15 条标签、`/tag/概念` 回到 200）

---

## [0.11.0] - 2026-09-13

### 🆕 标签治理与内容备份（第一批：A + E + D）

线上实测的问题（`tools/tag-audit.mjs` 跑出来的真实数据）：

| 站点 | 文章 | 标签 | 只用过 1 次 | 典型症状 |
|---|---|---|---|---|
| xl.dleu.net | 20 篇 | **91 个** | 82 个（90%） | 16 组「一篇文章自产一组标签」，涉及 78 个标签 |
| xq.dleu.net | 15 篇 | 28 个 | 18 个（64%） | `cpu` 与 `中央处理器` 覆盖完全相同的 5 篇文章 |

- **`tools/tag-audit.mjs`（A：标签体检，只读）**：两种数据源——线上站点（公开 API + `/tag-cloud`）与本地 `content/data`（离线，可在服务器上跑）。输出长尾分布、归一化重复（`markdown` == `MarkDown`）、同篇文章标签组、真子集关系、名称近义候选（含中英同概念，覆盖 ≥2 篇文章才算可靠信号）、同族发散聚类（`心理*` / `情绪*` / `学习*` / `注意*`）、过泛标签、演示内容噪声、标签堆砌。`--emit-plan` 导出 `tag-merge-plan.json`（`autoMerge` / `strongMerge` / `review` / `families` / `dropDemoTags` / `singleArticleTags`）供人工确认后再执行合并。
- **`tools/backup-content.ps1`（E：内容备份与恢复）**：`content/data` 与 `content/uploads` 既不在 git（`.gitignore` 排除）也不在同步脚本的备份范围内，属单点风险。现在：服务器清点 → `tar` 打包（默认排除体积持续增长的 `analytics/views-*.jsonl`）→ 写 manifest（文件数/字节数/归档 sha256/条目数）→ 一次性 `scp` 拉回本机 → **本机复算 sha256 与 tar 条目数做端到端校验** → 与上一份备份对比增减；`-Verify` 只清点、`-LocalOnly` 完全不连服务器、`-Prune -Keep N` 轮转、`-Restore` 解包前自动再备份一次（可回滚）；文件头附服务器端 crontab 片段（每晚快照 + 14 天轮转）。
- **编辑器防复发（D）**：
  - **保存时规范化**（`normalizeTagName` / `normalizeTagList`，落在 `content-item-manager` 的创建与更新路径，覆盖后台、API、脚本导入所有入口）：NFKC 全角→半角、合并空白、去掉开头 `#` 与首尾分隔符、**中文之间的空格合并**（`心理 危机` → `心理危机`）、长度上限 40、按 ASCII 大小写去重（`Markdown` 与 `Ｍａｒｋｄｏｗｎ` 只留一个）。
  - **优先复用已有标签**：编辑器从 `/api/tags` 拉取站点全部标签，提供原生 `datalist` 自动补全 + 「已有标签（点击复用）」芯片（按使用篇数排序，前 24 个）。
  - **近似标签确认**：输入与已有标签高度相似时（归一化同名 / 互相包含 / 共享 2+ 字前缀）弹一次确认——「站点已有「情绪」（6 篇），与「情绪管理」很接近。确定=复用，取消=仍然新建」。
  - **标签数提醒**：单篇超过 5 个标签时在输入框下方提示建议精简（线上多篇文章带 8 个标签）。
  - 客户端 `normalizeTagName` 与服务端保持逐字一致（有对照测试），保证「编辑器看到的 = 存进去的」。

---

## [0.10.1] - 2026-09-13

### 🔐 安全运维工具（配合敏感路径护栏）

- **`tools/rotate-security.ps1`**：一键完成服务器侧安全收尾——每个实例备份 `.env` → 生成**各自独立**的新 `COOKIE_SECRET`（保留原权限位）→ 重置管理员口令（三实例同一口令，经环境变量传递，不出现在 `ps` 进程列表中）→ 清空 `sessions.json` → 执行重启 → 复核 `/.env` 必须 404、首页必须 200。支持 `-CheckOnly`（只读体检：打印各实例密钥**长度与 sha256 指纹**而非密钥本身、其它疑似密钥键名、PORT、node/openssl/curl 可用性、数据文件与 salt 是否存在、tmux/pm2 守护情况）、`-DryRun`、`-ShowRemoteScript`、`-RotateAnalyticsSalt`、`-KeepSessions`、`-SkipSecret`、`-SkipPassword`。
- **`tools/reset-admin-password.mjs`**：不依赖登录态直接重置口令（复用应用自身的 scrypt 参数与自描述哈希格式，写入前自检、原子替换、旧文件备份为 `users.json.bak-*`），支持 `--list` / `--generate` / `--password` / `AE_NEW_PASSWORD`（口令不进 `ps`）/ `--clear-sessions` / `--data-dir` / `--dry-run`。
- 说明：统计用的加盐哈希盐值（`content/data/analytics/salt.txt` 或 `.env` 的 `ANALYTICS_SALT`）同样曾随 `content/data` 暴露，泄露后可结合明细日志暴力枚举访客 IP，因此提供 `-RotateAnalyticsSalt` 一并轮换（重启后自动生成新盐；历史聚合数字不受影响，仅后续 UV 去重改用新盐）。
- README 新增「安全收尾（密钥与口令轮换）」章节：体检 → 轮换 → 复核的完整步骤与 nginx `deny` 兜底建议。

---

## [0.10.0] - 2026-09-13

### 🆕 站内搜索（#8）

- **服务端搜索页 `/search`**：不需要前端索引文件、不需要额外依赖，直接对内容管理器里已发布的文章与页面打分排序（本地 10 篇内容实测 5 ms，数百篇规模同样是一次内存扫描）。
- **相关度打分**：整句命中标题（+45）> 标题（+12，开头命中再 +8）> 标签（+7）> 副标题（+6）> 分类（+5）> slug（+4）> 正文（每次命中 +2，最多计 10 处）；`"引号"` 精确短语按 1.6 倍加权；全部关键词都命中的结果再 +12。
- **多关键词默认 AND**：找不到「全部命中」的内容时**自动放宽为任意命中**，并在页面上明确提示，避免访客看到空白页。
- **可解释的结果**：每条结果标注命中位置（「标题、正文 3 处」）、日期（`YYYY-MM-DD`）、分类、阅读数与**正文首个命中处的高亮摘要**；标题与摘要中的关键词都用 `<mark>` 高亮（正则特殊字符已转义）。
- **筛选与排序**：类型（文章/页面，带计数）、标签（Top 14，带计数）、分类（Top 10，带计数）；排序支持 相关度 / 最新 / 阅读最多（阅读数取自自建统计，按 `/notes/<slug>` 统计键）。
- **分页**：`SEARCH_PER_PAGE`（默认 12），链接保留查询与筛选条件；页码越界自动夹到最后一页。
- **无关键词 / 无结果状态**：前者展示全站统计（内容数、标签数）、热门标签、分类与最新内容；后者给出「缩短关键词 / 用引号精确匹配 / 直接看标签」的建议与热门标签兜底。
- **实时联想**：`assets/search-suggest.js` 复用公开 API `/api/public/posts?q=`，输入即下拉建议（↑↓ 选择、回车跳转、Esc 与点击外部关闭），无 JS 或接口不可用时表单照常可用；接口失败静默降级。
- **SEO 与入口**：搜索页注入 `<meta name="robots" content="noindex, follow">`；两个主题的导航区块新增「搜索 →」入口（与「视频库 →」「标签云 →」并列），主题无关样式集中在 `assets/aether-extras.css`。
- **JSON 输出**：`/search?q=…&format=json` 返回 `terms / relaxed / total / totalPages / facets / results[]`（含 `score`、`hits`、`snippet`、`views`），便于调试、自动化与二次聚合。
- 查询解析：中文单字可搜、单个拉丁字母忽略、最多 6 个关键词；`,`「，」「。」等标点作分隔符，但保留 `+ # . _ -`（能搜 `c++`、`c#`、`node.js`、`gpt-4` 这类术语）。
- 说明：`/search` 是内置路由，字面路径优先于自定义页面的 `/:slug`，因此请避免创建同名 slug 的自定义页面。

### 🐛 修复

- **日期排序按星期名比较**：内容管理器把 frontmatter 的日期解析为 `Date` 对象，而 `/videos` 与新的搜索排序原先用 `String(date).localeCompare(...)`，实际比较的是 `"Wed Sep 02 2026 …"` 这样的字符串——结果是「按星期几排序」，月份/日期完全错乱（实测 `/search?sort=newest` 顺序为 09-02、09-01、09-03…）。改为统一用时间戳比较（新增 `dateValue()` 辅助函数），`/videos` 同步修正；日期展示也统一格式化为 `YYYY-MM-DD`。

---

## [0.9.0] - 2026-09-13

### 🆕 视频自动播放与顺序连播

- **打开文章即自动播放**：页面里第一个视频进入视口时自动开始（首屏就有视频则立即开始；视频在折叠线以下时，等访客滚动到它再开始，避免页面偷偷下载没人看的视频）。
- **多视频顺序连播**：当前视频结束后自动滚动到下一个并接着播放，直到队列播完（控制条提示「已播完 N 个」）；单视频页面同样有控制条，只是不显示「下一个」。
- **控制条**（页面左下角，只出现在含视频的页面）：`⏸ 停止连播 / ▶ 自动连播`、`第 n/N 个`、`🔊 开声 / 🔇 静音`、`⏭ 下一个`、`↺ 重新播放`。访客的开关与静音选择记在 localStorage，**优先于站点默认值**，之后每次访问都沿用。
- **为什么默认静音**：现代浏览器一律禁止「带声音的自动播放」，因此自动开始固定使用 `muted=1`；点控制条「🔊 开声」会在**当前进度续播**并带声音（走 PeerTube 的 `start=<秒>s` 参数），不会从头开始。
- **结束检测怎么做（实测结论）**：播放器在跨域 iframe 内，父页面读不到它的 DOM。**实测 PeerTube 7.3（stream.dleu.net）的 embed 页面不会向父页面发送普通事件**——官方 Embed API 需要嵌入地址带 `?api=1` 并由父页面引入 `@peertube/embed-api`（jschannel 协议）客户端；本项目不引入该依赖（避免额外第三方脚本，也避免把 AGPL 客户端源码内嵌进本仓库）。因此实际做法是：
  1. **时长计时（主）**：用元数据缓存里的时长（`data-duration`，PeerTube 封面缓存自带）推算结束时刻，届时**先弹出 5 秒倒计时**「当前视频已到预计时长，N 秒后播放下一个」，可点「✋ 取消」留在当前视频继续看——计时无法感知暂停/拖动，所以给访客一个可撤销的机会；
  2. **本地文件视频（精确）**：`[video:file.mp4]` 直接监听原生 `ended` 事件，播完即刻推进；
  3. **防御性 postMessage 解析（兜底）**：若某个播放器/版本确实上报事件（`ended`、`playbackState:"ended"`、`position`、`duration` 等形态都做了映射），会自动切换成精确推进，无需改代码；没有上报时这段逻辑完全静默。
- 细节：自动开始**不抢焦点、不打断阅读位置**（滚动到下一个时用平滑滚动）；自动开始期间覆盖一层「点击播放」，万一浏览器仍拦截自动播放，访客一点即可开始；省流量模式（`saveData` / 2G）下不自动播放；标签页切到后台时暂停推进计时，回到前台按实际进度决定是否续播。
- 哔哩哔哩：可以自动开始，但**没有时长与结束事件**，队列走到 B 站视频时不会自动跳到下一个，需要点「⏭ 下一个」（PeerTube 与本地文件不受影响）。
- 新增配置：`VIDEO_AUTOPLAY`（默认 `true`；设为 `false` 时默认不自动播放，但控制条保留，访客可自行开启）、`VIDEO_AUTOPLAY_MUTED`（默认 `true`）。
- 排查工具：URL 追加 `?aether-video-debug=1` 时，控制条会显示最近收到的播放器事件，控制台打印完整 payload（用于确认/扩展上面的事件解析）。
- 说明：该运行时由服务端钩子注入，**静态导出（`npm run build`）不包含**（与分享条/OG 的限制一致）；主题若要在导出页也支持，可在布局里自行引入 `/assets/video-playlist.js`（没有配置对象时按「自动播放 + 静音」默认运行）。
- 实现要点：`assets/video-facade.js` 仍是唯一的 iframe 加载器，新增 `autoplay / muted / start / veil` 选项与 `window.AetherVideoFacade` 接口，`assets/video-playlist.js` 只做队列调度，避免两处重复加载逻辑。

---

## [0.8.0] - 2026-09-13

### 🆕 复合资源增强（第二批：分享与开放接口）

- **附件区块（#7）**：正文里的 `[file:路径|名称]` 自动汇总为文末附件清单——按文件族配图标（PDF/文档/表格/演示/压缩包/文本/视频/音频/图片）、自动换算大小（KB/MB）、支持外链附件、**文件缺失时显式标红**（作者能立刻发现路径写错）；代码块里的示例不会误收集。实现放在 `renderMarkdown()` 内部，因此**前台、后台编辑器预览、静态导出三处自动一致**，且不改任何主题模板。
- **分享条（#10）**：内容页（文章/页面）自动注入分享条，全部服务端渲染、主题无关：
  - 🔗 复制链接（含 `execCommand` 兜底，非 HTTPS 环境可用）
  - 💬 微信 / 🏢 企业微信：点击展开**内联 SVG 二维码**（服务端用 `qrcode` 同步生成，无第三方请求、可离线）
  - ⭐ QQ空间 / 🐧 QQ：标准网页分享链接
  - 🖨️ 打印/另存为 PDF：附带打印样式（隐藏导航/分享条/视频遮罩，并把外链地址打印出来）
  - 🎞️ 原视频：文章含 PeerTube 视频时直达原片
  - 按需求**不含** Twitter/X、Facebook、微博
- **公开只读 API + oEmbed（#9）**：
  - `GET /api/public/site`、`/api/public/posts`（`limit/offset/tag/category/q/hasVideo/hasAttachment`）、`/api/public/posts/:slug?html=1`
  - `GET /oembed?url=…`：文章 → `type: rich`（iframe + 封面 + 作者）；PeerTube 视频 → `type: video`（标题/缩略图/嵌入 iframe）
  - CORS 全开放、**仅暴露已发布内容**、不下发内部字段（无 filePath、无原始 frontmatter）、按 IP 限流（默认 120 次/分钟）、列表 15 秒缓存
  - 开关与限流：`PUBLIC_API_ENABLED`、`PUBLIC_API_RATE_LIMIT`
- 新增依赖：`qrcode`（二维码，服务端同步生成）

### 🐛 修复

- **框架回调二次写头崩溃**：LiteNode 在中间件提前结束响应后仍会继续分发路由，而它的 `json/html/status` helper 不检查 `headersSent`，会抛 `ERR_HTTP_HEADERS_SENT` 让进程退出。现在全局 `notFound` 与 `onError` 处理器都会先判断 `res.headersSent || res.finished`（这也是安全实现 OPTIONS 预检的前提）。
- `qrcode` 的 `toString()` 是**异步** API（同步调用会渲染出 `[object Promise]`）：改用同步的 `QRCode.create()` 自行绘制 SVG 矩阵。

---

## [0.7.0] - 2026-09-12

### 🆕 复合资源增强（第一批）

- **PeerTube 元数据集成**：`core/lib/media/peertube.js` 按 shortUUID/UUID 抓取视频元数据（标题/时长/缩略图/频道/发布时间/观看数），缓存于 `content/cache/peertube/<id>.json`（默认 24h TTL、内存+磁盘两级、渲染时零网络）；启动后台预热、文章保存后自动抓取；API 返回的 `http://` 链接统一用 `PEERTUBE_URL` 重建，避免 HTTPS 页面出现混合内容。
- **视频封面卡 + 点击加载门面**：`[video:…]` 不再直接插入第三方 iframe——文章页渲染为「封面图 + ▶ + 时长」门面，点击后才载入播放器（`<noscript>` 保留兜底 iframe）；首页/分类/标签/自定义列表卡片新增 16:9 封面、播放角标与时长徽标。运行时 `assets/video-facade.js` 仅在含门面的页面注入。
- **视频库 `/videos`**：聚合全站含视频的内容，封面网格 + 时长/频道/来源徽标 + 标签筛选 + 分页；主题页脚导航新增「视频库」入口。
- **分享与结构化数据**：主题无关注入 `canonical`、OpenGraph（`video.other`、`og:video`、`og:video:duration`、`og:image` 取视频封面）、Twitter Card 与 JSON-LD（`Article` + `VideoObject`，含 name/duration/thumbnailUrl/uploadDate/embedUrl）。
- **哔哩哔哩支持**：识别 `bilibili.com/video/BV…`、`av…` 与 `b23.tv` 并转为播放器嵌入（无元数据接口，封面使用占位样式）。
- 新增配置：`PEERTUBE_URL`、`PEERTUBE_ENABLED`、`PEERTUBE_CACHE_DIR`、`PEERTUBE_CACHE_TTL`、`PEERTUBE_TIMEOUT`（见 `.env.example`）。
- 说明：代码块/行内代码里的 `[video:…]` 示例不再被当作真实视频（否则会污染视频库与卡片封面）。
- 说明：**Unlisted 视频可正常抓取封面与元数据**（实测 stream.dleu.net 上 Unlisted 视频匿名返回 200），仅从列表/搜索中隐藏；Private/Internal 才会被拒（降级为占位封面）。
- **封面自愈**：文章/列表渲染时若某视频元数据尚未缓存，会在后台按需抓取（`ensurePeerTubeMeta`，去重），下次访问即显示封面——存量文章**无需重新发布、无需重启**即可补上封面；静态导出期间不触发网络请求。

### 🔒 安全修复（重要）

- **静态文件越权访问**：LiteNode 会把项目根目录整目录当静态资源公开，线上可直接下载 `/.env`（含 `COOKIE_SECRET`）、`/content/data/users.json`（口令哈希）、`/content/data/sessions.json`（会话令牌）、草稿 Markdown、`content/data/analytics/salt.txt` 以及 `/core/**` 全部源码。
  - 已在 `core/app.js` 加入**首个中间件护栏**：只放行前端与后台真正需要的静态路径（`/assets/**`、`/content/themes/**`、`/content/uploads/**`、`/core/admin/static/**`），其余命中敏感模式（`.env`、`.git`、`content/data`、`content/cache`、`uploads/*.json`、`release`、`package*.json`、`index.js`、`README/CHANGELOG/LICENSE/DEPLOYMENT-*`、`/core/**`）的请求改写为不存在的路径，交由框架按 404 处理。
  - ⚠️ **注意**：护栏不能直接 `res.end()`——LiteNode 在中间件之后仍会继续分发路由，二次写头会抛 `ERR_HTTP_HEADERS_SENT` 并让进程崩溃（本地已复现并修正）。
  - ⚠️ 升级后请**轮换 `COOKIE_SECRET`**（旧值可能已泄露，可据此伪造登录 Cookie）、更换管理员口令；建议同时在 nginx 层加 `deny` 兜底（见 README 部署章节）。

### 🐛 修复

- **列表视频封面"看不见"**：封面容器在没有缩略图（元数据未就绪）时高度塌陷为 0，观感上像"完全没有封面"。现在容器恒为 16:9 并带渐变底色，占位时也显示明显的可点击播放块。
- **支持独立的 PeerTube API 地址**：新增 `PEERTUBE_API_URL`（可选）。当 CMS 服务器只能经内网访问 PeerTube（如 `http://<内网IP>:9000`）而访客走公网域名时，用它分离"服务端抓取地址"与"对外缩略图/嵌入地址"。

---

## [0.6.0] - 2026-09-12

### 🆕 新增功能

- **自建访问统计（first-party analytics）**：无需第三方脚本与数据库，数据完全留在本站。
  - 采集：全局中间件在每次前台 HTML 页面渲染完成后记录一条事件；自动过滤爬虫/机器人，默认排除已登录用户，同一访客同一页面 30 分钟内去重。
  - 存储：`content/data/analytics/views-YYYY-MM-DD.jsonl`（明细，按天分文件）+ `summary.json`（内存聚合、懒刷盘、原子写入）；原始明细按保留期自动清理。
  - 隐私：只保存**掩码 IP**（IPv4 保留前三段 / IPv6 保留前 3 组）与**加盐哈希**（盐自动生成于 `salt.txt`），不落完整 IP；仅当显式开启 `ANALYTICS_TRUST_PROXY` 且位于反向代理之后才采信 `X-Forwarded-For`。
  - 终端识别：内置轻量 UA 解析（设备 / 操作系统 / 浏览器），零依赖（未采用 AGPL 的 ua-parser-js v2）。
- **前台阅读次数**：文章页与页面显示阅读数；首页、分类页、标签工作台、自定义列表页的文章卡片同样显示。默认主题与 Ember 主题均已适配。
- **知识图谱显示阅读量**：`/notes/graph` 与后台 `/aether/graph` 的每个节点在类型徽标右侧显示 `👁 N`（阅读量 ≥100 转为橙色高亮），页首统计补充「共 X 个节点、Y 条链接、Z 次阅读」。
- **图谱热度可视化与阅读量筛选**：
  - 节点卡片尺寸、描边粗细与底色随阅读量对数递增（最热节点最大 +34% 宽 / +19% 高，越热越暖），热门节点带橙色光晕；物理层为热门节点加大排斥力避免卡片重叠；画布右下角显示热力图例与最高阅读量。
  - 工具栏新增「阅读量」筛选：全部 / 阅读 Top 5 / Top 10 / Top 20 / 有阅读 / 未被阅读；与搜索、类型筛选叠加生效，「重置视图」一并清除；筛选时左下角显示可见节点数。
  - 命中检测与平移边界已适配变尺寸卡片。
- **后台 `/aether/analytics` 面板**：总览卡片（PV / UV / 被访问内容数 / 日均 / 累计）、PV+UV 零依赖 canvas 趋势图（含悬停读数）、文章访问排行（Top 20）、访问终端分布（设备 / 系统 / 浏览器，带占比条）、外部来源站点、最近访问明细（时间 / 页面 / 掩码 IP / 终端）；支持时间范围切换（今日 / 7 / 30 / 90 天）与 **CSV 导出**（`/aether/analytics/export.csv`，带 BOM，Excel 打开中文不乱码）。
- 侧边栏新增「访问统计」入口；后台中英文（i18n）同步补充 analytics 词条。

### 🔧 说明

- 新增环境变量：`ANALYTICS_ENABLED`、`ANALYTICS_DIR`、`ANALYTICS_SALT`、`ANALYTICS_RETENTION_DAYS`、`ANALYTICS_TRUST_PROXY`、`ANALYTICS_EXCLUDE_ADMINS`、`ANALYTICS_DEDUP_MINUTES`（见 `.env.example`）。
- 静态导出（`npm run build`）页面无法回写统计，阅读计数仅在动态模式可用。
- UV（独立访客）由明细日志按天去重计算并带 60s 缓存；PV 与各维度分布直接读聚合汇总，常规后台访问不会扫描大文件。

### 🐛 修复

- **后台统计里标签/分类路由显示为百分号编码**（如 `/tag/%E5%B0%8F%E5%AD%A6`，不易识读与区分）：
  - 采集端改为保存**解码后的路径**，路线不再写入怪码；
  - 报表端把非文章页面渲染为可读名称：`首页`、`标签：小学`、`标签筛选：小学 × 数学`、`分类：技术`、`知识图谱`、`标签云`、`页面：<slug>`，并渲染为可点击链接（文章仍显示标题并链接到 `/notes/<slug>`）；
  - 历史已编码数据在启动时**自动归一化并合并**（`path:/tag/%E5%B0%8F%E5%AD%A6` 与 `path:/tag/小学` 合并为一条），同时清除早期把路径当标题存下的字段；
  - 该修复同时作用于「文章访问排行」「最近访问」与 CSV 导出。
- **标签云 / 知识图谱等页面的前端计数恒为 0**：`/tag-cloud`、`/notes/graph`（以及标签、分类列表页）走的是通用页面渲染流程，这些路由不传 `viewCount`，而页面模板会渲染 `{{ viewCount || 0 }}`，于是永远显示 0（后台统计本身正常）。
  - 现在全局渲染钩子会为**任何未自带计数的前台页面**按当前路径从统计里取数（`path:` 维度），因此标签云、知识图谱、标签/分类列表页都显示真实的本页访问数；
  - 默认主题的图谱页与两套主题的标签/分类列表页补充了计数显示，措辞统一为 `👁 N`（悬停提示"本页访问次数"）；
  - 说明：显示的是**本次访问之前**的累计值（与文章页一致，本次访问在响应结束时才入库）。
- **列表缩略内容泄露 Markdown 扩展语法**：当文章为了突出视频而把 `[video:URL|标题]` 放在正文开头时，列表卡片的摘要会原样显示该指令与视频 URL，正文文字反而看不到。
  - 新增统一的 **Markdown → 纯文本** 清洗函数 `markdownToPlainText()`（`core/lib/content/utils/content-utils.js`），覆盖本项目全部扩展语法：
    - `[video:URL|标题]` / `[asciinema:id|标题]` → **保留标题文字、丢弃 URL**
    - `[file:路径|名称]` → 保留名称；`[ref:key]` → 丢弃
    - `[[目标|显示文字]]` → 显示文字；`![[图片]]` → 丢弃，`![[笔记]]` → 显示文字
    - `$行内公式$` → 去掉定界符；`$$块级公式$$` → 丢弃
    - `> [!TYPE] 标题` Callout → 保留"标题"与正文
    - `#标签` → 去掉 `#` 记号；代码块/表格/列表/HTML/图片 → 丢弃或解包
  - 应用范围：列表卡片预览、**手写摘要字段**（历史脏摘要同样被清洗）、相关文章摘要、主题搜索索引、RSS/SEO 描述。
- **卡片媒体角标**：文章列表卡片在标题后显示媒体图标，一眼看出文章内含什么内容——🎬 含视频（`[video:]`、`<video>`、`<iframe>`）、⌨️ 含终端录制（`[asciinema:]`）、📎 含附件（`[file:]`），悬停显示文字说明；由 `detectMediaBadges()` 在 `summaryView` 阶段检测，默认主题与 Ember 主题的首页/标签分类列表/自定义列表页均已适配，样式走主题无关的 `assets/aether-extras.css`。

---

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
