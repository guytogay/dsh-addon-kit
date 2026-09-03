# mobile-remote — 手机访问 DSH Web 接入包（Tailscale 双通道 + 手机适配）

让手机/远程设备以 **HTTPS** 安全访问 DSH web 的可重复接入包。
（原理：DSH 客户端 RPC 依赖 crypto.randomUUID，仅 HTTPS/localhost 安全上下文可用；
手机远程必须走 HTTPS 或 tailscale 隧道。）

## 组件
- `setup.ps1`：一键配置 netsh portproxy + tailscale serve + 输出 trustedHosts 建议
- 手机适配清单（配置层）：目录选择器 browse 形态、webserver 0.0.0.0、trustedHosts 三元组、
  dsh-file-attach（设备文件选择器）；LXC 端 UI 补丁见 ../ui-patches（mobile-pwa/inject）

## 用法
```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1 -TailscaleIP <IP> -Domain <host>
# 例：powershell -File setup.ps1 -TailscaleIP <PC_TAILSCALE_IP> -Domain <YOUR_DOMAIN>.ts.net
```
前提：已安装并登录 Tailscale；DSH web 已监听 127.0.0.1:3080。

## 安全边界（不变式）
- 只暴露 tailnet（Tailscale serve 是 tailnet-only；portproxy 绑定 tailscale IP 非 0.0.0.0）
- `/api` 浏览器信任围栏：trustedHosts 必须包含远程 authority（否则 403）
- 不提供公网入口；不开放 31009/9900 到局域网/公网

## 手机适配状态参考（本机实绩）
- HTTPS：https://<YOUR_DOMAIN>.ts.net → 127.0.0.1:3080（tailscale serve）✅
- HTTP：<PC_TAILSCALE_IP>:3080（portproxy）✅
- trustedHosts: <PC_TAILSCALE_IP> / <YOUR_DOMAIN>.ts.net / <LAN_IP>
