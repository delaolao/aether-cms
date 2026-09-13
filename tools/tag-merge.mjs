#!/usr/bin/env node
/**
 * 标签合并执行工具（B）——把「合并方案」安全地落到内容文件上。
 *
 * 与 `tag-audit.mjs` 的关系：体检工具导出 `tag-merge-plan.json`（人工确认哪些要合并、
 * 删掉不认可的条目），本工具负责执行。默认**只预览不写入**，必须显式 `--apply`。
 *
 * 安全设计
 *   - 只改 frontmatter 里的 `tags:` 一行，文件其余部分**逐字节不变**（不是重新序列化整个 frontmatter）
 *   - 每个被改动的文件先备份到 `.tag-merge-backups/<时间戳>/`，`--rollback` 可整批还原
 *   - 原子写（临时文件 + rename），失败不会留下半个文件
 *   - 默认只执行 `autoMerge`(归一化重复) 与 `strongMerge`(文章集合完全相同)，
 *     `review`(语义近似) 需要显式 `--only review` 才执行；`dropDemoTags` 需要 `--drop-demo`
 *   - 幂等：重复执行不会产生新改动
 *   - 冲突（同一标签被映射到两个规范名 / 出现环）会直接报错并中止
 *
 * 用法
 *   # 预览（不写任何文件）
 *   node tools/tag-merge.mjs --plan tag-merge-plan.json
 *   node tools/tag-merge.mjs --dir /data/.../content/data --plan tag-merge-plan.json
 *
 *   # 执行（写文件 + 备份 + 报告）
 *   node tools/tag-merge.mjs --plan tag-merge-plan.json --apply
 *   node tools/tag-merge.mjs --plan tag-merge-plan.json --apply --also-alias   # 同时写入 tag-aliases.json（老链接继续 301）
 *   node tools/tag-merge.mjs --plan tag-merge-plan.json --apply --only review  # 连语义近似候选一起合并
 *
 *   # 临时合并 / 删除标签
 *   node tools/tag-merge.mjs --from cpu,CPU --to 中央处理器 --apply
 *   node tools/tag-merge.mjs --drop wiki,graph --apply
 *
 *   # 回滚（整批还原到执行前）
 *   node tools/tag-merge.mjs --rollback .tag-merge-backups/20260913-101500
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs"
import { join, resolve, dirname, basename, relative } from "node:path"
import { normalizeTagName, normalizeTagList, slugify } from "../core/lib/content/utils/content-utils.js"
import { saveTagAliases, tagAliasesFilePath, configureTagAliases } from "../core/lib/content/utils/tag-aliases.js"

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {
        dir: "content/data",
        plan: "",
        source: "",
        from: "",
        to: "",
        drop: "",
        only: "auto,strong",
        moveToStage: "",
        apply: false,
        dryRun: false,
        alsoAlias: false,
        dropDemo: false,
        rollback: "",
        quiet: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const value = () => {
            const next = argv[i + 1]
            if (next === undefined || next.startsWith("--")) {
                console.error(`缺少参数值: ${arg}`)
                process.exit(2)
            }
            i += 1
            return next
        }
        switch (arg) {
            case "--dir": args.dir = value(); break
            case "--plan": args.plan = value(); break
            case "--source": args.source = value(); break
            case "--from": args.from = value(); break
            case "--to": args.to = value(); break
            case "--drop": args.drop = value(); break
            case "--move-to-stage": args.moveToStage = value(); break
            case "--only": args.only = value(); break
            case "--rollback": args.rollback = value(); break
            case "--apply": args.apply = true; break
            case "--dry-run": args.dryRun = true; break
            case "--also-alias": args.alsoAlias = true; break
            case "--drop-demo": args.dropDemo = true; break
            case "--quiet": args.quiet = true; break
            case "--help":
            case "-h":
                console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0].replace(/^\/\*\*?/, "").replace(/^ ?\* ?/gm, ""))
                process.exit(0)
                break
            default:
                console.error(`未知参数: ${arg}`)
                process.exit(2)
        }
    }
    if (!args.plan && !args.from && !args.drop && !args.moveToStage && !args.rollback) {
        console.error(
            "请提供 --plan <方案文件>、或 --from A,B --to C、或 --drop A,B、或 --move-to-stage 小学,初中,高中、或 --rollback <备份目录>"
        )
        process.exit(2)
    }
    return args
}

function log(args, ...parts) {
    if (!args.quiet) console.log(...parts)
}

// ---------------------------------------------------------------------------
// 方案 → 合并映射
// ---------------------------------------------------------------------------
function planSources(plan) {
    if (Array.isArray(plan?.sources)) return plan.sources
    return [plan]
}

function selectSource(plan, wanted) {
    const sources = planSources(plan)
    if (sources.length === 1) return sources[0]
    if (!wanted) {
        console.error("方案文件包含多个站点，请用 --source <序号|名称> 指定要执行的这一个：")
        sources.forEach((source, index) => console.error(`  [${index}] ${source?.source || "(未命名)"}`))
        process.exit(2)
    }
    const index = Number.parseInt(wanted, 10)
    if (Number.isInteger(index) && sources[index]) return sources[index]
    const byName = sources.find((source) => String(source?.source || "").includes(wanted))
    if (byName) return byName
    console.error(`找不到 --source ${wanted}`)
    process.exit(2)
}

/**
 * 把方案里的条目收集成 `别名 → 规范名` 映射。
 * @param {Object} source - 方案中的单个站点对象
 * @param {string[]} only - 要执行的桶（auto / strong / review）
 * @returns {{map: Map<string,string>, skipped: Object, sources: string[]}}
 */
