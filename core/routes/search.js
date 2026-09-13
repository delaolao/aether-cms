/**
 * Site search — GET /search
 *
 * A server-rendered search page (no database, no client-side index required):
 * the whole corpus is the set of published posts + pages that the content
 * manager already holds in memory, so ranking happens per request and stays
 * fast for the sizes this CMS targets (hundreds of documents).
 *
 * Query parameters
 *   q         search terms (aliases: query, s, keyword). Quoted "phrases" are
 *             kept together, CJK single characters are allowed, single latin
 *             letters are ignored.
 *   type      all | post | page
 *   tag       tag slug
 *   category  category slug
 *   sort      relevance (default) | newest | views
 *   page      1-based page number
 *   format    json → return the ranked results as JSON instead of HTML
 *
 * Behaviour worth knowing:
 *   - All terms must match (AND) for precision; when that yields nothing the
 *     search automatically relaxes to "any term" and the page says so.
 *   - Every result shows WHY it matched (title / tags / category / body count)
 *     plus a highlighted snippet around the first body hit.
 *   - Rendered through the ACTIVE theme's page flow, like /videos and
 *     /tag-cloud, so every theme gets it without template changes.
 */

import { prepareTemplateData, processTemplateData } from "../utils/route-utils.js"
import { resolveTemplatePath } from "../utils/template-utils.js"
import { markdownToPlainText, slugify, truncateExcerpt } from "../lib/content/utils/content-utils.js"

/** Results per page (SEARCH_PER_PAGE, default 12). */
const PER_PAGE = Math.max(1, Number(process.env.SEARCH_PER_PAGE || 12) || 12)
const MAX_TERMS = 6
const FACET_TAGS = 14
const FACET_CATEGORIES = 10
const SNIPPET_RADIUS = 70

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Is this term a CJK / non-latin script? (single characters are meaningful there) */
function isWideTerm(term) {
    return /[^\u0000-\u024f]/.test(term)
}

/**
 * Split a raw query into terms. `"quoted phrases"` survive as one term; the
 * remaining text is split on whitespace and punctuation.
 */
function parseQuery(raw) {
    const text = String(raw || "").trim()
    const phrases = []
    const rest = text.replace(/"([^"]{1,60})"/g, (match, phrase) => {
        const cleaned = phrase.trim()
        if (cleaned) phrases.push({ text: cleaned, phrase: true })
        return " "
    })

    const words = rest
        // Split on whitespace and punctuation, but KEEP characters that are part
        // of real terms (`c++`, `c#`, `node.js`, `gpt-4`), otherwise searching
        // for those becomes impossible.
        .split(/[\s,，。、；;：:！!？?（）()\[\]【】{}<>《》“”'’‘"|/\\~^*@$%=]+/)
        .map((word) => word.trim())
        .filter(Boolean)
        .filter((word) => (isWideTerm(word) ? word.length >= 1 : word.length >= 2))

    const terms = [...phrases]
    for (const word of words) {
        if (terms.length >= MAX_TERMS) break
        if (!terms.some((t) => t.text.toLowerCase() === word.toLowerCase())) {
            terms.push({ text: word, phrase: false })
        }
    }
    return { raw: text, terms: terms.slice(0, MAX_TERMS) }
}

function countOccurrences(haystack, needle, cap = 40) {
    if (!haystack || !needle) return 0
    const target = needle.toLowerCase()
    let from = 0
    let count = 0
    const lower = haystack.toLowerCase()
    for (;;) {
        const at = lower.indexOf(target, from)
        if (at === -1 || count >= cap) break
        count += 1
        from = at + target.length
    }
    return count
}

function normalizeTagList(tags) {
    if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean)
    if (typeof tags === "string" && tags.trim()) {
        return tags.split(",").map((t) => t.trim()).filter(Boolean)
    }
    return []
}

/**
 * Dates coming out of the content manager are `Date` objects (frontmatter is
 * parsed), so they must never be compared or printed as raw strings —
 * `String(new Date())` is "Wed Sep 02 2026 …", which sorts by weekday name.
 */
function dateValue(value) {
    if (!value) return 0
    if (value instanceof Date) return value.getTime()
    const time = Date.parse(String(value))
    return isFinite(time) ? time : 0
}

