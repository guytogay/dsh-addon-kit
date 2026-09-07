# dsh-patch-kit（发布副本）— DSH Web UI 补丁库（面向 LXC/PVE 端 DSH）

> 本目录为 `upstream/dsh-patch-kit/` 的发布副本（工作区现役位置的快照）。
> **改动请回源目录**，发布副本由同步脚本/手动拷贝更新。

## 用途
对 **D**SH 官方 web-frontend（`dsh-web-frontend/dist/index.html` 等）做单行标记式补丁：
移动端 PWA/viewport/theme-color 注入、界面布局/抽屉/资源管理器/交付物 chips 等。
所有补丁：**单行标记**（不做 sed 区间）、落盘前 `<body>` 完整性守卫、幂等（标记存在即跳过）、
改后自动备份（.bak-时间戳）+ 重启。

## 分组（按文件前缀）
| 前缀 | 内容 |
|---|---|
| 01-03-*.sh | 设置解锁（server/client）/ opendocument headless |
| 04-mobile-pwa.sh | PWA 注入（apple-touch-icon/theme-color/viewport-fit） |
| 05-mobile-injection.sh | 移动端跨平台兜底（DSH_PKG_ROOT 可配） |
| patch-*.mjs | 界面补丁：explorer/layout/drawer/deliverables/autocollapse/msgattach/refchip/whale 等 53 项 |
| apply-all.sh / apply-mobile.sh / verify.sh | 批量应用/验证 |
| dsh-file-attach-0.1.0.tgz | 附件上传插件源码包（也见 ../plugins/） |

## 用法（Linux/LXC 端）
```bash
./apply-mobile.sh        # 移动端补丁（先设 DSH_PKG_ROOT 环境变量，自动 <body> 校验 + 重启）
./verify.sh              # 校验标记/完整性
```
Windows 端等价的**配置层**适配（browse 选择器/0.0.0.0/PWA 等效 meta）见 ../mobile-remote/。

## 风险提示
- 目标路径绑定官方包（升级 DSH 前先比对补丁；patch 自带幂等+备份，失败可还原 .bak）
- 补丁不改官方语义，仅做表现层注入；建议升级时执行 verify.sh

## 2026-09-08 移动性能/内网补丁包（新增，全部参数化、幂等、不匹配即中止）
新增补丁（node 执行；每个脚本接受目标文件路径，实例差异经参数传入）：
- patch-question-survive.mjs  断连保留 question/requested 帧（提问框刷新/慢回复生存）
- patch-parallel-load.mjs     插件同级依赖并行加载（44 插件串行→并行）
- patch-hist-timeout.mjs      unary RPC 超时 30s→120s（大历史页防中止）
- patch-lan-mode.mjs          内网模式：isLoopback 白名单 += 传入主机/IP + randomUUID 安全兜底（用法: node patch-lan-mode.mjs client.js <host> [more...]）
- patch-static-gzip.mjs       静态响应 gzip（dist 回退件；小件受益）
- patch-api-gzip.mjs          /api unary JSON gzip（v4：typed-array 安全 + 头合并 + 日志 %TEMP%/dsh-gzip-dbg.log；**需重启 web 生效**）
实例参数约定（部署时按实例传入，禁止硬编码）：
- DSH_TRUSTED_HOST（isLoopback/trustedHosts 的主机或 IP，如 <YOUR_DOMAIN>.ts.net 或 <LAN_IP>）
- DSH_APP_TITLE / DSH_APP_NAME（实例标题，如 DSH_PC / DSH_LXC）
- DSH_LAN_IPS（逗号分隔，服务端 trustedHosts 与客户端 isLoopback 共用）
- 服务端 trustedHosts：编辑实例的 cordis.patch.yml 的 connection.trustedHosts（见 mobile-remote/setup 说明）
- manifest 名称/图标/display：按实例由部署脚本或手工调整（参考 addon-manifest 的 mobile-remote）
部署顺序（每实例）：backup → patch-*（按上表）→ cordis patch trustedHosts → 重启 web → 端到端验证（双通道 JSON + 页面级）。
