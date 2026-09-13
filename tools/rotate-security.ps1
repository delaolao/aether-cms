<#
.SYNOPSIS
    服务器侧安全收尾：轮换 COOKIE_SECRET、重置管理员口令、清空会话、复核敏感路径 404。

.DESCRIPTION
    背景：/.env、content/data/*.json 曾可被公网直接下载，泄露内容包含 COOKIE_SECRET
    （可据此伪造登录 Cookie）与管理员口令哈希。代码层的敏感路径护栏已经上线（实测
    https://xl.dleu.net/.env 与 https://xq.dleu.net/.env 均返回 404 且带 __aether_not_found__
    标记，说明是应用护栏在生效），但**已泄露的密钥必须更换**，否则护栏只是关上门、
    钥匙却还在外面。

    本脚本对每个实例执行：
      1. 备份 .env（含旧密钥指纹，便于事后比对，但绝不打印密钥本身）
      2. 生成新的 COOKIE_SECRET（每个实例各自独立），写回 .env（保留原有权限位）
      3. 用 tools/reset-admin-password.mjs 重置管理员口令（同一口令应用到各实例，方便管理）
         并清空 sessions.json（所有旧登录态立即失效）
      4. 执行重启命令，让新密钥生效
      5. 复核：/.env 必须 404、首页必须 200，并列出 .env 中其它疑似密钥的**键名**
      6. 打印新口令（只显示一次）与后续人工复核清单

    密码通过 AE_NEW_PASSWORD 环境变量在服务器内部传递，不会出现在 ps 的进程列表里。

.PARAMETER Server
    目标服务器（默认 admin@100.66.18.125）。

.PARAMETER Instances
    实例目录列表（默认三个实例）。

.PARAMETER RestartCommand
    在每个实例目录内执行的重启命令，例如 'pm2 restart all'。
    不提供时不会重启——新 COOKIE_SECRET 要等下次重启才生效，脚本会明确提示。

.PARAMETER AdminPassword
    指定新的管理员口令（留空则自动生成一个 20 位强口令并打印一次）。

.PARAMETER AdminUser
    要重置口令的账号名（默认 admin）。

.PARAMETER KeepSessions
    保留现有会话（默认会清空 sessions.json，让所有旧登录态失效）。

.PARAMETER RotateAnalyticsSalt
    一并轮换统计用的加盐哈希盐值（`content/data/analytics/salt.txt`；若 `.env` 里设了
    ANALYTICS_SALT 则轮换该值）。盐值也曾随 content/data 一起暴露，泄露后他人可结合明细
    日志暴力枚举访客 IP；轮换后**历史聚合数字不受影响**，只是后续 UV 去重换了新盐
    （需要重启才生效）。

.PARAMETER SkipSecret / SkipPassword
    只做其中一件事。

.PARAMETER DryRun
    只打印将要执行的内容，不修改服务器。

.PARAMETER ShowRemoteScript
    打印将在服务器上执行的 bash 脚本后退出（便于先审阅）。

.PARAMETER CheckOnly
    只做**只读体检**：打印各实例 .env 的 COOKIE_SECRET 长度与指纹（不显示密钥本身）、
    其它疑似密钥的键名、PORT、node/openssl/curl 是否可用、users.json/sessions.json 是否存在、
    本机 curl 复核首页与 /.env、以及 tmux/pm2 的守护情况。
    不做任何修改，用来先确认「重启命令该怎么写」并验证 scp/ssh 通路。

.EXAMPLE
    # 第一步：只读体检（零风险，先摸清端口、依赖与守护方式）
    .\tools\rotate-security.ps1 -CheckOnly

.EXAMPLE
    # 先审阅远端脚本
    .\tools\rotate-security.ps1 -ShowRemoteScript

.EXAMPLE
    # 正式执行（需输入两次服务器密码：scp 一次、ssh 一次），并重启 pm2
    .\tools\rotate-security.ps1 -RestartCommand 'pm2 restart all'

.EXAMPLE
    # 使用 tmux 守护的实例：分别重启
    .\tools\rotate-security.ps1 -RestartCommand 'true'
    # 再手动执行：
    #   tmux kill-session -t xl-aether; tmux new-session -d -s xl-aether -c /data/te_se_zi_yuan/xl/aether-cms 'node index.js'
#>

[CmdletBinding()]
param(
    [string]$Server = 'admin@100.66.18.125',
    [string[]]$Instances = @(
        '/home/admin/aether-cms',
        '/data/te_se_zi_yuan/xl/aether-cms',
        '/data/te_se_zi_yuan/xq/aether-cms'
    ),
    [string]$RestartCommand = '',
    [string]$AdminPassword = '',
    [string]$AdminUser = 'admin',
    [switch]$KeepSessions,
    [switch]$RotateAnalyticsSalt,
    [switch]$SkipSecret,
    [switch]$SkipPassword,
    [switch]$DryRun,
    [switch]$ShowRemoteScript,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$RepoPath = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tag = "aether-security-$stamp"

# ---------------------------------------------------------------------------
# 0. 生成/校验新口令（本地生成，三实例共用，便于记忆与管理）
# ---------------------------------------------------------------------------
if (-not $SkipPassword) {
    if (-not $AdminPassword) {
        $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_=+'
        $bytes = New-Object byte[] 20
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $chars = foreach ($b in $bytes) { $alphabet[$b % $alphabet.Length] }
        $AdminPassword = -join $chars
        $generatedPassword = $true
    } elseif ($AdminPassword.Length -lt 8) {
        Write-Host '指定的 -AdminPassword 少于 8 个字符，已中止。' -ForegroundColor Red
        exit 1
    }
}

$resetToolLocal = Join-Path $RepoPath 'tools/reset-admin-password.mjs'
if (-not $SkipPassword -and -not (Test-Path $resetToolLocal)) {
    Write-Host ("找不到 {0}，无法重置口令。" -f $resetToolLocal) -ForegroundColor Red
    exit 1
}

# 口令要嵌进远端 bash 的双引号字符串里，这里先按双引号规则转义，
# 避免自定义口令里的 \ " $ ` 被 bash 解释（自动生成的口令本来就不含这些字符）。
$AdminPasswordBash = $AdminPassword
if ($AdminPasswordBash) {
    $AdminPasswordBash = $AdminPasswordBash.Replace('\', '\\').Replace('"', '\"').Replace('$', '\$').Replace('`', '\`')
}

Write-Host ''
Write-Host '=== Aether CMS 服务器安全收尾 ===' -ForegroundColor Cyan
Write-Host ("目标服务器 : {0}" -f $Server)
Write-Host ("实例数     : {0}" -f $Instances.Count)
foreach ($i in $Instances) { Write-Host ("             - {0}" -f $i) }
Write-Host ("轮换 COOKIE_SECRET : {0}" -f (-not $SkipSecret))
Write-Host ("重置管理员口令     : {0}{1}" -f (-not $SkipPassword), $(if ($SkipPassword) { '' } else { "（账号 $AdminUser，三实例同一口令）" }))
Write-Host ("清空 sessions.json : {0}" -f (-not $KeepSessions))
Write-Host ("轮换统计盐值       : {0}" -f [bool]$RotateAnalyticsSalt)
Write-Host ("重启命令           : {0}" -f $(if ($RestartCommand) { $RestartCommand } else { '(无 —— 新密钥需手动重启后生效)' }))
Write-Host ("模式               : {0}" -f $(if ($CheckOnly) { '只读体检（CheckOnly，不做任何修改）' } elseif ($DryRun) { 'DryRun（不做任何修改）' } else { '正式执行' }))

# ---------------------------------------------------------------------------
# 1. 远端 bash 脚本
# ---------------------------------------------------------------------------
# 只读体检脚本（-CheckOnly）：先摸清端口、依赖与守护方式，零风险
$checkTemplate = @'
set -u
for D in __INSTANCES__; do
    echo ""
    echo "=== $D ==="
    if [ ! -d "$D" ]; then echo "  目录不存在，跳过"; continue; fi
    ENV_FILE="$D/.env"
    if [ ! -f "$ENV_FILE" ]; then echo "  缺少 $ENV_FILE"; continue; fi

    SECRET=$(grep -E '^[[:space:]]*COOKIE_SECRET=' "$ENV_FILE" | head -n1 | cut -d= -f2-)
    if [ -n "$SECRET" ]; then
        echo "  COOKIE_SECRET : 长度 ${#SECRET} / sha256 前缀 $(printf '%s' "$SECRET" | sha256sum | cut -c1-12)"
    else
        echo "  COOKIE_SECRET : 未设置（生产环境必须设置）"
    fi

    OTHERS=$(grep -E '^[[:space:]]*[A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASS|KEY|SALT)[A-Za-z0-9_]*=' "$ENV_FILE" | cut -d= -f1 | tr -d ' ' | grep -v '^COOKIE_SECRET$' | paste -sd, -)
    echo "  其它疑似密钥  : ${OTHERS:-（无）}"

    PORT=$(grep -E '^[[:space:]]*PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d ' ')
    echo "  PORT         : ${PORT:-（未设置，默认 8080）}"
    echo "  依赖         : node=$(command -v node || echo 无) openssl=$(command -v openssl || echo 无) curl=$(command -v curl || echo 无) sha256sum=$(command -v sha256sum || echo 无)"
    echo "  数据文件     : users.json=$([ -f "$D/content/data/users.json" ] && echo 存在 || echo 缺失)  sessions.json=$([ -f "$D/content/data/sessions.json" ] && echo 存在 || echo 缺失)"
    echo "  分析盐         : $([ -f "$D/content/data/analytics/salt.txt" ] && echo 存在 || echo 缺失)"
    if command -v pm2 >/dev/null 2>&1; then
        echo "  pm2          : $(pm2 list 2>/dev/null | grep -i aether | head -n3 | tr -s ' ' | tr '\n' '|')"
    else
        echo "  pm2          : 未安装"
    fi
    if command -v tmux >/dev/null 2>&1; then
        echo "  tmux 会话    : $(tmux ls 2>/dev/null | tr '\n' '|' || echo 无)"
    else
        echo "  tmux         : 未安装"
    fi
    if command -v curl >/dev/null 2>&1; then
        P=${PORT:-8080}
        echo "  本机复核     : / -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$P/")  /.env -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$P/.env")  /content/data/users.json -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$P/content/data/users.json")"
    fi
done
echo ""
echo "RESULT: CHECK DONE（未做任何修改）"
exit 0
'@

$remoteTemplate = @'
set -u
STAMP="__STAMP__"
TAG="__TAG__"
BACKUP_ROOT="$HOME/.aether-security-backups/$TAG"
DO_SECRET="__DO_SECRET__"
DO_PASSWORD="__DO_PASSWORD__"
DO_SALT="__DO_SALT__"
CLEAR_SESSIONS="__CLEAR_SESSIONS__"
RESTART_CMD="__RESTART__"
ADMIN_USER="__ADMIN_USER__"
ADMIN_PASS="__ADMIN_PASS__"
RESET_TOOL="__RESET_TOOL__"

mkdir -p "$BACKUP_ROOT"
FAILED=0

fingerprint() {
    # 只输出长度与哈希前缀，绝不输出密钥本身
    printf '%s' "$1" | sha256sum | cut -c1-12
}

for D in __INSTANCES__; do
    echo ""
    echo "=== $D ==="
    if [ ! -d "$D" ]; then
        echo "  ERROR: 目录不存在，跳过"
        FAILED=1
        continue
    fi
    cd "$D" || { echo "  ERROR: 无法进入目录"; FAILED=1; continue; }
    NAME=$(basename "$D")
    ENV_FILE="$D/.env"
    if [ ! -f "$ENV_FILE" ]; then
        echo "  ERROR: 缺少 $ENV_FILE"
        FAILED=1
        continue
    fi

    # ---- 记录 .env 里其它疑似密钥的键名（值不外泄）----
    OTHER_KEYS=$(grep -E '^[[:space:]]*[A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASS|KEY|SALT)[A-Za-z0-9_]*=' "$ENV_FILE" | cut -d= -f1 | tr -d ' ' | grep -v '^COOKIE_SECRET$' | paste -sd, -)
    [ -n "$OTHER_KEYS" ] && echo "  其它疑似密钥（键名，需人工评估是否也泄露过）: $OTHER_KEYS"

    # ---- 1) 轮换 COOKIE_SECRET ----
    if [ "$DO_SECRET" = "1" ]; then
        OLD=$(grep -E '^[[:space:]]*COOKIE_SECRET=' "$ENV_FILE" | head -n1 | cut -d= -f2-)
        cp -p "$ENV_FILE" "$BACKUP_ROOT/$NAME.env.bak"
        if [ -n "$OLD" ]; then
            OLD_FP=$(fingerprint "$OLD")
            OLD_LEN=${#OLD}
        else
            OLD_FP="(未设置)"
            OLD_LEN=0
        fi

        NEW=$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))' 2>/dev/null)
        if [ -z "$NEW" ]; then
            NEW=$(openssl rand -hex 48 2>/dev/null)
        fi
        if [ -z "$NEW" ]; then
            echo "  ERROR: 无法生成新密钥（node 与 openssl 都不可用）"
            FAILED=1
            continue
        fi

        MODE=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '600')
        TMP_ENV="$ENV_FILE.aether-new.$$"
        awk '!/^[[:space:]]*#?[[:space:]]*COOKIE_SECRET=/' "$ENV_FILE" > "$TMP_ENV" || { echo "  ERROR: awk 处理失败"; FAILED=1; continue; }
        printf 'COOKIE_SECRET=%s\n' "$NEW" >> "$TMP_ENV"
        mv "$TMP_ENV" "$ENV_FILE"
        chmod "$MODE" "$ENV_FILE" 2>/dev/null || true

        NEW_FP=$(fingerprint "$NEW")
        echo "  COOKIE_SECRET: 旧长度 $OLD_LEN / 指纹 $OLD_FP  ->  新长度 ${#NEW} / 指纹 $NEW_FP"
        echo "  备份: $BACKUP_ROOT/$NAME.env.bak"
        unset OLD NEW
    else
        echo "  COOKIE_SECRET: 跳过"
    fi

    # ---- 1b) 轮换统计盐值（可选）----
    if [ "$DO_SALT" = "1" ]; then
        ENV_SALT=$(grep -E '^[[:space:]]*ANALYTICS_SALT=' "$ENV_FILE" | head -n1 | cut -d= -f2-)
        NEW_SALT=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' 2>/dev/null)
        [ -z "$NEW_SALT" ] && NEW_SALT=$(openssl rand -hex 32 2>/dev/null)
        if [ -n "$ENV_SALT" ]; then
            if [ -z "$NEW_SALT" ]; then
                echo "  ERROR: 无法生成新盐值"
                FAILED=1
            else
                MODE=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '600')
                TMP_ENV="$ENV_FILE.aether-salt.$$"
                awk '!/^[[:space:]]*#?[[:space:]]*ANALYTICS_SALT=/' "$ENV_FILE" > "$TMP_ENV"
                printf 'ANALYTICS_SALT=%s\n' "$NEW_SALT" >> "$TMP_ENV"
                mv "$TMP_ENV" "$ENV_FILE"
                chmod "$MODE" "$ENV_FILE" 2>/dev/null || true
                echo "  统计盐值: .env 中的 ANALYTICS_SALT 已轮换（指纹 $(fingerprint "$NEW_SALT")）"
            fi
        else
            SALT_FILE="$D/content/data/analytics/salt.txt"
            if [ -f "$SALT_FILE" ]; then
                cp -p "$SALT_FILE" "$BACKUP_ROOT/$NAME.salt.txt.bak"
                rm -f "$SALT_FILE"
                echo "  统计盐值: salt.txt 已移除（重启后自动生成新盐），备份在 $BACKUP_ROOT/$NAME.salt.txt.bak"
            else
                echo "  统计盐值: 没有 salt.txt，跳过"
            fi
        fi
        unset ENV_SALT NEW_SALT
    fi

    # ---- 2) 重置管理员口令 + 清空会话 ----
    if [ "$DO_PASSWORD" = "1" ]; then
        mkdir -p "$D/tools"
        cp -f "$RESET_TOOL" "$D/tools/reset-admin-password.mjs"
        ARGS="--username $ADMIN_USER --data-dir $D/content/data"
        [ "$CLEAR_SESSIONS" = "1" ] && ARGS="$ARGS --clear-sessions"
        if AE_NEW_PASSWORD="$ADMIN_PASS" node "$D/tools/reset-admin-password.mjs" $ARGS; then
            echo "  管理员口令已重置"
        else
            echo "  ERROR: 口令重置失败"
            FAILED=1
        fi
    else
        echo "  管理员口令: 跳过"
    fi

    # ---- 3) 重启 ----
    if [ -n "$RESTART_CMD" ]; then
        echo "  重启: $RESTART_CMD"
        ( cd "$D" && eval "$RESTART_CMD" ) || echo "  重启命令返回非零（请手动确认）"
        sleep 3
    else
        echo "  重启: 跳过（新 COOKIE_SECRET 需重启后生效）"
    fi

    # ---- 4) 复核 ----
    PORT=$(grep -E '^[[:space:]]*PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d ' ')
    [ -z "$PORT" ] && PORT=8080
    if command -v curl >/dev/null 2>&1; then
        ENV_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT/.env")
        HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT/")
        USERS_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$PORT/content/data/users.json")
        echo "  复核(端口 $PORT): / -> $HOME_CODE   /.env -> $ENV_CODE   /content/data/users.json -> $USERS_CODE"
        [ "$ENV_CODE" = "404" ] || { echo "  WARNING: /.env 未返回 404！"; FAILED=1; }
        [ "$HOME_CODE" = "200" ] || echo "  WARNING: 首页未返回 200（若未重启，可能是旧进程仍在运行）"
    else
        echo "  复核: 未找到 curl，跳过"
    fi
done

echo ""
echo "备份目录（服务器上）: $BACKUP_ROOT"
if [ "$FAILED" = "0" ]; then echo "RESULT: OK"; else echo "RESULT: 有实例存在问题，请查看上方输出"; fi
exit $FAILED
'@

if ($CheckOnly) {
    # 只读体检：只替换实例列表，其余动态值都不需要
    $remoteScript = $checkTemplate.Replace('__INSTANCES__', ($Instances -join ' '))
} else {
    $remoteScript = $remoteTemplate
    $remoteScript = $remoteScript.Replace('__STAMP__', $stamp)
    $remoteScript = $remoteScript.Replace('__TAG__', $tag)
    $remoteScript = $remoteScript.Replace('__INSTANCES__', ($Instances -join ' '))
    $remoteScript = $remoteScript.Replace('__DO_SECRET__', $(if ($SkipSecret) { '0' } else { '1' }))
    $remoteScript = $remoteScript.Replace('__DO_PASSWORD__', $(if ($SkipPassword) { '0' } else { '1' }))
    $remoteScript = $remoteScript.Replace('__DO_SALT__', $(if ($RotateAnalyticsSalt) { '1' } else { '0' }))
    $remoteScript = $remoteScript.Replace('__CLEAR_SESSIONS__', $(if ($KeepSessions) { '0' } else { '1' }))
    $remoteScript = $remoteScript.Replace('__RESTART__', $RestartCommand)
    $remoteScript = $remoteScript.Replace('__ADMIN_USER__', $AdminUser)
    $remoteScript = $remoteScript.Replace('__ADMIN_PASS__', $AdminPasswordBash)
    $remoteScript = $remoteScript.Replace('__RESET_TOOL__', "/tmp/$tag-reset-admin-password.mjs")
}
$remoteScript = $remoteScript -replace "`r`n", "`n"   # bash 不接受 CRLF

if ($ShowRemoteScript) {
    Write-Host ''
    Write-Host '--- 将在服务器上执行的 bash 脚本 ---' -ForegroundColor Yellow
    Write-Host $remoteScript
    exit 0
}

if ($DryRun -and -not $CheckOnly) {
    Write-Host ''
    Write-Host '--- DryRun：不会上传也不会修改服务器 ---' -ForegroundColor Yellow
    Write-Host '将上传：'
    Write-Host ("  {0}" -f (Join-Path $PSScriptRoot 'reset-admin-password.mjs'))
    Write-Host '将执行（远端）：'
    Write-Host '  1) 备份各实例 .env 到 ~/.aether-security-backups/'
    Write-Host '  2) 生成新的 COOKIE_SECRET 并写回 .env（保留权限位）'
    Write-Host '  3) 重置管理员口令并（默认）清空 sessions.json'
    Write-Host '  4) 执行重启命令并复核 /.env 是否 404'
    Write-Host ("新口令（本次 DryRun 生成，正式执行时会重新生成）：{0}" -f $AdminPassword)
    Write-Host ''
    Write-Host '想先看完整远端脚本请加 -ShowRemoteScript。'
    exit 0
}

# ---------------------------------------------------------------------------
# 2. 上传并执行
# ---------------------------------------------------------------------------
$localResetTool = Join-Path $PSScriptRoot 'reset-admin-password.mjs'
$remoteToolName = "$tag-reset-admin-password.mjs"
$localRemoteScript = Join-Path $env:TEMP "$tag-remote.sh"
$remoteScriptName = "$tag-remote.sh"

[System.IO.File]::WriteAllText($localRemoteScript, $remoteScript, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
if ($CheckOnly) {
    Write-Host '--- 上传体检脚本（需输入一次服务器密码）---' -ForegroundColor Cyan
    & scp $localRemoteScript "${Server}:/tmp/"
} else {
    Write-Host '--- 上传（需输入一次服务器密码）---' -ForegroundColor Cyan
    & scp $localResetTool "${Server}:/tmp/$remoteToolName"
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'scp 上传重置工具失败。' -ForegroundColor Red
        exit $LASTEXITCODE
    }
    & scp $localRemoteScript "${Server}:/tmp/"
}
if ($LASTEXITCODE -ne 0) {
    Write-Host 'scp 上传远端脚本失败。' -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ''
Write-Host '--- 远端执行（需再输入一次服务器密码）---' -ForegroundColor Cyan
if ($CheckOnly) {
    & ssh $Server "bash /tmp/$remoteScriptName; rc=`$?; rm -f /tmp/$remoteScriptName; exit `$rc"
} else {
    & ssh $Server "bash /tmp/$remoteScriptName; rc=`$?; rm -f /tmp/$remoteScriptName /tmp/$remoteToolName; exit `$rc"
}
$remoteExit = $LASTEXITCODE

Remove-Item -LiteralPath $localRemoteScript -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($CheckOnly) {
    if ($remoteExit -eq 0) { Write-Host '体检完成（服务器上未做任何修改）。' -ForegroundColor Green } else { Write-Host ("远端返回非零（{0}）。" -f $remoteExit) -ForegroundColor Red }
    Write-Host ''
    Write-Host '根据体检结果决定下一步：' -ForegroundColor Cyan
    Write-Host '  - 若走 pm2：   .\tools\rotate-security.ps1 -RestartCommand ''pm2 restart all'''
    Write-Host '  - 若走 tmux：  .\tools\rotate-security.ps1 -RestartCommand ''true''，随后按体检里列出的会话名重启：'
    Write-Host '      tmux kill-session -t <会话>; tmux new-session -d -s <会话> -c <实例目录> ''node index.js'''
    Write-Host ''
    exit $remoteExit
}

Write-Host ''
if ($remoteExit -eq 0) {
    Write-Host '安全收尾完成。' -ForegroundColor Green
} else {
    Write-Host ("远端返回非零（{0}），请检查上方输出。" -f $remoteExit) -ForegroundColor Red
}

if (-not $SkipPassword) {
    Write-Host ''
    Write-Host '=== 新的管理员口令（只显示这一次，请立刻保存）===' -ForegroundColor Yellow
    Write-Host ("  账号: {0}" -f $AdminUser) -ForegroundColor Yellow
    Write-Host ("  口令: {0}" -f $AdminPassword) -ForegroundColor Yellow
    Write-Host '  提示：口令已写入各实例 content/data/users.json（旧文件已备份为 users.json.bak-*）'
    Write-Host '  请立刻登录 /aether 验证一次，确认能用新口令进入后台。'
}

Write-Host ''
Write-Host '--- 仍需人工处理 ---' -ForegroundColor Cyan
Write-Host '  1. 部署最新代码后确认线上 /.env、/content/data/users.json、/core/app.js 均为 404：'
Write-Host '     curl -s -o /dev/null -w "%{http_code}\n" https://xl.dleu.net/.env   # 期望 404'
Write-Host '  2. 如 .env 里还有其它密钥（脚本已列出键名），按需一并轮换'
Write-Host '  3. 建议在 nginx 层再加一道 deny 兜底（见 README 部署章节）'
Write-Host '  4. 到 https://github.com/settings/tokens 检查/吊销可能泄露的令牌（若 .env 中曾存放）'
Write-Host ''
