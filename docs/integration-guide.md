# 鸿蒙 PC 浏览器 Agent 接入文档

> 基于自研 `cdp-bridge-ohos` 方案。让任意支持 MCP 协议的 Agent 接管鸿蒙 PC 上的浏览器。
>
> 已在 **HUAWEI MateBook Pro / HarmonyOS 6 (API 26)** 上完成端到端实测。

---

## 1. 方案概览

### 1.1 为什么需要它

鸿蒙 PC 的浏览器（海泰内核 / 华为浏览器）未开放标准的 DevTools 远程调试端口，无法像 Chrome 那样 `--remote-debugging-port` 直连。本方案通过**浏览器扩展**作为操控入口，把能力封装为标准 MCP 协议暴露给 Agent。

### 1.2 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Agent（任意 MCP 客户端）                                    │
│  Claude Code / WorkBuddy / 自研 Agent / LangChain 等          │
└──────────────┬──────────────────────────────────────────────┘
               │ MCP (stdio, JSON-RPC 2.0)
               │ 17 个 browser_* 工具
┌──────────────▼──────────────────────────────────────────────┐
│  mcp-stdio.js（MCP Server）                                   │
│  零第三方依赖，纯 Node 内置模块                                 │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTP POST /link  (127.0.0.1:18766)
┌──────────────▼──────────────────────────────────────────────┐
│  bridge-server.js（桥接服务）                                  │
│  · :18766  控制面（给 MCP / CLI）                             │
│  · :18765  WebSocket（给浏览器扩展反向连接）                    │
└──────────────┬──────────────────────────────────────────────┘
               │ WebSocket ws://127.0.0.1:18765
               │ 扩展主动连入（服务端不主动外连，天然穿透防火墙）
┌──────────────▼──────────────────────────────────────────────┐
│  浏览器扩展「TH CDP Bridge」                                   │
│  · content script 通道（主力，不依赖 CDP）                     │
│  · chrome.scripting / executeScript（备选）                    │
└──────────────┬──────────────────────────────────────────────┘
               │ 原生 DOM API
┌──────────────▼──────────────────────────────────────────────┐
│  页面（含用户已登录的会话）                                     │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 关键设计决策

| 决策 | 理由 |
|---|---|
| **扩展反向 WS 连接** | 浏览器主动连出到 `127.0.0.1`，无需开放入站端口，规避企业防火墙/安全策略 |
| **content script 为主通道** | 国产内核上 `chrome.debugger` 永久挂起，CDP 不可用；content script 走原生 DOM API，兼容性最好 |
| **MCP 层零依赖** | 鸿蒙 OHOS 无法加载未签名的原生 `.so`（pydantic-core 等），故用 Node 内置模块重写 |
| **仅上报 http/https 标签页** | 空白页 / 内部页无注入价值，过滤后减少噪声 |

---

## 2. 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | HarmonyOS 6+ / OpenHarmony，aarch64 |
| 浏览器 | 支持 Chrome MV3 扩展的国产内核浏览器（海泰 / 华为浏览器，已实测） |
| Node.js | 建议 20+（实测 v24.13.0） |
| 端口 | `18765`（WS）、`18766`（控制面），需本机可用 |

---

## 3. 部署步骤

### 3.1 安装浏览器扩展

将 `extension/` 目录下的全部文件加载到浏览器扩展管理页（开发者模式 → 加载已解压的扩展程序）。

必需文件：

```
extension/
├── manifest.json        # MV3 清单
├── background.js        # Service Worker：WS 客户端 + 命令路由
├── content.js           # 内容脚本：DOM 命令执行引擎
├── config.js            # 桥接地址配置
├── disable_dialogs.js   # 屏蔽原生弹窗（避免自动化卡死）
├── popup.html / popup.js
└── icons/
```

`manifest.json` 权限声明：

```json
{
  "permissions": [
    "tabs", "activeTab", "debugger", "scripting",
    "alarms", "declarativeNetRequest", "management",
    "contentSettings", "storage"
  ],
  "host_permissions": ["<all_urls>"]
}
```

> **提示**：`declarativeNetRequest` 用于剥离页面 CSP 响应头，这是页面能执行注入脚本的前提。

