/**
 * Attachment blocks — collect every `[file:path|名称]` reference from an
 * article and render a tidy download list (icon by type, human-readable size).
 *
 * Files live in `content/uploads/{documents,images}/` (the media library keeps a
 * `<filename>.metadata.json` sidecar next to each one). The block is appended to
 * the rendered article body, so it works on EVERY theme without template edits.
 */

import { existsSync, statSync } from "node:fs"
import { basename, extname, join, normalize, sep } from "node:path"

/**
 * Defaults used when a caller does not pass options. `core/app.js` configures
 * these from the app config so a custom uploads directory keeps working; the
 * static generator (run from the project root) simply uses the defaults.
 */
const defaults = { uploadsDir: "content/uploads", urlPrefix: "/content/uploads" }

export function configureAttachments(options = {}) {
    if (options.uploadsDir) defaults.uploadsDir = options.uploadsDir
    if (options.urlPrefix) defaults.urlPrefix = options.urlPrefix.replace(/\/+$/, "")
    return { ...defaults }
}

/** Icon + label per file family (kept dependency-free, emoji only). */
const TYPE_TABLE = [
    { exts: ["pdf"], icon: "📕", label: "PDF" },
    { exts: ["doc", "docx", "odt", "rtf"], icon: "📘", label: "文档" },
    { exts: ["xls", "xlsx", "ods", "csv"], icon: "📗", label: "表格" },
    { exts: ["ppt", "pptx", "odp"], icon: "📙", label: "演示" },
    { exts: ["zip", "rar", "7z", "tar", "gz"], icon: "🗜️", label: "压缩包" },
    { exts: ["txt", "md"], icon: "📄", label: "文本" },
    { exts: ["mp4", "mov", "mkv", "avi", "webm"], icon: "🎬", label: "视频" },
    { exts: ["mp3", "wav", "flac", "m4a", "ogg"], icon: "🎵", label: "音频" },
    { exts: ["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp"], icon: "🖼️", label: "图片" },
]

function typeInfo(ext) {
    const found = TYPE_TABLE.find((entry) => entry.exts.includes(ext))
    return found || { icon: "📎", label: ext ? ext.toUpperCase() : "文件" }
}

/** 1 234 567 → "1.2 MB" */
export function formatBytes(bytes) {
    const value = Number(bytes)
    if (!Number.isFinite(value) || value <= 0) return ""
    const units = ["B", "KB", "MB", "GB", "TB"]
    let size = value
    let unit = 0
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit++
    }
    const rounded = size >= 100 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10
    return `${rounded} ${units[unit]}`
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

/**
 * Every `[file:path|名称]` directive outside code fences / inline code.
 * @param {string} markdown
 * @returns {Array<{path: string, name: string}>}
 */
export function extractFileDirectives(markdown) {
    if (!markdown || typeof markdown !== "string") return []
    const prose = markdown
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/~~~[\s\S]*?~~~/g, " ")
        .replace(/`[^`\n]*`/g, " ")

    const out = []
    const re = /\[file:([^\]|]+)(?:\|([^\]]*))?\]/g
    let m
    while ((m = re.exec(prose)) !== null) {
        const path = m[1].trim()
        if (!path) continue
        out.push({ path, name: (m[2] || "").trim() })
    }
    return out
}

/**
 * Resolve directives into a list with size / type / URL, reading the real files
 * from the uploads directory (no HTTP, no network).
 *
 * @param {string} markdown
 * @param {Object} options
 * @param {string} [options.uploadsDir="content/uploads"]
 * @param {string} [options.urlPrefix="/content/uploads"]
 * @returns {Array<Object>}
 */
export function buildAttachmentList(markdown, options = {}) {
    const uploadsDir = options.uploadsDir || defaults.uploadsDir
    const urlPrefix = options.urlPrefix || defaults.urlPrefix
    const seen = new Set()
    const list = []

    for (const directive of extractFileDirectives(markdown)) {
        const isExternal = /^https?:\/\//i.test(directive.path)
        const rawName = directive.name || basename(directive.path)
        const ext = extname(directive.path).replace(/^\./, "").toLowerCase()
        const info = typeInfo(ext)
        const key = `${directive.path}|${rawName}`
        if (seen.has(key)) continue
        seen.add(key)

        let size = null
        let exists = true
        if (!isExternal) {
            // Keep resolution inside the uploads directory (no path traversal)
            const safeRelative = normalize(directive.path).replace(/^([/\\])+/, "")
            const fullPath = join(uploadsDir, safeRelative)
            const uploadsRoot = normalize(uploadsDir) + sep
            const insideRoot = normalize(fullPath).startsWith(uploadsRoot)
            if (insideRoot && existsSync(fullPath)) {
                try {
                    size = statSync(fullPath).size
                } catch {
                    size = null
                }
            } else {
                exists = false
            }
        }

        list.push({
            name: rawName,
            path: directive.path,
            url: isExternal ? directive.path : `${urlPrefix}/${directive.path.replace(/^([/\\])+/, "")}`,
            ext,
            icon: info.icon,
            typeLabel: info.label,
            size,
            sizeText: formatBytes(size),
            external: isExternal,
            exists,
        })
    }

    return list
}

/**
 * Render the attachment block for an article body.
 * @returns {string} HTML fragment, or "" when the article has no attachments
 */
export function buildAttachmentBlock(markdown, options = {}) {
    const list = buildAttachmentList(markdown, options)
    if (list.length === 0) return ""

    const rows = list
        .map((item) => {
            const meta = [item.typeLabel, item.sizeText].filter(Boolean).join(" · ")
            const missing = !item.external && !item.exists
            return `<li class="post-attachment${missing ? " is-missing" : ""}">
  <a class="post-attachment-link" href="${escapeHtml(item.url)}"${
                item.external ? ' target="_blank" rel="noopener"' : " download"
            }>
    <span class="post-attachment-icon" aria-hidden="true">${item.icon}</span>
    <span class="post-attachment-text">
      <span class="post-attachment-name">${escapeHtml(item.name)}</span>
      <span class="post-attachment-meta">${escapeHtml(missing ? `${meta} · 文件缺失` : meta)}</span>
    </span>
  </a>
</li>`
        })
        .join("\n")

    return `<section class="post-attachments">
  <h3 class="post-attachments-title">附件（${list.length}）</h3>
  <ul class="post-attachments-list">
${rows}
  </ul>
</section>`
}
