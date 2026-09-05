import { enhancedFormatPagination } from "../utils/pagination-utils.js"
import { prepareTemplateData, processTemplateData, handle404 } from "../utils/route-utils.js"
import { resolveTemplatePath, applyTemplateMetadata } from "../utils/template-utils.js"
import { getTagFrequency } from "../utils/tag-cloud-utils.js"
import { slugify } from "../lib/content/utils/content-utils.js"

/**
 * Tag workbench helpers — shared by the single-tag route (/tag/:slug) and the
 * multi-tag combination route (/tags/a/b/…).
 *
 * Panel model (kept small as the site grows):
 *   - ACTIVE chips: the currently selected tags (always few) — click removes.
 *   - FACET chips:  tags that appear INSIDE the current result set only, each
 *     with the count of posts you would get if you added it (AND). Tags that
 *     cannot narrow the current result never appear, so the panel stays
 *     proportional to the results instead of the whole tag universe.
 */

// How many facet chips to show before collapsing behind "show all".
const FACET_LIMIT = 24

// Decode one URL segment (litenode does not decode route params).
function decodeSegment(value) {
    if (value === undefined || value === null) return ""
    try {
        return decodeURIComponent(value)
    } catch {
        return String(value)
    }
}

// Normalise raw path segments into canonical tag slugs: decode → trim →
// slugify (lowercases ASCII, e.g. "Obsidian" → "obsidian") → dedupe.
function normalizeSlugs(list) {
    return Array.from(new Set(list.map((s) => slugify(decodeSegment(s))).filter(Boolean)))
}

// Read the tags of one content item's frontmatter into an array of names.
function getFrontmatterTags(frontmatter) {
    const rawTags = frontmatter?.tags
    if (Array.isArray(rawTags)) {
        return rawTags.map((t) => String(t))
    }
    if (typeof rawTags === "string" && rawTags.trim() !== "") {
        return rawTags.split(",").map((t) => t.trim()).filter(Boolean)
    }
    return []
}

/**
 * Build the ACTIVE chips (currently selected tags) + tag lookup maps from the
 * site-wide tag universe (for canonical display names).
 */
function buildActiveTags(allTags, activeSlugs) {
    const bySlug = new Map(allTags.map((t) => [t.slug, t]))
    const byNameLower = new Map(allTags.map((t) => [t.name.toLowerCase(), t]))
    const activeTags = activeSlugs.map((slug) => {
        const opt = bySlug.get(slug)
        return {
            name: opt ? opt.name : slug,
            slug,
            href: removeHrefFor(activeSlugs, slug),
        }
    })
    return { activeTags, bySlug, byNameLower }
}

// URL to remove one slug from the selection (empty selection → tag cloud).
function removeHrefFor(activeSlugs, slug) {
    const rest = activeSlugs.filter((s) => s !== slug)
    return rest.length > 0 ? `/tags/${rest.join("/")}` : "/tag-cloud"
}

/**
 * FACET chips: tags that occur in the CURRENT result posts (excluding tags
 * already selected), each counting how many result posts carry it — i.e. the
 * size of the intersection you get by adding that tag.
 *
 * @returns {{ facets: Array<{name,slug,count}> }}
 */
function buildFacetChips(resultPosts, byNameLower, activeSlugs) {
    const activeSet = new Set(activeSlugs)
    const comboPath = activeSlugs.join("/")
    const addHref = (slug) => `/tags/${comboPath ? `${comboPath}/` : ""}${slug}`
    const counts = new Map() // slug -> { name, slug, count, href }

    for (const post of resultPosts) {
        const fm = post.frontmatter || {}
        const seenInPost = new Set()
        for (const rawName of getFrontmatterTags(fm)) {
            if (!rawName) continue
            const known = byNameLower.get(rawName.toLowerCase())
            const name = known ? known.name : rawName
            const slug = known ? known.slug : slugify(rawName)
            if (activeSet.has(slug) || seenInPost.has(slug)) continue
            seenInPost.add(slug)
            const entry = counts.get(slug) || { name, slug, count: 0, href: addHref(slug) }
            entry.count += 1
            counts.set(slug, entry)
        }
    }

    const facets = Array.from(counts.values()).sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    )
    return facets
}

/**
 * Attach clickable tag chips (tagsView) to every paginated post card.
 * Each chip adds/removes the tag to/from the current combination. Counts use
 * the facet value (narrowed result size) where available.
 */
