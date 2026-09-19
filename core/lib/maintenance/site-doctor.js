/**
 * 站点体检（只读）— 后台「维护」页的数据来源。
 *
 * 为什么需要它：`tools/` 下的维护工具（标签体检、合并、备份、安全轮换）全是 CLI，
 * 必须 ssh 上服务器或在本地跑脚本才能用。日常最常用的其实只是"看一眼现在有没有问题"，
 * 而这部分完全是只读的 —— 放在后台一个页面里即可，无需 shell。
 *
 * 设计约束（刻意保守）：
 *   - **只读**：本模块不写任何文件，不改配置，不删任何东西。唯一的副作用是向
 *     **自己**发几个 HTTP 请求（探测敏感路径是否被公开），用于安全自检。
 *   - **不 spawn 子进程**：不调用 ssh / tar / node，因此它天然无法做跨机同步、
 *     密钥轮换、进程重启 —— 那些仍然必须留在 CLI（见文件末尾说明）。
 *   - **单实例视角**：进程只能看到自己那份 `content/`。三台实例各看各的。
 *   - 单文件解析失败不影响整体报告：每段都有 try/catch，失败项降级为一条提醒。
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { join, resolve, relative, extname } from "node:path"
import { normalizeTagName, normalizeStageName, compareStageNames, slugify } from "../content/utils/content-utils.js"
import { tagAliasStats, listTagAliasBackups } from "../content/utils/tag-aliases.js"
import { formatSiteDateTime, getSiteTimeZone } from "../../utils/time-utils.js"

// 正文里对上传文件的引用（`![](/content/uploads/images/x.png)`、`[附件](/content/uploads/documents/y.pdf)`）
const UPLOAD_REF_RE = /\/content\/uploads\/[^\s)"'<>\]]+/g

// 体检不看的目录（缓存与历史归档，不是内容）
const SKIP_DIRS = new Set([".git", "node_modules", ".backups", ".tag-merge-backups", "cache"])

export function formatBytes(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return `${n} B`
    const units = ["KB", "MB", "GB", "TB"]
    let value = n / 1024
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024
        i++
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

export function formatUptime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0))
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return `${d} 天 ${h} 小时`
    if (h > 0) return `${h} 小时 ${m} 分`
    return `${m} 分 ${s % 60} 秒`
}

/** 递归列出目录下的文件（跳过缓存/归档目录）。失败时返回 []。 */
async function listFiles(dir, base = dir) {
    const out = []
    let entries
    try {
        entries = await readdir(dir, { withFileTypes: true })
    } catch {
        return out
    }
    for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            out.push(...(await listFiles(full, base)))
            continue
        }
        if (!entry.isFile()) continue
        let size = 0
        try {
            size = (await stat(full)).size
        } catch {
            /* 读数失败按 0 处理 */
        }
        out.push({ rel: relative(base, full).split("\\").join("/"), full, size })
    }
    return out
}

/** 读 + 解析 JSON，把"文件损坏"变成一条可展示的结果而不是抛出。 */
async function readJsonSafe(file) {
    try {
        const raw = await readFile(file, "utf8")
        const bytes = Buffer.byteLength(raw)
        try {
            return { exists: true, ok: true, data: JSON.parse(raw), bytes }
        } catch (error) {
            return { exists: true, ok: false, error: error.message, bytes }
        }
    } catch (error) {
        if (error.code === "ENOENT") return { exists: false, ok: true, data: null, bytes: 0 }
        return { exists: true, ok: false, error: error.message, bytes: 0 }
    }
}

/** 向本进程自己发一个请求（安全自检：敏感路径是否被公开）。 */
async function probeSelf(port, urlPath) {
    if (!port) return { path: urlPath, status: 0, error: "无法确定监听端口，已跳过" }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
        const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
            redirect: "manual",
            signal: controller.signal,
        })
        return { path: urlPath, status: response.status, ok: true }
    } catch (error) {
        return { path: urlPath, status: 0, error: error.message, ok: false }
    } finally {
        clearTimeout(timer)
    }
}

