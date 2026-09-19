/**
 * 站点时区工具 —— 让所有"给人和给日历看"的时间都按**站点时区**呈现，
 * 与服务器进程的时区解耦。
 *
 * 背景（2026-09-19 审计结论）：
 *   1. 存储层用 UTC ISO（`createdAt`/`updatedAt`、访问事件 `t`）是最佳实践，保持不变；
 *   2. 但**展示层**曾直接输出 UTC，或依赖 `Date` 的进程本地时区：
 *      - 后台「访问统计 → 最近访问」直接显示 `2026-09-18T23:12:52.336Z`（与北京时间差 8 小时）
 *      - 前台文章日期用 LiteNode 的 `dateFormat`（默认 `useUTC=true`），而 `publishDate` 存的是
 *        站点墙钟时间 → 北京时间 00:00–07:59 发布的文章会显示成**前一天**（线上已中招 2 篇）
 *      - 按天分档（`dayKey`）与排序依赖进程时区 → 一旦服务器不在东八区就整体偏移
 *   3. 本模块把这些都改成**显式时区**：服务器换到任何时区，结果都不变。
 *
 * 时区来源优先级：`SITE_TIME_ZONE` 环境变量 → `settings.json` 的 `timeZone` → 默认 `Asia/Shanghai`。
 * 设置是整体提交的，`settingsService.settings` 是同步可读的缓存，所以改设置立刻生效，无需重启。
 */

export const DEFAULT_SITE_TIME_ZONE = "Asia/Shanghai"

/** 站点时区名（如 Asia/Shanghai） */
let siteTimeZone = DEFAULT_SITE_TIME_ZONE
/** 惰性读取设置的回调（由 app.js 注入，读取 settingsService 的缓存） */
let settingProvider = null
/** 环境变量覆盖（最高优先级） */
const envTimeZone = () => {
    const raw = String(process.env.SITE_TIME_ZONE || "").trim()
    return raw || ""
}

/** 校验时区名；非法值回落到默认（避免 Intl 抛错把页面打挂） */
export function normalizeTimeZone(candidate) {
    const name = String(candidate || "").trim()
    if (!name) return DEFAULT_SITE_TIME_ZONE
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: name }).format(new Date())
        return name
    } catch {
        console.error(`[time] 无效时区 "${name}"，回落到 ${DEFAULT_SITE_TIME_ZONE}`)
        return DEFAULT_SITE_TIME_ZONE
    }
}

/** 由 app.js 调用：注入"读取设置里时区"的方式（同步） */
export function configureSiteTimeZoneProvider(provider) {
    settingProvider = typeof provider === "function" ? provider : null
    siteTimeZone = resolveSiteTimeZone()
    return siteTimeZone
}

/** 直接设定（测试或显式覆盖用） */
export function setSiteTimeZone(name) {
    siteTimeZone = normalizeTimeZone(name)
    return siteTimeZone
}

function resolveSiteTimeZone() {
    const fromEnv = envTimeZone()
    if (fromEnv) return normalizeTimeZone(fromEnv)
    if (settingProvider) {
        try {
            const fromSettings = settingProvider()
            if (fromSettings) return normalizeTimeZone(fromSettings)
        } catch {
            /* 读取失败就用当前值 */
        }
    }
    return siteTimeZone || DEFAULT_SITE_TIME_ZONE
}

/** 当前生效的站点时区 */
export function getSiteTimeZone() {
    return resolveSiteTimeZone()
}

/** 该时区在某时刻相对 UTC 的偏移（毫秒） */
function zoneOffsetMs(date, timeZone) {
    // 先把时间截到整秒：Intl 的 formatToParts 不含毫秒，不截会导致偏移算出 +07:59:59.664
    // 这种"差一秒"的结果（实测踩到过）。
    const whole = new Date(Math.floor(date.getTime() / 1000) * 1000)
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    })
    const parts = Object.fromEntries(dtf.formatToParts(whole).map((p) => [p.type, p.value]))
    const asUTC = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second)
    )
    return asUTC - whole.getTime()
}

/** 时区偏移的文本形式，如 `+08:00` */
export function zoneOffsetText(timeZone = getSiteTimeZone(), date = new Date()) {
    const ms = zoneOffsetMs(date, timeZone)
    const sign = ms < 0 ? "-" : "+"
    const abs = Math.abs(ms)
    const hh = String(Math.floor(abs / 3600000)).padStart(2, "0")
    const mm = String(Math.floor((abs % 3600000) / 60000)).padStart(2, "0")
    return `${sign}${hh}:${mm}`
}

