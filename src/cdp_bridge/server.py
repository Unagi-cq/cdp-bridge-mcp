import asyncio, json, time, base64
import importlib
from pathlib import Path
from typing import Any
from contextvars import ContextVar

from mcp.server.fastmcp import FastMCP

from . import simphtml

mcp = FastMCP("tmwebdriver-bridge")

current_token: ContextVar[str] = ContextVar("current_token", default="")

from .TMWebDriver import TMWebDriver
driver: TMWebDriver | None = None


def configure_driver(websocket_port: int = 18765, multi_user: bool = False, allowed_tokens: list[str] | None = None) -> TMWebDriver:
    global driver
    if driver is None:
        driver = TMWebDriver(port=websocket_port, multi_user=multi_user, allowed_tokens=allowed_tokens)
    return driver

def get_driver():
    return configure_driver()

def _get_token() -> str | None:
    """Get the current request token from ContextVar."""
    token = current_token.get("")
    return token if token else None


def _ensure_sessions(d: TMWebDriver, token: str | None = None) -> list[dict[str, Any]]:
    sessions = d.get_all_sessions(token=token)
    if len(sessions) == 0:
        raise RuntimeError("No browser tabs connected.")
    return sessions


def _normalize_tab_id(tab_id: str | int | None) -> int | None:
    if tab_id is None or tab_id == "":
        return None
    return int(tab_id)


def _extension_command(d: TMWebDriver, cmd: dict[str, Any], tab_id: str | int | None = None, timeout: float = 15, token: str | None = None) -> Any:
    normalized_tab_id = _normalize_tab_id(tab_id)
    if normalized_tab_id is not None and "tabId" not in cmd:
        cmd["tabId"] = normalized_tab_id
    result = d.execute_js(json.dumps(cmd, ensure_ascii=False), timeout=timeout, token=token)
    return result.get("data", result)


