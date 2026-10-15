# 小李 · 调研文档（桌面化方案 + UI 设计感参考）

版本 v1.0 · 2026-10-15 · 状态：调研完成，结论已给，待采纳
关联：`改进方向-UI与桌面化.md` → `需求-UI与桌面化.md` → 本文（选型依据）

---

## 1. 调研目标

回答三个问题：
1. 让小李拥有**独立桌面窗口**（不占浏览器标签），用哪种技术最合适？
2. **不弹黑色命令行窗口**，用哪种启动方式最稳？
3. UI 设计感升级，在「不破坏 46 个测试、不联网、全站一套 CSS」约束下怎么走？

---

## 2. 现状盘点（已核实，非假设）

| 项 | 现状 |
| --- | --- |
| 服务端 | `app\服务.py`：标准库 `http.server`（ThreadingHTTPServer），端口 8765 起最多试 12 个，`--no-browser` 可关自动开浏览器 |
| 启动 | `启动.cmd`：探测多个 Python（本机实测：LocalAppData Python 3.12.4、ProgramFiles Python 3.14.7、msys64 3.14.7），逐个试导入后才选用；前台跑 `服务.py`，黑窗口常驻，关窗即停 |
| 数据 | `数据\` 根目录 + 数据集功能（`当前数据集.txt` + `默认\` 等子目录）；`XIAOLI_DATA_DIR` 环境变量下数据集功能关闭 |
| 前端 | `app\web\`：index.html + style.css（131KB，CSS 变量双主题体系完整）+ 50 余个 JS 模块 |
| 测试 | `tests\` 46 个 .mjs 测试文件（无头 Edge CDP 直连 HTTP 端口 + 纯逻辑单测）+ `自检.py`；全部走临时数据目录 |
| 图标 | 根目录 `小李.ico` 已有 |
| 定位 | 零外链、不联网、单机自用、不登录 |

**结论性事实**：
- 服务层与界面层已彻底解耦（HTTP + 静态页面），**换任何窗口壳都不影响服务与测试**；
- 测试直接访问 `http://127.0.0.1:端口`，**与浏览器外壳无关** → 桌面化对测试零影响（前提：服务层保持无 GUI 可跑）。

---

## 3. 桌面窗口方案对比

### 3.1 候选方案

| 方案 | 原理 | 体积 | 依赖 | 与现状集成 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **pywebview** | Python 库，Windows 上用 WebView2（Edge 内核）渲染本地 URL | 纯 Python 依赖（pywebview + pythonnet），运行时用系统自带 WebView2，无额外体积 | `pip install pywebview`；WebView2 Runtime（Win10/11 基本预装，Edge 自带） | `webview.create_window("小李", url)` 指向现有 `http://127.0.0.1:8765`；服务照常跑 | **推荐** |
| Electron | 打包 Chromium + Node，全功能桌面壳 | 150MB+ | Node.js 工具链 + 打包配置 | 需引入 Node 工程、改造启动、测试要适配 | 过重，不符合轻量定位 |
| Tauri | Rust + 系统 WebView2，体积小 | 数 MB | Rust 工具链 + Node | 需重写壳层，学习/构建成本高 | 过重，不符 |
| Edge PWA（安装为应用） | 浏览器「安装此站点为应用」，独立窗口 | 0 | 已装 Edge | 仅手动操作一次；但窗口仍是浏览器外壳，且不会启动服务 | 可作备选，非主线 |
| PyInstaller 打包 exe | 服务+前端打成单文件 exe，`--windowed` 无控制台 | 40~70MB | PyInstaller + 打包配置 | 一次性交付最像「软件」，但每次改动要重新打包；杀软可能误报 | **中期可选**，非首轮 |

### 3.2 为什么选 pywebview（证据）