/** 从文章正文里抽出被引用的上传文件相对路径（相对 uploadsDir）。 */
function collectUploadRefs(items, uploadsDir) {
    const refs = new Map()
    const prefix = `${uploadsDir}/`
    for (const item of items) {
        const body = String(item.content || "")
        if (!body) continue
        for (const match of body.matchAll(UPLOAD_REF_RE)) {
            let raw = match[0]
            try {
                raw = decodeURIComponent(raw)
            } catch {
                /* 保留原样 */
            }
            raw = raw.split("?")[0].split("#")[0]
            const idx = raw.indexOf(prefix)
            if (idx === -1) continue
            const rel = raw.slice(idx + prefix.length)
            if (!rel) continue
            const entry = refs.get(rel) || { rel, count: 0, sources: [] }
            entry.count += 1
            const label = item.frontmatter?.title || item.frontmatter?.slug || item.id || "?"
            if (entry.sources.length < 3 && !entry.sources.includes(label)) entry.sources.push(label)
            refs.set(rel, entry)
        }
    }
    return refs
}

// ---------------------------------------------------------------------------
// 各段体检
// ---------------------------------------------------------------------------

async function checkInstance({ paths, req, contentManager }) {
    const siteSettings = await contentManager.getSiteSettings().catch(() => ({}))
    const port = req?.socket?.localPort || null
    const cookieSecret = String(process.env.COOKIE_SECRET || "").trim()
    const items = [
        { label: "实例根目录", value: resolve(paths.rootDir) },
        { label: "内容目录", value: resolve(paths.dataDir) },
        { label: "上传目录", value: resolve(paths.uploadsDir) },
        { label: "监听端口", value: port ? String(port) : "未知" },
        { label: "进程", value: `PID ${process.pid} · Node ${process.version}` },
        { label: "运行时长", value: formatUptime(process.uptime()) },
        { label: "当前主题", value: siteSettings.activeTheme || "default" },
        { label: "站点标题", value: siteSettings.siteTitle || "(未设置)" },
        {
            label: "COOKIE_SECRET",
            value: cookieSecret ? "已配置" : "未配置 —— 正在使用不安全回退值",
            level: cookieSecret ? "ok" : "warn",
            hint: cookieSecret ? "" : "在实例目录的 .env 里设置 COOKIE_SECRET 后重启",
        },
    ]
    return { section: { id: "instance", title: "实例信息", icon: "🖥️", items }, siteSettings }
}

async function checkContent({ paths, contentManager }) {
    const posts = await contentManager.getPosts({}).catch(() => [])
    const pages = await contentManager.getPages({}).catch(() => [])
    const uploads = await listFiles(resolve(paths.uploadsDir))
    const uploadBytes = uploads.reduce((sum, file) => sum + file.size, 0)

    const published = posts.filter((p) => p.frontmatter?.status === "published").length
    const drafts = posts.length - published
    const customPages = pages.filter((p) => (p.frontmatter?.pageType || "normal") === "custom").length
    // frontmatter 的日期可能已被解析成 Date，也可能还是字符串 —— 统一成时间戳再取最大值
    const stamps = posts
        .map((p) => {
            const raw = p.frontmatter?.updatedAt || p.frontmatter?.createdAt
            if (!raw) return null
            const time = raw instanceof Date ? raw.getTime() : new Date(raw).getTime()
            return Number.isFinite(time) ? time : null
        })
        .filter((time) => time !== null)
        .sort((a, b) => a - b)
    const latest = stamps.length ? formatSiteDateTime(new Date(stamps[stamps.length - 1])) : "—"

    const items = [
        { label: "文章", value: `${posts.length} 篇（已发布 ${published} · 草稿 ${drafts}）` },
        { label: "页面", value: `${pages.length} 个（普通 ${pages.length - customPages} · 自定义 ${customPages}）` },
        { label: "最近更新", value: latest },
        { label: "上传文件", value: `${uploads.length} 个 · ${formatBytes(uploadBytes)}` },
    ]
    return { section: { id: "content", title: "内容体量", icon: "📚", items }, posts, pages, uploads, uploadBytes }
}

