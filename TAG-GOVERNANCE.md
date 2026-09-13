# 标签治理与内容备份（实施记录 + F/G 待决方案）

> 本文记录本轮「标签治理 + 运维备份」的实测问题、已完成的部分（A–E），
> 以及两个**需要站点负责人拍板**的方案（F 学段维度 / G 演示内容处理）。

---

## 1. 实测问题（不是推测，来自线上两个站点的真实数据）

用 `node tools/tag-audit.mjs https://xl.dleu.net https://xq.dleu.net` 跑出来的结果：

| 站点 | 已发布文章 | 标签总数 | 只用过 1 次 | 平均每篇标签 |
|---|---|---|---|---|
| xl.dleu.net（心理健康资源库） | 20 篇 | **91 个** | 82 个（**90%**） | 5.3 个 |
| xq.dleu.net | 15 篇 | 28 个 | 18 个（64%） | 3.7 个 |

五类具体病症：

1. **一篇文章自产一组标签**：xl 有 16 组「覆盖完全相同文章集合」的标签，涉及 78 个标签。例如
   《青少年心理问题初探》一篇就带 8 个标签（青少年心理问题 / 内生失衡 / 家庭与社会 / 网络信息洪流 / 同伴关系 / 班主任角色 / 情绪信号 / 安全连接）——每个标签页只服务一篇文章。
2. **同义/近义并存**：xq 上 `cpu` 与 `中央处理器` **覆盖完全相同的 5 篇文章**；xl 上有 `情绪管理`/`情绪信号`/`情绪障碍`、`心理干预`/`心理健康`/`心理课堂`/`心理情绪`/`心理危机`/`心理小活动`、`注意力`/`注意力缺陷`/`注意力转移`/`专注力`、`意志力`/`毅力`/`自制力` 等族。
3. **大小写/全半角重复**：两个站点都有 `markdown` == `MarkDown`。
4. **维度混用**：xl 的 `小学(7)/初中(3)/高中(3)` 是「学段」维度，却与话题标签混在同一命名空间；xq 的 `安全可靠测评(8/15 篇)` 过泛，更像分类。
5. **演示内容污染生产库**：两个站点都上线了上游示例文章（`Markdown 语法指南`、`Aether CMS × hblog-ng 整合说明`、`wiki 关系引擎`、`KaTeX 公式编辑教学`，xq 还有 `富文本测试`），带来约 10 个纯噪声标签（`wiki`/`graph`/`hblog-ng`/`KaTeX`/`markdown`/`Aether CMS`/`公式`/`吉他`/`王若琳`…），并同时污染搜索结果、sitemap、RSS、视频库与知识图谱。

根因三条：**没有共享词表**（作者按「这篇讲了什么」打标签）、**保存时零规范化**、**没有合并/重命名机制**。

---

## 2. 已完成（A–E，均已本地验证并提交）

| | 交付物 | 作用 | 提交 |
|---|---|---|---|
| **A** | `tools/tag-audit.mjs` | 标签体检：线上（公开 API + `/tag-cloud`）或本地（`--dir content/data`）；输出长尾、归一化重复、同篇文章标签组、真子集、名称近义候选（含中英同概念）、同族发散聚类、过泛标签、演示标签、标签堆砌；`--emit-plan` 导出合并方案 | `3196dcb` |
| **B** | `tools/tag-merge.mjs` | 执行合并方案：**只改 `tags:` 一行**、其余字节不变；默认只预览；备份到 `content/.tag-merge-backups/<时间戳>/`；`--rollback` 逐字节还原；`--also-alias` 同步写别名表；幂等；冲突/环报错中止 | `e65737b` |
| **C** | `core/lib/content/utils/tag-aliases.js` + `content/data/tag-aliases.json` | **读取时**归一（不改内容文件）：标签云/`/api/tags` 计数合并、`/tag/<别名>` **301**、规范标签页收录带别名的文章、公开 API 与站内搜索同步、sitemap/RSS 只出规范名；改文件 2 秒内生效，删文件即回滚 | `4ca4565` |
| **D** | `content-item-manager` + 后台编辑器 | 保存时规范化（NFKC/空格/`#`/大小写去重）、编辑器自动补全与「点击复用已有标签」、近似标签确认一次、单篇 >5 个标签提醒 | `b10b2f4` |
| **E** | `tools/backup-content.ps1` | `content/data` + `content/uploads` 打包拉回本机、manifest（文件数/字节/sha256/条目数）、本机复算校验、与上一份对比、`-Prune -Keep N` 轮转、`-Verify`、`-LocalOnly`、`-Restore`（解包前再备份一次）、附服务器端 crontab 片段 | `3196dcb` |

