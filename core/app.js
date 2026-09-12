// Import route setups
import { setupFrontendRoutes } from "./routes/index.js"
import { setupAdminRoutes } from "./admin/routes.js"

// Import API routes
import { setupContentApi } from "./api/content-api.js"
import { setupMediaApi } from "./api/media-api.js"
import { setupThemeApi } from "./api/theme-api.js"
import { setupUserApi } from "./api/user-api.js"
import { setupStaticApi } from "./api/static-api.js"

// Import core libraries
import { ThemeManager } from "./lib/theme/theme-manager.js"
import { ContentManager } from "./lib/content/content-manager.js"
import { HookSystem } from "./lib/hooks.js"
import { FileStorage } from "./lib/store/file-storage.js"
import { AuthManager } from "./lib/auth/auth-manager.js"
import { SettingsService } from "./lib/settings-service.js"
import { GlobalMenuManager } from "./lib/global-menu-manager.js"
import { AnalyticsStore } from "./lib/analytics/analytics-store.js"
import { VisitTracker } from "./lib/analytics/visit-tracker.js"

// Import utilities
import { handle404, handle500 } from "./utils/route-utils.js"
import { setupContentOptimizationHooks } from "./utils/hook-utils.js"
import { join } from "node:path"

// Global instances
let themeManager
let contentManager
let hookSystem
let fileStorage
let authManager
let settingsService
let menuManager
let analyticsStore
let visitTracker