### 3.2 部署桥接服务与 MCP Server

```
<部署目录>/
├── bridge-server.js      # 桥接服务
├── ws-mini.js            # 极简 WebSocket 实现（零依赖）
├── mcp-stdio.js          # MCP Server
├── extension/            # 浏览器扩展
└── oh-browser.js         # 可选：CLI 客户端
```

启动桥接服务（常驻）：

```bash
CDP_BRIDGE_WS_PORT=18765 CDP_BRIDGE_CTRL_PORT=18766 \
  node bridge-server.js
```

### 3.3 注册 MCP Server

#### 方式 A：作为 WorkBuddy / CodeBuddy 插件（推荐）

宿主以 `--strict-mcp-config` 启动 CLI，会屏蔽 `~/.workbuddy/mcp.json`（user scope）与项目级 `.mcp.json`，**只有插件声明的 MCP 会被加载**。因此标准做法是打包成插件。

插件目录结构：

```
<插件根>/                       # 如 .../plugins/cache/workbuddy-builtin/cdp-bridge-ohos/0.1.0
├── .codebuddy-plugin/
│   └── plugin.json             # 插件清单（含 mcpServers 声明）
└── mcp/
    ├── mcp-stdio.js            # MCP Server 实现
    ├── bridge-server.js        # 桥接服务
    ├── ws-mini.js              # WebSocket 实现
    └── cdp-bridge-ohos.json    # MCP server 声明（也会被自动收集）
```

宿主会依次读取以下位置并合并（`PluginMcpProvider`）：

1. `.codebuddy-plugin/plugin.json` 的 `mcpServers` 字段
2. 插件根目录的 `.mcp.json`
3. 插件根目录 `mcp/*.json` 下的所有 JSON 文件

`plugin.json` 示例：

```json
{
  "name": "cdp-bridge-ohos",
  "version": "0.1.0",
  "description": "鸿蒙 PC 浏览器 Agent 操控能力",
  "mcpServers": {
    "cdp-bridge-ohos": {
      "type": "stdio",
      "command": "node",
      "args": ["${CODEBUDDY_PLUGIN_ROOT}/mcp/mcp-stdio.js"],
      "env": {
        "CDP_BRIDGE_WS_PORT": "18765",
        "CDP_BRIDGE_CTRL_PORT": "18766"
      },
      "defer_loading": true
    }
  }
}
```

`${CODEBUDDY_PLUGIN_ROOT}` 与 `${CODEBUDDY_PLUGIN_DATA}` 会被宿主替换为实际路径。

注册到 marketplace 与已安装列表（`~/.workbuddy/plugins/`）：

```bash
# marketplace.json 追加条目
{ "name": "cdp-bridge-ohos", "source": "./cdp-bridge-ohos/0.1.0",
  "version": "0.1.0", "category": "builtin-plugin" }

# installed_plugins.json 追加条目（结构为 plugins.<name>@<marketplace> 的数组）
{ "scope": "user", "installPath": "<插件根绝对路径>",
  "version": "0.1.0", "installedAt": "<ISO时间>", "lastUpdated": "<ISO时间>" }

# settings.json 启用
{ "enabledPlugins": { "cdp-bridge-ohos@workbuddy-builtin": true } }
```

#### 方式 B：通用 MCP 客户端

任何支持 MCP 的宿主（Claude Code、Cursor、自研 Agent）直接用 stdio 配置即可：

```json
{
  "mcpServers": {
    "cdp-bridge-ohos": {
      "command": "node",
      "args": ["/path/to/mcp-stdio.js"],
      "env": {
        "CDP_BRIDGE_WS_PORT": "18765",
        "CDP_BRIDGE_CTRL_PORT": "18766"
      }
    }
  }
}
```

> **注意**：`mcp-stdio.js` 会在首次调用时自动拉起 `bridge-server.js`（detached 方式），因此通常无需手动常驻。

#### 方式 C：CodeBuddy CLI 直接指定

```bash
codebuddy --mcp-config ./mcp.json -p "列出可用的浏览器工具"
```

> `mcp list` 子命令不接受 `--mcp-config` / `--plugin-dir` 等全局选项，需用 `-p` 等业务命令验证。


### 3.4 验证连通性