/** "YYYY-MM-DD" for display / JSON. */
function dateIso(value) {
    const time = dateValue(value)
    return time ? new Date(time).toISOString().slice(0, 10) : ""
}

/** Plain-text document used for matching, built once per request. */
function toDocument(item, type) {
    const fm = item.frontmatter || {}
    const slug = fm.slug || ""
    const text = markdownToPlainText(String(item.content || ""))
    const rawDate = fm.publishDate || fm.updatedAt || fm.createdAt || ""
    return {
        id: fm.id || slug,
        type,
        title: fm.title || "未命名",
        subtitle: fm.subtitle || "",
        slug,
        url: `/notes/${slug}`,
        date: dateIso(rawDate),
        dateTime: dateValue(rawDate),
        category: fm.category || "",
        tags: normalizeTagList(fm.tags),
        author: fm.author || "",
        excerpt: fm.excerpt ? markdownToPlainText(String(fm.excerpt)) : truncateExcerpt(text, 200),
        text,
        _title: String(fm.title || "").toLowerCase(),
        _subtitle: String(fm.subtitle || "").toLowerCase(),
        _tags: normalizeTagList(fm.tags).join(" ").toLowerCase(),
        _category: String(fm.category || "").toLowerCase(),
        _author: String(fm.author || "").toLowerCase(),
        _slug: slug.toLowerCase(),
        _text: text.toLowerCase(),
    }
}

async function collectDocuments(contentManager) {
    const docs = []
    try {
        const posts = await contentManager.getPosts({ status: "published" })
        for (const post of posts) docs.push(toDocument(post, "post"))
    } catch (error) {
        console.error("search: failed to read posts:", error)
    }
    try {
        const pages = await contentManager.getPages({ status: "published" })
        for (const page of pages) docs.push(toDocument(page, "page"))
    } catch (error) {
        console.error("search: failed to read pages:", error)
    }
    docs.sort((a, b) => b.dateTime - a.dateTime)
    return docs
}

/** Score one document; `requireAll` decides whether a partial match is usable. */
function scoreDocument(doc, query, { requireAll }) {
    const terms = query.terms
    let score = 0
    let matchedTerms = 0
    const hits = { title: 0, subtitle: 0, tags: 0, category: 0, body: 0 }
    let firstBodyIndex = -1

    const wholeQuery = query.raw.toLowerCase()
    if (wholeQuery.length > 1 && doc._title.includes(wholeQuery)) {
        // Exact title phrase: almost certainly what the visitor wants.
        score += 45
        hits.title += 1
    }

    for (const term of terms) {
        const needle = term.text.toLowerCase()
        const weight = term.phrase ? 1.6 : 1
        let termScore = 0

        if (doc._title.includes(needle)) {
            termScore += 12 * weight
            hits.title += 1
            if (doc._title.indexOf(needle) === 0) termScore += 8
        }
        if (doc._subtitle.includes(needle)) {
            termScore += 6 * weight
            hits.subtitle += 1
        }
        if (doc._tags.includes(needle)) {
            termScore += 7 * weight
            hits.tags += 1
        }
        if (doc._category.includes(needle)) {
            termScore += 5 * weight
            hits.category += 1
        }
        if (doc._slug.includes(needle)) termScore += 4
        if (doc._author.includes(needle)) termScore += 2

        const bodyHits = countOccurrences(doc.text, term.text, 10)
        if (bodyHits > 0) {
            termScore += bodyHits * 2 * weight
            hits.body += bodyHits
            if (firstBodyIndex === -1) {
                const at = doc._text.indexOf(needle)
                if (at !== -1) firstBodyIndex = at
            }
        }

        if (termScore > 0) matchedTerms += 1
        score += termScore
    }

    if (requireAll && matchedTerms !== terms.length) return null
    if (matchedTerms === 0) return null
    if (terms.length > 1 && matchedTerms === terms.length) score += 12

    return { doc, score, hits, matchedTerms, firstBodyIndex }
}

