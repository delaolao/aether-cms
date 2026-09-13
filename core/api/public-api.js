/**
 * Public read-only API + oEmbed endpoint.
 *
 * Purpose: let other sites / mini-programs / aggregators consume the published
 * content, and let other platforms embed your article or video cards.
 *
 *   GET /api/public/site                       — site identity
 *   GET /api/public/posts                      — published list (filters below)
 *        ?limit=20&offset=0&tag=&category=&q=&hasVideo=1&hasAttachment=1
 *   GET /api/public/posts/:slug                — one item (+ html=1 for content)
 *   GET /oembed?url=…&format=json&maxwidth=…   — oEmbed (article + PeerTube video)
 *
 * Only PUBLISHED content is exposed; internals (file paths, raw frontmatter) are
 * stripped. CORS is open (this is public content anyway) and a light per-IP rate
 * limit protects the process. Disable everything with PUBLIC_API_ENABLED=false.
 */

import { detectMediaBadges, markdownToPlainText } from "../lib/content/utils/content-utils.js"
import { extractFileDirectives } from "../lib/media/attachments.js"
import { extractVideoDirectives, firstVideoCover } from "../lib/content/utils/content-utils.js"
import { readPeerTubeMetaSync, extractPeerTubeId, getPeerTubeConfig } from "../lib/media/peertube.js"
import { renderMarkdown, getWikilinkIndexCached } from "../lib/markdown/markdown-renderer.js"

const DEFAULT_RATE_LIMIT = 120 // requests per minute per IP
const LIST_CACHE_TTL_MS = 15_000

function envFlag(name, defaultValue) {
    const raw = process.env[name]
    if (raw === undefined || raw === "") return defaultValue
    return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
    res.statusCode = statusCode
    res.setHeader("Content-Type", "application/json; charset=utf-8")
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    res.setHeader("Access-Control-Max-Age", "600")
    for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value)
    res.end(JSON.stringify(payload))
}

function normalizeTags(tags) {
    if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean)
    if (typeof tags === "string" && tags.trim() !== "") {
        return tags.split(",").map((t) => t.trim()).filter(Boolean)
    }
    return []
}

/** Public shape of a post (no file paths, no raw frontmatter). */
function toPublicItem(post, { analyticsStore } = {}) {
    const fm = post.frontmatter || {}
    // Callers must pass RAW posts (full markdown), not summaryView output: the
    // summary view has already stripped the markdown, which would hide
    // `[video:…]` / `[file:…]` and make hasVideo/hasAttachment always false.
    const content = post.content || ""
    const cover = firstVideoCover(content)
    const attachments = extractFileDirectives(content)
    const badges = detectMediaBadges(content)
    const rawExcerpt = fm.excerpt || markdownToPlainText(content)
    const excerpt = rawExcerpt.length > 300 ? rawExcerpt.slice(0, 297).trim() + "…" : rawExcerpt

    return {
        id: fm.id,
        title: fm.title || "",
        subtitle: fm.subtitle || "",
        slug: fm.slug || "",
        url: `/notes/${fm.slug || ""}`,
        excerpt,
        category: fm.category || "",
        tags: normalizeTags(fm.tags),
        author: fm.author || "",
        publishDate: fm.publishDate || fm.createdAt || "",
        updatedAt: fm.updatedAt || "",
        views: analyticsStore ? analyticsStore.viewCountFor({ id: fm.id, slug: fm.slug }) : undefined,
        media: {
            hasVideo: badges.some((b) => b.type === "video"),
            hasCast: badges.some((b) => b.type === "cast"),
            hasAttachment: attachments.length > 0,
            attachmentCount: attachments.length,
            videoCount: extractVideoDirectives(content).length,
        },
        cover: cover
            ? {
                  thumbnailUrl: cover.thumbnailUrl,
                  durationText: cover.durationText,
                  channel: cover.channel,
                  watchUrl: cover.watchUrl,
              }
            : null,
    }
}