```bash
# 1) 桥接服务存活
curl -s http://127.0.0.1:18765
# {"service":"cdp-bridge-ohos","ok":true,"connections":1,"tabs":1}

# 2) MCP 协议握手
node -e "
const {spawn}=require('child_process');
const c=spawn('node',['mcp-stdio.js'],{stdio:['pipe','pipe','inherit']});
let b='';c.stdout.on('data',d=>{b+=d;let i;
  while((i=b.indexOf('\n'))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);
    if(l){const m=JSON.parse(l);
      if(m.id===1){c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n')}
      else if(m.id===2){console.log('工具数:',m.result.tools.length);c.kill();process.exit(0)}}}});
c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'probe',version:'1'}}})+'\n');
"
```

---

## 4. 工具清单（17 个）

### 4.1 页面感知

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `browser_get_tabs` | 列出所有可操控标签页（ID / URL / 标题） | — |
| `browser_status` | 检查扩展连接状态与标签页数 | — |
| `browser_scan` | 获取当前页简化 HTML（已为 LLM 优化，元素带 `wd-i` 索引）+ 标签页列表 | `switch_tab_id` `text_only` `maxchars` `tabs_only` |
| `browser_query` | 按 CSS 选择器查询元素，返回 tag / 文本 / value / href / 边界坐标 | `selector` `limit` `tab_id` `timeout` |
| `browser_dom` | 直接执行结构化 DOM 命令（原生 API，无 eval） | `action` `args` `tab_id` `timeout` |

`browser_dom` 支持的 action：`read_page` / `query` / `click` / `type` / `scroll` / `scroll_to` / `navigate` / `wait_for` / `get_meta`

### 4.2 交互操作

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `browser_click` | 按选择器点击元素 | `selector` `index` `tab_id` `timeout` |
| `browser_type` | 向输入框填字（原生 value setter + input/change 事件，兼容 React/Vue） | `selector` `text` `index` `clear` `enter` |
| `browser_scroll` | 滚动页面 | `x` `y` `top` `tab_id` |
| `browser_navigate` | 当前标签页跳转 URL | `url` |
| `browser_wait` | 轮询直到 JS 条件为真 | `condition_js` `timeout` `interval` |
| `browser_wait_for` | 轮询直到选择器匹配的元素出现 | `selector` `timeout` `tab_id` |

### 4.3 标签页管理

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `browser_switch_tab` | 切换 Agent 侧的活动标签页（不改变用户可见焦点） | `tab_id` |
| `browser_focus_tab` | 激活标签页**并**聚焦浏览器窗口（用户可见） | `tab_id` |

### 4.4 高级 / 调试

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `browser_execute_js` | 在页面 MAIN world 执行 JS（可访问页面全局与登录态） | `script` `switch_tab_id` `no_monitor` `timeout` |
| `browser_batch` | 批量执行 CDP / 扩展命令 | `commands` `tab_id` `timeout` |
| `browser_screenshot` | 截图，返回 base64 PNG | `tab_id` |
| `browser_save_image` | 将 base64 截图落盘为 PNG 文件 | `screenshot_json_str_or_file` `output_path` |

---

## 5. 协议规范

### 5.1 MCP 层（Agent ↔ mcp-stdio.js）

标准 JSON-RPC 2.0 over stdio，支持协议版本 `2024-11-05` / `2025-03-26` / `2025-06-18`。

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"cdp-bridge-ohos","version":"1.0.0"}}}

→ {"jsonrpc":"2.0","method":"notifications/initialized"}
→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[{name,description,inputSchema}, ...]}}

→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_get_tabs","arguments":{}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"tabs\":[...]}"}]}}
```

### 5.2 控制面（mcp-stdio.js ↔ bridge-server.js）

HTTP POST `http://127.0.0.1:18766/link`，JSON body。

| cmd | 用途 | 关键字段 |
|---|---|---|
| `status` | 连接数与标签页数 | — |
| `get_all_sessions` | 全部活动会话 | — |
| `find_session` | 按 URL 子串查找会话 | `url_pattern` |
| `set_default` | 设置 token 的默认标签页 | `sessionId` |
| `execute_js` | 向标签页下发命令 | `code` `sessionId` `token` `timeout` |

