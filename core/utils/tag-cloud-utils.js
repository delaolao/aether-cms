/**
 * Tag frequency utilities — shared by the tag-cloud route and the /api/tags
 * endpoint, so both report identical counts.
 */
import { slugify } from "../lib/content/utils/content-utils.js"

/**
 * Normalize a frontmatter `tags` value into an array of tag strings.
 * Supports the two shapes aether allows: an array, or a comma-separated string.
 * @param {*} tags
 * @returns {string[]}
 */
export function normalizeTags(tags) {
    if (Array.isArray(tags)) {
        return tags.map((t) => String(t).trim()).filter(Boolean)
    }
    if (typeof tags === "string" && tags.trim() !== "") {
        return tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
    }
    return []
}

/**
 * Count how many published posts use each tag.
 * @param {Object} contentManager - The content manager instance
 * @returns {Promise<Array<{name:string, slug:string, count:number}>>} Tags sorted by
 *   descending frequency, then alphabetically. Each entry carries the tag name,
 *   its URL-safe slug (matching the /tag/:slug route) and the post count.
 */
export async function getTagFrequency(contentManager) {
    let posts
    try {
        posts = await contentManager.getPosts({ status: "published", frontmatterOnly: true })
    } catch (error) {
        console.error("getTagFrequency: failed to read posts:", error)
        posts = []
    }

    const counts = new Map()
    for (const post of posts) {
        const tags = normalizeTags(post?.frontmatter?.tags)
        for (const tag of tags) {
            counts.set(tag, (counts.get(tag) || 0) + 1)
        }
    }

    return Array.from(counts.entries())
        .map(([name, count]) => ({ name, slug: slugify(name), count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
