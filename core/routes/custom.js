import { renderMarkdown, getWikilinkIndexCached } from "../lib/markdown/markdown-renderer.js"
import { enhancedFormatPagination, getSiblingCustomPagesNavigation } from "../utils/pagination-utils.js"
import { prepareTemplateData, processTemplateData, handle404 } from "../utils/route-utils.js"
import { resolveTemplatePath } from "../utils/template-utils.js"
import { detectSearchTemplates, generateSearchIndex, isSearchTemplate } from "../utils/search-utils.js"

export function setupCustomRoutes(app, systems) {
    const { themeManager, contentManager, hookSystem, settingsService, analyticsStore, visitTracker } = systems

    // Smart search detection and index generation
    // This runs once per request cycle and detects if search templates exist
    let searchIndexGenerated = false
    let searchIndexUrl = null
    let searchStats = null

    const detectAndGenerateSearch = async () => {
        if (searchIndexGenerated) return // Only run once per request cycle

        try {
            // Detect if theme has search templates
            const searchTemplates = detectSearchTemplates(themeManager)

            if (searchTemplates.length > 0) {
                console.log(`Detected search templates: ${searchTemplates.map((t) => t.name).join(", ")}`)

                // Generate search index
                const result = await generateSearchIndex(themeManager, contentManager)

                if (result.success) {
                    searchIndexUrl = result.indexUrl
                    searchStats = result.stats
                    console.log(`Search index ready at: ${searchIndexUrl}`)
                }
            }

            searchIndexGenerated = true
        } catch (error) {
            console.error("Error in search detection:", error)
            searchIndexGenerated = true // Prevent retries
        }
    }

    // Match up to 3 levels of nested paths (e.g., /docs, /docs/intro, /docs/api/examples)
    // The first segment (:path) is required
    // The second (:subpath) and third (:subSubPath) are optional
    app.get("/:path/:subpath?/:subSubPath?", async (req, res) => {
        // Run search detection first
        await detectAndGenerateSearch()

        // Destructure the path segments from the route parameters
        let { path, subpath, subSubPath } = req.params

        // litenode does not URL-decode route params; decode segments that may
        // contain non-ASCII (e.g. Chinese) custom-page slugs/paths.
        const dec = (v) => {
            if (v === undefined) return v
            try { return decodeURIComponent(v) } catch { return v }
        }
        path = dec(path)
        subpath = dec(subpath)
        subSubPath = dec(subSubPath)

        // Combine the segments into a single path string
        // - Create an array with the segments
        // - Remove any undefined or falsy values (e.g., if subpath or subSubPath are missing)
        // - Join the remaining segments with slashes to form a full path
        const fullPath = [path, subpath, subSubPath].filter(Boolean).join("/")

        // Skip processing for paths handled by other routes
        const skipPaths = ["aether", "api", "post", "page", "rss", "rss.xml", "sitemap", "sitemap.html", "sitemap.xml"]
        if (skipPaths.includes(path)) {
            return
        }

        try {
            let contentPage = null
            let parentPage = null
            let templatePath = null
            let customPath = path

            // First, try to find a direct match for the full path
            if (subpath) {
                // Try to find the parent page
                parentPage = await contentManager.getContentByProperty("page", "slug", path)

                if (
                    parentPage &&
                    parentPage.frontmatter.status === "published" &&
                    parentPage.frontmatter.pageType === "custom"
                ) {
                    // Look for the child page
                    if (subSubPath) {
                        // For three-level paths, check if subpath is an intermediate parent
                        const intermediatePage = await contentManager.getContentByProperty("page", "slug", subpath, {
                            parentPage: path,
                        })

                        if (
                            intermediatePage &&
                            intermediatePage.frontmatter.parentPage === path &&
                            intermediatePage.frontmatter.status === "published" &&
                            intermediatePage.frontmatter.pageType === "custom"
                        ) {
                            // Look for the final child page
                            contentPage = await contentManager.getContentByProperty("page", "slug", subSubPath, {
                                parentPage: subpath,
                            })

                            if (
                                contentPage &&
                                contentPage.frontmatter.parentPage === subpath &&
                                contentPage.frontmatter.status === "published" &&
                                contentPage.frontmatter.pageType === "custom"
                            ) {
                                customPath = `${path}-${subpath}-${subSubPath}`
                            } else {
                                // There is no Markdown file in content/data/custom with a slug matching subSubPath
                                return handle404(res, req, themeManager, settingsService)
                            }
                        }
                    } else {
                        // Two-level path, look for direct child
                        contentPage = await contentManager.getContentByProperty("page", "slug", subpath, {
                            parentPage: path,
                        })

                        if (
                            contentPage &&
                            contentPage.frontmatter.parentPage === path &&
                            contentPage.frontmatter.status === "published" &&
                            contentPage.frontmatter.pageType === "custom"
                        ) {
                            customPath = `${path}-${subpath}`
                        } else {
                            // There is no Markdown file in content/data/custom with a slug matching subpath
                            return handle404(res, req, themeManager, settingsService)
                        }
                    }
                }
            } else {
                // Single-level path, look for direct match
                contentPage = await contentManager.getContentByProperty("page", "slug", path)
            }

            // If no nested page found, try single-level custom page
            if (!contentPage) {
                contentPage = await contentManager.getContentByProperty("page", "slug", path)
                customPath = path
            }

            // Check if we found a published custom page
            const hasContentPage =
                contentPage &&
                contentPage.frontmatter.status === "published" &&
                contentPage.frontmatter.pageType === "custom"

            if (!hasContentPage) {
                return handle404(res, req, themeManager, settingsService)
            }

            // Resolve the appropriate template
            templatePath = await resolveTemplatePath({
                themeManager,
                contentType: "custom",
                slug: customPath,
                isCustomPage: true,
            })

            if (!templatePath || templatePath === themeManager.getTemplatePath("layout.html")) {
                return handle404(res, req, themeManager, settingsService)
            }

            // Get site settings
            const siteSettings = await contentManager.getSiteSettings()

            // Add sibling navigation for nested custom pages
            const siblingNavigation = await getSiblingCustomPagesNavigation(contentPage, contentManager, req)

            // Base template data
            let baseTemplateData = {
                customPath: fullPath,
                year: new Date().getFullYear(),
                isCustomTemplate: true,
            }

            // Check if this is a search template and add search functionality
            if (isSearchTemplate(templatePath) && searchIndexUrl) {
                baseTemplateData.isSearchPage = true
                baseTemplateData.searchIndexUrl = searchIndexUrl
                baseTemplateData.searchStats = searchStats
                baseTemplateData.hasSearchIndex = true

                console.log(`Search page detected: ${customPath}`)
            }

            // Add the content page data
            let templateData = {
                ...baseTemplateData,
                content: renderMarkdown(contentPage.content, {
                    wikilinks: await getWikilinkIndexCached(contentManager),
                }),
                metadata: contentPage.frontmatter,
                fileType: "page",
                contentRoute: true,
                contentId: contentPage.frontmatter.id,
                isCustomPage: true,
                viewCount: analyticsStore
                    ? analyticsStore.viewCountFor({
                          id: contentPage.frontmatter.id,
                          slug: contentPage.frontmatter.slug,
                          path: `/${contentPage.frontmatter.slug}`,
                      })
                    : 0,
                // Add parent page data if it exists
                parentPage: parentPage
                    ? {
                          title: parentPage.frontmatter.title,
                          slug: parentPage.frontmatter.slug,
                      }
                    : null,
                siblingNavigation: siblingNavigation,
            }

            // Determine if this template needs pagination
            const paginatedTemplates = new Set(["blog", "archive", "articles", "news"])
            const needsPagination = paginatedTemplates.has(path) || paginatedTemplates.has(customPath)

            // Determine if this template needs taxonomy counts
            const templateWithTaxonomyCounts = new Set(["categories", "tags", "topics"])
            const needsTaxonomyCounts =
                templateWithTaxonomyCounts.has(path) || templateWithTaxonomyCounts.has(customPath)

            // Add pagination if needed
            if (needsPagination) {
                // Get all published posts with summaryView
                const allPosts = await contentManager.getPosts({
                    status: "published",
                    summaryView: true,
                    previewLength: 300, // Optional defaults to a maximum 300 characters, roughly 40-55 words.
                })

                // Handle pagination
                const page = parseInt(req.queryParams?.get("page") || "1")
                const perPage = parseInt(req.queryParams?.get("pageSize") || siteSettings.postsPerPage || "10")
                const pagination = await app.paginateMarkdownFiles(allPosts, page, perPage)

                // Convert frontmatter to metadata for all posts
                const paginatedPosts = contentManager.renameKey(pagination.data, "frontmatter", "metadata")

                // Analytics: view counts on the paginated cards
                if (analyticsStore) {
                    for (const post of paginatedPosts) {
                        post.metadata.viewCount = analyticsStore.viewCountFor({
                            id: post.metadata.id,
                            slug: post.metadata.slug,
                            path: `/notes/${post.metadata.slug}`,
                        })
                    }
                }

                // Add pagination data to template with enhanced URLs
                templateData.posts = paginatedPosts
                templateData.pagination = enhancedFormatPagination(pagination, {
                    isGenerateStatic: false,
                    contentType: "custom",
                    slug: fullPath,
                    cleanUrls: false,
                })
            }

            // Add taxonomy counts if needed
            if (needsTaxonomyCounts) {
                if (path === "categories" || customPath === "categories") {
                    // Extract category data from all posts
                    const posts = await contentManager.getPosts({ status: "published", frontmatterOnly: true })

                    const groupedByCategory = await app.groupByMarkdownProperty(
                        posts,
                        ["title", "slug", "id", "category"],
                        "category"
                    )

                    const categoriesWithCounts = Object.entries(groupedByCategory)
                        .filter(
                            ([category]) => category && category.toLowerCase() !== "undefined" && category.trim() !== ""
                        )
                        .map(([category, posts]) => ({
                            name: category,
                            slug: contentManager.slugify(category),
                            count: posts.length,
                            posts,
                        }))

                    templateData.categories = categoriesWithCounts
                    templateData.taxonomies = categoriesWithCounts
                    templateData.taxonomiesType = "categories"
                    templateData.taxonomyType = "category"
                    templateData.hasTaxonomyData = true
                } else if (path === "tags" || customPath === "tags") {
                    // Handle tags
                    const posts = await contentManager.getPosts({ status: "published", frontmatterOnly: true })

                    // Create a map to count tags
                    const tagCounts = new Map()

                    // Process each post to count tags
                    posts.forEach((post) => {
                        const tags = post.frontmatter.tags
                        if (tags) {
                            // Handle different tag formats (string, array)
                            const tagArray = Array.isArray(tags)
                                ? tags
                                : typeof tags === "string"
                                ? tags.split(",").map((t) => t.trim())
                                : []

                            tagArray.forEach((tag) => {
                                if (tag) {
                                    const count = tagCounts.get(tag) || 0
                                    tagCounts.set(tag, count + 1)
                                }
                            })
                        }
                    })

                    // Convert map to array for template
                    const tagsWithCounts = Array.from(tagCounts.entries()).map(([tag, count]) => ({
                        name: tag,
                        slug: contentManager.slugify(tag),
                        count: count,
                    }))

                    templateData.tags = tagsWithCounts
                    templateData.taxonomies = tagsWithCounts
                    templateData.taxonomiesType = "tags"
                    templateData.taxonomyType = "tag"
                    templateData.hasTaxonomyData = true
                }
            }

            // Always provide recentPosts for sidebar/related content
            if (!needsPagination) {
                const recentPosts = await contentManager.getPosts({
                    frontmatterOnly: true,
                    status: "published",
                    limit: 5,
                })
                templateData.recentPosts = recentPosts
            }

            // Add breadcrumb navigation for nested pages
            if (subpath) {
                // Parent (level 0)
                const breadcrumbs = [{ title: parentPage?.frontmatter.title || path, slug: `/${path}`, order: 0 }]

                // Intermediate (level 1, optional)
                if (subSubPath && parentPage) {
                    // Add intermediate breadcrumb if exists
                    const intermediatePage = await contentManager.getContentByProperty("page", "slug", subpath, {
                        parentPage: path,
                    })
                    if (intermediatePage) {
                        breadcrumbs.push({
                            title: intermediatePage.frontmatter.title || subpath,
                            slug: `/${path}/${subpath}`,
                            order: 1,
                        })
                    }
                }

                // Current page (level 2 or 1)
                breadcrumbs.push({
                    title: contentPage.frontmatter.title || subSubPath || subpath,
                    slug: `/${fullPath}`,
                    active: true,
                    order: breadcrumbs.length, // This will be 1 or 2 depending on above
                })

                templateData.breadcrumbs = breadcrumbs
            }

            // Prepare full template data with all the site context (menus, theme info, etc.)
            const fullTemplateData = await prepareTemplateData(req, themeManager, siteSettings, templateData)

            // Analytics: attribute this visit to the custom page
            visitTracker?.markContent(res, {
                id: contentPage.frontmatter.id,
                slug: contentPage.frontmatter.slug,
                type: "page",
                title: contentPage.frontmatter.title,
            })

            // Process data through hooks
            const processedData = processTemplateData(hookSystem, fullTemplateData, `${customPath}.html`)

            // Render the template
            res.render(templatePath, processedData)
        } catch (error) {
            console.error(`Custom template render error:`, error)
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering custom template</p>")
        }
    })
}
