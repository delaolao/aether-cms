#!/usr/bin/env node
/**
 * 实例指纹 —— 核对「某个运行中的实例」与「本地仓库」到底差在哪些文件。
 *
 * 为什么需要它：服务器上的实例**不是 git 检出**（部署方式是 tar + scp 覆盖），
 * 所以就地手改过的文件不会出现在任何 `git status` 里，也不会被 `git log` 记录。
 * 一旦要把某个实例拆成独立项目/独立仓，如果不先做这一步，那些"只在服务器上存在"
 * 的修改就会在拆分中丢失；反过来，仓库里比实例新的文件也要能一眼看出。
 *
 * 难点：本地工作副本是 CRLF（core.autocrlf=true），服务器上是 LF，
 * **直接比 sha256 会得到"每个文件都不同"**（实测：ember 主题 17 个文件全部"不同"，
 * 逐行核对后其实 17/17 完全一致）。因此本工具对所有文件先做 CRLF→LF 归一化
 * （用 latin1 逐字节映射，二进制文件也保持一致语义），再算 sha256。
 *
 * 用法
 *   # 1) 在服务器上（实例目录内）生成指纹，排除 content/、node_modules、缓存
 *   node tools/instance-fingerprint.mjs --root . --out /tmp/xl.fingerprint.txt
 *
 *   # 2) 把指纹拉回本地（在本机执行）
 *   scp admin@<host>:/tmp/xl.fingerprint.txt .
 *
 *   # 3) 在本地仓库里做比对
 *   node tools/instance-fingerprint.mjs --root . --out xl-repo.fingerprint.txt
 *   node tools/instance-fingerprint.mjs --compare xl.fingerprint.txt --against xl-repo.fingerprint.txt
 *
 * 选项
 *   --root <path>      要扫描的目录（默认 .）
 *   --out <file>       指纹输出文件（默认 stdout）
 *   --compare <file>   与另一份指纹比对（当作"实例侧"）
 *   --against <file>   比对基准（当作"仓库侧"，默认当前 --root 生成的指纹）
 *   --exclude <name>   追加排除的目录名（可重复）
 *   --json             指纹输出为 JSON（便于二次处理）
 *   --quiet            只输出结论行
 *   --verbose          差异清单不折叠（默认按目录分组，大组只给计数）
 *
 * 判定说明
 *   只有实例有 → `MISSING_IN_REPO`（服务器侧改动/新增，拆分前必须回收）
 *   只有仓库有 → `MISSING_IN_INSTANCE`（仓库比实例新，或该文件没被部署过）
 *   内容不同   → `DIFFERS`
 *
 * 排除规则：
 *   目录名（任何层级）：node_modules、.git、cache、.npm-cache、release、_site、.backups、.tag-merge-backups
 *   相对路径：content/data（users.json / sessions.json / analytics）、content/uploads（图片与附件）、content/cache
 *   文件名：`.env` 及其变体（**绝不入库，也不该出现在"要回收"清单里**）、本工具自己的 `*.fingerprint.txt` 输出
 *   ⚠️ `content/themes/**` **参与比对** —— 模板定制正是最需要被发现的差异。
 *
 * 哈希口径：**删除所有 CR 字节**（等价于 `tr -d '\r'`）后再算 sha256。
 * 这样 Linux 侧的纯 shell 兜底命令（find + sha256sum + tr -d '\r'）与本工具结果逐字节一致 ——
 * 早期版本只在本地做 CRLF→LF 配对替换，遇到二进制文件里孤立的 0x0D 字节就会误报
 * （实测：default 主题的 screenshot.avif 被误判为 DIFFERS）。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join, resolve, relative, basename } from "node:path"
import { createHash } from "node:crypto"

// 按**目录名**排除：依赖、缓存、构建产物（任何层级出现都跳过）
const DEFAULT_EXCLUDES = new Set(["node_modules", ".git", "cache", ".npm-cache", "release", "_site", ".backups", ".tag-merge-backups"])

// 按**相对路径**排除：只有实例数据与实例媒体该被排除。
// 注意 content/themes 必须比对 —— 模板定制正是最需要发现的那类差异，
// 早期版本粗暴排除整个 content/，会漏掉主题改动。
const DEFAULT_EXCLUDED_PATHS = new Set([
    "content/data", // 实例数据：users.json / sessions.json / settings.json / analytics
    "content/uploads", // 实例媒体：图片与附件
    "content/cache",
])

/**
 * 按**文件名**排除。
 *
 * `.env` 必须排除：它是实例私有的密钥文件（COOKIE_SECRET），既不入库，也**绝不能**
 * 出现在 MISSING_IN_REPO 里 —— 否则"把实例有、仓库没有的文件都回收一下"这个动作
 * 会把密钥提交进 Git。`.env.example` 反过来是入库的模板，要照常比对。
 *
 * 本工具自己的输出（`*.fingerprint.txt`）也必须排除，否则第二次运行会把上一次的结果
 * 当成"实例侧新增文件"报出来。
 */
