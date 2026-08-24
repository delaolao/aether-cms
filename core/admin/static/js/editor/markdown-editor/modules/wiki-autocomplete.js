/**
 * Wiki Link Autocomplete — Obsidian-style [[ completion for the editor.
 *
 * When the author types an unclosed `[[prefix` at the cursor, a dropdown of
 * matching published note titles is shown; selecting one completes the link
 * as [[Title]] (with the typed text kept as the label when it differs).
 *
 * Data source: GET /api/wikilinks (title → {url, title, slug, type}).
 */

export class WikiAutocomplete {
    constructor({ textarea, container }) {
        this.textarea = textarea
        this.container = container
        this.wikilinks = null
        this.fetchPromise = null
        this.dropdown = null
        this.activeIndex = -1
        this.currentPrefix = ""

        this.bindEvents()
    }

    async loadWikilinks() {
        if (this.wikilinks) return this.wikilinks
        if (!this.fetchPromise) {
            this.fetchPromise = fetch("/api/wikilinks", { credentials: "same-origin" })
                .then((res) => (res.ok ? res.json() : { data: {} }))
                .then((json) => {
                    this.wikilinks = Object.values(json.data || {})
                    return this.wikilinks
                })
                .catch(() => {
                    this.wikilinks = []
                    return this.wikilinks
                })
        }
        return this.fetchPromise
    }

    /** Extract the unclosed [[prefix before the cursor, if any. */
    getCurrentPrefix() {
        const value = this.textarea.value
        const pos = this.textarea.selectionStart
        const before = value.substring(0, pos)
        const match = before.match(/\[\[([^\]\n]*)$/)
        return match ? match[1] : null
    }

    bindEvents() {
        this.textarea.addEventListener("input", () => this.onInput())
        this.textarea.addEventListener("keydown", (e) => this.onKeydown(e))
        this.textarea.addEventListener("blur", () => setTimeout(() => this.hide(), 150))
        document.addEventListener("click", (e) => {
            if (this.dropdown && !this.dropdown.contains(e.target)) this.hide()
        })
    }

    async onInput() {
        const prefix = this.getCurrentPrefix()
        if (prefix === null) {
            this.hide()
            return
        }
        const items = await this.loadWikilinks()
        const q = prefix.trim().toLowerCase()
        const matches = items
            .filter((item) => !q || item.title.toLowerCase().includes(q) || item.slug.includes(q))
            .slice(0, 10)
        if (matches.length === 0) {
            this.hide()
            return
        }
        this.currentPrefix = prefix
        this.renderDropdown(matches)
    }

    renderDropdown(items) {
        if (!this.dropdown) {
            this.dropdown = document.createElement("div")
            this.dropdown.className = "wiki-autocomplete"
            this.dropdown.style.position = "absolute"
            this.dropdown.style.zIndex = "1000"
            this.container?.appendChild(this.dropdown)
        }
        this.activeIndex = 0
        this.dropdown.innerHTML = ""
        items.forEach((item, index) => {
            const option = document.createElement("button")
            option.type = "button"
            option.className = "wiki-ac-option" + (index === 0 ? " active" : "")
            option.innerHTML = `<span class="wiki-ac-title">${escapeHtml(item.title)}</span><span class="wiki-ac-type">${item.type}</span>`
            option.addEventListener("mousedown", (e) => {
                e.preventDefault()
                this.complete(item)
            })
            this.dropdown.appendChild(option)
        })
        this.position()
    }

    position() {
        const caret = this.textarea.selectionStart
        const coords = getCaretCoordinates(this.textarea, caret)
        this.dropdown.style.left = `${Math.min(coords.left, this.textarea.clientWidth - 220)}px`
        this.dropdown.style.top = `${coords.top + coords.height + 4}px`
    }

    onKeydown(e) {
        if (!this.dropdown) return
        const options = this.dropdown.querySelectorAll(".wiki-ac-option")
        if (options.length === 0) return

        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault()
            this.activeIndex = (this.activeIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
            options.forEach((el, i) => el.classList.toggle("active", i === this.activeIndex))
        } else if (e.key === "Enter" || e.key === "Tab") {
            const item = this.getActiveItem()
            if (item) {
                e.preventDefault()
                this.complete(item)
            }
        } else if (e.key === "Escape") {
            this.hide()
        }
    }

    getActiveItem() {
        const items = this.wikilinks || []
        const q = this.currentPrefix.trim().toLowerCase()
        const matches = items.filter((item) => !q || item.title.toLowerCase().includes(q) || item.slug.includes(q))
        return matches[this.activeIndex]
    }

    complete(item) {
        const textarea = this.textarea
        const pos = textarea.selectionStart
        const value = textarea.value
        const before = value.substring(0, pos)
        const start = before.lastIndexOf("[[")
        const typed = before.substring(start + 2)
        const typedLabel = typed.trim()
        // Obsidian: [[Title]] when the typed text matches the title, else [[Title|typed]]
        const label = typedLabel && typedLabel.toLowerCase() !== item.title.toLowerCase() ? `|${typedLabel}` : ""
        const replacement = `[[${item.title}${label}]]`
        const newValue = value.substring(0, start) + replacement + value.substring(pos)
        textarea.value = newValue
        textarea.focus()
        const cursor = start + replacement.length
        textarea.selectionStart = cursor
        textarea.selectionEnd = cursor
        textarea.dispatchEvent(new Event("input", { bubbles: true }))
        this.hide()
    }

    hide() {
        if (this.dropdown) {
            this.dropdown.remove()
            this.dropdown = null
        }
        this.activeIndex = -1
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
}

/** Approximate caret coordinates inside a textarea (for dropdown placement). */
function getCaretCoordinates(textarea, position) {
    const clone = textarea.cloneNode(false)
    clone.style.position = "absolute"
    clone.style.visibility = "hidden"
    clone.style.width = `${textarea.clientWidth}px`
    clone.style.height = "auto"
    clone.style.whiteSpace = "pre-wrap"
    clone.style.overflow = "hidden"
    textarea.parentNode.appendChild(clone)

    const text = textarea.value.substring(0, position)
    const filler = "\u200b".repeat(100)
    clone.value = text + filler

    const rect = textarea.getBoundingClientRect()
    const cloneRect = clone.getBoundingClientRect()
    const lineHeight = parseFloat(getComputedStyle(clone).lineHeight) || 20

    // Measure the offset of the caret using a text range
    let top = 0
    let left = 0
    try {
        const range = document.createRange()
        const textNode = clone.firstChild
        if (textNode) {
            range.setStart(textNode, Math.min(text.length, textNode.length))
            range.setEnd(textNode, Math.min(text.length, textNode.length))
            const rects = range.getClientRects()
            if (rects.length > 0) {
                top = rects[0].top - cloneRect.top
                left = rects[0].left - cloneRect.left
            }
        }
    } catch {
        // fallback: estimate by line count
        const lines = text.split("\n").length
        top = (lines - 1) * lineHeight
    }

    clone.remove()
    return { top: top + textarea.scrollTop, left: left - textarea.scrollLeft, height: lineHeight }
}
