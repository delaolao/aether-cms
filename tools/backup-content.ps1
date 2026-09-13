<#
.SYNOPSIS
    内容备份与恢复：把各实例的 content/data（文章、页面、用户、设置、统计）与
    content/uploads（图片、附件）打包拉回本机留档，并支持校验与恢复。

.DESCRIPTION
    为什么需要它：content/data 与 content/uploads 既不在 git 里（.gitignore 排除），
    也不在同步脚本的备份范围内（同步脚本只备份它自己覆盖的代码文件）。也就是说
    文章与全部媒体目前是**单点**：服务器磁盘故障 / 误删 = 内容全丢。

    本脚本做三件事：
      1. 服务器上打包 → scp 拉回本机（异地副本），同时生成 manifest（文件数、字节数、
         归档 sha256），本机再复算一次 sha256 做端到端校验；
      2. -Verify：只清点+比对，不打包，用来确认线上与最近一次备份是否一致；
      3. -Restore：把指定归档上传并解包覆盖（解包前自动再做一次「恢复前备份」）。

.PARAMETER Server
    目标服务器（默认 admin@100.66.18.125）。

.PARAMETER Instances
    实例目录列表（默认三个实例）。

.PARAMETER Destination
    本机留档目录（默认 $env:USERPROFILE\aether-content-backups）。

.PARAMETER Keep
    -Prune 时每个实例保留最近几份归档（默认 14）。

.PARAMETER IncludeAnalytics
    连 content/data/analytics 的明细 JSONL 一起打包（默认排除，明细可由 summary 重建且体积会持续增长）。

.PARAMETER Prune
    真正删除超出 Keep 的旧归档（默认只提示不删除）。

.PARAMETER Verify
    只做清点与比对（与最近一次本机备份比较文件数/字节数），**不在服务器上打包**。

.PARAMETER LocalOnly
    完全不连服务器：只对留档目录里已有的备份做本机校验、对比与保留策略（用于事后核对）。

.PARAMETER DryRun
    只打印计划，不连服务器。

.PARAMETER ShowRemoteScript
    打印将在服务器上执行的 bash 脚本后退出。

.PARAMETER Restore
    恢复模式：配合 -Instance 与 -Archive 使用。

.PARAMETER Instance / Archive
    恢复目标实例目录 / 本机归档路径（.tgz）。

.EXAMPLE
    # 先看计划
    .\tools\backup-content.ps1 -DryRun

.EXAMPLE
    # 正式备份（scp 一次 + ssh 一次，各需输入一次服务器密码）
    .\tools\backup-content.ps1

.EXAMPLE
    # 确认线上内容与最近一次备份一致（不打包）
    .\tools\backup-content.ps1 -Verify

.EXAMPLE
    # 恢复：把本机归档解包回某个实例（解包前会自动再备份一次当前内容）
    .\tools\backup-content.ps1 -Restore -Instance '/data/te_se_zi_yuan/xl/aether-cms' -Archive 'D:\aether-content-backups\xl-aether-cms-20260913-190000.tgz'

.NOTES
    服务器端每晚自动快照（可选，加进 crontab 即可，与上面的异地拉取互补）：
      0 3 * * * cd $HOME && for D in /home/admin/aether-cms /data/te_se_zi_yuan/xl/aether-cms /data/te_se_zi_yuan/xq/aether-cms; do N=$(basename $D); mkdir -p $HOME/aether-content-backups; tar -czf $HOME/aether-content-backups/content-$N-$(date +\%Y\%m\%d).tgz -C $D content/data content/uploads; done; find $HOME/aether-content-backups -name 'content-*.tgz' -mtime +14 -delete
#>