function isExcludedFile(name) {
    if (name.startsWith(".env") && name !== ".env.example") return true
    if (name.endsWith(".fingerprint.txt")) return true
    return false
}

function parseArgs(argv) {
    const args = { root: ".", excludes: [], json: false, quiet: false, verbose: false }
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
            case "--root":
                args.root = value()
                break
            case "--out":
                args.out = value()
                break
            case "--compare":
                args.compare = value()
                break
            case "--against":
                args.against = value()
                break
            case "--exclude":
                args.excludes.push(value())
                break
            case "--json":
                args.json = true
                break
            case "--quiet":
                args.quiet = true
                break
            case "--verbose":
                args.verbose = true
                break
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
    return args
}

/** 删除所有 CR 字节后取 sha256（latin1 保证任意字节一对一映射，与 `tr -d '\r'` 等价）。 */
function hashFile(full) {
    const buffer = readFileSync(full)
    const normalized = buffer.toString("latin1").replace(/\r/g, "")
    return createHash("sha256").update(normalized, "latin1").digest("hex")
}

function walk(dir, ctx, out = []) {
    let entries
    try {
        entries = readdirSync(dir, { withFileTypes: true })
    } catch {
        return out
    }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(dir, entry.name)
        const rel = ctx.base === dir ? entry.name : `${relative(ctx.base, full).split("\\").join("/")}`
        if (entry.isDirectory()) {
            if (ctx.excludes.has(entry.name)) continue
            if (ctx.excludedPaths.has(rel)) continue
            walk(full, ctx, out)
            continue
        }
        if (!entry.isFile()) continue
        if (isExcludedFile(entry.name)) continue
        let size = 0
        try {
            size = statSync(full).size
        } catch {
            /* 读不到大小不影响指纹 */
        }
        out.push({ rel, sha256: hashFile(full), bytes: size })
    }
    return out
}

function buildManifest(rootPath, extraExcludes) {
    const excludes = new Set([...DEFAULT_EXCLUDES, ...extraExcludes])
    const excludedPaths = new Set(DEFAULT_EXCLUDED_PATHS)
    const root = resolve(rootPath)
    const files = walk(root, { base: root, excludes, excludedPaths }).sort((a, b) => a.rel.localeCompare(b.rel))
    return {
        generatedAt: new Date().toISOString(),
        root,
        by: `instance-fingerprint@${process.platform}`,
        excludes: [...excludes].sort(),
        excludedPaths: [...excludedPaths].sort(),
        fileCount: files.length,
        files,
    }
}

/** 文本指纹格式：`<sha256>  <relpath>`（与 sha256sum 一致，便于人眼/其他工具处理）。 */
function serialize(manifest) {
    return [
        `# instance-fingerprint v1`,
        `# generatedAt ${manifest.generatedAt}`,
        `# root ${manifest.root}`,
        `# files ${manifest.fileCount}`,
        `# excludes ${manifest.excludes.join(",")}`,
        `# excludedPaths ${(manifest.excludedPaths || []).join(",")}`,
        ...manifest.files.map((file) => `${file.sha256}  ${file.rel}`),
        "",
    ].join("\n")
}

function parseFingerprint(text) {
    const files = new Map()
    for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue
        const match = line.match(/^([0-9a-f]{64})\s+(.+)$/)
        if (match) files.set(match[2], match[1])
    }
    return files
}