function checkFields(posts, pages) {
    const all = [...posts, ...pages]
    const missing = { title: [], slug: [], category: [], stage: [], tags: [], excerpt: [] }
    for (const item of all) {
        const fm = item.frontmatter || {}
        const label = fm.title || fm.slug || item.id || "(无标题)"
        if (!String(fm.title || "").trim()) missing.title.push({ label, id: item.id })
        if (!String(fm.slug || "").trim()) missing.slug.push({ label, id: item.id })
        if (!String(fm.category || "").trim()) missing.category.push({ label, id: item.id })
        if (!normalizeStageName(fm.stage)) missing.stage.push({ label, id: item.id })
        const tags = Array.isArray(fm.tags) ? fm.tags.filter(Boolean) : []
        if (tags.length === 0) missing.tags.push({ label, id: item.id })
        if (!String(fm.excerpt || "").trim()) missing.excerpt.push({ label, id: item.id })
    }

    const row = (count, total, level, hint) => ({
        value: `${count} / ${total} 篇`,
        level: count === 0 ? "ok" : level,
        hint,
    })

    const total = all.length
    const items = [
        { label: "缺标题", ...row(missing.title.length, total, "error", "标题为空的内容在前台无法正常展示") },
        { label: "缺 slug", ...row(missing.slug.length, total, "error", "没有 slug 就没有可访问的 URL") },
        { label: "缺分类", ...row(missing.category.length, total, "info", "不影响发布，只是分类页里看不到它") },
        { label: "缺学段", ...row(missing.stage.length, total, "info", "不影响发布，只是学段页里看不到它") },
        { label: "无标签", ...row(missing.tags.length, total, "info", "无标签的文章不会出现在标签云与标签页") },
        { label: "缺摘要", ...row(missing.excerpt.length, total, "info", "缺摘要时前台按正文自动截断") },
    ]
    return { section: { id: "fields", title: "字段完整度", icon: "🧾", items }, missing }
}

function checkTags(posts) {
    const frequency = new Map()
    for (const post of posts) {
        const raw = post.frontmatter?.tags
        const tags = Array.isArray(raw)
            ? raw
            : typeof raw === "string"
            ? raw.split(/[,，、;；|]/)
            : []
        for (const tag of tags) {
            const name = normalizeTagName(tag)
            if (!name) continue
            const key = name.toLowerCase()
            const entry = frequency.get(key) || { name, count: 0 }
            entry.count += 1
            frequency.set(key, entry)
        }
    }

    const all = [...frequency.values()]
    const hapax = all.filter((entry) => entry.count === 1)
    const hapaxRatio = all.length ? Math.round((hapax.length / all.length) * 100) : 0

    // 归一化后仍并存的近重复（大小写/全半角差异会被 normalizeTagName 合并，
    // 所以这里剩下的是「写法不同但归一化结果不同」的候选，仅供人工判断）
    const bySlug = new Map()
    for (const entry of all) {
        const key = slugify(entry.name)
        const list = bySlug.get(key) || []
        list.push(entry)
        bySlug.set(key, list)
    }
    const duplicates = [...bySlug.values()].filter((list) => list.length > 1)

    const stats = tagAliasStats()
    const aliasRows = []
    if (stats.exists && stats.aliases) {
        const canonicalKeys = new Set(Object.values(stats.aliases).map((v) => String(v).toLowerCase()))
        for (const [alias, canonical] of Object.entries(stats.aliases)) {
            const aliasKey = String(alias).toLowerCase()
            const targetKey = String(canonical).toLowerCase()
            if (aliasKey === targetKey) {
                aliasRows.push({ level: "info", text: `别名自映射（无实际作用）：${alias} → ${canonical}` })
            } else if (!canonicalKeys.has(targetKey) && !frequency.has(targetKey)) {
                aliasRows.push({ level: "warn", text: `别名指向的规范名当前没有任何文章在用：${alias} → ${canonical}` })
            }
        }
    } else if (stats.error) {
        aliasRows.push({ level: "error", text: `别名文件解析失败：${stats.error}` })
    }

    const items = [
        { label: "唯一标签", value: `${all.length} 个` },
        {
            label: "只出现 1 次",
            value: `${hapax.length} 个 · ${hapaxRatio}%`,
            level: hapaxRatio >= 60 ? "warn" : "ok",
            hint: hapaxRatio >= 60 ? "长尾偏高，标签页只服务一篇文章；可用标签合并工具治理" : "",
        },
        { label: "近重复标签组", value: `${duplicates.length} 组`, level: duplicates.length ? "warn" : "ok" },
        {
            label: "别名表",
            value: stats.exists ? `${stats.count} 条别名 · ${stats.dropCount} 条丢弃` : "未启用（文件不存在）",
            level: stats.error ? "error" : "ok",
            hint: stats.exists ? relative(process.cwd(), stats.filePath).split("\\").join("/") : "content/data/tag-aliases.json",
        },
    ]
    return {
        section: { id: "tags", title: "标签", icon: "🏷️", items },
        tagFrequency: all.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN")),
        hapax,
        duplicates,
        aliasWarnings: aliasRows,
        aliasStats: stats,
    }
}