`code` 可以是：

- **JS 字符串** → 走 content script eval 通道
- **JSON 对象字符串** → 走结构化命令通道，如
  `{"__dom":true,"action":"read_page","args":{}}` / `{"cmd":"tabs","method":"create","url":"..."}` / `{"cmd":"capture"}`

### 5.3 扩展通道（bridge-server.js ↔ 扩展）

WebSocket `ws://127.0.0.1:18765`。

```
扩展 → 服务端：
  {"type":"ext_ready","tabs":[{"id","url","title"}],"token":"..."}
  {"type":"tabs_update","tabs":[...]}
  {"type":"ack","id":"..."}
  {"type":"result","id":"...","result":...,"newTabs":[...]}
  {"type":"error","id":"...","error":...}
  {"type":"ping"}

服务端 → 扩展：
  {"id":"<execId>","code":"<JS字符串或JSON对象字符串>","tabId":123,"timeout":15}
```

---

## 6. 使用范式

### 6.1 典型 Agent 循环

```
1. browser_get_tabs          → 拿到 tabId 列表
2. browser_scan              → 理解当前页面结构（元素带 wd-i 索引）
3. browser_query(selector)   → 精确定位目标元素，拿到 index
4. browser_click / browser_type  → 执行动作
5. browser_wait_for(sel)     → 等待页面响应
6. 循环
```

### 6.2 严格 CSP 页面

部分内网系统（如统一认证平台）有严格 CSP，会阻止 `eval` / 内联脚本。此时**必须**用结构化工具：

```
browser_dom { action: "read_page", args: { text_only: true } }
browser_dom { action: "query",    args: { selector: "#p_username" } }
browser_dom { action: "type",     args: { selector: "#p_username", text: "xxx" } }
```

而非 `browser_execute_js`（后者依赖 eval，会失败）。

### 6.3 跨标签页操作

```
browser_switch_tab { tab_id: "71132590" }   # 切 Agent 侧上下文
browser_query { selector: "input", tab_id: "71132590" }
```

---

## 7. 已知限制

### 7.1 国产内核限制（重要）

| 能力 | 状态 | 说明 |
|---|---|---|
| `chrome.debugger`（CDP） | **不可用** | `debugger.attach` 永久挂起（6s 超时）。CDP 系工具 `browser_batch` 中的 cdp 子命令、`Page.close` 等会失败 |
| `chrome.scripting` | 可用（不稳定） | 部分内核上会挂起，扩展已内置自动降级与记忆 |
| `chrome.tabs.executeScript` | 可用 | 扩展的首选执行路径 |
| content script 通道 | **可用（推荐）** | 所有 `browser_dom` / `browser_query` / `browser_click` / `browser_type` 都走这条 |
| `chrome.tabs.remove` | 可用 | 已封装为 `tabs.close` 命令 |
| `chrome.tabs.create` | 会挂起 | 扩展已内置三级降级：`tabs.create` → `windows.create` → 当前标签页原地跳转 |

### 7.2 环境限制

- **仅 http/https 标签页可见**：`about:`、`chrome://` 等内部页会被过滤，不出现在 `browser_get_tabs` 中
- **无头场景不可用**：必须先在浏览器里打开至少一个 http/https 页面，否则 `tabs` 为 0
- **系统级 UI 不可控**：本方案只覆盖浏览器内操作。操控鸿蒙原生应用窗口需要另外的手段（如 `uitest` 框架、hdc 通道），且受沙箱权限限制

### 7.3 沙箱权限

在 WorkBuddy 沙箱模式下，宿主进程的可读范围受限于当前用户 UID：

- `ps` 只能看到本 UID 的进程
- `/data/storage/el2/base/bundle`（浏览器数据目录）不可读
- `hidumper` / `aa` / `param` 等系统工具多为 `Permission denied`

这些**不影响**本方案运行 —— 桥接完全走 `127.0.0.1` 回环 + 扩展通道。

---

## 8. 运维

### 8.1 排障速查表

按现象定位根因：

