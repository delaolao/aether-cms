/**
 * Video library route — GET /videos
 *
 * Aggregates every published content item that embeds a video and renders a
 * cover grid (PeerTube thumbnail + duration + channel), with tag filtering and
 * pagination. Rendered through the ACTIVE theme's normal page flow (like
 * /tag-cloud), so it keeps the theme's header/nav/footer on every theme.
 */

import { prepareTemplateData, processTemplateData } from "../utils/route-utils.js"
import { resolveTemplatePath } from "../utils/template-utils.js"
import { extractVideoDirectives } from "../lib/content/utils/content-utils.js"
import { extractPeerTubeId, readPeerTubeMetaSync } from "../lib/media/peertube.js"
import { slugify } from "../lib/content/utils/content-utils.js"

const PER_PAGE = 24

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/**
 * Dates from the content manager are `Date` objects (frontmatter is parsed),
 * so sorting must compare timestamps — `String(date)` would compare weekday
 * names ("Wed Sep 02 …"), which is not chronological.
 */
function dateValue(value) {
    if (!value) return 0
    if (value instanceof Date) return value.getTime()
    const time = Date.parse(String(value))
    return isFinite(time) ? time : 0
}

/** Collect one entry per video, newest content first. */
async function collectVideoItems(contentManager) {
    const items = []
    let posts = []
    try {
        posts = await contentManager.getPosts({ status: "published" })
    } catch (error) {
        console.error("video library: failed to read posts:", error)
        return items
    }

    for (const post of posts) {
        const fm = post.frontmatter || {}
        const directives = extractVideoDirectives(post.content || "")
        if (directives.length === 0) continue

        const tags = Array.isArray(fm.tags)
            ? fm.tags.map((t) => String(t).trim()).filter(Boolean)
            : typeof fm.tags === "string" && fm.tags.trim()
            ? fm.tags.split(",").map((t) => t.trim()).filter(Boolean)
            : []

        for (const directive of directives) {
            const id = extractPeerTubeId(directive.url)
            const meta = id ? readPeerTubeMetaSync(id) : null
            items.push({
                postSlug: fm.slug || "",
                postTitle: fm.title || "Untitled",
                postUrl: `/notes/${fm.slug || ""}`,
                postDate: fm.publishDate || fm.createdAt || "",
                tags,
                videoId: id || "",
                title: directive.caption || meta?.title || fm.title || "视频",
                thumbnail: meta?.thumbnailUrl || "",
                duration: meta?.durationText || "",
                channel: meta?.channel || "",
                watchUrl: meta?.watchUrl || directive.url,
                isPeerTube: Boolean(id && meta),
                source: id ? "PeerTube" : /bilibili|b23\.tv/i.test(directive.url) ? "Bilibili" : "外链",
            })
        }
    }

    items.sort((a, b) => dateValue(b.postDate) - dateValue(a.postDate))
    return items
}

function buildVideoLibraryContent({ items, tags, activeTag, pagination, total }) {
    const chips = [
        `<a class="filter-chip${activeTag ? "" : " active"}" href="/videos">全部 ${total}</a>`,
        ...tags.map(
            (t) =>
                `<a class="filter-chip${activeTag === t.slug ? " active" : ""}" href="/videos?tag=${encodeURIComponent(
                    t.slug
                )}">${escapeHtml(t.name)} ${t.count}</a>`
        ),
    ].join("")

    const cards = items
        .map((item) => {
            const cover = item.thumbnail
                ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" />`
                : `<span class="video-lib-placeholder" aria-hidden="true">▶</span>`
            return `<a class="video-lib-card" href="${escapeHtml(item.postUrl)}" title="${escapeHtml(item.title)}">
  <div class="video-lib-cover">
    ${cover}
    <span class="video-lib-play" aria-hidden="true">▶</span>
    ${item.duration ? `<span class="post-cover-duration">${escapeHtml(item.duration)}</span>` : ""}
    <span class="video-lib-source">${escapeHtml(item.source)}</span>
  </div>
  <div class="video-lib-body">
    <div class="video-lib-title">${escapeHtml(item.title)}</div>
    <div class="video-lib-meta">${
        item.channel ? `<span class="video-lib-channel">${escapeHtml(item.channel)}</span>` : ""
    }<span>${escapeHtml(item.postTitle)}</span></div>
  </div>
</a>`
        })
        .join("\n")

    const pager = pagination.totalPages > 1
        ? `<div class="pagination">
    ${pagination.prevPage ? `<a class="prev-page" href="?page=${pagination.prevPage}${activeTag ? `&tag=${encodeURIComponent(activeTag)}` : ""}">&larr; 上一页</a>` : ""}
    <span class="page-info">第 ${pagination.currentPage} / ${pagination.totalPages} 页</span>
    ${pagination.nextPage ? `<a class="next-page" href="?page=${pagination.nextPage}${activeTag ? `&tag=${encodeURIComponent(activeTag)}` : ""}">下一页 &rarr;</a>` : ""}
  </div>`
        : ""

    return `<div class="video-library">
  <p class="video-lib-intro">共 ${total} 个视频${activeTag ? `（已按标签筛选）` : ""}，点击卡片进入对应文章观看。</p>
  <div class="video-lib-filters">${chips}</div>
  ${items.length ? `<div class="video-lib-grid">${cards}</div>` : `<p class="video-lib-empty">暂无视频资源。</p>`}
  ${pager}
</div>`
}

export function setupVideoLibraryRoute(app, systems) {
    const { themeManager, contentManager, hookSystem } = systems

    app.get("/videos", async (req, res) => {
        try {
            const siteSettings = await contentManager.getSiteSettings()
            const allItems = await collectVideoItems(contentManager)

            // Tag facets (only tags that actually have videos behind them)
            const tagCounts = new Map()
            for (const item of allItems) {
                for (const tag of item.tags) {
                    const key = slugify(tag)
                    const entry = tagCounts.get(key) || { name: tag, slug: key, count: 0 }
                    entry.count += 1
                    tagCounts.set(key, entry)
                }
            }
            const tags = Array.from(tagCounts.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

            const activeTag = req.queryParams?.get("tag") ? decodeURIComponent(req.queryParams.get("tag")) : ""
            const filtered = activeTag
                ? allItems.filter((item) => item.tags.some((t) => slugify(t) === activeTag))
                : allItems

            // Simple pagination over the filtered list
            const page = Math.max(1, parseInt(req.queryParams?.get("page") || "1", 10) || 1)
            const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
            const currentPage = Math.min(page, totalPages)
            const pageItems = filtered.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE)

            const content = buildVideoLibraryContent({
                items: pageItems,
                tags,
                activeTag,
                total: filtered.length,
                pagination: {
                    currentPage,
                    totalPages,
                    prevPage: currentPage > 1 ? currentPage - 1 : null,
                    nextPage: currentPage < totalPages ? currentPage + 1 : null,
                },
            })

            const pageData = await prepareTemplateData(req, themeManager, siteSettings, {
                content,
                metadata: { title: "视频库", pageType: "normal" },
                fileType: "page",
                contentRoute: true,
                videoLibraryRoute: true,
                year: new Date().getFullYear(),
            })
            const processed = processTemplateData(hookSystem, pageData, "page.html")
            const templatePath = await resolveTemplatePath({ themeManager, contentType: "page" })
            return res.render(templatePath, processed)
        } catch (error) {
            console.error("Video library render error:", error)
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering video library</p>")
        }
    })
}
