/**
 * Markdown Editor - Main Entry Point (HTML-Based Implementation)
 *
 * This file exports the main MarkdownEditor class that coordinates all editor functionality.
 * Instead of dynamically creating HTML, it uses pre-defined elements in the template.
 */

import { EditorState } from "./modules/editor-state.js"
import { EditorUI } from "./modules/editor-ui.js"
import { EditorCommands } from "./modules/editor-commands.js"
import { FullscreenManager } from "./modules/fullscreen-manager.js"
import { WikiAutocomplete } from "./modules/wiki-autocomplete.js"

export class MarkdownEditor {
    /**
     * Creates a new Markdown Editor instance
     * @param {Object} config - Editor configuration
     * @param {HTMLTextAreaElement} config.textarea - The textarea element
     * @param {Object} [config.options={}] - Optional configuration
     */
    constructor({ textarea, options = {} }) {
        // Ensure textarea exists
        if (!textarea) {
            throw new Error("Textarea element is required")
        }

        // Core configuration with defaults
        this.options = Object.assign(
            {
                autoResize: true,
                previewChangesIndicator: true,
                initialContent: textarea.value || "",
                onChange: null,
            },
            options
        )

        // Initialize the editor state
        this.state = new EditorState({
            initialContent: this.options.initialContent,
        })

        // Find the container element
        const container = textarea.closest(".form-group")

        // Initialize the UI manager
        this.ui = new EditorUI({
            textarea,
            container,
            onViewChange: this.handleViewChange.bind(this),
            onTabChange: this.handleTabChange.bind(this),
        })

        // Initialize the commands manager
        this.commands = new EditorCommands({
            state: this.state,
            ui: this.ui,
        })

        // Initialize the fullscreen manager
        this.fullscreen = new FullscreenManager({
            editor: this,
            state: this.state,
            ui: this.ui,
            commands: this.commands,
        })

        // Initialize the editor
        this.init()

        // Obsidian-style [[wikilink]] autocomplete
        this.wikiAutocomplete = new WikiAutocomplete({
            textarea,
            container,
        })
    }

    /**
     * Initialize the editor
     */
    init() {
        // Initialize core components
        this.ui.init()
        this.commands.init()

        // Attach event listeners
        this.attachEventListeners()

        // Render initial preview
        this.renderPreview()

        // Auto-resize if enabled
        if (this.options.autoResize) {
            this.ui.autoResizeTextarea()
        }
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
        // Textarea input event
        this.ui.textarea.addEventListener("input", this.handleTextareaInput.bind(this))

        // Toolbar button events
        this.ui.toolbarButtons.forEach((button) => {
            button.addEventListener("click", (e) => {
                const command = button.getAttribute("data-command")
                if (command) {
                    this.commands.execute(command)
                }
            })
        })

        // Fullscreen button
        const fullscreenBtn = document.querySelector('[data-action="fullscreen"]')
        if (fullscreenBtn) {
            fullscreenBtn.addEventListener("click", () => {
                this.fullscreen.toggle()
            })
        }

        // Keyboard shortcuts
        this.ui.textarea.addEventListener("keydown", (e) => {
            // Ctrl/Cmd + B: Bold
            if ((e.ctrlKey || e.metaKey) && e.key === "b") {
                e.preventDefault()
                this.commands.execute("bold")
            }
            // Ctrl/Cmd + I: Italic
            else if ((e.ctrlKey || e.metaKey) && e.key === "i") {
                e.preventDefault()
                this.commands.execute("italic")
            }
            // Ctrl/Cmd + K: Link
            else if ((e.ctrlKey || e.metaKey) && e.key === "k") {
                e.preventDefault()
                this.commands.execute("link")
            }
        })
    }

    /**
     * Handle textarea input event
     */
    handleTextareaInput() {
        // Update state
        this.state.setContent(this.ui.textarea.value)

        // Render preview
        this.renderPreview()

        // Auto-resize if enabled
        if (this.options.autoResize) {
            this.ui.autoResizeTextarea()
        }

        // Update change indicator
        this.updateChangeIndicator()

        // Call onChange callback if provided
        if (typeof this.options.onChange === "function") {
            this.options.onChange(this.ui.textarea.value)
        }
    }

