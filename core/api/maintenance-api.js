/**
 * 维护接口（后台，需登录）
 *
 *   GET /api/maintenance/report        只读体检报告（JSON）
 *   GET /api/maintenance/backup.zip    就地打包 content/data + content/uploads 供下载
 *
 * 边界说明（为什么这里只有这两件事）：
 *   进程内能做、且只读/可就地完成的事 → 放这里；
 *   需要 shell 或操作系统权限的事（跨机同步、密钥轮换、进程重启、把归档拉回本机）
 *   → 仍然只能留在 CLI，见 tools/ 下的脚本。后台页面会把这条边界直接写给使用者看。
 */
import AdmZip from "adm-zip"
import { buildSiteReport, collectBackupFiles, formatBytes } from "../lib/maintenance/site-doctor.js"

// 浏览器下载归档的上限：adm-zip 在内存里组装，超过这个体量请改用 CLI（可流式 + 异地留档）
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024

export function setupMaintenanceApi(app, systems) {
    const { contentManager, analyticsStore, authenticate, paths } = systems

    app.get("/api/maintenance/report", authenticate, async (req, res) => {
        try {
            const report = await buildSiteReport({ paths, contentManager, analyticsStore, req })
            res.statusCode = 200
            res.setHeader("Content-Type", "application/json; charset=utf-8")
            res.setHeader("Cache-Control", "no-store")
            return res.end(JSON.stringify({ success: true, report }))
        } catch (error) {
            console.error("Maintenance report error:", error)
            res.statusCode = 500
            res.setHeader("Content-Type", "application/json; charset=utf-8")
            return res.end(JSON.stringify({ success: false, error: error.message }))
        }
    })

    app.get("/api/maintenance/backup.zip", authenticate, async (req, res) => {
        try {
            const getFlag = (name, fallback) => {
                const raw = req.queryParams?.get(name)
                if (raw === null || raw === undefined || raw === "") return fallback
                return /^(1|true|yes|on)$/i.test(String(raw))
            }
            const includeUploads = getFlag("uploads", true)
            const includeAnalytics = getFlag("analytics", false)

            const collected = await collectBackupFiles({ paths, includeUploads, includeAnalytics })
            if (collected.files.length === 0) {
                res.statusCode = 404
                res.setHeader("Content-Type", "application/json; charset=utf-8")
                return res.end(JSON.stringify({ success: false, error: "没有可打包的内容文件" }))
            }
            if (collected.bytes > MAX_ARCHIVE_BYTES) {
                res.statusCode = 413
                res.setHeader("Content-Type", "application/json; charset=utf-8")
                return res.end(
                    JSON.stringify({
                        success: false,
                        error: `待打包内容 ${formatBytes(collected.bytes)}，超过浏览器下载上限 ${formatBytes(
                            MAX_ARCHIVE_BYTES
                        )}；请改用 tools/backup-content.ps1（可流式打包并异地留档）`,
                    })
                )
            }

            const port = req?.socket?.localPort || "unknown"
            const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15)

            // 清单与 CLI 备份对齐，便于事后核对来源与体量
            const manifest = {
                createdAt: new Date().toISOString(),
                source: "admin /aether/maintenance（就地打包）",
                instance: {
                    root: collected.rootDir,
                    port: String(port),
                    pid: process.pid,
                    node: process.version,
                    theme: (await contentManager.getSiteSettings().catch(() => ({}))).activeTheme || "default",
                },
                options: { includeUploads, includeAnalytics },
                totals: {
                    files: collected.files.length,
                    bytes: collected.bytes,
                    humanBytes: formatBytes(collected.bytes),
                    skippedAnalyticsFiles: collected.skippedAnalytics,
                },
                note: "本归档是就地临时副本；异地留档请使用 tools/backup-content.ps1（ssh/scp 拉回本机）。",
                entries: collected.files.map((file) => ({ path: file.zipPath, bytes: file.size })),
            }

            const zip = new AdmZip()
            for (const file of collected.files) {
                zip.addLocalFile(file.full, file.zipPath.slice(0, file.zipPath.lastIndexOf("/")))
            }
            zip.addFile("BACKUP-MANIFEST.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"))
            const buffer = zip.toBuffer()

            res.statusCode = 200
            res.setHeader("Content-Type", "application/zip")
            res.setHeader("Content-Length", String(buffer.length))
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="aether-content-port${port}-${stamp}.zip"`
            )
            res.setHeader("Cache-Control", "no-store")
            return res.end(buffer)
        } catch (error) {
            console.error("Maintenance backup error:", error)
            res.statusCode = 500
            res.setHeader("Content-Type", "application/json; charset=utf-8")
            return res.end(JSON.stringify({ success: false, error: error.message }))
        }
    })
}
