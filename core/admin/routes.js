/**
 * Sets up admin interface routes
 * @param {Object} app - LiteNode app instance
 * @param {Object} options - Configuration options
 */
export function setupAdminRoutes(app, systems) {
    const { themeManager, contentManager, authManager, signedCookies, settingsService, authenticate, analyticsStore } =
        systems

    // Login page
    app.get("/aether/login", async (req, res) => {
        // Check if already logged in using LiteNode's cookie parser
        const token = await signedCookies.getCookie(req, "authToken")

        if (token && (await authManager.verifyToken(token))) {
            return res.redirect("/aether")
        }

        res.render("/core/admin/views/layouts/login.html", {
            title: "Login",
            error: req.queryParams?.get("error"),
            adminLang: await settingsService.getSetting("uiLanguage", "zh"),
            year: new Date().getFullYear(),
        })
    })

    // Login form submission
    app.post("/aether/login", async (req, res) => {
        try {
            const { username, password } = req.body

            if (!username || !password) {
                return res.redirect("/aether/login?error=Username+and+password+are+required")
            }

            const result = await authManager.authenticateUser(username, password)

            if (!result) {
                return res.redirect("/aether/login?error=Invalid+username+or+password")
            }

            // Set auth cookie using LiteNode's API
            await signedCookies.setCookie(res, "authToken", result.token, {
                maxAge: 60 * 60 * 24, // 24 hours
                path: "/",
                httpOnly: true,
                sameSite: "Strict",
            })

            res.redirect("/aether")
        } catch (error) {
            res.redirect(`/aether/login?error=${encodeURIComponent(error.message)}`)
        }
    })

    // Logout
    app.get("/aether/logout", async (req, res) => {
        const token = await signedCookies.getCookie(req, "authToken")

        if (token) {
            await authManager.invalidateToken(token)
        }

        // Clear auth cookie using LiteNode's API
        res.clearCookie("authToken")

        res.redirect("/aether/login")
    })

    // Admin dashboard
    app.get("/aether", authenticate, async (req, res) => {
        try {
            // Get counts for dashboard
            const posts = await contentManager.getPosts()
            const pages = await contentManager.getPages()
            const users = await authManager.getUsers()
            const settings = await settingsService.getSettings()

            // Render dashboard
            res.render("/core/admin/views/layouts/index.html", {
                title: "Dashboard",
                user: req.user,
                counts: {
                    posts: posts.length,
                    pages: pages.length,
                    users: users.length,
                },
                site: settings,
                dashboardIndex: true,
            })
        } catch (error) {
            console.error("Dashboard error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load dashboard</p>")
        }
    })

    // Posts and Pages management page
    app.get("/aether/table/:contentType", authenticate, async (req, res) => {
        try {
            const contentType = req.params.contentType

            // If this is a JSON request (for Tabulator data)
            if (req.headers.accept?.includes("application/json") || req.queryParams?.get("format") === "json") {
                // Get appropriate content data based on contentType
                const data = contentType === "posts" ? await contentManager.getPosts() : await contentManager.getPages()

                // Handle Tabulator data request
                await handleTabulatorRequest(req, res, data)
            } else {
                // Render the Tabulator interface template
                res.render("/core/admin/views/layouts/index.html", {
                    title: contentType,
                    user: req.user,
                    dashboardTable: true,
                    tableContent: contentType,
                    // No need to pass pages or posts data - Tabulator will fetch it via AJAX
                })
            }
        } catch (error) {
            console.error(`${req.params.contentType} page error:`, error)
            if (req.headers.accept?.includes("application/json") || req.queryParams?.get("format") === "json") {
                res.status(500).json({ success: false, error: error.message })
            } else {
                res.status(500).html(`<h1>Error</h1><p>Could not load ${req.params.contentType}</p>`)
            }
        }
    })

    // Handler function for Tabulator data requests
    async function handleTabulatorRequest(req, res, data) {
        // Get settings for default values
        const settings = await settingsService.getSettings()
        const defaultPerPage = settings.postsPerPage || 10

        // Get pagination parameters from Tabulator
        const page = parseInt(req.queryParams?.get("page")) || 1
        const size = parseInt(req.queryParams?.get("size")) || defaultPerPage

        // Calculate pagination
        const totalPosts = data.length
        const totalPages = Math.ceil(totalPosts / size)
        const offset = (page - 1) * size
        const paginatedPosts = data.slice(offset, offset + size)

        // Helper function to generate view URL for pages
        const generatePageViewUrl = (pageData) => {
            const frontmatter = pageData.frontmatter

            // For normal pages, use the standard /page/{slug} format
            if (!frontmatter.pageType || frontmatter.pageType === "normal") {
                return `/page/${frontmatter.slug}`
            }

            // For custom pages, we need to build the nested URL
            if (frontmatter.pageType === "custom") {
                return buildCustomPageUrl(frontmatter.slug, frontmatter.parentPage, data)
            }

            return `/page/${frontmatter.slug}` // fallback
        }

        // Helper function to build custom page URL by traversing the parent chain
        const buildCustomPageUrl = (slug, parentSlug, allPages) => {
            if (!parentSlug) {
                // Root-level custom page
                return `/${slug}`
            }

            // Find the parent page in the data
            const parentPage = allPages.find((page) => page.frontmatter && page.frontmatter.slug === parentSlug)

            if (!parentPage) {
                // Parent not found, treat as root-level
                return `/${slug}`
            }

            // Recursively build the parent URL
            const parentUrl = buildCustomPageUrl(
                parentPage.frontmatter.slug,
                parentPage.frontmatter.parentPage,
                allPages
            )

            return `${parentUrl}/${slug}`
        }

        // Determine if this is a page request to generate proper URLs
        const isPageRequest = req.params.contentType === "pages"

        // Format posts for Tabulator
        const formattedPosts = paginatedPosts.map((post) => ({
            id: post.frontmatter.id,
            title: post.frontmatter.title,
            slug: post.frontmatter.slug,
            author: post.frontmatter.author || "",
            status: post.frontmatter.status || "draft",
            createdAt: post.frontmatter.createdAt,
            updatedAt: post.frontmatter.updatedAt,
            publishDate: post.frontmatter.publishDate || null,
            excerpt: post.frontmatter.excerpt || "",
            // Enhanced fields for pages
            pageType: post.frontmatter.pageType || null,
            parentPage: post.frontmatter.parentPage || null,
            // Generate the correct view URL
            viewUrl: isPageRequest ? generatePageViewUrl(post) : `/post/${post.frontmatter.slug}`,
        }))

        // Return formatted data for Tabulator
        res.json({
            last_page: totalPages,
            data: formattedPosts,
            last_row: totalPosts,
        })
    }

    // Post and Page editor page
    app.get("/aether/:contentType/edit/:id?", authenticate, async (req, res) => {
        try {
            const { contentType, id } = req.params

            let data = { title: "", content: "", status: "draft" }

            if (id) {
                data = contentType === "posts" ? await contentManager.getPost(id) : await contentManager.getPage(id)

                if (!data) {
                    return res.redirect(`/aether/table/${contentType}`)
                }
            }

            res.render("/core/admin/views/layouts/index.html", {
                title:
                    id && contentType === "posts"
                        ? `Edit Post: ${data.title}`
                        : id && contentType === "pages"
                        ? `Edit Page: ${data.title}`
                        : `Add new ${contentType[0].toUpperCase() + contentType.slice(1, 4)}`,
                user: req.user,
                contentType: contentType.slice(0, 4),
                item: data,
                isNew: id ? false : true,
                dashboardEditor: true,
            })
        } catch (error) {
            console.error("Editor error:", error)
            res.status(500).html(`<h1>Error</h1><p>Could not load ${contentType.substring(0, 4)} editor</p>`)
        }
    })

    // Media management page
    app.get("/aether/media", authenticate, async (req, res) => {
        try {
            res.render("/core/admin/views/layouts/index.html", {
                title: "Media Library",
                user: req.user,
                dashboardMedia: true,
            })
        } catch (error) {
            console.error("Media page error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load media library</p>")
        }
    })

    // Theme management page
    app.get("/aether/themes", authenticate, async (req, res) => {
        try {
            const availableThemes = themeManager.getAvailableThemes()
            const activeTheme = themeManager.getActiveTheme()

            res.render("/core/admin/views/layouts/index.html", {
                title: "Themes",
                user: req.user,
                themes: availableThemes,
                activeTheme: activeTheme.name,
                dashboardThemes: true,
            })
        } catch (error) {
            console.error("Themes page error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load themes</p>")
        }
    })

    // Settings page
    app.get("/aether/settings", authenticate, async (req, res) => {
        try {
            // Get all the data needed for the settings page
            // Force reload to ensure we have the latest data
            const settings = await settingsService.getSettings(true)
            const availableThemes = themeManager.getAvailableThemes()
            const activeTheme = themeManager.getActiveTheme()
            const users = await authManager.getUsers()

            // Get the selected theme object
            const selectedTheme = availableThemes.find((theme) => theme.name === settings.activeTheme) || activeTheme

            res.render("/core/admin/views/layouts/index.html", {
                title: "Settings",
                user: req.user,
                settings,
                themes: availableThemes,
                selectedTheme,
                users,
                dashboardSettings: true,
            })
        } catch (error) {
            console.error("Settings page error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load settings</p>")
        }
    })

    // Users management page
    app.get("/aether/users", authenticate, async (req, res) => {
        try {
            // Check if user is admin
            if (req.user?.role !== "admin") {
                return res.redirect("/aether")
            }

            res.render("/core/admin/views/layouts/index.html", {
                title: "User Management",
                user: req.user,
                dashboardUsers: true,
            })
        } catch (error) {
            console.error("Users page error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load users management</p>")
        }
    })

    // Knowledge graph page (rendered inside the admin frame)
    app.get("/aether/graph", authenticate, async (req, res) => {
        try {
            const { getGraphPayload } = await import("../lib/markdown/wiki-relations.js")
            const payload = await getGraphPayload(contentManager, { analyticsStore })
            const graphJson = JSON.stringify(payload).replace(/</g, "\\u003c")

            res.render("/core/admin/views/layouts/index.html", {
                title: "Knowledge Graph",
                user: req.user,
                dashboardGraph: true,
                html_graphJson: graphJson,
                graphStats: payload.stats,
            })
        } catch (error) {
            console.error("Knowledge graph page error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load knowledge graph</p>")
        }
    })

    // Tag cloud page (rendered inside the admin frame), like the knowledge graph.
    app.get("/aether/tag-cloud", authenticate, async (req, res) => {
        try {
            const { getTagFrequency } = await import("../utils/tag-cloud-utils.js")
            const tags = await getTagFrequency(contentManager)
            const json = JSON.stringify(tags).replace(/</g, "\\u003c")

            res.render("/core/admin/views/layouts/index.html", {
                title: "Tag Cloud",
                user: req.user,
                dashboardTagCloud: true,
                html_tagCloudJson: json,
                tagCloudStats: tags.length,
            })
        } catch (error) {
            console.error("Tag cloud page error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load tag cloud</p>")
        }
    })

    // ------------------------------------------------------------------
    // Analytics dashboard (self-hosted first-party statistics)
    // ------------------------------------------------------------------
    app.get("/aether/analytics", authenticate, async (req, res) => {
        try {
            if (!analyticsStore) {
                return res
                    .status(503)
                    .html("<h1>Analytics disabled</h1><p>Set ANALYTICS_ENABLED=true and restart the server.</p>")
            }

            const { buildAnalyticsReport, RANGE_OPTIONS } = await import("../utils/analytics-utils.js")

            const requested = parseInt(req.queryParams?.get("range") || "7")
            const rangeDays = RANGE_OPTIONS.some((o) => o.value === requested) ? requested : 7

            const report = await buildAnalyticsReport(analyticsStore, { days: rangeDays })

            // Keep the ranking table reasonable; the CSV export has the full list.
            const topLimit = 20
            const ranking = report.topContent.slice(0, topLimit).map((item, index) => ({ ...item, rank: index + 1 }))

            res.render("/core/admin/views/layouts/index.html", {
                title: "Analytics",
                user: req.user,
                dashboardAnalytics: true,
                report,
                ranking,
                rankingLimit: topLimit,
                ranges: RANGE_OPTIONS.map((option) => ({
                    days: option.value,
                    label: option.label,
                    active: option.value === rangeDays,
                    href: `/aether/analytics?range=${option.value}`,
                })),
                exportUrl: `/aether/analytics/export.csv?range=${rangeDays}`,
                analyticsJson: JSON.stringify({ series: report.series, totals: report.totals }).replace(/</g, "\\u003c"),
            })
        } catch (error) {
            console.error("Analytics page error:", error)
            res.status(500).html("<h1>Error</h1><p>Could not load analytics</p>")
        }
    })

    // CSV export of the article view ranking for the selected range
    app.get("/aether/analytics/export.csv", authenticate, async (req, res) => {
        try {
            if (!analyticsStore) {
                return res.status(503).json({ error: "Analytics disabled" })
            }
            const { buildAnalyticsReport, reportToCsv } = await import("../utils/analytics-utils.js")
            const days = parseInt(req.queryParams?.get("range") || "30")
            const report = await buildAnalyticsReport(analyticsStore, { days })
            const csv = reportToCsv(report)

            res.setHeader("Content-Type", "text/csv; charset=utf-8")
            res.setHeader("Content-Disposition", `attachment; filename="aether-analytics-${report.range.from}_${report.range.to}.csv"`)
            // BOM keeps Excel happy with UTF-8 (Chinese titles)
            res.end("\uFEFF" + csv)
        } catch (error) {
            console.error("Analytics export error:", error)
            res.status(500).json({ error: "Export failed" })
        }
    })
}
