/**
 * Analytics reporting helpers — turn the store's aggregates + raw day logs into
 * the structures the admin dashboard and CSV export consume.
 *
 * PV and all breakdowns come from the small aggregated summary (per-day
 * counters), so they are cheap. UV needs uniqueness, which only the raw logs
 * carry, so it is computed by scanning the requested day files and cached for a
 * short TTL (the dashboard is admin-only and low traffic).
 */

import { dayKey } from "../lib/analytics/analytics-store.js"

const UV_CACHE_TTL_MS = 60_000
const uvCache = new Map() // `${from}|${to}` → { at, uvByDay, uvRange }

export const RANGE_OPTIONS = [
    { value: 1, label: "今日" },
    { value: 7, label: "近 7 天" },
    { value: 30, label: "近 30 天" },
    { value: 90, label: "近 90 天" },
]

function daysBack(count) {
    const list = []
    const today = new Date()
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(today)
        d.setDate(today.getDate() - i)
        list.push(dayKey(d))
    }
    return list
}

function toSortedPairs(map = {}) {
    const total = Object.values(map).reduce((sum, n) => sum + n, 0)
    return Object.entries(map)
        .map(([name, count]) => ({
            name,
            count,
            pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Percent-decode a path; fall back to the raw value when malformed. */
function safeDecode(value) {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

/**
 * Canonicalise a stored content key so historical entries recorded before the
 * tracker decoded paths (e.g. `path:/tag/%E5%B0%8F%E5%AD%A6`) merge with new
 * ones (`path:/tag/小学`) instead of showing up as separate rows.
 */
function normalizeContentKey(key) {
    if (typeof key !== "string") return key
    if (key.startsWith("path:")) return `path:${safeDecode(key.slice(5))}`
    return key
}

/**
 * Human-readable label for a frontend path, used for non-article pages in the
 * dashboard (`文章排行` / `最近访问`) where there is no article title.
 *
 *   /                        → 首页
 *   /tag/小学                → 标签：小学
 *   /tags/小学/数学           → 标签筛选：小学 × 数学
 *   /category/技术            → 分类：技术
 *   /notes/graph             → 知识图谱
 *   /tag-cloud               → 标签云
 *   /notes/<slug>            → 页面：<slug>
 */
export function describePath(path) {
    const decoded = safeDecode(String(path || ""))
    if (!decoded || decoded === "/") return "首页"

    const segments = decoded.split("/").filter(Boolean)

    if (segments[0] === "tag" && segments[1]) {
        return `标签：${segments[1]}`
    }
    if (segments[0] === "tags" && segments.length > 1) {
        return `标签筛选：${segments.slice(1).join(" × ")}`
    }
    if (segments[0] === "category" && segments[1]) {
        return `分类：${segments[1]}`
    }
    if (decoded === "/notes/graph") return "知识图谱"
    if (decoded === "/tag-cloud") return "标签云"
    if (segments[0] === "notes" && segments[1]) {
        return `页面：${segments.slice(1).join("/")}`
    }
    if (segments[0] === "page" && segments[1]) {
        return `页面：${segments[1]}`
    }
    if (segments[0] === "post" && segments[1]) {
        return `文章：${segments[1]}`
    }
    return decoded
}

/**
 * Unique visitors per day (and for the whole range) by scanning raw logs.
 * @param {import("../lib/analytics/analytics-store.js").AnalyticsStore} store
 * @param {string[]} days
 */
async function computeUv(store, days) {
    const key = `${days[0]}|${days[days.length - 1]}|${days.length}`
    const cached = uvCache.get(key)
    if (cached && Date.now() - cached.at < UV_CACHE_TTL_MS) return cached.data

    const uvByDay = {}
    const rangeSet = new Set()
    for (const day of days) {
        const events = await store.readDay(day)
        const set = new Set()
        for (const ev of events) {
            if (ev.iph) {
                set.add(ev.iph)
                rangeSet.add(ev.iph)
            }
        }
        uvByDay[day] = set.size
    }

    const data = { uvByDay, uvRange: rangeSet.size }
    uvCache.set(key, { at: Date.now(), data })
    // Keep the cache bounded
    if (uvCache.size > 32) uvCache.clear()
    return data
}

/** Invalidate the UV cache (called after storage cleanup). */
export function clearAnalyticsReportCache() {
    uvCache.clear()
}

/**
 * Build the full dashboard report.
 * @param {import("../lib/analytics/analytics-store.js").AnalyticsStore} store
 * @param {Object} [options]
 * @param {number} [options.days=7] - Range length in days (1 = today only)
 * @param {number} [options.recentLimit=50]
 */
export async function buildAnalyticsReport(store, { days = 7, recentLimit = 50 } = {}) {
    const summary = store.summary || { totals: { pv: 0 }, byDay: {}, byContent: {} }
    const rangeDays = daysBack(Math.max(1, Number(days) || 7))
    const from = rangeDays[0]
    const to = rangeDays[rangeDays.length - 1]

    // ---- PV + breakdowns from per-day aggregates -------------------------
    let pv = 0
    const contentPv = {}
    const devices = {}
    const os = {}
    const browsers = {}
    const referrers = {}

    // Metadata (title/slug/type) per canonical key, for REAL content entries
    // only. Plain-page entries carry no meaningful title (historically they
    // stored their own path), so they are skipped and rendered through
    // describePath() instead. Historical entries recorded before paths were
    // decoded are matched through the same normalisation, so
    // `path:/tag/%E5%B0%8F%E5%AD%A6` and `path:/tag/小学` become one row.
    const metaByKey = new Map()
    for (const [key, meta] of Object.entries(summary.byContent || {})) {
        if (key.startsWith("path:")) continue
        const canonical = normalizeContentKey(key)
        const existing = metaByKey.get(canonical)
        if (!existing || (!existing.title && meta?.title)) metaByKey.set(canonical, meta || {})
    }

    for (const day of rangeDays) {
        const entry = summary.byDay?.[day]
        if (!entry) continue
        pv += entry.pv || 0
        for (const [rawKey, count] of Object.entries(entry.ct || {})) {
            const key = normalizeContentKey(rawKey)
            contentPv[key] = (contentPv[key] || 0) + count
        }
        for (const [name, count] of Object.entries(entry.dev || {})) devices[name] = (devices[name] || 0) + count
        for (const [name, count] of Object.entries(entry.os || {})) os[name] = (os[name] || 0) + count
        for (const [name, count] of Object.entries(entry.br || {})) browsers[name] = (browsers[name] || 0) + count
        for (const [name, count] of Object.entries(entry.rf || {})) referrers[name] = (referrers[name] || 0) + count
    }

    // ---- UV from raw logs ------------------------------------------------
    const { uvByDay, uvRange } = await computeUv(store, rangeDays)

    // ---- Trend series ----------------------------------------------------
    const series = rangeDays.map((day) => ({
        day,
        short: day.slice(5),
        pv: summary.byDay?.[day]?.pv || 0,
        uv: uvByDay[day] || 0,
    }))

    // ---- Top content -----------------------------------------------------
    const topContent = Object.entries(contentPv)
        .map(([key, count]) => {
            const meta = metaByKey.get(key) || {}
            const isPathKey = key.startsWith("path:")
            const rawLabel = key.replace(/^(id|path|slug):/, "")
            return {
                key,
                pv: count,
                share: pv > 0 ? Math.round((count / pv) * 1000) / 10 : 0,
                // Articles show their title; page/tag routes become readable labels.
                title: isPathKey ? describePath(rawLabel) : meta.title || meta.slug || rawLabel,
                slug: meta.slug || "",
                type: meta.type || (isPathKey ? "page" : ""),
                // Clickable target: article → /notes/<slug>, other pages → the route
                url: meta.slug ? `/notes/${meta.slug}` : isPathKey ? rawLabel : "",
            }
        })
        .sort((a, b) => b.pv - a.pv || a.title.localeCompare(b.title))

    // ---- Recent visits (newest raw events) -------------------------------
    const recent = []
    const recentDays = daysBack(3).reverse()
    for (const day of recentDays) {
        if (recent.length >= recentLimit) break
        const events = await store.readDay(day)
        for (let i = events.length - 1; i >= 0 && recent.length < recentLimit; i--) {
            const ev = events[i]
            const key = normalizeContentKey(ev.k)
            const meta = metaByKey.get(key) || {}
            const decodedPath = safeDecode(ev.p || "")
            const isPathEvent = !key || String(key).startsWith("path:")
            recent.push({
                time: ev.t,
                path: decodedPath,
                title: ev.ti || (isPathEvent ? describePath(decodedPath) : meta.title || describePath(decodedPath)),
                url: meta.slug ? `/notes/${meta.slug}` : decodedPath,
                ip: ev.ipm || "",
                device: ev.dv || "unknown",
                os: ev.os || "unknown",
                browser: ev.br || "unknown",
                referrer: ev.rf || "",
            })
        }
    }

    const daysWithTraffic = rangeDays.filter((d) => (summary.byDay?.[d]?.pv || 0) > 0).length

    return {
        range: { days: rangeDays.length, from, to, label: `${from} ~ ${to}` },
        totals: {
            pv,
            uv: uvRange,
            allTimePv: summary.totals?.pv || 0,
            contentCount: Object.keys(contentPv).length,
            avgPerDay: rangeDays.length > 0 ? Math.round((pv / rangeDays.length) * 10) / 10 : 0,
            daysWithTraffic,
        },
        series,
        topContent,
        devices: toSortedPairs(devices),
        os: toSortedPairs(os),
        browsers: toSortedPairs(browsers),
        referrers: toSortedPairs(referrers).slice(0, 15),
        recent,
    }
}

/**
 * CSV export of the article view ranking for the given range.
 * @param {Object} report - Result of buildAnalyticsReport
 * @returns {string}
 */
export function reportToCsv(report) {
    const rows = [
        ["rank", "title", "slug", "type", "pv", "share(%)"],
        ...report.topContent.map((item, index) => [
            index + 1,
            item.title,
            item.slug,
            item.type,
            item.pv,
            item.share,
        ]),
    ]

    const escape = (value) => {
        const s = String(value ?? "")
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }

    const header = [
        `# Aether CMS analytics export`,
        `# range: ${report.range.from} ~ ${report.range.to} (${report.range.days} days)`,
        `# pv: ${report.totals.pv}, uv: ${report.totals.uv}, exported: ${new Date().toISOString()}`,
        "",
    ]

    return header.join("\n") + rows.map((row) => row.map(escape).join(",")).join("\n") + "\n"
}
