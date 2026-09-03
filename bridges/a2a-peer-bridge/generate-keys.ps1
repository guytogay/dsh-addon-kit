# 生成 A2A/Peer 随机凭据（不落库、不打印到日志）
# 用法：powershell -ExecutionPolicy Bypass -File generate-keys.ps1
# 输出到本目录：a2a-push.token / a2a-push-signature.secret / peer.token（GUID 强度随机）
$ErrorActionPreference = 'Stop'
function New-Token([int]$bytes = 32) {
  $buf = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  -join ($buf | ForEach-Object { $_.ToString('x2') })
}
$a2a = New-Token 32
$sig = New-Token 32
$peer = New-Token 32
Set-Content -Path "$PSScriptRoot\a2a-push.token" -Value $a2a -NoNewline -Encoding ASCII
Set-Content -Path "$PSScriptRoot\a2a-push-signature.secret" -Value $sig -NoNewline -Encoding ASCII
Set-Content -Path "$PSScriptRoot\peer.token" -Value $peer -NoNewline -Encoding ASCII
Write-Host "已生成 3 个凭据文件（值不回显）。"
Write-Host "交付对端时：A2A 用 a2a-push.token（Bearer 或 push token），peer 用签名 secret（A2A_PUSH_SECRET），MCP 用 peer.token。"