/** 把任意时间值解析成 Date；无法解析时返回 null */
function toDate(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value
    if (typeof value === "number") return new Date(value)
    const date = new Date(value)
    return isNaN(date.getTime()) ? null : date
}

/**
 * 解析"站点时区里的墙钟时间"字符串。
 *
 * 为什么要它：`publishDate` 一直是**朴素本地时间**（`2026-09-17T22:38`，没有时区标记），
 * 而 `new Date("2026-09-17T22:38")` 会按**进程时区**解释 —— 服务器不在东八区时就会整体偏移。
 * 这里显式按站点时区解释，得到正确的绝对时刻。
 *
 * @param {string|Date|number} value
 * @returns {Date|null}
 */
export function parseSiteDateTime(value) {
    if (value instanceof Date || typeof value === "number") return toDate(value)
    const raw = String(value === undefined || value === null ? "" : value).trim()
    if (!raw) return null

    // 已带时区信息（Z / ±HH:MM）→ 交给 Date 解析
    if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) return toDate(raw)

    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
    if (!m) return toDate(raw)

    const [, y, mo, d, h = "0", mi = "0", s = "0"] = m
    const wallUTC = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
    const timeZone = getSiteTimeZone()
    // 偏移可能因夏令时变化，用两次逼近足够（Asia/Shanghai 无 DST，一次即准）
    let offset = zoneOffsetMs(new Date(wallUTC), timeZone)
    let instant = wallUTC - offset
    offset = zoneOffsetMs(new Date(instant), timeZone)
    instant = wallUTC - offset
    return new Date(instant)
}

/**
 * 按站点时区格式化。
 * 支持的占位符：YYYY MM DD HH mm ss（其余字符原样输出）。
 *
 * @param {string|Date|number} value
 * @param {string} pattern
 * @param {{timeZone?: string, naiveIsSiteTime?: boolean}} [options]
 *        naiveIsSiteTime: 对无时区标记的字符串，是否按站点时区解释（前台内容日期需要；UTC ISO 不需要）
 * @returns {string} 无法解析时返回 ""
 */
export function formatInSiteZone(value, pattern = "YYYY-MM-DD HH:mm:ss", options = {}) {
    const timeZone = normalizeTimeZone(options.timeZone || getSiteTimeZone())
    const date = options.naiveIsSiteTime ? parseSiteDateTime(value) : toDate(value)
    if (!date) return ""

    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour12: false,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        })
            .formatToParts(date)
            .map((p) => [p.type, p.value])
    )
    const map = {
        YYYY: parts.year,
        MM: parts.month,
        DD: parts.day,
        HH: parts.hour === "24" ? "00" : parts.hour,
        mm: parts.minute,
        ss: parts.second,
    }
    return String(pattern).replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => map[token])
}

/** 站点时区里的日期（YYYY-MM-DD）—— 用于按天分档、日报、留存裁剪 */
export function siteDayKey(date = new Date()) {
    return formatInSiteZone(date, "YYYY-MM-DD")
}

/** 展示用：站点时区里的日期时间（后台统一用这个） */
export function formatSiteDateTime(value, { naiveIsSiteTime = false } = {}) {
    return formatInSiteZone(value, "YYYY-MM-DD HH:mm:ss", { naiveIsSiteTime })
}

/**
 * 内容项"用于展示的日期"（YYYY-MM-DD）。
 * 优先 `publishDate`（作者填的，朴素站点时间），否则 `createdAt`（UTC ISO）。
 * 两者约定不同，这里统一按站点时区解析后再格式化，避免差一天。
 */
export function displayDateOf(frontmatter, pattern = "YYYY-MM-DD") {
    const fm = frontmatter || {}
    if (fm.publishDate) return formatInSiteZone(fm.publishDate, pattern, { naiveIsSiteTime: true })
    if (fm.createdAt) return formatInSiteZone(fm.createdAt, pattern)
    return ""
}

/** 内容项的绝对时刻（排序用）：两种约定都按站点时区正确解释 */
export function contentInstant(frontmatter) {
    const fm = frontmatter || {}
    if (fm.publishDate) {
        const d = parseSiteDateTime(fm.publishDate)
        if (d) return d
    }
    return toDate(fm.createdAt) || new Date(0)
}