/**
 * 解析后再过一遍排除规则。
 *
 * 为什么不能只在遍历目录时排除：比对用的指纹可能是**别处生成**的 —— 旧版本工具、
 * Linux 上的纯 shell 兜底命令、甚至一份手写的清单。`.env` 绝不能从这些来源漏进
 * MISSING_IN_REPO，否则"回收实例独有的文件"这个动作就会把 COOKIE_SECRET 提交进 Git。
 */
function applyExclusionFilter(files) {
    const out = new Map()
    for (const [rel, sha] of files) {
        const name = rel.split("/").pop()
        if (isExcludedFile(name)) continue
        if (DEFAULT_EXCLUDED_PATHS.has(rel)) continue
        if ([...DEFAULT_EXCLUDED_PATHS].some((prefix) => rel.startsWith(`${prefix}/`))) continue
        out.set(rel, sha)
    }
    return out
}

/** 按前两级目录分组（`content/themes/clean_blog/theme.json` → `content/themes/**`）。 */
function groupByPrefix(files) {
    const map = new Map()
    for (const rel of files) {
        const parts = rel.split("/")
        const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/**` : rel
        const list = map.get(key) || []
        list.push(rel)
        map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

// 一个分组内文件数不超过这个值就逐个列出，否则只给计数（避免上百个第三方主题文件淹没真正的发现）
const FULL_LIST_LIMIT = 15

function compare(instanceFiles, repoFiles, options = {}) {
    const { quiet = false, verbose = false } = options
    const missingInRepo = []
    const missingInInstance = []
    const differs = []

    for (const [rel, sha] of instanceFiles) {
        if (!repoFiles.has(rel)) missingInRepo.push(rel)
        else if (repoFiles.get(rel) !== sha) differs.push(rel)
    }
    for (const rel of repoFiles.keys()) {
        if (!instanceFiles.has(rel)) missingInInstance.push(rel)
    }

    if (!quiet) {
        const dump = (title, list, hint) => {
            console.log(`\n${title}（${list.length}）${hint ? ` — ${hint}` : ""}`)
            for (const [key, group] of groupByPrefix(list.sort())) {
                if (group.length <= FULL_LIST_LIMIT || verbose) {
                    for (const rel of group) console.log(`  ${rel}`)
                } else {
                    console.log(`  ${key}  ${group.length} 个文件（--verbose 展开）`)
                }
            }
        }
        dump("MISSING_IN_REPO  实例有、仓库没有", missingInRepo, "服务器侧改动/新增，拆分为新仓前必须回收")
        dump("DIFFERS          两边都有但内容不同", differs)
        dump("MISSING_IN_INSTANCE  仓库有、实例没有", missingInInstance, "仓库更新，或该文件从未部署到这台实例")
    }

    console.log(
        `\n结论：实例 ${instanceFiles.size} 个文件 · 仓库 ${repoFiles.size} 个文件 · 需回收 ${missingInRepo.length} · 内容不同 ${differs.length} · 仓库独有 ${missingInInstance.length}`
    )
    return { missingInRepo, differs, missingInInstance }
}

function main() {
    const args = parseArgs(process.argv.slice(2))

    if (args.compare) {
        const instanceFiles = applyExclusionFilter(parseFingerprint(readFileSync(resolve(args.compare), "utf8")))
        const repoText = args.against
            ? readFileSync(resolve(args.against), "utf8")
            : serialize(buildManifest(args.root, args.excludes))
        const repoFiles = applyExclusionFilter(parseFingerprint(repoText))
        const result = compare(instanceFiles, repoFiles, { quiet: args.quiet, verbose: args.verbose })
        // 需要回收的文件即"实例比仓库新"，有则返回非零，方便脚本里当门禁用
        process.exit(result.missingInRepo.length || result.differs.length ? 1 : 0)
    }

    const manifest = buildManifest(args.root, args.excludes)
    const text = args.json ? `${JSON.stringify(manifest, null, 2)}\n` : serialize(manifest)
    if (args.out) {
        writeFileSync(resolve(args.out), text, "utf8")
        console.log(`已写出指纹：${resolve(args.out)}（${manifest.fileCount} 个文件，已排除 ${manifest.excludes.join(", ")}）`)
    } else {
        process.stdout.write(text)
    }
}

main()
