# source-patches — 面向 DSH **源码检出**的补丁

与上一级 `dsh-patch-kit-release/` 的区别，这一条很重要：

| | `dsh-patch-kit-release/` | 本目录 |
| --- | --- | --- |
| 打在哪 | 官方**构建产物**（如 `lib/client.js`） | DSH **源码**（`packages/…/src`、`apps/web`） |
| 何时失效 | **下一次 `pnpm run build` 即被覆盖** | 只有上游改了同一处才需重解 |
| 适用 | 只发布产物的部署 | 自己构建的检出（本机 `pnpm run build`） |

**自己构建的部署应当优先用源码补丁**：产物补丁每次重建都要重打，很容易在升级流程里被悄悄漏掉。

## 应用方式

```bash
cd <dsh-checkout>
git apply /path/to/source-patches/mobile-keyboard-viewport-meta.patch
git apply /path/to/source-patches/mobile-keyboard-inset.patch
git apply /path/to/source-patches/mobile-keyboard-frame.patch
pnpm run build          # 客户端产物必须重建
# 宿主直接读磁盘上的客户端产物，通常无需重启
```

补丁自带标记（`interactive-widget=resizes-content` / `installKeyboardInset` / `--dsh-keyboard-inset`），
可用 `grep` 判断是否已应用，重复执行安全。

## mobile-keyboard-* —— 让输入框不被手机软键盘挡住

**问题**：手机点输入框时页面不上弹，底部键盘盖住输入框。

**根因**：客户端完全没有软键盘处理（源码里 `visualViewport` 零命中）。输入栏是 `position: sticky; bottom: 0`，而整条高度链是 `height: 100%`，即贴在**布局视口**底部。iOS 上键盘弹出**不改变布局视口**，只是覆盖其上，于是贴底元素被盖住。

**两平台两套机制、一个变量**：

| 平台 | 机制 | 文件 |
| --- | --- | --- |
| Android（Chrome 等） | `interactive-widget=resizes-content` —— 让**布局视口**随键盘收缩，贴底元素自然留在键盘上方（原生，一行） | `apps/web/index.html` |
| iOS Safari | 它**忽略**上面那个提示、只收缩**视觉视口**；改为监听 `window.visualViewport`，算出被遮挡高度并发布为 `--dsh-keyboard-inset` | `apps/web/src/main.ts` |
| 消费方 | 外壳高度收缩：`height: calc(100% - var(--dsh-keyboard-inset, 0px))` | `ui-layout/AppFrame.module.css` |

顺带加了 `viewport-fit=cover`，使 `env(safe-area-inset-*)` 可用（刘海/home 指示条）。

**已验证**：Android 侧浏览器实际收到的 meta 含该提示；iOS 侧以可控桩替换 `visualViewport` 模拟 300px 键盘后，变量为 300px、输入框底边由 585 上移到 435、高于键盘 117px、控制台零错误；**并在真实 Android 手机（小米）上确认修复有效**。

**一次被实测推翻的设计**：最初的实现是把变量用在输入栏的 `bottom` 上（`bottom: var(--dsh-keyboard-inset)`）。实测变量值完全正确而输入栏**纹丝不动**——因为 `position: sticky` 的偏移量只在元素会被容器挤出时生效，短会话里输入栏位于视口中间，该属性毫无作用。改为收缩外壳高度后成立。**改 sticky 的偏移前，先问这个元素当前是否会被挤出。**

## 验证

```bash
node tools/dsh-ui-verify/dsh-keyboard-check.mjs
```

同时断言两条平台路径；手机真实键盘无法自动化复现，脚本会明确标注这一点。
