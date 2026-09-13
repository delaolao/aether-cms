/**
 * 标签别名归一（read-time canonicalization）
 *
 * 目的：不修改任何内容文件，就能把「同一个概念的多个标签」合并展示——
 * `cpu` 与 `中央处理器`、`MarkDown` 与 `markdown`、`情绪管理` 与 `情绪`……
 * 这是数据清洗（`tools/tag-merge.mjs`，会改写 frontmatter）之外的**展示层**方案，
 * 优点是零风险、可随时回滚（删掉别名文件即恢复原状）。
 *
 * 别名文件：`content/data/tag-aliases.json`
 *   {
 *     "aliases": { "cpu": "中央处理器", "MarkDown": "markdown" },
 *     "drop": ["wiki", "graph"]
 *   }
 *   - aliases：别名 → 规范名（可链式，内部有环检测与 10 跳上限）
 *   - drop：整条丢弃的标签（例如上游演示文章带来的噪声标签），仅影响展示与筛选
 *   - 键名按 `normalizeTagName()` 归一后**忽略大小写**匹配，所以
 *     `markdown` / `MarkDown` / `Ｍａｒｋｄｏｗｎ` 都能命中同一条规则
 *
 * 生效范围：标签云与 `/api/tags`、标签页（`/tag/:slug`、`/tags/**`，含 301 跳转）、
 * 公开 API 的标签字段与 `?tag=` 过滤、站内搜索的标签面与过滤、sitemap/RSS 的标签。
 * 保存路径**不做**别名改写（那是 tag-merge 工具的职责，需要人工确认方案）。
 *
 * 文件改动会在 2 秒内被自动感知（按 mtime 重载），无需重启进程。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { normalizeTagName, slugify } from "./content-utils.js"

const DEFAULT_FILE = "tag-aliases.json"
const RELOAD_TTL_MS = 2000
const MAX_HOPS = 10

let config = {
    dataDir: "content/data",
    fileName: DEFAULT_FILE,
    enabled: true,
}

let cache = {
    loadedAt: 0,
    mtimeMs: -1,
    filePath: "",
    /** 归一化小写别名 → 规范名 */
    byKey: new Map(),
    /** 别名 slug（小写）→ 规范名 */
    bySlug: new Map(),
    /** 归一化小写的「被丢弃标签」 */
    dropKeys: new Set(),
    /** 已解析的规范名集合（归一化小写） */
    canonicalKeys: new Set(),
    raw: { aliases: {}, drop: [] },
    error: "",
}

/** 配置别名文件位置（在 core/app.js 启动时调用一次）。 */
export function configureTagAliases(options = {}) {
    if (options.dataDir) config.dataDir = options.dataDir
    if (options.fileName) config.fileName = options.fileName
    if (options.enabled !== undefined) config.enabled = options.enabled !== false
    cache.loadedAt = 0
    cache.mtimeMs = -1
    loadTagAliases({ force: true })
}

/** 别名文件的绝对/相对路径。 */
export function tagAliasesFilePath() {
    return join(config.dataDir, config.fileName)
}

/**
 * 读取并缓存别名表。默认按 mtime + 2 秒 TTL 自动重载，
 * 所以编辑 `tag-aliases.json` 后刷新页面即可生效。
 * @param {{force?: boolean}} [options]
 */
export function loadTagAliases(options = {}) {
    const filePath = tagAliasesFilePath()
    const now = Date.now()

    if (!options.force && now - cache.loadedAt < RELOAD_TTL_MS && cache.filePath === filePath) {
        return cache
    }

    let mtimeMs = -1
    try {
        if (existsSync(filePath)) mtimeMs = statSync(filePath).mtimeMs
    } catch {
        mtimeMs = -1
    }
    if (!options.force && mtimeMs === cache.mtimeMs && cache.filePath === filePath) {
        cache.loadedAt = now
        return cache
    }

    const next = {
        loadedAt: now,
        mtimeMs,
        filePath,
        byKey: new Map(),
        bySlug: new Map(),
        dropKeys: new Set(),
        canonicalKeys: new Set(),
        raw: { aliases: {}, drop: [] },
        error: "",
    }

    if (mtimeMs >= 0) {
        try {
            const parsed = JSON.parse(readFileSync(filePath, "utf8"))
            const aliases = parsed && typeof parsed.aliases === "object" && parsed.aliases ? parsed.aliases : {}
            const drop = Array.isArray(parsed?.drop) ? parsed.drop : []
            for (const [alias, canonical] of Object.entries(aliases)) {
                const aliasName = normalizeTagName(alias)
                const canonicalName = normalizeTagName(canonical)
                if (!aliasName || !canonicalName) continue
                // 只跳过「完全一样」的自映射（`自己: 自己`）。
                // 注意不能比较小写形式：`MarkDown → markdown` 正是把大小写变体
                // 归一到规范写法的用例，比较小写会把它误判成自映射而丢弃。
                if (aliasName === canonicalName) continue
                next.byKey.set(aliasName.toLowerCase(), canonicalName)
                next.bySlug.set(slugify(aliasName).toLowerCase(), canonicalName)
            }
            for (const item of drop) {
                const name = normalizeTagName(item)
                if (name) next.dropKeys.add(name.toLowerCase())
            }
            next.raw = { aliases, drop }
        } catch (error) {
            next.error = error.message
            console.error(`[tag-aliases] 无法解析 ${filePath}: ${error.message}`)
        }
        for (const canonical of next.byKey.values()) next.canonicalKeys.add(canonical.toLowerCase())
    }

    cache = next
    return cache
}

