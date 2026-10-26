# cdp-bridge-ohos

**Let any MCP agent take control of the browser on HarmonyOS PC.**

Domestic Chromium-based kernels (Haitai / Huawei Browser and similar) do not expose a DevTools remote debugging port, so agents cannot drive pages the way they would with Chrome. This project fills that gap with a **browser extension + the MCP protocol**: agents read pages, click elements, fill forms, take screenshots and manage tabs through standard MCP tools.

Verified end-to-end on **HUAWEI MateBook Pro / HarmonyOS 6 (API 26)**.

```
Agent ──MCP(stdio)──▶ mcp-stdio.js ──HTTP:18766──▶ bridge-server.js
                                                              │
                                                    WebSocket:18765
                                                              │
                                                              ▼
                                                   Browser extension (MV3)
                                                              │
                                                              ▼
                                                          Page DOM
```

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Tool Catalogue](#tool-catalogue)
- [Architecture](#architecture)
- [Domestic Kernel Compatibility](#domestic-kernel-compatibility)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Features

- **Zero third-party dependencies** — the MCP server and bridge service use only Node.js built-ins. HarmonyOS OHOS cannot load unsigned native `.so` libraries (e.g. `pydantic-core`), so this implementation is a pure-JS rewrite.
- **17 MCP tools** — page reading, element queries, clicking, typing, scrolling, screenshots, tab management and batch commands.
- **Reuses your logged-in session** — operates directly inside the browser you are already signed in to; credentials are never touched.
- **Outbound-only connection** — the extension dials back over WebSocket to `127.0.0.1`, so no inbound port has to be opened and enterprise firewall policies stay happy.
- **CSP friendly** — structured DOM commands use native DOM APIs instead of `eval`, so they work even on strict-CSP intranet systems.
- **Graceful degradation** — probes for and works around APIs that hang on particular kernels.

---

## Quick Start

### 1. Install the browser extension

Enable "Developer mode" in your browser's extension management page and load the `extension/` directory.

> If your browser does not expose a developer mode, check its extension management documentation. The extension needs the `tabs`, `scripting`, `alarms`, `declarativeNetRequest` and `storage` permissions.

### 2. Start the bridge service

```bash
cd mcp
node bridge-server.js
```

Or let the MCP server spawn it on demand (recommended — no manual daemon):

```bash
node mcp/mcp-stdio.js
```

### 3. Connect your agent

#### Any MCP client

```json
{
  "mcpServers": {
    "cdp-bridge-ohos": {
      "command": "node",
      "args": ["/abs/path/to/mcp/mcp-stdio.js"],
      "env": {
        "CDP_BRIDGE_WS_PORT": "18765",
        "CDP_BRIDGE_CTRL_PORT": "18766"
      }
    }
  }
}
```

#### WorkBuddy / CodeBuddy

The host launches the CLI with `--strict-mcp-config`, which disables the `user` scope (`~/.workbuddy/mcp.json`) and the project-level `.mcp.json` — **only plugin-declared MCP servers are loaded**. So install it as a plugin:

```
<plugin root>/
├── .codebuddy-plugin/plugin.json     # contains the mcpServers declaration
└── mcp/
    ├── mcp-stdio.js
    ├── bridge-server.js
    ├── ws-mini.js
    └── cdp-bridge-ohos.json
```

The host reads, in order: the `mcpServers` field of `.codebuddy-plugin/plugin.json`, the plugin root's `.mcp.json`, and every `mcp/*.json` under the plugin root.

`plugin.json` example:

```json
{
  "name": "cdp-bridge-ohos",
  "version": "0.2.0",
  "description": "Browser control for agents on HarmonyOS PC",
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

> Prefer `node` (relies on `PATH`); use an absolute path if Node is not on `PATH`.

### 4. Verify

```bash
node scripts/verify-mcp.js
```

```
cdp-bridge-ohos MCP self-check
  server: /path/to/mcp/mcp-stdio.js

  PASS  initialize handshake  ->  cdp-bridge-ohos v1.0.0
  PASS  tools/list returns tools  ->  17
  PASS  all key tools present  ->  all 17 in place
  PASS  bridge service online  ->  ok=true
  PASS  extension connected  ->  connections=1
  PASS  controllable tabs  ->  1: Example Domain

All checks passed ✓
```

### 5. Use it

Open any **http/https page** in the browser (the extension only reports those), then:

```
Agent: open example.com and read the title and every link
  → browser_navigate { "url": "https://example.com" }
  → browser_wait { "condition_js": "location.href.indexOf('example.com') !== -1" }
  → browser_scan { "text_only": true }
```

> **Pitfall**: do not wait on `document.readyState === 'complete'` right after `browser_navigate` — navigation is asynchronous, and the *old* page is already `complete`, so the condition passes immediately and you end up reading stale content. Wait for the URL to change first.

---

## Tool Catalogue

### Page perception

| Tool | Purpose | Key parameters |
|---|---|---|
| `browser_get_tabs` | List all controllable tabs (ID / URL / title) | — |
| `browser_status` | Check extension connection state and tab count | — |
| `browser_scan` | Simplified HTML of the current page (LLM-optimised, elements tagged with `wd-i`) plus the tab list | `switch_tab_id` `text_only` `maxchars` `tabs_only` |
| `browser_query` | Query elements by CSS selector; returns tag / text / value / href / bounding rect | `selector` `limit` `tab_id` `timeout` |
| `browser_dom` | Run a structured DOM command (native APIs, no eval) | `action` `args` `tab_id` `timeout` |

Supported `browser_dom` actions: `read_page` / `query` / `click` / `type` / `scroll` / `scroll_to` / `navigate` / `wait_for` / `get_meta`

### Interaction

| Tool | Purpose | Key parameters |
|---|---|---|
| `browser_click` | Click an element by CSS selector | `selector` `index` `tab_id` `timeout` |
| `browser_type` | Type into an input/textarea (native value setter + input/change events, works with React/Vue) | `selector` `text` `index` `clear` `enter` |
| `browser_scroll` | Scroll the page | `x` `y` `top` `tab_id` |
| `browser_navigate` | Navigate the current tab to a URL | `url` |
| `browser_wait` | Poll until a JS condition is truthy | `condition_js` `timeout` `interval` |
| `browser_wait_for` | Poll until a selector matches an element | `selector` `timeout` `tab_id` |

### Tab management

| Tool | Purpose | Key parameters |
|---|---|---|
| `browser_switch_tab` | Switch the agent-side active tab (does not change the user's visible focus) | `tab_id` |
| `browser_focus_tab` | Activate a tab **and** focus the browser window (visible to the user) | `tab_id` |

### Advanced / debugging

| Tool | Purpose | Key parameters |
|---|---|---|
| `browser_execute_js` | Run JS in the page MAIN world (full access to page globals and your logged-in session) | `script` `switch_tab_id` `no_monitor` `timeout` |
| `browser_batch` | Run multiple extension commands in one request | `commands` `tab_id` `timeout` |
| `browser_screenshot` | Capture a screenshot, returns base64 PNG | `tab_id` |
| `browser_save_image` | Write base64 screenshot data to a PNG file | `screenshot_json_str_or_file` `output_path` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Agent (any MCP client)                                      │
└──────────────┬──────────────────────────────────────────────┘
               │ MCP (stdio, JSON-RPC 2.0) · 17 browser_* tools
┌──────────────▼──────────────────────────────────────────────┐
│  mcp/mcp-stdio.js (MCP Server)                                │
│  Zero third-party dependencies, Node built-ins only          │
└──────────────┬──────────────────────────────────────────────┘
               │ HTTP POST /link  (127.0.0.1:18766)
┌──────────────▼──────────────────────────────────────────────┐
│  mcp/bridge-server.js (bridge service)                       │
│  · :18766  control plane (for MCP / CLI)                     │
│  · :18765  WebSocket (extension dials in)                    │
└──────────────┬──────────────────────────────────────────────┘
               │ ws://127.0.0.1:18765
┌──────────────▼──────────────────────────────────────────────┐
│  extension/ (MV3 browser extension)                          │
│  · content script channel (primary, no CDP needed)           │
│  · chrome.scripting / executeScript (fallback)               │
└──────────────┬──────────────────────────────────────────────┘
               │ native DOM APIs
┌──────────────▼──────────────────────────────────────────────┐
│  The page (including your logged-in session)                 │
└─────────────────────────────────────────────────────────────┘
```

### Design decisions

| Decision | Why |
|---|---|
| Extension dials in over WebSocket | The browser connects out to `127.0.0.1`, so no inbound port is needed |
| Content script as the primary channel | `chrome.debugger` hangs forever on domestic kernels, so CDP is unusable |
| Zero-dependency MCP layer | OHOS cannot load unsigned native `.so` libraries |
| Only http/https tabs are reported | Internal and blank pages have no injection value |

### Directory layout

```
.
├── extension/                  # Browser extension (MV3)
│   ├── manifest.json
│   ├── background.js           # Service Worker: WS client + command routing
│   ├── content.js              # Content script: DOM command engine
│   ├── config.js               # Bridge address configuration
│   ├── disable_dialogs.js      # Suppress native dialogs (avoids automation stalls)
│   └── icons/
├── mcp/                        # MCP server and bridge service
│   ├── mcp-stdio.js            # MCP server, 17 tools
│   ├── bridge-server.js        # Bridge service (WS + control plane)
│   ├── ws-mini.js              # Minimal WebSocket server (zero deps)
│   └── cdp-bridge-ohos.json    # MCP server declaration
├── scripts/
│   ├── oh-browser.js           # CLI client
│   └── verify-mcp.js           # End-to-end self-check
└── docs/
    └── integration-guide.md    # Full integration guide (Chinese)
```

---

## Domestic Kernel Compatibility

Domestic Chromium kernels differ significantly in which Chrome extension APIs they support. Measured behaviour:

| Capability | Status | Notes |
|---|---|---|
| `chrome.debugger` (CDP) | **Unavailable** | `debugger.attach` hangs forever (6s timeout). CDP commands fail |
| `chrome.scripting` | Unstable | Hangs on some kernels; the extension auto-degrades and remembers |
| `chrome.tabs.executeScript` | Available | The extension's preferred execution path |
| Content script channel | **Available (recommended)** | All DOM-oriented tools use this |
| `chrome.tabs.remove` | Available | Exposed as the `tabs.close` command |
| `chrome.tabs.create` | Hangs | Three-level fallback: `tabs.create` → `windows.create` → in-place navigation |

### Strict-CSP pages

Some intranet systems enforce a strict CSP that blocks `eval` and inline scripts. Use the structured tools there:

```
browser_dom { action: "read_page", args: { text_only: true } }
browser_dom { action: "query",    args: { selector: "#username" } }
browser_dom { action: "type",     args: { selector: "#username", text: "..." } }
```

`browser_execute_js` will fail on such pages because it relies on `eval`.

### Service worker freezing

MV3 service workers are frozen when idle, which also stops `chrome.alarms` — after the bridge service restarts, the extension may fail to reconnect on its own. The extension in this project ships wake-up hooks:

```js
chrome.tabs.onActivated.addListener(() => ensureConnected());
chrome.tabs.onUpdated.addListener(() => ensureConnected());
chrome.tabs.onCreated.addListener(() => ensureConnected());
chrome.tabs.onRemoved.addListener(() => ensureConnected());
chrome.windows.onFocusChanged.addListener(() => ensureConnected());
```

**Workaround**: switch tabs in the browser once to wake it up.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No browser tabs connected` | Extension not connected to the bridge | `curl http://127.0.0.1:18765` — `connections` should be ≥1 |
| `connections: 0, tabs: 0` | Extension connected but no http page open | Open any http/https page |
| `connections: 0` | Extension service worker frozen | Switch tabs in the browser to wake it |
| `curl :18765` refused | Bridge service not running | Start `node mcp/bridge-server.js` |
| Extension code changes have no effect | Editing the wrong copy | See "Locating the real extension path" below |
| No `mcp__cdp-bridge-ohos__*` tools in the host | Host uses `--strict-mcp-config`, disabling user scope | Use the plugin declaration |
| `browser_execute_js` fails but `browser_dom` works | Strict CSP on the page | Switch to `browser_dom` |
| `browser_batch` cdp sub-commands fail | `chrome.debugger` hangs on that kernel | Use the content script channel |

### Health check

```bash
curl -s http://127.0.0.1:18765
# {"service":"cdp-bridge-ohos","ok":true,"connections":1,"tabs":1}
#         ok=true      → bridge service alive
#     connections≥1     → extension connected
#          tabs≥1       → controllable page available
```

### Locating the real extension path

An unpacked extension's ID is derived from its **absolute path**: take the first 16 bytes of `sha256(absolute_path)`, split each byte into two nibbles, map each to `'a' + nibble`, and concatenate into a 32-character lowercase string:

```js
const id = (p) => {
  const h = require('crypto').createHash('sha256').update(p).digest();
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += String.fromCharCode(97 + (h[i] >> 4));
    s += String.fromCharCode(97 + (h[i] & 15));
  }
  return s;
};
```

Get the actual ID from the extension popup or `chrome.management.getAll()`, then match it back to a path. Editing the wrong copy has no effect whatsoever.

### Reloading the extension after a code change

```
1. Edit extension/background.js
2. Trigger a self-reload (while the extension is connected):
   curl -s -X POST http://127.0.0.1:18766/link \
     -H 'Content-Type: application/json' \
     -d '{"cmd":"execute_js","code":"{\"cmd\":\"management\",\"method\":\"reload\"}","sessionId":"<any tabId>"}'
3. Wait ~15s for the extension to reconnect
```

### Logs

| File | Contents |
|---|---|
| `mcp/bridge.log` | Bridge service: WS connections, tab syncs, command dispatch and results |
| `mcp/mcp.log` | MCP server: startup, stdin close, tool errors |

---

## Development

### CLI

```bash
node scripts/oh-browser.js tabs                      # list tabs
node scripts/oh-browser.js meta                      # read metadata
node scripts/oh-browser.js read 3000                 # read page text
node scripts/oh-browser.js query "a, button"         # query elements
node scripts/oh-browser.js click "#submit"            # click
node scripts/oh-browser.js type "#username" "hello"  # type
node scripts/oh-browser.js shot out.png              # screenshot
node scripts/oh-browser.js open "https://example.com"# open a new tab
node scripts/oh-browser.js close <tabId>             # close a tab
node scripts/oh-browser.js scroll 800                # scroll
node scripts/oh-browser.js reload                    # reload
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CDP_BRIDGE_WS_PORT` | `18765` | Extension WebSocket port |
| `CDP_BRIDGE_CTRL_PORT` | `18766` | Control plane HTTP port |
| `CDP_BRIDGE_LOG` | `mcp/bridge.log` | Bridge service log path |
| `CDP_BRIDGE_MCP_DIR` | `mcp/` | MCP directory used by `verify-mcp.js` |
| `CDP_BRIDGE_DIR` | `mcp/` | Bridge directory used by `oh-browser.js` |

### Control plane API

Beyond MCP you can talk to the control plane directly — handy when you do not want an MCP dependency:

```bash
curl -s -X POST http://127.0.0.1:18766/link \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"get_all_sessions"}'
```

| cmd | Purpose |
|---|---|
| `status` | Connection count and tab count |
| `get_all_sessions` | All active sessions |
| `find_session` | Find a session by URL substring |
| `set_default` | Set the default tab |
| `execute_js` | Dispatch a command to a tab |

---

## License

MIT License — see [LICENSE](LICENSE).

The browser extension portion derives from the MIT-licensed `cdp-bridge-mcp` project; this repository adds the domestic-kernel adaptations.
