/**
 * Share bar runtime.
 *
 * Behaviour: copy link (with clipboard fallback), WeChat / WeCom QR popovers,
 * print/save-as-PDF. QQ & QZone are plain links rendered on the server, so they
 * need no JavaScript at all.
 */
;(function () {
    "use strict"

    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext !== false) {
            return navigator.clipboard.writeText(text)
        }
        // Fallback for plain-HTTP deployments (clipboard API needs a secure context)
        return new Promise(function (resolve, reject) {
            try {
                var area = document.createElement("textarea")
                area.value = text
                area.setAttribute("readonly", "")
                area.style.position = "fixed"
                area.style.opacity = "0"
                document.body.appendChild(area)
                area.select()
                var ok = document.execCommand("copy")
                document.body.removeChild(area)
                ok ? resolve() : reject(new Error("execCommand copy failed"))
            } catch (error) {
                reject(error)
            }
        })
    }

    function toast(bar, message) {
        var el = bar.querySelector(".share-toast")
        if (!el) return
        el.textContent = message
        el.classList.add("is-visible")
        clearTimeout(el._timer)
        el._timer = setTimeout(function () {
            el.classList.remove("is-visible")
        }, 2200)
    }

    function closePops(bar, except) {
        bar.querySelectorAll(".share-pop").forEach(function (pop) {
            if (pop === except) return
            pop.hidden = true
            var trigger = bar.querySelector('[data-target="' + pop.dataset.pop + '"]')
            if (trigger) trigger.setAttribute("aria-expanded", "false")
        })
    }

    function init() {
        document.querySelectorAll(".share-bar").forEach(function (bar) {
            var url = bar.dataset.shareUrl || window.location.href
            var title = bar.dataset.shareTitle || document.title

            bar.addEventListener("click", function (event) {
                var button = event.target.closest("[data-share]")
                if (!button) return
                var action = button.dataset.share

                if (action === "copy") {
                    event.preventDefault()
                    copyText(title ? title + " " + url : url)
                        .then(function () {
                            toast(bar, "链接已复制")
                        })
                        .catch(function () {
                            window.prompt("复制下面的链接：", url)
                        })
                    return
                }

                if (action === "pop") {
                    event.preventDefault()
                    var pop = bar.querySelector('.share-pop[data-pop="' + button.dataset.target + '"]')
                    if (!pop) return
                    var willOpen = pop.hidden
                    closePops(bar, willOpen ? pop : null)
                    pop.hidden = !willOpen
                    button.setAttribute("aria-expanded", String(willOpen))
                    return
                }

                if (action === "print") {
                    event.preventDefault()
                    window.print()
                }
            })

            // Clicking outside closes any open popover
            document.addEventListener("click", function (event) {
                if (!bar.contains(event.target)) closePops(bar, null)
            })

            document.addEventListener("keydown", function (event) {
                if (event.key === "Escape") closePops(bar, null)
            })
        })
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init)
    } else {
        init()
    }
})()