| 现象 | 根因 | 处理 |
|---|---|---|
| `tools/list` 正常，但调用报 `No browser tabs connected` | 扩展未连上桥接服务 | 查 `curl http://127.0.0.1:18765`，`connections` 应 ≥1；见 8.2 |
| `curl :18765` 返回 `connections: 0, tabs: 0` | 扩展已连但浏览器无 http 页面 | 在浏览器打开任意 http/https 页面（空白页会被过滤） |
| `curl :18765` 返回 `connections: 0` | 扩展 Service Worker 被冻结 | 在浏览器里切一下标签页唤醒；见 8.2 |
| `curl :18765` 连接被拒 | 桥接服务未启动 | 启动 `node bridge-server.js`，或让 MCP server 自动拉起 |
| 改了扩展代码但行为没变 | 改的不是浏览器实际加载的目录 | 见 8.3 反查真实路径 |
| 宿主里看不到 `mcp__cdp-bridge-ohos__*` 工具 | 宿主以 `--strict-mcp-config` 启动，屏蔽了 user scope | 必须走插件声明；见 3.3 方式 A |
| `tools/list` 少工具 / 工具报未知 | MCP server 协议异常 | 用 `verify-mcp.js` 独立验证 |
| `browser_execute_js` 失败但 `browser_dom` 正常 | 页面有严格 CSP，eval 被拦 | 改用 `browser_dom` 结构化命令 |
| `browser_batch` 里的 cdp 子命令失败 | 国产内核 `chrome.debugger` 永久挂起 | 改用 content script 通道 |

### 8.2 扩展 Service Worker 冻结问题

**现象**：桥接服务重启后，扩展不再自动重连，`connections` 恒为 0。

**根因**：MV3 的 Service Worker 空闲会被冻结，`chrome.alarms` 定时器随之停摆，导致重连探针不再执行。

**已内置的修复**（本方案的扩展已包含）：监听浏览器事件作为唤醒源。

```js
function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws && ws.readyState <= 1) return;   // 正在连接中
  connectWS();
}
chrome.tabs.onActivated.addListener(() => ensureConnected());
chrome.tabs.onUpdated.addListener(() => ensureConnected());
chrome.tabs.onCreated.addListener(() => ensureConnected());
chrome.tabs.onRemoved.addListener(() => ensureConnected());
chrome.windows.onFocusChanged.addListener(() => ensureConnected());
```

**临时兜底**：手动在浏览器里切一下标签页即可唤醒（`ensureConnected` 会立即重连）。

### 8.3 扩展代码更新流程

浏览器加载的是**磁盘上的实体目录**，改完代码必须重载扩展才生效：

```
1. 编辑 <扩展目录>/background.js
2. 触发扩展自重载（扩展已连接时）：
   curl -s -X POST http://127.0.0.1:18766/link \
     -H 'Content-Type: application/json' \
     -d '{"cmd":"execute_js","code":"{\"cmd\":\"management\",\"method\":\"reload\"}","sessionId":"<任一tabId>"}'
   （扩展会自行 chrome.runtime.reload()）
3. 等待 ~15s，扩展自动重连
```

> **注意**：若存在多份扩展副本，改错目录不会有任何效果。
>
> **排查方法**：未打包扩展的 ID 由**绝对路径**决定 —— 取 `sha256(绝对路径)` 的前 16 字节，每字节拆成两个 nibble，分别映射到 `'a' + nibble`，拼成 32 位小写字符串。
>
> ```js
> const id = (p) => {
>   const h = require('crypto').createHash('sha256').update(p).digest();
>   let s = '';
>   for (let i = 0; i < 16; i++) { s += String.fromCharCode(97 + (h[i] >> 4)); s += String.fromCharCode(97 + (h[i] & 15)); }
>   return s;
> };
> ```
>
> 先用扩展的 `management.list` 命令拿到实际 ID，再反查真实路径。

### 8.4 日志

| 文件 | 内容 |
|---|---|
| `bridge.log` | 桥接服务：WS 连接、标签页同步、命令下发与结果 |
| `mcp.log` | MCP Server：启动、stdin 关闭、工具错误 |

### 8.5 健康检查

```bash
# 桥接 + 扩展 + 标签页 三层状态
curl -s http://127.0.0.1:18765
# {"service":"cdp-bridge-ohos","ok":true,"connections":1,"tabs":1}
#         ok=true  → 桥接服务存活
#     connections≥1 → 扩展已连上
#          tabs≥1   → 有可操控页面
```


