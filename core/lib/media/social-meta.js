/**
 * Social / SEO meta tags — OpenGraph, Twitter Card and JSON-LD structured data,
 * injected into <head> by the global render hook (core/app.js) so they work on
 * EVERY theme without per-theme template edits.
 *
 * Video pages additionally get a `VideoObject` entry (name, description,
 * thumbnailUrl, uploadDate, duration, embedUrl) which is what search engines
 * require to treat the page as a video page.
 */

function escapeAttr(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

/** Strip tags/entities from rendered HTML to build a plain-text description. */
function htmlToText(html, limit = 200) {
    const text = String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        // Video facades carry UI copy ("▶ 37:59 … 在原站打开 ↗") — drop the whole
        // block so descriptions read as prose.
        .replace(/<figure[^>]*class="[^"]*video-[^"]*"[\s\S]*?<\/figure>/gi, " ")
        .replace(/<figcaption[\s\S]*?<\/figcaption>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[▶►▪•]/g, " ")
        .replace(/(^|\s)#([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5.-]*)/g, "$1$2") // #标签 → 标签
        .replace(/\s+/g, " ")
        .trim()
    return text.length > limit ? text.slice(0, limit - 1).trim() + "…" : text
}

/** Canonical absolute URL for the current request (decoded path, no query). */
export function canonicalUrl(req) {
    let path = String(req?.url || "/").split("?")[0]
    try {
        path = decodeURIComponent(path)
    } catch {
        /* keep raw */
    }
    const host = String(req?.headers?.host || "").trim()
    const proto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim() || "http"
    return host ? `${proto}://${host}${path}` : path
}

/** Feature image can be a string path or an object with a `url` field. */
function featuredImageUrl(metadata) {
    const featured = metadata?.featuredImage
    if (!featured) return ""
    const raw = typeof featured === "string" ? featured : featured.url || ""
    if (!raw) return ""
    if (/^https?:\/\//i.test(raw)) return raw
    return `/content/uploads${raw.startsWith("/") ? "" : "/"}${raw}`
}

/** Collect video facades from the rendered HTML (data attributes set by the renderer). */
export function extractVideosFromHtml(html) {
    const videos = []
    const figureRe = /<figure class="video-embed video-facade[^"]*"([^>]*)>/g
    let match
    while ((match = figureRe.exec(String(html || ""))) !== null) {
        const attrs = match[1]
        const pick = (name) => {
            const m = attrs.match(new RegExp(`${name}="([^"]*)"`))
            return m ? m[1].replace(/&amp;/g, "&") : ""
        }
        const embedUrl = pick("data-embed")
        if (!embedUrl) continue
        const durationSeconds = Number(pick("data-duration") || 0)
        videos.push({
            embedUrl,
            thumbnailUrl: pick("data-poster"),
            title: pick("data-title"),
            durationSeconds,
            watchUrl: pick("data-watch"),
        })
    }
    return videos
}

function isoDuration(seconds) {
    const total = Math.floor(Number(seconds) || 0)
    if (total <= 0) return undefined
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return `PT${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${s > 0 || (h === 0 && m === 0) ? `${s}S` : ""}`
}

/**
 * Build the <meta> / <script type="application/ld+json"> block for a page.
 *
 * @param {Object} params
 * @param {Object} params.data - Template data passed to res.render
 * @param {Object} params.req - Request (for canonical URL)
 * @param {string} params.html - Rendered page HTML (videos are parsed from it)
 * @param {Object} [params.siteSettings] - Site settings (title fallback)
 * @returns {string} HTML fragment to inject into <head>
 */
export function buildSocialMeta({ data = {}, req = null, html = "", siteSettings = null } = {}) {
    const metadata = data.metadata || {}
    const site = data.site || siteSettings || {}

    // Canonical URL
    const canonical = canonicalUrl(req)

    const isHome = String(req?.url || "/").split("?")[0] === "/" || data.homeRoute === true
    const siteTitle = site.siteTitle || "Aether CMS"
    const title = isHome ? siteTitle : metadata.title ? `${metadata.title} | ${siteTitle}` : siteTitle

    const videos = extractVideosFromHtml(html)
    const firstVideo = videos[0] || null

    let description =
        metadata.seoDescription || metadata.excerpt || metadata.subtitle || ""
    if (!description) description = htmlToText(data.content || html, 200)
    if (!description) description = site.siteDescription || ""

    let image = featuredImageUrl(metadata) || firstVideo?.thumbnailUrl || ""
    if (image && !/^https?:\/\//i.test(image) && host) image = `${proto}://${host}${image}`

    const tags = Array.isArray(metadata.tags)
        ? metadata.tags
        : typeof metadata.tags === "string" && metadata.tags.trim()
        ? metadata.tags.split(",").map((t) => t.trim())
        : []

    const lines = []
    lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}" />`)
    lines.push(`<meta property="og:site_name" content="${escapeAttr(siteTitle)}" />`)
    lines.push(`<meta property="og:title" content="${escapeAttr(title)}" />`)
    if (description) lines.push(`<meta property="og:description" content="${escapeAttr(description)}" />`)
    lines.push(`<meta property="og:url" content="${escapeAttr(canonical)}" />`)
    lines.push(
        `<meta property="og:type" content="${firstVideo ? "video.other" : isHome ? "website" : "article"}" />`
    )
    lines.push(`<meta property="og:locale" content="${site.uiLanguage === "en" ? "en_US" : "zh_CN"}" />`)
    if (image) {
        lines.push(`<meta property="og:image" content="${escapeAttr(image)}" />`)
        lines.push(`<meta name="twitter:card" content="summary_large_image" />`)
        lines.push(`<meta name="twitter:image" content="${escapeAttr(image)}" />`)
    } else {
        lines.push(`<meta name="twitter:card" content="summary" />`)
    }
    lines.push(`<meta name="twitter:title" content="${escapeAttr(title)}" />`)
    if (description) lines.push(`<meta name="twitter:description" content="${escapeAttr(description)}" />`)
    if (!isHome && metadata.publishDate) {
        lines.push(`<meta property="article:published_time" content="${escapeAttr(metadata.publishDate)}" />`)
    }
    if (!isHome && metadata.category) {
        lines.push(`<meta property="article:section" content="${escapeAttr(metadata.category)}" />`)
    }
    for (const tag of tags) {
        lines.push(`<meta property="article:tag" content="${escapeAttr(tag)}" />`)
    }
    if (firstVideo) {
        lines.push(`<meta property="og:video" content="${escapeAttr(firstVideo.embedUrl)}" />`)
        lines.push(`<meta property="og:video:type" content="text/html" />`)
        if (firstVideo.thumbnailUrl) {
            lines.push(`<meta property="og:video:image" content="${escapeAttr(firstVideo.thumbnailUrl)}" />`)
        }
        if (firstVideo.durationSeconds) {
            lines.push(`<meta property="og:video:duration" content="${firstVideo.durationSeconds}" />`)
        }
    }

    // ---- JSON-LD -------------------------------------------------------
    // The page node is always an Article (or WebSite on the home page); when the
    // content embeds a video a dedicated VideoObject node carries the media
    // fields, which is what search engines look for.
    const graph = []
    if (!isHome) {
        graph.push({
            "@type": "Article",
            headline: metadata.title || "",
            name: metadata.title || "",
            description,
            url: canonical,
            ...(image ? { image: [image] } : {}),
            ...(metadata.publishDate || metadata.createdAt
                ? { datePublished: metadata.publishDate || metadata.createdAt }
                : {}),
            ...(metadata.updatedAt ? { dateModified: metadata.updatedAt } : {}),
            ...(metadata.author ? { author: { "@type": "Person", name: metadata.author } } : {}),
            ...(tags.length ? { keywords: tags.join(", ") } : {}),
            ...(metadata.category ? { articleSection: metadata.category } : {}),
            publisher: { "@type": "Organization", name: siteTitle },
        })
        if (firstVideo) {
            graph.push({
                "@type": "VideoObject",
                name: firstVideo.title || metadata.title || "",
                description,
                ...(firstVideo.thumbnailUrl ? { thumbnailUrl: [firstVideo.thumbnailUrl] } : {}),
                ...(metadata.publishDate || metadata.createdAt
                    ? { uploadDate: metadata.publishDate || metadata.createdAt }
                    : {}),
                ...(isoDuration(firstVideo.durationSeconds) ? { duration: isoDuration(firstVideo.durationSeconds) } : {}),
                embedUrl: firstVideo.embedUrl,
                ...(firstVideo.watchUrl ? { url: firstVideo.watchUrl } : {}),
            })
        }
    } else {
        graph.push({
            "@type": "WebSite",
            name: siteTitle,
            url: canonical,
            description: site.siteDescription || "",
        })
    }
    lines.push(
        `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(
            /</g,
            "\\u003c"
        )}</script>`
    )

    return lines.join("\n") + "\n"
}