[CmdletBinding()]
param(
    [string]$Server = 'admin@100.66.18.125',
    [string[]]$Instances = @(
        '/home/admin/aether-cms',
        '/data/te_se_zi_yuan/xl/aether-cms',
        '/data/te_se_zi_yuan/xq/aether-cms'
    ),
    [string]$Destination = (Join-Path $env:USERPROFILE 'aether-content-backups'),
    [int]$Keep = 14,
    [switch]$IncludeAnalytics,
    [switch]$Prune,
    [switch]$Verify,
    [switch]$LocalOnly,
    [switch]$DryRun,
    [switch]$ShowRemoteScript,
    [switch]$Restore,
    [string]$Instance = '',
    [string]$Archive = ''
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tag = "aether-content-$stamp"
$remoteExit = 0

if ($Restore) {
    if (-not $Instance -or -not $Archive) {
        Write-Host '-Restore 需要同时提供 -Instance <实例目录> 与 -Archive <本机 tgz 路径>。' -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path $Archive)) {
        Write-Host ("找不到归档: {0}" -f $Archive) -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path $Destination)) {
    if ($DryRun -or $ShowRemoteScript) {
        Write-Host ("留档目录尚不存在，正式执行时会创建: {0}" -f $Destination) -ForegroundColor Yellow
    } else {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }
}

Write-Host ''
Write-Host '=== Aether CMS 内容备份 ===' -ForegroundColor Cyan
Write-Host ("目标服务器 : {0}" -f $Server)
Write-Host ("留档目录   : {0}" -f $Destination)
if ($Restore) {
    Write-Host ("模式       : 恢复（{0}  ←  {1}）" -f $Instance, $Archive) -ForegroundColor Yellow
} elseif ($LocalOnly) {
    Write-Host ("模式       : 仅本机校验（-LocalOnly，完全不连服务器）") -ForegroundColor Yellow
} elseif ($Verify) {
    Write-Host ("模式       : 校验（只清点比对，不打包）")
} else {
    Write-Host ("模式       : 备份（含 {0} 个实例）" -f $Instances.Count)
    foreach ($i in $Instances) { Write-Host ("             - {0}" -f $i) }
}
Write-Host ("统计明细       : {0}" -f $(if ($IncludeAnalytics) { '包含（体积会较大）' } else { '排除 views-*.jsonl（summary.json 仍会备份）' }))
Write-Host ("保留策略       : 每个实例保留最近 {0} 份{1}" -f $Keep, $(if ($Prune) { '（并删除多余）' } else { '（只提示，-Prune 才删除）' }))

# ---------------------------------------------------------------------------
# 远端 bash 脚本
# ---------------------------------------------------------------------------
$remoteTemplate = @'
set -u
STAMP="__STAMP__"
TAG="__TAG__"
REMOTE_ROOT="$HOME/aether-content-backups"
TAG_DIR="$REMOTE_ROOT/$TAG"
DO_RESTORE="__DO_RESTORE__"
RESTORE_DIR="__RESTORE_DIR__"
RESTORE_ARCHIVE="__RESTORE_ARCHIVE__"
INCLUDE_ANALYTICS="__INCLUDE_ANALYTICS__"
DO_ARCHIVE="__DO_ARCHIVE__"
FAILED=0

mkdir -p "$REMOTE_ROOT"

count_files() { if [ -d "$1" ]; then find "$1" -type f 2>/dev/null | wc -l; else echo 0; fi }
dir_bytes() { if [ -d "$1" ]; then du -sb "$1" 2>/dev/null | cut -f1; else echo 0; fi }
human() { echo "$1" | awk '{ if ($1 >= 1073741824) printf "%.2f GB", $1/1073741824; else if ($1 >= 1048576) printf "%.1f MB", $1/1048576; else printf "%.0f KB", $1/1024 }'; }