配套安全工具（更早提交）：`tools/rotate-security.ps1`（轮换 COOKIE_SECRET / 重置口令 / 只读体检 / auto 原地重启）、`tools/reset-admin-password.mjs`。

### 建议的执行顺序（在两个站点上）

```powershell
# 1) 体检 + 导出方案（只读）
node tools/tag-audit.mjs https://xq.dleu.net --emit-plan tag-merge-plan.json

# 2) 人工编辑方案：删掉不认可的条目；review 桶要显式 --only 才执行
# 3) 预览（不写文件）
node tools/tag-merge.mjs --dir <实例>/content/data --plan tag-merge-plan.json --only auto,strong

# 4) 执行：备份 + 原子写 + 报告 + 同步别名表（老链接继续 301）
node tools/tag-merge.mjs --dir <实例>/content/data --plan tag-merge-plan.json --apply --also-alias

# 5) 复查标签云 / 标签页 / 搜索；不满意就整批回滚
node tools/tag-merge.mjs --rollback <实例>/content/.tag-merge-backups/<时间戳>
```

**xq 站现在就能确定执行的一条**：`cpu` → `中央处理器`（5 篇文章，文章集合完全相同）。
xl 站的 `markdown` → `MarkDown` 同理；`心理*`/`情绪*`/`学习*`/`注意力*` 几族属语义判断，建议按方案逐条确认。

---

## 3. F 方案：把「学段」从标签里独立出来（待拍板）

**问题**：xl 的内容天然按小学 / 初中 / 高中分（标签计数 7 / 3 / 3），但它是**维度**，和「情绪管理」这类话题标签混在同一个命名空间，导致标签云既不像分类也不像关键词；同时 `初中生心理特点` 这种「带学段的话题」也无法用筛选表达。

**方案（推荐）**：新增独立字段 `stage`，与 `category`/`tags` 平行：

- frontmatter 增加 `stage: 小学`（可选，单选）
- 迁移：把现有 `小学/初中/高中` 三个标签**从 tags 移除**，写入 `stage`；`初中生心理特点` 这类保持为话题标签不动（它本身是话题，不是学段）
- 展示：文章卡片与文章页显示「学段」徽标；列表页/标签页顶部出现「学段」筛选行（与现有 `filter-chip` 样式一致，链接形如 `/stage/小学`）
- 新增路由 `/stage/:name`（复用标签页模板与分页），并在 `/api/public/posts` 增加 `?stage=`
- SEO：`stage` 不进 sitemap 的标签列表，避免与话题标签页面重复

**工作量/风险**：中等。改动集中在 `content-item-manager`（字段读写）、taxonomy 路由（新增一个维度）、主题模板（徽标与筛选行）、公开 API。
**风险点**：内容模型变更需要一次数据迁移（可由 `tag-merge` 的同款机制实现：把 `小学` 从 tags 移到 stage，带备份与回滚）。
**不做的替代方案**：保持在 tags 里，只把 `小学/初中/高中` 通过 `tag-aliases.json` 归一到统一写法（零改动，但维度仍然混着）。

**需要你回答**：`F` 做不做？做的话迁移是否接受「一次性改写 frontmatter（自动备份 + 可回滚）」？

