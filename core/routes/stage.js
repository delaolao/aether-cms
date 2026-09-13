/**
 * 学段路由 — GET /stage、GET /stage/:name
 *
 * 「学段」（小学 / 初中 / 高中 …）是**单值维度**，与 `tags` 分开：
 * 混在标签里会让标签云既不像分类也不像关键词（线上实测：`小学(7)/初中(3)/高中(3)`
 * 与 `情绪管理(1)` 挤在同一命名空间）。
 *
 * 本路由复用主题的**分类页模板**（`taxonomyRoute` + `collection.html`），
 * 所以文章卡片和标签页长得一样；筛选条通过全局渲染钩子注入
 * （`res.tagWorkbenchHtml`），因此**不需要改任何主题模板**就能在所有主题上出现。
 *
 * 交叉筛选：`/stage/小学?category=心理微课[&tag=…]`
 * （镜像入口是 `/category/心理微课?stage=小学`）。
 *
 * 旧内容不受影响：没有 `stage` 字段的文章只是不出现在任何学段页里。
 */
import { prepareTemplateData, processTemplateData, handle404 } from "../utils/route-utils.js"
import { resolveTemplatePath } from "../utils/template-utils.js"
import { enhancedFormatPagination } from "../utils/pagination-utils.js"
import { normalizeStageName, compareStageNames, slugify } from "../lib/content/utils/content-utils.js"
import { resolveTagIdentifier } from "../lib/content/utils/tag-aliases.js"
import {
    buildChips,
    buildCrossFilterBarHtml,
    buildTaxonomyUrl,
    countCategories,
    ensureActiveChip,
    filterPostsByCategory,
    filterPostsByTag,
} from "../utils/taxonomy-filter-utils.js"

// litenode 不解析路由参数里的百分号编码
function decodeSegment(value) {
    if (value === undefined || value === null) return ""
    try {
        return decodeURIComponent(value)
    } catch {
        return String(value)
    }
}

/** 给卡片挂上可点击的标签 chips（主题 collection.html 会渲染 metadata.tagsView） */
function attachTagsView(posts) {
    for (const post of posts) {
        const metadata = post.metadata || post.frontmatter || {}
        const tags = Array.isArray(metadata.tags)
            ? metadata.tags
            : typeof metadata.tags === "string" && metadata.tags.trim()
            ? metadata.tags.split(",").map((t) => t.trim()).filter(Boolean)
            : []
        metadata.tagsView = tags.slice(0, 5).map((name) => ({
            name,
            href: `/tag/${encodeURIComponent(slugify(name))}`,
            count: "",
            active: false,
        }))
    }
}

/** 学段筛选条（沿用标签筛选条的样式，class 里保留 tag-filter-bar 以便复用 CSS） */
function buildStageBarHtml({ stages, active, total, categoryFilter = "", tagFilter = "" }) {
    const base = "/stage"
    const chips = buildChips({
        entries: stages,
        activeSlug: active ? active.slug : "",
        hrefFor: (stage) =>
            buildTaxonomyUrl(`${base}/${encodeURIComponent(stage.slug)}`, {
                category: categoryFilter,
                tag: tagFilter,
            }),
        // 「全部」：有分类筛选时回到该分类页（那里才是「不限学段」的自然入口）
        allHref: categoryFilter
            ? buildTaxonomyUrl(`/category/${encodeURIComponent(categoryFilter)}`, { tag: tagFilter })
            : base,
    })

    return buildCrossFilterBarHtml({
        title: "按学段浏览",
        note: `共 ${total} 篇`,
        rows: [{ label: "学段", chips }],
        clearHref: categoryFilter || tagFilter ? base : "",
        extraClass: "stage-filter-bar",
    })
}

