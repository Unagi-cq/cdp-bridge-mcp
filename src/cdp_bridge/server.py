import asyncio, json, time
import importlib
from typing import Any

from mcp.server.fastmcp import FastMCP

from . import simphtml

mcp = FastMCP("tmwebdriver-bridge")

from .TMWebDriver import TMWebDriver
driver: TMWebDriver | None = None


def configure_driver(websocket_port: int = 18765) -> TMWebDriver:
    global driver
    if driver is None:
        driver = TMWebDriver(port=websocket_port)
    return driver

def get_driver():
    return configure_driver()


def _ensure_sessions(d: TMWebDriver) -> list[dict[str, Any]]:
    sessions = d.get_all_sessions()
    if len(sessions) == 0:
        raise RuntimeError("No browser tabs connected.")
    return sessions


def _normalize_tab_id(tab_id: str | int | None) -> int | None:
    if tab_id is None or tab_id == "":
        return None
    return int(tab_id)


def _extension_command(d: TMWebDriver, cmd: dict[str, Any], tab_id: str | int | None = None, timeout: float = 15) -> Any:
    normalized_tab_id = _normalize_tab_id(tab_id)
    if normalized_tab_id is not None and "tabId" not in cmd:
        cmd["tabId"] = normalized_tab_id
    result = d.execute_js(json.dumps(cmd, ensure_ascii=False), timeout=timeout)
    return result.get("data", result)


