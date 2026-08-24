/**
 * Editor Markdown Extensions (browser)
 *
 * Registers Obsidian-style markdown extensions on the global `marked` instance
 * used by the admin editor live preview, mirroring the server-side renderer in
 * core/lib/markdown/markdown-renderer.js so preview ≈ production:
 *
 *   - [[wikilinks]]  (resolved via /api/wikilinks)
 *   - ![[embeds]]
 *   - $math$ / $$math$$ (KaTeX, loaded from vendors/katex)
 *   - > [!TYPE] callouts
 *   - [video:url|caption], [asciinema:id], [file:path|name], [ref:key]
 *   - #hashtags
 */

let registered = false
let wikilinkIndex = null
let wikilinkFetchPromise = null

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function getVideoInfo(src) {
    if (!src) return { type: "unknown", embedUrl: src }

    if (src.includes("youtube.com") || src.includes("youtu.be")) {
        const videoId = src.match(
            /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/
        )?.[1]
        if (videoId) {
            return { type: "youtube", embedUrl: `https://www.youtube.com/embed/${videoId}` }
        }
    }

    if (src.includes("vimeo.com")) {
        const videoId = src.match(
            /vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/(?:[^/]*)\/videos\/|album\/(?:\d+)\/video\/|video\/|)(\d+)(?:$|\/|\?)/
        )?.[1]
        if (videoId) {
            return { type: "vimeo", embedUrl: `https://player.vimeo.com/video/${videoId}` }
        }
    }

    if (!src.startsWith("http") && !src.startsWith("/")) {
        return { type: "local", embedUrl: `/videos/${src}` }
    }
    return { type: "local", embedUrl: src }
}

function renderMath(text, displayMode) {
    if (window.katex && typeof window.katex.renderToString === "function") {
        try {
            return window.katex.renderToString(text, { displayMode, throwOnError: false })
        } catch {
            /* fall through to code fallback */
        }
    }
    return `<code>${escapeHtml(text)}</code>`
}

function resolveWikilink(page) {
    if (!wikilinkIndex) return undefined
    return wikilinkIndex[page.trim().toLowerCase()] || undefined
}

async function loadWikilinkIndex() {
    if (wikilinkIndex) return wikilinkIndex
    if (!wikilinkFetchPromise) {
        wikilinkFetchPromise = fetch("/api/wikilinks", { credentials: "same-origin" })
            .then((res) => (res.ok ? res.json() : { data: {} }))
            .then((json) => {
                wikilinkIndex = json.data || {}
                return wikilinkIndex
            })
            .catch(() => {
                wikilinkIndex = {}
                return wikilinkIndex
            })
    }
    return wikilinkFetchPromise
}

/**
 * Register the extensions on window.marked. Idempotent.
 * @returns {Promise<void>}
 */
export async function initEditorMarkdownExtensions() {
    if (registered || !window.marked) return
    registered = true

    // Preload the wikilink index for preview resolution (non-blocking).
    loadWikilinkIndex()

    const extensions = [
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
                const target = resolveWikilink(token.page)
                const label = escapeHtml(token.label)
                const anchor = token.anchor ? `#${encodeURIComponent(token.anchor)}` : ""
                if (target) {
                    return `<a class="wikilink" href="${target.url}${anchor}" title="${escapeHtml(target.title)}">${label}</a>`
                }
                return `<span class="wikilink wikilink-unresolved" title="Unresolved note: ${escapeHtml(token.page)}">${label}</span>`
            },
        },

        // ![[Link]]
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
            },
            renderer(token) {
                const isImage = /\.(png|jpe?g|gif|svg|webp)$/i.test(token.link)
                const caption = escapeHtml(token.caption || token.link)
                if (isImage) {
                    const src =
                        token.link.startsWith("/") || token.link.startsWith("http")
                            ? token.link
                            : `/content/uploads/${token.link}`
                    return `<img class="embedded-image" src="${escapeHtml(src)}" alt="${caption}" loading="lazy" />`
                }
                const target = resolveWikilink(token.link)
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
                return `<div class="math-block">${renderMath(token.text, true)}</div>`
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
                return renderMath(token.text, false)
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
                const inner = window.marked ? window.marked.parse(token.content) : escapeHtml(token.content)
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
                const url =
                    token.path.startsWith("/") || token.path.startsWith("http")
                        ? token.path
                        : `/content/uploads/${token.path}`
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
                const slug = token.text.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
                return `<a class="hashtag" href="/tag/${encodeURIComponent(slug)}">#${escapeHtml(token.text)}</a>`
            },
        },
    ]

    window.marked.use({ extensions })
}
