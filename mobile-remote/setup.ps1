# mobile-remote setup — Tailscale 双通道 + 信任栅栏配置（管理员权限）
param(
  [Parameter(Mandatory=$false)][string]$TailscaleIP = '<PC_TAILSCALE_IP>',
  [Parameter(Mandatory=$false)][string]$Domain = '<YOUR_DOMAIN>.ts.net',
  [Parameter(Mandatory=$false)][int]$Port = 3080
)
$ErrorActionPreference = 'Stop'
Write-Host "[1/4] netsh portproxy: $TailscaleIP`:$Port -> 127.0.0.1:$Port"
netsh interface portproxy delete v4tov4 listenaddress=$TailscaleIP listenport=$Port 2>$null
netsh interface portproxy add v4tov4 listenaddress=$TailscaleIP listenport=$Port connectaddress=127.0.0.1 connectport=$Port
Write-Host "[2/4] tailscale serve: https://$Domain -> 127.0.0.1:$Port"
& 'C:\Program Files\Tailscale\tailscale.exe' serve reset 2>$null
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg "https://$Domain" "http://127.0.0.1:$Port"
Write-Host "[3/4] 校验："
netsh interface portproxy show all
& 'C:\Program Files\Tailscale\tailscale.exe' serve status
Write-Host "[4/4] DSH trustedHosts 建议（加入 cordis.patch.yml）："
Write-Host "  - id: connection"
Write-Host "    config:"
Write-Host "      trustedHosts: ['$TailscaleIP', '$Domain']"
Write-Host "完成。手机浏览器访问 https://$Domain（需与 PC 同一 tailnet）。"
