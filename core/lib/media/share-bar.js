/**
 * Share bar — server-rendered sharing UI injected into content pages.
 *
 * Targets are chosen for domestic networks (no Twitter/X/Facebook): copy link,
 * WeChat / WeCom QR (WeChat cannot be shared by URL, so we show a QR + copy
 * hint), QQ and QZone share URLs, and print/save-as-PDF.
 *
 * The QR codes are generated HERE (server side, `qrcode` → inline SVG), so the
 * page needs no extra request, no third-party script and works offline.
 */

import QRCode from "qrcode"

function escapeAttr(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

function escapeHtml(value) {
    return escapeAttr(value).replace(/'/g, "&#39;")
}

/**
 * Inline SVG QR, or "" when generation fails (bar degrades gracefully).
 *
 * Uses the SYNCHRONOUS `QRCode.create()` (the `toString()` helper is async and
 * would render "[object Promise]"), then draws the module matrix as one SVG
 * path with crisp edges — scalable, no extra request, no client-side library.
 */
function qrSvg(text) {
    try {
        const qr = QRCode.create(text, { errorCorrectionLevel: "M" })
        const size = qr.modules.size
        const data = qr.modules.data
        const quiet = 2 // quiet zone, in modules
        const total = size + quiet * 2

        let path = ""
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (data[y * size + x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`
            }
        }

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" shape-rendering="crispEdges" role="img" aria-label="扫码打开本页"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${path}" fill="#111827"/></svg>`
    } catch (error) {
        console.warn("[share] QR generation failed:", error.message)
        return ""
    }
}

/**
 * Build the share bar markup for one page.
 *
 * @param {Object} params
 * @param {string} params.url - Canonical absolute URL of the page
 * @param {string} params.title - Page title
 * @param {string} [params.description] - Short description (for QQ/QZone)
 * @param {Array} [params.videos] - [{ watchUrl }] — adds "在 PeerTube 打开"
 * @returns {string} HTML (empty string when sharing is not applicable)
 */
export function buildShareBar({ url, title, description = "", videos = [] } = {}) {
    if (!url) return ""

    const safeUrl = escapeAttr(url)
    const safeTitle = escapeAttr(title || "")
    const safeDesc = escapeAttr((description || "").slice(0, 120))
    const encodedUrl = encodeURIComponent(url)
    const encodedTitle = encodeURIComponent(title || "")

    const qzone = `https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url=${encodedUrl}&title=${encodedTitle}&summary=${encodeURIComponent(
        description || ""
    )}`
    const qq = `https://connect.qq.com/widget/shareqq/index.html?url=${encodedUrl}&title=${encodedTitle}&desc=${encodeURIComponent(
        description || ""
    )}`

    const qr = qrSvg(url)
    const wechatPopover = `
    <div class="share-pop" data-pop="wechat" hidden>
      <div class="share-qr">${qr || '<span class="share-qr-missing">二维码生成失败，请直接复制链接</span>'}</div>
      <p class="share-qr-hint">用<b>微信</b>扫一扫打开本页；<br />手机端可直接点「复制链接」发给好友。</p>
    </div>`
    const wecomPopover = `
    <div class="share-pop" data-pop="wecom" hidden>
      <div class="share-qr">${qr || '<span class="share-qr-missing">二维码生成失败，请直接复制链接</span>'}</div>
      <p class="share-qr-hint">用<b>企业微信</b>扫一扫打开本页，或复制链接粘贴到会话中。</p>
    </div>`

    const videoLink = videos[0]?.watchUrl
        ? `<a class="share-btn share-link" href="${escapeAttr(videos[0].watchUrl)}" target="_blank" rel="noopener" title="在 PeerTube 打开原视频">🎞️ 原视频</a>`
        : ""

    return `<section class="share-bar" data-share-url="${safeUrl}" data-share-title="${safeTitle}">
  <span class="share-label" aria-hidden="true">分享</span>
  <button class="share-btn" type="button" data-share="copy" title="复制本页链接">🔗 复制链接</button>
  <span class="share-item">
    <button class="share-btn" type="button" data-share="pop" data-target="wechat" aria-expanded="false" title="用微信打开">💬 微信</button>
    ${wechatPopover}
  </span>
  <span class="share-item">
    <button class="share-btn" type="button" data-share="pop" data-target="wecom" aria-expanded="false" title="用企业微信打开">🏢 企业微信</button>
    ${wecomPopover}
  </span>
  <a class="share-btn share-link" href="${escapeAttr(qzone)}" target="_blank" rel="noopener" title="分享到 QQ 空间">⭐ QQ空间</a>
  <a class="share-btn share-link" href="${escapeAttr(qq)}" target="_blank" rel="noopener" title="分享给 QQ 好友">🐧 QQ</a>
  <button class="share-btn" type="button" data-share="print" title="打印或另存为 PDF">🖨️ 打印/PDF</button>
  ${videoLink}
  <span class="share-toast" role="status" aria-live="polite"></span>
</section>`
}
