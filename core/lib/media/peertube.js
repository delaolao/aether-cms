/**
 * PeerTube metadata client — fetch + cache video metadata (title, duration,
 * thumbnail, channel, publish date) for the instance video URLs used in content
 * (`[video:https://stream.dleu.net/w/<shortUUID>|标题]`).
 *
 * Why cache: list pages render dozens of cards per request, and the cover/duration
 * badges must be available **synchronously** while rendering. So the design is:
 *
 *   readPeerTubeMetaSync(id)  — memory → disk cache only, never network
 *   getPeerTubeMeta(id)       — cache, else fetch and store (async, never throws)
 *   warmCacheFromContent()    — background warm-up at startup / after saves
 *
 * URLs are always rebuilt from the configured base URL: this instance runs
 * behind a reverse proxy and its API reports `http://…` URLs, which would break
 * mixed-content on an HTTPS site.
 */

import { mkdir, writeFile, stat } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DEFAULT_BASE = "https://stream.dleu.net"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 1 day
const DEFAULT_TIMEOUT_MS = 8000

let config = {
    enabled: true,
    base: DEFAULT_BASE, // public base URL — used for thumbnails / watch / embed
    apiUrl: "", // optional separate base for server-side API calls (defaults to base)
    cacheDir: "content/cache/peertube",
    ttlMs: DEFAULT_TTL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    // Only true once the CMS app has configured it: gates the "self-heal" async
    // fetch so other consumers (static generator) never hit the network.
    runtime: false,
}

/** Base URL used for API calls (falls back to the public base). */
function apiBase() {
    return String(config.apiUrl || config.base || DEFAULT_BASE).replace(/\/+$/, "")
}

/** @type {Map<string, {meta: Object|null, at: number}>} */
const memory = new Map()

/** In-flight fetches, keyed by id — dedupes the self-heal path. */
const inFlight = new Map()

export function configurePeerTube(options = {}) {
    config = {
        ...config,
        ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== "")),
    }
    if (typeof config.base === "string") config.base = config.base.replace(/\/+$/, "")
    return { ...config }
}
export function getPeerTubeConfig() {
    return { ...config }
}

