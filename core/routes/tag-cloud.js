/**
 * Tag cloud route.
 *
 *   GET /tag-cloud  → renders a "标签词云" (tag word cloud) page
 *
 * The cloud data is computed from all published posts (tag frequency) and
 * embedded as JSON in the page; the theme-agnostic /assets/tag-cloud.js reads it
 * and renders a word cloud where each tag links to /tag/:slug (its article
 * list). It is rendered through the ACTIVE theme's normal page flow, so the
 * page keeps the theme's header/nav/footer on every theme — exactly like the
 * knowledge-graph fallback in /notes/graph.
 */
import { getTagFrequency } from "../utils/tag-cloud-utils.js"
import { prepareTemplateData, processTemplateData } from "../utils/route-utils.js"
import { resolveTemplatePath } from "../utils/template-utils.js"

/**
 * Page body (intro line + word-cloud container + embedded JSON + script).
 * @param {Array} tags - [{ name, slug, count }]
 * @param {string} json - Pre-escaped JSON payload
 * @returns {string} HTML fragment
 */
function buildTagCloudContent(tags, json) {
    const has = Array.isArray(tags) && tags.length > 0
    const body = has
        ? '<div class="tag-cloud" id="tag-cloud"></div>'
        : '<p class="tag-cloud-empty">暂无标签</p>'

    return `<div class="tag-cloud-page">
  <p style="color:#777;margin:0 0 1rem;">共 ${has ? tags.length : 0} 个标签，点击标签查看相关文章</p>
  ${body}
  <script type="application/json" id="tag-cloud-data">${json}</script>
  <script src="/assets/tag-cloud.js"></script>
</div>`
}

export function setupTagCloudRoute(app, systems) {
    const { themeManager, contentManager, hookSystem } = systems

    app.get("/tag-cloud", async (req, res) => {
        try {
            const siteSettings = await contentManager.getSiteSettings()
            const tags = await getTagFrequency(contentManager)

            // JSON is embedded raw; escape "</script" sequences for safety.
            const json = JSON.stringify(tags).replace(/</g, "\\u003c")
            const content = buildTagCloudContent(tags, json)

            const pageData = await prepareTemplateData(req, themeManager, siteSettings, {
                content,
                metadata: { title: "标签云", pageType: "normal" },
                fileType: "page",
                contentRoute: true,
                tagCloudRoute: true,
                year: new Date().getFullYear(),
            })
            const processedPage = processTemplateData(hookSystem, pageData, "page.html")
            const pageTemplate = await resolveTemplatePath({
                themeManager,
                contentType: "page",
            })
            return res.render(pageTemplate, processedPage)
        } catch (error) {
            console.error("Tag cloud render error:", error)
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering tag cloud</p>")
        }
    })
}
