/**
 * Analytics storage — append-only JSONL detail logs + an aggregated JSON
 * summary, matching the project's "file based, no database" philosophy.
 *
 *   content/data/analytics/
 *     salt.txt                 stable per-site salt for IP hashing (auto-created)
 *     views-YYYY-MM-DD.jsonl   raw visit events, one JSON object per line
 *     summary.json             aggregated counters (kept in memory, flushed lazily)
 *
 * Writes are cheap: a visit appends one line and bumps in-memory counters. The
 * summary is flushed at most every FLUSH_INTERVAL_MS (and on shutdown), so the
 * hot path never rewrites a growing JSON file.
 *
 * Privacy: the store never receives a raw IP — the tracker hands it a masked
 * form and a salted hash only (see visit-tracker.js).
 */

import { mkdir, readFile, writeFile, appendFile, readdir, unlink, rename } from "node:fs/promises"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const FLUSH_INTERVAL_MS = 5000
const MAX_DAY_HISTORY = 400 // keep daily aggregates this long (they are tiny)

function dayKey(date = new Date()) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

function emptyDayEntry() {
    return { pv: 0, dev: {}, os: {}, br: {}, rf: {}, ct: {} }
}

function bump(map, key) {
    if (!key) return
    map[key] = (map[key] || 0) + 1
}

export class AnalyticsStore {
    /**
     * @param {Object} options
     * @param {string} options.dir - Storage directory
     * @param {string} [options.salt] - Fixed salt (falls back to salt.txt / generated)
     * @param {number} [options.retentionDays=180] - Raw JSONL retention
     */
    constructor({ dir, salt = "", retentionDays = 180 } = {}) {
        this.dir = dir
        this.salt = salt
        this.retentionDays = Number(retentionDays) > 0 ? Number(retentionDays) : 180

        this.summary = null
        this.dirty = false
        this.flushTimer = null
        this.lastFlushAt = 0
        this.cleanupTimer = null
        this._countsCache = null
    }

    get summaryPath() {
        return join(this.dir, "summary.json")
    }

    get saltPath() {
        return join(this.dir, "salt.txt")
    }

    dayFilePath(day) {
        return join(this.dir, `views-${day}.jsonl`)
    }

    async initialize() {
        await mkdir(this.dir, { recursive: true })
        await this.#loadSalt()
        await this.#loadSummary()

        // Periodic + shutdown-safe flushing (unref: never keeps the process alive)
        this.flushTimer = setInterval(() => {
            this.flush().catch(() => {})
        }, FLUSH_INTERVAL_MS)
        if (this.flushTimer.unref) this.flushTimer.unref()

        // Daily retention cleanup
        this.cleanupTimer = setInterval(
            () => {
                this.cleanup().catch(() => {})
            },
            24 * 60 * 60 * 1000
        )
        if (this.cleanupTimer.unref) this.cleanupTimer.unref()

        await this.cleanup()
        return this
    }

