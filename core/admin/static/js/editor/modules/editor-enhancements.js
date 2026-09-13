import { slugify } from "./validation-utils.js"

/** Translate an admin string when the i18n layer is available, else fall back. */
function tr(key, params, fallback) {
    if (typeof window.__ === "function") {
        const value = window.__(key, params)
        if (value && value !== key) return value
    }
    if (!fallback) return key
    return String(fallback).replace(/\{(\w+)\}/g, (match, name) =>
        params && params[name] !== undefined ? String(params[name]) : match
    )
}

/**
 * Canonical tag name — mirrors `normalizeTagName()` in
 * core/lib/content/utils/content-utils.js so the editor shows exactly what the
 * server will store (trim, NFKC/full-width → half-width, collapsed spaces,
 * stripped leading '#' and separators, capped length).
 */
export function normalizeTagName(raw) {
    if (raw === null || raw === undefined) return ""
    let text = String(raw).normalize("NFKC")
    text = text.replace(/[\s\u00a0\u3000]+/g, " ").trim()
    text = text.replace(/^#+/, "").trim()
    text = text.replace(/^[,，、;；|]+/, "").replace(/[,，、;；|]+$/, "").trim()
    text = text.replace(/[\s\u00a0\u3000]+/g, " ").trim()
    // Drop spaces between two CJK characters (`心理 危机` → `心理危机`).
    for (let i = 0; i < 4; i++) {
        const collapsed = text.replace(/([\u3400-\u9fff\uf900-\ufaff])\s+([\u3400-\u9fff\uf900-\ufaff])/g, "$1$2")
        if (collapsed === text) break
        text = collapsed
    }
    if (text.length > 40) text = text.slice(0, 40).trim()
    return text
}

/** How many tags a single article should carry before we nudge the author. */
const TAG_SOFT_LIMIT = 5
/** How many existing tags to offer as reusable chips. */
const EXISTING_TAG_CHIPS = 24

/**
 * Editor Enhancements - Handles tags, categories, and date picker functionality
 */
export class EditorEnhancements {
    constructor() {
        // DOM Elements
        this.tagInput = document.getElementById("tagInput")
        this.tagsList = document.getElementById("tagsList")
        this.addTagBtn = document.getElementById("addTag")
        this.recommendTagsBtn = document.getElementById("recommendTags")

        this.categoryInput = document.getElementById("categoryInput")
        this.categoriesList = document.getElementById("categoriesList")
        this.addCategoryBtn = document.getElementById("addCategory")

        this.publishDateInput = document.getElementById("publishDate")

        // 学段（stage）：单值维度，独立于标签
        this.stageInput = document.getElementById("stageInput")
        this.stageSuggestionsList = document.getElementById("stageSuggestions")
        this.existingStages = []

        // Existing-tag suggestions (see loadTagSuggestions)
        this.tagSuggestionsList = document.getElementById("tagSuggestions")
        this.existingTagsBox = document.getElementById("existingTagsBox")
        this.existingTagsList = document.getElementById("existingTagsList")
        this.tagCountHint = document.getElementById("tagCountHint")
        this.existingTags = []

        // New parent page elements
        this.pageTypeSelect = document.getElementById("pageType")
        this.parentPageGroup = document.getElementById("parentPageGroup")
        this.parentPageSelect = document.getElementById("parentPage")

        // State
        this.tags = []
        this.categories = []
        this.removedTags = new Set() // Track explicitly removed tags
        this.removedCategory = null // Track if category was explicitly removed

        // Initialize
        this.init()
    }

    /**
     * Initialize the enhancements
     */
    init() {
        // Initialize event listeners
        this.initEventListeners()

        // Initialize parent page controls for custom pages
        this.initParentPageControls()

        // Initialize date picker with current value or current date
        this.initDatePicker()

        // Load existing tags and categories if available
        this.loadExistingData()

        // Offer the tags the site already uses (autocomplete + clickable chips)
        this.loadTagSuggestions()

        // Load the stages the site already uses (学段是独立维度)
        this.loadStageSuggestions()

        // Listen for content loaded event to ensure we get the data
        document.addEventListener("editor:contentLoaded", (event) => {
            // Load categories and tags from the loaded content
            this.loadExistingData()
        })
    }

    /**
     * Load every tag the site already uses (GET /api/tags — same public endpoint
     * that feeds the frontend word cloud) and offer them in two ways:
     *   - a <datalist> for the tag input (native autocomplete)
     *   - clickable chips ordered by usage ("点击复用")
     *
     * This is the main defence against tag sprawl: authors are far more likely to
     * reuse an existing tag when it is one click away than to retype a variant.
     */
    async loadTagSuggestions() {
        try {
            const res = await fetch("/api/tags", { credentials: "same-origin" })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            const tags = Array.isArray(json.tags) ? json.tags : []
            this.existingTags = tags
                .filter((tag) => tag && tag.name)
                .map((tag) => ({ name: String(tag.name), count: Number(tag.count) || 0 }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        } catch (error) {
            // Suggestions are a convenience — never block the editor on them.
            this.existingTags = []
        }
        this.renderTagSuggestions()
    }

    /** Load the stages already used on the site (GET /api/stages) into a datalist. */
    async loadStageSuggestions() {
        try {
            const res = await fetch("/api/stages", { credentials: "same-origin" })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            const stages = Array.isArray(json.stages) ? json.stages : []
            this.existingStages = stages
                .filter((stage) => stage && stage.name)
                .map((stage) => ({ name: String(stage.name), count: Number(stage.count) || 0 }))
        } catch (error) {
            this.existingStages = []
        }
        if (!this.stageSuggestionsList) return
        this.stageSuggestionsList.innerHTML = ""
        for (const stage of this.existingStages) {
            const option = document.createElement("option")
            option.value = stage.name
            option.label = `${stage.count} 篇`
            this.stageSuggestionsList.appendChild(option)
        }
    }

    /** Render the datalist + the reusable-tag chips. */
    renderTagSuggestions() {
        if (this.tagSuggestionsList) {
            this.tagSuggestionsList.innerHTML = ""
            for (const tag of this.existingTags) {
                const option = document.createElement("option")
                option.value = tag.name
                option.label = `${tag.count} 篇`
                this.tagSuggestionsList.appendChild(option)
            }
        }
        if (!this.existingTagsList || !this.existingTagsBox) return
        this.existingTagsList.innerHTML = ""
        const shown = this.existingTags.slice(0, EXISTING_TAG_CHIPS)
        this.existingTagsBox.hidden = shown.length === 0
        for (const tag of shown) {
            const chip = document.createElement("button")
            chip.type = "button"
            chip.className = "existing-tag-chip"
            chip.title = tr("editor_reuseTag", { name: tag.name, count: tag.count }, `复用「${tag.name}」（已用于 ${tag.count} 篇）`)
            chip.innerHTML = `<span class="tag-text"></span><span class="tag-count"></span>`
            chip.querySelector(".tag-text").textContent = tag.name
            chip.querySelector(".tag-count").textContent = tag.count
            chip.addEventListener("click", () => this.addExistingTag(tag.name))
            this.existingTagsList.appendChild(chip)
        }
    }

    /** Add a tag that already exists on the site (no confirm needed). */
    addExistingTag(name) {
        const canonical = normalizeTagName(name)
        if (!canonical) return
        if (this.tags.some((tag) => tag.toLowerCase() === canonical.toLowerCase())) {
            this.flashTagHint(tr("editor_tagAlreadyAdded", { name: canonical }, `「${canonical}」已在标签列表里`))
            return
        }
        this.removedTags.delete(canonical)
        this.tags.push(canonical)
        if (this.tagInput) this.tagInput.value = ""
        this.renderTags()
        this.markEditorDirty()
    }

    /**
     * Find an existing tag that the given name probably means: same after
     * normalization, one contains the other, or a shared 2+ character prefix.
     * Returns the most-used candidate, or null.
     */
    findSimilarExistingTag(rawName) {
        const name = normalizeTagName(rawName)
        if (!name) return null
        const lower = name.toLowerCase()
        const candidates = []
        for (const tag of this.existingTags) {
            const other = tag.name.toLowerCase()
            if (other === lower) continue // already the same concept
            const normalizedOther = normalizeTagName(tag.name).toLowerCase()
            let kind = ""
            if (normalizedOther === lower) kind = "same"
            else if (lower.length >= 2 && normalizedOther.includes(lower)) kind = "contained"
            else if (normalizedOther.length >= 2 && lower.includes(normalizedOther)) kind = "contains"
            else {
                let shared = 0
                while (shared < Math.min(lower.length, normalizedOther.length) && lower[shared] === normalizedOther[shared]) shared++
                if (shared >= 2) kind = `prefix:${lower.slice(0, shared)}`
            }
            if (kind) candidates.push({ tag, kind })
        }
        if (!candidates.length) return null
        candidates.sort((a, b) => b.tag.count - a.tag.count || a.tag.name.localeCompare(b.tag.name))
        return candidates[0]
    }

    /**
     * Initialize event listeners
     */
    initEventListeners() {
        // Tag events
        if (this.addTagBtn) {
            this.addTagBtn.addEventListener("click", () => this.addTag())
        }

        if (this.recommendTagsBtn) {
            this.recommendTagsBtn.addEventListener("click", () => this.recommendTags())
        }

        if (this.tagInput) {
            this.tagInput.addEventListener("keypress", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault()
                    this.addTag()
                }
            })
        }

        // Category events
        if (this.addCategoryBtn) {
            this.addCategoryBtn.addEventListener("click", () => this.addCategory())
        }

        if (this.categoryInput) {
            this.categoryInput.addEventListener("keypress", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault()
                    this.addCategory()
                }
            })
        }
    }

    /**
     * Initialize parent page controls for custom pages
     */
    initParentPageControls() {
        if (!this.pageTypeSelect || !this.parentPageSelect) return

        // Show/hide parent page selection based on page type
        this.pageTypeSelect.addEventListener("change", (e) => {
            const isCustom = e.target.value === "custom"

            if (this.parentPageGroup) {
                this.parentPageGroup.style.display = isCustom ? "block" : "none"
            }

            // Load parent page options when switching to custom
            if (isCustom) {
                this.loadParentPageOptions()
            }
        })

        // Load options if already set to custom
        if (this.pageTypeSelect.value === "custom") {
            this.loadParentPageOptions()
        }
    }

    /**
     * Load available parent pages for selection - Allows child pages as parents
     */
    async loadParentPageOptions() {
        try {
            // Get all published custom pages
            const response = await fetch("/api/pages?status=published")
            const data = await response.json()

            if (!data.success) {
                console.error("Error loading pages:", data.error)
                return
            }

            // Clear existing options (except the default "None")
            while (this.parentPageSelect.children.length > 1) {
                this.parentPageSelect.removeChild(this.parentPageSelect.lastChild)
            }

            // Get current page ID to exclude from parent options
            const currentPageId = this.getCurrentPageId()
            const currentPageData = await this.getCurrentPageData()

            // Filter for custom pages only and exclude current page
            const customPages = data.data.filter((page) => {
                const metadata = page.frontmatter || page.metadata || page

                // Exclude current page
                if (metadata.id === currentPageId) {
                    return false
                }

                // Only include custom pages
                if (metadata.pageType !== "custom") {
                    return false
                }

                // Prevent circular references by checking if the potential parent
                // is actually a descendant of the current page
                if (currentPageData && this.isDescendantOf(currentPageData.slug, metadata, data.data)) {
                    return false
                }

                return true
            })

            // Group pages by hierarchy for better UX
            const rootPages = customPages.filter((page) => {
                const metadata = page.frontmatter || page.metadata || page
                return !metadata.parentPage
            })

            const childPages = customPages.filter((page) => {
                const metadata = page.frontmatter || page.metadata || page
                return metadata.parentPage
            })

            // Add root pages first
            rootPages.forEach((page) => {
                const metadata = page.frontmatter || page.metadata || page
                const option = document.createElement("option")
                option.value = metadata.slug
                option.textContent = metadata.title

                // Select if this is the current parent
                if (metadata.slug === this.getCurrentParentPage()) {
                    option.selected = true
                }

                this.parentPageSelect.appendChild(option)
            })

            // Add child pages with indentation for visual hierarchy
            childPages.forEach((page) => {
                const metadata = page.frontmatter || page.metadata || page
                const option = document.createElement("option")
                option.value = metadata.slug

                // Get parent info for display
                const parentPage = data.data.find((p) => {
                    const pMeta = p.frontmatter || p.metadata || p
                    return pMeta.slug === metadata.parentPage
                })

                const parentTitle = parentPage
                    ? (parentPage.frontmatter || parentPage.metadata || parentPage).title
                    : metadata.parentPage
                option.textContent = `  └─ ${metadata.title} (under ${parentTitle})`

                // Select if this is the current parent
                if (metadata.slug === this.getCurrentParentPage()) {
                    option.selected = true
                }

                this.parentPageSelect.appendChild(option)
            })
        } catch (error) {
            console.error("Error loading parent pages:", error)
        }
    }

    /**
     * Check if a potential parent is actually a descendant of the current page
     * This prevents circular references
     */
    isDescendantOf(currentSlug, potentialParentMetadata, allPages) {
        let checkSlug = potentialParentMetadata.parentPage

        while (checkSlug) {
            if (checkSlug === currentSlug) {
                return true // Found circular reference
            }

            // Find parent page
            const parentPage = allPages.find((page) => {
                const meta = page.frontmatter || page.metadata || page
                return meta.slug === checkSlug
            })

            if (!parentPage) {
                break
            }

            const parentMeta = parentPage.frontmatter || parentPage.metadata || parentPage
            checkSlug = parentMeta.parentPage
        }

        return false
    }

    /**
     * Get current page data for circular reference checking
     */
    async getCurrentPageData() {
        const currentPageId = this.getCurrentPageId()
        if (!currentPageId) return null

        try {
            const response = await fetch(`/api/pages/${currentPageId}`)
            const data = await response.json()

            if (data.success) {
                return data.data.frontmatter || data.data.metadata || data.data
            }
        } catch (error) {
            console.error("Error getting current page data:", error)
        }

        return null
    }

    /**
     * Get current page ID from URL or editor state
     */
    getCurrentPageId() {
        const pathParts = window.location.pathname.split("/")
        return pathParts.length > 4 ? pathParts[4] : null
    }

    /**
     * Get current parent page slug
     */
    getCurrentParentPage() {
        // This should be set when loading existing content
        return window.editorState?.contentData?.metadata?.parentPage || ""
    }

    /**
     * Initialize date picker with the current value or current date/time
     */
    initDatePicker() {
        if (!this.publishDateInput) return

        // If no existing value, set to current date and time
        if (!this.publishDateInput.value) {
            const now = new Date()

            // Format date to YYYY-MM-DDThh:mm
            const year = now.getFullYear()
            const month = String(now.getMonth() + 1).padStart(2, "0")
            const day = String(now.getDate()).padStart(2, "0")
            const hours = String(now.getHours()).padStart(2, "0")
            const minutes = String(now.getMinutes()).padStart(2, "0")

            this.publishDateInput.value = `${year}-${month}-${day}T${hours}:${minutes}`
        }
    }

    /**
     * Load existing tags and categories from data
     */
    loadExistingData() {
        // Don't reload data if we've explicitly removed items
        if (this.removedCategory !== null || this.removedTags.size > 0) {
            return
        }

        // Access editor state to get existing tags and categories
        if (window.editorState) {
            const frontmatter = this.getFrontmatterFromEditorState()

            if (frontmatter) {
                // Load tags if not explicitly removed
                if (frontmatter.tags) {
                    // Handle different data formats
                    const rawTags = Array.isArray(frontmatter.tags)
                        ? frontmatter.tags
                        : typeof frontmatter.tags === "string"
                        ? frontmatter.tags.split(",")
                        : []
                    // Show the canonical form, deduped case-insensitively, so the
                    // editor never displays two tags that the server treats as one.
                    const seen = new Set()
                    this.tags = []
                    for (const raw of rawTags) {
                        const name = normalizeTagName(raw)
                        if (!name || seen.has(name.toLowerCase())) continue
                        seen.add(name.toLowerCase())
                        this.tags.push(name)
                    }
                }

                // Load category if not explicitly removed
                if (frontmatter.category) {
                    if (typeof frontmatter.category === "string") {
                        this.categories = [frontmatter.category]
                    } else if (Array.isArray(frontmatter.category) && frontmatter.category.length > 0) {
                        this.categories = [frontmatter.category[0]]
                    }
                }

                // Load 学段（stage）
                if (this.stageInput) {
                    this.stageInput.value = normalizeTagName(frontmatter.stage || "")
                }
            }
        }

        // Render the tags and categories
        this.renderTags()
        this.renderCategories()
    }

    /**
     * Get frontmatter from editor state
     * @returns {Object|null} Frontmatter or null if not found
     */
    getFrontmatterFromEditorState() {
        if (!window.editorState) return null

        // Check if there's original data in the editor state
        if (window.editorState.originalData && window.editorState.originalData.metadata) {
            return window.editorState.originalData.metadata
        }

        // Check if there's current data in the editor state
        if (window.editorState.currentData && window.editorState.currentData.metadata) {
            return window.editorState.currentData.metadata
        }

        return null
    }

    /**
     * Add a new tag.
     *
     * Guards against the tag sprawl we measured on the live sites (91 tags for
     * 20 articles, 90% used once):
     *   1. the name is canonicalized the same way the server will store it;
     *   2. duplicates that differ only by case/spacing are refused;
     *   3. if the name is close to a tag the site already uses, the author is
     *      asked once whether to reuse that tag instead of creating a variant.
     */
    addTag() {
        if (!this.tagInput) return
        // Keep the raw name (trimmed) — slugifying would strip non-ASCII
        // characters such as Chinese tag names.
        const tag = normalizeTagName(this.tagInput.value)
        if (!tag) {
            this.tagInput.value = ""
            return
        }

        // Skip if already exists (case-insensitive: `markdown` == `MarkDown`)
        if (this.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
            this.tagInput.value = ""
            this.flashTagHint(tr("editor_tagAlreadyAdded", { name: tag }, `「${tag}」已在标签列表里`))
            return
        }

        // Ask once when a very similar tag already exists on the site
        const similar = this.findSimilarExistingTag(tag)
        let finalTag = tag
        if (similar) {
            const count = similar.tag.count
            const question = tr(
                "editor_similarTagConfirm",
                { existing: similar.tag.name, count, input: tag },
                `站点已有「${similar.tag.name}」（${count} 篇），与「${tag}」很接近。\n\n` +
                    `确定 = 复用已有的「${similar.tag.name}」\n取消 = 仍然新建「${tag}」`
            )
            if (window.confirm(question)) {
                this.addExistingTag(similar.tag.name)
                return
            }
        }

        // Remove from removedTags if it was previously removed
        this.removedTags.delete(finalTag)
        if (this.removedTags.has(tag)) this.removedTags.delete(tag)

        // Add to tags array
        this.tags.push(finalTag)

        // Clear input
        this.tagInput.value = ""

        // Update UI
        this.renderTags()

        // Mark editor as dirty (unsaved changes)
        this.markEditorDirty()
    }

    /** Show a short-lived note under the tag input. */
    flashTagHint(message) {
        if (!this.tagCountHint) return
        this.tagCountHint.textContent = message
        this.tagCountHint.hidden = false
        if (this._tagHintTimer) window.clearTimeout(this._tagHintTimer)
        this._tagHintTimer = window.setTimeout(() => this.updateTagCountHint(), 4000)
    }

    /** Nudge when an article carries a lot of tags (recommended: 3–5). */
    updateTagCountHint() {
        if (!this.tagCountHint) return
        if (this.tags.length > TAG_SOFT_LIMIT) {
            this.tagCountHint.textContent = tr(
                "editor_tagCountHint",
                { count: this.tags.length, limit: TAG_SOFT_LIMIT },
                `当前 ${this.tags.length} 个标签，建议精简到 ${TAG_SOFT_LIMIT} 个以内，便于读者按标签找到相关内容`
            )
            this.tagCountHint.hidden = false
            return
        }
        this.tagCountHint.textContent = ""
        this.tagCountHint.hidden = true
    }

    /**
     * Remove a tag
     * @param {string} tag - Tag to remove
     */
    removeTag(tag) {
        // Add to explicitly removed tags set
        this.removedTags.add(tag)

        // Remove from tags array
        this.tags = this.tags.filter((t) => t !== tag)

        // Update UI
        this.renderTags()

        // Mark editor as dirty (unsaved changes)
        this.markEditorDirty()
    }

    /**
     * Ask the backend to recommend tags for the current content and add them.
     * Uses /api/suggest-tags (Ollama or jieba backend).
     */
    async recommendTags() {
        const contentEl = document.getElementById("content")
        const titleEl = document.getElementById("title")
        const content = contentEl ? contentEl.value : ""
        if (!content || !content.trim()) {
            alert("请先输入正文内容，再推荐标签。")
            return
        }
        const title = titleEl ? titleEl.value : ""
        const btn = this.recommendTagsBtn
        const originalText = btn ? btn.textContent : ""
        if (btn) {
            btn.disabled = true
            btn.textContent = "推荐中…"
        }

        try {
            const resp = await fetch("/api/suggest-tags", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ title, content }),
            })
            const data = await resp.json()
            if (data.success) {
                if (data.tags && data.tags.length) {
                    this.addTagsList(data.tags)
                } else {
                    alert(data.message || "未能生成标签。")
                }
            } else {
                alert(data.error || "推荐标签失败。")
            }
        } catch (e) {
            alert("推荐标签出错：" + (e.message || e))
        } finally {
            if (btn) {
                btn.disabled = false
                btn.textContent = originalText
            }
        }
    }

    /**
     * Add a batch of recommended tags (no duplicates) and re-render once.
     * @param {string[]} tags
     */
    addTagsList(tags) {
        const list = Array.isArray(tags) ? tags : []
        let added = false
        for (const raw of list) {
            const tag = normalizeTagName(raw)
            if (!tag || this.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) continue
            this.removedTags.delete(tag)
            this.tags.push(tag)
            added = true
        }
        if (added) {
            this.renderTags()
            this.markEditorDirty()
        }
    }

    /**
     * Render tags list
     */
    renderTags() {
        if (!this.tagsList) return

        // Clear current list
        this.tagsList.innerHTML = ""

        // Add each tag
        if (this.tags.length > 0) {
            this.tags.forEach((tag) => {
                const tagElement = document.createElement("div")
                tagElement.className = "tag-item"
                tagElement.innerHTML = `
                    <span class="tag-text">${tag}</span>
                    <button type="button" class="tag-remove" title="Remove tag">×</button>
                `

                // Add remove handler
                tagElement.querySelector(".tag-remove").addEventListener("click", () => this.removeTag(tag))

                this.tagsList.appendChild(tagElement)
            })
        } else {
            // If no tags, show a placeholder
            this.tagsList.innerHTML = '<p class="tags-placeholder">No tags added</p>'
        }

        // Warn when the article carries more tags than recommended
        this.updateTagCountHint()
    }

    /**
     * Add a new category
     */
    addCategory() {
        if (!this.categoryInput || !this.categoryInput.value.trim()) return

        // Keep the raw name (trimmed) — slugifying would strip non-ASCII
        // characters such as Chinese category names.
        const category = this.categoryInput.value.trim()

        // For simplicity, we'll keep a single category - replace any existing one
        this.categories = [category]

        // Reset removedCategory flag since we've explicitly added one
        this.removedCategory = null

        // Clear input
        this.categoryInput.value = ""

        // Update UI
        this.renderCategories()

        // Mark editor as dirty (unsaved changes)
        this.markEditorDirty()
    }

    /**
     * Remove a category
     * @param {string} category - Category to remove
     */
    removeCategory(category) {
        // Set the removedCategory flag
        this.removedCategory = category

        // Clear the categories array
        this.categories = []

        // Update UI
        this.renderCategories()

        // Mark editor as dirty (unsaved changes)
        this.markEditorDirty()
    }

    /**
     * Render categories list
     */
    renderCategories() {
        if (!this.categoriesList) return

        // Clear current list
        this.categoriesList.innerHTML = ""

        // Add each category
        if (this.categories.length > 0) {
            this.categories.forEach((category) => {
                const categoryElement = document.createElement("div")
                categoryElement.className = "category-item"
                categoryElement.innerHTML = `
                    <span class="category-text">${category}</span>
                    <button type="button" class="category-remove" title="Remove category">×</button>
                `

                // Add remove handler
                categoryElement
                    .querySelector(".category-remove")
                    .addEventListener("click", () => this.removeCategory(category))

                this.categoriesList.appendChild(categoryElement)
            })
        } else {
            // If no category, show a placeholder
            this.categoriesList.innerHTML = '<p class="categories-placeholder">No category set</p>'
        }
    }

    /**
     * Mark the editor as having unsaved changes
     */
    markEditorDirty() {
        // Use the existing unsaved changes handler if available
        if (window.editorState) {
            if (typeof window.editorState.markDirty === "function") {
                window.editorState.markDirty()
            } else if (window.editorState.isDirty !== undefined) {
                window.editorState.isDirty = true
            }
        }

        // Also notify any unsaved changes handler
        const event = new Event("input", { bubbles: true })
        document.getElementById("content")?.dispatchEvent(event)
    }

    /**
     * Get current values for form submission
     * @returns {Object} Current values
     */
    getCurrentValues() {
        const values = {
            publishDate: this.publishDateInput ? this.publishDateInput.value : null,
            tags: this.tags,
            category: this.categories.length > 0 ? this.categories[0] : null,
            // 学段（单值维度）：空字符串表示清除
            stage: this.stageInput ? normalizeTagName(this.stageInput.value) : null,
            // Include removal flags so the ContentService knows these were explicitly removed
            removedTags: Array.from(this.removedTags),
            removedCategory: this.removedCategory,
        }

        // Always include parent page for custom pages (even if null)
        if (this.pageTypeSelect?.value === "custom") {
            values.parentPage = this.parentPageSelect?.value || null
        }

        return values
    }

    /**
     * Reset the removal tracking after save
     */
    resetRemovalTracking() {
        this.removedTags.clear()
        this.removedCategory = null
    }
}
