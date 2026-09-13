#!/usr/bin/env node
/**
 * 标签体检（只读）— 量化「标签混乱」，并给出可执行的合并方案。
 *
 * 为什么需要它：文章一多，标签就会长成长尾——每篇文章自带 5 个新标签，
 * 标签页只服务一篇文章，同义/近义标签并存（`cpu` 与 `中央处理器`、`情绪管理`
 * 与 `情绪信号`…），标签云因此既不像分类也不像关键词。这个工具把这些问题
 * 变成可核对的数据，并导出 `tag-merge-plan.json` 供人工确认后再执行合并。
 *
 * 用法
 *   # 线上站点（走公开 API + /tag-cloud，只读）
 *   node tools/tag-audit.mjs https://xl.dleu.net
 *   node tools/tag-audit.mjs https://xl.dleu.net https://xq.dleu.net
 *
 *   # 本地实例（直接读 content/data，不联网）
 *   node tools/tag-audit.mjs --dir content/data
 *   node tools/tag-audit.mjs --dir /data/te_se_zi_yuan/xl/aether-cms/content/data
 *
 *   # 导出合并方案（供 tools/tag-merge.mjs 或人工审阅）
 *   node tools/tag-audit.mjs https://xl.dleu.net --emit-plan tag-merge-plan.json
 *   node tools/tag-audit.mjs --dir content/data --json > audit.json
 *
 * 输出分区
 *   [1] 概览与长尾    [2] 归一化重复      [3] 同篇文章标签组（一篇文章产出一组标签）
 *   [4] 真子集关系    [5] 名称近义候选    [6] 过泛标签
 *   [7] 演示/样板内容 [8] 标签堆砌        [9] 长尾明细        [10] 建议动作与方案文件
 *
 * 只读：不会修改任何内容文件。
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve, extname } from "node:path"

// --------------------------------------------------------------------------
// 演示/样板内容的识别（这些标签来自上游示例文章，属于噪声）
// --------------------------------------------------------------------------
const DEMO_TAG_PATTERNS = [
    /^wiki$/i,
    /^graph$/i,
    /^hblog-?ng$/i,
    /^katex$/i,
    /^markdown$/i,
    /^aether cms$/i,
    /^obsidian$/i,
    /^公式$/,
    /^吉他$/,
    /^王若琳$/,
    /^富文本/,
    /测试$/,
]
const DEMO_TITLE_PATTERNS = [/aether cms/i, /hblog/i, /obsidian/i, /markdown/i, /语法速查/, /语法指南/, /整合说明/, /文件嵌入/, /公式编辑/, /富文本测试/, /封面测试/, /自动连播/, /标签云/, /知识图谱/, /wiki 关系/]

// --------------------------------------------------------------------------
// 参数
// --------------------------------------------------------------------------
function parseArgs(argv) {
    const args = { hosts: [], dir: "", json: false, emitPlan: "", quiet: false }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === "--dir") args.dir = argv[++i]
        else if (arg === "--json") args.json = true
        else if (arg === "--emit-plan") args.emitPlan = argv[++i]
        else if (arg === "--quiet") args.quiet = true
        else if (arg.startsWith("--")) {
            console.error(`未知参数: ${arg}`)
            process.exit(2)
        } else args.hosts.push(arg)
    }
    if (!args.dir && args.hosts.length === 0) {
        console.error("用法: node tools/tag-audit.mjs <站点URL...> | --dir <content/data 路径> [--emit-plan 文件] [--json]")
        process.exit(2)
    }
    return args
}

// --------------------------------------------------------------------------
// 文本工具
// --------------------------------------------------------------------------
function normalize(name) {
    return String(name)
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s_\-·・.,，。、；;：:!！?？"'“”‘’()（）\[\]【】<>《》/\\|~^*+]+/g, "")
}

/** 是否含 CJK（用于识别「中英同概念」候选） */
function hasCJK(text) {
    return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text))
}