function buildMergeMap(source, only) {
    const map = new Map()
    const skipped = { autoMerge: 0, strongMerge: 0, review: 0, dropDemoTags: 0 }
    const origins = []

    const add = (from, to, bucket) => {
        const canonical = normalizeTagName(to)
        if (!canonical) return
        for (const aliasRaw of Array.isArray(from) ? from : [from]) {
            const alias = normalizeTagName(aliasRaw)
            if (!alias || alias === canonical) continue
            const existing = map.get(alias)
            if (existing && normalizeTagName(existing) !== canonical) {
                console.error(`冲突：标签「${alias}」同时被映射到「${existing}」与「${canonical}」，请先修正方案。`)
                process.exit(3)
            }
            map.set(alias, canonical)
            origins.push(`${bucket}: ${alias} → ${canonical}`)
        }
    }

    for (const entry of source?.autoMerge || []) {
        if (!only.includes("auto")) { skipped.autoMerge += (entry.from || []).length; continue }
        add(entry.from, entry.to, "autoMerge")
    }
    for (const entry of source?.strongMerge || []) {
        if (!only.includes("strong")) { skipped.strongMerge += (entry.from || []).length; continue }
        add(entry.from, entry.to, "strongMerge")
    }
    for (const entry of source?.review || []) {
        if (!only.includes("review")) { skipped.review += 1; continue }
        // review 条目形如 { a, b, kind, counts, suggestion }：
        // 方向优先取显式的 entry.to，其次取使用篇数更多的一个作为规范名。
        if (!entry.a || !entry.b) continue
        const [countA = 0, countB = 0] = Array.isArray(entry.counts) ? entry.counts : []
        const to = entry.to || (countA >= countB ? entry.a : entry.b)
        const from = normalizeTagName(to) === normalizeTagName(entry.a) ? entry.b : entry.a
        add([from], to, "review")
    }
    if (!only.includes("demo")) skipped.dropDemoTags += (source?.dropDemoTags || []).length

    return { map, skipped, origins }
}