---

## 4. G 方案：演示/样板内容怎么处理（待拍板）

**现状**：两个生产站点上都有上游示例文章在跑：

| 文章 | 出现站点 | 带来的噪声标签 |
|---|---|---|
| `Markdown 语法指南` | xl、xq | markdown |
| `Aether CMS × hblog-ng 整合说明` | xl、xq | Aether CMS、hblog-ng、MarkDown、wiki、吉他 |
| `wiki 关系引擎` | xl（xq 亦然） | graph、wiki |
| `KaTeX 公式编辑教学` | xl、xq | KaTeX、公式 |
| `富文本测试` | xq | 公式、王若琳、吉他 |

**三种处理方式**：

| 选项 | 做法 | 影响 | 可逆性 |
|---|---|---|---|
| **G1 只隐藏标签（最小动作，推荐先做）** | 直接把现成文件复制进实例：`docs/tag-aliases/<站点>.plus-demo-drop.json` → `content/data/tag-aliases.json` | 标签云/标签页/搜索/API/sitemap 立刻干净；**文章仍在**（可作语法参考） | 删掉文件即恢复（2 秒内） |
| **G2 文章转草稿** | 通过后台把这些文章的 `status` 改成 `draft`（或批量脚本） | 前台/搜索/sitemap/API 全部不再出现，内容仍保留在实例里可随时恢复 | 改回 published 即恢复 |
| **G3 删除文章** | 直接删除 `.md` | 最彻底，同时清掉标签、封面缓存、视频库条目 | 需靠备份（E）恢复 |

**G1 已经准备好了现成文件**（见 `docs/tag-aliases/README.md`）：

| 文件 | 内容 |
|---|---|
| `docs/tag-aliases/xl.dleu.net.json` | `MarkDown → markdown` |
| `docs/tag-aliases/xl.dleu.net.plus-demo-drop.json` | 同上 + 丢弃 7 个演示噪声标签 |
| `docs/tag-aliases/xq.dleu.net.json` | `MarkDown → markdown`、`cpu → 中央处理器` |
| `docs/tag-aliases/xq.dleu.net.plus-demo-drop.json` | 同上 + 丢弃 8 个演示噪声标签 |

生成器内置两道安全检查（别名的规范名不会被丢弃；被非演示文章使用的标签会在 `notes` 里单独提示），并已用别名加载器逐份验证解析结果。

**推荐顺序**：**G1 立刻做**（复制一个文件，零风险、当天见效）→ 跑一次 E 的备份 → 视内容规划再决定 G2/G3。

**需要你回答**：只做 G1，还是 G1 + G2（转草稿）？若选 G3（删除），请先跑一次 `.\tools\backup-content.ps1` 留下备份。

---

## 5. 尚未完成的两件操作（需要你来跑）

1. **首份内容备份**（当前最大风险：`content/data` 与 `content/uploads` 零备份）
   ```powershell
   cd D:\teacherGeng\AetherCMS\aether-cms
   .\tools\backup-content.ps1          # 会输出三个实例的真实文章数/上传文件数/体积
   ```
2. **部署**：`.\tools\sync-today-to-server.ps1 -RunNpmInstall`（清单已含本批 21 新增 + 46 修改 = 66 个文件）+ 重启三个实例（会话 0/10/11）。

---

## 6. 验收方式（做完 F/G 后怎么确认）

```bash
# 体检：标签总数下降、单次标签占比下降、同义簇消失
node tools/tag-audit.mjs https://xl.dleu.net --emit-plan plan-after.json

# 标签云与计数
curl -s https://xl.dleu.net/api/tags | head -c 400

# 旧链接仍可用（应为 301 → 规范标签）
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://xl.dleu.net/tag/<旧标签>

# 搜索与公开 API 的标签面一致
curl -s 'https://xl.dleu.net/api/public/posts?tag=<别名>' | head -c 200
```