function buildSnippet(doc, firstBodyIndex, terms) {
    const text = doc.text
    if (!text) return ""
    let start = 0
    if (firstBodyIndex > 0) start = Math.max(0, firstBodyIndex - SNIPPET_RADIUS)
    let end = Math.min(text.length, start + SNIPPET_RADIUS * 2 + 120)
    // Prefer cutting at a whitespace boundary so words are not chopped in half.
    if (start > 0) {
        const space = text.indexOf(" ", start)
        if (space !== -1 && space - start < 30) start = space + 1
    }
    if (end < text.length) {
        const space = text.lastIndexOf(" ", end)
        if (space !== -1 && end - space < 30) end = space
    }
    return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "")
}

function highlight(value, terms) {
    let out = escapeHtml(value)
    for (const term of terms) {
        const pattern = new RegExp(escapeRegExp(escapeHtml(term.text)), "gi")
        out = out.replace(pattern, (match) => `<mark>${match}</mark>`)
    }
    return out
}

/** Build a /search URL that keeps the current query and overrides a few params. */
function searchUrl(params, overrides = {}) {
    const merged = { ...params, ...overrides }
    const search = new URLSearchParams()
    if (merged.q) search.set("q", merged.q)
    if (merged.type && merged.type !== "all") search.set("type", merged.type)
    if (merged.tag) search.set("tag", merged.tag)
    if (merged.category) search.set("category", merged.category)
    if (merged.sort && merged.sort !== "relevance") search.set("sort", merged.sort)
    if (merged.page && Number(merged.page) > 1) search.set("page", String(merged.page))
    const qs = search.toString()
    return qs ? `/search?${qs}` : "/search"
}

function facetChips(label, entries, params, key, activeValue) {
    if (!entries.length) return ""
    const chips = [
        `<a class="filter-chip${activeValue ? "" : " active"}" href="${escapeHtml(searchUrl(params, { [key]: "", page: 1 }))}">全部</a>`,
        ...entries.map(
            (entry) =>
                `<a class="filter-chip${activeValue === entry.slug ? " active" : ""}" href="${escapeHtml(
                    searchUrl(params, { [key]: entry.slug, page: 1 })
                )}">${escapeHtml(entry.name)} <span class="chip-count">${entry.count}</span></a>`
        ),
    ]
    return `<div class="search-facet"><span class="search-facet-label">${escapeHtml(label)}</span><div class="search-facet-chips">${chips.join("")}</div></div>`
}