/** 解析映射中的链式关系并检测环。 */
function resolveMap(map) {
    const resolved = new Map()
    for (const alias of map.keys()) {
        let current = alias
        const visited = new Set()
        for (let hop = 0; hop < 10; hop++) {
            const key = normalizeTagName(current)
            if (visited.has(key)) {
                console.error(`方案里存在环形映射（涉及「${alias}」），请先修正。`)
                process.exit(3)
            }
            visited.add(key)
            const next = map.get(key)
            if (!next) break
            current = next
        }
        resolved.set(alias, current)
    }
    return resolved
}

// ---------------------------------------------------------------------------
// 改写内容文件
// ---------------------------------------------------------------------------
const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---)/

/** 把 tags 数组序列化成项目既有风格：["a", "b"] */
function serializeTags(tags) {
    return `[${tags.map((t) => JSON.stringify(t)).join(", ")}]`
}

/**
 * 只替换 frontmatter 内 `tags:` 那一行，其它字节原样保留。
 * @returns {{changed: boolean, before: string[], after: string[], text: string}}
 */
function rewriteTags(text, transform) {
    const match = FRONTMATTER_RE.exec(text)
    if (!match) return { changed: false, before: [], after: [], text }

    const head = match[1]
    const body = match[2]
    const tail = match[3]
    const rest = text.slice(match[0].length)

    const lines = body.split(/\r?\n/)
    const newline = body.includes("\r\n") ? "\r\n" : "\n"
    const lineIndex = lines.findIndex((line) => /^\s*tags\s*:/.test(line))
    if (lineIndex === -1) return { changed: false, before: [], after: [], text }

    const rawValue = lines[lineIndex].replace(/^\s*tags\s*:\s*/, "").trim()
    let before = []
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        try {
            before = normalizeTagList(JSON.parse(rawValue))
        } catch {
            before = normalizeTagList(rawValue.slice(1, -1))
        }
    } else {
        before = normalizeTagList(rawValue)
    }

    const after = transform(before)
    if (JSON.stringify(before) === JSON.stringify(after)) return { changed: false, before, after, text }

    lines[lineIndex] = `tags: ${serializeTags(after)}`
    const newText = head + lines.join(newline) + tail + rest
    return { changed: true, before, after, text: newText }
}

function collectContentFiles(dataDir) {
    const files = []
    for (const sub of ["posts", "pages", "custom"]) {
        const dir = join(dataDir, sub)
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir)) {
            if (name.endsWith(".md")) files.push({ path: join(dir, name), kind: sub })
        }
    }
    return files
}

/**
 * 把 `stage:` 行写入（或替换 / 删除）frontmatter，其余字节原样保留。
 * 用于 F 的一次性迁移：把「小学/初中/高中」从 tags 移到独立字段。
 * @returns {{changed: boolean, before: string, after: string, text: string}}
 */
