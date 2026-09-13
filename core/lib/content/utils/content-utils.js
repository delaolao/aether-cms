/**
 * Utility functions for content management
 */

import { extractPeerTubeId, readPeerTubeMetaSync, ensurePeerTubeMeta } from "../../media/peertube.js"

/**
 * Every `[video:URL|Caption]` directive in a markdown string.
 *
 * Code samples are ignored on purpose: documentation pages routinely show
 * `[video:…]` inside fenced blocks or inline code, and those are examples, not
 * real embeds (otherwise they would show up in the video library and cards).
 *
 * @param {string} markdown
 * @returns {Array<{url: string, caption: string}>}
 */
export function extractVideoDirectives(markdown) {
    if (!markdown || typeof markdown !== "string") return []
    const prose = markdown
        .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
        .replace(/~~~[\s\S]*?~~~/g, " ") // tilde-fenced blocks
        .replace(/`[^`\n]*`/g, " ") // inline code

    const out = []
    const re = /\[video:([^\]|]+)(?:\|([^\]]*))?\]/g
    let m
    while ((m = re.exec(prose)) !== null) {
        out.push({ url: m[1].trim(), caption: (m[2] || "").trim() })
    }
    return out
}

/**
 * Cover information for the FIRST video of a piece of content, used by list
 * cards (thumbnail + duration badge + channel). Reads the PeerTube metadata
 * cache synchronously — no network while rendering — and returns null when the
 * content has no video or the cache is still cold.
 *
 * @param {string} markdown
 * @returns {Object|null}
 */
export function firstVideoCover(markdown) {
    for (const directive of extractVideoDirectives(markdown)) {
        const id = extractPeerTubeId(directive.url)
        if (!id) continue
        const meta = readPeerTubeMetaSync(id)
        // Self-heal: cold cache → fetch in the background, so the next render
        // shows the real cover without re-saving the article.
        if (!meta) ensurePeerTubeMeta(id).catch(() => {})
        return {
            id,
            title: meta?.title || directive.caption || "",
            caption: directive.caption || "",
            thumbnailUrl: meta?.thumbnailUrl || "",
            previewUrl: meta?.previewUrl || "",
            durationText: meta?.durationText || "",
            channel: meta?.channel || "",
            watchUrl: meta?.watchUrl || directive.url,
            ready: Boolean(meta?.thumbnailUrl),
        }
    }
    return null
}

/**
 * Convert a string to a URL-friendly slug
 * @param {string} text - Text to convert
 * @returns {string} Slug
 */
export function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-") // Replace spaces with -
        .replace(/&/g, "-and-") // Replace & with 'and'
        // Keep word characters AND CJK (Chinese/Japanese/Korean) characters so
        // Chinese slugs (categories, tags, titles) survive.
        .replace(/[^\w\u4e00-\u9fa5\-]+/g, "") // Remove all non-word characters
        .replace(/\-\-+/g, "-") // Replace multiple - with single -
}

/**
 * Renames a property in all objects within an array
 * This function modifies the objects in place for optimal performance
 * @param {Array<Object>} array - The array of objects to process
 * @param {string} oldKey - The current property name to be renamed
 * @param {string} newKey - The new property name to replace the old key
 * @returns {Array<Object>} The modified array with renamed properties
 */
export function renameProperty(array, oldKey, newKey) {
    // Use for loop for better performance with large arrays
    for (let i = 0; i < array.length; i++) {
        const obj = array[i]
        // Only manipulate object if it has the property
        if (oldKey in obj) {
            // Create the property with new name
            obj[newKey] = obj[oldKey]
            // Delete the old property
            delete obj[oldKey]
        }
    }
    return array
}

/**
 * Adds lightweight references to previous and next posts in a collection
 * Optimized for performance with large datasets in a Node.js environment
 * @param {Array<Object>} posts - Array of post objects to process
 * @param {Object} options - Configuration options
 * @param {Function} options.getTitleFn - Function to extract title from a post
 * @param {Function} options.getSlugFn - Function to extract slug from a post
 * @param {String} options.prevFieldName - Field name for previous post reference
 * @param {String} options.nextFieldName - Field name for next post reference
 * @param {Boolean} options.mutate - Whether to mutate original posts array
 * @returns {Array<Object>} - Array of posts with added references
 */
export function addPostReferences(posts, options = {}) {
    // Set default options
    const {
        getTitleFn = (post) => post.frontmatter?.title,
        getSlugFn = (post) => post.fileBaseName,
        prevFieldName = "prevPost",
        nextFieldName = "nextPost",
        mutate = true,
    } = options

    // Create a new array if we shouldn't mutate the original
    const result = mutate ? posts : JSON.parse(JSON.stringify(posts))

    // Single pass through the array for optimal performance
    for (let i = 0; i < result.length; i++) {
        const post = result[i]

        // Add reference to previous post (next in chronological order)
        if (i + 1 < result.length) {
            const prevPost = result[i + 1]
            post[prevFieldName] = {
                title: getTitleFn(prevPost),
                slug: getSlugFn(prevPost),
            }
        } else {
            post[prevFieldName] = null
        }

        // Add reference to next post (previous in chronological order)
        if (i - 1 >= 0) {
            const nextPost = result[i - 1]
            post[nextFieldName] = {
                title: getTitleFn(nextPost),
                slug: getSlugFn(nextPost),
            }
        } else {
            post[nextFieldName] = null
        }
    }

    return result
}

/**
 * Sort content items by date (newest first)
 * @param {Array<Object>} items - Array of content items to sort
 * @returns {Array<Object>} Sorted array
 */
export function sortContentByDate(items) {
    return items.sort((a, b) => {
        const dateA = getContentDate(a.frontmatter)
        const dateB = getContentDate(b.frontmatter)
        return dateB - dateA
    })
}

/**
 * Resolve the canonical display/sort date for a content item: prefer an
 * explicit `publishDate` (set by the author), otherwise fall back to
 * `createdAt`. Returns a Date or epoch 0.
 * @param {Object} frontmatter
 * @returns {Date}
 */
function getContentDate(frontmatter) {
    const value = frontmatter?.publishDate || frontmatter?.createdAt
    const parsed = value ? new Date(value) : new Date(0)
    return isNaN(parsed.getTime()) ? new Date(0) : parsed
}

/**
 * Canonical date string (ISO) used for display, preferring publishDate.
 * Exported for reuse by routes/templates.
 * @param {Object} frontmatter
 * @returns {string|undefined}
 */
export function getContentDateValue(frontmatter) {
    return frontmatter?.publishDate || frontmatter?.createdAt
}

/**
 * Apply offset and limit to an array
 * @param {Array<Object>} items - Array of items
 * @param {Object} options - Options object with offset and limit properties
 * @returns {Array<Object>} Sliced array
 */
export function applyPagination(items, options) {
    const limit = options.limit || Infinity
    const offset = options.offset || 0
    return items.slice(offset, offset + limit)
}

/**
 * Helper method to truncate excerpt to specified length
 * @param {string} excerpt - The excerpt to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated excerpt
 */
export function truncateExcerpt(excerpt, maxLength = 120) {
    if (!excerpt || excerpt.length <= maxLength) {
        return excerpt
    }

    // Find a good breaking point (end of word)
    const truncated = excerpt.substring(0, maxLength)
    const lastSpace = truncated.lastIndexOf(" ")

    if (lastSpace > maxLength * 0.8) {
        // Only break at word if we're not losing too much text
        return truncated.substring(0, lastSpace) + "..."
    }

    // Otherwise just truncate and add ellipsis
    return truncated + "..."
}

/**
 * Detect which media badges a piece of content should show on its card.
 *
 * Cards are a glanceable summary, so this only reports unmistakable signals:
 * a video embed (`[video:…]`, raw `<video>` / `<iframe>`), an asciinema cast
 * (`[asciinema:…]`) or a file attachment (`[file:…]`).
 *
 * @param {string} content - Raw Markdown of the item
 * @returns {Array<{type: string, icon: string, label: string}>}
 */
export function detectMediaBadges(content) {
    if (!content || typeof content !== "string") return []

    const badges = []
    if (/\[video:/i.test(content) || /<video[\s>]/i.test(content) || /<iframe[\s>]/i.test(content)) {
        badges.push({ type: "video", icon: "🎬", label: "含视频" })
    }
    if (/\[asciinema:/i.test(content)) {
        badges.push({ type: "cast", icon: "⌨️", label: "含终端录制" })
    }
    if (/\[file:/i.test(content)) {
        badges.push({ type: "file", icon: "📎", label: "含附件" })
    }
    return badges
}

/**
 * Convert Markdown (including this project's Obsidian-style extensions) into
 * plain prose, for excerpts / summaries / meta descriptions / search indexes.
 *
 * Standard Markdown alone is not enough here: an article often OPENS with an
 * embed such as `[video:https://…|标题]`, and a naive strip would leak the raw
 * directive (and its URL) into list previews. Rules:
 *
 *   [video:URL|Caption]      → Caption        (URL dropped)
 *   [asciinema:id|Caption]   → Caption
 *   [file:path|Name]         → Name (or basename)
 *   [ref:key]                → dropped
 *   [[Note|Label]]           → Label
 *   ![[image.png]]           → dropped,  ![[Note]] → Label
 *   $$…$$ / $…$              → dropped / inner expression
 *   > [!TYPE] Title          → Title
 *   #标签                     → 标签
 *   code fences / tables / lists / HTML / images → dropped or unwrapped
 *
 * @param {string} markdown
 * @returns {string} Plain single-line text
 */
export function markdownToPlainText(markdown) {
    if (!markdown || typeof markdown !== "string") return ""

    return (
        markdown
            // Fenced code blocks — no prose value
            .replace(/```[\s\S]*?```/g, " ")
            // Obsidian embeds: images are dropped, note embeds keep their label
            .replace(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (match, target, label) =>
                /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(String(target).trim()) ? " " : label || target
            )
            // Wikilinks: [[Target#Anchor|Label]] → Label
            .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (match, target, label) => label || target)
            // Media / attachment directives — keep the human-readable caption
            .replace(/\[video:([^\]|]+)(?:\|([^\]]+))?\]/g, (match, url, caption) => caption || " ")
            .replace(/\[asciinema:([^\]|]+)(?:\|([^\]]+))?\]/g, (match, id, caption) => caption || " ")
            .replace(/\[file:([^\]|]+)(?:\|([^\]]+))?\]/g, (match, path, name) => {
                const fallback = String(path).split("/").pop() || ""
                return name || fallback || " "
            })
            .replace(/\[ref:[^\]]+\]/g, " ")
            // Math
            .replace(/\$\$[\s\S]*?\$\$/g, " ")
            .replace(/\$([^$\n]+)\$/g, "$1")
            // Images then links
            .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
            .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
            .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
            .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, " ")
            // Callouts: "> [!INFO] Title" → "Title"
            .replace(/^>\s*\[!(\w+)\]\s*(.*)$/gm, "$2")
            // Headings / blockquote markers / list markers / rules
            .replace(/#{1,6}\s+/g, "")
            .replace(/^>\s?/gm, "")
            .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
            .replace(/^\s*[-*+]\s+/gm, "")
            .replace(/^\s*\d+\.\s+/gm, "")
            // Table rows
            .replace(/^\s*\|.*\|\s*$/gm, " ")
            // Emphasis + inline code (keep the text)
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/\*([^*]+)\*/g, "$1")
            .replace(/~~([^~]+)~~/g, "$1")
            .replace(/_([^_]+)_/g, "$1")
            .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
            // Hashtags → plain words
            .replace(/(^|\s)#([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5.\-]*)/g, "$1$2")
            // Raw HTML
            .replace(/<[^>]*>/g, " ")
            // Collapse whitespace into a single line
            .replace(/[ \t]+/g, " ")
            .replace(/\s*\n\s*/g, " ")
            .trim()
    )
}