if [ "$DO_RESTORE" = "1" ]; then
    echo "=== 恢复: $RESTORE_DIR  <==  $RESTORE_ARCHIVE ==="
    if [ ! -d "$RESTORE_DIR" ]; then echo "  ERROR: 实例目录不存在"; exit 1; fi
    if [ ! -f "$RESTORE_ARCHIVE" ]; then echo "  ERROR: 归档不存在"; exit 1; fi
    PRE="$REMOTE_ROOT/prerestore-$(echo "$RESTORE_DIR" | sed 's#^/##; s#/#-#g')-$STAMP.tgz"
    if tar -czf "$PRE" -C "$RESTORE_DIR" content/data content/uploads 2>/dev/null; then
        echo "  恢复前备份: $PRE ($(human $(stat -c '%s' "$PRE")))"
    else
        echo "  ERROR: 恢复前备份失败，已中止（内容未被改动）"
        exit 1
    fi
    if tar -xzf "$RESTORE_ARCHIVE" -C "$RESTORE_DIR"; then
        echo "  已解包到 $RESTORE_DIR"
        echo "  清点: 文章 $(count_files "$RESTORE_DIR/content/data/posts") / 页面 $(count_files "$RESTORE_DIR/content/data/pages") / 上传 $(count_files "$RESTORE_DIR/content/uploads")"
    else
        echo "  ERROR: 解包失败（内容可能只恢复了一部分，请检查后用 $PRE 回滚）"
        exit 1
    fi
    echo ""
    echo "  接下来请重启该实例：tmux send-keys -t <会话号> C-c; tmux send-keys -t <会话号> 'npm start' Enter"
    echo "  （会话号：0 = /home/admin/aether-cms，10 = xl，11 = xq）"
    echo "RESULT: RESTORE DONE"
    exit 0
fi

mkdir -p "$TAG_DIR"

for D in __INSTANCES__; do
    echo ""
    echo "=== $D ==="
    if [ ! -d "$D" ]; then echo "  ERROR: 目录不存在，跳过"; FAILED=1; continue; fi
    # 三个实例目录都叫 aether-cms，用 basename 会让归档与 manifest 互相覆盖：
    # 统一用「去掉开头斜杠、把 / 换成 -」的完整路径作为唯一键。
    NAME=$(echo "$D" | sed 's#^/##; s#/#-#g')
    BASE=$(basename "$D")
    DATA="$D/content/data"
    UPLOADS="$D/content/uploads"
    if [ ! -d "$DATA" ]; then echo "  ERROR: 缺少 $DATA"; FAILED=1; continue; fi

    POSTS=$(count_files "$DATA/posts")
    PAGES=$(count_files "$DATA/pages")
    CUSTOM=$(count_files "$DATA/custom")
    UPLOAD_FILES=$(count_files "$UPLOADS")
    DATA_BYTES=$(dir_bytes "$DATA")
    UPLOAD_BYTES=$(dir_bytes "$UPLOADS")
    echo "  清点: 文章 $POSTS / 页面 $PAGES / 自定义 $CUSTOM / 上传文件 $UPLOAD_FILES"
    echo "  体积: data $(human "$DATA_BYTES")  uploads $(human "$UPLOAD_BYTES")"
    echo "  settings.json=$([ -f "$DATA/settings.json" ] && echo 有 || echo 无) users.json=$([ -f "$DATA/users.json" ] && echo 有 || echo 无) analytics=$([ -d "$DATA/analytics" ] && echo 有 || echo 无)"
    if [ "$INCLUDE_ANALYTICS" = "1" ]; then
        echo "  统计明细: 包含"
    else
        echo "  统计明细: 排除 views-*.jsonl"
    fi

    ARCHIVE="$TAG_DIR/content-$NAME-$STAMP.tgz"
    MEMBERS="content/data"
    [ -d "$UPLOADS" ] && MEMBERS="$MEMBERS content/uploads"
    EXCLUDES=""
    [ "$INCLUDE_ANALYTICS" = "1" ] || EXCLUDES="--exclude=content/data/analytics/views-*.jsonl"

    if [ "$DO_ARCHIVE" = "1" ]; then
        if tar -czf "$ARCHIVE" $EXCLUDES -C "$D" $MEMBERS 2>/dev/null; then
            BYTES=$(stat -c '%s' "$ARCHIVE")
            SHA=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
            ENTRIES=$(tar -tzf "$ARCHIVE" | wc -l)
            echo "  归档: $(basename "$ARCHIVE")  $(human "$BYTES")  sha256=${SHA:0:16}…  $ENTRIES 条目"
        else
            echo "  ERROR: 打包失败"
            FAILED=1
            continue
        fi
        MANIFEST="$TAG_DIR/content-$NAME-$STAMP.manifest.json"
        ARCHIVE_NAME="$(basename "$ARCHIVE")"
    else
        echo "  校验模式: 不打包，仅清点"
        BYTES=0
        SHA=""
        ENTRIES=0
        ARCHIVE_NAME=""
        MANIFEST="$TAG_DIR/verify-$NAME-$STAMP.manifest.json"
    fi

    # manifest：本机再复算 sha256 与 tar 条目数，做端到端校验
    printf '{\n  "instance": "%s",\n  "name": "%s",\n  "basename": "%s",\n  "stamp": "%s",\n  "mode": "%s",\n  "archive": "%s",\n  "archiveBytes": %s,\n  "archiveSha256": "%s",\n  "archiveEntries": %s,\n  "counts": { "posts": %s, "pages": %s, "custom": %s, "uploads": %s },\n  "bytes": { "data": %s, "uploads": %s },\n  "includeAnalytics": %s\n}\n' \
        "$D" "$NAME" "$BASE" "$STAMP" "$([ "$DO_ARCHIVE" = "1" ] && echo backup || echo verify)" "$ARCHIVE_NAME" "$BYTES" "$SHA" "$ENTRIES" \
        "$POSTS" "$PAGES" "$CUSTOM" "$UPLOAD_FILES" "$DATA_BYTES" "$UPLOAD_BYTES" \
        "$([ "$INCLUDE_ANALYTICS" = "1" ] && echo true || echo false)" > "$MANIFEST"
    echo "  实例键: $NAME（目录名 $BASE）"
    echo "  manifest: $(basename "$MANIFEST")"
