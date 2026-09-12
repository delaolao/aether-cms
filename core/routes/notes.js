/**
 * Notes routes — unified knowledge-base path.
 *
 *   GET /notes/graph  → interactive knowledge graph of all published content
 *   GET /notes/:slug  → unified route for any published post / page
 *
 * [[wikilinks]], backlinks and graph nodes point at these /notes/* URLs, so
 * all published content lives under one route path (Obsidian-style).
 */

import { renderMarkdown, getWikilinkIndexCached } from "../lib/markdown/markdown-renderer.js"
import { getBacklinks, getWikiRelated, getGraphPayload } from "../lib/markdown/wiki-relations.js"
import { prepareTemplateData, processTemplateData, handle404 } from "../utils/route-utils.js"
import { resolveTemplatePath } from "../utils/template-utils.js"

/**
 * Graph page body (toolbar + canvas + runtime scripts). Rendered inside the
 * ACTIVE theme's layout via the normal "page" flow, so /notes/graph keeps the
 * theme's header/nav/footer on every theme.
 * @param {Object} payload - { nodes, edges, stats }
 * @param {string} graphJson - Pre-escaped JSON payload
 * @returns {string} HTML fragment
 */
function buildGraphContent(payload, graphJson) {
    const stats = payload.stats || { nodes: 0, edges: 0 }
    const nodeOptions = ["", "post", "page"]
        .map((v) => {
            const label = v === "" ? "全部类型" : v === "post" ? "文章" : "页面"
            return `<option value="${v}">${label}</option>`
        })
        .join("")

    const viewsText = stats.totalViews ? `、${stats.totalViews} 次阅读` : ""

    return `<div class="graph-page" style="margin-top:1rem;">
  <p style="color:#777;margin:0 0 1rem;">共 ${stats.nodes} 个节点、${stats.edges} 条链接${viewsText}</p>
  <div class="graph-toolbar">
    <input type="text" id="graph-search" class="graph-search" placeholder="搜索节点标题…" autocomplete="off" />
    <select id="graph-type-filter" class="graph-type">${nodeOptions}</select>
    <select id="graph-views-filter" class="graph-type">
      <option value="">全部阅读量</option>
      <option value="top5">阅读 Top 5</option>
      <option value="top10">阅读 Top 10</option>
      <option value="top20">阅读 Top 20</option>
      <option value="read">有阅读</option>
      <option value="unread">未被阅读</option>
    </select>
    <button type="button" id="graph-reset">重置视图</button>
    <span class="graph-hint">拖拽节点 · 空白拖拽平移(边界停住) · 滚轮缩放 · 双击复位 · 点击节点打开</span>
  </div>
  <canvas id="knowledge-graph" width="1100" height="620"></canvas>
  <script type="application/json" id="graph-data">${graphJson}</script>
  <script src="/assets/knowledge-graph.js"></script>
</div>`
}