---

## 9. 目录清单

### 9.1 插件包（对外交付物）

```
cdp-bridge-ohos/
├── .codebuddy-plugin/
│   └── plugin.json              # 插件清单 + mcpServers 声明
└── mcp/
    ├── mcp-stdio.js             # MCP Server（stdio），17 个工具
    ├── bridge-server.js         # 桥接服务，WS + 控制面
    ├── ws-mini.js               # 极简 WebSocket 服务端（零依赖）
    └── cdp-bridge-ohos.json     # MCP server 声明
```

### 9.2 浏览器扩展

```
extension/
├── manifest.json                # MV3 清单
├── background.js                # Service Worker：WS 客户端 + 命令路由 + 唤醒逻辑
├── content.js                   # 内容脚本：DOM 命令执行引擎
├── config.js                    # 桥接地址配置
├── disable_dialogs.js           # 屏蔽原生弹窗（避免自动化卡死）
├── popup.html / popup.js
└── icons/
```

### 9.3 开发辅助

| 文件 | 说明 |
|---|---|
| `oh-browser.js` | CLI 客户端，便于脚本化与调试 |
| `verify-mcp.js` | MCP 协议端到端自检（initialize → tools/list → tools/call） |

### 9.4 CLI 用法

```bash
node oh-browser.js tabs                      # 列出标签页
node oh-browser.js meta                      # 读元信息
node oh-browser.js read 3000                 # 读页面正文
node oh-browser.js query "a, button"         # 查询元素
node oh-browser.js click "#submit"            # 点击
node oh-browser.js type "#username" "hello"  # 输入
node oh-browser.js shot out.png              # 截图
node oh-browser.js open "https://example.com"# 新开标签页
node oh-browser.js close <tabId>             # 关闭标签页
node oh-browser.js scroll 800                # 滚动
node oh-browser.js reload                    # 刷新
```

---

## 10. 部署检查清单

上线前逐项确认：

- [ ] 浏览器扩展已加载，`chrome.management.getAll()` 能看到「TH CDP Bridge」且 `enabled: true`
- [ ] `curl http://127.0.0.1:18765` 返回 `ok: true`
- [ ] 浏览器已打开至少一个 http/https 页面（`tabs` ≥ 1）
- [ ] `curl http://127.0.0.1:18765` 返回 `connections: 1`
- [ ] MCP server 独立自检通过（`tools/list` 返回 17 个工具）
- [ ] 宿主内 `mcp__cdp-bridge-ohos__browser_get_tabs` 可调用并返回真实标签页
- [ ] 内网系统（含严格 CSP 页面）验证：`browser_dom` 可读、`browser_execute_js` 预期失败
- [ ] 涉及写操作时，确认 `browser_type` 的 `clear` 语义与目标表单一致

---

## 11. 与系统级 Agent 平台的关系

本方案与各类系统级 Agent 开放平台在**架构同构**，可作为技术验证或私有部署的替代路径：

| 维度 | 系统级开放平台 | 本方案 |
|---|---|---|
| 能力暴露方式 | 平台 Skill / 系统能力开放 | 浏览器扩展 + 结构化 DOM 命令 |
| Agent 接入协议 | MCP / A2A | MCP（stdio JSON-RPC 2.0） |
| 部署形态 | 云侧托管 | 端侧本地，浏览器内闭环 |
| 适用场景 | 系统级、跨应用、规模化 | 内网系统自动化、浏览器内任务 |
| 鉴权 | 平台账号体系 | 本机回环，无外部暴露 |

**互操作路径**：本方案的 MCP Server 可直接作为 MCP 客户端接入任意支持 MCP 的平台；也可反向将平台 Skill 暴露为 MCP 工具供本方案的 Agent 调用。两者通过 MCP 协议对接，无需改造内部实现。

**选型建议**：

- 只做浏览器内自动化、要求零外部依赖、数据不出本机 → 用本方案
- 需要跨应用、跨设备的系统级能力，或需要规模化托管 → 用系统级平台
- 两者结合 → 本方案作为 MCP 服务端接入平台，与平台能力组合