/**
 * Transforms a list of content items based on view options
 * @param {Array<Object>} contentItems - Array of content items to transform
 * @param {Object} options - Transformation options
 * @param {boolean} options.summaryView - Whether to generate content previews
 * @param {number} options.previewLength - Length of content preview (default: 300)
 * @param {boolean} options.frontmatterOnly - Whether to return only frontmatter
 * @returns {Array<Object>} Transformed content items
 */
export function transformContentItems(contentItems, options = {}) {
    // Handle the summaryView option - includes frontmatter and truncated content
    if (options.summaryView) {
        // Default to 300 characters for content previews
        const previewLength = options.previewLength || 300

        return contentItems.map((item) => {
            // Create frontmatter with excerpt if needed
            const frontmatter = { ...item.frontmatter } || {}

            // Sanitise an authored excerpt too: legacy excerpts (and ones pasted
            // from content) may still contain raw directives such as
            // `[video:https://…|标题]`, which would show up verbatim in cards.
            if (frontmatter.excerpt) {
                frontmatter.excerpt = markdownToPlainText(frontmatter.excerpt)
            }

            // Card media badges (video / terminal cast / attachment)
            frontmatter.mediaIcons = detectMediaBadges(item.content)

            // Card video cover (PeerTube thumbnail + duration) for video content
            frontmatter.videoCover = firstVideoCover(item.content)
            frontmatter.videoCount = extractVideoDirectives(item.content).length

            // Generate preview from content if needed
            let contentPreview = ""
            if (item.content) {
                const plainText = markdownToPlainText(item.content)

                contentPreview =
                    plainText.length > previewLength ? plainText.substring(0, previewLength - 3) + "..." : plainText
            }

            // Return structured object with frontmatter and preview content
            return {
                frontmatter,
                content: contentPreview || "",
            }
        })
    }

    // Handle the frontmatterOnly option
    if (options.frontmatterOnly) {
        return contentItems.map((item) => ({
            frontmatter: item.frontmatter || {},
        }))
    }

    // Return unmodified content items
    return contentItems
}
