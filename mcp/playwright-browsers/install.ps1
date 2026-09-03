# playwright-browsers 安装脚本（Windows）
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallDir <dir>] [-WithFirefox]
param(
  [string]$InstallDir = "$env:USERPROFILE\.dsh\mcp\playwright",
  [switch]$WithFirefox,
  [switch]$SkipBrowsers
)
$ErrorActionPreference = 'Stop'
Write-Host "[1/3] npm install @playwright/mcp -> $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if (-not (Test-Path "$InstallDir\package.json")) { npm init -y | Out-Null }
Set-Location $InstallDir
npm install @playwright/mcp --no-audit --no-fund
Write-Host "[2/3] 浏览器准备"
if ($SkipBrowsers) { Write-Host "  (跳过浏览器准备 -> 直接使用系统 Chrome/Edge)" }
else {
  Write-Host "  Chrome/Edge: 使用系统安装（无需下载）"
  if ($WithFirefox) { Write-Host "  下载 Playwright Firefox..." ; npx playwright install firefox }
  else { Write-Host "  Firefox 支持可选: 重跑本脚本加 -WithFirefox" }
}
Write-Host "[3/3] 完成。接入片段见 cordis-patch.yaml（替换 <KIT> 为 $InstallDir 的父级或目标位置）"
