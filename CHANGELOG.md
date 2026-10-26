# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-22

### Added

- `browser_dom` structured DOM command channel that works on strict-CSP pages
  (native DOM APIs, no `eval`).
- `tabs.close` command with a two-level fallback (`chrome.tabs.remove` →
  content-script `window.close()`).
- Service-worker wake-up hooks so the extension reconnects automatically after
  the bridge service restarts:
  `chrome.tabs.onActivated` / `onUpdated` / `onCreated` / `onRemoved` and
  `chrome.windows.onFocusChanged`.
- `scripts/verify-mcp.js` — end-to-end self-check covering the MCP handshake,
  the tool catalogue and live browser connectivity.
- `scripts/oh-browser.js` — CLI client for scripting and debugging.
- `examples/minimal-agent.js` — a dependency-free MCP client showing the
  full navigation → read → query flow.
- `README_EN.md` — English documentation.

### Changed

- Extension renamed to **CDP Bridge for Agents**; internal log prefixes changed
  from `[TMWD]` to `[CDP-Bridge]`.
- Bridge host/port are now configurable through `chrome.storage` (persisted from
  the extension popup) with `127.0.0.1:18765` as the default.
- README and integration guide restructured for public release: environment
  variables, health checks, troubleshooting matrix and a deployment checklist.

### Fixed

- The extension no longer reports a stale tab list after the bridge service
  restarts.
- `browser_navigate` followed by a `document.readyState` wait could return
  stale page content; documented the correct wait condition (wait for the URL
  to change).

## [0.1.0] - 2026-09-07

### Added

- Initial release: browser extension, bridge service and MCP server with the
  core tool set (`browser_get_tabs`, `browser_scan`, `browser_execute_js`,
  `browser_click`, `browser_type`, `browser_screenshot`, and others).
- Three-tier execution fallback for domestic Chromium kernels that hang on
  `chrome.scripting` or `chrome.debugger`.
