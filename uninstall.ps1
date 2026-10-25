# 移除 Windows 程序、登录启动和运行地址，保留用户数据与环境配置。
#
# Kept intact (survives uninstall — preserves data for reinstall):
#   - ~/.pi/agent/pi-web.sqlite          (共享确认、设置和通知)
#   - ~/.pi/agent/pi-web-memory.sqlite   (memory skill data)
#   - ~/.config/pi-web/env               (token, proxy, service settings)
#   - ~/.pi/agent/sessions/              (session files)

$ErrorActionPreference = 'Continue'

if ($env:PI_WEB_INSTALL_DIR) {
  $Binary = Join-Path $env:PI_WEB_INSTALL_DIR 'pi-web.exe'
} else {
  $Binary = Join-Path $HOME '.pi\agent\bin\pi-web.exe'
}
$ConfigDir = Join-Path $HOME '.config\pi-web'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Info($msg) { Write-Host "-> $msg" }
function Skip($msg) { Write-Host "   (skipped) $msg" }

Write-Host ''
Info 'pi-web uninstaller (Windows)'
Write-Host ''

# Stop running instance
$proc = Get-Process -Name 'pi-web' -ErrorAction SilentlyContinue
if ($proc) {
  Info 'Stopping running pi-web instance...'
  $proc | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# Remove binary (and any leftover from a previous swap)
if (Test-Path -LiteralPath $Binary) {
  Info "Removing binary: $Binary"
  Remove-Item -LiteralPath $Binary -Force -ErrorAction SilentlyContinue
} else {
  Skip "binary not found at $Binary"
}
Get-ChildItem -LiteralPath (Split-Path $Binary) -Filter 'pi-web.exe.old*' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

# Remove runtime state
$stateFile = Join-Path $HOME '.pi\agent\pi-web\pi-web-state.json'
if (Test-Path -LiteralPath $stateFile) {
  Info "Removing state file: $stateFile"
  Remove-Item -LiteralPath $stateFile -Force
} else {
  Skip 'state file not found'
}
$stateDir = Join-Path $HOME '.pi\agent\pi-web'
if ((Test-Path -LiteralPath $stateDir) -and -not (Get-ChildItem -LiteralPath $stateDir)) {
  Remove-Item -LiteralPath $stateDir -Force
}

# Remove auto-start (Run key + hidden launcher; the env file is kept)
Remove-ItemProperty -Path $RunKey -Name 'pi-web' -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $ConfigDir 'pi-web-start.ps1') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $ConfigDir 'pi-web-start.vbs') -Force -ErrorAction SilentlyContinue
Info 'Removed Windows auto-start (Run key + launcher)'

Info 'pi-web service and binary removed.'
Info 'Data preserved: ~/.pi/agent/pi-web.sqlite, ~/.pi/agent/pi-web-memory.sqlite, ~/.config/pi-web/env'
Write-Host ''
