/**
 * Ember theme — minimal JS: active nav link + mobile menu toggle.
 */
document.addEventListener("DOMContentLoaded", function () {
    const currentPath = window.location.pathname

    // Highlight the current navigation item.
    document.querySelectorAll(".site-navigation a").forEach(function (link) {
        const href = link.getAttribute("href")
        if (!href) return
        if (href === "/" && currentPath === "/") {
            link.classList.add("active")
        } else if (href !== "/" && currentPath.startsWith(href)) {
            link.classList.add("active")
        }
    })

    // Mobile menu toggle.
    const nav = document.querySelector(".site-navigation")
    if (!nav) return
    const toggle = document.createElement("button")
    toggle.className = "menu-toggle"
    toggle.setAttribute("aria-expanded", "false")
    toggle.textContent = "☰"
    nav.parentNode.insertBefore(toggle, nav)
    toggle.addEventListener("click", function () {
        const expanded = this.getAttribute("aria-expanded") === "true"
        this.setAttribute("aria-expanded", !expanded)
        nav.classList.toggle("toggled")
    })
})