/** Extract a PeerTube video id (shortUUID or UUID) from any supported URL. */
export function extractPeerTubeId(url) {
    if (!url || typeof url !== "string") return null
    const value = url.trim()
    const patterns = [
        /\/w\/([^/?#]+)/i,
        /\/videos\/watch\/([^/?#]+)/i,
        /\/videos\/embed\/([^/?#]+)/i,
        /\/api\/v1\/videos\/([^/?#]+)/i,
    ]
    for (const re of patterns) {
        const m = value.match(re)
        if (m) return decodeURIComponent(m[1])
    }
    // Bare id / uuid (no scheme, no slash)
    if (!value.includes("/") && /^[A-Za-z0-9-]{8,64}$/.test(value)) return value
    return null
}

/** Where the metadata for a video id is cached. */
function cachePath(id) {
    return join(config.cacheDir, `${String(id).replace(/[^A-Za-z0-9-]/g, "")}.json`)
}

/** 1702 → "28:22", 3725 → "1:02:05" */
export function formatDuration(seconds) {
    const total = Number(seconds)
    if (!Number.isFinite(total) || total <= 0) return ""
    const s = Math.floor(total % 60)
    const m = Math.floor((total / 60) % 60)
    const h = Math.floor(total / 3600)
    const pad = (n) => String(n).padStart(2, "0")
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Turn a path from the API (or an absolute URL) into an absolute URL on our base. */
function absolute(base, maybePath) {
    if (!maybePath) return ""
    if (maybePath.startsWith("http://") || maybePath.startsWith("https://")) {
        try {
            const parsed = new URL(maybePath)
            return base + parsed.pathname + parsed.search
        } catch {
            return maybePath
        }
    }
    return base + (maybePath.startsWith("/") ? "" : "/") + maybePath
}

/** Normalise a PeerTube API video object into the shape the CMS uses. */
export function normalizePeerTubeMeta(video, base = config.base) {
    if (!video || !video.uuid) return null
    const id = video.shortUUID || video.uuid
    return {
        id,
        uuid: video.uuid,
        title: video.name || "",
        description: video.description || "",
        duration: Number(video.duration) || 0,
        durationText: formatDuration(video.duration),
        thumbnailUrl: absolute(base, video.thumbnailPath),
        previewUrl: absolute(base, video.previewPath),
        watchUrl: `${base}/w/${id}`,
        embedUrl: `${base}/videos/embed/${id}`,
        channel: video.channel?.displayName || "",
        channelUrl: absolute(base, video.channel?.url ? new URL(video.channel.url).pathname : ""),
        account: video.account?.displayName || "",
        publishedAt: video.publishedAt || "",
        views: Number(video.views) || 0,
        isLive: Boolean(video.isLive),
        privacy: video.privacy?.label || "",
        fetchedAt: new Date().toISOString(),
    }
}

/**
 * Self-healing fetch: if the id has no fresh cache entry, fetch it in the
 * background (deduplicated). Callers keep rendering synchronously from the cache
 * (placeholder cover now, real cover on the next request a moment later), so
 * existing articles gain covers WITHOUT being re-saved and without a restart.
 *
 * No-op outside the CMS runtime (e.g. during static generation) — guarded by
 * `config.runtime`, which only app.js enables.
 *
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export function ensurePeerTubeMeta(id) {
    if (!id || !config.enabled || !config.runtime) return Promise.resolve(null)

    const cached = readPeerTubeMetaSync(id)
    if (cached && !isStale(id)) return Promise.resolve(cached)
    if (inFlight.has(id)) return inFlight.get(id)

    const promise = getPeerTubeMeta(id).finally(() => inFlight.delete(id))
    inFlight.set(id, promise)
    return promise
}

/**
 * Synchronous cache lookup (memory → disk). Never touches the network, so it is
 * safe to call while rendering list cards.
 * @returns {Object|null}
 */
export function readPeerTubeMetaSync(id) {
    if (!id || !config.enabled) return null

    const cached = memory.get(id)
    if (cached && Date.now() - cached.at < config.ttlMs) return cached.meta

    try {
        const file = cachePath(id)
        if (!existsSync(file)) return null
        const parsed = JSON.parse(readFileSync(file, "utf8"))
        const meta = parsed?.meta || null
        memory.set(id, { meta, at: Date.now() })
        return meta
    } catch {
        return null
    }
}

/** True when the cached entry is older than the TTL (stale but still usable). */
function isStale(id) {
    try {
        const file = cachePath(id)
        if (!existsSync(file)) return true
        const parsed = JSON.parse(readFileSync(file, "utf8"))
        const at = parsed?.fetchedAt ? Date.parse(parsed.fetchedAt) : 0
        return !at || Date.now() - at > config.ttlMs
    } catch {
        return true
    }
}

async function storeMeta(id, meta) {
    await mkdir(config.cacheDir, { recursive: true })
    const payload = JSON.stringify({ fetchedAt: new Date().toISOString(), meta }, null, 2)
    await writeFile(cachePath(id), payload, "utf8")
    memory.set(id, { meta, at: Date.now() })
    return meta
}

/**
 * Get metadata for a video id, fetching and caching when needed.
 * Never throws: on network failure it returns a stale cache entry if present.
 * @param {string} id
 * @param {{force?: boolean}} [options]
 * @returns {Promise<Object|null>}
 */
export async function getPeerTubeMeta(id, { force = false } = {}) {
    if (!id || !config.enabled) return null

    if (!force) {
        const cached = readPeerTubeMetaSync(id)
        if (cached && !isStale(id)) return cached
    }

    try {
        // Metadata is fetched from the API base (possibly an internal address),
        // while every public URL is still built from `base`.
        const url = `${apiBase()}/api/v1/videos/${encodeURIComponent(id)}`
        const res = await fetch(url, {
            headers: { accept: "application/json", "user-agent": "aether-cms-peertube-client/1.0" },
            signal: AbortSignal.timeout(config.timeoutMs),
        })
        if (!res.ok) {
            // 404 → the video is gone/private; keep any cached copy, flag nothing
            if (res.status === 404) return readPeerTubeMetaSync(id)
            return readPeerTubeMetaSync(id)
        }
        const video = await res.json()
        const meta = normalizePeerTubeMeta(video, config.base)
        if (!meta) return readPeerTubeMetaSync(id)
        return await storeMeta(id, meta)
    } catch (error) {
        // Offline / timeout → serve whatever we have (cards degrade gracefully)
        if (process.env.PEERTUBE_DEBUG) {
            console.warn(`[peertube] fetch failed for ${id}: ${error.message}`)
        }
        return readPeerTubeMetaSync(id)
    }
}

/** Fetch metadata for many ids with a small concurrency limit. */
export async function warmPeerTubeCache(ids, { concurrency = 2, force = false } = {}) {
    const list = Array.from(new Set((ids || []).filter(Boolean)))
    const results = { total: list.length, fetched: 0, cached: 0, failed: 0 }

    let index = 0
    async function worker() {
        while (index < list.length) {
            const id = list[index++]
            if (!force && readPeerTubeMetaSync(id) && !isStale(id)) {
                results.cached++
                continue
            }
            const meta = await getPeerTubeMeta(id, { force })
            if (meta) results.fetched++
            else results.failed++
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker))
    return results
}

/** Extract every PeerTube video id referenced in a markdown string. */
export function extractPeerTubeIds(markdown) {
    if (!markdown || typeof markdown !== "string") return []
    const ids = new Set()
    const re = /\[video:([^\]|]+)(?:\|[^\]]*)?\]/g
    let m
    while ((m = re.exec(markdown)) !== null) {
        const id = extractPeerTubeId(m[1])
        if (id) ids.add(id)
    }
    return Array.from(ids)
}

/**
 * Warm the cache for every video referenced by published content.
 * Intended for a fire-and-forget call at startup.
 */
export async function warmCacheFromContent(contentManager, { limit = 60 } = {}) {
    if (!config.enabled || !contentManager) return { total: 0, fetched: 0, failed: 0 }

    const ids = new Set()
    try {
        const posts = await contentManager.getPosts({ status: "published" })
        for (const post of posts) {
            for (const id of extractPeerTubeIds(post.content || "")) ids.add(id)
        }
        const pages = await contentManager.getPages({ status: "published" })
        for (const page of pages) {
            for (const id of extractPeerTubeIds(page.content || "")) ids.add(id)
        }
    } catch (error) {
        if (process.env.PEERTUBE_DEBUG) console.warn("[peertube] warm scan failed:", error.message)
        return { total: 0, fetched: 0, failed: 0 }
    }

    return warmPeerTubeCache(Array.from(ids).slice(0, limit))
}

/** Cache statistics for the admin dashboard / debugging. */
export async function peerTubeCacheStats() {
    try {
        const dir = config.cacheDir
        if (!existsSync(dir)) return { count: 0, dir }
        const { readdir } = await import("node:fs/promises")
        const files = (await readdir(dir)).filter((f) => f.endsWith(".json"))
        let bytes = 0
        for (const f of files) {
            try {
                bytes += (await stat(join(dir, f))).size
            } catch {
                /* ignore */
            }
        }
        return { count: files.length, bytes, dir, base: config.base, enabled: config.enabled }
    } catch {
        return { count: 0, dir: config.cacheDir, base: config.base, enabled: config.enabled }
    }
}
