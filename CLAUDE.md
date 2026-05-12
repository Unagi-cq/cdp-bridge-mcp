# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
# 以 MCP stdio 服务方式运行（主要使用方式）
uvx cdp-bridge@latest

# 获取扩展目录路径（用于手动加载到浏览器）
uvx cdp-bridge-extension-path@latest  # 或: python -m cdp_bridge extension_path

# 本地开发：安装依赖并运行
uv sync
uv run cdp-bridge

# 构建 PyPI 分发包
uv build
```

项目没有测试、lint 配置和 CI/CD。

## 架构

CDP Bridge MCP 让 LLM 客户端连接**用户正在使用的真实浏览器**，而非无头自动化实例。用户加载 Chromium 扩展（`tmwd_cdp_bridge/`），然后 MCP 服务将工具调用桥接为浏览器内的 JS 执行。

**启动链路** → 控制台脚本 `cdp_bridge:main` → `mcp.run()` 启动 FastMCP stdio 服务。

**`server.py`** — 定义 9 个 MCP 工具（`browser_get_tabs`、`browser_scan`、`browser_execute_js`、`browser_switch_tab`、`browser_batch`、`browser_wait`、`browser_navigate`、`browser_screenshot`、`browser_cookies`）。所有工具用 `asyncio.to_thread()` 包裹同步代码。注意：工具在每次调用前通过 `importlib.reload(simphtml)` 重载模块，这样无需重启服务就能更新浏览器内 JS 辅助代码。

**`TMWebDriver.py`** — 核心桥接层。管理通过 WebSocket（`127.0.0.1:18765`）或 HTTP 长轮询（`:18766`）连接的浏览器会话。每个 `Session` 跟踪一个标签页（url、连接类型、活跃状态）。三种连接模式：
- `ws` — 扩展直连 WebSocket
- `ext_ws` — 扩展 WebSocket，带标签页级别的追踪（`tabs_update` 广播）
- `http` — HTTP 长轮询降级方案

也可在 `is_remote` 模式下运行，通过 HTTP 代理到另一 TMWebDriver 实例。

**`simphtml.py`** — 浏览器内 HTML 优化。包含大型嵌入式 JS 代码块（`optHTML()` — 去除脚本/样式/不可见元素并对页面区域分类；`findMainList()` — 检测重复内容列表；`smart_truncate()` — 基于 token 预算的 HTML 截断）。Python 侧用 BeautifulSoup 做后处理（属性清理、列表截断、`execute_js_rich()` 的 DOM 变更 diff）。

**`tmwd_cdp_bridge/`** — Chrome 扩展：`background.js`（WebSocket 连接 + 约每 5 秒自动重连）、`content.js`（页面内脚本执行）、`popup.html/js`（扩展工具栏界面）。

**`sop/`** — 扩展 CDP 能力和 Vue3 组件处理的标准操作文档。

## 关键约定

- **日志必须走 stderr**：用 `log()`（在 `TMWebDriver.py` 和 `simphtml.py` 中已定义）输出所有诊断信息。stdout 仅用于 MCP JSON-RPC 消息，任何 `print()` 写到 stdout 都会污染 MCP 协议流，导致客户端报 `Transport closed` 错误。
- 会话 ID 就是 Chrome 标签页 ID（字符串类型）。`default_session_id` 标识当前 MCP 工具操作的目标标签页。
- `execute_js()` 有约 15 秒超时，并跟踪 ACK 确认——能区分"脚本未送达"和"脚本已送达但尚无结果"。