export function setupStageRoutes(app, systems) {
    const { themeManager, contentManager, hookSystem, settingsService, analyticsStore } = systems

    const collectStages = async () => {
        const stages = await contentManager.getStageFrequency({ status: "published" })
        return stages.map((stage) => ({ ...stage, key: stage.name.toLowerCase() }))
    }

    // GET /stage — 学段总览（没有指定学段时给出全部学段入口）
    app.get("/stage", async (req, res) => {
        try {
            const stages = await collectStages()
            const siteSettings = await contentManager.getSiteSettings()
            const total = stages.reduce((sum, stage) => sum + stage.count, 0)
            const content = buildStageBarHtml({ stages, active: null, total })
            const pageData = await prepareTemplateData(req, themeManager, siteSettings, {
                content,
                metadata: { title: "按学段浏览", pageType: "normal" },
                fileType: "page",
                contentRoute: true,
                stageRoute: true,
                year: new Date().getFullYear(),
            })
            const processed = processTemplateData(hookSystem, pageData, "page.html")
            const templatePath = await resolveTemplatePath({ themeManager, contentType: "page" })
            return res.render(templatePath, processed)
        } catch (error) {
            console.error("Stage index render error:", error)
            if (res.headersSent || res.finished) return
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering stages</p>")
        }
    })

    // GET /stage/:name — 某个学段下的文章（可用 ?category= / ?tag= 交叉筛选）
    app.get("/stage/:name", async (req, res) => {
        try {
            const requested = decodeSegment(String(req.params.name || ""))
            const stages = await collectStages()
            const wanted = normalizeStageName(requested).toLowerCase()
            const active = stages.find((stage) => stage.key === wanted)
            if (!active) {
                return handle404(res, req, themeManager, settingsService)
            }

            // 交叉筛选参数：/stage/小学?category=心理微课[&tag=…]
            const rawCategory = decodeSegment(req.queryParams?.get("category") || "").trim()
            const rawTag = decodeSegment(req.queryParams?.get("tag") || "")
            const tagFilter = rawTag ? resolveTagIdentifier(rawTag) || rawTag : ""

            // 规范链接：/stage/%E5%B0%8F%E5%AD%A6 → /stage/小学（301，保留筛选与分页）
            const canonicalSlug = active.slug
            if (slugify(requested) !== canonicalSlug) {
                const query = new URLSearchParams()
                for (const key of ["page", "pageSize"]) {
                    const value = req.queryParams?.get(key)
                    if (value) query.set(key, value)
                }
                if (rawCategory) query.set("category", rawCategory)
                if (tagFilter) query.set("tag", tagFilter)
                const qs = query.toString()
                return res.redirect(`/stage/${encodeURIComponent(canonicalSlug)}${qs ? `?${qs}` : ""}`, 301)
            }

            const allPosts = await contentManager.getPostsByStage(active.name, {
                status: "published",
                summaryView: true,
                previewLength: 200,
            })

            // 分类交叉筛选（分类名大小写/空白不敏感）
            const categoryFilter = rawCategory
                ? (countCategories(allPosts).find(
                      (entry) =>
                          entry.name.toLowerCase() === rawCategory.toLowerCase() ||
                          entry.slug === slugify(rawCategory)
                  )?.name ?? rawCategory)
                : ""

            let filteredPosts = allPosts
            if (categoryFilter) filteredPosts = filterPostsByCategory(filteredPosts, categoryFilter)
            if (tagFilter) filteredPosts = filterPostsByTag(filteredPosts, tagFilter)

            const siteSettings = await contentManager.getSiteSettings()
            const page = parseInt(req.queryParams?.get("page") || "1", 10) || 1
            const perPage = parseInt(req.queryParams?.get("pageSize") || siteSettings.postsPerPage || "10", 10)
            const pagination = await app.paginateMarkdownFiles(filteredPosts, page, perPage)
            const paginatedPosts = contentManager.renameKey(pagination.data, "frontmatter", "metadata")
            attachTagsView(paginatedPosts)

            if (analyticsStore) {
                for (const post of paginatedPosts) {
                    post.metadata.viewCount = analyticsStore.viewCountFor({
                        id: post.metadata.id,
                        slug: post.metadata.slug,
                        path: `/notes/${post.metadata.slug}`,
                    })
                }
            }

            const displayTerm = categoryFilter ? `${active.name} · ${categoryFilter}` : active.name
            const stageBase = `/stage/${encodeURIComponent(canonicalSlug)}`

            const templateData = await prepareTemplateData(req, themeManager, siteSettings, {
                posts: paginatedPosts,
                fileType: "stage",
                taxonomyType: "学段",
                taxonomyTerm: displayTerm,
                taxonomyRoute: true,
                stageRoute: true,
                stageName: active.name,
                stageKey: active.key,
                stageCount: active.count,
                stageTotal: stages.reduce((sum, stage) => sum + stage.count, 0),
                // 主题的 collection.html 用它区分标题分支
                tagName: "",
                categoryName: "",
                crossFilterActive: Boolean(categoryFilter || tagFilter),
                crossFilterCategory: categoryFilter,
                crossFilterTag: tagFilter,
                crossFilterCount: filteredPosts.length,
                pagination:
                    pagination.total_pages > 0
                        ? enhancedFormatPagination(pagination, {
                              isGenerateStatic: false,
                              contentType: "stage",
                              slug: canonicalSlug,
                              cleanUrls: false,
                              // 分页时保留交叉筛选
                              extraQuery: { category: categoryFilter, tag: tagFilter },
                          })
                        : null,
                year: new Date().getFullYear(),
            })

            const templatePath = await resolveTemplatePath({
                themeManager,
                contentType: "tag",
                slug: "",
                isTaxonomy: true,
            })

            // 筛选面板（全局渲染钩子会插到文章列表上方）
            const stageEntries = ensureActiveChip(
                stages.map((stage) => ({ ...stage, slug: stage.slug, name: stage.name, count: stage.count })),
                active.name,
                { compare: compareStageNames }
            )
            const categoryEntries = ensureActiveChip(countCategories(allPosts), categoryFilter)
            const rows = [
                {
                    label: "学段",
                    chips: buildChips({
                        entries: stageEntries,
                        activeSlug: canonicalSlug,
                        hrefFor: (stage) =>
                            buildTaxonomyUrl(`/stage/${encodeURIComponent(stage.slug)}`, {
                                category: categoryFilter,
                                tag: tagFilter,
                            }),
                        allHref: categoryFilter
                            ? buildTaxonomyUrl(`/category/${encodeURIComponent(categoryFilter)}`, { tag: tagFilter })
                            : "/stage",
                    }),
                },
            ]
            // 文章都没写分类时，不渲染一行只有「全部」的空白筛选
            if (categoryEntries.length) {
                rows.push({
                    label: "分类",
                    chips: buildChips({
                        entries: categoryEntries,
                        activeSlug: categoryFilter ? slugify(categoryFilter) : "",
                        hrefFor: (entry) =>
                            buildTaxonomyUrl(stageBase, { category: entry.name, tag: tagFilter }),
                        allHref: buildTaxonomyUrl(stageBase, { tag: tagFilter }),
                    }),
                })
            }
            if (tagFilter) {
                rows.push({
                    label: "标签",
                    chips: [
                        {
                            name: `#${tagFilter}`,
                            href: buildTaxonomyUrl(stageBase, { category: categoryFilter }),
                            count: filterPostsByTag(allPosts, tagFilter).length,
                            active: true,
                        },
                    ],
                })
            }
            res.tagWorkbenchHtml = buildCrossFilterBarHtml({
                title: "筛选",
                note: `共 ${filteredPosts.length} 篇`,
                rows,
                clearHref: categoryFilter || tagFilter ? stageBase : "",
                extraClass: "stage-filter-bar",
            })

            const processed = processTemplateData(hookSystem, templateData, "tag.html")
            return res.render(templatePath, processed)
        } catch (error) {
            console.error("Stage render error:", error)
            if (res.headersSent || res.finished) return
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering stage</p>")
        }
    })
}