export function setupNotesRoutes(app, systems) {
    const { themeManager, contentManager, hookSystem, settingsService, analyticsStore, visitTracker } = systems

    // ------------------------------------------------------------------
    // GET /notes/graph — knowledge graph page
    // ------------------------------------------------------------------
    app.get("/notes/graph", async (req, res) => {
        try {
            const siteSettings = await contentManager.getSiteSettings()
            // Pass the analytics store so graph nodes carry their view counts.
            const payload = await getGraphPayload(contentManager, { analyticsStore })

            // JSON is embedded raw; escape "</script" sequences for safety.
            const graphJson = JSON.stringify(payload).replace(/</g, "\\u003c")

            const layoutPath = themeManager.getTemplatePath("layout.html")
            const templatePath = await resolveTemplatePath({
                themeManager,
                contentType: "custom",
                slug: "notes-graph",
                isCustomPage: true,
            })

            // If the active theme supplies a dedicated graph template (the
            // bundled default theme does), render it inside the theme shell.
            if (templatePath && templatePath !== layoutPath) {
                const templateData = await prepareTemplateData(req, themeManager, siteSettings, {
                    html_graphJson: graphJson,
                    graphStats: payload.stats,
                    graphRoute: true,
                    notesRoute: true,
                    metadata: { title: "Knowledge Graph" },
                    year: new Date().getFullYear(),
                })
                const processedData = processTemplateData(hookSystem, templateData, "notes-graph.html")
                return res.render(templatePath, processedData)
            }

            // Otherwise render the graph as a normal page inside the ACTIVE
            // theme's layout (header/nav/footer preserved on any theme).
            const graphContent = buildGraphContent(payload, graphJson)
            const pageData = await prepareTemplateData(req, themeManager, siteSettings, {
                content: graphContent,
                metadata: { title: "知识图谱", pageType: "normal" },
                fileType: "page",
                contentRoute: true,
                graphRoute: true,
                year: new Date().getFullYear(),
            })
            const processedPage = processTemplateData(hookSystem, pageData, "page.html")
            const pageTemplate = await resolveTemplatePath({
                themeManager,
                contentType: "page",
            })
            return res.render(pageTemplate, processedPage)
        } catch (error) {
            console.error("Knowledge graph render error:", error)
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering knowledge graph</p>")
        }
    })

    // ------------------------------------------------------------------
    // GET /notes/:slug — unified content route (post or page)
    // ------------------------------------------------------------------
    app.get("/notes/:slug", async (req, res) => {
        let slug = req.params.slug
        try {
            slug = decodeURIComponent(slug)
        } catch {
            // keep raw if malformed
        }

        try {
            // 1) Try posts first (with navigation + manual related posts)
            const post = await contentManager.getContentByProperty("post", "slug", slug, {
                addNavigation: true,
                resolveRelatedPosts: true,
            })

            if (post && post.frontmatter.status === "published") {
                const siteSettings = await contentManager.getSiteSettings()
                const wikilinks = await getWikilinkIndexCached(contentManager)
                const [backlinks, wikiRelated] = await Promise.all([
                    getBacklinks(contentManager, post.frontmatter.id),
                    getWikiRelated(contentManager, post.frontmatter.id, post.relatedPostsData),
                ])

                // Analytics: tag the page so the visit is attributed to this post,
                // and expose its view count to the template.
                visitTracker?.markContent(res, {
                    id: post.frontmatter.id,
                    slug: post.frontmatter.slug,
                    type: "post",
                    title: post.frontmatter.title,
                })

                let templateData = await prepareTemplateData(req, themeManager, siteSettings, {
                    content: renderMarkdown(post.content, { wikilinks }),
                    metadata: post.frontmatter,
                    backlinks,
                    wikiRelated,
                    hasWikiLinks: backlinks.length > 0 || wikiRelated.length > 0,
                    fileType: "post",
                    contentRoute: true,
                    contentId: post.frontmatter.id,
                    viewCount: analyticsStore
                        ? analyticsStore.viewCountFor({
                              id: post.frontmatter.id,
                              slug: post.frontmatter.slug,
                              path: `/notes/${post.frontmatter.slug}`,
                          })
                        : 0,
                    prevPost: post.prevPost || null,
                    nextPost: post.nextPost || null,
                    year: new Date().getFullYear(),
                })

                const processedData = processTemplateData(hookSystem, templateData, "post.html")
                const templatePath = await resolveTemplatePath({
                    themeManager,
                    contentType: "post",
                })
                return res.render(templatePath, processedData)
            }

            // 2) Then pages (normal + custom)
            const page = await contentManager.getContentByProperty("page", "slug", slug)

            if (page && page.frontmatter.status === "published") {
                const isCustomPage = page.frontmatter.pageType === "custom"
                const siteSettings = await contentManager.getSiteSettings()
                const wikilinks = await getWikilinkIndexCached(contentManager)
                const [backlinks, wikiRelated] = await Promise.all([
                    getBacklinks(contentManager, page.frontmatter.id),
                    getWikiRelated(contentManager, page.frontmatter.id, page.relatedPostsData),
                ])

                visitTracker?.markContent(res, {
                    id: page.frontmatter.id,
                    slug: page.frontmatter.slug,
                    type: "page",
                    title: page.frontmatter.title,
                })

                let templateData = await prepareTemplateData(req, themeManager, siteSettings, {
                    content: renderMarkdown(page.content, { wikilinks }),
                    metadata: page.frontmatter,
                    backlinks,
                    wikiRelated,
                    hasWikiLinks: backlinks.length > 0 || wikiRelated.length > 0,
                    fileType: "page",
                    contentRoute: true,
                    contentId: page.frontmatter.id,
                    isCustomPage,
                    viewCount: analyticsStore
                        ? analyticsStore.viewCountFor({
                              id: page.frontmatter.id,
                              slug: page.frontmatter.slug,
                              path: `/notes/${page.frontmatter.slug}`,
                          })
                        : 0,
                    year: new Date().getFullYear(),
                })

                const processedData = processTemplateData(
                    hookSystem,
                    templateData,
                    isCustomPage ? `${slug}.html` : "page.html"
                )

                const templatePath = await resolveTemplatePath({
                    themeManager,
                    contentType: "page",
                    slug,
                    isCustomPage,
                })

                return res.render(templatePath, processedData)
            }

            return handle404(res, req, themeManager, settingsService)
        } catch (error) {
            console.error(`Notes render error for ${slug}:`, error)
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering note</p>")
        }
    })
}
