/**
 * Search utilities for theme-based search functionality
 */
import { join } from "node:path"
import { existsSync } from "node:fs"
import { ensureDirectory, writeJsonFile } from "../lib/theme/utils/file-utils.js"
import { markdownToPlainText } from "../lib/content/utils/content-utils.js"

/**
 * Detects search templates in the active theme
 * @param {Object} themeManager - Theme manager instance
 * @returns {Array} Array of detected search templates
 */
export function detectSearchTemplates(themeManager) {
    if (!themeManager.activeTheme) {
        return []
    }

    const searchTemplateNames = ["search.html", "find.html", "lookup.html"]
    const detectedTemplates = []

    for (const templateName of searchTemplateNames) {
        // Check in custom directory first
        const customTemplatePath = themeManager.getCustomTemplatePath("custom", templateName)
        if (existsSync(customTemplatePath)) {
            detectedTemplates.push({
                name: templateName.replace(".html", ""),
                path: customTemplatePath,
                type: "custom",
            })
            continue
        }

        // Check in main templates directory
        const mainTemplatePath = themeManager.getTemplatePath(templateName)
        if (existsSync(mainTemplatePath)) {
            detectedTemplates.push({
                name: templateName.replace(".html", ""),
                path: mainTemplatePath,
                type: "main",
            })
        }
    }

    return detectedTemplates
}

/**
 * Builds the correct path for nested custom pages
 * @param {Object} page - Page object with frontmatter
 * @param {Array} allPages - Array of all pages for parent resolution
 * @returns {string} Full path for the page
 */
function buildPagePath(page, allPages) {
    const parentChain = []
    let currentPage = page

    // Traverse up the parent chain
    while (currentPage.frontmatter.parentPage) {
        const parent = allPages.find((p) => p.frontmatter.slug === currentPage.frontmatter.parentPage)
        if (!parent) break

        parentChain.unshift(parent.frontmatter.slug)
        currentPage = parent
    }

    // Build full path with parent chain
    return `/${[...parentChain, page.frontmatter.slug].join("/")}`
}

/**
 * Transforms posts into search index format
 * @param {Array} posts - Array of posts from content manager
 * @returns {Array} Array of search-formatted post objects
 */
function transformPostsForSearch(posts) {
    return posts.map((post) => {
        const metadata = post.frontmatter || post.metadata
        return {
            id: metadata.id,
            title: metadata.title || "Untitled Post",
            path: `/post/${metadata.slug}`,
            content: markdownToPlainText(metadata.excerpt || metadata.seoDescription || ""),
            excerpt: markdownToPlainText(metadata.excerpt || ""),
            type: "post",
            category: metadata.category || null,
            tags: Array.isArray(metadata.tags)
                ? metadata.tags
                : typeof metadata.tags === "string"
                ? metadata.tags.split(",").map((t) => t.trim())
                : [],
            publishDate: metadata.publishDate || metadata.createdAt,
            author: metadata.author || "Unknown",
        }
    })
}

/**
 * Transforms custom pages into search index format
 * @param {Array} pages - Array of custom pages from content manager
 * @returns {Array} Array of search-formatted page objects
 */
function transformPagesForSearch(pages) {
    return pages.map((page) => {
        const frontmatter = page.frontmatter
        return {
            id: frontmatter.id,
            title: frontmatter.title || "Untitled Page",
            path: buildPagePath(page, pages),
            content: markdownToPlainText(frontmatter.excerpt || frontmatter.seoDescription || ""),
            excerpt: markdownToPlainText(frontmatter.excerpt || ""),
            type: "page",
            parentPage: frontmatter.parentPage || null,
            publishDate: frontmatter.publishDate || frontmatter.createdAt,
            author: frontmatter.author || "Unknown",
        }
    })
}

/**
 * Generates search index and saves it to the active theme's assets folder
 * @param {Object} themeManager - Theme manager instance
 * @param {Object} contentManager - Content manager instance
 * @returns {Promise<Object>} Result object with success status and details
 */
export async function generateSearchIndex(themeManager, contentManager) {
    try {
        if (!themeManager.activeTheme) {
            console.warn("No active theme found for search index generation")
            return { success: false, error: "No active theme" }
        }

        // Get all published posts with minimal data for performance
        const allPosts = await contentManager.getPosts({
            status: "published",
            frontmatterOnly: true,
        })

        // Get all published custom pages with minimal data
        const allCustomPages = await contentManager.getPages({
            status: "published",
            pageType: "custom",
            frontmatterOnly: true,
        })

        // Transform data for search index
        const postsSearchData = transformPostsForSearch(allPosts)
        const pagesSearchData = transformPagesForSearch(allCustomPages)

        // Combine and sort by publish date (newest first)
        const searchIndex = [...postsSearchData, ...pagesSearchData]
        searchIndex.sort((a, b) => new Date(b.publishDate || 0) - new Date(a.publishDate || 0))

        // Create search index with metadata
        const searchIndexData = {
            meta: {
                generatedAt: new Date().toISOString(),
                totalItems: searchIndex.length,
                totalPosts: postsSearchData.length,
                totalPages: pagesSearchData.length,
                themeName: themeManager.activeTheme.name,
                version: "1.0.0",
            },
            index: searchIndex,
        }

        // Ensure assets/json directory exists in the active theme
        const jsonAssetsDir = join(themeManager.activeTheme.path, "assets", "json")
        await ensureDirectory(jsonAssetsDir)

        // Write search index file
        const searchIndexPath = join(jsonAssetsDir, "search-index.json")
        const success = await writeJsonFile(searchIndexPath, searchIndexData, true)

        if (success) {
            console.log(`Search index generated: ${searchIndex.length} items written to theme assets`)
            return {
                success: true,
                indexUrl: `/themes/${themeManager.activeTheme.name}/assets/json/search-index.json`,
                stats: searchIndexData.meta,
                filePath: searchIndexPath,
            }
        } else {
            console.error("Failed to write search index file")
            return { success: false, error: "Failed to write search index file" }
        }
    } catch (error) {
        console.error("Error generating search index:", error)
        return { success: false, error: error.message }
    }
}

/**
 * Checks if a template path corresponds to a search template
 * @param {string} templatePath - Path to the template file
 * @returns {boolean} True if it's a search template
 */
export function isSearchTemplate(templatePath) {
    const searchTemplateNames = ["search.html", "find.html", "lookup.html"]
    return searchTemplateNames.some((name) => templatePath.includes(name))
}

/**
 * Gets the search index URL for the active theme
 * @param {Object} themeManager - Theme manager instance
 * @returns {string|null} URL to search index or null if no active theme
 */
export function getSearchIndexUrl(themeManager) {
    if (!themeManager.activeTheme) {
        return null
    }
    return `/themes/${themeManager.activeTheme.name}/assets/json/search-index.json`
}

/**
 * Checks if search index file exists for the active theme
 * @param {Object} themeManager - Theme manager instance
 * @returns {boolean} True if search index file exists
 */
export function searchIndexExists(themeManager) {
    if (!themeManager.activeTheme) {
        return false
    }

    const searchIndexPath = join(themeManager.activeTheme.path, "assets", "json", "search-index.json")
    return existsSync(searchIndexPath)
}
