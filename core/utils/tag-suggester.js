/**
 * Tag suggester — two interchangeable backends for auto-suggesting article tags.
 *
 *   1. "ollama"  : calls a local Ollama server (OLLAMA_URL) with a generative
 *                  prompt; requires Ollama running and a model pulled.
 *   2. "jieba"   : pure-WASM Chinese word segmentation (jieba-wasm) + POS filter
 *                  + frequency ranking; offline, free, no native build.
 *
 * Which one runs is controlled by:
 *   AI_BACKEND  = "ollama" | "jieba"   (optional)
 *   OLLAMA_URL  = e.g. http://127.0.0.1:11434   (default)
 *   OLLAMA_MODEL = e.g. qwen2.5:3b     (default)
 *
 * If "ollama" is chosen but fails (server down / no model), it falls back to
 * "jieba"; if jieba is not installed, returns backend "none".
 */

// --- jieba (lazy-loaded WASM) ------------------------------------------------
let jiebaPromise = null
async function getJieba() {
    if (!jiebaPromise) {
        jiebaPromise = import("jieba-wasm")
    }
    const mod = await jiebaPromise
    return mod.default || mod
}

// Content-word POS tags from jieba: nouns/places/orgs/persons/verbs/adjectives.
const CONTENT_POS = new Set([
    "n", "ns", "nz", "nt", "nr", "nrt", "nrfg", "ng", "nw", "nl", // nouns
    "v", "vn", "vg", "vi", "vd", // verbs
    "a", "an", "ad", "ag", // adjectives
    "i", // idiom
])
// A few extra function words POS filtering does not remove.
const STOPWORDS = new Set([
    "我们", "他们", "这个", "那个", "什么", "一个", "可以", "进行", "通过", "对于",
    "以及", "而且", "从而", "但是", "如果", "因为", "所以", "已经", "没有", "不会",
    "自己", "方面", "相关", "这篇", "文章", "本系统", "本课题",
])
// Words that are segmentable but never make good tags (technical filler / meta /
// generic verbs). Frequency extraction has no semantic judgement, so we hard-exclude
// these to avoid "空格"/"括号"-type suggestions.
const NOISE = new Set([
    "空格", "括号", "使用", "编辑", "渲染", "进行", "可以", "一个", "这个", "相关",
    "文档", "内容", "文章", "教程", "设置", "效果", "方式", "方法", "过程", "输入",
    "输出", "表示", "通过", "示例", "例子", "说明", "我们", "需要", "可能", "不同",
    "包括", "支持", "提供", "预览", "显示", "生成", "实现", "应用", "开发",
])
// Preference per POS tag — nouns/places/orgs beat verbs/adjectives.
const POS_PREF = {
    ns: 10, nz: 10, nt: 9, nr: 9, n: 8, nw: 7, i: 6, vn: 5,
    v: -4, a: -3, an: -3, ad: -3, ag: -3,
}

// Is the word "content-like"? contains at least one CJK char or ASCII letter/digit.
function isContentWord(word) {
    return /[\u4e00-\u9fa5a-zA-Z0-9]/.test(word)
}

/**
 * Extract tags from text using jieba segmentation + POS filter + a score that
 * strongly favours words appearing in the title and nouns, and demotes generic
 * verbs/adjectives. @returns {Promise<string[]>}
 */
async function extractKeywords(title, content, maxTags = 6) {
    const jieba = await getJieba()

    let titleWords = new Set()
    if (title) {
        try {
            titleWords = new Set(jieba.cut(title, true).map((w) => w.trim()).filter(Boolean))
        } catch {
            titleWords = new Set()
        }
    }

    const tagged = jieba.tag(content, true)
    const entries = new Map() // word -> { count, pos }

    for (const item of tagged || []) {
        const word = (item.word || "").trim()
        const pos = item.tag || ""
        if (!word || word.length < 2) continue
        if (pos && !CONTENT_POS.has(pos)) continue
        if (STOPWORDS.has(word) || NOISE.has(word)) continue
        if (!isContentWord(word)) continue

        const e = entries.get(word) || { count: 0, pos }
        e.count += 1
        e.pos = pos
        entries.set(word, e)
    }

    return Array.from(entries.entries())
        .map(([word, { count, pos }]) => {
            let score = count * 10
            if (titleWords.has(word)) score += 40
            score += POS_PREF[pos] || 0
            if (word.length >= 3) score += 2
            return [word, score]
        })
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
        .slice(0, maxTags)
        .map(([word]) => word)
}

