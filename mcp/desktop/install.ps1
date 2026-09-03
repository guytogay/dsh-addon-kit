# desktop MCP 安装脚本（Windows）
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1 [-TargetDir <dir>] [-VenvDir <dir>]
param(
  [string]$TargetDir = "$env:USERPROFILE\.dsh\mcp\desktop",
  [string]$VenvDir = "$TargetDir\.venv"
)
$ErrorActionPreference = 'Stop'
Write-Host "[1/3] 复制 server 文件 -> $TargetDir"
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item "$PSScriptRoot\desktop_server.py", "$PSScriptRoot\uia_helper.ps1" $TargetDir -Force
if (-not (Test-Path "$VenvDir\Scripts\python.exe")) {
  Write-Host "[2/3] 创建 venv ($VenvDir)"
  python -m venv $VenvDir
} else { Write-Host "[2/3] venv 已存在" }
Write-Host "[3/3] 安装依赖 (mcp<2 + mss)"
& "$VenvDir\Scripts\python.exe" -m pip install -q --disable-pip-version-check "mcp>=1.28,<2" mss
# 冒烟测试（可选）：& "$VenvDir\Scripts\python.exe" "$PSScriptRoot\..\..\_tests\desktop-smoke.py"
Write-Host "DONE. 将 cordis-patch.yaml 的 command 改为: $VenvDir\Scripts\python.exe"