done

echo ""
echo "MANIFEST_DIR: $TAG_DIR"
if [ "$FAILED" = "0" ]; then echo "RESULT: OK"; else echo "RESULT: 有实例处理失败，请看上方输出"; fi
exit $FAILED
'@

$remoteScript = $remoteTemplate
$remoteScript = $remoteScript.Replace('__STAMP__', $stamp)
$remoteScript = $remoteScript.Replace('__TAG__', $tag)
$remoteScript = $remoteScript.Replace('__INSTANCES__', ($Instances -join ' '))
$remoteScript = $remoteScript.Replace('__INCLUDE_ANALYTICS__', $(if ($IncludeAnalytics) { '1' } else { '0' }))
$remoteScript = $remoteScript.Replace('__DO_ARCHIVE__', $(if ($Verify) { '0' } else { '1' }))
$remoteScript = $remoteScript.Replace('__DO_RESTORE__', $(if ($Restore) { '1' } else { '0' }))
$remoteScript = $remoteScript.Replace('__RESTORE_DIR__', $Instance)
$remoteScript = $remoteScript.Replace('__RESTORE_ARCHIVE__', $(if ($Restore) { "/tmp/$tag-$(Split-Path $Archive -Leaf)" } else { '' }))
$remoteScript = $remoteScript -replace "`r`n", "`n"   # bash 不接受 CRLF

if ($ShowRemoteScript) {
    Write-Host ''
    Write-Host '--- 将在服务器上执行的 bash 脚本 ---' -ForegroundColor Yellow
    Write-Host $remoteScript
    exit 0
}

