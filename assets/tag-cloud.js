/**
 * Tag cloud (标签词云) — theme-agnostic, zero-dependency.
 *
 * Reads the tag list from either:
 *   1. an embedded `<script type="application/json" id="tag-cloud-data">` element
 *      (produced by the /tag-cloud route), or
 *   2. the public /api/tags endpoint (fallback).
 *
 * Then renders an `<a>` per tag, sized by frequency and colored by weight.
 * Clicking a tag navigates to /tag/<slug>, which lists all posts using it.
 */
(function () {
    "use strict"

    var MIN_SIZE = 0.85 // rem
    var MAX_SIZE = 2.5 // rem
    var PALETTE = ["#5b7cfa", "#42a5f5", "#26a69a", "#66bb6a", "#ffca28", "#ff7043", "#ec407a", "#ab47bc"]

    function readEmbedded(id) {
        var el = document.getElementById(id)
        if (!el) return null
        try {
            return JSON.parse(el.textContent)
        } catch (e) {
            return null
        }
    }

    function weightLevel(norm, maxLevel) {
        // norm is 0..1; map to 1..maxLevel
        return Math.max(1, Math.min(maxLevel, Math.round(norm * (maxLevel - 1)) + 1))
    }

    function esc(str) {
        return String(str).replace(/[&<>"]/g, function (ch) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]
        })
    }

    // Stable per-name seed so each tag floats at its own tempo / phase.
    function nameSeed(str) {
        var h = 0
        for (var i = 0; i < str.length; i++) {
            h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff
        }
        return h
    }

    // Match the same condition as the CSS prefers-reduced-motion media query.
    // When the user/OS asks for less motion we simply do NOT start the drift
    // (identical static chips everywhere), instead of relying on a stylesheet
    // override that inline animation longhands would otherwise win over.
    var REDUCED_MOTION =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches

    function render(container, tags) {
        if (!container) return
        container.innerHTML = ""

        if (!Array.isArray(tags) || tags.length === 0) {
            container.innerHTML = '<p class="tag-cloud-empty">暂无标签</p>'
            return
        }

        var counts = tags.map(function (t) { return t.count })
        var max = Math.max.apply(null, counts)
        var min = Math.min.apply(null, counts)
        var logMax = Math.log(max + 1)
        var logMin = Math.log(min + 1)
        var span = logMax - logMin || 1

        tags
            .slice()
            .sort(function (a, b) { return b.count - a.count })
            .forEach(function (tag) {
                var norm = (Math.log(tag.count + 1) - logMin) / span // 0..1
                var size = MIN_SIZE + norm * (MAX_SIZE - MIN_SIZE)
                var level = weightLevel(norm, PALETTE.length)
                var color = PALETTE[level - 1]

                // Gentle drift. Every animation longhand is set INLINE from JS
                // (name/duration/timing/iteration/delay) so all engines apply
                // identical animation settings — nothing depends on stylesheet
                // shorthand ordering. Duration 3.5–6s with a ±10px keyframe is
                // clearly perceptible; the negative delay starts each tag
                // mid-cycle so they bob out of sync.
                var seed = nameSeed(String(tag.name))

                var a = document.createElement("a")
                a.className = "tag-cloud-item"
                a.href = "/tag/" + encodeURIComponent(tag.slug)
                a.textContent = tag.name
                a.title = tag.name + " (" + tag.count + ")"
                a.style.fontSize = size.toFixed(3) + "rem"
                a.style.color = color

                if (!REDUCED_MOTION) {
                    var duration = 3.5 + (seed % 6) * 0.5 // 3.5..6.0 seconds
                    var delay = -((seed % 100) / 100) * duration // start mid-cycle
                    a.style.animationName = "tag-cloud-float"
                    a.style.animationDuration = duration.toFixed(2) + "s"
                    a.style.animationTimingFunction = "ease-in-out"
                    a.style.animationIterationCount = "infinite"
                    a.style.animationDelay = delay.toFixed(2) + "s"
                }

                a.setAttribute("data-count", tag.count)
                a.setAttribute("data-level", level)
                container.appendChild(a)
            })
    }

    function init() {
        var container = document.getElementById("tag-cloud")
        if (!container) return

        var data = readEmbedded("tag-cloud-data")
        if (data) {
            render(container, data)
            return
        }

        // Fallback: fetch from the public endpoint.
        fetch("/api/tags")
            .then(function (r) { return r.json() })
            .then(function (j) { render(container, (j && j.tags) || []) })
            .catch(function () { /* leave container empty */ })
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init)
    } else {
        init()
    }
})()
