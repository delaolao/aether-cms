/**
 * Autoplay + sequential playback ("playlist") for videos embedded in a page.
 *
 * Goal: open an article that contains videos and the first one starts playing
 * by itself; when it ends the next one starts, in document order.
 *
 * Browser reality (why this file exists at all):
 *   - A page may only autoplay an iframe/video when it is MUTED (or when the
 *     visitor already interacted with the site), so autoplay always starts
 *     muted and the control bar offers a one-click "开声".
 *   - The player lives in a cross-origin iframe, so "has it ended?" cannot be
 *     read from the DOM. Verified against PeerTube 7.3 (stream.dleu.net):
 *     the embed page does NOT post plain events to its parent — PeerTube's
 *     official "Embed API" requires `?api=1` plus the `@peertube/embed-api`
 *     jschannel client, which this project deliberately does not vendor.
 *     What is used instead:
 *       1. the video duration cached in the HTML (`data-duration`, filled from
 *          the PeerTube metadata cache) drives a timer that offers the next
 *          video when the estimated end is reached — with a visible countdown
 *          the visitor can cancel (a timer cannot know about pauses/seeks);
 *       2. local `<video>` elements (`[video:file.mp4]`) use their exact
 *          native `ended` event;
 *       3. `postMessage` payloads are still parsed defensively, so players or
 *          future PeerTube versions that do report events get exact handling
 *          (`playbackState: "ended"`, `position`, `duration` all map onto the
 *          same state machine). Nothing happens when no message ever arrives.
 *
 * Config injected by core/app.js as window.__AETHER_VIDEO_PLAYLIST__:
 *   { enabled: <VIDEO_AUTOPLAY>, muted: <VIDEO_AUTOPLAY_MUTED> }
 * Visitors can override both from the on-page control bar (localStorage).
 *
 * Debugging: append ?aether-video-debug=1 to the URL to log every message the
 * player sends (used to confirm/extend the event parsing above).
 */