function rewriteStageLine(text, value) {
    const match = FRONTMATTER_RE.exec(text)
    if (!match) return { changed: false, before: "", after: "", text }
    const head = match[1]
    const body = match[2]
    const tail = match[3]
    const rest = text.slice(match[0].length)
    const lines = body.split(/\r?\n/)
    const newline = body.includes("\r\n") ? "\r\n" : "\n"
    const lineIndex = lines.findIndex((line) => /^\s*stage\s*:/.test(line))
    const before = lineIndex === -1 ? "" : lines[lineIndex].replace(/^\s*stage\s*:\s*/, "").trim().replace(/^["']|["']$/g, "")
    const after = value ? String(value) : ""

    if (before === after) return { changed: false, before, after, text }

    if (after) {
        if (lineIndex === -1) {
            // 插到 slug/status 之后（不存在则追加到 frontmatter 末尾）
            const anchor = lines.findIndex((line) => /^\s*(status|slug)\s*:/.test(line))
            const insertAt = anchor === -1 ? lines.length : anchor + 1
            lines.splice(insertAt, 0, `stage: ${JSON.stringify(after)}`)
        } else {
            lines[lineIndex] = `stage: ${JSON.stringify(after)}`
        }
    } else if (lineIndex !== -1) {
        lines.splice(lineIndex, 1)
    }

    return { changed: true, before, after, text: head + lines.join(newline) + tail + rest }
}

// ---------------------------------------------------------------------------
// 回滚
// ---------------------------------------------------------------------------
function rollback(backupDir, args) {
    // manifest.json 是回滚的契约文件；report.json 为同一内容的可读副本（早期版本只写了后者）
    const manifestPath = existsSync(join(backupDir, "manifest.json"))
        ? join(backupDir, "manifest.json")
        : join(backupDir, "report.json")
    if (!existsSync(manifestPath)) {
        console.error(`备份目录里没有 manifest.json / report.json: ${backupDir}`)
        process.exit(1)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    let restored = 0
    for (const entry of manifest.files || []) {
        const backupFile = join(backupDir, entry.backup)
        if (!existsSync(backupFile)) {
            console.error(`缺少备份文件: ${backupFile}`)
            continue
        }
        copyFileSync(backupFile, entry.path)
        restored += 1
    }
    log(args, `已从 ${backupDir} 还原 ${restored} 个文件（原始标签与内容一并恢复）。`)
    log(args, "提示：若之前用 --also-alias 写过 tag-aliases.json，需要按需手动清理。")
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2))
const dataDir = resolve(args.dir)

// 别名表也要指向同一个数据目录（--also-alias 会写 content/data/tag-aliases.json）
configureTagAliases({ dataDir })

if (args.rollback) {
    rollback(resolve(args.rollback), args)
    process.exit(0)
}

if (!existsSync(dataDir)) {
    console.error(`数据目录不存在: ${dataDir}`)
    process.exit(1)
}

// 1) 组装合并映射
let mergeMap = new Map()
let skipped = { autoMerge: 0, strongMerge: 0, review: 0, dropDemoTags: 0 }
let dropList = []
let origins = []
let planNote = ""

if (args.plan) {
    const planPath = resolve(args.plan)
    if (!existsSync(planPath)) {
        console.error(`方案文件不存在: ${planPath}`)
        process.exit(1)
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8"))
    const source = selectSource(plan, args.source)
    const only = args.only.split(",").map((s) => s.trim()).filter(Boolean)
    const built = buildMergeMap(source, only)
    mergeMap = resolveMap(built.map)
    skipped = built.skipped
    origins = built.origins
    planNote = `${basename(planPath)}（站点: ${source?.source || "未命名"}）`
    if (args.dropDemo || only.includes("demo")) {
        dropList = (source?.dropDemoTags || []).map((d) => normalizeTagName(d.tag ?? d)).filter(Boolean)
    }
}

if (args.from) {
    if (!args.to) {
        console.error("--from 需要同时提供 --to <规范名>")
        process.exit(2)
    }
    const canonical = normalizeTagName(args.to)
    for (const alias of args.from.split(",")) {
        const name = normalizeTagName(alias)
        if (name && name !== canonical) mergeMap.set(name, canonical)
    }
}

if (args.drop) {
    dropList = dropList.concat(args.drop.split(",").map((tag) => normalizeTagName(tag)).filter(Boolean))
}

const dropSet = new Set(dropList.map((t) => t.toLowerCase()))

// F：把学段标签（小学/初中/高中…）从 tags 迁到独立字段 stage
const stageMoves = (args.moveToStage || "").split(",").map((s) => normalizeTagName(s)).filter(Boolean)
const stageMoveSet = new Set(stageMoves.map((s) => s.toLowerCase()))

if (mergeMap.size === 0 && dropSet.size === 0 && stageMoveSet.size === 0) {
    console.log("没有任何合并/删除规则，未做任何修改。")
    if (skipped.review || skipped.dropDemoTags || skipped.autoMerge || skipped.strongMerge) {
        console.log(
            `提示：方案里还有 review ${skipped.review} 条 / dropDemoTags ${skipped.dropDemoTags} 个 / ` +
                `autoMerge ${skipped.autoMerge} 个 / strongMerge ${skipped.strongMerge} 个被 --only 过滤掉了。`
        )
        console.log("     想预览语义近似合并：--only auto,strong,review；想连演示噪声标签一起清理：再加 --drop-demo。")
    }
    process.exit(0)
}

// 2) 计算改动
const files = collectContentFiles(dataDir)
const changes = []
for (const file of files) {
    const text = readFileSync(file.path, "utf8")
    const tagResult = rewriteTags(text, (tags) => {
        const out = []
        const seen = new Set()
        for (const tag of tags) {
            const canonical = mergeMap.get(tag) || tag
            if (dropSet.has(canonical.toLowerCase())) continue
            const key = canonical.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            out.push(canonical)
        }
        return out
    })

    // F：把学段标签从 tags 移到 stage 字段（保留原学段，不覆盖作者已填的值）
    let finalText = tagResult.text
    let stageBefore = ""
    let stageAfter = ""
    let movedFrom = ""
    if (stageMoveSet.size) {
        const matched = tagResult.before
            .concat(tagResult.after)
            .find((tag) => stageMoveSet.has(tag.toLowerCase()))
        if (matched) {
            const existing = /(?:^|\n)stage\s*:\s*"?([^"\n]*)"?/.exec(text)
            const currentStage = existing ? existing[1].trim() : ""
            const targetStage = currentStage || matched
            // 先把学段标签从 tags 里移除，再写 stage 行；两步的结果必须串起来，
            // 否则「stage 行本来就正确」时会把 tags 的改动丢掉（曾经的 bug）。
            const withoutStageTag = rewriteTags(finalText, (tags) =>
                tags.filter((tag) => !stageMoveSet.has(tag.toLowerCase()))
            )
            const stageResult = rewriteStageLine(withoutStageTag.text, targetStage)
            finalText = stageResult.text
            stageBefore = stageResult.before
            stageAfter = stageResult.after
            movedFrom = matched
        }
    }

    if (finalText !== text) {
        const finalTags = rewriteTags(finalText, (tags) => tags)
        changes.push({
            path: file.path,
            kind: file.kind,
            before: tagResult.before,
            after: finalTags.before,
            stageBefore,
            stageAfter,
            movedFrom,
            text: finalText,
        })
    }
}

// 3) 预览
console.log("")
console.log("=== 标签合并执行（B）===")
console.log(`数据目录 : ${dataDir}`)
if (planNote) console.log(`方案     : ${planNote}`)
console.log(`合并规则 : ${mergeMap.size} 条${mergeMap.size ? ` → ${[...mergeMap.entries()].map(([a, b]) => `${a}→${b}`).join(", ")}` : ""}`)
if (dropSet.size) console.log(`删除规则 : ${dropSet.size} 条 → ${[...dropSet].join(", ")}`)
if (stageMoveSet.size) console.log(`学段迁移 : tags 中的 ${stageMoves.join(", ")} 将移入 stage 字段（不覆盖已有 stage）`)
if (skipped.autoMerge || skipped.strongMerge || skipped.review || skipped.dropDemoTags) {
    console.log(
        `已跳过   : review ${skipped.review} 条（需 --only review）、dropDemoTags ${skipped.dropDemoTags} 个（需 --drop-demo）、` +
            `autoMerge ${skipped.autoMerge} 个、strongMerge ${skipped.strongMerge} 个（未包含在 --only 中）`
    )
}
console.log(`扫描文件 : ${files.length} 个，其中需要改动 ${changes.length} 个`)
if (args.plan) {
    const single = (selectSource(JSON.parse(readFileSync(resolve(args.plan), "utf8")), args.source)?.singleArticleTags || []).length
    if (single) console.log(`仅信息   : ${single} 组「一篇文章自产的一组标签」未被处理（需要人工决定是否改成正文关键词）`)
}
console.log("")
for (const change of changes) {
    console.log(`  ${relative(dataDir, change.path)}`)
    console.log(`    原: [${change.before.join(", ")}]`)
    console.log(`    新: [${change.after.join(", ")}]`)
    if (change.stageAfter !== undefined && change.movedFrom) {
        console.log(
            `    学段: ${change.stageBefore && change.stageBefore !== change.stageAfter ? `「${change.stageBefore}」→ ` : ""}「${change.stageAfter}」（来自标签「${change.movedFrom}」）`
        )
    }
}

if (!args.apply) {
    console.log("")
    console.log("以上为预览（未写入任何文件）。确认无误后加 --apply 执行。")
    process.exit(0)
}
if (changes.length === 0) {
    console.log("")
    console.log("没有需要改动的文件（已经是目标状态，幂等）。")
    process.exit(0)
}

// 4) 备份 + 原子写入
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19)
const backupDir = resolve(dataDir, "..", ".tag-merge-backups", stamp)
mkdirSync(backupDir, { recursive: true })

