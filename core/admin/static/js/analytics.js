/**
 * Analytics trend chart — zero-dependency canvas line chart (PV + UV).
 *
 * Reads the embedded `<script type="application/json" id="analytics-data">`
 * payload rendered by /aether/analytics and draws two series with grid lines,
 * axis labels and a hover readout. Mirrors the style of the knowledge-graph
 * runtime (logical/CSS-pixel coordinates + devicePixelRatio scaling).
 */
;(function () {
    "use strict"

    var dataEl = document.getElementById("analytics-data")
    var canvas = document.getElementById("analytics-trend")
    if (!dataEl || !canvas) return

    var payload
    try {
        payload = JSON.parse(dataEl.textContent)
    } catch (e) {
        console.error("Invalid analytics payload", e)
        return
    }

    var series = (payload && payload.series) || []
    var ctx = canvas.getContext("2d")
    var dpr = window.devicePixelRatio || 1
    var hoverIndex = -1

    var PADDING = { top: 16, right: 16, bottom: 28, left: 40 }
    var COLOR_PV = "#0066cc"
    var COLOR_UV = "#ff8f3f"

    function logicalSize() {
        var rect = canvas.getBoundingClientRect()
        var w = Math.max(320, Math.floor(rect.width || canvas.clientWidth || 800))
        var h = Math.max(160, Math.floor(rect.height || 220))
        return { w: w, h: h }
    }

    function maxValue() {
        var max = 1
        series.forEach(function (point) {
            max = Math.max(max, point.pv || 0, point.uv || 0)
        })
        return max
    }

    function niceMax(value) {
        if (value <= 5) return 5
        var pow = Math.pow(10, Math.floor(Math.log10(value)))
        var scaled = value / pow
        var step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
        return step * pow
    }

    function pointX(index, plotWidth, count) {
        if (count <= 1) return PADDING.left + plotWidth / 2
        return PADDING.left + (plotWidth * index) / (count - 1)
    }

    function pointY(value, plotHeight, max) {
        return PADDING.top + plotHeight - (plotHeight * value) / max
    }

    function drawSeries(key, color, plotWidth, plotHeight, max) {
        if (!series.length) return
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        series.forEach(function (point, index) {
            var x = pointX(index, plotWidth, series.length)
            var y = pointY(point[key] || 0, plotHeight, max)
            if (index === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        })
        ctx.stroke()

        // Points (skip when crowded, except the hovered one)
        var showPoints = series.length <= 40
        series.forEach(function (point, index) {
            if (!showPoints && index !== hoverIndex) return
            var x = pointX(index, plotWidth, series.length)
            var y = pointY(point[key] || 0, plotHeight, max)
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(x, y, index === hoverIndex ? 4 : 2.5, 0, Math.PI * 2)
            ctx.fill()
        })
    }

    function draw() {
        var size = logicalSize()
        var plotWidth = Math.max(10, size.w - PADDING.left - PADDING.right)
        var plotHeight = Math.max(10, size.h - PADDING.top - PADDING.bottom)

        canvas.width = Math.floor(size.w * dpr)
        canvas.height = Math.floor(size.h * dpr)
        canvas.style.width = size.w + "px"
        canvas.style.height = size.h + "px"
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, size.w, size.h)

        var max = niceMax(maxValue())

        // Grid + Y labels
        ctx.font = "11px system-ui, -apple-system, Segoe UI, sans-serif"
        ctx.fillStyle = "#98a2b3"
        ctx.strokeStyle = "#eef1f4"
        ctx.lineWidth = 1
        var steps = 4
        for (var i = 0; i <= steps; i++) {
            var value = (max * i) / steps
            var y = pointY(value, plotHeight, max)
            ctx.beginPath()
            ctx.moveTo(PADDING.left, y)
            ctx.lineTo(PADDING.left + plotWidth, y)
            ctx.stroke()
            ctx.fillText(String(Math.round(value)), 6, y + 4)
        }

        if (!series.length) {
            ctx.fillStyle = "#98a2b3"
            ctx.fillText("暂无数据", PADDING.left + 8, PADDING.top + 18)
            return
        }

        // X labels (thin out when crowded)
        var labelStep = Math.max(1, Math.ceil(series.length / 10))
        ctx.fillStyle = "#98a2b3"
        series.forEach(function (point, index) {
            if (index % labelStep !== 0 && index !== series.length - 1) return
            var x = pointX(index, plotWidth, series.length)
            ctx.fillText(point.short || point.day, x - 14, size.h - 8)
        })

        drawSeries("pv", COLOR_PV, plotWidth, plotHeight, max)
        drawSeries("uv", COLOR_UV, plotWidth, plotHeight, max)

        // Hover readout
        if (hoverIndex >= 0 && series[hoverIndex]) {
            var point = series[hoverIndex]
            var hx = pointX(hoverIndex, plotWidth, series.length)
            ctx.strokeStyle = "rgba(0, 102, 204, 0.28)"
            ctx.beginPath()
            ctx.moveTo(hx, PADDING.top)
            ctx.lineTo(hx, PADDING.top + plotHeight)
            ctx.stroke()

            var text = (point.day || "") + "  PV " + (point.pv || 0) + " · UV " + (point.uv || 0)
            ctx.font = "12px system-ui, -apple-system, Segoe UI, sans-serif"
            var textWidth = ctx.measureText(text).width
            var boxX = Math.min(Math.max(PADDING.left, hx - textWidth / 2 - 8), size.w - textWidth - 20)
            ctx.fillStyle = "rgba(23, 35, 51, 0.9)"
            ctx.fillRect(boxX, PADDING.top - 2, textWidth + 16, 22)
            ctx.fillStyle = "#fff"
            ctx.fillText(text, boxX + 8, PADDING.top + 13)
        }
    }

    function indexFromEvent(event) {
        if (!series.length) return -1
        var rect = canvas.getBoundingClientRect()
        var x = event.clientX - rect.left
        var plotWidth = rect.width - PADDING.left - PADDING.right
        if (plotWidth <= 0) return -1
        var ratio = (x - PADDING.left) / plotWidth
        var index = Math.round(ratio * (series.length - 1))
        return Math.min(series.length - 1, Math.max(0, index))
    }

    canvas.addEventListener("mousemove", function (event) {
        var index = indexFromEvent(event)
        if (index !== hoverIndex) {
            hoverIndex = index
            draw()
        }
    })

    canvas.addEventListener("mouseleave", function () {
        if (hoverIndex !== -1) {
            hoverIndex = -1
            draw()
        }
    })

    window.addEventListener("resize", draw)
    draw()
})()
