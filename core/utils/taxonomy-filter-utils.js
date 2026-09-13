/**
 * 维度交叉筛选（分类 × 学段 × 标签）
 *
 * 需求：`/category/心理微课` 与 `/stage/小学` 各自只能看一个维度，
 * 而「列出心理微课分类里所有小学学段的文章」这类问题没有 URL 可以表达。
 *
 * 约定（两页互为镜像，参数名即维度名）：
 *
 *   /category/心理微课?stage=小学
 *   /stage/小学?category=心理微课
 *   /category/心理微课?stage=小学&tag=情绪管理
 *   /stage/小学?category=心理微课&tag=情绪管理
 *
 * 为什么用查询参数而不是路径段：`?stage=` 可以被同一个页面反复覆盖/清除，
 * 分页链接也只需带上同一串参数；用路径段（`/category/x/stage/y`）会让
 * 「只去掉学段」这种情况没有自然的 URL，而且会和「主题自定义分类模板」的
 * 路径匹配打架。
 *
 * 本模块只做纯数据处理与 HTML 片段生成，路由负责取参数、渲染。
 */
import {
    normalizeStageName,
    normalizeTagName,
    compareStageNames,
    slugify,
} from "../lib/content/utils/content-utils.js"

/** litenode 不解析路由参数里的百分号编码 */
export function decodeSegment(value) {
    if (value === undefined || value === null) return ""
    try {
        return decodeURIComponent(value)
    } catch {
        return String(value)
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
}

/** 文章对象在路由里可能是 { frontmatter } 或 { metadata } */
export function frontmatterOf(post) {
    return post?.metadata || post?.frontmatter || {}
}

/** 文章的学段（已归一化，"" 表示未设置） */
export function postStageOf(post) {
    return normalizeStageName(frontmatterOf(post).stage)
}

/** 文章的分类（原样，仅去空白） */
export function postCategoryOf(post) {
    return String(frontmatterOf(post).category || "").trim()
}

/** 文章的标签数组（兼容逗号分隔的字符串写法） */
export function postTagsOf(post) {
    const raw = frontmatterOf(post).tags
    if (Array.isArray(raw)) return raw.map((tag) => normalizeTagName(tag)).filter(Boolean)
    if (typeof raw === "string") {
        return raw
            .split(",")
            .map((tag) => normalizeTagName(tag))
            .filter(Boolean)
    }
    return []
}

// --- 过滤 -----------------------------------------------------------------

function sameName(a, b) {
    return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase()
}

export function filterPostsByStage(posts, stage) {
    const wanted = normalizeStageName(stage)
    if (!wanted) return posts
    return posts.filter((post) => sameName(postStageOf(post), wanted))
}

export function filterPostsByCategory(posts, category) {
    const wanted = String(category || "").trim()
    if (!wanted) return posts
    return posts.filter((post) => sameName(postCategoryOf(post), wanted))
}

/**
 * 标签过滤：`resolvedName` 由调用方先用别名表解析（`resolveTagIdentifier`），
 * 这样 `?tag=cpu` 也能命中 `中央处理器`。
 */
export function filterPostsByTag(posts, resolvedName) {
    const wanted = normalizeTagName(resolvedName)
    if (!wanted) return posts
    return posts.filter((post) => postTagsOf(post).some((tag) => sameName(tag, wanted)))
}

// --- 计数 -----------------------------------------------------------------

/**
 * 统计某个维度在给定文章集里的取值分布。
 *
 * @param {Array} posts
 * @param {(post: any) => string} pick
 * @param {{compare?: (a: string, b: string) => number}} [options] 传 compare 时按该顺序排（学段），否则按篇数倒序
 * @returns {Array<{name: string, slug: string, count: number}>}
 */
export function countDimension(posts, pick, options = {}) {
    const { compare } = options
    const map = new Map()
    for (const post of posts) {
        const name = String(pick(post) || "").trim()
        if (!name) continue
        const key = slugify(name) || name.toLowerCase()
        const existing = map.get(key) || { name, slug: slugify(name) || name, count: 0 }
        existing.count += 1
        map.set(key, existing)
    }
    const list = Array.from(map.values())
    if (typeof compare === "function") {
        list.sort((a, b) => compare(a.name, b.name) || b.count - a.count)
    } else {
        list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"))
    }
    return list
}

/** 学段分布（按教育阶段顺序排列） */
export function countStages(posts) {
    return countDimension(posts, postStageOf, { compare: compareStageNames })
}

/** 分类分布（按篇数倒序） */
export function countCategories(posts) {
    return countDimension(posts, postCategoryOf)
}

/**
 * 让「当前筛选值」一定出现在 chips 里（哪怕本页结果为 0 篇）：
 * 例如 `/category/心理微课?stage=小学` 而该分类下没有小学内容时，
 * `小学` 仍要显示为选中态，用户才能看到「原来是空的」而不是「筛选没生效」。
 */
export function ensureActiveChip(entries, name, options = {}) {
    const wanted = String(name || "").trim()
    if (!wanted) return entries
    const slug = slugify(wanted) || wanted
    if (entries.some((entry) => entry.slug === slug)) return entries
    const list = [...entries, { name: wanted, slug, count: 0 }]
    if (typeof options.compare === "function") list.sort((a, b) => options.compare(a.name, b.name))
    return list
}

// --- URL / HTML -----------------------------------------------------------

/**
 * 在基础路径上拼查询参数（空值自动忽略，中文自动百分号编码）。
 * @param {string} basePath 已编码好的路径，如 `/category/${encodeURIComponent(slug)}`
 * @param {Object} params
 */
export function buildTaxonomyUrl(basePath, params = {}) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        const text = String(value ?? "").trim()
        if (text) search.set(key, text)
    }
    const qs = search.toString()
    return qs ? `${basePath}?${qs}` : basePath
}

