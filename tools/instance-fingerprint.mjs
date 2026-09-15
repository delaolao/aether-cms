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
 *
 * 判定说明
 *   只有实例有 → `MISSING_IN_REPO`（服务器侧改动/新增，拆分前必须回收）
 *   只有仓库有 → `MISSING_IN_INSTANCE`（仓库比实例新，或该文件没被部署过）
 *   内容不同   → `DIFFERS`
 *
 * 排除规则分两类：
 *   目录名（任何层级）：node_modules、.git、cache、.npm-cache、release、_site、.backups、.tag-merge-backups
 *   相对路径：content/data（users.json / sessions.json / analytics）、content/uploads（图片与附件）、content/cache
 *   ⚠️ `content/themes/**` **参与比对** —— 模板定制正是最需要被发现的差异。
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

function parseArgs(argv) {
    const args = { root: ".", excludes: [], json: false, quiet: false }
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

/** CRLF→LF 归一化后取 sha256（latin1 保证任意字节一对一映射）。 */
function hashFile(full) {
    const buffer = readFileSync(full)
    const normalized = buffer.toString("latin1").replace(/\r\n/g, "\n")
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

function compare(instanceFiles, repoFiles, quiet) {
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
            for (const rel of list.sort()) console.log(`  ${rel}`)
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
        const instanceFiles = parseFingerprint(readFileSync(resolve(args.compare), "utf8"))
        const repoText = args.against
            ? readFileSync(resolve(args.against), "utf8")
            : serialize(buildManifest(args.root, args.excludes))
        const repoFiles = parseFingerprint(repoText)
        const result = compare(instanceFiles, repoFiles, args.quiet)
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