    async #loadSalt() {
        if (this.salt) return
        try {
            if (existsSync(this.saltPath)) {
                const value = (await readFile(this.saltPath, "utf8")).trim()
                if (value) {
                    this.salt = value
                    return
                }
            }
            this.salt = randomBytes(32).toString("hex")
            await writeFile(this.saltPath, this.salt + "\n", "utf8")
        } catch (error) {
            console.error("[analytics] could not initialise salt:", error.message)
            this.salt = this.salt || randomBytes(16).toString("hex")
        }
    }

    async #loadSummary() {
        try {
            if (existsSync(this.summaryPath)) {
                const raw = await readFile(this.summaryPath, "utf8")
                if (raw && raw.trim() !== "") {
                    const parsed = JSON.parse(raw)
                    if (parsed && typeof parsed === "object" && parsed.byDay) {
                        this.summary = this.#normalizeSummary(parsed)
                        // Migrate legacy percent-encoded path keys, then persist
                        // the cleaned aggregate (see #migrateEncodedKeys).
                        this.#migrateEncodedKeys()
                        if (this.dirty) await this.flush()
                        return
                    }
                }
            }
        } catch (error) {
            console.warn("[analytics] summary.json unreadable, rebuilding from logs:", error.message)
        }
        this.summary = await this.#rebuildFromLogs()
        this.dirty = true
        await this.flush()
    }

    #normalizeSummary(parsed) {
        return {
            version: 1,
            updatedAt: parsed.updatedAt || new Date().toISOString(),
            totals: { pv: parsed.totals?.pv || 0 },
            byDay: parsed.byDay || {},
            byContent: parsed.byContent || {},
        }
    }

    /**
     * One-time key migration: paths used to be stored percent-encoded
     * (`path:/tag/%E5%B0%8F%E5%AD%A6`). Decode them and merge duplicates so the
     * aggregate file holds one canonical entry per page.
     */
    #migrateEncodedKeys() {
        if (!this.summary) return

        const decodeKey = (key) => {
            if (typeof key !== "string" || !key.startsWith("path:")) return key
            const raw = key.slice(5)
            try {
                return `path:${decodeURIComponent(raw)}`
            } catch {
                return key
            }
        }

        let changed = false

        // byContent: merge counts + keep the richest metadata
        const merged = {}
        for (const [key, entry] of Object.entries(this.summary.byContent || {})) {
            const canonical = decodeKey(key)
            if (!merged[canonical]) {
                merged[canonical] = { ...(entry || {}) }
            } else {
                const target = merged[canonical]
                target.pv = (target.pv || 0) + (entry?.pv || 0)
                if (!target.title && entry?.title) target.title = entry.title
                if (!target.slug && entry?.slug) target.slug = entry.slug
                if (!target.type && entry?.type) target.type = entry.type
            }
            if (canonical !== key) changed = true
        }
        if (changed) this.summary.byContent = merged

        // Legacy entries stored their own path as the "title"; drop those so
        // reports render a proper label (首页 / 标签：X / …) instead. Compare
        // both the raw and the percent-decoded form, since older entries used
        // the encoded path as their title.
        const samePath = (value, path) => {
            if (value === path) return true
            try {
                return decodeURIComponent(value) === path
            } catch {
                return false
            }
        }
        for (const [key, entry] of Object.entries(this.summary.byContent || {})) {
            if (!key.startsWith("path:") || !entry?.title) continue
            if (samePath(entry.title, key.slice(5))) {
                entry.title = ""
                changed = true
            }
        }

        // byDay[day].ct: same treatment per day
        for (const [day, entry] of Object.entries(this.summary.byDay || {})) {
            const ct = entry?.ct
            if (!ct) continue
            const dayMerged = {}
            for (const [key, count] of Object.entries(ct)) {
                const canonical = decodeKey(key)
                dayMerged[canonical] = (dayMerged[canonical] || 0) + count
                if (canonical !== key) changed = true
            }
            if (changed) entry.ct = dayMerged
        }

        if (changed) {
            this.dirty = true
            this._countsCache = null
        }
    }

    /** Rebuild the aggregate summary by scanning retained JSONL files. */
    async #rebuildFromLogs() {
        const summary = {
            version: 1,
            updatedAt: new Date().toISOString(),
            totals: { pv: 0 },
            byDay: {},
            byContent: {},
        }

        const days = await this.listDays()
        for (const day of days) {
            const events = await this.readDay(day)
            for (const ev of events) {
                this.#applyEvent(summary, ev)
            }
        }
        return summary
    }

    #applyEvent(summary, ev) {
        if (!ev) return
        const day = ev.d || dayKey(new Date(ev.t || Date.now()))

        summary.totals.pv += 1

        if (!summary.byDay[day]) summary.byDay[day] = emptyDayEntry()
        const d = summary.byDay[day]
        d.pv += 1
        bump(d.dev, ev.dv)
        bump(d.os, ev.os)
        bump(d.br, ev.br)
        if (ev.rf) bump(d.rf, ev.rf)

        const key = ev.k || `path:${ev.p || "/"}`
        if (ev.ct !== false) bump(d.ct, key)

        const entry = summary.byContent[key] || {
            slug: ev.s || "",
            // Only real content titles are stored; for plain pages this stays
            // empty so reports can render a readable label from the route.
            title: ev.ti || ev.s || "",
            type: ev.ty || "unknown",
            pv: 0,
        }
        if (ev.ti) entry.title = ev.ti
        if (ev.s) entry.slug = ev.s
        if (ev.ty) entry.type = ev.ty
        entry.pv += 1
        summary.byContent[key] = entry
    }

    /**
     * Record one visit.
     * @param {Object} event - {t,day,path,key,slug,title,type,ipMasked,ipHash,device,os,browser,referrer}
     */
    async record(event) {
        const day = event.day || dayKey(new Date(event.t || Date.now()))
        const line =
            JSON.stringify({
                t: event.t || new Date().toISOString(),
                d: day,
                p: event.path,
                k: event.key,
                s: event.slug || "",
                ti: event.title || "",
                ty: event.type || "",
                ipm: event.ipMasked || "",
                iph: event.ipHash || "",
                dv: event.device || "unknown",
                os: event.os || "unknown",
                br: event.browser || "unknown",
                rf: event.referrer || "",
            }) + "\n"

        try {
            await appendFile(this.dayFilePath(day), line, "utf8")
        } catch (error) {
            console.error("[analytics] append failed:", error.message)
        }

        this.#applyEvent(this.summary, {
            t: event.t,
            d: day,
            p: event.path,
            k: event.key,
            s: event.slug,
            ti: event.title,
            ty: event.type,
            dv: event.device,
            os: event.os,
            br: event.browser,
            rf: event.referrer,
        })
        this._countsCache = null
        this.dirty = true
        this.#scheduleFlush()
    }

    #scheduleFlush() {
        const elapsed = Date.now() - this.lastFlushAt
        if (elapsed >= FLUSH_INTERVAL_MS) {
            this.flush().catch(() => {})
            return
        }
        if (this.flushTimer) return // interval will pick it up
    }

    async flush() {
        if (!this.dirty || !this.summary) return
        const payload = JSON.stringify({ ...this.summary, updatedAt: new Date().toISOString() })
        const tmp = `${this.summaryPath}.tmp`
        try {
            await writeFile(tmp, payload, "utf8")
            await rename(tmp, this.summaryPath)
            this.dirty = false
            this.lastFlushAt = Date.now()
        } catch (error) {
            console.error("[analytics] flush failed:", error.message)
        }
    }

    /** Best-effort synchronous flush for process exit handlers. */
    flushSync() {
        if (!this.dirty || !this.summary) return
        try {
            writeFileSync(this.summaryPath, JSON.stringify({ ...this.summary, updatedAt: new Date().toISOString() }), "utf8")
            this.dirty = false
        } catch {
            /* ignore */
        }
    }

    async listDays() {
        try {
            const files = await readdir(this.dir)
            return files
                .map((f) => /^views-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1])
                .filter(Boolean)
                .sort()
        } catch {
            return []
        }
    }

    async readDay(day) {
        try {
            const raw = await readFile(this.dayFilePath(day), "utf8")
            const events = []
            for (const line of raw.split("\n")) {
                if (!line.trim()) continue
                try {
                    events.push(JSON.parse(line))
                } catch {
                    /* skip malformed line */
                }
            }
            return events
        } catch {
            return []
        }
    }

    /** Read every retained event (bounded by retentionDays). */
    async readAll() {
        const days = await this.listDays()
        const all = []
        for (const day of days) {
            const events = await this.readDay(day)
            for (const ev of events) all.push(ev)
        }
        return all
    }

    /**
     * Aggregate counters for the frontend (keyed lookups by id / slug / path).
     * Cached until the next recorded visit.
     * @returns {{byId: Object, bySlug: Object, byPath: Object, byKey: Object}}
     */
    counts() {
        if (this._countsCache) return this._countsCache
        const byId = {}
        const bySlug = {}
        const byPath = {}
        const byKey = {}
        for (const [key, entry] of Object.entries(this.summary?.byContent || {})) {
            byKey[key] = entry.pv
            if (key.startsWith("id:")) byId[key.slice(3)] = entry.pv
            else if (key.startsWith("path:")) byPath[key.slice(5)] = entry.pv
            if (entry.slug) bySlug[entry.slug] = entry.pv
        }
        this._countsCache = { byId, bySlug, byPath, byKey }
        return this._countsCache
    }

    /** Look up the view count for a content item (id wins over slug). */
    viewCountFor({ id, slug, path } = {}) {
        const c = this.counts()
        if (id && c.byId[id] != null) return c.byId[id]
        if (slug && c.bySlug[slug] != null) return c.bySlug[slug]
        if (path && c.byPath[path] != null) return c.byPath[path]
        return 0
    }

    /** Delete raw JSONL files older than the retention window. */
    async cleanup() {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - this.retentionDays)
        const cutoffKey = dayKey(cutoff)

        try {
            for (const day of await this.listDays()) {
                if (day < cutoffKey) {
                    await unlink(this.dayFilePath(day)).catch(() => {})
                }
            }
        } catch (error) {
            console.error("[analytics] cleanup failed:", error.message)
        }

        // Trim very old daily aggregates (keep trends bounded)
        if (this.summary?.byDay) {
            const historyCutoff = new Date()
            historyCutoff.setDate(historyCutoff.getDate() - MAX_DAY_HISTORY)
            const historyKey = dayKey(historyCutoff)
            let trimmed = false
            for (const day of Object.keys(this.summary.byDay)) {
                if (day < historyKey) {
                    delete this.summary.byDay[day]
                    trimmed = true
                }
            }
            if (trimmed) this.dirty = true
        }
    }

    async close() {
        if (this.flushTimer) clearInterval(this.flushTimer)
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
        await this.flush()
    }
}

export { dayKey }
