// Import route setups
import { setupFrontendRoutes } from "./routes/index.js"
import { setupAdminRoutes } from "./admin/routes.js"

// Import API routes
import { setupContentApi } from "./api/content-api.js"
import { setupMediaApi } from "./api/media-api.js"
import { setupThemeApi } from "./api/theme-api.js"
import { setupUserApi } from "./api/user-api.js"
import { setupStaticApi } from "./api/static-api.js"
import { setupPublicApi } from "./api/public-api.js"

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
import { configurePeerTube, warmCacheFromContent, extractPeerTubeIds, warmPeerTubeCache } from "./lib/media/peertube.js"
import { buildSocialMeta, canonicalUrl, extractVideosFromHtml } from "./lib/media/social-meta.js"
import { buildShareBar } from "./lib/media/share-bar.js"
import { configureAttachments } from "./lib/media/attachments.js"

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
    // ---------------------------------------------------------------------
    // Static-file guard (runs FIRST).
    //
    // LiteNode serves the project root as static assets, so without this guard
    // anyone could download `/.env` (COOKIE_SECRET!), `/content/data/*`
    // (users.json password hashes, sessions.json tokens, drafts, analytics salt)
    // and the source files under `/core/**`. Only the paths the frontend and the
    // admin UI genuinely need stay public:
    //
    //   /assets/**              theme-agnostic CSS/JS
    //   /content/themes/**      theme assets
    //   /content/uploads/**     media files (image/doc JSON sidecars blocked)
    //   /core/admin/static/**   admin UI assets
    // ---------------------------------------------------------------------
    const SENSITIVE_PATH_PATTERNS = [
        /^\/\.env/i,
        /^\/\.git(\/|$)/i,
        /^\/\.npm-cache(\/|$)/i,
        /^\/content\/data(\/|$)/i,
        /^\/content\/cache(\/|$)/i,
        /^\/content\/uploads\/.*\.json$/i,
        /^\/release(\/|$)/i,
        /^\/(package\.json|package-lock\.json|index\.js)$/i,
        /^\/(README|CHANGELOG|LICENSE|DEPLOYMENT-AI-TAGS)(\.[a-z]+)?$/i,
        /^\/core\/(?!admin\/static(\/|$))/i,
    ]

    app.use(async (req, res) => {
        let path = String(req.url || "/").split("?")[0]
        try {
            path = decodeURIComponent(path)
        } catch {
            /* keep raw */
        }
        if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(path))) {
            // Do NOT end the response here: LiteNode keeps dispatching the route
            // after middleware, and a handler would then write headers twice
            // (ERR_HTTP_HEADERS_SENT → process crash). Rewriting the URL to a
            // path that has no route lets the framework's own 404 handling
            // produce the response (theme 404 page, or JSON for /api/*).
            req.url = "/__aether_not_found__"
        }
    })

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

    // ---------------------------------------------------------------------
    // PeerTube metadata (video covers / duration / channel)
    // ---------------------------------------------------------------------
    configurePeerTube({
        enabled: envFlag("PEERTUBE_ENABLED", true),
        base: process.env.PEERTUBE_URL || "https://stream.dleu.net",
        // Optional separate base for server-side metadata calls, e.g. when the
        // CMS host can only reach PeerTube on its internal address
        // (http://10.x.x.x:9000) while visitors use the public HTTPS domain.
        apiUrl: process.env.PEERTUBE_API_URL || "",
        cacheDir: process.env.PEERTUBE_CACHE_DIR || join(config.rootDir || ".", "content", "cache", "peertube"),
        ttlMs: Number(process.env.PEERTUBE_CACHE_TTL || 86400) * 1000,
        timeoutMs: Number(process.env.PEERTUBE_TIMEOUT || 8000),
        // How many videos to warm per startup pass (the rest fill in on访问自愈).
        warmLimit: Number(process.env.PEERTUBE_WARM_LIMIT || 200),
        runtime: true,
    })

    const peerTubeWarmLimit = Number(process.env.PEERTUBE_WARM_LIMIT || 200)

    // Video autoplay + sequential playback on article pages (frontend only).
    // Browsers only allow programmatic playback while muted, so `muted` is the
    // default and the on-page control bar offers a one-click "开声".
    const videoAutoplay = envFlag("VIDEO_AUTOPLAY", true)
    const videoAutoplayMuted = envFlag("VIDEO_AUTOPLAY_MUTED", true)

    // Attachment blocks read real files from the uploads directory
    configureAttachments({
        uploadsDir: config.uploadsDir || "content/uploads",
        urlPrefix: "/content/uploads",
    })

    // Warm covers in the background (never blocks startup) so list cards have
    // thumbnails without fetching during a request. New/updated posts warm too.
    if (process.env.PEERTUBE_ENABLED !== "false") {
        setTimeout(() => {
            warmCacheFromContent(contentManager, { limit: peerTubeWarmLimit })
                .then((stats) => {
                    if (stats.total > 0) {
                        console.log(
                            `[peertube] metadata ready: ${stats.total} videos (fetched ${stats.fetched}, cached ${stats.cached}, failed ${stats.failed})`
                        )
                    }
                })
                .catch(() => {})
        }, 4000).unref?.()

        const warmFromPost = (post) => {
            try {
                const ids = extractPeerTubeIds(post?.content || "")
                if (ids.length > 0) warmPeerTubeCache(ids).catch(() => {})
            } catch {
                /* ignore */
            }
        }
        hookSystem.addAction("post_created", warmFromPost)
        hookSystem.addAction("post_updated", warmFromPost)
    }

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

        const injectHead = (html, data) => {
            const str = String(html)
            const idx = str.toLowerCase().indexOf("<head>")
            if (idx === -1) return html
            let extra = '<link rel="stylesheet" href="/assets/aether-extras.css" />\n'
            // The video facade / share bar runtimes are only needed on pages that
            // contain them, so other pages stay byte-identical. Themes may also
            // include them in their layout (which keeps static exports working) —
            // skip the injection when the tag is already present.
            if (str.includes('class="video-facade') && !str.includes("video-facade.js")) {
                extra += '<script src="/assets/video-facade.js" defer></script>\n'
            }
            // Autoplay / sequential playback: only on pages that actually embed
            // videos. The settings travel as an inline JSON object so a visitor
            // can still override them from the on-page control bar (an empty
            // object — e.g. a static export including the runtime itself —
            // simply means "autoplay on, muted", the browser-safe default).
            const hasLocalVideo = str.includes('class="video-local"')
            if (str.includes('class="video-facade') || hasLocalVideo) {
                extra += `<script>window.__AETHER_VIDEO_PLAYLIST__=${JSON.stringify({
                    enabled: videoAutoplay,
                    muted: videoAutoplayMuted,
                })}</script>\n`
                if (!str.includes("video-playlist.js")) {
                    extra += '<script src="/assets/video-playlist.js" defer></script>\n'
                }
            }
            if (str.includes('class="share-bar"') && !str.includes("share-bar.js")) {
                extra += '<script src="/assets/share-bar.js" defer></script>\n'
            }
            // Live search suggestions on /search (the page works without JS —
            // the script only adds a dropdown fed by the public API).
            if (str.includes("data-search-suggest") && !str.includes("search-suggest.js")) {
                extra += '<script src="/assets/search-suggest.js" defer></script>\n'
            }
            // Search result pages must not be indexed (thin/duplicate content).
            if (data && data.searchRoute) {
                extra += '<meta name="robots" content="noindex, follow" />\n'
            }
            // OpenGraph / Twitter Card / JSON-LD (theme-agnostic, like the CSS)
            try {
                extra += buildSocialMeta({
                    data: data || {},
                    req,
                    html: str,
                    siteSettings: settingsService?.settings || null,
                })
            } catch (error) {
                console.error("[aether] social meta injection failed:", error.message)
            }
            return str.slice(0, idx + 6) + extra + str.slice(idx + 6)
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

        /**
         * Share bar: injected into CONTENT pages only (a real post/page, i.e. the
         * route supplied a contentId). Placed just above the "knowledge links"
         * block when the theme renders one, otherwise before the end of the
         * article. Fully server-rendered (QR codes included) so it works on every
         * theme, and it is skipped when the markup is already present.
         */
        const injectShareBar = (html, data) => {
            const str = String(html)
            if (!data || !data.contentId || !data.metadata?.title) return html
            if (str.includes('class="share-bar"')) return html

            let fragment = ""
            try {
                const videos = extractVideosFromHtml(str)
                fragment = buildShareBar({
                    url: canonicalUrl(req),
                    title: data.metadata.title,
                    description: data.metadata.seoDescription || data.metadata.excerpt || "",
                    videos,
                })
            } catch (error) {
                console.error("[aether] share bar failed:", error.message)
                return html
            }
            if (!fragment) return html

            const markers = ['class="wiki-links"', 'class="post-footer"', 'class="post-nav"']
            let idx = -1
            for (const marker of markers) {
                const at = str.indexOf(marker)
                if (at !== -1) {
                    const tagStart = str.lastIndexOf("<", at)
                    idx = tagStart !== -1 && tagStart < at ? tagStart : at
                    break
                }
            }
            if (idx === -1) {
                const closing = str.lastIndexOf("</article>")
                if (closing !== -1) {
                    idx = closing
                } else {
                    const main = str.toLowerCase().indexOf("</main>")
                    idx = main !== -1 ? main : str.length
                }
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
            if (!html) return res.end(html)
            // Order matters: the share bar is added to the BODY first, so that
            // injectHead (which decides which runtimes to load) sees it.
            let out = injectShareBar(html, data)
            out = injectHead(out, data)
            out = injectWorkbench(out, res.tagWorkbenchHtml)
            res.end(out)
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
    setupPublicApi(app, systems) // /api/public/* + /oembed (read-only, CORS open)

    // Set global not found handler
    app.notFound(async (req, res) => {
        // A middleware may have answered already (e.g. CORS preflight). LiteNode
        // still calls this handler afterwards, and its json/html helpers do NOT
        // guard against an already-sent response — writing again would throw
        // ERR_HTTP_HEADERS_SENT and kill the process.
        if (res.headersSent || res.finished) return

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
        if (res.headersSent || res.finished) return
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
