# 回滚「老师头像」这次改动（2026-11-10）
#
# 用法（在 persona-router 目录下）：
#   pwsh -File .\tools\rollback-user-avatar.ps1
#
# 它做两件事：把 plugin/index.js 与 plugin/client.js 还原成改动前的备份。
# 备份是这次动手前存的：
#   backups/index.js.bak-20261110
#   backups/client.js.bak-20261110
#
# 回滚之后还要手动做两步（脚本不替你做，因为都要经过 UI）：
#   1. 设置 →「人格路由」这一行关掉再打开（宿主半不热重载）
#   2. 刷新页面（客户端半要重新加载）
#
# 只想「关掉功能」而不改代码的话，有更轻的一条：
#   删掉 ~\.dsh\persona-router\user-avatar.* 即可 —— 没图时客户端一个节点都不画，
#   壁纸引擎自己的头像照常显示，等于这个功能不存在。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pairs = @(
  @{ backup = 'backups\index.js.bak-20261110';  target = 'plugin\index.js' },
  @{ backup = 'backups\client.js.bak-20261110'; target = 'plugin\client.js' }
)

foreach ($pair in $pairs) {
  $from = Join-Path $root $pair.backup
  $to = Join-Path $root $pair.target
  if (-not (Test-Path $from)) {
    Write-Host "缺少备份：$from" -ForegroundColor Red
    exit 1
  }
  Copy-Item $from $to -Force
  Write-Host "已还原 $($pair.target)"
}

Write-Host ''
Write-Host '回滚完成。还需要两步：' -ForegroundColor Green
Write-Host '  1. 设置 →「人格路由」关掉再打开（宿主半不热重载）'
Write-Host '  2. 刷新页面'
