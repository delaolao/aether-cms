/**
 * Aether Markdown Renderer
 *
 * Obsidian-style Markdown rendering for Aether CMS.
 *
 * The tokenizers below are ported from hblog-ng (MIT license, halit/hblog-ng)
 * `lib/markdown/extensions.ts`, adapted from React-component rendering to
 * server-side HTML rendering for Aether's theme templates:
 *
 *   - [[wikilinks]]          → internal content links (resolved against the CMS)
 *   - ![[embeds]]            → embedded images / note links
 *   - $math$ / $$math$$      → KaTeX math (server-rendered HTML)
 *   - > [!TYPE] callouts     → styled callout blocks
 *   - [video:url|caption]    → YouTube / Vimeo / local video embeds
 *   - [asciinema:id|caption] → asciinema terminal casts
 *   - [file:path|name]       → file attachment links
 *   - [ref:key]              → reference placeholders (BibTeX not wired yet)
 *   - #hashtag               → tag links
 *
 * Raw HTML blocks (e.g. <iframe src="...">) pass through marked unchanged,
 * which is how arbitrary embeddable video players are supported.
 */

import { Marked } from "marked"
import katex from "katex"

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function slugifyTag(text) {
    return String(text)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
        .replace(/^-+|-+$/g, "")
}

// ---------------------------------------------------------------------------
// Video URL resolution (ported from hblog-ng utils/video.ts)
// ---------------------------------------------------------------------------

export function getVideoInfo(src) {
    if (!src) return { type: "unknown", embedUrl: src }

    // YouTube
    if (src.includes("youtube.com") || src.includes("youtu.be")) {
        const videoId = src.match(
            /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/
        )?.[1]
        if (videoId) {
            return { type: "youtube", id: videoId, embedUrl: `https://www.youtube.com/embed/${videoId}` }
        }
    }

    // Vimeo
    if (src.includes("vimeo.com")) {
        const videoId = src.match(
            /vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/(?:[^/]*)\/videos\/|album\/(?:\d+)\/video\/|video\/|)(\d+)(?:$|\/|\?)/
        )?.[1]
        if (videoId) {
            return { type: "vimeo", id: videoId, embedUrl: `https://player.vimeo.com/video/${videoId}` }
        }
    }

    // Asciinema
    if (src.includes("asciinema.org") || src.endsWith(".cast")) {
        if (src.includes("asciinema.org/a/")) {
            const videoId = src.match(/asciinema\.org\/a\/([a-zA-Z0-9-]+)/)?.[1]
            if (videoId) {
                return { type: "asciinema", id: videoId, embedUrl: `https://asciinema.org/a/${videoId}.cast` }
            }
        }
        if (src.endsWith(".cast")) {
            return { type: "asciinema", embedUrl: src }
        }
    }

    // Local / generic
    if (!src.startsWith("http") && !src.startsWith("/")) {
        return { type: "local", embedUrl: `/videos/${src}` }
    }

    return { type: "local", embedUrl: src }
}

// ---------------------------------------------------------------------------
// Wikilink index
// ---------------------------------------------------------------------------

/**
 * Build a map of lowercase title → { url, title, type } from all published
 * content, used to resolve [[wikilinks]] to real URLs.
 *
 * @param {Object} contentManager - Aether ContentManager instance
 * @returns {Promise<Map<string, {url: string, title: string, type: string}>>}
 */
export async function buildWikilinkIndex(contentManager) {
    const index = new Map()

    const addItem = (frontmatter, type) => {
        if (!frontmatter || !frontmatter.title || frontmatter.status !== "published") return
        const url = getContentUrl(frontmatter, type)
        index.set(frontmatter.title.trim().toLowerCase(), {
            url,
            title: frontmatter.title,
            slug: frontmatter.slug,
            type,
        })
    }

    try {
        const posts = await contentManager.getPosts({ status: "published", frontmatterOnly: true })
        for (const post of posts) addItem(post.frontmatter, "post")
    } catch (error) {
        console.error("buildWikilinkIndex(posts):", error)
    }

    try {
        const pages = await contentManager.getPages({ status: "published", frontmatterOnly: true })
        for (const page of pages) addItem(page.frontmatter, "page")
    } catch (error) {
        console.error("buildWikilinkIndex(pages):", error)
    }

    return index
}