function attachCardTagChips(posts, byNameLower, bySlug, activeSlugs, facetCounts) {
    const activeSet = new Set(activeSlugs)
    const comboPath = activeSlugs.join("/")
    const removeHrefFor = (slug) => {
        const rest = activeSlugs.filter((s) => s !== slug)
        return rest.length > 0 ? `/tags/${rest.join("/")}` : "/tag-cloud"
    }

    for (const post of posts) {
        const meta = post.metadata || post.frontmatter || {}
        const tagsView = []
        const seen = new Set()
        for (const rawName of getFrontmatterTags(meta)) {
            if (!rawName || seen.has(rawName.toLowerCase())) continue
            seen.add(rawName.toLowerCase())
            const known = byNameLower.get(rawName.toLowerCase())
            const name = known ? known.name : rawName
            const slug = known ? known.slug : slugify(rawName)
            const active = activeSet.has(slug)
            const count = active ? 0 : facetCounts?.get(slug) ?? (bySlug.get(slug)?.count ?? 0)
            tagsView.push({
                name,
                slug,
                count,
                active,
                href: active
                    ? removeHrefFor(slug)
                    : `/tags/${comboPath ? `${comboPath}/` : ""}${slug}`,
            })
        }
        post.tagsView = tagsView
    }
}

/**
 * Render the tag workbench for ANY number of selected tags (1..n, AND).
 * Used by both GET /tag/:slug and GET /tags/:slug1/:slug2/…
 */
async function renderTagCombination(app, req, res, systems, rawSlugs) {
    const { themeManager, contentManager, hookSystem, settingsService } = systems

    try {
        const slugs = normalizeSlugs(rawSlugs)
        if (slugs.length === 0) {
            return handle404(res, req, themeManager, settingsService)
        }

        // Tag universe = tags of published posts (same source as /tag-cloud),
        // used only to resolve canonical names and reject unknown slugs.
        const allTags = await getTagFrequency(contentManager)
        const knownSlugs = new Set(allTags.map((t) => t.slug))
        for (const s of slugs) {
            if (!knownSlugs.has(s)) {
                return handle404(res, req, themeManager, settingsService)
            }
        }

        // AND filter: posts carrying every selected tag (slug-normalised).
        const allTaxonomyPosts = await contentManager.getPostsByTagCombination(slugs, {
            status: "published",
            summaryView: true,
            previewLength: 200,
        })

        // Site settings & pagination
        const siteSettings = await contentManager.getSiteSettings()
        const page = parseInt(req.queryParams?.get("page") || "1")
        const perPage = parseInt(req.queryParams?.get("pageSize") || siteSettings.postsPerPage || "10")

        // Panel model: active chips + result-scoped facet chips. Computed from
        // the raw result items BEFORE renameKey below (renameKey renames the
        // "frontmatter" key in place on the very same objects).
        const { activeTags, bySlug, byNameLower } = buildActiveTags(allTags, slugs)
        const facetChips = buildFacetChips(allTaxonomyPosts, byNameLower, slugs)
        const facetCounts = new Map(facetChips.map((f) => [f.slug, f.count]))

        // Collapse long facet lists behind "show all"
        const showAll = String(req.queryParams?.get("showAll") || "") === "1"
        const visibleFacets = showAll ? facetChips : facetChips.slice(0, FACET_LIMIT)
        const hiddenFacetCount = facetChips.length - visibleFacets.length

        const pagination = await app.paginateMarkdownFiles(allTaxonomyPosts, page, perPage)

        // Convert frontmatter to metadata for the templates
        const paginatedPosts = contentManager.renameKey(pagination.data, "frontmatter", "metadata")

        // Card chips (page-scoped)
        attachCardTagChips(paginatedPosts, byNameLower, bySlug, slugs, facetCounts)

        const displayTerm = activeTags.map((t) => t.name).join(" × ")

        // Build base template data
        let templateData = await prepareTemplateData(req, themeManager, siteSettings, {
            posts: paginatedPosts,
            fileType: "tag",
            taxonomyType: "tag",
            taxonomyTerm: displayTerm,
            tagName: displayTerm,
            taxonomyRoute: true,
            // Tag workbench context
            tagFilterActive: true,
            tagSlugs: slugs,
            tagSlugsPath: slugs.join("/"),
            tagActiveChips: activeTags,
            tagFacetChips: visibleFacets,
            tagFacetTotal: facetChips.length,
            tagFacetHidden: hiddenFacetCount,
            tagFacetShowAll: showAll,
            tagResultCount: allTaxonomyPosts.length,
            pagination:
                pagination.total_pages > 0
                    ? enhancedFormatPagination(pagination, {
                          isGenerateStatic: false,
                          contentType: "tags",
                          slug: slugs.join("/"),
                          cleanUrls: false,
                      })
                    : null,
            year: new Date().getFullYear(),
        })

        // Resolve the template path (single-tag keeps slug-specific lookups;
        // combinations only use the generic tag/custom template).
        const templatePath = await resolveTemplatePath({
            themeManager,
            contentType: "tag",
            slug: slugs.length === 1 ? slugs[0] : "",
            isTaxonomy: true,
        })

        // Apply template metadata (title/description based on the combination)
        const enhancedTemplateData = await applyTemplateMetadata({
            templatePath,
            contentManager,
            templateData,
            taxonomyType: "tag",
            taxonomyTerm: displayTerm,
            itemCount: allTaxonomyPosts.length,
            page,
        })

        // Process data through hooks
        const processedData = processTemplateData(hookSystem, enhancedTemplateData, "tag.html")

        res.render(templatePath, processedData)
    } catch (err) {
        console.error(`Tag workbench render error (${rawSlugs?.join("/")}):`, err)
        res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering tag list</p>")
    }
}

