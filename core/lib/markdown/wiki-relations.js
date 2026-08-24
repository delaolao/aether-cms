/**
 * Wiki Relations — Obsidian-style content relationship engine.
 *
 * Derives the knowledge graph from [[wikilinks]] across all published content:
 *
 *   - extractInternalLinks()  — pull [[Page]], [[Page#Anchor]], [[Page|Label]]
 *   - buildRelationGraph()    — nodes (all published content) + edges
 *   - getBacklinks()          — items that link to a given item (directional)
 *   - getWikiRelated()        — items a given item links to + manual relatedPosts
 *
 * The bidirectional graph mirrors hblog-ng's scripts/pipeline/graph.ts; the
 * directional backlinks mirror Obsidian's backlinks panel.
 */

import { getWikilinkIndexCached, getContentUrl } from "./markdown-renderer.js"

/**
 * Extract the target names of all [[wikilinks]] in a markdown string.
 * (Ported from hblog-ng lib/routing.ts extractInternalLinks.)
 *
 * @param {string} content
 * @returns {string[]}
 */
export function extractInternalLinks(content) {
    if (!content) return []
    const linkRegex = /\[\[([^\]]+)\]\]/g
    const links = new Set()
    let match
    while ((match = linkRegex.exec(content)) !== null) {
        // Obsidian wikilinks can carry an alias ([[Target|Label]]) and/or a
        // heading/block anchor ([[Target#Heading]]); only the target part
        // identifies the linked note.
        const target = match[1].split("|")[0].split("#")[0].trim()
        if (target) links.add(target)
    }
    return Array.from(links)
}

/**
 * Resolve a wikilink label against the wikilink index.
 * Matches by exact title, normalized title (spaces → dashes), or slug.
 *
 * @param {string} label
 * @param {Map<string, {url: string, title: string, type: string, slug: string}>} wikilinks
 * @returns {Object|undefined}
 */
export function resolveLinkLabel(label, wikilinks) {
    const lower = label.trim().toLowerCase()
    if (!lower) return undefined
    if (wikilinks.has(lower)) return wikilinks.get(lower)

    const normalized = lower.replace(/\s+/g, "-")
    if (wikilinks.has(normalized)) return wikilinks.get(normalized)

    for (const value of wikilinks.values()) {
        if (value.slug && (value.slug.toLowerCase() === lower || value.slug.toLowerCase() === normalized)) {
            return value
        }
    }
    return undefined
}

/**
 * Fetch all published posts and pages (with content) as a uniform list.
 * @param {Object} contentManager
 * @returns {Promise<Array<{id: string, frontmatter: Object, content: string, type: string}>>}
 */
async function getAllPublishedItems(contentManager) {
    const items = []
    try {
        const posts = await contentManager.getPosts({ status: "published" })
        for (const post of posts) {
            items.push({ id: String(post.frontmatter?.id), frontmatter: post.frontmatter || {}, content: post.content || "", type: "post" })
        }
    } catch (error) {
        console.error("getAllPublishedItems(posts):", error)
    }
    try {
        const pages = await contentManager.getPages({ status: "published" })
        for (const page of pages) {
            items.push({ id: String(page.frontmatter?.id), frontmatter: page.frontmatter || {}, content: page.content || "", type: "page" })
        }
    } catch (error) {
        console.error("getAllPublishedItems(pages):", error)
    }
    return items
}

/**
 * Build the full relationship graph.
 *
 * @param {Object} contentManager
 * @returns {Promise<{
 *   nodes: Array<{id: string, title: string, slug: string, type: string, url: string, category: string, tags: string[]}>,
 *   edges: Array<{source: string, target: string}>,
 *   outgoing: Map<string, Object[]>,
 *   incoming: Map<string, Object[]>,
 * }>}
 */