1. **版本与健康度**：pywebview 当前最新 6.2.1（2026-04-15 发布），Snyk 检测 0 已知漏洞；6.x 为活跃主版本，2025-08 起 6.0 加入窗口级菜单等能力，仍在持续迭代。
2. **Windows 依赖**：Windows 平台依赖 pythonnet（需 .NET 4.0+，Win10/11 自带）与 WebView2 Runtime；WebView2 支持 Windows 10 SAC 1709 及以上、Windows 11（官方文档明示），且 Edge 浏览器预装即带 Runtime —— 本机（Windows 10/11）无需额外装运行库。
3. **与现状集成度**：本服务是标准库 HTTP 服务 + 静态页面，pywebview 只需 `create_window(url=...)` 指向本机端口即可，**不改服务协议、不改前端任何代码**；46 个测试完全不受影响。
4. **轻量**：相比 Electron（Chromium 全量）与 Tauri（Rust 工具链），pywebview 是纯 Python 依赖，与现有「找 Python 跑服务」的启动链天然衔接。
5. **窗口能力**：6.x 支持 `create_window(title, url, width, height, min_size=(…), icon=…)`、`webview.start()` 阻塞主线程；关闭窗口即退出（满足 D-5）。

### 3.3 pywebview 与现有服务线程的集成方式（方案级验证）

```python
import threading, webview
# 现有逻辑：httpd, port = start_server()
def run():
    httpd.serve_forever()
threading.Thread(target=run, daemon=True).start()
webview.create_window("小李", f"http://127.0.0.1:{port}/",
                      width=1280, height=860, min_size=(960, 640), icon="小李.ico")
webview.start()          # 阻塞；窗口关闭后返回
httpd.server_close()     # 优雅退出，端口释放
```
- 注意：`serve_forever` 移到后台线程；`webview.start()` 占用主线程跑 WinForms 消息循环；
- 保留 `--no-gui`（等价现在的浏览器模式）给测试与调试；
- pywebview import 失败 → 走浏览器模式（`threading.Timer(0.15, open_browser)` 现状逻辑）。

---

## 4. 隐藏命令行窗口方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **pythonw.exe** | 用 `pythonw.exe`（与 python.exe 同目录）跑 `服务.py` | 零依赖、系统自带；.pyw 文件双击也走 pythonw | 无 stdout/stderr，报错不可见（需重定向到日志文件）；启动.cmd 的探测逻辑需同步适配 | **推荐**（配合日志重定向） |
| VBS 隐藏启动 | 启动.cmd 内用 `WScript.Shell.Run "…cmd", 0, False` 隐藏窗口 | 保留 cmd 探测逻辑 | 多一层脚本；隐藏窗口后用户看不到任何输出 | 备选 |
| PyInstaller `--windowed/--noconsole` | 打包 exe 时不提供控制台 | 交付即单文件，无 Python 依赖 | 打包体积大、每次改动要重打、杀软误报风险 | 中期可选 |
| pywebview 自身 | 窗口模式下控制台本就多余 | 与桌面化同源 | 单独用没意义 | 与 D-1 合并 |

**推荐组合**：`启动.cmd` 探测到可用 Python 后，优先 `pythonw.exe` 跑 `服务.py --desktop`（桌面窗口模式）；把 `print` 输出同时追加到 `日志\` 下（服务已有 log_line 机制，只把控制台 print 重定向进文件即可）；另留 `启动-调试.cmd` 用 `python.exe`（带控制台）跑，供排错。

> 证据：PyInstaller 文档明确 `-w/--windowed/--noconsole` 在 Windows 上「不提供控制台窗口」，且 `pythonw` 后缀文件自动走无控制台模式 —— 印证 pythonw 是系统级无窗口启动的正规途径。

---

## 5. UI 设计感：现状与提升参考

### 5.1 现状（已读 style.css 与界面截图核实）

- 设计令牌完整：圆角 16/10/8、阴影单档、间距 8 基准、主色 `#3b66d9`、明暗双主题 + 跟随系统、滚动条细胶囊统一；
- 布局：顶栏（品牌/问候/搜索/主题/状态）+ 侧栏（9~11 模块）+ 主区 + 状态栏；
- 现状观感：干净、工具化；背景纯色、卡片纯白/纯灰、无渐变层次、无 hover 反馈、无动效、空状态无配图。