// --- Ollama ------------------------------------------------------------------
async function suggestWithOllama(title, content) {
    const base = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "")
    const model = process.env.OLLAMA_MODEL || "qwen2.5:3b"

    const prompt = `你是内容标签助手。请阅读下面这篇文章，给出 3 到 6 个简洁、准确的关键词标签（中文优先，可含英文缩写）。只输出一个 JSON 字符串数组，例如 ["人工智能","机器学习"]，不要输出任何其它文字或解释。

标题：${title || "(无标题)"}

文章正文：
${String(content).slice(0, 6000)}`

    const controller = new AbortController()
    const timeoutMs = parseInt(process.env.AI_OLLAMA_TIMEOUT || "90000", 10) || 90000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // On big multi-NUMA CPU-only machines, too many llama.cpp threads make a
    // small model drastically SLOWER (thread spin > parallel speedup), and the
    // OLLAMA_NUM_THREADS env is not honoured by every build. Passing
    // options.num_thread per-request reliably caps it.
    const numThread = parseInt(process.env.AI_OLLAMA_NUM_THREADS || "4", 10) || 4
    try {
        const resp = await fetch(`${base}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
                format: "json",
                options: { num_thread: numThread },
            }),
            signal: controller.signal,
        })
        if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`)
        const data = await resp.json()
        const raw = data?.response
        if (!raw) return []

        // Normalise the model's output into a string array. Models differ: some
        // return a bare JSON array, some an object like {"tags": [...]},
        // {"tag": [...]} or {"标签": [...]}, and some wrap the array in prose.
        // Handle all of them (use the first array-valued property).
        const tryParse = (str) => {
            try {
                const v = JSON.parse(str)
                if (Array.isArray(v)) return v
                if (v && typeof v === "object") {
                    for (const key of Object.keys(v)) {
                        if (Array.isArray(v[key])) return v[key]
                    }
                }
                return []
            } catch {
                return []
            }
        }
        let tags = tryParse(raw)
        if (tags.length === 0) {
            // Fallback: pull the first [...] block out of prose.
            const m = String(raw).match(/\[[\s\S]*?\]/)
            if (m) tags = tryParse(m[0])
        }

        return tags
            .map((t) => String(t).trim().replace(/^["']|["']$/g, ""))
            .filter((t) => t && t.length <= 30)
            .slice(0, 8)
    } finally {
        clearTimeout(timer)
    }
}

// --- Public API --------------------------------------------------------------
/**
 * Suggest tags for a piece of content.
 * @param {{title?: string, content?: string}} payload
 * @returns {Promise<{backend: string, tags: string[], message?: string}>}
 */
export async function suggestTags({ title = "", content = "" } = {}) {
    const text = String(content || "").trim()
    if (!text) {
        return { backend: "none", tags: [], message: "请先输入正文" }
    }

    const backend = (
        process.env.AI_BACKEND ||
        (process.env.OLLAMA_URL ? "ollama" : "jieba")
    ).toLowerCase()

    if (backend === "ollama" && process.env.OLLAMA_URL) {
        try {
            const tags = await suggestWithOllama(title, text)
            if (tags.length) return { backend: "ollama", tags }
        } catch (error) {
            // fall through to jieba
        }
    }

    try {
        const tags = await extractKeywords(title, text, 8)
        if (tags.length) return { backend: "jieba", tags }
        return { backend: "jieba", tags: [], message: "jieba 未能提取出有效标签" }
    } catch (error) {
        return {
            backend: "none",
            tags: [],
            message: "没有可用的标签后端：请配置 OLLAMA_URL 或安装 jieba-wasm",
        }
    }
}