    /**
     * Render markdown preview
     */
    renderPreview() {
        // Update preview in normal mode
        if (this.ui.previewElement) {
            this.updatePreviewContent(this.ui.previewElement)
        }

        // Update preview in fullscreen mode if active
        if (this.fullscreen.isActive && document.getElementById("fs-preview")) {
            this.updatePreviewContent(document.getElementById("fs-preview"))
        }

        // Update toolbar state
        this.commands.updateToolbarState()
    }

    /**
     * Update preview content in a specific element.
     *
     * Renders via the server-side /api/preview so the preview matches the
     * frontend exactly ([[wikilinks]], callouts, KaTeX, video, etc.), avoiding
     * the browser-marked extension + cache issues.
     * @param {HTMLElement} previewElement - The preview element to update
     */
    updatePreviewContent(previewElement) {
        const markdownText = this.state.getContent()
        this._renderPreviewAsync(previewElement, markdownText)
    }

    async _renderPreviewAsync(previewElement, markdownText) {
        // Debounce rapid typing.
        if (this._previewTimer) clearTimeout(this._previewTimer)
        const seq = (this._previewSeq = (this._previewSeq || 0) + 1)

        this._previewTimer = setTimeout(async () => {
            if (seq !== this._previewSeq) return // a newer render superseded this one

            try {
                const res = await fetch("/api/preview", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "same-origin",
                    body: JSON.stringify({ content: markdownText }),
                })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const data = await res.json()
                if (seq !== this._previewSeq) return
                previewElement.innerHTML = data.html
            } catch (error) {
                // Fallback to local marked if the network call fails.
                if (window.marked && seq === this._previewSeq) {
                    previewElement.innerHTML = window.marked.parse(markdownText)
                } else if (seq === this._previewSeq) {
                    previewElement.innerHTML = "<p>Preview unavailable</p>"
                }
            }
        }, 120)
    }

    /**
     * Update change indicator based on content changes
     */
    updateChangeIndicator() {
        if (!this.options.previewChangesIndicator) return

        const hasChanges = this.state.hasContentChanged()

        // Update indicator in normal mode
        if (this.ui.previewChangesIndicator) {
            this.ui.previewChangesIndicator.classList.toggle("hidden", !hasChanges)
        }

        // Update indicator in fullscreen mode
        const fsIndicator = document.getElementById("fs-preview-changes-indicator")
        if (fsIndicator) {
            fsIndicator.classList.toggle("hidden", !hasChanges)
        }
    }

    /**
     * Handle view change (side-by-side toggle)
     * @param {boolean} isSideBySide - Whether side-by-side view is active
     */
    handleViewChange(isSideBySide) {
        // Sync view mode
        this.state.setSideBySideMode(isSideBySide)

        // Update UI to reflect the change
        this.ui.applySideBySideMode(isSideBySide)

        // Render preview
        this.renderPreview()

        // Resize editor for the new layout
        if (this.options.autoResize) {
            this.ui.autoResizeTextarea()
        }
    }

    /**
     * Handle tab change
     * @param {string} tabId - ID of the active tab
     */
    handleTabChange(tabId) {
        // Sync tab state
        this.state.setActiveTab(tabId)

        // Resize editor for the new layout
        if (this.options.autoResize) {
            this.ui.autoResizeTextarea()
        }
    }

    /**
     * Public API: Get editor content
     * @returns {string} Current content
     */
    getContent() {
        return this.state.getContent()
    }

    /**
     * Public API: Set editor content
     * @param {string} content - Content to set
     * @param {boolean} [resetInitial=false] - Whether to reset initial content
     */
    setContent(content, resetInitial = false) {
        // Update state
        this.state.setContent(content)

        // If resetInitial is true, reset initial content
        if (resetInitial) {
            this.state.resetInitialContent()
        }

        // Update UI
        this.ui.textarea.value = content

        // Update preview
        this.renderPreview()

        // Update change indicator
        this.updateChangeIndicator()

        // Auto-resize if enabled
        if (this.options.autoResize) {
            this.ui.autoResizeTextarea()
        }
    }

    /**
     * Public API: Focus the editor
     */
    focus() {
        this.ui.focus()
    }

    /**
     * Public API: Reset the change indicator
     * This method will be called after content is saved
     */
    resetChangeIndicator() {
        // Reset the initial content to match current content
        this.state.resetInitialContent()

        // Update the change indicator in the UI
        this.updateChangeIndicator()
    }
}