function checkStages(posts) {
    const frequency = new Map()
    const unset = []
    for (const post of posts) {
        const stage = normalizeStageName(post.frontmatter?.stage)
        if (!stage) {
            unset.push({ label: post.frontmatter?.title || post.frontmatter?.slug || post.id, id: post.id })
            continue
        }
        const key = stage.toLowerCase()
        const entry = frequency.get(key) || { name: stage, count: 0 }
        entry.count += 1
        frequency.set(key, entry)
    }
    const stages = [...frequency.values()].sort((a, b) => compareStageNames(a.name, b.name))

    const noStageAtAll = posts.length > 0 && unset.length === posts.length
    const items = [
        {
            label: "已设学段",
            value: `${posts.length - unset.length} / ${posts.length} 篇`,
            // 学段是可选维度：整站都不用不算问题（info）；只在"一部分用了、一部分漏了"
            // 时提醒——那种情况下漏掉的文章在前台 /stage 页里看不到。
            level: noStageAtAll ? "info" : unset.length === 0 ? "ok" : "warn",
            hint: noStageAtAll
                ? "尚未启用学段维度；给 frontmatter 加 stage 即可让 /stage 页生效"
                : unset.length === 0
                ? ""
                : `有 ${unset.length} 篇缺学段，不会出现在 /stage 页`,
        },
        {
            label: "学段分布",
            value: stages.length ? stages.map((s) => `${s.name}(${s.count})`).join(" · ") : "（没有任何文章设置学段）",
            level: stages.length ? "ok" : "info",
            hint: stages.length ? "前台 /stage 与 /stage/:学段 使用" : "设置某项 frontmatter 的 stage 即可启用学段页",
        },
    ]
    return { section: { id: "stages", title: "学段", icon: "🎓", items }, stages, unset }
}

function checkMedia({ uploads, posts, pages, paths }) {
    const refs = collectUploadRefs([...posts, ...pages], paths.uploadsDir)
    const onDisk = new Set(uploads.map((file) => file.rel))
    // 图片/文档的元数据 sidecar 不算独立媒体，也不应被"孤儿"统计
    const isSidecar = (rel) => rel.endsWith(".metadata.json")

    const orphans = uploads.filter((file) => !isSidecar(file.rel) && !refs.has(file.rel))
    const missing = [...refs.values()].filter((ref) => !onDisk.has(ref.rel))
    const sidecars = uploads.filter((file) => isSidecar(file.rel))
    const sidecarsWithoutTarget = sidecars.filter((file) => !onDisk.has(file.rel.replace(/\.metadata\.json$/, "")))

    const items = [
        { label: "被引用的上传", value: `${refs.size} 个` },
        {
            label: "孤儿上传",
            value: `${orphans.length} 个`,
            level: orphans.length ? "warn" : "ok",
            hint: orphans.length ? "磁盘上有文件但没有任何文章引用（可能是历史遗留，删除前请自行确认）" : "",
        },
        {
            label: "引用但缺失",
            value: `${missing.length} 个`,
            level: missing.length ? "error" : "ok",
            hint: missing.length ? "文章里引用了文件，但磁盘上找不到 —— 前台会显示坏图/坏链" : "",
        },
        {
            label: "元数据 sidecar",
            value: `${sidecars.length} 个${sidecarsWithoutTarget.length ? `（其中 ${sidecarsWithoutTarget.length} 个没有对应文件）` : ""}`,
            level: sidecarsWithoutTarget.length ? "info" : "ok",
        },
    ]
    return {
        section: { id: "media", title: "上传与附件", icon: "🖼️", items },
        orphans: orphans.map((file) => ({ rel: file.rel, size: formatBytes(file.size) })),
        missing,
        sidecarsWithoutTarget: sidecarsWithoutTarget.map((file) => ({ rel: file.rel })),
    }
}

