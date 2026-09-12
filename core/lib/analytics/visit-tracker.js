/**
 * Visit tracker — the collection half of the built-in analytics module.
 *
 * Registered as a global middleware (see core/app.js). For every frontend HTML
 * page it records ONE event when the response finishes successfully:
 *
 *   - real client IP (only trusting X-Forwarded-For when `trustProxy` is on)
 *   - a MASKED IP and a SALTED HASH — the raw IP is never stored
 *   - device / OS / browser buckets parsed from the User-Agent
 *   - external referrer host (internal navigation is not recorded)
 *   - a per-visitor cookie id used only for de-duplicating repeat views
 *
 * Bots are dropped, and (by default) logged-in admin/editor traffic is skipped
 * so the author's own browsing does not pollute the statistics.
 *
 * Routes may attach richer context via `markContent(res, {...})` — e.g.
 * core/routes/notes.js marks the post id/slug/title so the dashboard can rank
 * articles by title instead of by URL.
 */

import { randomBytes, createHmac } from "node:crypto"
import { isBot, parseUserAgent, referrerHost } from "./ua-parser.js"

const VISITOR_COOKIE = "aether_vid"
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000

/** Percent-decode a request path, falling back to the raw value if malformed. */
function decodePath(path) {
    try {
        return decodeURIComponent(path)
    } catch {
        return path
    }
}

// Paths that must never be counted (admin, APIs, static assets, feeds).
const SKIP_PREFIXES = ["/aether", "/api", "/core", "/assets", "/content/themes", "/content/uploads", "/favicon", "/.well-known"]
const SKIP_EXACT = ["/robots.txt", "/rss", "/rss.xml", "/sitemap", "/sitemap.xml", "/sitemap.html"]

export class VisitTracker {
    /**
     * @param {Object} options
     * @param {import("./analytics-store.js").AnalyticsStore} options.store
     * @param {boolean} [options.trustProxy=false] - Trust X-Forwarded-For (set behind nginx/CDN)
     * @param {boolean} [options.excludeAdmins=true] - Skip logged-in users
     * @param {number} [options.dedupWindowMs] - Ignore repeat views of the same page by the same visitor
     * @param {Object} [options.authManager] - Used to verify the auth cookie when excludeAdmins is on
     */
    constructor({
        store,
        trustProxy = false,
        excludeAdmins = true,
        dedupWindowMs = 30 * 60 * 1000,
        authManager = null,
        signedCookies = null,
    }) {
        this.store = store
        this.trustProxy = !!trustProxy
        this.excludeAdmins = !!excludeAdmins
        this.dedupWindowMs = dedupWindowMs
        this.authManager = authManager
        // The auth cookie is SIGNED, so it must be unwrapped before verification.
        this.signedCookies = signedCookies

        /** @type {Map<string, number>} `${visitorId}|${key}` → last recorded timestamp */
        this.recent = new Map()
        /** @type {Map<string, {ok: boolean, at: number}>} token → validity */
        this.authCache = new Map()
    }

    /** Attach content context so the dashboard can show titles, not just URLs. */
    markContent(res, { id, slug, type, title } = {}) {
        if (!res) return
        res.analyticsContent = {
            id: id != null ? String(id) : "",
            slug: slug || "",
            type: type || "",
            title: title || "",
        }
    }

