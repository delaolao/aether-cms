#!/usr/bin/env node
/**
 * Reset a user's password directly in `content/data/users.json`.
 *
 * Why a CLI tool: the web UI needs an existing login, and the security
 * hardening checklist ("rotate the admin password after the data directory was
 * exposed") has to work even when nobody knows the current password.
 *
 * It reuses the application's own PasswordService, so the produced hash is
 * byte-for-byte compatible with the login flow (scrypt, self-describing
 * `scrypt$N$r$p$salt$key` format).
 *
 * Usage
 *   node tools/reset-admin-password.mjs --password 'NewStrongPassword'
 *   node tools/reset-admin-password.mjs --username admin --generate
 *   node tools/reset-admin-password.mjs --generate --clear-sessions
 *   node tools/reset-admin-password.mjs --list
 *   node tools/reset-admin-password.mjs --password x --dry-run
 *
 * Options
 *   --username <name>     account to update (default: admin)
 *   --id <id>             update by user id instead of username
 *   --password <value>    new password (min 8 chars) — or set AE_NEW_PASSWORD
 *   --generate            generate a strong random password instead
 *   --data-dir <path>     data directory (default: content/data)
 *   --clear-sessions      also empty sessions.json (logs everyone out)
 *   --list                list users (no change)
 *   --dry-run             show what would change, write nothing
 *   --quiet               only print the password (for scripting)
 *
 * Passing the password through the AE_NEW_PASSWORD environment variable keeps
 * it out of the process list (ps) on shared servers.
 *
 * The file is written atomically (tmp + rename) and the previous version is
 * kept next to it as `users.json.bak-<timestamp>`.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { join, resolve } from "node:path"
import { PasswordService } from "../core/lib/auth/modules/password-service.js"

function parseArgs(argv) {
    const args = { username: "admin", dataDir: "content/data", dryRun: false, generate: false, clearSessions: false, list: false, quiet: false }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const value = () => {
            const next = argv[i + 1]
            if (next === undefined || next.startsWith("--")) {
                console.error(`缺少参数值: ${arg}`)
                process.exit(2)
            }
            i += 1
            return next
        }
        switch (arg) {
            case "--username":
            case "-u":
                args.username = value()
                break
            case "--id":
                args.id = value()
                break
            case "--password":
            case "-p":
                args.password = value()
                break
            case "--data-dir":
                args.dataDir = value()
                break
            case "--generate":
                args.generate = true
                break
            case "--clear-sessions":
                args.clearSessions = true
                break
            case "--list":
                args.list = true
                break
            case "--dry-run":
                args.dryRun = true
                break
            case "--quiet":
                args.quiet = true
                break
            case "--help":
            case "-h":
                console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0].replace(/^\/\*\*?/, "").replace(/^ ?\* ?/gm, ""))
                process.exit(0)
                break
            default:
                console.error(`未知参数: ${arg}`)
                process.exit(2)
        }
    }
    return args
}

/** Human-friendly but strong: avoids characters that are painful in a shell. */
function generatePassword(length = 20) {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_=+"
    const bytes = randomBytes(length)
    let out = ""
    for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
    return out
}

function main() {
    const args = parseArgs(process.argv.slice(2))
    const dataDir = resolve(args.dataDir)
    const usersPath = join(dataDir, "users.json")
    const sessionsPath = join(dataDir, "sessions.json")

    if (!existsSync(usersPath)) {
        console.error(`找不到用户文件: ${usersPath}`)
        process.exit(1)
    }

    let users
    try {
        users = JSON.parse(readFileSync(usersPath, "utf8"))
    } catch (error) {
        console.error(`无法解析 ${usersPath}: ${error.message}`)
        process.exit(1)
    }
    const isArray = Array.isArray(users)
    const list = isArray ? users : users.users || []

    if (args.list) {
        console.log(`用户文件: ${usersPath}`)
        for (const user of list) {
            console.log(`  id=${user.id}  username=${user.username}  role=${user.role}  email=${user.email || "-"}`)
        }
        return
    }

    const index = list.findIndex((user) => (args.id ? user.id === args.id : user.username === args.username))
    if (index === -1) {
        console.error(`未找到用户: ${args.id ? `id=${args.id}` : `username=${args.username}`}`)
        process.exit(1)
    }
    const target = list[index]

    const password = args.generate ? generatePassword() : args.password || process.env.AE_NEW_PASSWORD
    if (!password) {
        console.error("请用 --password <新密码> 指定密码，或用 --generate 自动生成，或设置 AE_NEW_PASSWORD")
        process.exit(2)
    }
    if (password.length < 8) {
        console.error("密码太短：至少 8 个字符")
        process.exit(2)
    }

    const service = new PasswordService()

    return (async () => {
        const passwordHash = await service.hashPassword(password)
        const verified = await service.verifyPassword(password, passwordHash)
        if (!verified) {
            console.error("自检失败：新哈希无法通过校验，未写入任何内容")
            process.exit(1)
        }

        const updated = {
            ...target,
            passwordHash,
            updatedAt: new Date().toISOString(),
        }

        if (args.dryRun) {
            console.log(`[dry-run] 将更新 ${usersPath} 中的用户 ${target.username}（id=${target.id}）`)
            console.log(`[dry-run] 新密码长度 ${password.length}，哈希前缀 ${passwordHash.slice(0, 12)}…（自检通过）`)
            if (args.clearSessions) console.log(`[dry-run] 将清空 ${sessionsPath}`)
            console.log(`[dry-run] 新密码：${password}`)
            return
        }

        list[index] = updated
        const payload = isArray ? list : { ...users, users: list }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const backupPath = `${usersPath}.bak-${stamp}`

        copyFileSync(usersPath, backupPath)
        const tmpPath = `${usersPath}.tmp-${process.pid}`
        writeFileSync(tmpPath, `${JSON.stringify(payload, null, 4)}\n`, { encoding: "utf8", mode: 0o600 })
        renameSync(tmpPath, usersPath)

        if (args.clearSessions && existsSync(sessionsPath)) {
            const sessionsBackup = `${sessionsPath}.bak-${stamp}`
            copyFileSync(sessionsPath, sessionsBackup)
            writeFileSync(sessionsPath, "{}\n", { encoding: "utf8", mode: 0o600 })
        }

        if (args.quiet) {
            console.log(password)
            return
        }
        console.log(`已更新用户 ${updated.username}（id=${updated.id}）的密码`)
        console.log(`  文件    : ${usersPath}`)
        console.log(`  备份    : ${backupPath}`)
        if (args.clearSessions) console.log(`  会话    : 已清空 ${sessionsPath}（所有登录态失效）`)
        console.log(`  新密码  : ${password}`)
        console.log("请立即登录后台确认，并妥善保存该密码（本提示只显示这一次）。")
    })()
}

main()