@mcp.tool()
async def browser_get_tabs() -> str:
    """Get all open browser tabs with their IDs, URLs, and titles."""
    def _run():
        d = get_driver()
        sessions = d.get_all_sessions()
        for s in sessions:
            s.pop('connected_at', None)
            s.pop('type', None)
        return json.dumps({"tabs": sessions, "active_tab": d.default_session_id}, ensure_ascii=False)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_scan(tabs_only: bool = False, switch_tab_id: str = "", text_only: bool = False) -> str:
    """Get simplified HTML content of the active tab plus tab list. The HTML is optimized for LLM consumption (stripped of scripts, styles, invisible elements).

    Args:
        tabs_only: Only return tab list without page content (saves tokens).
        switch_tab_id: Switch to this tab before scanning.
        text_only: Return plain text instead of simplified HTML.
    """
    def _run():
        d = get_driver()
        if len(d.get_all_sessions()) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected. Ensure Chrome extension is running."}, ensure_ascii=False)

        if switch_tab_id:
            d.default_session_id = switch_tab_id

        tabs = []
        for sess in d.get_all_sessions():
            sess.pop('connected_at', None)
            sess.pop('type', None)
            sess['url'] = sess.get('url', '')[:80]
            tabs.append(sess)

        result = {
            "status": "success",
            "metadata": {"tabs_count": len(tabs), "tabs": tabs, "active_tab": d.default_session_id}
        }
        if not tabs_only:
            importlib.reload(simphtml)
            result["content"] = simphtml.get_html(d, cutlist=True, maxchars=35000, text_only=text_only)
        return json.dumps(result, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_execute_js(script: str, switch_tab_id: str = "", no_monitor: bool = False) -> str:
    """Execute JavaScript in the browser and capture results plus DOM changes.

    Args:
        script: JavaScript code to execute (or JSON command for CDP operations).
        switch_tab_id: Switch to this tab before executing.
        no_monitor: Skip DOM change monitoring (faster, less info).
    """
    def _run():
        d = get_driver()
        if len(d.get_all_sessions()) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)
        if switch_tab_id:
            d.default_session_id = switch_tab_id
        importlib.reload(simphtml)
        result = simphtml.execute_js_rich(script, d, no_monitor=no_monitor)
        return json.dumps(result, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_switch_tab(tab_id: str) -> str:
    """Switch the active MCP browser tab without changing the visible Chrome tab.

    Args:
        tab_id: The tab ID to switch to (from browser_get_tabs).
    """
    def _run():
        d = get_driver()
        _ensure_sessions(d)
        d.default_session_id = tab_id
        session = d.sessions.get(tab_id)
        if not session or not session.is_active():
            return json.dumps({"status": "error", "msg": f"Tab {tab_id} not found or disconnected."}, ensure_ascii=False)
        return json.dumps({
            "status": "success",
            "active_tab": tab_id,
            "url": session.info.get('url', ''),
        }, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_batch(commands: list[dict[str, Any]], tab_id: str = "", timeout: float = 20) -> str:
    """Run multiple extension/CDP commands in one request.

    Args:
        commands: Command objects supported by the extension, such as
            {"cmd":"cdp","method":"DOM.getDocument","params":{"depth":1}}.
        tab_id: Optional tab ID inherited by commands that omit tabId.
        timeout: Seconds to wait for the batch result.
    """
    def _run():
        d = get_driver()
        _ensure_sessions(d)
        result = _extension_command(d, {"cmd": "batch", "commands": commands}, tab_id=tab_id, timeout=timeout)
        return json.dumps({"status": "success", "results": result}, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_wait(condition_js: str, timeout: float = 10, interval: float = 0.5, switch_tab_id: str = "") -> str:
    """Wait until JavaScript condition returns a truthy value.

    Args:
        condition_js: JavaScript expression or script. The return value is tested for truthiness.
        timeout: Maximum seconds to wait.
        interval: Seconds between checks.
        switch_tab_id: Optional tab ID to make active before waiting.
    """
    def _run():
        d = get_driver()
        _ensure_sessions(d)
        if switch_tab_id:
            d.default_session_id = switch_tab_id
        deadline = time.time() + max(timeout, 0)
        last_value = None
        last_error = None
        attempts = 0
        while True:
            attempts += 1
            try:
                response = d.execute_js(condition_js, timeout=min(max(interval, 0.2), 5))
                last_value = response.get("data", response.get("result"))
                last_error = None
                if last_value:
                    return json.dumps({
                        "status": "success",
                        "value": last_value,
                        "attempts": attempts,
                        "tab_id": d.default_session_id,
                    }, ensure_ascii=False, default=str)
            except Exception as e:
                last_error = str(e)
            if time.time() >= deadline:
                return json.dumps({
                    "status": "timeout",
                    "value": last_value,
                    "error": last_error,
                    "attempts": attempts,
                    "tab_id": d.default_session_id,
                }, ensure_ascii=False, default=str)
            time.sleep(max(interval, 0.1))
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_navigate(url: str) -> str:
    """Navigate the active tab to a URL.

    Args:
        url: The URL to navigate to.
    """
    def _run():
        d = get_driver()
        if len(d.get_all_sessions()) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)
        d.jump(url, timeout=10)
        return json.dumps({"status": "success", "msg": f"Navigating to {url}"}, ensure_ascii=False)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_screenshot(tab_id: str = "") -> str:
    """Take a screenshot of the active tab (returns base64 PNG).

    Args:
        tab_id: Optional tab ID to screenshot. Uses active tab if empty.
    """
    def _run():
        d = get_driver()
        if len(d.get_all_sessions()) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)
        cmd = {"cmd": "cdp", "method": "Page.captureScreenshot", "params": {"format": "png"}}
        if tab_id:
            cmd["tabId"] = int(tab_id)
        result = d.execute_js(json.dumps(cmd))
        data = result.get('data', {})
        if isinstance(data, dict) and 'data' in data:
            return json.dumps({"status": "success", "format": "png", "base64": data['data']}, ensure_ascii=False)
        return json.dumps({"status": "success", "data": data}, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_cookies(url: str = "") -> str:
    """Get cookies for the current page or a specific URL.

    Args:
        url: URL to get cookies for. If empty, gets cookies for the active tab's URL.
    """
    def _run():
        d = get_driver()
        if len(d.get_all_sessions()) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)
        cmd = {"cmd": "cookies"}
        if url:
            cmd["url"] = url
        result = d.execute_js(json.dumps(cmd))
        return json.dumps({"status": "success", "cookies": result.get('data', [])}, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


if __name__ == "__main__":
    mcp.run()
