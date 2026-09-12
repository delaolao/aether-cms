/**
 * Lightweight User-Agent parsing for the built-in analytics module.
 *
 * Zero dependencies on purpose: the project avoids heavy frameworks, and a
 * small heuristic parser is enough to classify traffic into device / OS /
 * browser buckets for the dashboard. (Note: `ua-parser-js` v2 is AGPL — not
 * suitable here; `bowser` would be an option if richer parsing is ever needed.)
 *
 * Everything is derived from headers supplied by the client, so the values are
 * "best effort" and must never be treated as authenticated facts.
 */

// Known crawlers / bots / CLI clients. Matched case-insensitively against the UA.
const BOT_PATTERN = new RegExp(
    [
        "bot",
        "crawler",
        "spider",
        "crawl",
        "slurp",
        "bingpreview",
        "facebookexternalhit",
        "whatsapp",
        "telegrambot",
        "twitterbot",
        "discordbot",
        "embedly",
        "quora link preview",
        "pinterest",
        "vkShare",
        "W3C_Validator",
        "curl/",
        "wget",
        "python-requests",
        "python-urllib",
        "aiohttp",
        "httpx",
        "axios/",
        "node-fetch",
        "undici",
        "go-http-client",
        "java/",
        "okhttp",
        "libwww-perl",
        "headlesschrome",
        "phantomjs",
        "puppeteer",
        "playwright",
        "lighthouse",
        "pagespeed",
        "pingdom",
        "uptimerobot",
        "statuscake",
        "semrush",
        "ahrefs",
        "mj12bot",
        "dotbot",
        "yandex",
        "baiduspider",
        "sogou",
        "360spider",
        "bytespider",
        "petalbot",
        "applebot",
        "ia_archiver",
        "archive.org_bot",
        "gptbot",
        "chatgpt-user",
        "claudebot",
        "claude-web",
        "ccbot",
        "perplexity",
        "anthropic-ai",
        "feedfetcher",
        "feedly",
        "feedburner",
        "monitoring",
        "uptime",
    ].join("|"),
    "i"
)

/**
 * Whether the UA looks like a bot / automation client.
 * Missing UA is treated as a bot (browsers always send one).
 * @param {string} ua
 * @returns {boolean}
 */
export function isBot(ua) {
    if (!ua || typeof ua !== "string" || ua.trim() === "") return true
    return BOT_PATTERN.test(ua)
}

/**
 * Parse a User-Agent into coarse buckets.
 * @param {string} ua
 * @returns {{ device: string, os: string, browser: string }}
 */
export function parseUserAgent(ua) {
    const s = typeof ua === "string" ? ua : ""

    return {
        device: detectDevice(s),
        os: detectOs(s),
        browser: detectBrowser(s),
    }
}

function detectDevice(ua) {
    if (!ua) return "unknown"
    // Tablets first: iPad reports "Mobile" on newer iPadOS Safari, and Android
    // tablets omit "Mobile" — check explicit tablet markers before mobile.
    if (/iPad|Tablet|PlayBook|Silk|Kindle|Nexus 7|Nexus 9|SM-T|GT-P/i.test(ua)) return "tablet"
    if (/SmartTV|SMART-TV|AppleTV|GoogleTV|HbbTV|NetCast|Tizen|Web0S|WebOS TV|BRAVIA|Roku|Xbox|PlayStation/i.test(ua))
        return "tv"
    if (/Mobi|Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini|HarmonyOS/i.test(ua)) return "mobile"
    return "desktop"
}

function detectOs(ua) {
    if (!ua) return "unknown"
    if (/Windows NT 10\.0/i.test(ua)) return "Windows"
    if (/Windows NT 6\.3/i.test(ua)) return "Windows 8.1"
    if (/Windows NT 6\.1/i.test(ua)) return "Windows 7"
    if (/Windows/i.test(ua)) return "Windows (other)"
    if (/HarmonyOS|OpenHarmony/i.test(ua)) return "HarmonyOS"
    if (/Android/i.test(ua)) return "Android"
    if (/iPhone|iPad|iPod/i.test(ua)) return "iOS"
    if (/Mac OS X|Macintosh/i.test(ua)) return "macOS"
    if (/CrOS/i.test(ua)) return "ChromeOS"
    if (/Ubuntu/i.test(ua)) return "Ubuntu"
    if (/Fedora|Debian|CentOS|Red Hat|SUSE/i.test(ua)) return "Linux"
    if (/Linux/i.test(ua)) return "Linux"
    if (/FreeBSD|OpenBSD|NetBSD/i.test(ua)) return "BSD"
    return "unknown"
}

function detectBrowser(ua) {
    if (!ua) return "unknown"
    // Order matters: many browsers embed Chrome/Safari tokens.
    if (/Edg[A-Z]?\//i.test(ua)) return "Edge"
    if (/OPR\/|Opera/i.test(ua)) return "Opera"
    if (/SamsungBrowser/i.test(ua)) return "Samsung Internet"
    if (/UCBrowser|UCWEB/i.test(ua)) return "UC Browser"
    if (/QQBrowser/i.test(ua)) return "QQ Browser"
    if (/MiuiBrowser|XiaoMi/i.test(ua)) return "Mi Browser"
    if (/HuaweiBrowser|HBPC|HarmonyBrowser/i.test(ua)) return "Huawei Browser"
    if (/Vivaldi/i.test(ua)) return "Vivaldi"
    if (/Brave/i.test(ua)) return "Brave"
    if (/Firefox\/|FxiOS/i.test(ua)) return "Firefox"
    if (/CriOS/i.test(ua)) return "Chrome (iOS)"
    if (/Chrome\//i.test(ua)) return "Chrome"
    if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return "Safari"
    if (/MSIE|Trident/i.test(ua)) return "Internet Explorer"
    if (/WeChat|MicroMessenger/i.test(ua)) return "WeChat"
    return "unknown"
}

/**
 * Extract a referrer host from a Referer header, ignoring internal navigation
 * (same site) so the dashboard only shows genuine外部来源.
 *
 * @param {string} referer - Raw Referer header value
 * @param {string} host - Host of the current request (to detect internal)
 * @returns {string} Host name, or "" when empty/internal
 */
export function referrerHost(referer, host) {
    if (!referer || typeof referer !== "string") return ""
    try {
        const url = new URL(referer)
        const refHost = url.hostname.toLowerCase().replace(/^www\./, "")
        const selfHost = String(host || "")
            .split(":")[0]
            .toLowerCase()
            .replace(/^www\./, "")
        if (!refHost) return ""
        if (selfHost && refHost === selfHost) return ""
        return refHost
    } catch {
        return ""
    }
}