export function setupPublicApi(app, systems) {
    const { contentManager, analyticsStore, settingsService } = systems
    const enabled = envFlag("PUBLIC_API_ENABLED", true)
    if (!enabled) {
        console.log("[aether] public API disabled (PUBLIC_API_ENABLED=false)")
        return
    }

    const limitPerMinute = Number(process.env.PUBLIC_API_RATE_LIMIT || DEFAULT_RATE_LIMIT)
    /** @type {Map<string, {count: number, resetAt: number}>} */
    const buckets = new Map()
    /** Tiny TTL cache for the post list (avoids re-reading every .md per request) */
    const listCache = { at: 0, items: null }

    function rateLimited(req) {
        if (!limitPerMinute || limitPerMinute <= 0) return false
        const ip = String(req.headers?.["x-real-ip"] || req.socket?.remoteAddress || "unknown")
        const now = Date.now()
        const bucket = buckets.get(ip)
        if (!bucket || now > bucket.resetAt) {
            buckets.set(ip, { count: 1, resetAt: now + 60_000 })
            return false
        }
        bucket.count++
        if (buckets.size > 5000) buckets.clear()
        return bucket.count > limitPerMinute
    }

    // CORS preflight. LiteNode has no app.options(), so OPTIONS is answered by a
    // middleware; the global notFound/onError handlers are guarded against an
    // already-sent response, so answering here is safe.
    app.use(async (req, res) => {
        if (req.method !== "OPTIONS") return
        const path = String(req.url || "").split("?")[0]
        if (path !== "/oembed" && !path.startsWith("/api/public/")) return

        res.statusCode = 204
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type")
        res.setHeader("Access-Control-Max-Age", "600")
        res.end()
    })

    app.get("/api/public/site", async (req, res) => {
        try {
            const site = (await settingsService?.getSettings?.()) || {}
            sendJson(res, 200, {
                success: true,
                data: {
                    title: site.siteTitle || "",
                    description: site.siteDescription || "",
                    language: site.uiLanguage || "zh",
                    theme: site.activeTheme || "",
                },
            })
        } catch (error) {
            sendJson(res, 500, { success: false, error: error.message })
        }
    })

    app.get("/api/public/posts", async (req, res) => {
        if (rateLimited(req)) return sendJson(res, 429, { success: false, error: "Too many requests" })

        try {
            const params = req.queryParams
            const limit = Math.min(Math.max(parseInt(params?.get("limit") || "20", 10) || 20, 1), 100)
            const offset = Math.max(parseInt(params?.get("offset") || "0", 10) || 0, 0)
            const tag = (params?.get("tag") || "").trim().toLowerCase()
            const category = (params?.get("category") || "").trim().toLowerCase()
            const query = (params?.get("q") || "").trim().toLowerCase()
            const onlyVideo = /^(1|true|yes)$/i.test(params?.get("hasVideo") || "")
            const onlyAttachment = /^(1|true|yes)$/i.test(params?.get("hasAttachment") || "")

            // Raw posts (full markdown) + a small cache: the rate limiter already
            // bounds traffic, and this keeps repeated polls cheap on a small site.
            const now = Date.now()
            if (!listCache.items || now - listCache.at > LIST_CACHE_TTL_MS) {
                const rawPosts = await contentManager.getPosts({ status: "published" })
                listCache.items = rawPosts.map((post) => toPublicItem(post, { analyticsStore }))
                listCache.at = now
            }
            let items = listCache.items

            if (tag) items = items.filter((item) => item.tags.some((t) => t.toLowerCase() === tag))
            if (category) items = items.filter((item) => String(item.category).toLowerCase() === category)
            if (onlyVideo) items = items.filter((item) => item.media.hasVideo)
            if (onlyAttachment) items = items.filter((item) => item.media.hasAttachment)
            if (query) {
                items = items.filter((item) =>
                    `${item.title} ${item.subtitle} ${item.excerpt} ${item.tags.join(" ")}`
                        .toLowerCase()
                        .includes(query)
                )
            }

            const total = items.length
            const page = items.slice(offset, offset + limit)

            sendJson(res, 200, { success: true, total, limit, offset, items: page })
        } catch (error) {
            console.error("[public-api] posts error:", error)
            sendJson(res, 500, { success: false, error: "Internal error" })
        }
    })

    app.get("/api/public/posts/:slug", async (req, res) => {
        if (rateLimited(req)) return sendJson(res, 429, { success: false, error: "Too many requests" })

        try {
            let slug = req.params.slug
            try {
                slug = decodeURIComponent(slug)
            } catch {
                /* keep raw */
            }

            const post = await contentManager.getContentByProperty("post", "slug", slug)
            if (!post || post.frontmatter?.status !== "published") {
                return sendJson(res, 404, { success: false, error: "Not found" })
            }

            const item = toPublicItem(post, { analyticsStore })
            if (/^(1|true|yes)$/i.test(req.queryParams?.get("html") || "")) {
                const wikilinks = await getWikilinkIndexCached(contentManager)
                item.html = renderMarkdown(post.content, { wikilinks })
            }

            sendJson(res, 200, { success: true, data: item })
        } catch (error) {
            console.error("[public-api] post error:", error)
            sendJson(res, 500, { success: false, error: "Internal error" })
        }
    })

    // ------------------------------------------------------------------
    // oEmbed — /oembed?url=…&format=json&maxwidth=&maxheight=
    // ------------------------------------------------------------------
    app.get("/oembed", async (req, res) => {
        if (rateLimited(req)) return sendJson(res, 429, { error: "Too many requests" })

        try {
            const rawUrl = req.queryParams?.get("url") || ""
            const format = (req.queryParams?.get("format") || "json").toLowerCase()
            const maxWidth = parseInt(req.queryParams?.get("maxwidth") || "0", 10) || 0
            const maxHeight = parseInt(req.queryParams?.get("maxheight") || "0", 10) || 0

            if (!rawUrl) return sendJson(res, 400, { error: "Missing url parameter" })
            if (format !== "json") {
                return sendJson(res, 501, { error: "Only format=json is supported" })
            }

            const site = (await settingsService?.getSettings?.()) || {}
            const siteTitle = site.siteTitle || "Aether CMS"
            const base = `${
                String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() || "http"
            }://${req.headers?.host || ""}`

            let target
            try {
                target = new URL(rawUrl)
            } catch {
                return sendJson(res, 400, { error: "Invalid url" })
            }

            // ---- PeerTube (or other) video URL → type: video -----------------
            const peerTube = getPeerTubeConfig()
            const videoId = extractPeerTubeId(rawUrl)
            if (videoId && peerTube.enabled && rawUrl.includes(new URL(peerTube.base).hostname)) {
                const meta = readPeerTubeMetaSync(videoId)
                const width = maxWidth || 640
                const height = maxHeight || Math.round((width * 9) / 16)
                return sendJson(res, 200, {
                    version: "1.0",
                    type: "video",
                    provider_name: new URL(peerTube.base).hostname,
                    provider_url: peerTube.base,
                    title: meta?.title || "",
                    author_name: meta?.channel || meta?.account || "",
                    thumbnail_url: meta?.thumbnailUrl || "",
                    thumbnail_width: 480,
                    thumbnail_height: 270,
                    width,
                    height,
                    html: `<iframe width="${width}" height="${height}" src="${peerTube.base}/videos/embed/${encodeURIComponent(
                        videoId
                    )}" frameborder="0" allowfullscreen sandbox="allow-same-origin allow-scripts allow-popups"></iframe>`,
                })
            }

            // ---- Content on this CMS → type: rich ----------------------------
            const path = decodeURIComponent(target.pathname.replace(/\/+$/, ""))
            const slug = path.split("/").filter(Boolean).pop() || ""
            const isContentPath = /^\/(notes|post|page)\//.test(path) || Boolean(slug)
            if (!isContentPath) {
                return sendJson(res, 404, { error: "Unsupported url" })
            }

            const post =
                (await contentManager.getContentByProperty("post", "slug", slug)) ||
                (await contentManager.getContentByProperty("page", "slug", slug))

            if (!post || post.frontmatter?.status !== "published") {
                return sendJson(res, 404, { error: "Not found" })
            }

            const fm = post.frontmatter
            const cover = firstVideoCover(post.content || "")
            const width = maxWidth || 640
            const height = maxHeight || 360
            const pageUrl = `${base}/notes/${fm.slug}`

            return sendJson(res, 200, {
                version: "1.0",
                type: "rich",
                provider_name: siteTitle,
                provider_url: base,
                title: fm.title || "",
                author_name: fm.author || "",
                thumbnail_url: cover?.thumbnailUrl || "",
                thumbnail_width: cover?.thumbnailUrl ? 480 : undefined,
                thumbnail_height: cover?.thumbnailUrl ? 270 : undefined,
                width,
                height,
                cache_age: 600,
                html: `<iframe width="${width}" height="${height}" src="${pageUrl}" frameborder="0" loading="lazy" sandbox="allow-same-origin allow-scripts allow-popups allow-forms"></iframe>`,
            })
        } catch (error) {
            console.error("[oembed] error:", error)
            sendJson(res, 500, { error: "Internal error" })
        }
    })
}
