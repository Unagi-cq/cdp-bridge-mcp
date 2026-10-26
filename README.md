<p align="center">
  <h1 align="center">CDP Bridge · OpenHarmony 版</h1>
  <p align="center">在 OpenHarmony / 国产 Chromium 内核上可用的浏览器自动化 MCP 桥</p>
  <p align="center">
    <a href="#快速开始">快速开始</a> ·
    <a href="#mcp-工具清单">工具清单</a> ·
    <a href="#已知限制">已知限制</a> ·
    <a href="#架构">架构</a>
  </p>
</p>

---

`cdp-bridge-ohos` 是 [CDP Bridge MCP](https://github.com/Unagi-cq/cdp-bridge-mcp) 的 **OpenHarmony（鸿蒙）适配版**：把一台 MCP 客户端（如 WorkBuddy / Claude / Cline）连接到**真实、已登录**的浏览器标签页，让大模型能读取页面、查询元素、点击、输入、滚动、跳转、等待——复用浏览器里的登录态、Cookie、前端渲染结果。

**它解决的核心痛点**（在国产内核 / OpenHarmony 上）：

1. **Python 原生库无法加载** —— OpenHarmony 强制 ELF/`.so` 代码签名，`pydantic-core`/`rpds` 等原生模块跑不起来 → 本项目用**纯 Node 零依赖**重写整个服务端，系统自带 Node 即可运行。
2. **扩展 API 挂起 / 无 eval** —— 在部分国产 Chromium 内核（实测 htbrowser / Chrome 132）中，`chrome.scripting.executeScript`、`chrome.debugger.*`、`chrome.tabs.create`、`chrome.tabs.captureVisibleTab` 会**永久挂起**；MV3 又禁止 `unsafe-eval`，页面 CSP 拦内联脚本 → 本项目改用**内容脚本隔离世界 + 结构化 DOM 命令（全程无 eval）**驱动页面。
3. **反自动化页面点不动** —— 对校验 `event.isTrusted` 的站点，程序化点击无效 → 提供**走后端 API**的通道（`fetchx` 自动注入登录 token），拿到数据/地址后用 `chrome.windows.create` 打开目标。

---

## 特性

- ✅ **真实浏览器会话**：连接已打开的页面，复用登录态；非无状态 HTTP 抓取
- ✅ **17 个 MCP 工具**：列标签页 / 读页面 / 查询元素 / 点击 / 输入 / 滚动 / 跳转 / 等待 / 截图（受内核限制）/ 批量
- ✅ **全程无 eval**：结构化 DOM 命令在隔离世界用原生 DOM API 执行，严格 CSP 页面也能读能点能填
- ✅ **零第三方依赖**：服务端只用 Node 内置模块（`http`/`crypto`/`zlib`），自带迷你 WebSocket 实现
- ✅ **内核缺陷多路降级**：`tabs.create` 挂起 → 自动回退 `windows.create` → 回退当前标签页导航
- ✅ **反自动化绕行**：`read_ls` 读登录 token → `fetchx` 调同源后端 API → 拿地址后开标签

---

## 架构

```
+--------------------+      +----------------------+      +------------------+
|  MCP 客户端        |      |  bridge-server.js     |      | 浏览器扩展        |
| (WorkBuddy/Claude  |      |  (本机常驻 Node 服务)  |      |  (background.js) |
|  /Cline...)        |      |                      |      |                  |
|                    |      |   :18766 HTTP 控制面   |      |  连接 :18765 WS   |
|  mcp-stdio.js <--->|------|->  execute_js 路由     |<-----|   tabs.sendMessage|
|  (stdio)           |      |   :18765 WebSocket    |      |        |          |
+--------------------+      +----------------------+      +--------|----------+
                                                                  v
                                                            content.js (隔离世界)
                                                                | 结构化 DOM 命令
                                                            (read_page/query/click/
                                                             type/scroll/navigate/
                                                             wait_for/get_meta)
                                                                |
                                                                v
                                                          真实已登录页面 DOM
```

数据流：

```
MCP stdio ──▶ HTTP :18766 ──▶ bridge-server ──▶ WS :18765 ──▶ background ──▶ content script ──▶ 页面
         (initialize/tools/call)   (路由/会话)     (扩展连入)   (转发命令)  (无 eval)      (真实 DOM)
```

其中 `ws-mini.js` 是零依赖 WebSocket（RFC 6455）服务端实现，避免引入任何原生模块。

---

## 快速开始

### 前置条件

- OpenHarmony / 国产 Chromium 内核笔记本（如海泰浏览器 htbrowser 2.x、Chrome 132+）
- 系统自带 Node（`node -v` ≥ 18；OpenHarmony 上使用系统预装二进制即可）
- 一个 MCP 客户端（WorkBuddy / Claude Desktop / Cline…）

### 第 1 步：加载浏览器扩展

1. 打开浏览器的扩展管理页（`chrome://extensions`），开启右上角「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本仓库的 **`src/extension/`** 目录
3. 确认扩展图标出现。扩展会**主动**向 `127.0.0.1:18765` 发起 WebSocket 连接（无需浏览器开启 CDP 调试端口）

> 说明：`background.js` / `content.js` 修改后，需要在 `chrome://extensions` 里点一下扩展的「刷新」（重载），内容脚本有资源缓存，仅刷新网页不会生效。

### 第 2 步：启动桥接服务

```bash
# 方式 A：直接起服务（mcp-stdio 会自动拉起 bridge-server）
node src/mcp-stdio.js

# 方式 B：分开起（调试方便）
node src/bridge-server.js   # 常驻：18765(WS) + 18766(HTTP 控制面)
```

验证服务状态：

```bash
curl -s -X POST http://127.0.0.1:18766/link -H 'Content-Type: application/json' -d '{"cmd":"status"}'
# {"r":{"ok":true,"connections":1,"tabs":2}}   ← connections 就是已连上扩展数
```

### 第 3 步：接入 MCP 客户端

#### 方式一：WorkBuddy 一键安装（推荐，最省事）

```bash
node scripts/install-workbuddy.js
```

脚本会自动：定位本机 node → 解析 `src/mcp-stdio.js` 绝对路径 → 把 `cdp-bridge-ohos` 这一个服务合并进 `~/.workbuddy/mcp.json`。你已有的其它 MCP 服务器**不会被改动**，写入前会自动备份 `mcp.json.bak`。

然后只剩在界面点一下「信任」：

1. 左侧边栏 → **连接器**
2. 右上角 → **自定义连接 / MCP 服务器**
3. 列表中找到 **`cdp-bridge-ohos`** → 点 **「信任」** → 启用
4. 状态指示灯变绿（已连接 / 已启用），就可以用自然语言让它"打开某个网页 / 点击 / 填表"了

> 自定义服务名或配置目录：`node scripts/install-workbuddy.js --name browser --home /path/to/home`；只想预览不写盘：加 `--dry-run`。

#### 方式二：手动配置（任意 MCP 客户端通用）

任意 MCP 客户端配一个 **stdio** 服务，命令指向 `src/mcp-stdio.js`：

```json
{
  "mcpServers": {
    "cdp-bridge-ohos": {
      "command": "node",
      "args": ["/绝对路径/cdp-bridge-ohos/src/mcp-stdio.js"],
      "env": {
        "CDP_BRIDGE_WS_PORT": "18765",
        "CDP_BRIDGE_CTRL_PORT": "18766"
      }
    }
  }
}
```

WorkBuddy 同样支持：把上面这段粘进 `~/.workbuddy/mcp.json`（**合并进 `mcpServers`，别覆盖其它项**），回到连接器页对 `cdp-bridge-ohos` 点「信任」即激活。

### 第 4 步：跑通

```bash
node examples/01-mcp-smoke.js    # 冒烟：列工具 → 列标签 → 读页面元信息 → 查元素
node examples/02-e2e-basic.js    # 端到端：读页/查询/滚动/输入/验证/等待（在当前标签页）
```

---

## MCP 工具清单

| 工具 | 说明 |
| --- | --- |
| `browser_get_tabs` | 列出所有可脚本化标签页（id / url / title） |
| `browser_status` | 桥接状态 + 已连扩展数 + 标签页 |
| `browser_scan` | 扫描当前标签页——文本模式或简化 HTML（带 `wd-i` 索引，供 LLM 消费） |
| `browser_dom` | **通用 DOM 命令入口**：`read_page / query / click / type / scroll / scroll_to / navigate / wait_for / get_meta` 及高级命令 |
| `browser_query` | 按 CSS 选择器查元素列表（tag/text/坐标/关键属性/输入框实时 value） |
| `browser_click` | 点击匹配元素（selector + index；含 pointer 事件兜底，React 兼容） |
| `browser_type` | 输入文本（原生 value setter + input/change 事件，React/Vue 受控输入兼容；支持 clear/enter） |
| `browser_scroll` | 按 x/y 滚动 或 滚动到绝对 top |
| `browser_wait_for` | 轮询等待某选择器出现（默认 8s） |
| `browser_navigate` | 当前标签页跳转到 URL |
| `browser_switch_tab` | 切换默认操作标签页 |
| `browser_focus_tab` | 聚焦某标签页 |
| `browser_screenshot` | 截图（⚠️ 受内核限制，见「已知限制」） |
| `browser_batch` | 批量执行一组扩展命令 |
| `browser_wait` | 轮询执行一段 JS 直到条件为真 |
| `browser_save_image` | 把截图 JSON 保存为本地 PNG |
| `browser_execute_js` | 执行任意 JS（⚠️ 仅宽松 CSP 页面可用，见「已知限制」） |

### browser_dom 的高级命令（content script 内置，均可经 `browser_dom` 透传）

这些是在 OA / 反自动化场景沉淀的调试与绕行能力：

| action | 说明 |
| --- | --- |
| `read_ls` | 读当前站点 `localStorage` 键值（隔离世界与页面共享同源存储），用于找登录 token |
| `fetchx` | 页面内 `fetch`，`args.auth:true` 时自动从 `localStorage.token` 注入 `Authorization`/`token`/`X-Access-Token` 请求头 → 可调同源后端 API |
| `perf_resources` | 列出页面加载过的资源 URL（Performance API），用于反推后端 API 路径 |
| `arm_open` / `read_opens` | 在共享 `window` 上挂 `window.open` 代理，捕获页面程序要打开的 URL（即使被弹窗拦截） |
| `probe_escape` | 诊断页面的 meta CSP 与 MAIN world 可达性 |

> 反自动化站点万能三连：`read_ls` 找 token → `fetchx(auth)` 调后端 API 拿数据/地址 → 开标签（见 `tabs method=open`）。

---

## 已知限制

以下是本方案绕不开的内核级约束（实测 htbrowser / Chrome 132 on OpenHarmony）：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `chrome.scripting.executeScript` | ❌ 挂起 | Service Worker 中调用后 `Promise` 永不回调 |
| `chrome.debugger.*` | ❌ 挂起 | CDP 命令通道不可用 |
| `chrome.tabs.create` | ❌ 挂起 | 开新标签会卡死 → 已自动回退 `windows.create` |
| `chrome.tabs.captureVisibleTab` | ⚠️ 不稳定 | 目标 tab 非前台时挂起；截图需前台窗口 |
| 任意 JS 执行（eval） | ❌ | MV3 禁 `unsafe-eval` + 页面 CSP → 只能走结构化 DOM 命令 |
| 程序化点击 | ⚠️ 部分页面失效 | 校验 `event.isTrusted` 的站点需走后端 API 路线（见上） |

**一句话总结**：读、查、点、填、跳、等——全部可用；**任意 JS 注入**与**可靠截图**受内核限制。

---

## 目录结构

```
cdp-bridge-ohos/
├── src/
│   ├── bridge-server.js        # 常驻桥接服务：WS(18765) + HTTP 控制面(18766)，会话/路由/轮询
│   ├── ws-mini.js              # 零依赖 WebSocket(RFC6455) 服务端
│   ├── mcp-stdio.js            # MCP(stdio) 服务：tools/list + 17 个工具实现，自动拉起 bridge
│   └── extension/              # 浏览器扩展（在 chrome://extensions 加载此目录）
│       ├── manifest.json       # MV3；无 unsafe-eval；content_scripts 注入
│       ├── background.js       # Service Worker：WS 连桥、转发 DOM 命令、tabs 多路降级
│       ├── content.js          # 隔离世界：结构化 DOM 命令（read/query/click/type/...）
│       ├── config.js           # 桥接地址常量（默认 127.0.0.1:18765）
│       ├── disable_dialogs.js  # 屏蔽 alert/confirm/prompt，防页面弹窗阻塞自动化
│       ├── popup.html / popup.js
│       └── icons/
├── scripts/
│   └── install-workbuddy.js    # WorkBuddy 一键接入：写 ~/.workbuddy/mcp.json + 备份 + 信任指引
└── examples/
    ├── 01-mcp-smoke.js         # MCP 冒烟测试（只读）
    ├── 02-e2e-basic.js         # 端到端基础操作演示
    └── 03-fake-extension.js    # 模拟扩展的 WS 客户端：无浏览器也能测服务端协议
```

### 端口约定

| 端口 | 用途 | 谁连谁 |
| --- | --- | --- |
| `18765` | WebSocket | 浏览器扩展 **主动连入**（也支持 HTTP 存活探测 `GET /`） |
| `18766` | HTTP 控制面 | MCP stdio 进程调用（`POST /link`, body: `{"cmd":...}`） |

---

## 常见问题

**Q：`browser_get_tabs` 提示没有连接标签页？**
A：检查扩展是否已加载且「合作伙伴」状态正常——打开 `chrome://extensions` 确认扩展没有报错；然后 `curl ... /link -d '{"cmd":"status"}'` 看 `connections` 是否为 ≥1。

**Q：改完 `content.js`/`background.js` 不生效？**
A：内容脚本有资源缓存。去 `chrome://extensions` 点该扩展的「刷新」（重载整个扩展），会触发它重新连 WS 并重新注入；仅刷新目标网页不行。

**Q：`node src/mcp-stdio.js` 为什么没有明显的日志？**
A：stdout 是 MCP 协议通道，日志写到 `mcp.log`（可通过环境变量 `CDP_BRIDGE_LOG` 指定）。直接查 `mcp.log` / `bridge.log`。

**Q：想换端口？**
A：设置环境变量 `CDP_BRIDGE_WS_PORT` / `CDP_BRIDGE_CTRL_PORT`；并同步修改 `src/extension/config.js` 里的 `DEFAULT_BRIDGE_PORT`（扩展连的端口）与 `popup.js`。

---

## 致谢

- [**CDP Bridge MCP**](https://github.com/Unagi-cq/cdp-bridge-mcp)（作者 cq_huang，MIT License）——本项目是针对其 OpenHarmony 环境的适配与 Node 零依赖重写；扩展代码在其基础上针对国产内核做了大量改造
- 所有在 OpenHarmony 沙箱环境中一起把不可能变成可能的人

## License

[MIT](./LICENSE)
