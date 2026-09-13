/**
 * Video facade runtime — loads the real iframe only after the visitor clicks
 * (or when the autoplay playlist decides to start a video).
 *
 * Markup produced by the Markdown renderer (core/lib/markdown/markdown-renderer.js):
 *
 *   <figure class="video-facade" data-embed="https://…/videos/embed/<id>"
 *           data-title="…" data-duration="2279">
 *     <img class="video-facade-poster" …>        (PeerTube thumbnail, if cached)
 *     <button class="video-facade-play">▶ 28:22</button>
 *     <noscript><iframe …></noscript>
 *     <figcaption>…</figcaption>
 *   </figure>
 *
 * Benefits: no third-party iframe (and no cookies/bandwidth) until the visitor
 * actually wants to watch; pages with many videos stay fast.
 *
 * This file is the single iframe loader. assets/video-playlist.js (the
 * autoplay/sequential-playback controller) reuses `window.AetherVideoFacade`
 * instead of duplicating the loading logic.
 */
;(function () {
    "use strict"

    /**
     * Build the player URL for an embed base, adding the parameters browsers
     * need for programmatic playback:
     *   autoplay=1        start playing right away
     *   muted=1 / muted=0 required by every autoplay policy (unmute is a click)
     *   start=<seconds>s  resume position (PeerTube supports start/stop)
     *
     * `muted` is emitted explicitly (1 or 0) whenever the caller states an
     * intent, so a reload used to unmute cannot inherit the previous state.
     */
    function buildSrc(embed, options) {
        const opts = options || {}
        const params = []
        if (opts.autoplay !== false) params.push("autoplay=1")
        if (opts.muted !== undefined) params.push(opts.muted ? "muted=1" : "muted=0")
        const start = Math.floor(Number(opts.start) || 0)
        if (start > 1) params.push("start=" + start + "s")
        if (params.length === 0) return embed
        return embed + (embed.includes("?") ? "&" : "?") + params.join("&")
    }

    function removeVeil(facade) {
        const veil = facade.__aetherVeil
        if (veil) {
            veil.remove?.()
            facade.__aetherVeil = null
        }
    }

    /**
     * Full-poster click target shown while a programmatic (autoplay) start is
     * pending. Browsers may still refuse to autoplay; the veil gives the
     * visitor an obvious way to start the video with a real user gesture, and
     * the playlist removes it as soon as the player reports playback.
     */
    function addVeil(facade, frame, options) {
        removeVeil(facade)
        const veil = document.createElement("button")
        veil.type = "button"
        veil.className = "video-autoplay-veil"
        veil.setAttribute("aria-label", "播放视频")
        veil.innerHTML =
            '<span class="video-autoplay-veil-icon" aria-hidden="true">▶</span>' +
            '<span class="video-autoplay-veil-text">点击播放</span>'
        veil.addEventListener("click", (event) => {
            event.preventDefault()
            event.stopPropagation()
            removeVeil(facade)
            if (typeof options.onVeilClick === "function") {
                options.onVeilClick(facade, frame)
            } else {
                // Default: reload with autoplay — the click itself is the user
                // gesture that unlocks playback.
                frame.src = buildSrc(facade.dataset.embed, {
                    autoplay: true,
                    muted: options.muted,
                    start: options.start,
                })
            }
        })
        facade.appendChild(veil)
        facade.__aetherVeil = veil
        return veil
    }

    function activate(facade, options) {
        const opts = options || {}
        if (!facade || facade.dataset.loaded === "1") {
            return facade?.querySelector?.("iframe.video-iframe") || null
        }
        const embed = facade.dataset.embed
        if (!embed) return null

        facade.dataset.loaded = "1"
        facade.classList.add("is-playing")

        const frame = document.createElement("iframe")
        frame.className = "video-iframe"
        frame.src = buildSrc(embed, opts)
        frame.title = facade.dataset.title || "Video"
        frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        frame.allowFullscreen = true
        frame.setAttribute("loading", "lazy")

        // Replace the poster/button with the player, keep the caption bar
        facade.querySelectorAll(".video-facade-poster, .video-facade-placeholder, .video-facade-play").forEach((el) => el.remove())
        facade.insertBefore(frame, facade.firstChild)
        facade.__aetherFrame = frame

        if (opts.veil) addVeil(facade, frame, opts)
        // Programmatic starts must not steal the reader's scroll position.
        if (opts.focus !== false) frame.focus?.()
        return frame
    }

    function init() {
        document.querySelectorAll(".video-facade").forEach((facade) => {
            const button = facade.querySelector(".video-facade-play")
            if (button) button.addEventListener("click", () => userPlay(facade))
            // Clicking the poster also plays (but not the caption links)
            facade.addEventListener("click", (event) => {
                const target = event.target
                if (target.closest("a")) return
                if (target.closest(".video-facade-play")) return
                if (target.closest(".video-autoplay-veil")) return
                if (facade.dataset.loaded === "1") return
                userPlay(facade)
            })
        })
    }

    /** A real user click — let the playlist keep its queue in sync. */
    function userPlay(facade) {
        const playlist = window.AetherVideoPlaylist
        if (playlist && typeof playlist.userPlay === "function") {
            playlist.userPlay(facade)
            return
        }
        activate(facade, { autoplay: true })
    }

    window.AetherVideoFacade = { activate, buildSrc, removeVeil, userPlay }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init)
    } else {
        init()
    }
})()
