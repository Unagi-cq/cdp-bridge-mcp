<h1 align="center">CDP Bridge MCP</h1>

<div align="center">

[![PyPI](https://img.shields.io/pypi/v/cdp-bridge?label=PyPI)](https://pypi.org/project/cdp-bridge/)
[![Python](https://img.shields.io/badge/Python-3.12%2B-blue)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-Browser%20Bridge-green)](https://modelcontextprotocol.io/)
[![GitHub](https://img.shields.io/badge/GitHub-Unagi--cq%2Fcdp--bridge--mcp-black)](https://github.com/Unagi-cq/cdp-bridge-mcp)

</div>

<p align="center">
CDP Bridge MCP 是一个连接 MCP 客户端与真实浏览器会话的桥接服务。它通过配套的 Chromium 扩展接入浏览器页面，让大模型客户端可以读取标签页、扫描页面、执行 JavaScript、截图、导航和读取 Cookie。
</p>

<p align="center">
<a href="#中文说明">中文</a> | <a href="#english">English</a>
</p>

## 中文说明

### 项目介绍

CDP Bridge MCP 适合需要让大模型操作真实浏览器的场景。和无状态 HTTP 抓取不同，它连接的是你已经登录、已经打开的浏览器页面，因此可以复用真实浏览器里的登录态、Cookie、页面状态和前端渲染结果。

项目由两部分组成：

- **MCP Server**：Python 包，发布到 PyPI 后可通过 `uvx cdp-bridge` 启动。
- **浏览器扩展**：随 Python 包一起发布，用于把 Chromium 标签页连接到本地 MCP Server。

代码仓库：<https://github.com/Unagi-cq/cdp-bridge-mcp>

### 功能

- 标签页管理：获取当前已连接浏览器标签页列表，并切换活动标签页。
- 页面扫描：提取当前页面的简化 HTML 或纯文本内容，减少无关脚本、样式和隐藏元素。
- JavaScript 执行：在真实页面上下文中执行 JavaScript，并返回执行结果。
- 页面导航：控制活动标签页跳转到指定 URL。
- 页面截图：通过 CDP 截取当前页面 PNG，并返回 base64 数据。
- Cookie 读取：读取当前页面或指定 URL 的 Cookie。
- 真实会话复用：可使用浏览器中已有登录态，适合需要账号态页面的自动化和检索场景。

### 安装与启动

安装 `uv` 后，发布到 PyPI 的版本可以直接用 `uvx` 启动：

```bash
uvx cdp-bridge
```

在 MCP 客户端中可以这样配置：

```json
{
  "mcpServers": {
    "cdp-bridge": {
      "command": "uvx",
      "args": ["cdp-bridge"]
    }
  }
}
```

### 加载浏览器扩展

浏览器扩展已经包含在 Python 包内。安装或通过 `uvx` 使用后，可以打印扩展目录：

```bash
uvx --from cdp-bridge cdp-bridge-extension-path
```

然后在 Chrome 或其他 Chromium 浏览器中加载：

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `cdp-bridge-extension-path` 输出的目录。
5. 启动 MCP Server 后，刷新需要操作的网页。

默认情况下，扩展会连接本地服务地址 `127.0.0.1:18765`。

### 可用工具

MCP Server 当前暴露以下工具：

| 工具名 | 说明 |
| --- | --- |
| `browser_get_tabs` | 获取已连接标签页列表 |
| `browser_scan` | 扫描当前页面内容，可返回简化 HTML 或纯文本 |
| `browser_execute_js` | 在当前标签页执行 JavaScript |
| `browser_switch_tab` | 切换活动标签页 |
| `browser_navigate` | 跳转当前标签页到指定 URL |
| `browser_screenshot` | 获取页面截图 |
| `browser_cookies` | 读取 Cookie |

### 本地开发

克隆仓库：

```bash
git clone git@github.com:Unagi-cq/cdp-bridge-mcp.git
cd cdp-bridge-mcp
```

从源码运行：

```bash
uv run cdp-bridge
```

构建发布包：

```bash
uv build
```

检查发布包：

```bash
uvx twine check dist/*
```

发布到 PyPI：

```bash
uv publish
```

### 注意事项

- 本项目需要 Python 3.12 或更高版本。
- 浏览器扩展需要和 MCP Server 同时运行，否则工具会提示没有连接的浏览器标签页。
- 页面自动化会运行在你的真实浏览器会话中，请只连接你信任的 MCP 客户端。
- 如果修改了扩展文件，重新构建包前请确认 `src/cdp_bridge/tmwd_cdp_bridge` 中的文件已经更新。

## English

### Introduction

CDP Bridge MCP is an MCP server for connecting model clients to real browser sessions. Instead of fetching pages as stateless HTTP documents, it works with tabs already open in your Chromium-based browser, so the model can use existing login state, cookies, rendered DOM, and live page context.

The project has two parts:

- **MCP Server**: a Python package that can be launched with `uvx cdp-bridge` after publishing to PyPI.
- **Browser extension**: a packaged Chromium extension that connects browser tabs to the local MCP server.

Repository: <https://github.com/Unagi-cq/cdp-bridge-mcp>

### Features

- Tab management: list connected browser tabs and switch the active tab.
- Page scanning: extract simplified HTML or plain text from the active page.
- JavaScript execution: run JavaScript in the real page context.
- Navigation: navigate the active tab to a target URL.
- Screenshots: capture a PNG screenshot through CDP and return base64 data.
- Cookie access: read cookies for the current page or a specific URL.
- Real session reuse: operate on pages with your existing browser login state.

### Install and Run

After installing `uv`, the PyPI package can be launched with:

```bash
uvx cdp-bridge
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "cdp-bridge": {
      "command": "uvx",
      "args": ["cdp-bridge"]
    }
  }
}
```

### Load the Browser Extension

The Chromium extension is included in the Python package. Print its local path with:

```bash
uvx --from cdp-bridge cdp-bridge-extension-path
```

Then load it in Chrome or another Chromium-based browser:

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select the directory printed by `cdp-bridge-extension-path`.
5. Start the MCP server and refresh the page you want to operate on.

By default, the extension connects to `127.0.0.1:18765`.

### Tools

The MCP server exposes these tools:

| Tool | Description |
| --- | --- |
| `browser_get_tabs` | List connected browser tabs |
| `browser_scan` | Scan the active page as simplified HTML or plain text |
| `browser_execute_js` | Execute JavaScript in the active tab |
| `browser_switch_tab` | Switch the active tab |
| `browser_navigate` | Navigate the active tab to a URL |
| `browser_screenshot` | Capture a page screenshot |
| `browser_cookies` | Read cookies |

### Development

Clone the repository:

```bash
git clone git@github.com:Unagi-cq/cdp-bridge-mcp.git
cd cdp-bridge-mcp
```

Run from source:

```bash
uv run cdp-bridge
```

Build the package:

```bash
uv build
```

Check the distribution files:

```bash
uvx twine check dist/*
```

Publish to PyPI:

```bash
uv publish
```

### Notes

- Python 3.12 or newer is required.
- The browser extension and MCP server must run at the same time.
- Browser automation runs in your real browser session, so only connect clients you trust.
- If extension files are changed, make sure `src/cdp_bridge/tmwd_cdp_bridge` is updated before building the package.