;(function () {
    "use strict"

    var CFG = window.__AETHER_VIDEO_PLAYLIST__ || {}

    var facadeApi = window.AetherVideoFacade || null
    // The facade runtime is a `defer` script too and themes often include it
    // themselves, so it may not have run yet when this file is evaluated —
    // always resolve it lazily instead of caching a possibly-undefined value.
    function api() {
        if (!facadeApi && window.AetherVideoFacade) facadeApi = window.AetherVideoFacade
        return facadeApi
    }
    var DEBUG = /[?&]aether-video-debug=1/.test(window.location.search)
    var LS_AUTOPLAY = "aether.video.autoplay"
    var LS_MUTED = "aether.video.muted"

    var state = {
        items: [],
        index: -1,
        // Site default; a visitor's stored choice always wins (see init()).
        enabled: CFG.enabled !== false,
        muted: CFG.muted !== false,
        duration: 0,
        knownTime: 0,
        startedAt: 0,
        gotMessage: false,
        hidden: false,
        finished: false,
        timer: null,
        countdown: null,
        pending: false,
        veilTimer: null,
        observer: null,
        bar: null,
        els: {},
        debug: "",
    }

    // ------------------------------------------------------------------ utils
    function lsGet(key) {
        try {
            return window.localStorage.getItem(key)
        } catch (error) {
            return null
        }
    }

    function lsSet(key, value) {
        try {
            window.localStorage.setItem(key, value)
        } catch (error) {
            /* private mode — just keep the in-memory value */
        }
    }

    function num(value) {
        var parsed = Number(value)
        return isFinite(parsed) && parsed > 0 ? parsed : 0
    }

    function isVisible(el) {
        if (!el || typeof el.getBoundingClientRect !== "function") return true
        var rect = el.getBoundingClientRect()
        var vh = window.innerHeight || 800
        return rect.top < vh * 0.85 && rect.bottom > 0
    }

    function reduceMotion() {
        try {
            return window.matchMedia("(prefers-reduced-motion: reduce)").matches
        } catch (error) {
            return false
        }
    }

    function saveData() {
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection
        return !!(conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || "")))
    }

    // ------------------------------------------------------------- collection
    function collect() {
        var nodes = document.querySelectorAll(".video-facade[data-embed], video.video-local")
        var items = []
        Array.prototype.forEach.call(nodes, function (el) {
            if (el.tagName === "VIDEO") {
                items.push({ el: el, kind: "native", type: "local", duration: num(el.duration), autoAdvance: true, ended: false })
                return
            }
            var cls = String(el.className || "")
            var type = cls.indexOf("video-peertube") >= 0 ? "peertube" : cls.indexOf("video-bilibili") >= 0 ? "bilibili" : "other"
            items.push({
                el: el,
                kind: "facade",
                type: type,
                duration: num(el.dataset && el.dataset.duration),
                // PeerTube playback can be advanced automatically (duration is
                // cached + the player reports events). Bilibili exposes neither,
                // so its queue entry waits for the ⏭ button.
                autoAdvance: type === "peertube",
                ended: false,
            })
        })
        return items
    }

    function currentItem() {
        return state.index >= 0 ? state.items[state.index] : null
    }

    function currentFrame() {
        var item = currentItem()
        if (!item || item.kind !== "facade") return null
        return item.el.querySelector("iframe.video-iframe")
    }

    // ------------------------------------------------------------------ timing
    function clearTimer() {
        if (state.timer) {
            window.clearTimeout(state.timer)
            state.timer = null
        }
    }

    function playedSeconds() {
        if (state.knownTime > 0) return state.knownTime
        if (!state.startedAt) return 0
        return Math.max(0, (Date.now() - state.startedAt) / 1000)
    }

    function armTimer() {
        clearTimer()
        if (!state.enabled || state.hidden || state.index < 0) return
        var item = currentItem()
        if (!item || !item.autoAdvance) return
        if (item.kind === "native" && item.el.paused) return
        var total = state.duration || item.duration || 0
        if (!total) return
        var remaining = Math.max(0, (total - playedSeconds()) * 1000)
        // A little slack so the player's own "ended" wins the race when the
        // player does report events; the timer only covers the silent case.
        var slack = state.knownTime > 0 ? 2000 : 3500
        state.timer = window.setTimeout(function () {
            offerNext("timer")
        }, remaining + slack)
    }

    // --------------------------------------------------------------- playlist
    function activate(index, programmatic) {
        var item = state.items[index]
        if (!item) return
        clearTimer()
        dismissVeil()
        state.index = index
        state.knownTime = 0
        state.gotMessage = false
        state.finished = false
        state.startedAt = Date.now()
        state.duration = item.duration || 0
        markCurrent(item)

        if (item.kind === "native") {
            var video = item.el
            video.muted = !!state.muted
            try {
                video.currentTime = 0
            } catch (error) {
                /* not seekable yet */
            }
            var promise = video.play()
            if (promise && typeof promise.catch === "function") {
                promise.catch(function () {
                    hint("浏览器阻止了自动播放，点击视频开始")
                })
            }
            if (num(video.duration)) state.duration = num(video.duration)
        } else if (api()) {
            var frame = api().activate(item.el, {
                autoplay: true,
                muted: !!state.muted,
                // never steal the reader's scroll position on a programmatic start
                focus: !programmatic,
                // a click target stays on top until the player reports playback
                veil: !!programmatic,
                onVeilClick: function (facade, playerFrame) {
                    playerFrame.src = api().buildSrc(facade.dataset.embed, {
                        autoplay: true,
                        muted: state.muted,
                        start: state.knownTime,
                    })
                    state.startedAt = Date.now()
                },
            })
            item.frame = frame || null
            if (programmatic) armVeilWatch(item)
        }

        armTimer()
        updateBar()
    }

    /** Start the queue from the top (or resume it after enabling). */
    function startPlaylist() {
        if (!state.enabled) return
        if (state.index >= 0 && currentItem() && currentItem().el.dataset.loaded === "1") {
            armTimer()
            return
        }
        activate(0, true)
    }

    function next(reason) {
        clearTimer()
        stopCountdown()
        if (DEBUG && reason) setDebug("advance → " + reason)
        if (!state.enabled) return
        var index = state.index + 1
        if (index >= state.items.length) {
            finish()
            return
        }
        scrollToItem(state.items[index])
        activate(index, true)
    }

    /**
     * Timer-based advance is only an estimate (the player lives in a
     * cross-origin iframe and may not report events at all), so the visitor
     * gets a few seconds to cancel before the page moves on.
     * Event-driven advances (native `ended`) are exact and go straight ahead.
     */
    function offerNext(reason) {
        var item = currentItem()
        if (!item || !state.enabled) return
        if (reason !== "timer") {
            next(reason)
            return
        }
        if (state.countdown || item.suppressed) return
        var left = Math.round(Number(CFG.confirmSeconds) || 5)
        state.pending = true
        updateBar()
        tick()
        state.countdown = window.setInterval(function () {
            left -= 1
            if (left <= 0) {
                stopCountdown()
                next("timer")
            } else {
                tick()
            }
        }, 1000)

        function tick() {
            hint("当前视频已到预计时长，" + left + " 秒后播放下一个")
        }
    }

    function stopCountdown() {
        if (state.countdown) {
            window.clearInterval(state.countdown)
            state.countdown = null
        }
        if (state.pending) {
            state.pending = false
            hint("")
        }
        updateBar()
    }

    /** Visitor pressed "取消" on the countdown: keep this video, stop auto-advance. */
    function cancelNext() {
        var item = currentItem()
        stopCountdown()
        if (item) item.suppressed = true
        hint("已取消自动播放下一个（可点「⏭ 下一个」继续）")
    }

    function finish() {
        state.finished = true
        state.index = state.items.length - 1
        updateBar()
        hint("全部 " + state.items.length + " 个视频已播放完毕")
    }

    function scrollToItem(item) {
        if (!item || !item.el || typeof item.el.scrollIntoView !== "function") return
        if (isVisible(item.el)) return
        try {
            item.el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" })
        } catch (error) {
            try {
                item.el.scrollIntoView()
            } catch (inner) {
                /* nothing else to try */
            }
        }
    }

    function markCurrent(item) {
        state.items.forEach(function (entry) {
            if (entry === item) {
                entry.el.classList.add("is-current")
                entry.el.setAttribute("data-video-current", "1")
            } else {
                entry.el.classList.remove("is-current")
                entry.el.removeAttribute("data-video-current")
            }
        })
    }

    // ------------------------------------------------------ player → page API
    var EVENT_RE = /^(play|playing|started|pause|paused|ended|finish|finished|timeupdate|progress|seeking|seeked|canplay|loadedmetadata|ready|buffering|waiting)$/i
    var TIME_KEYS = /^(currentTime|current_time|time|position|currentSec|elapsed|playedSeconds)$/i
    var DURATION_KEYS = /^(duration|total|length)$/i
    // PeerTube's own vocabulary (`playbackState`) plus the event names it uses
    // in `playbackStatusUpdate` / `playbackStatusChange`.
    var STATE_KEYS = /^(playbackState|state|status)$/i
    var STATE_MAP = { playing: "play", paused: "pause", ended: "ended", unstarted: "pause" }

    /**
     * Collect event names / time values out of an unknown payload. PeerTube's
     * Embed API speaks jschannel (`{method:'playbackStatusUpdate', params:{…}}`)
     * and is only active with `?api=1`, but nothing is assumed here: any of
     * `{event:'ended'}`, `{type:'ended'}`, `{playbackState:'ended'}` — or a
     * nested variant — is accepted, and an unrecognised payload is ignored.
     */
    function inspect(data) {
        var out = { events: [], time: null, duration: null }
        walk(data, out, 0)
        return out
    }

    function walk(data, out, depth) {
        if (data === null || data === undefined || depth > 3) return
        if (typeof data === "string") {
            var text = data.trim()
            if (EVENT_RE.test(text)) out.events.push(text.toLowerCase())
            return
        }
        if (typeof data !== "object") return
        if (Array.isArray(data)) {
            for (var i = 0; i < data.length; i++) walk(data[i], out, depth + 1)
            return
        }
        var keys = Object.keys(data)
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k]
            var value = data[key]
            if (typeof value === "string") {
                var text = value.trim()
                var lower = text.toLowerCase()
                if (EVENT_RE.test(text)) out.events.push(lower)
                else if (STATE_KEYS.test(key) && STATE_MAP[lower]) out.events.push(STATE_MAP[lower])
                else if (TIME_KEYS.test(key) && isFinite(Number(text))) out.time = Number(text)
                else if (DURATION_KEYS.test(key) && isFinite(Number(text))) out.duration = Number(text)
            } else if (typeof value === "number") {
                if (TIME_KEYS.test(key)) out.time = value
                else if (DURATION_KEYS.test(key)) out.duration = value
            } else if (value && typeof value === "object") {
                walk(value, out, depth + 1)
            }
        }
    }

    function onMessage(event) {
        var frame = currentFrame()
        if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return
        var info = inspect(event.data)
        if (DEBUG) {
            setDebug((info.events.join("/") || "message") + (info.time === null ? "" : " @" + Math.round(info.time) + "s"))
            try {
                window.console.log("[aether-video] message", event.data, info)
            } catch (error) {
                /* ignore */
            }
        }
        // Any traffic from the player proves it can talk to us: the veil is no
        // longer needed and the timer can trust exact positions.
        state.gotMessage = true
        dismissVeil()

        if (info.time !== null && isFinite(info.time) && info.time >= 0) state.knownTime = info.time
        if (num(info.duration)) state.duration = num(info.duration)

        if (info.events.indexOf("ended") >= 0 || info.events.indexOf("finish") >= 0 || info.events.indexOf("finished") >= 0) {
            next("player")
            return
        }
        if (info.events.indexOf("pause") >= 0 || info.events.indexOf("paused") >= 0) {
            clearTimer()
            return
        }
        armTimer()
    }

    function armVeilWatch(item) {
        if (state.veilTimer) window.clearTimeout(state.veilTimer)
        // If the player never talks to us we cannot tell "playing muted" from
        // "autoplay blocked"; after a few seconds the player's own controls are
        // the better fallback, so the extra veil is dropped.
        state.veilTimer = window.setTimeout(function () {
            if (state.gotMessage || currentItem() !== item) return
            removeVeil(item)
        }, 5000)
    }

    function dismissVeil() {
        var item = currentItem()
        if (item && item.kind === "facade") removeVeil(item)
    }

    function removeVeil(item) {
        if (!item) return
        var facade = api()
        if (facade && typeof facade.removeVeil === "function") facade.removeVeil(item.el)
        else if (item.el.__aetherVeil) {
            item.el.__aetherVeil.remove()
            item.el.__aetherVeil = null
        }
    }

    // -------------------------------------------------------- native <video>
    function bindNative(item) {
        var video = item.el
        var index = state.items.indexOf(item)
        video.muted = !!state.muted
        if (num(video.duration)) item.duration = num(video.duration)
        video.addEventListener("loadedmetadata", function () {
            if (num(video.duration)) item.duration = num(video.duration)
            if (currentItem() === item) {
                state.duration = item.duration
                armTimer()
            }
        })
        video.addEventListener("play", function () {
            if (currentItem() !== item) return
            state.startedAt = Date.now()
            armTimer()
        })
        video.addEventListener("pause", function () {
            if (currentItem() !== item) return
            clearTimer()
        })
        video.addEventListener("timeupdate", function () {
            if (currentItem() !== item || item.ended) return
            state.knownTime = video.currentTime
            state.duration = num(video.duration) || state.duration
            armTimer()
        })
        video.addEventListener("ended", function () {
            if (currentItem() !== item) return
            item.ended = true
            clearTimer()
            window.setTimeout(function () {
                item.ended = false
            }, 1500)
            next("native")
        })
        // A manual click on a native player joins the queue as well
        video.addEventListener("click", function () {
            if (state.index !== index && state.enabled) activate(index, false)
        })
    }

    // ------------------------------------------------------------------- bar
    function makeButton(className, label, onClick) {
        var button = document.createElement("button")
        button.type = "button"
        button.className = className
        button.addEventListener("click", onClick)
        button.textContent = label
        return button
    }

    function buildBar() {
        if (state.bar) return state.bar
        var bar = document.createElement("div")
        bar.className = "aether-video-bar"
        bar.setAttribute("role", "group")
        bar.setAttribute("aria-label", "视频播放控制")

        var toggle = makeButton("aether-video-bar-btn aether-video-bar-toggle", "⏸ 停止连播", function () {
            setEnabled(!state.enabled)
        })
        var status = document.createElement("span")
        status.className = "aether-video-bar-status"
        var mute = makeButton("aether-video-bar-btn aether-video-bar-mute", "🔊 开声", function () {
            setMuted(!state.muted)
        })
        var nextBtn = makeButton("aether-video-bar-btn aether-video-bar-next", "⏭ 下一个", function () {
            next("manual")
        })
        var replay = makeButton("aether-video-bar-btn aether-video-bar-replay", "↺ 重新播放", function () {
            setEnabled(true)
            activate(0, true)
        })
        var cancel = makeButton("aether-video-bar-btn aether-video-bar-cancel", "✋ 取消", cancelNext)
        var hintEl = document.createElement("span")
        hintEl.className = "aether-video-bar-hint"

        ;[toggle, status, mute, nextBtn, replay, cancel, hintEl].forEach(function (el) {
            bar.appendChild(el)
        })
        document.body.appendChild(bar)
        state.bar = bar
        state.els = { toggle: toggle, status: status, mute: mute, next: nextBtn, replay: replay, cancel: cancel, hint: hintEl }
        return bar
    }

    function updateBar() {
        if (!state.bar) return
        var els = state.els
        var total = state.items.length
        els.toggle.textContent = state.enabled ? "⏸ 停止连播" : "▶ 自动连播"
        els.toggle.setAttribute("aria-pressed", state.enabled ? "true" : "false")
        els.mute.textContent = state.muted ? "🔊 开声" : "🔇 静音"
        els.mute.setAttribute("aria-pressed", state.muted ? "false" : "true")
        els.next.hidden = total < 2
        els.replay.hidden = !(state.finished || state.index > 0) || total < 1
        els.cancel.hidden = !state.pending
        if (state.finished) {
            els.status.textContent = "已播完 " + total + " 个"
        } else if (state.index >= 0) {
            els.status.textContent = "第 " + (state.index + 1) + "/" + total + " 个"
        } else {
            els.status.textContent = total + " 个视频"
        }
        if (DEBUG && state.debug) els.status.textContent += " · " + state.debug
    }

    var hintTimer = null
    function hint(text) {
        if (!state.bar) return
        state.els.hint.textContent = text || ""
        if (hintTimer) window.clearTimeout(hintTimer)
        if (text) {
            hintTimer = window.setTimeout(function () {
                state.els.hint.textContent = ""
            }, 6000)
        }
    }

    function setDebug(text) {
        state.debug = text
        updateBar()
    }

    function setEnabled(enabled) {
        state.enabled = !!enabled
        lsSet(LS_AUTOPLAY, state.enabled ? "1" : "0")
        hint(state.enabled ? "自动连播已开启" : "自动连播已停止")
        if (state.enabled) {
            if (state.index < 0 || state.finished) startPlaylist()
            else armTimer()
        } else {
            clearTimer()
            if (state.observer) {
                state.observer.disconnect()
                state.observer = null
            }
        }
        updateBar()
    }

    function setMuted(muted) {
        state.muted = !!muted
        lsSet(LS_MUTED, state.muted ? "1" : "0")
        var item = currentItem()
        if (!item) {
            hint(state.muted ? "已设为静音播放" : "已设为带声播放")
            updateBar()
            return
        }
        if (item.kind === "native") {
            item.el.muted = state.muted
            updateBar()
            return
        }
        var frame = item.el.querySelector("iframe.video-iframe")
        if (!frame || !api()) {
            updateBar()
            return
        }
        // Reloading the player is the only way to change its volume from the
        // outside; the click is a user gesture, so sound is allowed now.
        var resume = state.knownTime > 2 ? state.knownTime : state.gotMessage ? 0 : playedSeconds()
        frame.src = api().buildSrc(item.el.dataset.embed, {
            autoplay: true,
            muted: state.muted,
            start: resume,
        })
        state.startedAt = Date.now()
        state.knownTime = 0
        armTimer()
        updateBar()
    }

    // ------------------------------------------------------------- lifecycle
    function scheduleStart() {
        if (!state.enabled || !state.items.length || state.index >= 0) return
        if (saveData()) {
            hint("检测到省流量模式，已暂停自动播放")
            return
        }
        if (isVisible(state.items[0].el)) {
            activate(0, true)
            return
        }
        // Video is below the fold: start when the reader reaches it, so the
        // page does not silently download video nobody looks at.
        if (typeof window.IntersectionObserver === "function") {
            state.observer = new window.IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].isIntersecting) {
                        state.observer.disconnect()
                        state.observer = null
                        if (state.enabled && state.index < 0) activate(0, true)
                        return
                    }
                }
            }, { threshold: 0.35 })
            state.observer.observe(state.items[0].el)
        } else {
            activate(0, true)
        }
    }

    function init() {
        state.items = collect()
        if (!state.items.length) return

        // explicit visitor choice wins over the site default
        var storedAutoplay = lsGet(LS_AUTOPLAY)
        if (storedAutoplay !== null) state.enabled = storedAutoplay === "1"
        var storedMuted = lsGet(LS_MUTED)
        if (storedMuted !== null) state.muted = storedMuted === "1"

        state.items.forEach(function (item) {
            if (item.kind === "native") bindNative(item)
        })

        buildBar()
        updateBar()
        window.addEventListener("message", onMessage)
        document.addEventListener("visibilitychange", function () {
            state.hidden = document.hidden
            if (state.hidden) {
                clearTimer()
            } else if (state.enabled && state.index >= 0) {
                var item = currentItem()
                var total = state.duration || (item && item.duration) || 0
                if (total && playedSeconds() >= total + 2) next("resume")
                else armTimer()
            }
        })
        scheduleStart()

        if (DEBUG) {
            try {
                window.console.log("[aether-video] playlist", state.items.length, "items", CFG)
            } catch (error) {
                /* ignore */
            }
        }
    }

    // Public hook used by assets/video-facade.js when a visitor clicks a poster
    window.AetherVideoPlaylist = {
        userPlay: function (facade) {
            var index = -1
            for (var i = 0; i < state.items.length; i++) {
                if (state.items[i].el === facade) {
                    index = i
                    break
                }
            }
            if (index < 0) {
                if (api()) api().activate(facade, { autoplay: true, muted: state.muted })
                return
            }
            activate(index, false)
        },
        state: state,
    }

    // Why always DOMContentLoaded (instead of running right away when the DOM
    // is already parsed): this file is injected at the top of <head>, while
    // themes include the facade runtime further down, and deferred scripts run
    // in document order — so at this point `window.AetherVideoFacade` may not
    // exist yet and the queue would have no runtime to drive.
    if (document.readyState === "complete") {
        init()
    } else {
        document.addEventListener("DOMContentLoaded", init, { once: true })
    }
})()
