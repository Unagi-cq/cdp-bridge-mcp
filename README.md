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
中文 | <a href="./doc/README_EN.md">English</a>
</p>

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

## 可用工具

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

# 如何使用

## 安装步骤

1. 将项目中提供的浏览器插件 `src/cdp_bridge/tmwd_cdp_bridge` 文件夹加载到 Chrome 或其他 Chromium 浏览器
2. 在MCP客户端配置CDP Bridge MCP

然后就可以正常使用了。下面详细介绍上述安装步骤。

## 加载浏览器

在 Chrome 或其他 Chromium 浏览器中加载：

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `src/cdp_bridge/tmwd_cdp_bridge` 文件夹。

默认情况下，扩展会连接本地服务地址 `127.0.0.1:18765`。

## 配置 MCP

第一步，电脑上安装 `uv`。

> uvx 是在 uv 的 0.2.0 版本中才正式引入的。 如果你安装的 uv 版本低于 0.2.0，那么系统中就没有 uvx 这个命令。在旧版本中，类似的功能可能需要通过 uv tool run 来实现（这也是 uvx 的底层实现方式）。

### 脚本测试

```bash
uvx cdp-bridge # uv >= 0.2.0
uv tool run # uv < 0.2.0
```
### 标准配置
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

### Claude Code

```bash
claude mcp add cdp-bridge uvx cdp-bridge
```

### Codex

```bash
codex mcp add cdp-bridge uvx cdp-bridge
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
        "cdp-bridge"
      ],
      "enabled": true
    }
  }
}

```

### 注意事项

- 本项目需要 Python 3.12 或更高版本。
- 浏览器扩展需要和 MCP Server 同时运行，否则工具会提示没有连接的浏览器标签页。
- 页面自动化会运行在你的真实浏览器会话中，请只连接你信任的 MCP 客户端。