async function checkConfigFiles({ paths }) {
    const dataDir = resolve(paths.dataDir)
    const names = ["settings.json", "users.json", "sessions.json", "menu.json", "login-attempts.json", "tag-aliases.json"]
    const rows = []
    for (const name of names) {
        const result = await readJsonSafe(join(dataDir, name))
        rows.push({
            name,
            exists: result.exists,
            ok: result.ok,
            error: result.error || "",
            bytes: formatBytes(result.bytes),
        })
    }
    const broken = rows.filter((row) => row.exists && !row.ok)
    const items = [
        {
            label: "配置/数据文件",
            value: broken.length ? `${broken.length} 个无法解析` : `全部可正常解析（已存在 ${rows.filter((r) => r.exists).length} 个）`,
            level: broken.length ? "error" : "ok",
            hint: broken.length ? "损坏的 JSON 会被静默忽略，可能导致设置或登录失效，建议用备份恢复" : "",
        },
    ]
    return { section: { id: "config", title: "配置文件健康", icon: "🧩", items }, rows }
}

async function checkBackups({ paths }) {
    const dataDir = resolve(paths.dataDir)
    const contentDir = resolve(paths.contentDir || paths.dataDir)

    const aliasBackups = listTagAliasBackups()
    const mergeDir = join(contentDir, ".tag-merge-backups")
    const mergeDirs = (await readdir(mergeDir, { withFileTypes: true }).catch(() => [])).filter((e) =>
        e.isDirectory()
    )
    const webDir = join(contentDir, ".backups")
    const webBackups = (await listFiles(webDir)).filter((file) => extname(file.rel) === ".zip")

    const latest = (list) => (list.length ? String(list[list.length - 1]).slice(0, 19).replace("T", " ") : "")

    const items = [
        {
            label: "别名文件备份",
            value: aliasBackups.length ? `${aliasBackups.length} 个 · 最近 ${latest(aliasBackups)}` : "无",
            level: "info",
            hint: relative(process.cwd(), dataDir).split("\\").join("/"),
        },
        {
            label: "标签合并备份",
            value: mergeDirs.length ? `${mergeDirs.length} 次 · 最近 ${mergeDirs[mergeDirs.length - 1].name}` : "无",
            level: "info",
            hint: "content/.tag-merge-backups/（tag-merge 工具与在线合并共用）",
        },
        {
            label: "整站备份归档",
            value: webBackups.length ? `${webBackups.length} 个 zip` : "本机未生成",
            level: webBackups.length ? "ok" : "info",
            hint: "整站归档的主力仍是 CLI（异地留档需 ssh/scp）；此页可下载一份 zip 作为临时副本",
        },
    ]
    return {
        section: { id: "backups", title: "备份现状", icon: "🗄️", items },
        aliasBackups,
        mergeCount: mergeDirs.length,
        mergeLatest: mergeDirs.length ? mergeDirs[mergeDirs.length - 1].name : "",
        webBackups: webBackups.map((file) => ({ rel: file.rel, size: formatBytes(file.size) })),
    }
}

