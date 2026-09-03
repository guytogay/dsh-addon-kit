# dsh-file-attach 插件 — 附件上传（回形针 → 设备文件选择器 → chips 文档流）

DSH web UI 自定义插件（host + 浏览器双面）：full-type 文件选择器、附件 chips、引用行自动携带。
命名 `dsh-file-attach`（无 @deepseek-ai scope，用户自研发，v0.1.0）。

## 文件
- `lib/index.js`（host 侧）· `lib/client.js`（浏览器侧）· `lib/typert.host.js`
- `dsh-file-attach-0.1.0.tgz`（可 npm 安装的源码包）

## 安装（DSH）
1. 放置：`<dsh profile>\node_modules\dsh-file-attach\`（npm pack 或直接放置 lib/ + package.json）
2. 接入（cordis patch，本已含于主配置）：
```yaml
- insert:
    - id: file-attach
      name: dsh-file-attach
```

## 其他 agent / 环境
插件是 DSH 专用（组合到 cordis.yml）；其他 agent 如需等价能力：
- 通用 MCP 附件工具（如 文档类/文档 MCP）代替；或参考 client.js 的 chips 交互自行适配。

## 版本
0.1.0（2026-08-27，user 授权手搓）。变更对照：upstream/dsh-patch-kit/patch-attach-auto.mjs。