if ($DryRun) {
    Write-Host ''
    Write-Host '--- DryRun：不会连服务器 ---' -ForegroundColor Yellow
    if ($Restore) {
        Write-Host ("将上传归档: {0}" -f $Archive)
        Write-Host ("将在服务器上执行: 先备份 {0}/content/data|uploads → prerestore-*.tgz，再解包覆盖" -f $Instance)
    } elseif ($Verify) {
        Write-Host '将在服务器上为每个实例执行: 只清点（不打包）→ 写 verify manifest'
        Write-Host '然后拉回本机与最近一次备份的文件数/字节数对比'
    } else {
        Write-Host '将在服务器上为每个实例执行: 清点 → tar 打包 content/data + content/uploads → 写 manifest'
        Write-Host '然后一次性 scp 拉回，本机复算 sha256 与 tar 条目数做校验，最后按保留策略提示（或 -Prune 删除）'
    }
    if ($LocalOnly) { Write-Host '-LocalOnly: 完全跳过服务器，只校验留档目录里已有的备份' -ForegroundColor Yellow }
    Write-Host ''
    Write-Host '想先看完整远端脚本请加 -ShowRemoteScript。'
    exit 0
}

# ---------------------------------------------------------------------------
# -LocalOnly：完全不连服务器，只校验已有的本机备份
# ---------------------------------------------------------------------------
if ($LocalOnly) {
    $localTagDir = (Get-ChildItem -Path $Destination -Directory | Where-Object { $_.Name -notlike '_verify*' } | Sort-Object Name -Descending | Select-Object -First 1).FullName
    if (-not $localTagDir) {
        Write-Host ("留档目录里没有任何备份: {0}" -f $Destination) -ForegroundColor Red
        exit 1
    }
    Write-Host ''
    Write-Host ("--- 本机校验（-LocalOnly，最新一份: {0}）---" -f $localTagDir) -ForegroundColor Cyan
} else {
    $localRemoteScript = Join-Path $env:TEMP "$tag-remote.sh"
    $remoteScriptName = "$tag-remote.sh"
    [System.IO.File]::WriteAllText($localRemoteScript, $remoteScript, (New-Object System.Text.UTF8Encoding($false)))

    # -----------------------------------------------------------------------
    # 上传脚本 / （恢复模式）上传归档
    # -----------------------------------------------------------------------
    if ($Restore) {
    Write-Host ''
    Write-Host '--- 上传归档与脚本（需输入一次服务器密码）---' -ForegroundColor Cyan
    & scp $Archive "${Server}:/tmp/$tag-$(Split-Path $Archive -Leaf)"
    if ($LASTEXITCODE -ne 0) { Write-Host 'scp 上传归档失败。' -ForegroundColor Red; exit $LASTEXITCODE }
    & scp $localRemoteScript "${Server}:/tmp/"
    if ($LASTEXITCODE -ne 0) { Write-Host 'scp 上传脚本失败。' -ForegroundColor Red; exit $LASTEXITCODE }

    Write-Host ''
    Write-Host '--- 远端执行恢复（需再输入一次服务器密码）---' -ForegroundColor Cyan
    & ssh $Server "bash /tmp/$remoteScriptName; rc=`$?; rm -f /tmp/$remoteScriptName; exit `$rc"
    $remoteExit = $LASTEXITCODE
    Remove-Item -LiteralPath $localRemoteScript -Force -ErrorAction SilentlyContinue
    Write-Host ''
    if ($remoteExit -eq 0) { Write-Host '恢复完成，别忘了重启对应实例。' -ForegroundColor Green } else { Write-Host ("远端返回非零（{0}）。" -f $remoteExit) -ForegroundColor Red }
    exit $remoteExit
    }

    Write-Host ''
    Write-Host '--- 上传脚本（需输入一次服务器密码）---' -ForegroundColor Cyan
    & scp $localRemoteScript "${Server}:/tmp/"
    if ($LASTEXITCODE -ne 0) { Write-Host 'scp 上传脚本失败。' -ForegroundColor Red; exit $LASTEXITCODE }

    Write-Host ''
    Write-Host '--- 远端打包（需再输入一次服务器密码）---' -ForegroundColor Cyan
    $remoteOutput = & ssh $Server "bash /tmp/$remoteScriptName; rc=`$?; rm -f /tmp/$remoteScriptName; exit `$rc"
    $remoteExit = $LASTEXITCODE
    $remoteOutput | ForEach-Object { Write-Host $_ }
    Remove-Item -LiteralPath $localRemoteScript -Force -ErrorAction SilentlyContinue

    $manifestDir = $null
    foreach ($lineText in $remoteOutput) {
        if ($lineText -match '^MANIFEST_DIR:\s*(.+)$') { $manifestDir = $Matches[1].Trim() }
    }
    if (-not $manifestDir) {
        Write-Host '未能从远端输出解析 MANIFEST_DIR，无法继续拉取（上面是远端完整输出）。' -ForegroundColor Red
        exit 1
    }

    # -----------------------------------------------------------------------
    # 拉回本机
    # -----------------------------------------------------------------------
    $localTagDir = Join-Path $Destination $stamp
    New-Item -ItemType Directory -Path $localTagDir -Force | Out-Null

    Write-Host ''
    Write-Host '--- 拉回本机（需再输入一次服务器密码）---' -ForegroundColor Cyan
    & scp -r "${Server}:${manifestDir}/*" $localTagDir
    if ($LASTEXITCODE -ne 0) { Write-Host 'scp 拉取失败。' -ForegroundColor Red; exit $LASTEXITCODE }
}