function tagListOf(value) {
    // 既接受内容对象（{tags: …}），也接受扁平的标签值（数组 / 逗号字符串）
    const raw =
        value && typeof value === "object" && !Array.isArray(value) && "tags" in value ? value.tags : value
    if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean)
    if (typeof raw === "string") return raw.split(",").map((t) => t.trim()).filter(Boolean)
    return []
}

function isDemoTag(name) {
    return DEMO_TAG_PATTERNS.some((re) => re.test(String(name).trim()))
}

function isDemoTitle(title) {
    return DEMO_TITLE_PATTERNS.some((re) => re.test(String(title)))
}

// --------------------------------------------------------------------------
// 数据源 1：线上站点（公开 API + /tag-cloud）
// --------------------------------------------------------------------------
async function get(url, timeout = 20000) {
    try {
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeout) })
        return { status: res.status, body: await res.text() }
    } catch (error) {
        return { status: 0, body: "", error: error.message }
    }
}

async function loadFromHost(host) {
    const [cloudRes, apiRes] = await Promise.all([get(`${host}/tag-cloud`), get(`${host}/api/public/posts?limit=1000`)])
    if (apiRes.status !== 200) {
        throw new Error(`公开 API 不可用（${apiRes.status}）——请在服务器上用 --dir 模式，或先启用 PUBLIC_API_ENABLED`)
    }
    const items = (JSON.parse(apiRes.body).items || []).map((item) => ({
        title: item.title || "(无标题)",
        url: item.url || "",
        tags: tagListOf(item),
        status: "published",
    }))
    const cloudMatch = cloudRes.body.match(/id="tag-cloud-data">([\s\S]*?)<\/script>/)
    let cloud = []
    if (cloudMatch) {
        try {
            cloud = JSON.parse(cloudMatch[1])
        } catch {
            cloud = []
        }
    }
    // 公开 API 的 items 里没有出现、但标签云里存在的标签（例如只用在页面/草稿上）
    const seen = new Set()
    for (const item of items) for (const tag of item.tags) seen.add(tag)
    const extra = cloud.filter((t) => !seen.has(t.name)).map((t) => ({ name: t.name, count: t.count, onlyElsewhere: true }))
    return { label: host, items, cloudTags: cloud, extraTags: extra }
}