/** 别名表的当前状态（供后台/工具展示，不暴露内部 Map）。 */
export function tagAliasStats() {
    const state = loadTagAliases()
    return {
        filePath: state.filePath,
        exists: state.mtimeMs >= 0,
        count: state.byKey.size,
        dropCount: state.dropKeys.size,
        aliases: Object.fromEntries(state.byKey),
        drop: [...state.dropKeys],
        error: state.error,
    }
}

function isDropped(key) {
    return cache.dropKeys.size > 0 && cache.dropKeys.has(key)
}

/**
 * 把一个标签名解析成规范名。
 * 同名、链式别名、大小写/全半角/空格差异都会被处理；不在表里的标签原样返回。
 * @param {string} name
 * @returns {string} 规范名（"" 表示空或应被丢弃）
 */
export function resolveTagName(name) {
    if (!config.enabled) return normalizeTagName(name)
    loadTagAliases()
    const normalized = normalizeTagName(name)
    if (!normalized) return ""
    let current = normalized
    // Loop protection: never visit the same normalized key twice. The guard is
    // on *visited keys*, not on the input, so a case/width-only alias
    // (`MarkDown` → `markdown`) still applies — its key equals the input key.
    const visited = new Set()
    for (let hop = 0; hop < MAX_HOPS; hop++) {
        const key = current.toLowerCase()
        if (visited.has(key)) break
        visited.add(key)
        const next = cache.byKey.get(key)
        if (!next) break
        current = next
    }
    return isDropped(current.toLowerCase()) ? "" : current
}

/**
 * 用 slug 或名字解析规范名（标签页与筛选器拿到的可能是 slug）。
 * @param {string} value
 * @returns {string} 规范名；无法解析时返回归一化后的原值
 */
export function resolveTagIdentifier(value) {
    if (!config.enabled) return normalizeTagName(value)
    loadTagAliases()
    const raw = String(value ?? "").trim()
    if (!raw) return ""
    const byName = cache.byKey.get(normalizeTagName(raw).toLowerCase())
    if (byName) return isDropped(byName.toLowerCase()) ? "" : byName
    const bySlug = cache.bySlug.get(raw.toLowerCase()) || cache.bySlug.get(slugify(raw).toLowerCase())
    if (bySlug) return isDropped(bySlug.toLowerCase()) ? "" : bySlug
    return normalizeTagName(raw)
}

/**
 * 归一化 + 别名解析 + 去重（忽略大小写）——展示与筛选统一走这里。
 * @param {string[]|string|null} tags
 * @returns {string[]}
 */
export function canonicalizeTagList(tags) {
    const list = Array.isArray(tags)
        ? tags
        : typeof tags === "string"
        ? tags.split(/[,，、;；|]/)
        : []
    const out = []
    const seen = new Set()
    for (const raw of list) {
        const name = resolveTagName(raw)
        if (!name) continue
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(name)
    }
    return out
}

/** 该 slug/名字是否是一个被配置的别名（用于 301 跳转判断）。 */
export function isAliasIdentifier(value) {
    if (!config.enabled) return false
    loadTagAliases()
    const raw = String(value ?? "").trim()
    if (!raw) return false
    if (cache.byKey.has(normalizeTagName(raw).toLowerCase())) return true
    return cache.bySlug.has(raw.toLowerCase()) || cache.bySlug.has(slugify(raw).toLowerCase())
}

/**
 * 写入别名表（供 tag-merge 工具或后台使用）。原子写 + 备份。
 * @param {{aliases?: Object, drop?: string[]}} data
 * @returns {{filePath: string, backup: string, count: number}}
 */
export function saveTagAliases(data = {}) {
    const filePath = tagAliasesFilePath()
    const aliases = data.aliases && typeof data.aliases === "object" ? data.aliases : {}
    const drop = Array.isArray(data.drop) ? data.drop : []
    const payload = {
        $comment: "标签别名：aliases 为「别名 → 规范名」，drop 为整条丢弃的标签名。改完保存即可生效（自动重载）。",
        updatedAt: new Date().toISOString(),
        aliases,
        drop,
    }

    let backup = ""
    if (existsSync(filePath)) {
        backup = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`
        try {
            writeFileSync(backup, readFileSync(filePath))
        } catch (error) {
            console.error(`[tag-aliases] 备份失败: ${error.message}`)
            backup = ""
        }
    } else {
        try {
            mkdirSync(config.dataDir, { recursive: true })
        } catch {
            /* 目录已存在 */
        }
    }

    const tmp = `${filePath}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    renameSync(tmp, filePath)
    loadTagAliases({ force: true })
    return { filePath, backup, count: Object.keys(aliases).length }
}

/** 目录里是否有别名文件（给后台/工具做提示用）。 */
export function tagAliasesExist() {
    try {
        return existsSync(tagAliasesFilePath())
    } catch {
        return false
    }
}

/** 列出 dataDir 下的备份文件（便于人工回滚）。 */
export function listTagAliasBackups() {
    try {
        return readdirSync(config.dataDir)
            .filter((name) => name.startsWith(`${config.fileName}.bak-`))
            .sort()
            .reverse()
    } catch {
        return []
    }
}