export async function buildRelationGraph(contentManager) {
    const wikilinks = await getWikilinkIndexCached(contentManager)
    const items = await getAllPublishedItems(contentManager)

    // Nodes
    const urlToNode = new Map()
    const nodes = items.map((item) => {
        const fm = item.frontmatter
        const node = {
            id: item.id,
            title: fm.title || "Untitled",
            slug: fm.slug || "untitled",
            type: item.type,
            url: getContentUrl(fm, item.type),
            category: fm.category || "",
            tags: Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? fm.tags.split(",").map((t) => t.trim()) : [],
            created: fm.createdAt || "",
            updated: fm.updatedAt || "",
            description: fm.excerpt || fm.seoDescription || "",
        }
        urlToNode.set(node.url, node)
        return node
    })

    // Edges + directional maps
    const edges = []
    const edgeSet = new Set()
    const outgoing = new Map()
    const incoming = new Map()

    for (const item of items) {
        const sourceNode = urlToNode.get(getContentUrl(item.frontmatter, item.type))
        if (!sourceNode) continue

        const targets = []
        for (const label of extractInternalLinks(item.content)) {
            const target = resolveLinkLabel(label, wikilinks)
            if (!target || target.url === sourceNode.url) continue
            const targetNode = urlToNode.get(target.url)
            if (!targetNode) continue

            targets.push(targetNode)

            const key = [sourceNode.id, targetNode.id].sort().join("|")
            if (!edgeSet.has(key)) {
                edgeSet.add(key)
                edges.push({ source: sourceNode.id, target: targetNode.id })
            }
        }
        outgoing.set(sourceNode.id, targets)
    }

    // Incoming (reverse of outgoing)
    for (const [sourceId, targets] of outgoing.entries()) {
        for (const target of targets) {
            if (!incoming.has(target.id)) incoming.set(target.id, [])
            incoming.get(target.id).push(nodes.find((n) => n.id === sourceId))
        }
    }

    return { nodes, edges, outgoing, incoming, wikilinks }
}

// TTL cache (mirrors the wikilink index cache in markdown-renderer.js)
let graphCache = { at: 0, data: null }
const GRAPH_CACHE_TTL = 15000

export async function getRelationGraphCached(contentManager) {
    const now = Date.now()
    if (graphCache.data && now - graphCache.at < GRAPH_CACHE_TTL) {
        return graphCache.data
    }
    const data = await buildRelationGraph(contentManager)
    graphCache = { at: now, data }
    return data
}

export function clearRelationGraphCache() {
    graphCache = { at: 0, data: null }
}

/**
 * Items that link to the given item (Obsidian-style backlinks).
 * @param {Object} contentManager
 * @param {string} itemId - Frontmatter id of the current item
 * @returns {Promise<Object[]>}
 */
export async function getBacklinks(contentManager, itemId) {
    const graph = await getRelationGraphCached(contentManager)
    return graph.incoming.get(String(itemId)) || []
}

/**
 * Related notes for the given item: outgoing [[wikilinks]] merged with the
 * manually curated relatedPosts (deduplicated by id).
 * @param {Object} contentManager
 * @param {string} itemId - Frontmatter id of the current item
 * @param {Array} [manualRelated=[]] - Items from metadata.relatedPostsData
 * @returns {Promise<Object[]>}
 */
export async function getWikiRelated(contentManager, itemId, manualRelated = []) {
    const graph = await getRelationGraphCached(contentManager)
    const merged = new Map()
    for (const node of graph.outgoing.get(String(itemId)) || []) {
        merged.set(node.id, node)
    }
    for (const item of manualRelated || []) {
        if (item && item.id) merged.set(String(item.id), item)
    }
    return Array.from(merged.values())
}

/**
 * Public graph payload for the /graph page (nodes + edges only, plus stats).
 * @param {Object} contentManager
 * @returns {Promise<{nodes: Object[], edges: Object[], stats: Object}>}
 */
export async function getGraphPayload(contentManager) {
    const graph = await getRelationGraphCached(contentManager)
    return {
        nodes: graph.nodes,
        edges: graph.edges,
        stats: {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            linked: graph.nodes.filter((n) => graph.incoming.has(n.id) || graph.outgoing.has(n.id)).length,
        },
    }
}