/**
 * Canonical URL for a content item's frontmatter.
 *
 * Posts and regular pages live under the unified /notes/<slug> route
 * (core/routes/notes.js), so [[wikilinks]], backlinks and graph nodes all
 * resolve into one route path. Custom pages keep their nested template path
 * (/<slug> or /<parent>/<slug>).
 */
export function getContentUrl(frontmatter, type) {
    const slug = frontmatter.slug || "untitled"
    if (type === "page" && frontmatter.pageType === "custom") return `/${slug}`
    return `/notes/${slug}`
}

// TTL cache for the wikilink index (kept short so new/renamed content appears
// quickly without a restart, while avoiding a full scan per request).
let wikilinkCache = { at: 0, index: null }
const WIKILINK_CACHE_TTL = 15000

export async function getWikilinkIndexCached(contentManager) {
    const now = Date.now()
    if (wikilinkCache.index && now - wikilinkCache.at < WIKILINK_CACHE_TTL) {
        return wikilinkCache.index
    }
    const index = await buildWikilinkIndex(contentManager)
    wikilinkCache = { at: now, index }
    return index
}

export function clearWikilinkCache() {
    wikilinkCache = { at: 0, index: null }
}

// ---------------------------------------------------------------------------
// Marked extensions (tokenizers ported from hblog-ng, HTML renderers new)
// ---------------------------------------------------------------------------