export function setupTaxonomyRoutes(app, systems) {
    const { themeManager, contentManager, hookSystem, settingsService } = systems

    // Handle category routes: /category/:slug
    app.get("/category/:slug", async (req, res) => {
        // litenode does not URL-decode route params (Chinese percent-encoding
        // arrives as e.g. '%E5%AE...'), so decode before matching content.
        let slug = req.params.slug
        try {
            slug = decodeURIComponent(slug)
        } catch {
            // keep raw if malformed
        }

        try {
            // Get posts for this category with summaryView enabled
            const allTaxonomyPosts = await contentManager.getPostsByCategory(slug, {
                summaryView: true,
                previewLength: 200, // Slightly shorter preview for taxonomy pages
            })

            if (!allTaxonomyPosts || allTaxonomyPosts.length === 0) {
                return handle404(res, req, themeManager, settingsService)
            }

            // Get site settings
            const siteSettings = await contentManager.getSiteSettings()

            // Handle pagination
            const page = parseInt(req.queryParams?.get("page") || "1")
            const perPage = parseInt(req.queryParams?.get("pageSize") || siteSettings.postsPerPage || "10")
            const pagination = await app.paginateMarkdownFiles(allTaxonomyPosts, page, perPage)

            // Convert frontmatter to metadata for all posts
            const paginatedPosts = contentManager.renameKey(pagination.data, "frontmatter", "metadata")

            // Build base template data
            let templateData = await prepareTemplateData(req, themeManager, siteSettings, {
                posts: paginatedPosts,
                fileType: "category",
                taxonomyType: "category",
                taxonomyTerm: slug,
                pagination: enhancedFormatPagination(pagination, {
                    isGenerateStatic: false,
                    contentType: "category",
                    slug: slug,
                    cleanUrls: false,
                }),
                taxonomyRoute: true,
                categoryName: slug,
                year: new Date().getFullYear(),
            })

            // Resolve the template path
            const templatePath = await resolveTemplatePath({
                themeManager,
                contentType: "category",
                slug: slug, // Pass the slug to enable slug-specific templates
                isTaxonomy: true,
            })

            // Apply template metadata using our new utility function
            const enhancedTemplateData = await applyTemplateMetadata({
                templatePath,
                contentManager,
                templateData,
                taxonomyType: "category",
                taxonomyTerm: slug,
                itemCount: allTaxonomyPosts.length,
                page,
            })

            // Process data through hooks
            const processedData = processTemplateData(hookSystem, enhancedTemplateData, "category.html")

            res.render(templatePath, processedData)
        } catch (err) {
            console.error(`Category render error for ${slug}:`, err)
            res.status(500).html("<h1>500 - Server Error</h1><p>Error rendering category</p>")
        }
    })

    // Tag workbench: /tags/:slug1/:slug2/… (AND combination, arbitrary depth)
    app.get("/tags/**", async (req, res) => {
        // litenode captures the whole remaining path under req.params["**"].
        const slugs = normalizeSlugs(String(req.params?.["**"] || "").split("/"))
        if (slugs.length === 0) {
            return handle404(res, req, themeManager, settingsService)
        }
        return renderTagCombination(app, req, res, systems, slugs)
    })

    // Tag workbench entry: legacy single-tag route /tag/:slug — same UI, one
    // tag pre-selected. Backwards compatible with hashtags / tag-cloud links.
    app.get("/tag/:slug", async (req, res) => {
        return renderTagCombination(app, req, res, systems, [req.params.slug])
    })
}
