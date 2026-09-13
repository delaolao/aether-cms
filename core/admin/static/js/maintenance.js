/**
 * 后台「系统维护」页 —— 只读体检的重新执行与备份下载。
 *
 * 页面本身是服务端渲染的（无 JS 也能看），这里只做两件事：
 *   1. 「重新体检」：请求 /api/maintenance/report，刷新结论条与提醒清单
 *   2. 「下载内容备份」：按当前选项拼 zip 的查询串
 *
 * 刻意不做任何写操作 —— 这个页面没有"执行维护动作"的能力，避免误点。
 */
(function () {
    "use strict"

    const dataEl = document.getElementById("maintenance-data")
    const endpointsEl = document.getElementById("maintenance-endpoints")
    const refreshBtn = document.getElementById("maintenance-refresh")
    const backupLink = document.getElementById("maintenance-backup")

    if (!dataEl || !endpointsEl) return

    const reportApi = String(endpointsEl.textContent || "").split("|")[0]

    function setBusy(button, busy, busyText) {
        if (!button) return
        if (busy) {
            button.dataset.idleText = button.textContent
            button.textContent = busyText
            button.setAttribute("disabled", "disabled")
        } else {
            if (button.dataset.idleText) button.textContent = button.dataset.idleText
            button.removeAttribute("disabled")
        }
    }

    function levelText(level) {
        return level === "error" ? "错误" : "提醒"
    }

    /** 用新报告刷新结论条与提醒清单（明细区保持服务端渲染的版本，避免两套渲染逻辑） */
    function applyStatus(report) {
        const status = document.getElementById("maint-status")
        if (status) {
            status.classList.toggle("is-ok", Boolean(report.ok))
            status.classList.toggle("is-bad", !report.ok)
            const icon = status.querySelector(".maint-status-icon")
            const text = status.querySelector(".maint-status-text")
            if (icon) icon.textContent = report.ok ? "✅" : "⚠️"
            if (text) {
                let message = report.ok
                    ? "未发现阻断性问题"
                    : `发现 ${report.counts.error} 项需要立即处理`
                if (report.counts.warn) message += ` · ${report.counts.warn} 项提醒`
                text.textContent = message
            }
            const meta = status.querySelector(".maint-status-meta")
            if (meta) meta.textContent = `生成于 ${report.generatedAt} · 耗时 ${report.tookMs} ms`
        }

        const list = document.querySelector(".maint-issues")
        if (!list) return
        list.innerHTML = ""
        for (const issue of report.issues) {
            const li = document.createElement("li")
            li.className = `maint-issue level-${issue.level}`

            const badge = document.createElement("span")
            badge.className = "maint-issue-badge"
            badge.textContent = levelText(issue.level)

            const section = document.createElement("span")
            section.className = "maint-issue-section"
            section.textContent = issue.section

            const text = document.createElement("span")
            text.className = "maint-issue-text"
            text.textContent = issue.text

            li.append(badge, section, text)
            list.appendChild(li)
        }
    }

    if (refreshBtn && reportApi) {
        refreshBtn.addEventListener("click", async () => {
            setBusy(refreshBtn, true, "体检中…")
            try {
                const response = await fetch(reportApi, { headers: { Accept: "application/json" } })
                if (response.status === 401) {
                    window.location.href = "/aether/login"
                    return
                }
                const payload = await response.json()
                if (!payload.success) throw new Error(payload.error || "体检失败")
                applyStatus(payload.report)
                if (window.I18N) window.I18N.init()
            } catch (error) {
                window.alert(`体检请求失败：${error.message}`)
            } finally {
                setBusy(refreshBtn, false)
            }
        })
    }

    // 备份下载：链接由模板直接给出（含上传 / 仅数据两种），不需要 JS 参与，
    // 因此在没有 JS 或请求被拦截时依然可用。
    void backupLink
})()