/** Read a boolean-ish environment variable. */
function envFlag(name, defaultValue) {
    const raw = process.env[name]
    if (raw === undefined || raw === "") return defaultValue
    return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

export async function setupApp(app, config) {
    // Enable cookie parser
    app.enableCookieParser()

    // Create signed cookies utility. The signing secret MUST come from the
    // environment (COOKIE_SECRET). A hardcoded secret is a security risk, so we
    // only fall back to a clearly-marked dev value and warn loudly.
    const cookieSecret = process.env.COOKIE_SECRET || "insecure-dev-secret-change-me"
    if (!process.env.COOKIE_SECRET) {
        console.warn(
            "[aether] COOKIE_SECRET is not set — using an insecure fallback. Set COOKIE_SECRET in .env in production."
        )
    }
    const signedCookies = app.createSignedCookies(cookieSecret)

    // Initialize core systems in proper sequence
    hookSystem = new HookSystem()
    fileStorage = new FileStorage(config.uploadsDir)
    authManager = new AuthManager(config.dataDir)

    // Initialize the built-in analytics (self-hosted, file based). Only a
    // masked client IP plus a salted hash is ever stored — see visit-tracker.js.
    const analyticsEnabled = envFlag("ANALYTICS_ENABLED", true)
    if (analyticsEnabled) {
        analyticsStore = new AnalyticsStore({
            dir: process.env.ANALYTICS_DIR || join(config.dataDir, "analytics"),
            salt: process.env.ANALYTICS_SALT || "",
            retentionDays: Number(process.env.ANALYTICS_RETENTION_DAYS || 180),
        })
        await analyticsStore.initialize()

        visitTracker = new VisitTracker({
            store: analyticsStore,
            trustProxy: envFlag("ANALYTICS_TRUST_PROXY", false),
            excludeAdmins: envFlag("ANALYTICS_EXCLUDE_ADMINS", true),
            dedupWindowMs: Number(process.env.ANALYTICS_DEDUP_MINUTES || 30) * 60 * 1000,
            authManager,
            signedCookies,
        })
    } else {
        console.log("[aether] analytics disabled (ANALYTICS_ENABLED=false)")
    }

    // Initialize settings service first
    settingsService = new SettingsService(config.dataDir)
    await settingsService.initialize()

    // Initialize the global menu manager
    menuManager = new GlobalMenuManager(config.dataDir)
    await menuManager.initialize()

    // Then initialize content manager with the settings service
    contentManager = new ContentManager(config.dataDir, app, settingsService)
    await contentManager.initialize()

    // Finally initialize theme manager with settings service and menu manager
    themeManager = new ThemeManager(config.themesDir, settingsService, menuManager)
    await themeManager.initialize()

    // Add a charset to text/* responses so non-ASCII content (e.g. Chinese)
    // is not mis-decoded by the browser when no charset is declared.
    // This patches res.setHeader so that render/html/txt calls — which set
    // "Content-Type: text/html" etc. — automatically get "; charset=utf-8".
    app.use(async (req, res) => {
        const originalSetHeader = res.setHeader.bind(res)
        res.setHeader = (name, value) => {
            const lowerName = typeof name === "string" ? name.toLowerCase() : name

            // Modern admin JS/CSS is cached aggressively (max-age=86400) in
            // production, which causes stale-admin-scripts issues after
            // updates. Disable caching for admin static assets so the browser
            // always picks up the latest admin code.
            if (typeof req.url === "string" && req.url.startsWith("/core/admin/static")) {
                if (lowerName === "cache-control") {
                    value = "no-cache, no-store, must-revalidate"
                }
                if (lowerName === "expires") {
                    value = "0"
                }
                return originalSetHeader(name, value)
            }

            if (
                lowerName === "content-type" &&
                typeof value === "string" &&
                value.toLowerCase().startsWith("text/") &&
                !value.toLowerCase().includes("charset=")
            ) {
                value = `${value}; charset=utf-8`
            }
            return originalSetHeader(name, value)
        }
    })

    // Add security headers to all responses
    app.use(async (req, res) => {
        // Security headers
        res.setHeader("X-Frame-Options", "DENY") // Prevent click-jacking
        res.setHeader("X-Content-Type-Options", "nosniff") // Prevent MIME type sniffing
        res.setHeader("X-XSS-Protection", "1; mode=block") // XSS protection
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains") // Strict HTTPS
    })

    // Global hook: inject a theme-agnostic stylesheet into the <head> of every
    // frontend page, so Aether's Obsidian-style enhancements (wikilinks,
    // callouts, KaTeX, video embeds, hashtags, knowledge-links section, graph
    // page) look consistent regardless of the active theme.
    app.use(async (req, res) => {
        const isFrontend =
            !req.url.startsWith("/aether") &&
            !req.url.startsWith("/api") &&
            !req.url.startsWith("/core") &&
            !req.url.startsWith("/assets") &&
            !req.url.startsWith("/favicon") &&
            !req.url.startsWith("/.well-known")

        if (!isFrontend) return

        const injectHead = (html) => {
            const idx = String(html).toLowerCase().indexOf("<head>")
            if (idx === -1) return html
            const link = '<link rel="stylesheet" href="/assets/aether-extras.css" />\n'
            return html.slice(0, idx + 6) + link + html.slice(idx + 6)
        }

        // Inject the tag workbench (filter bar) into the page for the ACTIVE
        // theme. The fragment is built by the tag routes and attached to the
        // response as `res.tagWorkbenchHtml`. It is placed right above the post
        // list on whatever theme is active, so every theme (including themes
        // downloaded outside this repo) shows the workbench without any
        // per-theme template edits. Themes that render their own workbench
        // (they already contain `class="tag-filter-bar"`) are skipped to avoid
        // a duplicate panel.
        const injectWorkbench = (html, fragment) => {
            if (!fragment) return html
            const str = String(html)
            if (str.includes('class="tag-filter-bar"')) return html
            const markers = [
                'class="collection-content"',
                'class="post-grid"',
                'class="posts-list"',
                'class="post-list"',
                'class="post-cards"',
                'class="taxonomy-collection"',
            ]
            let idx = -1
            for (let i = 0; i < markers.length; i++) {
                const at = str.indexOf(markers[i])
                if (at !== -1) {
                    // Insert BEFORE the whole element that carries this class
                    // (back up to the tag's opening "<"), otherwise the fragment
                    // would land inside the tag and corrupt the markup.
                    const tagStart = str.lastIndexOf("<", at)
                    idx = tagStart !== -1 && tagStart < at ? tagStart : at
                    break
                }
            }
            if (idx === -1) {
                const article = str.indexOf("<article")
                idx = article !== -1 ? article : str.toLowerCase().indexOf("</main>")
            }
            if (idx === -1) {
                const body = str.toLowerCase().indexOf("</body>")
                idx = body !== -1 ? body : str.length
            }
            return str.slice(0, idx) + fragment + str.slice(idx)
        }

        const originalRender = res.render.bind(res)
        res.render = async (template, data) => {
            // Page-level view counter: routes that resolve a content item pass
            // their own `viewCount` (id-based). For every other frontend page
            // (tag cloud, knowledge graph, taxonomy, custom page …) fall back to
            // the count recorded for this request path, so the template's
            // `{{ viewCount }}` shows the real number instead of a hard 0.
            if (data && data.viewCount === undefined && analyticsStore) {
                let path = String(req.url || "").split("?")[0]
                try {
                    path = decodeURIComponent(path)
                } catch {
                    /* keep raw */
                }
                data.viewCount = analyticsStore.viewCountFor({ path })
            }

            let html = ""
            const originalEnd = res.end.bind(res)
            res.end = (chunk) => {
                html = chunk
                return res
            }
            try {
                await originalRender(template, data)
            } finally {
                res.end = originalEnd
            }
            res.end(html ? injectWorkbench(injectHead(html), res.tagWorkbenchHtml) : html)
        }

        const originalHtml = res.html.bind(res)
        res.html = (body, statusCode = 200) => {
            originalHtml(injectHead(body), statusCode)
        }
    })

    // Create the edit permissions middleware directly from auth manager
    const editPermissionsMiddleware = authManager.createEditPermissionsMiddleware(signedCookies)

    // Apply edit permissions middleware globally
    app.use(editPermissionsMiddleware)

    // Analytics collection: records one event per frontend HTML page view
    // (bots and — by default — logged-in users are skipped).
    if (visitTracker) {
        app.use(visitTracker.middleware())
    }

    // Set up API optimization hooks for content endpoints
    // This enables query params like:
    //  - frontmatterOnly=true (removes content and other properties, returns only metadata)
    //  - properties=id,title,slug (filters to only requested properties)
    // Example: /api/posts?frontmatterOnly=true&properties=id,title,slug
    setupContentOptimizationHooks(hookSystem)

    // Set up authentication middleware
    const authenticate = async (req, res) => {
        // Using LiteNode's cookie parser
        const token = req.headers.authorization?.split(" ")[1] || (await signedCookies.getCookie(req, "authToken"))

        if (!token || !(await authManager.verifyToken(token))) {
            if (req.url.startsWith("/api")) {
                res.status(401).json({ error: "Unauthorized" })
                return false
            } else {
                res.redirect("/aether/login")
                return false
            }
        }

        req.user = await authManager.getUserFromToken(token)
        return true
    }

    // Create a systems object to pass to route setup functions
    const systems = {
        themeManager,
        contentManager,
        hookSystem,
        fileStorage,
        authManager,
        settingsService,
        menuManager,
        authenticate,
        signedCookies,
        analyticsStore,
        visitTracker,
    }

    // Set up frontend routes (home, content, taxonomy, custom)
    setupFrontendRoutes(app, systems)

    // Set up admin routes
    setupAdminRoutes(app, systems)

    // Set up API routes
    setupContentApi(app, systems)
    setupThemeApi(app, systems)
    setupMediaApi(app, systems)
    setupUserApi(app, systems)
    setupStaticApi(app, systems)

    // Set global not found handler
    app.notFound(async (req, res) => {
        if (req.url.startsWith("/api")) {
            res.status(404).json({ error: "Endpoint not found" })
        } else if (!req.url.startsWith("/aether")) {
            // Use theme 404 handler for frontend routes
            await handle404(res, req, themeManager, settingsService)
        }
    })

    // Set custom error handler
    app.onError(async (error, req, res) => {
        console.error("Application error:", error)
        if (req.url.startsWith("/api")) {
            res.status(500).json({ error: "Internal server error" })
        } else if (req.url.startsWith("/aether")) {
            res.status(500).html("<h1>500 - Server Error</h1><p>Admin interface error</p>")
        } else {
            // Use theme 500 handler for frontend routes
            await handle500(res, req, themeManager, settingsService)
        }
    })

    // Persist aggregated analytics on shutdown (the hot path flushes lazily).
    const flushAnalytics = () => {
        try {
            analyticsStore?.flushSync?.()
        } catch {
            /* ignore */
        }
    }
    process.once("SIGINT", () => {
        flushAnalytics()
        process.exit(0)
    })
    process.once("SIGTERM", () => {
        flushAnalytics()
        process.exit(0)
    })
}

// Export utility to get core systems (for plugins in the future)
export function getCoreSystem(name) {
    switch (name) {
        case "hooks":
            return hookSystem
        case "themes":
            return themeManager
        case "content":
            return contentManager
        case "files":
            return fileStorage
        case "auth":
            return authManager
        case "settings":
            return settingsService
        case "menu":
            return menuManager
        case "analytics":
            return { store: analyticsStore, tracker: visitTracker }
        default:
            return null
    }
}