### 5.2 提升方向（业界常见、纯 CSS 可实现）

1. **玻璃拟态（Glassmorphism）**：`backdrop-filter: blur() + saturate() + 半透明底色 + 1px 高光描边`，用于顶栏/侧栏/弹窗 —— 深色下效果最明显，与现有「液态玻璃」注释中的方向一致，属延续而非颠覆；
2. **柔和渐变背景**：浅色 `linear-gradient` 微蓝紫，深色 `radial-gradient` 光晕，低饱和不刺眼；
3. **设计令牌扩展**：在现有 `:root` 变量上新增 `--bg-grad`、`--glass-bg`、`--glass-border`、`--shadow-2`、`--ease`、`--dur-*`、`--module-*` 等一组新变量，**增量覆盖，不重写**；
4. **动效**：纯 CSS transition/keyframes，全部 `@media (prefers-reduced-motion: reduce)` 关闭；
5. **空状态/图标**：内联 SVG（不联网），延续现有 `icons.js` 线性风格。

### 5.3 硬约束（写死）

- 不改 DOM 结构、不改既有 class 名、不改 placeholder 文本与按钮文案（46 个测试依赖）；
- 不引入在线字体/图标/CDN（断网可用底线）；
- style.css 只增不改：新样式追加在文件尾部、以变量驱动；确需覆盖旧规则时用更高优先级选择器并注释原因。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| pywebview 在个别环境装不上/启动失败 | 双击打不开 | D-3 回退机制：import 失败 → 浏览器模式，绝不拦死入口 |
| pythonw 下 print 不可见，排错困难 | 出问题不知道原因 | 服务内 print 统一重定向到 `日志\`；保留 `启动-调试.cmd` 控制台模式 |
| CSS 增量覆盖与旧规则冲突 | 视觉错乱 | 走查 11 个模块 + 改前/改后成对截图存档；测试全绿兜底 |
| 关闭窗口时服务未优雅退出 | 端口残留/进程残留 | 窗口关闭事件里 `server_close()`；验收含 `netstat` 查端口释放 |
| 数据集功能与窗口模式冲突 | 切换数据集时整页重载逻辑 | 桌面窗口就是普通 WebView 页面，数据集逻辑全在前端+HTTP，无冲突；但需回归数据集 46→58 项测试 |

---

## 7. 调研结论

1. **桌面窗口：pywebview 6.2.x（WebView2 后端）** —— 纯 Python 依赖、与现有 HTTP 服务零摩擦集成、Windows 10/11 自带 WebView2 Runtime、46 测试零影响；Electron/Tauri 因体积与工具链不符轻量定位，不选；Edge PWA 作手动备选；
2. **隐藏控制台：pythonw.exe 启动 + 日志重定向** —— 系统级方案、零新依赖，配 `启动-调试.cmd` 保留排错通道；PyInstaller `--windowed` 作中期「打包成真正 exe」的演进方向；
3. **UI：CSS 变量增量覆盖 + 玻璃拟态 + 柔和渐变 + 模块主题色 + 轻动效** —— 在不动 DOM/class 的约束下完全可行，风险集中在样式覆盖冲突，用「只增不改 + 全模块走查 + 截图对比」控制。

## 8. 信息来源

- pywebview 官方 Changelog（6.2.1，2026-04-15）：https://pywebview.flowrl.com/changelog
- pywebview 中文文档·安装（Windows 依赖 pythonnet + WebView2）：https://pywebview.idepy.com/guide/installation
- Microsoft Learn·WebView2 简介（支持 Win10 SAC 1709+ / Win11）：https://learn.microsoft.com/zh-cn/microsoft-edge/webview2/
- PyInstaller 使用文档（`--windowed/--noconsole`、pythonw 语义）：https://www.pyinstaller.org/en/v6.11.1/usage.html
- Snyk·pywebview 版本与漏洞（6.2.1 0 漏洞）：https://security.snyk.io/package/pip/pywebview/versions
