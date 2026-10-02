# dsh-ui-verify — 用真浏览器验证 DSH Web UI

两个 Playwright 脚本，使用**系统 Chrome**（`channel: 'chrome'`），playwright 从 DSH checkout 解析。适用于「HTTP 表面看起来正常、界面其实是坏的」这一类故障。

## dsh-mobile-audit.mjs — 手机视口量化审计

以手机视口（默认 393×852 @3x，iPhone 14 Pro 档）渲染，输出**可修的数字**而不是主观观感：

- 横向溢出的元素清单
- 触控目标尺寸（标出低于 44px 下限的控件）
- 各面板位置（能看出桌面三栏布局是否残留、有没有面板停在屏幕外）
- 输入框是否落在可视视口内
- 控制台错误与失败请求数
- 截图落盘

```bash
node dsh-mobile-audit.mjs [port]      # 默认 3080，令牌从宿主日志自动取
```

## dsh-remote-settings-check.mjs — 远程地址设置可用性闸门

验证**非回环地址**（局域网 IP / tailnet IP / MagicDNS 域名）下设置页是否可用。

背景：DSH 仅凭**浏览器地址栏主机名**决定设置持久化模式（`localhost` / `127.x` / `[::1]` 之外一律降级），于是远程打开 Settings → Models 会报
`settings are unavailable in this browser`。本脚本是 `ui-patches/dsh-patch-kit-release/patch-remote-settings.mjs` 的验收闸门。

**为什么带断言**：早期版本只检查「有没有出现报错」，结果在两条路径上都得出「没问题」的**假结论**——实际点击从未进入设置页。现在它会确认「设置面板确实打开」且「模型项确实被点中」，否则明确报 **INCONCLUSIVE**，绝不假通过。

```bash
node dsh-remote-settings-check.mjs
```

退出码：`0` 全部通过 / `1` 至少一条路径仍报错 / `2` 无法判定（测试装置有问题，结论不可信）

## 依赖

- 一个 DSH 源码 checkout（提供 playwright 与客户端产物），默认 `$HOME/Developer/deepseek-harness`，可用 `DSH_CHECKOUT` 覆盖
- 系统安装的 Chrome
- 输入框需可访问宿主：脚本从 `$HOME/.dsh/bin/dsh-url` 取各权威的带令牌链接
