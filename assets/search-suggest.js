/**
 * Live search suggestions for the /search page (progressive enhancement).
 *
 * The search page works fully without JavaScript; this file only adds a
 * dropdown with the top few matches while the visitor types, using the public
 * read-only API (`/api/public/posts?q=…`) so nothing new has to be indexed in
 * the browser. Any failure (API disabled, offline, rate limit) silently leaves
 * the plain form in place.
 *
 * Markup expected (built by core/routes/search.js):
 *
 *   <form class="search-form" data-search-suggest action="/search" method="get">
 *     <input type="search" name="q" …>
 *     <div class="search-suggest" hidden></div>
 *   </form>
 */
;(function () {
    "use strict"

    var DEBOUNCE_MS = 220
    var MIN_CHARS = 1
    var LIMIT = 6

    function init() {
        var forms = document.querySelectorAll("form[data-search-suggest]")
        Array.prototype.forEach.call(forms, setup)

        function setup(form) {
            var input = form.querySelector('input[name="q"]')
            var panel = form.querySelector(".search-suggest")
            if (!input || !panel) return

            var timer = null
            var controller = null
            var items = []
            var active = -1
            var lastQuery = ""

            function close() {
                panel.hidden = true
                panel.innerHTML = ""
                items = []
                active = -1
            }

            function open() {
                panel.hidden = false
            }

            function render(results, query) {
                if (!results.length) {
                    panel.innerHTML = '<div class="search-suggest-empty">没有匹配的内容，按回车查看完整搜索</div>'
                    open()
                    return
                }
                panel.innerHTML = results
                    .map(function (item, index) {
                        var type = item.type === "page" ? "页面" : "文章"
                        var date = item.date ? String(item.date).slice(0, 10) : ""
                        return (
                            '<a class="search-suggest-item' +
                            (index === active ? " is-active" : "") +
                            '" href="' +
                            escapeAttr(item.url) +
                            '"><span class="search-suggest-title">' +
                            escapeHtml(item.title) +
                            '</span><span class="search-suggest-meta">' +
                            type +
                            (date ? " · " + date : "") +
                            "</span></a>"
                        )
                    })
                    .join("")
                open()
            }

            function fetchSuggestions(query) {
                if (controller && controller.abort) controller.abort()
                controller = typeof AbortController === "function" ? new AbortController() : null
                var url = "/api/public/posts?limit=" + LIMIT + "&q=" + encodeURIComponent(query)
                fetch(url, controller ? { signal: controller.signal } : undefined)
                    .then(function (response) {
                        if (!response.ok) throw new Error("HTTP " + response.status)
                        return response.json()
                    })
                    .then(function (payload) {
                        if (query !== lastQuery) return
                        var results = Array.isArray(payload.items) ? payload.items : []
                        items = results
                        active = -1
                        render(results, query)
                    })
                    .catch(function () {
                        close()
                    })
            }

            input.addEventListener("input", function () {
                var query = input.value.trim()
                lastQuery = query
                if (timer) window.clearTimeout(timer)
                if (query.length < MIN_CHARS) {
                    close()
                    return
                }
                timer = window.setTimeout(function () {
                    fetchSuggestions(query)
                }, DEBOUNCE_MS)
            })

            input.addEventListener("keydown", function (event) {
                if (panel.hidden || !items.length) return
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    active += event.key === "ArrowDown" ? 1 : -1
                    if (active < 0) active = items.length - 1
                    if (active >= items.length) active = 0
                    render(items, lastQuery)
                } else if (event.key === "Enter" && active >= 0) {
                    event.preventDefault()
                    window.location.href = items[active].url
                } else if (event.key === "Escape") {
                    close()
                }
            })

            document.addEventListener("click", function (event) {
                if (!form.contains(event.target)) close()
            })
            input.addEventListener("blur", function () {
                // Let a click on a suggestion land before hiding the panel.
                window.setTimeout(close, 150)
            })
        }

        function escapeHtml(value) {
            return String(value == null ? "" : value)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;")
        }

        function escapeAttr(value) {
            return escapeHtml(value)
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init)
    } else {
        init()
    }
})()
