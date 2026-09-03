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