async function checkAnalytics({ paths, analyticsStore }) {
    const dir = resolve(process.env.ANALYTICS_DIR || join(paths.dataDir, "analytics"))
    const files = await listFiles(dir)
    const bytes = files.reduce((sum, file) => sum + file.size, 0)
    const views = files.filter((file) => /^views-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file.rel))
    const salt = files.find((file) => file.rel === "salt.txt")

    const items = [
        {
            label: "统计开关",
            value: analyticsStore ? "已启用" : "未启用",
            level: analyticsStore ? "ok" : "info",
            hint: analyticsStore ? "" : "设置 ANALYTICS_ENABLED=true 并重启后才会记录访问",
        },
        { label: "统计文件", value: `${files.length} 个 · ${formatBytes(bytes)}` },
        { label: "按天明细", value: views.length ? `${views.length} 天（最早 ${views[0].rel}）` : "无" },
        {
            label: "哈希盐值",
            value: salt ? "存在" : "缺失",
            level: salt ? "ok" : "warn",
            hint: salt ? "" : "缺 salt 时 UV 统计会失效（重启后会自动重建）",
        },
    ]
    return { section: { id: "analytics", title: "访问统计", icon: "📈", items } }
}

async function checkSecurity({ rootDir, port }) {
    const targets = [
        { path: "/.env", expect: 404, label: ".env" },
        { path: "/content/data/users.json", expect: 404, label: "users.json" },
        { path: "/core/app.js", expect: 404, label: "core 源码" },
        { path: "/", expect: 200, label: "首页" },
    ]
    const probes = []
    for (const target of targets) {
        const result = await probeSelf(port, target.path)
        probes.push({
            label: target.label,
            path: target.path,
            status: result.status,
            error: result.error || "",
            expect: target.expect,
            ok: result.status === target.expect,
        })
    }

    const bad = probes.filter((probe) => !probe.error && !probe.ok)
    const items = [
        {
            label: "敏感路径自检",
            value: bad.length
                ? `${bad.length} 项不符合预期`
                : probes.some((p) => p.error)
                ? "部分探测失败（不影响结论）"
                : "全部符合预期",
            level: bad.length ? "error" : "ok",
            hint: bad.length ? "被公开的路径说明静态文件守卫失效，请立即检查" : "从本机 127.0.0.1 发起的自我请求",
        },
        {
            label: "环境文件",
            value: (await stat(join(resolve(rootDir), ".env")).then(() => "存在").catch(() => "不存在")),
            level: "info",
            hint: "仅检查文件是否存在，不读取内容",
        },
    ]
    return { section: { id: "security", title: "安全自检", icon: "🔒", items }, probes }
}

// ---------------------------------------------------------------------------
// 备份归档（只读地收集文件清单；打包由调用方完成）
// ---------------------------------------------------------------------------

