/**
 * Knowledge Graph — zero-dependency canvas force graph for Aether CMS.
 *
 * Ported and simplified from hblog-ng (MIT, halit/hblog-ng): hand-rolled
 * force simulation (center pull / repulsion / friction / bounds / sleep)
 * rendered to <canvas>, with drag, wheel zoom, hover, search filter, type
 * filter and click-to-navigate.
 *
 * Coordinate model
 * ----------------
 * All physics and drawing use LOGICAL (CSS-pixel) coordinates in the range
 * [0, logicalW] x [0, logicalH]. The backing canvas buffer is scaled by
 * devicePixelRatio so text and nodes stay crisp on hi-DPI displays without
 * shifting layout. On every resize the nodes are re-centered, so the graph
 * always fills the visible box and never overflows the page.
 *
 * Expects: a <script type="application/json" id="graph-data"> payload of
 * { nodes: [{id,title,slug,type,url,category,tags}], edges: [{source,target}] }
 * and a <canvas id="knowledge-graph">.
 */
(function () {
    "use strict"

    const dataEl = document.getElementById("graph-data")
    const canvas = document.getElementById("knowledge-graph")
    if (!dataEl || !canvas) return

    let payload
    try {
        payload = JSON.parse(dataEl.textContent)
    } catch (e) {
        console.error("Invalid graph data", e)
        return
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    const nodes = (payload.nodes || []).map((n) => ({
        ...n,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        fixed: false,
        visible: true,
        matched: false,
        neighbor: false,
    }))
    const links = payload.edges || []

    // ------------------------------------------------------------------
    // Heat (view-count) model
    // ------------------------------------------------------------------
    // `views` is injected by the server (analytics). The hottest node defines
    // the top of the ramp; scaling is logarithmic so low-traffic notes still
    // differ from each other instead of collapsing to one size.
    const maxViews = nodes.reduce((max, n) => Math.max(max, Number(n.views || 0)), 0)

    function nodeHeat(node) {
        const views = Number(node?.views || 0)
        if (maxViews <= 0 || views <= 0) return 0
        return Math.log(1 + views) / Math.log(1 + maxViews) // 0..1
    }

    /** Nodes sorted by views (descending) — used by the Top-N filter. */
    function nodesByViews() {
        return nodes.slice().sort((a, b) => Number(b.views || 0) - Number(a.views || 0))
    }

    function sizeOf(node) {
        const heat = nodeHeat(node)
        return {
            heat,
            width: Math.round(NODE_WIDTH * (1 + HEAT_MAX_SCALE * heat)),
            height: Math.round(NODE_HEIGHT * (1 + HEAT_MAX_SCALE * 0.55 * heat)),
        }
    }

    // Physics constants (from hblog-ng config/graph.ts)
    const REPULSION = 2000
    const FRICTION = 0.85
    const CENTER_PULL = 0.002
    const VELOCITY_THRESHOLD = 0.01

    // Visuals (all in logical/CSS pixels)
    const NODE_WIDTH = 150
    const NODE_HEIGHT = 62
    const HEAT_MAX_SCALE = 0.34 // hottest node grows up to +34% (width) / +19% (height)
    const TYPE_COLORS = { post: "#0066cc", page: "#2e7d32" }
    const TYPE_LABELS = { post: "POST", page: "PAGE" }
    const BACKGROUND = "#ffffff"
    const LINK_COLOR = "rgba(150, 160, 180, 0.35)"
    const ACTIVE_COLOR = "#0066cc"

    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) return

    let width = 0 // logical width  (CSS px)
    let height = 0 // logical height (CSS px)
    let dpr = 1 // device pixel ratio
    let zoom = 1
    let draggedNode = null
    let hoveredNode = null
    let simulating = true
    // Track pointer travel to distinguish a click from a drag.
    let downClientX = 0
    let downClientY = 0
    let didDrag = false
    const DRAG_THRESHOLD = 4 // pixels before a mousedown counts as a drag

    // Canvas panning (drag on empty space to move the whole view).
    let panX = 0
    let panY = 0
    let panning = false
    let panStartScreen = { x: 0, y: 0 }
    let panStartPan = { x: 0, y: 0 }

    // ------------------------------------------------------------------
    // Search / filter state
    // ------------------------------------------------------------------
    const searchInput = document.getElementById("graph-search")
    const typeFilter = document.getElementById("graph-type-filter")
    const viewsFilterEl = document.getElementById("graph-views-filter")
    const resetButton = document.getElementById("graph-reset")

    function applyFilters() {
        const query = (searchInput ? searchInput.value : "").trim().toLowerCase()
        const type = typeFilter ? typeFilter.value : ""
        const viewsFilter = viewsFilterEl ? viewsFilterEl.value : ""

        const direct = new Set()
        const all = new Set()
        if (query) {
            nodes.forEach((n) => {
                const haystack = (n.title || "") + " " + (n.category || "") + " " + (n.tags || []).join(" ")
                if (haystack.toLowerCase().includes(query)) direct.add(n.id)
            })
            nodes.forEach((n) => {
                if (direct.has(n.id)) all.add(n.id)
            })
            links.forEach((l) => {
                if (direct.has(l.source)) all.add(l.target)
                if (direct.has(l.target)) all.add(l.source)
            })
        }

        // View-count filter: hides non-matching nodes entirely (Top N / read /
        // unread) so the remaining graph re-settles on its own.
        let viewsAllowed = null
        if (viewsFilter === "read") {
            viewsAllowed = new Set(nodes.filter((n) => Number(n.views || 0) > 0).map((n) => n.id))
        } else if (viewsFilter === "unread") {
            viewsAllowed = new Set(nodes.filter((n) => Number(n.views || 0) <= 0).map((n) => n.id))
        } else if (viewsFilter.startsWith("top")) {
            const limit = parseInt(viewsFilter.slice(3), 10)
            if (limit > 0) {
                viewsAllowed = new Set(
                    nodesByViews()
                        .slice(0, limit)
                        .map((n) => n.id)
                )
            }
        }

        nodes.forEach((n) => {
            n.visible =
                (!type || n.type === type) &&
                (!query || all.has(n.id)) &&
                (!viewsAllowed || viewsAllowed.has(n.id))
            n.matched = query ? direct.has(n.id) : false
            n.neighbor = query ? all.has(n.id) && !direct.has(n.id) : false
        })
        wakeSimulation()
    }

    function resetView() {
        if (searchInput) searchInput.value = ""
        if (typeFilter) typeFilter.value = ""
        if (viewsFilterEl) viewsFilterEl.value = ""
        zoom = 1
        panX = 0
        panY = 0
        panning = false
        centerNodes()
        applyFilters()
    }

    if (searchInput) searchInput.addEventListener("input", applyFilters)
    if (typeFilter) typeFilter.addEventListener("change", applyFilters)
    if (viewsFilterEl) viewsFilterEl.addEventListener("change", applyFilters)
    if (resetButton) resetButton.addEventListener("click", resetView)

    // ------------------------------------------------------------------
    // Sizing — logical vs device pixels, re-centering on resize
    // ------------------------------------------------------------------
    /** Scatter all non-fixed nodes around the current center. */
    function centerNodes() {
        nodes.forEach((n) => {
            if (n.fixed) return
            n.x = width / 2 + (Math.random() - 0.5) * width * 0.6
            n.y = height / 2 + (Math.random() - 0.5) * height * 0.6
            n.vx = 0
            n.vy = 0
        })
        wakeSimulation()
    }

    function resize() {
        const rect = canvas.getBoundingClientRect()
        dpr = window.devicePixelRatio || 1
        // Use the CSS box size as the LOGICAL coordinate space (never let a
        // zero / oddly-small measurement collapse the graph).
        const w = Math.max(320, Math.round(rect.width))
        const h = Math.max(320, Math.round(rect.height))

        const changed = Math.abs(width - w) > 1 || Math.abs(height - h) > 1
        width = w
        height = h
        canvas.width = Math.round(w * dpr) // backing buffer
        canvas.height = Math.round(h * dpr)

        if (changed) centerNodes()
    }

    // ------------------------------------------------------------------
    // Physics
    // ------------------------------------------------------------------
    function wakeSimulation() {
        simulating = true
    }

    function updatePhysics() {
        if (!simulating) return
        let maxVelocity = 0
        const visible = nodes.filter((n) => n.visible)

        for (let i = 0; i < visible.length; i++) {
            const node = visible[i]
            if (node.fixed || node === draggedNode) continue

            node.vx += (width / 2 - node.x) * CENTER_PULL
            node.vy += (height / 2 - node.y) * CENTER_PULL

            for (let j = i + 1; j < visible.length; j++) {
                const other = visible[j]
                const dx = node.x - other.x
                const dy = node.y - other.y
                const distSq = dx * dx + dy * dy
                if (distSq > 0 && distSq < 640000) {
                    const dist = Math.sqrt(distSq)
                    // Bigger (hotter) cards push harder, so the heat scaling does
                    // not make them overlap each other.
                    const heatBoost = 1 + 0.9 * Math.max(nodeHeat(node), nodeHeat(other))
                    const force = (REPULSION * heatBoost) / distSq
                    const fx = (dx / dist) * force
                    const fy = (dy / dist) * force
                    node.vx += fx
                    node.vy += fy
                    if (!other.fixed && other !== draggedNode) {
                        other.vx -= fx
                        other.vy -= fy
                    }
                }
            }

            node.vx *= FRICTION
            node.vy *= FRICTION
        }

        for (const node of visible) {
            if (node.fixed || node === draggedNode) continue
            node.x += node.vx
            node.y += node.vy

            const padding = 60
            if (node.x < padding) { node.x = padding; node.vx *= -1 }
            if (node.x > width - padding) { node.x = width - padding; node.vx *= -1 }
            if (node.y < padding) { node.y = padding; node.vy *= -1 }
            if (node.y > height - padding) { node.y = height - padding; node.vy *= -1 }

            const vSq = node.vx * node.vx + node.vy * node.vy
            if (vSq > maxVelocity) maxVelocity = vSq
        }

        if (maxVelocity < VELOCITY_THRESHOLD * VELOCITY_THRESHOLD && !draggedNode) {
            simulating = false
        }
    }

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------
    function render() {
        updatePhysics()

        // Reset to identity, then scale so 1 logical unit = dpr device px.
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.fillStyle = BACKGROUND
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.save()
        // View transform: screen = center + pan + zoom * (world - center)
        ctx.translate(width / 2 + panX, height / 2 + panY)
        ctx.scale(zoom, zoom)
        ctx.translate(-width / 2, -height / 2)

        const nodeById = new Map(nodes.map((n) => [n.id, n]))
        const hasFilter =
            (searchInput && searchInput.value.trim()) ||
            (typeFilter && typeFilter.value) ||
            (viewsFilterEl && viewsFilterEl.value)

        // Links
        for (const link of links) {
            const source = nodeById.get(link.source)
            const target = nodeById.get(link.target)
            if (!source || !target || !source.visible || !target.visible) continue

            let opacity = 1
            if (hasFilter) {
                if (source.matched || target.matched) opacity = 1
                else if (source.neighbor || target.neighbor) opacity = 0.25
                else opacity = 0.06
            }

            ctx.beginPath()
            ctx.moveTo(source.x, source.y)
            ctx.lineTo(target.x, target.y)
            ctx.strokeStyle = source.matched || target.matched ? ACTIVE_COLOR : LINK_COLOR
            ctx.lineWidth = source.matched || target.matched ? 2.5 : 1.4
            ctx.globalAlpha = opacity
            ctx.stroke()
            ctx.globalAlpha = 1
        }

        // Nodes
        for (const node of nodes) {
            if (!node.visible) continue

            const isHovered = hoveredNode === node
            let opacity = 1
            if (hasFilter && !node.matched && !node.neighbor) opacity = 0.15
            ctx.globalAlpha = opacity

            // Heat: card size, border weight and warmth all scale with views.
            const { heat, width: cardW, height: cardH } = sizeOf(node)
            node.width = cardW
            node.height = cardH
            node.heat = heat
            const nX = node.x - cardW / 2
            const nY = node.y - cardH / 2
            const color = TYPE_COLORS[node.type] || "#6b7280"

            if (node.matched) {
                ctx.strokeStyle = ACTIVE_COLOR
                ctx.lineWidth = 2.5
                ctx.shadowBlur = 8
                ctx.shadowColor = ACTIVE_COLOR
            } else if (isHovered) {
                ctx.strokeStyle = "#ff5252"
                ctx.lineWidth = 1.5 + 1.5 * heat
            } else {
                ctx.strokeStyle = heat >= 0.5 ? "#e07a1f" : color
                ctx.lineWidth = 1.5 + 2 * heat
                if (heat >= 0.6) {
                    ctx.shadowBlur = 8 * heat
                    ctx.shadowColor = "rgba(224, 122, 31, 0.45)"
                }
            }

            // Hotter cards get a warm tint so the ranking is readable at a glance.
            ctx.fillStyle = heat >= 0.7 ? "#fff7ed" : heat >= 0.4 ? "#fffdf8" : "#ffffff"
            ctx.beginPath()
            ctx.roundRect(nX, nY, cardW, cardH, 6)
            ctx.fill()
            ctx.stroke()
            ctx.shadowBlur = 0

            // Title
            ctx.fillStyle = "#1f2937"
            ctx.font = "bold 12px system-ui, sans-serif"
            const title =
                node.title && node.title.length > 20 ? node.title.substring(0, 18) + "…" : node.title || "Untitled"
            ctx.fillText(title, nX + 10, nY + 22)

            // Type badge
            ctx.fillStyle = color
            ctx.font = "10px system-ui, sans-serif"
            const typeLabel = TYPE_LABELS[node.type] || (node.type || "NOTE").toUpperCase()
            const badgeW = ctx.measureText(typeLabel).width + 14
            ctx.beginPath()
            ctx.roundRect(nX + 10, nY + 32, badgeW, 16, 8)
            ctx.fill()
            ctx.fillStyle = "#ffffff"
            ctx.fillText(typeLabel, nX + 17, nY + 44)

            // Category
            if (node.category) {
                ctx.fillStyle = "#9ca3af"
                ctx.font = "10px system-ui, sans-serif"
                ctx.fillText(node.category, nX + 10, nY + cardH - 8)
            }

            // View count (analytics) — right-aligned on the badge line, shown
            // only when the node has been read at least once.
            const views = Number(node.views || 0)
            if (views > 0) {
                ctx.font = "10px system-ui, sans-serif"
                ctx.fillStyle = views >= 100 ? "#c2410c" : "#6b7280"
                const viewsLabel = `👁 ${views}`
                const viewsWidth = ctx.measureText(viewsLabel).width
                ctx.fillText(viewsLabel, nX + cardW - 10 - viewsWidth, nY + 44)
            }

            ctx.globalAlpha = 1
        }

        ctx.restore()

        // Status overlay (drawn in logical coords)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        if (hasFilter) {
            const visibleCount = nodes.filter((n) => n.visible).length
            ctx.fillStyle = "#6b7280"
            ctx.font = "12px system-ui, sans-serif"
            ctx.fillText(`显示 ${visibleCount} / ${nodes.length} 个节点`, 12, height - 12)
        }

        // Heat legend — only meaningful when the graph carries view counts.
        if (maxViews > 0) {
            ctx.font = "11px system-ui, sans-serif"
            ctx.fillStyle = "#98a2b3"
            const legend = `节点大小/描边 ∝ 阅读量（最高 ${maxViews}）`
            const legendWidth = ctx.measureText(legend).width
            ctx.fillText(legend, width - 12 - legendWidth, height - 12)
        }
    }

    function frame() {
        render()
        requestAnimationFrame(frame)
    }

    // ------------------------------------------------------------------
    // Interaction (logical coords; getBoundingClientRect is already CSS px)
    // ------------------------------------------------------------------
    function getWorldCoordinates(clientX, clientY) {
        const rect = canvas.getBoundingClientRect()
        const screenX = clientX - rect.left
        const screenY = clientY - rect.top
        // Inverse of the view transform: world = C + (screen - C - pan) / zoom
        return {
            x: (screenX - width / 2 - panX) / zoom + width / 2,
            y: (screenY - height / 2 - panY) / zoom + height / 2,
        }
    }

    function findNodeAt(x, y) {
        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i]
            if (!n.visible) continue
            const w = n.width || NODE_WIDTH
            const h = n.height || NODE_HEIGHT
            if (Math.abs(n.x - x) <= w / 2 && Math.abs(n.y - y) <= h / 2) return n
        }
        return null
    }

    /**
     * Clamp the pan so the world point at the viewport centre always stays
     * inside the graph's bounding box (plus a margin). This makes the view
     * stop at the graph boundary instead of letting it drift far off-screen.
     */
    function clampPan() {
        const visible = nodes.filter((n) => n.visible)
        const list = visible.length ? visible : nodes
        if (list.length === 0) return

        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (const n of list) {
            const w = (n.width || NODE_WIDTH) / 2
            const h = (n.height || NODE_HEIGHT) / 2
            minX = Math.min(minX, n.x - w)
            maxX = Math.max(maxX, n.x + w)
            minY = Math.min(minY, n.y - h)
            maxY = Math.max(maxY, n.y + h)
        }

        const margin = 100
        minX -= margin
        maxX += margin
        minY -= margin
        maxY += margin

        // World coordinate currently at the viewport centre.
        const centerX = width / 2 - panX / zoom
        const centerY = height / 2 - panY / zoom

        // Clamp that centre into the graph bounds, then convert back to pan.
        const cx = Math.min(Math.max(centerX, minX), maxX)
        const cy = Math.min(Math.max(centerY, minY), maxY)
        panX = (width / 2 - cx) * zoom
        panY = (height / 2 - cy) * zoom
    }

    /** Reset zoom + pan (keeps node positions). Used by double-click. */
    function resetViewTransform() {
        zoom = 1
        panX = 0
        panY = 0
        panning = false
        canvas.style.cursor = "grab"
        wakeSimulation()
    }

    canvas.addEventListener("mousemove", (e) => {
        if (draggedNode) {
            const { x, y } = getWorldCoordinates(e.clientX, e.clientY)
            draggedNode.x = x
            draggedNode.y = y
            draggedNode.vx = 0
            draggedNode.vy = 0
            // Once the pointer moves beyond the threshold, it's a drag, not a click.
            if (Math.hypot(e.clientX - downClientX, e.clientY - downClientY) > DRAG_THRESHOLD) {
                didDrag = true
            }
            wakeSimulation()
        } else if (panning) {
            // Pan the whole canvas with the pointer.
            panX = panStartPan.x + (e.clientX - panStartScreen.x)
            panY = panStartPan.y + (e.clientY - panStartScreen.y)
            clampPan()
        } else {
            const { x, y } = getWorldCoordinates(e.clientX, e.clientY)
            hoveredNode = findNodeAt(x, y)
            canvas.style.cursor = hoveredNode ? "pointer" : "grab"
        }
    })

    canvas.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return
        const { x, y } = getWorldCoordinates(e.clientX, e.clientY)
        const node = findNodeAt(x, y)
        if (node) {
            draggedNode = node
            hoveredNode = node
            downClientX = e.clientX
            downClientY = e.clientY
            didDrag = false
            canvas.style.cursor = "grabbing"
            wakeSimulation()
        } else {
            // Empty space: start panning the view.
            panning = true
            panStartScreen = { x: e.clientX, y: e.clientY }
            panStartPan = { x: panX, y: panY }
            canvas.style.cursor = "grabbing"
        }
    })

    canvas.addEventListener("mouseup", (e) => {
        if (draggedNode && e.button === 0) {
            const target = draggedNode
            draggedNode.fixed = true
            draggedNode = null
            // Only navigate on a genuine click (no meaningful drag).
            if (!didDrag && target.url) {
                window.location.href = target.url
            }
            didDrag = false
        }
        if (panning && e.button === 0) {
            panning = false
            canvas.style.cursor = "grab"
        }
    })

    canvas.addEventListener("dblclick", (e) => {
        // Double-click on the canvas resets the view (zoom + pan).
        e.preventDefault()
        resetViewTransform()
    })

    canvas.addEventListener("mouseleave", () => {
        hoveredNode = null
        if (panning) {
            panning = false
            canvas.style.cursor = "grab"
        }
    })

    canvas.addEventListener("wheel", (e) => {
        e.preventDefault()
        const delta = -e.deltaY
        zoom = Math.min(Math.max(zoom + delta * 0.001, 0.4), 2.5)
        clampPan()
        wakeSimulation()
    }, { passive: false })

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------
    window.addEventListener("resize", resize)
    resize()
    canvas.style.cursor = "grab" // empty space pans the view
    applyFilters()
    frame()
})()