# ---------------------------------------------------------------------------
# 本机校验：sha256 + tar 条目数 + 清点
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '--- 本机校验 ---' -ForegroundColor Cyan
$results = @()
$manifests = Get-ChildItem -Path $localTagDir -Filter '*.manifest.json' -File
foreach ($manifestFile in $manifests) {
    $manifest = Get-Content -Raw -Path $manifestFile.FullName | ConvertFrom-Json
    $isVerifyRun = [string]$manifest.mode -eq 'verify' -or -not $manifest.archive
    $archivePath = if ($manifest.archive) { Join-Path $localTagDir $manifest.archive } else { '' }
    $row = [ordered]@{
        实例目录 = $manifest.instance
        归档     = $(if ($isVerifyRun) { '（校验模式，无归档）' } else { $manifest.archive })
        大小     = $(if ($isVerifyRun) { '-' } else { '{0:N1} MB' -f ($manifest.archiveBytes / 1MB) })
        文章     = $manifest.counts.posts
        上传     = $manifest.counts.uploads
        校验     = ''
    }
    if ($isVerifyRun) {
        $row.校验 = '已清点（未打包）'
    } elseif (-not (Test-Path $archivePath)) {
        $row.校验 = '归档缺失'
    } else {
        $hash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLower()
        if ($hash -ne $manifest.archiveSha256) {
            $row.校验 = 'sha256 不一致！'
        } else {
            $entries = (& tar.exe -tzf $archivePath | Measure-Object).Count
            if ($entries -ne [int]$manifest.archiveEntries) {
                $row.校验 = ('条目数不符 {0}/{1}' -f $entries, $manifest.archiveEntries)
            } else {
                $row.校验 = ('OK（{0} 条目）' -f $entries)
            }
        }
    }
    $results += [pscustomobject]$row
}

$results | Format-Table -AutoSize
$missing = $manifests.Count
Write-Host ("  本次拉回 {0} 个实例的 manifest（应与实例数一致；若偏少说明服务端归档被同名覆盖）" -f $missing)

# 与上一份 manifest 比对（-Verify 的核心）
$previous = Get-ChildItem -Path $Destination -Recurse -Filter '*.manifest.json' -File |
    Where-Object { $_.DirectoryName -ne $localTagDir } |
    Sort-Object LastWriteTime -Descending