function countFacet(docs, pick) {
    const map = new Map()
    for (const entry of docs) {
        for (const value of pick(entry.doc)) {
            const name = String(value || "").trim()
            if (!name) continue
            const slug = slugify(name)
            const existing = map.get(slug) || { name, slug, count: 0 }
            existing.count += 1
            map.set(slug, existing)
        }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

const TYPE_LABELS = { post: "文章", page: "页面" }

function resultItem(entry, terms) {
    const doc = entry.doc
    const hitNotes = []
    if (entry.hits.title) hitNotes.push("标题")
    if (entry.hits.tags) hitNotes.push("标签")
    if (entry.hits.category) hitNotes.push("分类")
    if (entry.hits.subtitle) hitNotes.push("副标题")
    if (entry.hits.body) hitNotes.push(`正文 ${entry.hits.body} 处`)

    const tags = doc.tags
        .slice(0, 4)
        .map((tag) => `<a class="chip-mini" href="/tag/${encodeURIComponent(slugify(tag))}">${escapeHtml(tag)}</a>`)
        .join("")

    return `<li class="search-result">
  <a class="search-result-title" href="${escapeHtml(doc.url)}">${highlight(doc.title, terms)}</a>
  <div class="search-result-meta">
    <span class="search-result-type">${escapeHtml(TYPE_LABELS[doc.type] || doc.type)}</span>
    ${doc.date ? `<time datetime="${escapeHtml(doc.date)}">${escapeHtml(doc.date)}</time>` : ""}
    ${doc.category ? `<a class="search-result-category" href="/category/${encodeURIComponent(slugify(doc.category))}">${escapeHtml(doc.category)}</a>` : ""}
    ${entry.views ? `<span class="post-views" title="阅读次数">👁 ${entry.views}</span>` : ""}
    <span class="search-result-hits">命中：${escapeHtml(hitNotes.join("、") || "正文")}</span>
  </div>
  ${entry.snippet ? `<p class="search-result-snippet">${highlight(entry.snippet, terms)}</p>` : ""}
  ${tags ? `<div class="search-result-tags">${tags}</div>` : ""}
</li>`
}

function emptyStateHtml({ docs, params, tagFacets, categoryFacets }) {
    const hotTags = tagFacets.slice(0, 12)
    const newest = docs.slice(0, 6)
    const tagCount = new Set()
    for (const doc of docs) for (const tag of doc.tags) tagCount.add(slugify(tag))

    return `<div class="search-intro">
  <p class="search-stats">全站共 <strong>${docs.length}</strong> 条已发布内容（文章 ${docs.filter((d) => d.type === "post").length} · 页面 ${docs.filter((d) => d.type === "page").length}），覆盖 <strong>${tagCount.size}</strong> 个标签。</p>
  ${
      hotTags.length
          ? `<div class="search-facet"><span class="search-facet-label">热门标签</span><div class="search-facet-chips">${hotTags
                .map(
                    (entry) =>
                        `<a class="filter-chip" href="${escapeHtml(searchUrl(params, { tag: entry.slug, page: 1 }))}">${escapeHtml(
                            entry.name
                        )} <span class="chip-count">${entry.count}</span></a>`
                )
                .join("")}</div></div>`
          : ""
  }
  ${
      categoryFacets.length
          ? `<div class="search-facet"><span class="search-facet-label">分类</span><div class="search-facet-chips">${categoryFacets
                .slice(0, 8)
                .map(
                    (entry) =>
                        `<a class="filter-chip" href="${escapeHtml(searchUrl(params, { category: entry.slug, page: 1 }))}">${escapeHtml(
                            entry.name
                        )} <span class="chip-count">${entry.count}</span></a>`
                )
                .join("")}</div></div>`
          : ""
  }
  <h3 class="search-section-title">最新内容</h3>
  <ul class="search-newest">
    ${newest
        .map(
            (doc) =>
                `<li><a href="${escapeHtml(doc.url)}">${escapeHtml(doc.title)}</a> <span class="search-result-type">${
                    TYPE_LABELS[doc.type] || doc.type
                }</span> <time>${escapeHtml(doc.date)}</time></li>`
        )
        .join("")}
  </ul>
  <div class="search-extra-links">
    <a href="/tag-cloud">标签云 →</a>
    <a href="/notes/graph">知识图谱 →</a>
    <a href="/videos">视频库 →</a>
  </div>
</div>`
}

function buildSearchPageHtml({ docs, query, results, params, facets, pagination, relaxed, tookMs, usedTag, usedCategory }) {
    const form = `<form class="search-form" role="search" action="/search" method="get" data-search-suggest>
  <input type="search" name="q" value="${escapeHtml(query.raw)}" placeholder="搜索文章、页面、标签…（支持 &quot;精确短语&quot;）" aria-label="站内搜索" autocomplete="off" />
  <button type="submit" class="search-submit">🔍 搜索</button>
  <div class="search-suggest" hidden></div>
</form>`

    // No query: show what can be searched instead of an empty list.
    if (!query.terms.length) {
        return `<div class="search-page">
  <h1 class="search-title">站内搜索</h1>
  ${form}
  ${emptyStateHtml({ docs, params, tagFacets: facets.tags, categoryFacets: facets.categories })}
</div>`
    }

    const summary = `<p class="search-summary">${
        results.total
            ? `关键词 <strong>${escapeHtml(query.terms.map((t) => t.text).join(" "))}</strong>：找到 <strong>${results.total}</strong> 条结果（${tookMs} ms）`
            : `关键词 <strong>${escapeHtml(query.terms.map((t) => t.text).join(" "))}</strong>：没有匹配内容`
    }${usedTag || usedCategory ? "（已应用筛选）" : ""}</p>`

    const relaxedNote = relaxed
        ? `<p class="search-note">未找到同时包含全部关键词的内容，已放宽为「任意关键词匹配」。</p>`
        : ""

    const typeChips = ["all", "post", "page"]
        .map((type) => {
            const count = type === "all" ? facets.typeCounts.all : facets.typeCounts[type] || 0
            if (type !== "all" && count === 0) return ""
            const label = type === "all" ? "全部类型" : TYPE_LABELS[type]
            return `<a class="filter-chip${(params.type || "all") === type ? " active" : ""}" href="${escapeHtml(
                searchUrl(params, { type, page: 1 })
            )}">${label} <span class="chip-count">${count}</span></a>`
        })
        .join("")

    const sortChips = [
        ["relevance", "相关度"],
        ["newest", "最新"],
        ["views", "阅读最多"],
    ]
        .map(
            ([value, label]) =>
                `<a class="filter-chip${(params.sort || "relevance") === value ? " active" : ""}" href="${escapeHtml(
                    searchUrl(params, { sort: value, page: 1 })
                )}">${label}</a>`
        )
        .join("")

    const pager = pagination.totalPages > 1
        ? `<div class="pagination">
    ${pagination.prevPage ? `<a class="prev-page" href="${escapeHtml(searchUrl(params, { page: pagination.prevPage }))}">&larr; 上一页</a>` : ""}
    <span class="page-info">第 ${pagination.currentPage} / ${pagination.totalPages} 页</span>
    ${pagination.nextPage ? `<a class="next-page" href="${escapeHtml(searchUrl(params, { page: pagination.nextPage }))}">下一页 &rarr;</a>` : ""}
  </div>`
        : ""

    const body = results.items.length
        ? `<ol class="search-results">${results.items.map((entry) => resultItem(entry, query.terms)).join("\n")}</ol>${pager}`
        : `<div class="search-empty">
  <p>没有找到与 <strong>${escapeHtml(query.terms.map((t) => t.text).join(" "))}</strong> 匹配的内容。</p>
  <ul class="search-empty-tips">
    <li>试试更短的关键词，或去掉筛选条件</li>
    <li>用 <code>"引号"</code> 可以精确匹配短语</li>
    <li>也可以直接浏览下面的标签</li>
  </ul>
  <div class="search-facet"><span class="search-facet-label">热门标签</span><div class="search-facet-chips">${facets.tags
      .slice(0, 12)
      .map(
          (entry) =>
              `<a class="filter-chip" href="${escapeHtml(searchUrl({ q: "" }, { tag: entry.slug }))}">${escapeHtml(
                  entry.name
              )} <span class="chip-count">${entry.count}</span></a>`
      )
      .join("")}</div></div>
</div>`

    const facetsHtml = `<div class="search-facets">
    <div class="search-facet"><span class="search-facet-label">类型</span><div class="search-facet-chips">${typeChips}</div></div>
    <div class="search-facet"><span class="search-facet-label">排序</span><div class="search-facet-chips">${sortChips}</div></div>
    ${facetChips("标签", facets.tags.slice(0, FACET_TAGS), params, "tag", params.tag)}
    ${facetChips("分类", facets.categories.slice(0, FACET_CATEGORIES), params, "category", params.category)}
  </div>`

    return `<div class="search-page">
  <h1 class="search-title">站内搜索</h1>
  ${form}
  ${summary}
  ${relaxedNote}
  ${facetsHtml}
  ${body}
</div>`
}

export function setupSearchRoute(app, systems) {
    const { themeManager, contentManager, hookSystem, analyticsStore } = systems

    app.get("/search", async (req, res) => {
        const started = Date.now()
        try {
            const getParam = (name) => (req.queryParams?.get(name) ? String(req.queryParams.get(name)) : "")
            const rawQuery = getParam("q") || getParam("query") || getParam("s") || getParam("keyword")
            const query = parseQuery(rawQuery)

            const params = {
                q: query.raw,
                type: ["post", "page"].includes(getParam("type")) ? getParam("type") : "all",
                tag: getParam("tag"),
                category: getParam("category"),
                sort: ["newest", "views"].includes(getParam("sort")) ? getParam("sort") : "relevance",
                page: Math.max(1, parseInt(getParam("page") || "1", 10) || 1),
            }

            const [docs, siteSettings] = await Promise.all([
                collectDocuments(contentManager),
                contentManager.getSiteSettings(),
            ])

            // Facet pools: everything (empty state) or the matching set (results).
            let entries = []
            let relaxed = false
            if (query.terms.length) {
                entries = docs.map((doc) => scoreDocument(doc, query, { requireAll: true })).filter(Boolean)
                if (!entries.length) {
                    relaxed = true
                    entries = docs.map((doc) => scoreDocument(doc, query, { requireAll: false })).filter(Boolean)
                }
                entries.forEach((entry) => {
                    entry.views = analyticsStore ? analyticsStore.viewCountFor({ path: entry.doc.url }) || 0 : 0
                })
            }

            const facetSource = query.terms.length ? entries : docs.map((doc) => ({ doc }))
            const facets = {
                tags: countFacet(facetSource, (doc) => doc.tags),
                categories: countFacet(facetSource, (doc) => (doc.category ? [doc.category] : [])),
                typeCounts: {
                    all: facetSource.length,
                    post: facetSource.filter((entry) => entry.doc.type === "post").length,
                    page: facetSource.filter((entry) => entry.doc.type === "page").length,
                },
            }

            // Apply the chips
            let filtered = entries
            if (params.type !== "all") filtered = filtered.filter((entry) => entry.doc.type === params.type)
            if (params.tag) filtered = filtered.filter((entry) => entry.doc.tags.some((tag) => slugify(tag) === params.tag))
            if (params.category) filtered = filtered.filter((entry) => slugify(entry.doc.category) === params.category)

            const sorted = [...filtered]
            if (params.sort === "relevance") {
                sorted.sort((a, b) => b.score - a.score || b.doc.dateTime - a.doc.dateTime)
            } else if (params.sort === "newest") {
                sorted.sort((a, b) => b.doc.dateTime - a.doc.dateTime)
            } else {
                sorted.sort((a, b) => (b.views || 0) - (a.views || 0) || b.doc.dateTime - a.doc.dateTime)
            }

            const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE))
            const currentPage = Math.min(params.page, totalPages)
            const pageEntries = sorted.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE).map((entry) => ({
                ...entry,
                snippet: buildSnippet(entry.doc, entry.firstBodyIndex, query.terms),
            }))

            const tookMs = Math.max(1, Date.now() - started)

            if (getParam("format") === "json") {
                res.statusCode = 200
                res.setHeader("Content-Type", "application/json; charset=utf-8")
                return res.end(
                    JSON.stringify({
                        query: query.raw,
                        terms: query.terms.map((t) => t.text),
                        relaxed,
                        sort: params.sort,
                        tookMs,
                        total: sorted.length,
                        page: currentPage,
                        perPage: PER_PAGE,
                        totalPages,
                        facets: { tags: facets.tags, categories: facets.categories, types: facets.typeCounts },
                        results: pageEntries.map((entry) => ({
                            title: entry.doc.title,
                            url: entry.doc.url,
                            type: entry.doc.type,
                            date: entry.doc.date,
                            category: entry.doc.category,
                            tags: entry.doc.tags,
                            views: entry.views || 0,
                            score: Math.round(entry.score * 10) / 10,
                            hits: entry.hits,
                            snippet: entry.snippet,
                        })),
                    })
                )
            }

            const content = buildSearchPageHtml({
                docs,
                query,
                results: { items: pageEntries, total: sorted.length },
                params,
                facets,
                pagination: {
                    currentPage,
                    totalPages,
                    prevPage: currentPage > 1 ? currentPage - 1 : null,
                    nextPage: currentPage < totalPages ? currentPage + 1 : null,
                },
                relaxed,
                tookMs,
                usedTag: params.tag,
                usedCategory: params.category,
            })

            const title = query.terms.length ? `搜索：${query.terms.map((t) => t.text).join(" ")}` : "站内搜索"
            const pageData = await prepareTemplateData(req, themeManager, siteSettings, {
                content,
                // "normal" is what themes treat as a plain content page (same as
                // /videos and /tag-cloud); any other value makes the default
                // theme fall into its blog-listing branch, which needs `posts`.
                metadata: { title, pageType: "normal" },
                fileType: "page",
                contentRoute: true,
                searchRoute: true,
                searchQuery: query.raw,
                searchTotal: sorted.length,
                year: new Date().getFullYear(),
            })
            const processed = processTemplateData(hookSystem, pageData, "page.html")
            const templatePath = await resolveTemplatePath({ themeManager, contentType: "page" })
            return res.render(templatePath, processed)
        } catch (error) {
            console.error("Search render error:", error)
            if (res.headersSent || res.finished) return
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering search</p>")
        }
    })
}