// 归档时排除的路径片段：缓存、历史备份、依赖
const BACKUP_SKIP = [/^content\/cache\//, /^content\/\.backups\//, /^content\/\.tag-merge-backups\//, /^node_modules\//]

/**
 * 收集「整站内容备份」应包含的文件。
 *
 * 与 CLI 备份工具的差别：CLI 会把归档拉回**本机**（异地副本），那一步需要 ssh/scp；
 * 这里只能在服务器端就地打包供浏览器下载，所以它替代不了异地留档，只作为临时副本。
 *
 * @param {{paths: Object, includeUploads?: boolean, includeAnalytics?: boolean}} options
 * @returns {Promise<{files: Array, bytes: number, skippedAnalytics: number}>}
 */
export async function collectBackupFiles({ paths, includeUploads = true, includeAnalytics = false }) {
    const dataDir = resolve(paths.dataDir)
    const uploadsDir = resolve(paths.uploadsDir)
    const rootDir = resolve(paths.rootDir)

    const dataFiles = await listFiles(dataDir)
    const uploadFiles = includeUploads ? await listFiles(uploadsDir) : []

    let skippedAnalytics = 0
    const files = []
    const push = (file, base) => {
        const rel = file.rel.split("\\").join("/")
        if (!includeAnalytics && /^analytics\/views-\d{4}-\d{2}-\d{2}\.jsonl$/.test(rel)) {
            skippedAnalytics++
            return
        }
        const zipPath = `${base}/${rel}`
        if (BACKUP_SKIP.some((pattern) => pattern.test(zipPath))) return
        files.push({ full: file.full, zipPath, size: file.size })
    }

    for (const file of dataFiles) push(file, "content/data")
    for (const file of uploadFiles) push(file, "content/uploads")

    return { files, bytes: files.reduce((sum, file) => sum + file.size, 0), skippedAnalytics, rootDir }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 生成一份完整的只读体检报告。
 *
 * @param {{paths: Object, contentManager: Object, analyticsStore?: Object, req?: Object}} options
 * @returns {Promise<Object>}
 */
export async function buildSiteReport({ paths, contentManager, analyticsStore, req }) {
    const started = Date.now()
    const port = req?.socket?.localPort || null
    const issues = []

    const instance = await checkInstance({ paths, req, contentManager })
    const content = await checkContent({ paths, contentManager })
    const fields = checkFields(content.posts, content.pages)
    const tags = checkTags(content.posts)
    const stages = checkStages(content.posts)
    const media = checkMedia({
        uploads: content.uploads,
        posts: content.posts,
        pages: content.pages,
        paths,
    })
    const config = await checkConfigFiles({ paths })
    const backups = await checkBackups({ paths })
    const analytics = await checkAnalytics({ paths, analyticsStore })
    const security = await checkSecurity({ rootDir: paths.rootDir, port })

    // 汇总提醒：只收「需要人看一眼」的项，ok 的条目不再重复
    const pushFrom = (section, extraText) => {
        for (const item of section.items) {
            if (item.level === "warn" || item.level === "error") {
                issues.push({
                    level: item.level,
                    section: section.title,
                    text: `${item.label}：${item.value}${item.hint ? `（${item.hint}）` : ""}`,
                })
            }
        }
        if (extraText) issues.push(extraText)
    }
    pushFrom(instance.section)
    pushFrom(fields.section)
    pushFrom(tags.section)
    pushFrom(media.section)
    pushFrom(config.section)
    pushFrom(analytics.section)
    pushFrom(security.section)
    for (const warning of tags.aliasWarnings) {
        issues.push({ level: warning.level, section: "标签", text: warning.text })
    }

    const sections = [
        instance.section,
        content.section,
        fields.section,
        tags.section,
        stages.section,
        media.section,
        config.section,
        backups.section,
        analytics.section,
        security.section,
    ]

    const counts = {
        error: issues.filter((issue) => issue.level === "error").length,
        warn: issues.filter((issue) => issue.level === "warn").length,
        info: issues.filter((issue) => issue.level === "info").length,
    }

    return {
        ok: counts.error === 0,
        generatedAt: formatSiteDateTime(new Date()),
        timeZone: getSiteTimeZone(),
        tookMs: Date.now() - started,
        counts,
        issues,
        sections,
        instance: {
            root: resolve(paths.rootDir),
            dataDir: resolve(paths.dataDir),
            uploadsDir: resolve(paths.uploadsDir),
            port,
            pid: process.pid,
            node: process.version,
            platform: `${process.platform} ${process.arch}`,
            uptime: formatUptime(process.uptime()),
            theme: instance.siteSettings?.activeTheme || "default",
            siteTitle: instance.siteSettings?.siteTitle || "",
        },
        details: {
            incomplete: {
                title: fields.missing.title,
                slug: fields.missing.slug,
                category: fields.missing.category.slice(0, 50),
                stage: fields.missing.stage.slice(0, 50),
                tags: fields.missing.tags.slice(0, 50),
            },
            tagHapax: tags.hapax.slice(0, 50).map((entry) => ({ name: entry.name, count: entry.count })),
            tagDuplicates: tags.duplicates.map((group) => group.map((entry) => `${entry.name}(${entry.count})`).join(" / ")),
            orphanUploads: media.orphans.slice(0, 50),
            missingUploads: media.missing.slice(0, 50).map((ref) => ({
                rel: ref.rel,
                count: ref.count,
                sourcesText: ref.sources.join("、"),
            })),
            configFiles: config.rows,
            probes: security.probes,
            webBackups: backups.webBackups,
        },
        meta: {
            tagTotal: tags.tagFrequency.length,
            hapaxTotal: tags.hapax.length,
            stageTotal: stages.stages.length,
            unsetStageTotal: stages.unset.length,
            mergeBackupCount: backups.mergeCount,
        },
    }
}