if ($previous.Count -gt 0) {
    Write-Host '--- 与最近一次备份对比 ---' -ForegroundColor Cyan
    foreach ($manifestFile in $manifests) {
        $current = Get-Content -Raw -Path $manifestFile.FullName | ConvertFrom-Json
        $match = $previous | Where-Object { $_.Name -like "*$($current.name)*" } | Select-Object -First 1
        if (-not $match) { Write-Host ("  {0}: 没有可对比的历史备份（这是第一份）" -f $current.name); continue }
        $old = Get-Content -Raw -Path $match.FullName | ConvertFrom-Json
        $diffPosts = [int]$current.counts.posts - [int]$old.counts.posts
        $diffUploads = [int]$current.counts.uploads - [int]$old.counts.uploads
        Write-Host ("  {0}: 文章 {1} → {2}（{3:+#;-#;0}）  上传 {4} → {5}（{6:+#;-#;0}）  [对比 {7}]" -f `
            $current.name, $old.counts.posts, $current.counts.posts, $diffPosts, `
            $old.counts.uploads, $current.counts.uploads, $diffUploads, $match.Directory.Name)
    }
} else {
    Write-Host '  （这是本机第一份备份，没有可对比的历史）'
}

# ---------------------------------------------------------------------------
# 保留策略
# ---------------------------------------------------------------------------
if ($Prune) {
    Write-Host ''
    Write-Host '--- 保留策略（-Prune）---' -ForegroundColor Cyan
    $folders = Get-ChildItem -Path $Destination -Directory | Sort-Object Name -Descending
    $byInstance = @{}
    foreach ($folder in $folders) {
        foreach ($manifestFile in (Get-ChildItem -Path $folder.FullName -Filter '*.manifest.json' -File)) {
            $m = Get-Content -Raw -Path $manifestFile.FullName | ConvertFrom-Json
            if (-not $byInstance.ContainsKey($m.name)) { $byInstance[$m.name] = @() }
            $byInstance[$m.name] += $folder.FullName
        }
    }
    # 一个时间戳目录里含多个实例，同一目录可能被多个实例键同时判定为「过旧」，
    # 所以先汇总去重再删除，并跳过已被删掉的路径（否则 -ErrorAction Stop 会中断）。
    $toDelete = @()
    foreach ($name in $byInstance.Keys) {
        $dirs = $byInstance[$name] | Select-Object -Unique | Sort-Object -Descending
        if ($dirs.Count -gt $Keep) {
            $toDelete += $dirs[$Keep..($dirs.Count - 1)]
        } else {
            Write-Host ("  {0}: 当前 {1} 份，未超过 {2} 份" -f $name, $dirs.Count, $Keep)
        }
    }
    foreach ($old in ($toDelete | Select-Object -Unique)) {
        if (-not (Test-Path $old)) { continue }
        Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $old) {
            Write-Host ("  删除失败（请手动处理）: {0}" -f $old) -ForegroundColor Red
        } else {
            Write-Host ("  已删除旧备份目录: {0}" -f $old) -ForegroundColor Yellow
        }
    }
    if ($toDelete.Count -eq 0) { Write-Host '  无需清理。' }
} else {
    Write-Host ''
    Write-Host ("提示：本机留档目录会持续增长；需要自动清理超出的旧份数时加 -Prune（每个实例保留最近 {0} 份）。" -f $Keep) -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '--- 恢复怎么做 ---' -ForegroundColor Cyan
Write-Host ("  1) 从本机归档恢复某个实例（脚本会自动先备份当前内容）:")
Write-Host ("     .\tools\backup-content.ps1 -Restore -Instance '<实例目录>' -Archive '{0}\<实例名>-...tgz'" -f $localTagDir)
Write-Host '  2) 恢复后重启实例（tmux 会话 0 = /home/admin/aether-cms，10 = xl，11 = xq）:'
Write-Host "     tmux send-keys -t 10 C-c; tmux send-keys -t 10 'npm start' Enter"
Write-Host '  3) 服务器上还留有本次归档与 manifest，可用 tar -tzf 直接核对内容。'
Write-Host ''
if ($remoteExit -eq 0) { Write-Host '备份完成。' -ForegroundColor Green } else { Write-Host ("远端返回非零（{0}），请检查上面输出。" -f $remoteExit) -ForegroundColor Red }