// --------------------------------------------------------------------------
// 数据源 2：本地 content/data（离线，无需 API）
// --------------------------------------------------------------------------
function parseFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!match) return {}
    const fm = {}
    for (const line of match[1].split(/\r?\n/)) {
        const at = line.indexOf(":")
        if (at === -1) continue
        const key = line.slice(0, at).trim()
        let value = line.slice(at + 1).trim()
        if (!key) continue
        if (value.startsWith("[") && value.endsWith("]")) {
            fm[key] = value
                .slice(1, -1)
                .split(",")
                .map((v) => v.trim().replace(/^["']|["']$/g, ""))
                .filter(Boolean)
        } else if (value.startsWith('"') && value.endsWith('"')) {
            fm[key] = value.slice(1, -1)
        } else {
            fm[key] = value
        }
    }
    return fm
}

function loadFromDir(dataDir) {
    const root = resolve(dataDir)
    const items = []
    const dirs = [
        ["posts", "post"],
        ["pages", "page"],
        ["custom", "custom"],
    ]
    for (const [sub, kind] of dirs) {
        const dir = join(root, sub)
        if (!existsSync(dir)) continue
        for (const file of readdirSync(dir)) {
            if (extname(file) !== ".md") continue
            const fm = parseFrontmatter(readFileSync(join(dir, file), "utf8"))
            const slug = fm.slug || file.replace(/\.md$/, "")
            items.push({
                title: fm.title || file,
                url: `/notes/${slug}`,
                tags: tagListOf(fm.tags),
                status: fm.status || "published",
                kind,
                file: join(sub, file),
            })
        }
    }
    // 本地模式：标签频次按「已发布」内容自行统计
    const counts = new Map()
    for (const item of items) {
        if (item.status !== "published") continue
        for (const tag of item.tags) counts.set(tag, (counts.get(tag) || 0) + 1)
    }
    const cloudTags = [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    const draftsOnly = []
    for (const item of items) {
        if (item.status === "published") continue
        for (const tag of item.tags) if (!counts.has(tag)) draftsOnly.push({ name: tag, count: 0, draftOnly: true })
    }
    return { label: `dir:${root}`, items, cloudTags, extraTags: draftsOnly }
}

// --------------------------------------------------------------------------
// 分析
// --------------------------------------------------------------------------
function analyze(source) {
    const { items, cloudTags, extraTags } = source
    const published = items.filter((item) => item.status === "published")
    const total = published.length

    // 标签 → 文章
    const tagPosts = new Map()
    for (const item of published) {
        for (const tag of item.tags) {
            if (!tagPosts.has(tag)) tagPosts.set(tag, [])
            tagPosts.get(tag).push(item.title)
        }
    }
    const counts = new Map()
    for (const tag of cloudTags) counts.set(tag.name, tag.count)
    for (const [tag, posts] of tagPosts) if (!counts.has(tag)) counts.set(tag, posts.length)

    const allTags = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    const hapax = allTags.filter((t) => t.count === 1)
    const tagSlots = published.reduce((sum, item) => sum + item.tags.length, 0)

    // [2] 归一化重复
    const byNorm = new Map()
    for (const tag of allTags) {
        const key = normalize(tag.name)
        if (!byNorm.has(key)) byNorm.set(key, [])
        byNorm.get(key).push(tag)
    }
    const exactDupes = [...byNorm.values()].filter((group) => group.length > 1)

    // [3] 文章集合完全相同
    const bySignature = new Map()
    for (const [tag, posts] of tagPosts) {
        const sig = [...posts].sort().join("\u0001")
        if (!bySignature.has(sig)) bySignature.set(sig, [])
        bySignature.get(sig).push(tag)
    }
    const sameSet = [...bySignature.values()]
        .filter((group) => group.length > 1)
        .map((group) => ({ tags: group, posts: tagPosts.get(group[0]) || [] }))
        .sort((a, b) => b.tags.length - a.tags.length)
    // 多篇（≥2 篇）同集合 = 强合并候选；单篇同集合 = 「一篇文章自产一组标签」
    const strongSameSet = sameSet.filter((group) => group.posts.length >= 2)
    const singleArticleGroups = sameSet.filter((group) => group.posts.length === 1)

    // [4] 真子集
    const entries = [...tagPosts.entries()]
    const subsets = []
    for (const [a, postsA] of entries) {
        for (const [b, postsB] of entries) {
            if (a === b || postsA.length >= postsB.length) continue
            if (postsA.every((p) => postsB.includes(p))) subsets.push({ small: a, smallCount: postsA.length, big: b, bigCount: postsB.length })
        }
    }

    // [5] 名称近义候选（包含关系 / 共享 2+ 字前缀 / 中英同概念）
    const nearNames = []
    const seenPair = new Set()
    for (let i = 0; i < allTags.length; i++) {
        for (let j = i + 1; j < allTags.length; j++) {
            const A = allTags[i]
            const B = allTags[j]
            const a = normalize(A.name)
            const b = normalize(B.name)
            if (a.length < 2 || b.length < 2 || a === b) continue
            let shared = 0
            while (shared < Math.min(a.length, b.length) && a[shared] === b[shared]) shared++
            const contained = a.includes(b) || b.includes(a)
            const cjkMix = hasCJK(A.name) !== hasCJK(B.name)
            const pa = tagPosts.get(A.name) || []
            const pb = tagPosts.get(B.name) || []
            // 「文章集合完全相同」只有在覆盖 ≥2 篇文章时才是可靠信号：
            // 一篇文章自带的一组标签天然同集合，那属于 [3] 的范畴，不算同义词。
            const identical = pa.length >= 2 && pa.length === pb.length && pa.every((p) => pb.includes(p))
            const inter = pa.filter((p) => pb.includes(p)).length
            const kind = identical && cjkMix ? "中英同概念(同文章)" : identical ? "同文章集合" : contained ? "名称包含" : shared >= 2 ? `共享「${a.slice(0, shared)}」` : ""
            if (!kind) continue
            const key = [A.name, B.name].sort().join("|")
            if (seenPair.has(key)) continue
            seenPair.add(key)
            nearNames.push({ kind, a: A, b: B, inter, identical, cjkMix, weight: (identical ? 100 : 0) + (contained ? 20 : 0) + (cjkMix ? 5 : 0) + shared })
        }
    }
    const nearRanked = nearNames.sort((x, y) => y.weight - x.weight || x.a.name.localeCompare(y.a.name))

    // [5b] 同族聚类：共享 2+ 字前缀、且都只在 1-2 篇文章上（典型的「同族标签发散」）
    const familyMap = new Map()
    for (const tag of allTags) {
        if (tag.count > 2) continue
        const norm = normalize(tag.name)
        if (norm.length < 3) continue
        for (let len = 2; len <= Math.min(3, norm.length - 1); len++) {
            const key = norm.slice(0, len)
            if (!familyMap.has(key)) familyMap.set(key, new Set())
            familyMap.get(key).add(tag.name)
        }
    }
    const families = [...familyMap.entries()]
        .map(([prefix, names]) => ({ prefix, tags: [...names] }))
        .filter((f) => f.tags.length >= 3)
        .map((f) => ({ ...f, counts: f.tags.map((n) => counts.get(n) || 0) }))
        .sort((a, b) => b.tags.length - a.tags.length)

    // [6] 过泛
    const broad = allTags.filter((t) => t.count >= Math.max(3, Math.ceil(total * 0.5)))

    // [7] 演示内容
    const demoArticles = published.filter((item) => isDemoTitle(item.title))
    const demoTags = allTags.filter((t) => isDemoTag(t.name))

    // [8] 堆砌
    const stuffed = [...published].sort((a, b) => b.tags.length - a.tags.length).slice(0, 5)

    return {
        total,
        allTags,
        hapax,
        tagSlots,
        exactDupes,
        strongSameSet,
        singleArticleGroups,
        subsets,
        nearNames: nearRanked,
        families,
        broad,
        demoArticles,
        demoTags,
        stuffed,
        tagPosts,
        extraTags,
        avgTagsPerArticle: total ? tagSlots / total : 0,
    }
}

// --------------------------------------------------------------------------
// 合并方案（供人工确认 → tools/tag-merge.mjs 执行）
// --------------------------------------------------------------------------
function buildPlan(source, report) {
    const plan = { generatedAt: new Date().toISOString(), source: source.label, autoMerge: [], strongMerge: [], review: [], families: [], dropDemoTags: [], singleArticleTags: [], notes: [] }

    for (const group of report.exactDupes) {
        const sorted = [...group].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        plan.autoMerge.push({ from: sorted.slice(1).map((t) => t.name), to: sorted[0].name, reason: "归一化后同名（大小写/全半角/空格差异）" })
    }
    for (const group of report.strongSameSet) {
        const sorted = [...group.tags].sort((a, b) => (report.tagPosts.get(b) || []).length - (report.tagPosts.get(a) || []).length || a.localeCompare(b))
        plan.strongMerge.push({ from: sorted.slice(1), to: sorted[0], articles: group.posts.length, reason: "覆盖完全相同的文章集合" })
    }
    plan.review = report.nearNames.slice(0, 60).map((near) => {
        const preferChinese = near.cjkMix && (hasCJK(near.a.name) ? near.a : near.b)
        const preferMore = near.a.count >= near.b.count ? near.a : near.b
        return {
            a: near.a.name,
            b: near.b.name,
            kind: near.kind,
            counts: [near.a.count, near.b.count],
            sharedArticles: near.inter,
            suggestion: near.identical
                ? `建议合并 → ${preferChinese ? preferChinese.name : preferMore.name}`
                : "人工确认是否合并（名称相近但文章集合不同）",
        }
    })
    plan.families = report.families.slice(0, 20).map((f) => ({ prefix: f.prefix, tags: f.tags, counts: f.counts, suggestion: `同族发散：考虑统一为一个上位标签（如「${f.prefix}」），或明确保留最具体的 1-2 个` }))
    plan.dropDemoTags = report.demoTags.map((t) => ({ tag: t.name, count: t.count, reason: "来自上游演示/样板文章" }))
    for (const group of report.singleArticleGroups) {
        plan.singleArticleTags.push({ article: group.posts[0], tags: group.tags })
    }
    plan.notes.push(`共 ${report.total} 篇已发布文章、${report.allTags.length} 个标签，平均每篇 ${report.avgTagsPerArticle.toFixed(1)} 个标签`)
    plan.notes.push(`仅出现 1 次的标签 ${report.hapax.length} 个（${Math.round((report.hapax.length / Math.max(1, report.allTags.length)) * 100)}%）`)
    plan.notes.push(`「一篇文章自产一组标签」共 ${report.singleArticleGroups.length} 组，涉及 ${report.singleArticleGroups.reduce((s, g) => s + g.tags.length, 0)} 个标签`)
    return plan
}

// --------------------------------------------------------------------------
// 报告输出
// --------------------------------------------------------------------------
function printReport(source, report) {
    const line = (s = "") => console.log(s)
    line()
    line("=".repeat(78))
    line(`=== ${source.label}`)
    line("=".repeat(78))
    line(`  已发布文章: ${report.total} 篇   标签总数: ${report.allTags.length}   平均每篇标签: ${report.avgTagsPerArticle.toFixed(1)}`)
    line(`  仅出现 1 次: ${report.hapax.length} 个（${Math.round((report.hapax.length / Math.max(1, report.allTags.length)) * 100)}%）   出现 2 次: ${report.allTags.filter((t) => t.count === 2).length} 个   ≥3 次: ${report.allTags.filter((t) => t.count >= 3).length} 个`)
    if (report.extraTags.length) {
        line(`  另在标签云/草稿里出现、但不在已发布文章上的标签: ${report.extraTags.length} 个 → ${report.extraTags.slice(0, 12).map((t) => t.name).join(", ")}${report.extraTags.length > 12 ? " …" : ""}`)
    }

    line(`\n  [2] 归一化后完全重复（大小写/全半角/空格差异）`)
    line(report.exactDupes.length ? report.exactDupes.map((g) => `      ${g.map((t) => `${t.name}(${t.count})`).join("  ==  ")}`).join("\n") : "      （无）")

    line(`\n  [3] 覆盖「完全相同文章集合」的标签`)
    line(`      多篇文章共同享有（强合并候选，${report.strongSameSet.length} 组）:`)
    line(
        report.strongSameSet.length
            ? report.strongSameSet
                  .slice(0, 12)
                  .map((g) => `        ${g.tags.map((t) => `${t}(${g.posts.length}篇)`).join("  +  ")}`)
                  .join("\n")
            : "        （无）"
    )
    line(`      只有 1 篇文章在用（= 该文章自产的一组标签，${report.singleArticleGroups.length} 组，涉及 ${report.singleArticleGroups.reduce((s, g) => s + g.tags.length, 0)} 个标签）:`)
    line(
        report.singleArticleGroups
            .slice(0, 8)
            .map((g) => `        ${g.tags.length} 个 ← 《${g.posts[0]}》: ${g.tags.join(", ")}`)
            .join("\n") || "        （无）"
    )

    line(`\n  [4] 真子集关系（A 的文章全部属于 B，${report.subsets.length} 组，仅列前 12）`)
    line(report.subsets.slice(0, 12).map((s) => `      ${s.small}(${s.smallCount}篇) ⊂ ${s.big}(${s.bigCount}篇)`).join("\n") || "      （无）")

    line(`\n  [5] 名称近义候选（${report.nearNames.length} 组，按可靠度排序，仅列前 20）`)
    line(
        report.nearNames
            .slice(0, 20)
            .map((n) => `      ${n.kind}: ${n.a.name}(${n.a.count}) ↔ ${n.b.name}(${n.b.count})  交集 ${n.inter}${n.identical ? "  ★建议合并" : ""}`)
            .join("\n") || "      （无）"
    )
    line(`\n  [5b] 同族发散（共享 2 字前缀、且都只在 1-2 篇文章上，${report.families.length} 组）`)
    line(
        report.families
            .slice(0, 12)
            .map((f) => `      「${f.prefix}」 ${f.tags.map((t, i) => `${t}(${f.counts[i]})`).join(" / ")}`)
            .join("\n") || "      （无）"
    )

    line(`\n  [6] 过泛标签（覆盖 ≥ 半数文章，通常应下沉为分类，${report.broad.length} 个）`)
    line(report.broad.map((t) => `      ${t.name}: ${t.count}/${report.total} 篇`).join("\n") || "      （无）")

    line(`\n  [7] 演示/样板内容（上游示例文章带来的噪声）`)
    line(`      疑似演示文章 ${report.demoArticles.length} 篇:`)
    line(report.demoArticles.map((item) => `        - ${item.title}  [${item.tags.join(", ")}]`).join("\n") || "        （无）")
    line(`      疑似演示标签 ${report.demoTags.length} 个: ${report.demoTags.map((t) => `${t.name}(${t.count})`).join("  ") || "（无）"}`)

    line(`\n  [8] 单篇标签最多的文章（堆砌）`)
    line(report.stuffed.map((item) => `      ${item.tags.length} 个  ${item.title}\n        ${item.tags.join(", ")}`).join("\n"))

    line(`\n  [9] 仅出现 1 次的标签 → 出自哪篇文章（${report.hapax.length} 个）`)
    line(
        report.hapax
            .map((t) => `      ${t.name}  →  ${(report.tagPosts.get(t.name) || ["（不在已发布文章上，可能是草稿或页面）"])[0]}`)
            .join("\n")
    )

    line(`\n  [10] 建议动作`)
    line(`      可直接合并（归一化重复）: ${report.exactDupes.length} 组`)
    line(`      强合并候选（同文章集合）: ${report.strongSameSet.length} 组`)
    line(`      需人工确认（名称近义）  : ${report.nearNames.length} 组`)
    line(`      建议清理的演示标签      : ${report.demoTags.length} 个`)
    line(`      单篇文章自产标签组      : ${report.singleArticleGroups.length} 组（考虑改成正文关键词或并入更稳的维度标签）`)
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2))
const sources = []
if (args.dir) sources.push(loadFromDir(args.dir))
for (const host of args.hosts) sources.push(await loadFromHost(host))

const reports = []
for (const source of sources) {
    const report = analyze(source)
    reports.push({ source, report })
    if (!args.json) printReport(source, report)
}

if (args.json) {
    console.log(
        JSON.stringify(
            reports.map(({ source, report }) => ({
                source: source.label,
                total: report.total,
                tags: report.allTags,
                avgTagsPerArticle: report.avgTagsPerArticle,
                exactDupes: report.exactDupes,
                strongSameSet: report.strongSameSet,
                singleArticleGroups: report.singleArticleGroups,
                subsets: report.subsets.slice(0, 50),
                nearNames: report.nearNames.slice(0, 50).map((n) => ({ kind: n.kind, a: n.a, b: n.b, identical: n.identical, inter: n.inter })),
                broad: report.broad,
                demoTags: report.demoTags,
                demoArticles: report.demoArticles.map((i) => i.title),
                stuffed: report.stuffed.map((i) => ({ title: i.title, tags: i.tags })),
                hapax: report.hapax,
            })),
            null,
            2
        )
    )
}

if (args.emitPlan) {
    const plan = reports.length === 1 ? buildPlan(reports[0].source, reports[0].report) : { generatedAt: new Date().toISOString(), sources: reports.map(({ source, report }) => buildPlan(source, report)) }
    writeFileSync(args.emitPlan, `${JSON.stringify(plan, null, 2)}\n`, "utf8")
    if (!args.json) console.log(`\n  合并方案已写入: ${resolve(args.emitPlan)}（人工确认后再执行合并；当前还没有执行工具会读取它）`)
}