@mcp.tool()
async def browser_get_tabs() -> str:
    """Get all open browser tabs with their IDs, URLs, and titles."""
    token = _get_token()
    def _run():
        d = get_driver()
        ctx = d.get_context(token)
        sessions = d.get_all_sessions(token=token)
        for s in sessions:
            s.pop('connected_at', None)
            s.pop('type', None)
        return json.dumps({"tabs": sessions, "active_tab": ctx.default_session_id}, ensure_ascii=False)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_scan(tabs_only: bool = False, switch_tab_id: str = "", text_only: bool = False) -> str:
    """Get simplified HTML content of the active tab plus tab list. The HTML is optimized for LLM consumption (stripped of scripts, styles, invisible elements).

    Args:
        tabs_only: Only return tab list without page content (saves tokens).
        switch_tab_id: Switch to this tab before scanning.
        text_only: Return plain text instead of simplified HTML.
    """
    token = _get_token()
    def _run():
        d = get_driver()
        ctx = d.get_context(token)
        if len(d.get_all_sessions(token=token)) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected. Ensure Chrome extension is running."}, ensure_ascii=False)

        if switch_tab_id:
            ctx.default_session_id = switch_tab_id

        tabs = []
        for sess in d.get_all_sessions(token=token):
            sess.pop('connected_at', None)
            sess.pop('type', None)
            sess['url'] = sess.get('url', '')[:80]
            tabs.append(sess)

        result = {
            "status": "success",
            "metadata": {"tabs_count": len(tabs), "tabs": tabs, "active_tab": ctx.default_session_id}
        }
        if not tabs_only:
            importlib.reload(simphtml)
            result["content"] = simphtml.get_html(d, cutlist=True, maxchars=35000, text_only=text_only, token=token)
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
    token = _get_token()
    def _run():
        d = get_driver()
        ctx = d.get_context(token)
        if len(d.get_all_sessions(token=token)) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)
        if switch_tab_id:
            ctx.default_session_id = switch_tab_id
        importlib.reload(simphtml)
        result = simphtml.execute_js_rich(script, d, no_monitor=no_monitor, token=token)
        return json.dumps(result, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_switch_tab(tab_id: str) -> str:
    """Switch the active MCP browser tab without changing the visible Chrome tab.

    Args:
        tab_id: The tab ID to switch to (from browser_get_tabs).
    """
    token = _get_token()
    def _run():
        d = get_driver()
        ctx = d.get_context(token)
        _ensure_sessions(d, token=token)
        ctx.default_session_id = tab_id
        session = ctx.sessions.get(tab_id)
        if not session or not session.is_active():
            return json.dumps({"status": "error", "msg": f"Tab {tab_id} not found or disconnected."}, ensure_ascii=False)
        return json.dumps({
            "status": "success",
            "active_tab": tab_id,
            "url": session.info.get('url', ''),
        }, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_focus_tab(tab_id: str) -> str:
    """Bring a Chrome tab to the foreground: activate the tab AND focus its window.

    Unlike browser_switch_tab (which only changes the MCP-side active session
    without touching the visible Chrome UI), this actually makes the tab visible
    to the user. Use this when the user can't find the tab the agent is working
    on (e.g. across many windows / Spaces / minimized windows).

    Goes through chrome.tabs.update + chrome.windows.update (extension-native
    APIs), avoiding the chrome.debugger CDP "Not allowed" restriction on
    Target.activateTarget.

    Args:
        tab_id: The tab ID to focus (from browser_get_tabs).
    """
    def _run():
        d = get_driver()
        _ensure_sessions(d)
        normalized = _normalize_tab_id(tab_id)
        if normalized is None:
            return json.dumps({"status": "error", "msg": "tab_id is required"}, ensure_ascii=False)
        result = _extension_command(
            d,
            {"cmd": "tabs", "method": "switch", "tabId": normalized},
            timeout=10,
        )
        # User asked us to bring this tab to the front — they will most likely
        # operate on it next, so sync the MCP-side active session too.
        d.default_session_id = tab_id
        return json.dumps({
            "status": "success",
            "focused_tab": tab_id,
            "extension_response": result,
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
    token = _get_token()
    def _run():
        d = get_driver()
        _ensure_sessions(d, token=token)
        result = _extension_command(d, {"cmd": "batch", "commands": commands}, tab_id=tab_id, timeout=timeout, token=token)
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
    token = _get_token()
    def _run():
        d = get_driver()
        ctx = d.get_context(token)
        _ensure_sessions(d, token=token)
        if switch_tab_id:
            ctx.default_session_id = switch_tab_id
        deadline = time.time() + max(timeout, 0)
        last_value = None
        last_error = None
        attempts = 0
        while True:
            attempts += 1
            try:
                response = d.execute_js(condition_js, timeout=min(max(interval, 0.2), 5), token=token)
                last_value = response.get("data", response.get("result"))
                last_error = None
                if last_value:
                    return json.dumps({
                        "status": "success",
                        "value": last_value,
                        "attempts": attempts,
                        "tab_id": ctx.default_session_id,
                    }, ensure_ascii=False, default=str)
            except Exception as e:
                last_error = str(e)
            if time.time() >= deadline:
                return json.dumps({
                    "status": "timeout",
                    "value": last_value,
                    "error": last_error,
                    "attempts": attempts,
                    "tab_id": ctx.default_session_id,
                }, ensure_ascii=False, default=str)
            time.sleep(max(interval, 0.1))
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_navigate(url: str) -> str:
    """Navigate the active tab to a URL.

    Args:
        url: The URL to navigate to.
    """
    token = _get_token()
    def _run():
        d = get_driver()
        if len(d.get_all_sessions(token=token)) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)
        d.jump(url, timeout=10, token=token)
        return json.dumps({"status": "success", "msg": f"Navigating to {url}"}, ensure_ascii=False)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_screenshot(tab_id: str = "") -> str:
    """Take a screenshot of the active tab (returns base64 PNG).

    Args:
        tab_id: Optional tab ID to screenshot. Uses active tab if empty.
    """
    token = _get_token()
    def _run():
        d = get_driver()
        if len(d.get_all_sessions(token=token)) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)
        cmd = {"cmd": "cdp", "method": "Page.captureScreenshot", "params": {"format": "png"}}
        if tab_id:
            cmd["tabId"] = int(tab_id)
        result = d.execute_js(json.dumps(cmd), token=token)
        data = result.get('data', {})
        if isinstance(data, dict) and 'data' in data:
            return json.dumps({"status": "success", "format": "png", "base64": data['data']}, ensure_ascii=False)
        return json.dumps({"status": "success", "data": data}, ensure_ascii=False, default=str)
    return await asyncio.to_thread(_run)


@mcp.tool()
async def browser_save_image(screenshot_json_str_or_file: str, output_path: str = "") -> str:
    """Save base64 screenshot data to PNG file.

    Args:
        screenshot_json_str_or_file: JSON output from browser_screenshot tool, or path to a JSON file containing the screenshot data.
        output_path: Output PNG file path or directory. Behavior:
            - Existing directory: save as {directory}/screenshot_{timestamp}.png
            - File path with existing parent dir: save directly to that file
            - File path with non-existing parent dir: return error
            - Empty/not provided: auto-generate based on input path or timestamp

    Returns:
        JSON with status, saved_path, and size_bytes.
    """
    def _run():
        try:
            from datetime import datetime

            # Determine if input is a file path or JSON string
            input_path = Path(screenshot_json_str_or_file)
            if input_path.exists() and input_path.is_file():
                with open(input_path, "r", encoding="utf-8") as f:
                    content = f.read()
            else:
                content = screenshot_json_str_or_file
                input_path = None

            # Parse the screenshot JSON result
            data = json.loads(content)

            # Handle nested result structure: {"status": "success", "result": "{...}"}
            result_str = data.get("result", "")
            if isinstance(result_str, str) and result_str.startswith("{"):
                data = json.loads(result_str)

            # Extract base64 data
            b64_data = data.get("base64", "")
            if not b64_data:
                return json.dumps({"status": "error", "msg": "No base64 data found in screenshot JSON"}, ensure_ascii=False)

            # Decode base64
            img_data = base64.b64decode(b64_data)

            # Determine output path
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            if output_path:
                output_path_obj = Path(output_path).resolve()
                if output_path_obj.is_dir():
                    # output_path is an existing directory -> save inside with timestamp filename
                    save_path = output_path_obj / f"screenshot_{timestamp}.png"
                elif not output_path_obj.parent.exists():
                    return json.dumps({
                        "status": "error",
                        "msg": f"Parent directory does not exist: {output_path_obj.parent}"
                    }, ensure_ascii=False)
                else:
                    # output_path is a file path (directory exists) -> save directly
                    save_path = output_path_obj
            else:
                # No output_path provided -> use default logic
                if input_path:
                    save_path = input_path.parent.resolve() / f"{input_path.stem}.png"
                else:
                    save_path = Path.cwd().resolve() / f"screenshot_{timestamp}.png"

            # Ensure parent directory exists
            save_path.parent.mkdir(parents=True, exist_ok=True)

            # Resolve to absolute path
            save_path = save_path.resolve()

            # Save the image
            with open(save_path, "wb") as f:
                f.write(img_data)

            return json.dumps({
                "status": "success",
                "saved_path": str(save_path),
                "size_bytes": len(img_data)
            }, ensure_ascii=False)

        except json.JSONDecodeError as e:
            return json.dumps({"status": "error", "msg": f"Invalid JSON: {e}"}, ensure_ascii=False)
        except base64.binascii.Error as e:
            return json.dumps({"status": "error", "msg": f"Invalid base64 data: {e}"}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"status": "error", "msg": str(e)}, ensure_ascii=False)

    return await asyncio.to_thread(_run)


if __name__ == "__main__":
    mcp.run()
