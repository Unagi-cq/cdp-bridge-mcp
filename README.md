<p align="center">
  <img src="./images/icon.png" alt="CDP Bridge MCP Icon" width="120" height="120" />
</p>

<h1 align="center">CDP Bridge MCP</h1>

<div align="center">

[![PyPI](https://img.shields.io/pypi/v/cdp-bridge?label=PyPI)](https://pypi.org/project/cdp-bridge/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-blue)](https://www.python.org/)
[![MCP](https://img.shields.io/badge/MCP-Browser%20Bridge-green)](https://modelcontextprotocol.io/)
[![GitHub](https://img.shields.io/badge/GitHub-Unagi--cq%2Fcdp--bridge--mcp-black)](https://github.com/Unagi-cq/cdp-bridge-mcp)

</div>

<p align="center">
CDP Bridge MCP 是一个连接 MCP 客户端与真实浏览器会话的桥接服务。它通过配套的 Chromium 扩展接入浏览器页面，让大模型客户端可以读取标签页、扫描页面、执行 JavaScript、截图、导航和读取 Cookie。
</p>

<p align="center">
中文 | <a href="./doc/README_EN.md">English</a>
</p>

## 演示视频

| 查询小红书平台 Anthropic 最新动态 | 读取 CSDN 网站作者后台数据分析 |
| --- | --- |
| [观看视频](https://www.bilibili.com/video/BV1RDRQBrEY7/?p=2) | [观看视频](https://www.bilibili.com/video/BV1RDRQBrEY7/) |

# 项目介绍

CDP Bridge MCP 适合需要让大模型操作真实浏览器的场景。**和无状态 HTTP 抓取不同，它连接的是你已经登录、已经打开的浏览器页面，因此可以复用真实浏览器里的登录态、Cookie、页面状态和前端渲染结果。**

代码仓库：<https://github.com/Unagi-cq/cdp-bridge-mcp>

> 本项目以Python语言编写并发布。 

## 为什么用 CDP Bridge MCP ?

**为什么用 CDP Bridge MCP 而不是 playwright MCP 或者 chrome devtools MCP ？**

Playwright MCP 和 Chrome DevTools MCP 都很强，但它们更偏向“自动化测试 / 调试协议 / 新开浏览器实例”的工作流。CDP Bridge MCP 的目标不同：它更关注让 LLM 直接接管你正在使用的真实浏览器会话。

- **复用真实登录态**：CDP Bridge MCP 连接的是你已经打开、已经登录的浏览器标签页，可以直接使用现有 Cookie、登录状态、页面上下文和前端渲染结果。很多需要账号态的网站，不需要重新登录或额外搬运 Cookie。
- **更适合日常浏览器协作**：Playwright 更适合可重复、可脚本化的自动化流程，而 CDP Bridge MCP 更适合 LLM 在用户当前页面上做读取、分析、点击前判断、执行脚本、截图等交互式任务。
- **页面内容更适合 LLM 消费**：`browser_scan` 会对页面 HTML 做简化，过滤脚本、样式和不可见元素，尽量保留对模型有用的正文、控件和结构信息，减少 token 浪费。
- **启动链路轻量**：服务端发布到 PyPI 后可直接 `uvx cdp-bridge` 启动，浏览器端加载扩展即可连接，不需要编写 Playwright 脚本，也不需要为每个浏览器实例单独配置调试参数。

如果你的目标是“让模型控制一个专门启动的自动化浏览器”，Playwright MCP 很合适；如果你的目标是“调试 Chrome 或精细操作 DevTools 协议”，Chrome DevTools MCP 很合适；如果你的目标是“让模型读取和操作我当前正在使用的真实浏览器页面”，CDP Bridge MCP 更贴近这个场景。

## 系统架构

```mermaid
graph TB
    subgraph Client["🖥️ MCP 客户端"]
        LLM["LLM (Claude、Codex 等)"]
    end

    subgraph Server["⚙️ cdp-bridge MCP 服务 (Python)"]
        FastMCP["FastMCP stdio Server<br/>9 个 MCP 工具"]
        TMWD["TMWebDriver<br/>会话管理器"]
        WS["WebSocket Server<br/>127.0.0.1:18765"]
        HTTP["HTTP Server<br/>127.0.0.1:18766"]
        FastMCP --- TMWD
        TMWD --- WS
        TMWD --- HTTP
    end

    subgraph Browser["🌐 Chrome / Chromium 浏览器"]
        subgraph Extension["扩展 (tmwd_cdp_bridge)"]
            BG["background.js<br/>Service Worker"]
            CT["content.js<br/>Content Script"]
        end
        Tabs["浏览器标签页<br/>(用户真实会话)"]
    end

    LLM <-->|"MCP 协议 (stdio)"| FastMCP
    WS <-->|"WebSocket (ext_ws)"| BG
    HTTP <-->|"HTTP 长轮询"| BG
    BG <-->|"chrome.scripting<br/>CDP Runtime.evaluate"| Tabs
    BG <-->|"chrome.runtime.sendMessage"| CT
    CT -->|"DOM 访问"| Tabs
```

**数据流简述：**

1. MCP 客户端通过 stdio 启动 `cdp-bridge` 进程，建立 MCP 协议通信。
2. TMWebDriver 启动 WebSocket（:18765）和 HTTP（:18766）两个服务端口。
3. 浏览器扩展通过 WebSocket 连接服务端，上报所有已打开标签页（`ext_ws` 模式），服务端为每个标签页创建 Session。
4. 当 MCP 工具被调用（如 `browser_execute_js`），服务端将 JS 代码通过 WebSocket 发送到扩展。
5. 扩展的 background.js 优先使用 `chrome.scripting.executeScript` 在页面 MAIN world 执行；若页面有 CSP 限制，自动降级为 CDP `Runtime.evaluate`。
6. 执行结果通过 WebSocket 返回服务端，再由 MCP 协议返回给 LLM 客户端。

## 可用工具

MCP Server 当前暴露以下工具：

| 工具名 | 说明 |
| --- | --- |
| `browser_get_tabs` | 获取已连接标签页列表 |
| `browser_scan` | 扫描当前页面内容，可返回简化 HTML 或纯文本 |
| `browser_execute_js` | 在当前标签页执行 JavaScript |
| `browser_switch_tab` | 切换 MCP 活动标签页，不改变用户当前可见的 Chrome 标签页 |
| `browser_batch` | 批量执行扩展/CDP 命令，适合需要复用 CDP 上下文的复杂操作 |
| `browser_wait` | 轮询 JavaScript 条件直到返回真值或超时 |
| `browser_navigate` | 跳转当前标签页到指定 URL |
| `browser_screenshot` | 获取页面截图 |
| `browser_cookies` | 读取 Cookie |

# 如何使用

## 安装步骤

1. 将项目中提供的浏览器插件 `src/cdp_bridge/tmwd_cdp_bridge` 文件夹加载到 Chrome 或其他 Chromium 浏览器
2. 在MCP客户端配置CDP Bridge MCP

然后就可以正常使用了。下面详细介绍上述安装步骤。

> **首次使用**：加载扩展后首次连接 WebSocket 会产生 `ERR_CONNECTION_REFUSED` 报错，这是正常的。扩展内置自动重连机制（每 ~5 秒探测一次），当检测到后端服务启动后会自动恢复连接，无需手动重启扩展。

## 使用流程

1. **加载浏览器扩展**（参考下方步骤）
2. **配置 MCP 客户端**（参考下方步骤）
3. **使用任意浏览器工具**（如 `browser_get_tabs`），MCP 服务启动后 WebSocket 服务会自动就绪
4. 浏览器扩展会在数秒内自动连接，之后即可正常使用所有工具

## 加载浏览器

在 Chrome 或其他 Chromium 浏览器中加载：

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `src/cdp_bridge/tmwd_cdp_bridge` 文件夹。

默认情况下，扩展会连接本地服务地址 `127.0.0.1:18765`。

## 配置 MCP

第一步，电脑上安装 `uv`。

### 脚本测试

```bash
uvx cdp-bridge@latest
uvx cdp-bridge@latest --transport stdio
uvx cdp-bridge@latest --transport streamable-http --port 3001
uv tool run cdp-bridge@latest # uvx不可用时
```

不传 `--transport` 时默认使用 `stdio`。使用 `streamable-http` 时默认端口为 `8000`，服务地址为 `http://127.0.0.1:<port>/mcp`。

### 标准配置
在 MCP 客户端中可以这样配置：
```json
{
  "mcpServers": {
    "cdp-bridge": {
      "command": "uvx",
      "args": ["cdp-bridge@latest"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add cdp-bridge uvx cdp-bridge@latest
```

### Codex

```bash
codex mcp add cdp-bridge uvx cdp-bridge@latest
```

### opencode
在`~/.config/opencode/opencode.json`里面配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cdp-bridge": {
      "type": "local",
      "command": [
        "uvx",
        "cdp-bridge@latest"
      ],
      "enabled": true
    }
  }
}

```

### OpenClaw

可以使用 OpenClaw CLI 写入 MCP 配置：

```bash
openclaw mcp set cdp-bridge '{"command":"uvx","args":["cdp-bridge@latest"]}'
```

等价配置结构如下：

```json
{
  "mcp": {
    "servers": {
      "cdp-bridge": {
        "command": "uvx",
        "args": ["cdp-bridge@latest"]
      }
    }
  }
}
```

### 注意事项

- 本项目需要 Python 3.10 或更高版本。
- 浏览器扩展内置自动重连机制：首次连接失败后会持续探测 WebSocket 服务（每 ~5 秒），当 MCP 服务启动后会自动恢复连接。如果看到 ERR_CONNECTION_REFUSED，等待数秒即可自动恢复。
- 页面自动化会运行在你的真实浏览器会话中，请只连接你信任的 MCP 客户端。

## 致谢

本项目的浏览器插件和部分代码参考并来源于 [GenericAgent](https://github.com/lsdefine/GenericAgent)。感谢原项目作者的开源工作。