/**
 * 生成一行 chips：`全部` + 各取值。
 * @param {{entries: Array, activeSlug?: string, hrefFor: (entry: any) => string, allHref?: string}} options
 */
export function buildChips({ entries, activeSlug = "", hrefFor, allHref }) {
    const chips = []
    if (allHref) {
        chips.push({ name: "全部", href: allHref, count: "", active: !activeSlug })
    }
    for (const entry of entries) {
        chips.push({
            name: entry.name,
            href: hrefFor(entry),
            count: entry.count,
            active: Boolean(activeSlug) && activeSlug === entry.slug,
        })
    }
    return chips
}

/**
 * 交叉筛选面板。沿用标签工作台的样式类（tag-filter-bar / filter-chip），
 * 通过全局渲染钩子 `res.tagWorkbenchHtml` 注入，因此不需要改任何主题模板。
 *
 * @param {{title?: string, note?: string, rows: Array<{label: string, chips: Array}>, clearHref?: string, clearLabel?: string}} options
 */
export function buildCrossFilterBarHtml({
    title = "",
    note = "",
    rows = [],
    clearHref = "",
    clearLabel = "清除筛选",
    extraClass = "",
}) {
    const body = rows
        .filter((row) => row && Array.isArray(row.chips) && row.chips.length)
        .map((row) => {
            const chips = row.chips
                .map((chip) => {
                    const count =
                        chip.count === "" || chip.count === undefined || chip.count === null
                            ? ""
                            : ` <span class="chip-count">${escapeHtml(chip.count)}</span>`
                    return `<a class="filter-chip${chip.active ? " active" : ""}" href="${escapeHtml(chip.href)}">${escapeHtml(
                        chip.name
                    )}${count}</a>`
                })
                .join("")
            return `<div class="tag-filter-row"><span class="tag-filter-label">${escapeHtml(
                row.label
            )}</span><div class="tag-filter-chips">${chips}</div></div>`
        })
        .join("\n  ")

    if (!body) return ""

    const head = `<div class="tag-filter-head"><span class="tag-filter-title">${escapeHtml(title)}</span>${
        note ? `<span class="tag-filter-note">${escapeHtml(note)}</span>` : ""
    }${clearHref ? `<a class="tag-filter-clear" href="${escapeHtml(clearHref)}">${escapeHtml(clearLabel)}</a>` : ""}</div>`

    return `<div class="tag-filter-bar cross-filter-bar${extraClass ? ` ${extraClass}` : ""}">
  ${head}
  ${body}
</div>`
}