function createExtensions(options) {
    const { wikilinks = new Map(), uploadsPrefix = "/content/uploads", getRenderer = null } = options

    const parseInlineWith = (md) => (getRenderer ? getRenderer().parse(md) : escapeHtml(md))

    return [
        // [[Page]] | [[Page#Section|Label]]
        {
            name: "wikilink",
            level: "inline",
            start(src) {
                return src.indexOf("[[")
            },
            tokenizer(src) {
                const rule = /^\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/
                const match = rule.exec(src)
                if (match) {
                    return {
                        type: "wikilink",
                        raw: match[0],
                        page: match[1].trim(),
                        anchor: match[2]?.trim(),
                        label: match[3]?.trim() || match[1].trim(),
                    }
                }
                return undefined
            },
            renderer(token) {
                const target = wikilinks.get(token.page.toLowerCase())
                const label = escapeHtml(token.label)
                const anchor = token.anchor ? `#${encodeURIComponent(token.anchor)}` : ""
                if (target) {
                    return `<a class="wikilink" href="${target.url}${anchor}" title="${escapeHtml(target.title)}">${label}</a>`
                }
                return `<span class="wikilink wikilink-unresolved" title="Unresolved note: ${escapeHtml(token.page)}">${label}</span>`
            },
        },

        // ![[Link]] — image embeds become images, others become links
        {
            name: "embed",
            level: "inline",
            start(src) {
                return src.indexOf("![[")
            },
            tokenizer(src) {
                const rule = /^!\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/
                const match = rule.exec(src)
                if (match) {
                    return {
                        type: "embed",
                        raw: match[0],
                        link: match[1].trim(),
                        anchor: match[2]?.trim(),
                        caption: match[3]?.trim(),
                    }
                }
                return undefined
            },            renderer(token) {
                const isImage = /\.(png|jpe?g|gif|svg|webp)$/i.test(token.link)
                const caption = escapeHtml(token.caption || token.link)
                if (isImage) {
                    const src = token.link.startsWith("/") || token.link.startsWith("http")
                        ? token.link
                        : `${uploadsPrefix}/${token.link}`
                    return `<img class="embedded-image" src="${escapeHtml(src)}" alt="${caption}" loading="lazy" />`
                }
                const target = wikilinks.get(token.link.toLowerCase())
                if (target) {
                    return `<a class="wikilink" href="${target.url}" title="${escapeHtml(target.title)}">${caption}</a>`
                }
                return `<span class="wikilink wikilink-unresolved">${caption}</span>`
            },
        },

        // $$ ... $$
        {
            name: "mathBlock",
            level: "block",
            start(src) {
                return src.indexOf("$$")
            },
            tokenizer(src) {
                const rule = /^\$\$([\s\S]*?)\$\$/
                const match = rule.exec(src)
                if (match) {
                    return { type: "mathBlock", raw: match[0], text: match[1].trim() }
                }
                return undefined
            },
            renderer(token) {
                try {
                    const html = katex.renderToString(token.text, { displayMode: true, throwOnError: false })
                    return `<div class="math-block">${html}</div>`
                } catch {
                    return `<div class="math-block"><code>${escapeHtml(token.text)}</code></div>`
                }
            },
        },

        // $ ... $
        {
            name: "mathInline",
            level: "inline",
            start(src) {
                return src.indexOf("$")
            },
            tokenizer(src) {
                const rule = /^\$([^$\n]+?)\$/
                const match = rule.exec(src)
                if (match) {
                    return { type: "mathInline", raw: match[0], text: match[1].trim() }
                }
                return undefined
            },
            renderer(token) {
                try {
                    return katex.renderToString(token.text, { throwOnError: false })
                } catch {
                    return `<code>${escapeHtml(token.text)}</code>`
                }
            },
        },

        // > [!TYPE] Title
        {
            name: "callout",
            level: "block",
            start(src) {
                return src.indexOf("> [!")
            },
            tokenizer(src) {
                const rule = /^> \[!(\w+)\]([^\n]*)\n((?:>.*\n?)*)/
                const match = rule.exec(src)
                if (match) {
                    return {
                        type: "callout",
                        raw: match[0],
                        calloutType: match[1].trim(),
                        title: match[2].trim(),
                        content: match[3].replace(/^> /gm, "").trim(),
                    }
                }
                return undefined
            },
            renderer(token) {
                const type = token.calloutType.toLowerCase()
                const title = token.title || token.calloutType
                const inner = parseInlineWith(token.content)
                return `<div class="callout callout-${escapeHtml(type)}"><div class="callout-title">${escapeHtml(title)}</div><div class="callout-content">${inner}</div></div>`
            },
        },

        // [ref:key]
        {
            name: "referenceLink",
            level: "inline",
            start(src) {
                return src.indexOf("[ref:")
            },
            tokenizer(src) {
                const rule = /^\[ref:([^\]]+)\]/
                const match = rule.exec(src)
                if (match) {
                    const content = match[1].trim()
                    const [refId, label] = content.includes("|") ? content.split("|") : [content, null]
                    return { type: "referenceLink", raw: match[0], refId: refId.trim(), label: label?.trim() }
                }
                return undefined
            },
            renderer(token) {
                // BibTeX references are not wired into Aether yet; render as a
                // styled placeholder so the source stays intact.
                return `<span class="reference-link">[ref:${escapeHtml(token.refId)}]</span>`
            },
        },

        // [file:path|name]
        {
            name: "fileAttachment",
            level: "inline",
            start(src) {
                return src.indexOf("[file:")
            },
            tokenizer(src) {
                const rule = /^\[file:([^\]]+)\]/
                const match = rule.exec(src)
                if (match) {
                    const content = match[1].trim()
                    const [path, name] = content.includes("|") ? content.split("|") : [content, null]
                    return {
                        type: "fileAttachment",
                        raw: match[0],
                        path: path.trim(),
                        name: name?.trim() || path.split("/").pop()?.trim(),
                    }
                }
                return undefined
            },
            renderer(token) {
                const url = token.path.startsWith("/") || token.path.startsWith("http")
                    ? token.path
                    : `${uploadsPrefix}/${token.path}`
                return `<a class="file-attachment" href="${escapeHtml(url)}" download>📎 ${escapeHtml(token.name)}</a>`
            },
        },

        // [video:url|caption]
        {
            name: "videoPlayer",
            level: "inline",
            start(src) {
                return src.indexOf("[video:")
            },
            tokenizer(src) {
                const rule = /^\[video:([^\]]+)\]/
                const match = rule.exec(src)
                if (match) {
                    const content = match[1].trim()
                    const [url, caption] = content.includes("|") ? content.split("|") : [content, null]
                    return { type: "videoPlayer", raw: match[0], url: url.trim(), caption: caption?.trim() }
                }
                return undefined
            },
            renderer(token) {
                const info = getVideoInfo(token.url)
                const caption = token.caption ? `<div class="video-caption">${escapeHtml(token.caption)}</div>` : ""
                if (info.type === "youtube" || info.type === "vimeo") {
                    return `<div class="video-embed"><iframe src="${escapeHtml(info.embedUrl)}" class="video-iframe" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen title="${escapeHtml(token.caption || "Video")}"></iframe></div>${caption}`
                }
                return `<div class="video-embed"><video src="${escapeHtml(info.embedUrl)}" controls preload="metadata" class="video-local"></video></div>${caption}`
            },
        },

        // [asciinema:id|caption]
        {
            name: "asciinema",
            level: "inline",
            start(src) {
                return src.indexOf("[asciinema:")
            },
            tokenizer(src) {
                const rule = /^\[asciinema:([^\]]+)\]/
                const match = rule.exec(src)
                if (match) {
                    const content = match[1].trim()
                    const [id, caption] = content.includes("|") ? content.split("|") : [content, null]
                    return { type: "asciinema", raw: match[0], id: id.trim(), caption: caption?.trim() }
                }
                return undefined
            },
            renderer(token) {
                const src = token.id.startsWith("http")
                    ? token.id
                    : `https://asciinema.org/a/${token.id}/embed/1`
                return `<div class="video-embed asciinema-embed"><iframe src="${escapeHtml(src)}" class="video-iframe" allowfullscreen title="${escapeHtml(token.caption || "Terminal session")}"></iframe></div>`
            },
        },

        // #hashtag
        {
            name: "hashtag",
            level: "inline",
            start(src) {
                return src.indexOf("#")
            },
            tokenizer(src) {
                const rule = /^#([A-Za-z\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5_.-]*)/
                const match = rule.exec(src)
                if (match) {
                    return { type: "hashtag", raw: match[0], text: match[1] }
                }
                return undefined
            },
            renderer(token) {
                const slug = slugifyTag(token.text)
                return `<a class="hashtag" href="/tag/${encodeURIComponent(slug)}">#${escapeHtml(token.text)}</a>`
            },
        },
    ]
}

// ---------------------------------------------------------------------------
// Renderer factory
// ---------------------------------------------------------------------------

/**
 * Create a configured marked instance.
 *
 * @param {Object} [options]
 * @param {Map} [options.wikilinks] - lower-title → {url,title} map (see buildWikilinkIndex)
 * @param {string} [options.uploadsPrefix] - base URL for uploaded files
 * @returns {import("marked").Marked}
 */
export function createMarkdownRenderer(options = {}) {
    let instance = null
    const extensions = createExtensions({ ...options, getRenderer: () => instance })
    instance = new Marked({ gfm: true, breaks: false })
    instance.use({ extensions })
    return instance
}

/**
 * Render markdown to HTML using Aether's Obsidian-style renderer.
 *
 * @param {string} content - Raw markdown
 * @param {Object} [options] - Same options as createMarkdownRenderer
 * @returns {string} HTML
 */
export function renderMarkdown(content, options = {}) {
    if (!content) return ""
    return createMarkdownRenderer(options).parse(content)
}