const manifest = { createdAt: new Date().toISOString(), dataDir, plan: args.plan ? resolve(args.plan) : "", mergeMap: Object.fromEntries(mergeMap), drop: [...dropSet], moveToStage: stageMoves, files: [] }
for (const change of changes) {
    const backupName = `${change.kind}__${basename(change.path)}`
    copyFileSync(change.path, join(backupDir, backupName))
    const tmp = `${change.path}.tag-merge.tmp-${process.pid}`
    writeFileSync(tmp, change.text, "utf8")
    renameSync(tmp, change.path)
    manifest.files.push({
        path: change.path,
        backup: backupName,
        before: change.before,
        after: change.after,
        stageBefore: change.stageBefore || "",
        stageAfter: change.stageAfter || "",
        bytes: statSync(change.path).size,
    })
}

// 5) 可选：把合并结果写进别名表，保证老链接 301 与漏网内容仍能归一
let aliasInfo = ""
if (args.alsoAlias) {
    const aliases = {}
    for (const [alias, canonical] of mergeMap) aliases[alias] = canonical
    for (const dropped of dropSet) aliases[dropped] = "" // 空值表示丢弃
    const cleaned = {}
    const keepDrop = []
    for (const [alias, canonical] of Object.entries(aliases)) {
        if (canonical) cleaned[alias] = canonical
        else keepDrop.push(alias)
    }
    let existing = { aliases: {}, drop: [] }
    const aliasFile = tagAliasesFilePath()
    try {
        if (existsSync(aliasFile)) {
            const parsed = JSON.parse(readFileSync(aliasFile, "utf8"))
            existing = { aliases: parsed.aliases || {}, drop: Array.isArray(parsed.drop) ? parsed.drop : [] }
        }
    } catch {
        /* 无法解析则覆盖写入 */
    }
    const merged = {
        aliases: { ...existing.aliases, ...cleaned },
        drop: [...new Set([...existing.drop, ...keepDrop])],
    }
    const saved = saveTagAliases(merged)
    aliasInfo = `已写入别名表 ${saved.filePath}（${Object.keys(merged.aliases).length} 条别名、${merged.drop.length} 条丢弃）`
}

const reportPath = join(backupDir, "report.json")
const reportJson = `${JSON.stringify({ ...manifest, reportPath }, null, 2)}\n`
writeFileSync(reportPath, reportJson, "utf8")
// manifest.json 与 report.json 同内容：前者是 --rollback 的契约，后者便于人工阅读
writeFileSync(join(backupDir, "manifest.json"), reportJson, "utf8")

console.log("")
console.log(`已改动 ${changes.length} 个文件；备份与报告在 ${backupDir}`)
if (aliasInfo) console.log(aliasInfo)
console.log(`回滚命令: node tools/tag-merge.mjs --rollback "${backupDir}"`)
console.log("提示：若实例正在运行，标签云/标签页会在下一次请求时读到新标签（无需重启；只有改代码才需要重启）。")
