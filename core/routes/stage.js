/**
 * 学段路由 — GET /stage/:name
 *
 * 「学段」（小学 / 初中 / 高中 …）是**单值维度**，与 `tags` 分开：
 * 混在标签里会让标签云既不像分类也不像关键词（线上实测：`小学(7)/初中(3)/高中(3)`
 * 与 `情绪管理(1)` 挤在同一命名空间）。
 *
 * 本路由复用主题的**分类页模板**（`taxonomyRoute` + `collection.html`），
 * 所以文章卡片和标签页长得一样；筛选条通过全局渲染钩子注入
 * （`res.tagWorkbenchHtml`），因此**不需要改任何主题模板**就能在所有主题上出现。
 *
 * 旧内容不受影响：没有 `stage` 字段的文章只是不出现在任何学段页里。
 */
import { prepareTemplateData, processTemplateData, handle404 } from "../utils/route-utils.js"
import { resolveTemplatePath } from "../utils/template-utils.js"
import { enhancedFormatPagination } from "../utils/pagination-utils.js"
import { normalizeStageName, slugify } from "../lib/content/utils/content-utils.js"

// litenode 不解析路由参数里的百分号编码
function decodeSegment(value) {
    if (value === undefined || value === null) return ""
    try {
        return decodeURIComponent(value)
    } catch {
        return String(value)
    }
}

/** 学段筛选条（沿用标签筛选条的样式，class 里保留 tag-filter-bar 以便复用 CSS） */
function buildStageBarHtml({ stages, active, total }) {
    const chips = [
        `<a class="filter-chip${active ? "" : " active"}" href="/stage">全部 ${stages.reduce((sum, s) => sum + s.count, 0)}</a>`,
        ...stages.map(
            (stage) =>
                `<a class="filter-chip${active && active.key === stage.key ? " active" : ""}" href="/stage/${encodeURIComponent(
                    stage.slug
                )}">${stage.name} <span class="chip-count">${stage.count}</span></a>`
        ),
    ].join("")

    return `<div class="tag-filter-bar stage-filter-bar">
  <div class="tag-filter-head">
    <span class="tag-filter-title">按学段浏览</span>
    <span class="tag-filter-note">共 ${total} 篇</span>
  </div>
  <div class="tag-filter-row"><span class="tag-filter-label">学段</span><div class="tag-filter-chips">${chips}</div></div>
</div>`
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

    // GET /stage/:name — 某个学段下的文章
    app.get("/stage/:name", async (req, res) => {
        try {
            const requested = decodeSegment(String(req.params.name || ""))
            const stages = await collectStages()
            const wanted = normalizeStageName(requested).toLowerCase()
            const active = stages.find((stage) => stage.key === wanted)
            if (!active) {
                return handle404(res, req, themeManager, settingsService)
            }

            // 规范链接：/stage/%E5%B0%8F%E5%AD%A6 → /stage/小学（301）
            const canonicalSlug = active.slug
            if (slugify(requested) !== canonicalSlug) {
                const page = req.queryParams?.get("page")
                return res.redirect(
                    `/stage/${encodeURIComponent(canonicalSlug)}${page ? `?page=${encodeURIComponent(page)}` : ""}`,
                    301
                )
            }

            const allPosts = await contentManager.getPostsByStage(active.name, {
                status: "published",
                summaryView: true,
                previewLength: 200,
            })

            const siteSettings = await contentManager.getSiteSettings()
            const page = parseInt(req.queryParams?.get("page") || "1", 10) || 1
            const perPage = parseInt(req.queryParams?.get("pageSize") || siteSettings.postsPerPage || "10", 10)
            const pagination = await app.paginateMarkdownFiles(allPosts, page, perPage)
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

            const templateData = await prepareTemplateData(req, themeManager, siteSettings, {
                posts: paginatedPosts,
                fileType: "stage",
                taxonomyType: "学段",
                taxonomyTerm: active.name,
                taxonomyRoute: true,
                stageRoute: true,
                stageName: active.name,
                stageKey: active.key,
                stageCount: active.count,
                stageTotal: stages.reduce((sum, stage) => sum + stage.count, 0),
                // 主题的 collection.html 用它区分标题分支
                tagName: "",
                categoryName: "",
                pagination:
                    pagination.total_pages > 0
                        ? enhancedFormatPagination(pagination, {
                              isGenerateStatic: false,
                              contentType: "stage",
                              slug: canonicalSlug,
                              cleanUrls: false,
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

            // 学段筛选条（全局渲染钩子会插到文章列表上方）
            res.tagWorkbenchHtml = buildStageBarHtml({
                stages,
                active,
                total: templateData.stageTotal,
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