    /** Global middleware. */
    middleware() {
        return async (req, res) => {
            if (this.#shouldSkip(req)) return

            // Resolve/assign the visitor id now: headers must be set before the
            // handler runs, so this cannot happen in the finish handler.
            const visitorId = this.#visitorId(req, res)

            res.on("finish", () => {
                this.#onFinish(req, res, visitorId).catch((error) => {
                    console.error("[analytics] tracking failed:", error.message)
                })
            })
        }
    }

    #shouldSkip(req) {
        if (!req || (req.method !== "GET" && req.method !== "HEAD")) return true
        const path = String(req.url || "").split("?")[0]
        if (!path.startsWith("/")) return true
        for (const prefix of SKIP_PREFIXES) {
            if (path.startsWith(prefix)) return true
        }
        if (SKIP_EXACT.includes(path)) return true
        // Skip anything that looks like a static file, but keep .html pages.
        const lastSegment = path.split("/").pop() || ""
        if (lastSegment.includes(".") && !/\.html?$/i.test(lastSegment)) return true
        return false
    }

    #visitorId(req, res) {
        const existing = req.cookies?.[VISITOR_COOKIE]
        if (existing && /^[a-f0-9]{16,64}$/i.test(existing)) return existing

        const id = randomBytes(16).toString("hex")
        try {
            const proto = String(req.headers?.["x-forwarded-proto"] || "").toLowerCase()
            const secure = proto === "https" || Boolean(req.socket?.encrypted)
            res.setCookie(VISITOR_COOKIE, id, {
                maxAge: VISITOR_COOKIE_MAX_AGE,
                httpOnly: true,
                sameSite: "Lax",
                secure,
            })
        } catch {
            /* cookie is best-effort; tracking still works with a transient id */
        }
        return id
    }

    async #onFinish(req, res, visitorId) {
        if (res.statusCode !== 200) return
        const contentType = String(res.getHeader?.("content-type") || "")
        if (contentType && !contentType.includes("text/html")) return

        const ua = String(req.headers?.["user-agent"] || "")
        if (isBot(ua)) return

        if (this.excludeAdmins && (await this.#isLoggedIn(req))) return

        // Store the path DECODED: litenode hands us the raw request URL, so
        // Chinese routes arrive percent-encoded (e.g. /tag/%E5%B0%8F%E5%AD%A6)
        // and would be unreadable in the dashboard. Decoding also keeps one
        // canonical path per page, so counts aggregate correctly.
        const path = decodePath(String(req.url || "").split("?")[0])
        const marked = res.analyticsContent || null
        const key = marked?.id ? `id:${marked.id}` : marked?.slug ? `slug:${marked.slug}` : `path:${path}`

        // De-duplicate: same visitor + same page within the window counts once
        // (guards against refresh-spam inflating the counters).
        const dedupKey = `${visitorId}|${key}`
        const now = Date.now()
        const last = this.recent.get(dedupKey)
        if (last && now - last < this.dedupWindowMs) return
        this.recent.set(dedupKey, now)
        if (this.recent.size > 10000) this.#pruneRecent(now)

        const ip = this.#clientIp(req)
        const { device, os, browser } = parseUserAgent(ua)

        await this.store.record({
            t: new Date(now).toISOString(),
            path,
            key,
            slug: marked?.slug || "",
            title: marked?.title || "",
            type: marked?.type || "page",
            ipMasked: this.#maskIp(ip),
            ipHash: this.#hashIp(ip),
            device,
            os,
            browser,
            referrer: referrerHost(req.headers?.referer, req.headers?.host),
        })
    }

    async #isLoggedIn(req) {
        const signed = req.cookies?.authToken
        if (!signed || !this.authManager) return false

        const cached = this.authCache.get(signed)
        if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) return cached.ok

        let ok = false
        try {
            // authToken is a SIGNED cookie: unwrap it first, then verify the
            // session token itself (mirrors the authenticate middleware).
            const token = this.signedCookies ? await this.signedCookies.getCookie(req, "authToken") : signed
            ok = Boolean(token) && Boolean(await this.authManager.verifyToken(token))
        } catch {
            ok = false
        }
        this.authCache.set(signed, { ok, at: Date.now() })
        if (this.authCache.size > 2000) this.authCache.clear()
        return ok
    }

    #clientIp(req) {
        if (this.trustProxy) {
            const header = req.headers?.["x-forwarded-for"]
            if (header) {
                const first = String(header).split(",")[0].trim()
                if (first) return first
            }
            const real = req.headers?.["x-real-ip"]
            if (real) return String(real).trim()
        }
        const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || ""
        return String(raw)
    }

    /** Mask an IP: IPv4 keeps the first three octets, IPv6 the first three hextets. */
    #maskIp(ip) {
        if (!ip) return ""
        const value = this.#normalizeIp(ip)

        if (value.includes(".")) {
            const parts = value.split(".")
            if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`
            return value
        }
        if (value.includes(":")) {
            if (value === "::1") return "::1"
            const groups = value.split(":").filter(Boolean)
            return groups.slice(0, 3).join(":") + "::"
        }
        return value
    }

    /** Salted hash of the full IP — stable per site, so daily UV can be computed. */
    #hashIp(ip) {
        if (!ip) return ""
        const value = this.#normalizeIp(ip)
        return createHmac("sha256", this.store.salt || "aether-analytics").update(value).digest("hex").slice(0, 16)
    }

    #normalizeIp(ip) {
        let value = String(ip).trim()
        // IPv4-mapped IPv6 (::ffff:1.2.3.4) → plain IPv4
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value)
        if (mapped) value = mapped[1]
        // Zone index (fe80::1%eth0) → strip it
        const zone = value.indexOf("%")
        if (zone !== -1) value = value.slice(0, zone)
        return value
    }

    #pruneRecent(now) {
        for (const [key, ts] of this.recent) {
            if (now - ts > this.dedupWindowMs) this.recent.delete(key)
        }
        if (this.recent.size > 10000) this.recent.clear()
    }
}
