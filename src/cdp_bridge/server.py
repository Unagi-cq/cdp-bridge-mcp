import asyncio, json
import importlib

from mcp.server.fastmcp import FastMCP

from . import simphtml

mcp = FastMCP("tmwebdriver-bridge")

driver = None

def get_driver():
    global driver
    if driver is None:
        from .TMWebDriver import TMWebDriver
        driver = TMWebDriver()
    return driver


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
    """Switch the active browser tab.

    Args:
        tab_id: The tab ID to switch to (from browser_get_tabs).
    """
    def _run():
        d = get_driver()
        d.default_session_id = tab_id
        session = d.sessions.get(tab_id)
        if session and session.is_active():
            return json.dumps({"status": "success", "active_tab": tab_id, "url": session.info.get('url', '')}, ensure_ascii=False)
        return json.dumps({"status": "error", "msg": f"Tab {tab_id} not found or disconnected."}, ensure_ascii=False)
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
