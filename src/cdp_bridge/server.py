import asyncio, json, time, os
import importlib
from typing import Any
from contextvars import ContextVar

from mcp.server.fastmcp import FastMCP

from . import simphtml
from . import snapshot

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
async def browser_click(uid: str, switch_tab_id: str = "") -> str:
    """Click on an element by its uid from the page accessibility tree snapshot.

    First takes a fresh snapshot to find the element, resolves DOM info, then clicks it.

    Args:
        uid: The uid of the element to click (from browser_snapshot output).
        switch_tab_id: Switch to this tab before clicking.
    """
    token = _get_token()
    def _run():
        d = get_driver()
        ctx = d.get_context(token)
        sessions = d.get_all_sessions(token=token)
        if len(sessions) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)

        if switch_tab_id:
            ctx.default_session_id = switch_tab_id

        tab_id = ctx.default_session_id

        # Try to reuse cached snapshot from browser_snapshot
        cached = snapshot.get_cached_snapshot(token, tab_id)
        if cached:
            root = cached["root"]
            sid = cached["sid"]
        else:
            # Step 1: Get accessibility tree
            ax_response = _extension_command(
                d,
                {"cmd": "cdp", "method": "Accessibility.getFullAXTree"},
                tab_id=tab_id,
                timeout=10,
                token=token,
            )

            ax_nodes = snapshot.parse_ax_tree_response(ax_response)
            if not ax_nodes:
                return json.dumps({"status": "error", "msg": "Accessibility tree is empty."}, ensure_ascii=False)

            root = snapshot.build_tree(ax_nodes, interesting_only=True)
            if root is None:
                return json.dumps({"status": "error", "msg": "Failed to build accessibility tree."}, ensure_ascii=False)

            sid = snapshot.SnapshotIdCounter.get_and_increment()
            snapshot.assign_uids(root, sid)

            # Resolve DOM info for precise locating
            backend_ids = snapshot.collect_dom_info(ax_nodes)
            if backend_ids:
                tab_id_int = int(tab_id) if isinstance(tab_id, str) else tab_id
                snapshot.resolve_dom_info_by_query(d, token, tab_id_int, ax_nodes, backend_ids)
                snapshot.enrich_nodes_with_dom(root, backend_ids)

            # Cache for next click
            snapshot.cache_snapshot(token, root, sid, tab_id)

        # Step 2: Find the node by uid
        target = snapshot.find_node_by_uid(root, uid)
        if target is None:
            return json.dumps({
                "status": "error",
                "msg": f"Element uid '{uid}' not found in current snapshot.",
                "hint": "Use browser_snapshot to get the latest element uids.",
            }, ensure_ascii=False)

        # Step 3: Build click JS based on element DOM properties
        click_js = _build_click_js_for_node(target)

        # Step 4: Execute the click
        try:
            result = d.execute_js(click_js, timeout=10, token=token)
            data = result.get("data", result)
            if isinstance(data, dict) and data.get("ok"):
                val = data
                return json.dumps({
                    "status": "success",
                    "msg": f"Clicked: {val.get('tag', '')} - {val.get('text', '')}",
                    "element": {"uid": uid, "role": target.role, "name": target.name, "tagName": target.tag_name, "domId": target.dom_id},
                }, ensure_ascii=False)
            else:
                return json.dumps({
                    "status": "error",
                    "msg": f"Click failed: {data.get('error', 'Unknown error') if isinstance(data, dict) else str(data)}",
                }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({
                "status": "error",
                "msg": f"Click failed: {str(e)}",
            }, ensure_ascii=False)

    return await asyncio.to_thread(_run)


def _build_click_js_for_node(node) -> str:
    """Build JavaScript to click on an element using DOM info for precise locating.

    Priority order:
    1. By DOM id (most precise): document.querySelector('#id')
    2. By tag + feature classes + accessible name
    3. By aria-label attribute
    4. By text content match on buttons/links
    5. By URL for link elements
    """
    import json as _json

    dom_id = node.dom_id
    tag_name = node.tag_name.lower() if node.tag_name else ""
    dom_classes = node.dom_classes
    name = node.name
    role = node.role
    url = node.properties.get("url", "")

    # Priority 1: by DOM id (most precise)
    if dom_id:
        return f"""(function() {{
            const el = document.getElementById({_json.dumps(dom_id)});
            if (el) {{ el.click(); return {{ ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) }}; }}
            return {{ ok: false, error: 'Element with id "{dom_id}" not found' }};
        }})()"""

    # Priority 2: by tag + feature classes
    if tag_name and dom_classes:
        class_selector = ".".join(dom_classes[:3])
        selector = f"{tag_name}.{class_selector}"
        # If we also have a name, try matching text within the selected element
        if name:
            return f"""(function() {{
                const elements = document.querySelectorAll({_json.dumps(selector)});
                for (const el of elements) {{
                    const text = (el.textContent || '').trim();
                    const ariaLabel = el.getAttribute('aria-label') || '';
                    if (text === {_json.dumps(name)} || text.startsWith({_json.dumps(name)}) || ariaLabel === {_json.dumps(name)}) {{
                        el.click();
                        return {{ ok: true, tag: el.tagName, text: text.substring(0, 80) }};
                    }}
                }}
                // If no text match, click the first one
                if (elements.length > 0) {{ elements[0].click(); return {{ ok: true, tag: elements[0].tagName, text: (elements[0].textContent || '').trim().substring(0, 80) }}; }}
                return {{ ok: false, error: 'Element with selector "{selector}" not found' }};
            }})()"""
        else:
            return f"""(function() {{
                const el = document.querySelector({_json.dumps(selector)});
                if (el) {{ el.click(); return {{ ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) }}; }}
                return {{ ok: false, error: 'Element with selector "{selector}" not found' }};
            }})()"""

    # Priority 3: by tag + name (text match)
    if tag_name and name:
        return f"""(function() {{
            const elements = document.querySelectorAll({_json.dumps(tag_name)});
            for (const el of elements) {{
                const text = (el.textContent || '').trim();
                const ariaLabel = el.getAttribute('aria-label') || '';
                if (text === {_json.dumps(name)} || text.startsWith({_json.dumps(name)}) || ariaLabel === {_json.dumps(name)}) {{
                    el.click();
                    return {{ ok: true, tag: el.tagName, text: text.substring(0, 80) }};
                }}
            }}
            return {{ ok: false, error: 'Element <{tag_name}> with text "{name}" not found' }};
        }})()"""

    # Priority 4: by aria-label (for accessible elements)
    if name:
        escaped_name = name.replace("'", "\\'")
        return f"""(function() {{
            let el = document.querySelector('[aria-label="{escaped_name}"]');
            if (el) {{ el.click(); return {{ ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) }}; }}
            // Try by text content for buttons and links
            const candidates = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
            for (const elem of candidates) {{
                const text = (elem.textContent || '').trim();
                if (text === {_json.dumps(name)} || text.startsWith({_json.dumps(name)})) {{
                    elem.click();
                    return {{ ok: true, tag: elem.tagName, text: text.substring(0, 80) }};
                }}
            }}
            return {{ ok: false, error: 'Element with aria-label or text "{name}" not found' }};
        }})()"""

    # Priority 5: for links, match by href
    if url and role == "link":
        return f"""(function() {{
            const links = document.querySelectorAll('a[href]');
            for (const link of links) {{
                if (link.href === {_json.dumps(url)}) {{
                    link.click();
                    return {{ ok: true, tag: link.tagName, text: (link.textContent || '').trim().substring(0, 80) }};
                }}
            }}
            return {{ ok: false, error: 'Link with matching URL not found' }};
        }})()"""

    # Fallback
    backend_id = node.backend_dom_node_id
    if backend_id:
        return f"""(function() {{
            return {{ ok: false, error: 'Cannot locate element without id, classes, or name. backendNodeId: {backend_id}' }};
        }})()"""

    return """(function() {
        return { ok: false, error: 'No identifying properties to locate element' };
    })()"""


@mcp.tool()
async def browser_snapshot(verbose: bool = False, file_path: str = "", switch_tab_id: str = "") -> str:
    """Get simplified text snapshot of the current page based on the accessibility tree.

    The snapshot lists page elements with unique identifiers (uid).
    Each element includes DOM info (tagName, id, feature classes) for precise locating.
    Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot.

    Args:
        verbose: Whether to include all elements (default: only meaningful elements).
        file_path: Absolute or relative path to save the snapshot to a .txt file.
        switch_tab_id: Switch to this tab before taking snapshot.
    """
    token = _get_token()
    def _run():
        d = get_driver()
        ctx = d.get_context(token)
        sessions = d.get_all_sessions(token=token)
        if len(sessions) == 0:
            return json.dumps({"status": "error", "msg": "No browser tabs connected."}, ensure_ascii=False)

        if switch_tab_id:
            ctx.default_session_id = switch_tab_id

        tab_id = ctx.default_session_id

        ax_response = _extension_command(
            d,
            {"cmd": "cdp", "method": "Accessibility.getFullAXTree"},
            tab_id=tab_id,
            timeout=10,
            token=token,
        )

        ax_nodes = snapshot.parse_ax_tree_response(ax_response)
        if not ax_nodes:
            return json.dumps({"status": "error", "msg": "Accessibility tree is empty or not available."}, ensure_ascii=False)

        root = snapshot.build_tree(ax_nodes, interesting_only=not verbose)
        if root is None:
            return json.dumps({"status": "error", "msg": "Failed to build accessibility tree."}, ensure_ascii=False)

        sid = snapshot.SnapshotIdCounter.get_and_increment()
        snapshot.assign_uids(root, sid)

        # Resolve DOM info for nodes with backendDOMNodeId
        backend_ids = snapshot.collect_dom_info(ax_nodes)
        if backend_ids:
            tab_id_int = int(tab_id) if isinstance(tab_id, str) else tab_id
            snapshot.resolve_dom_info_by_query(d, token, tab_id_int, ax_nodes, backend_ids)
            snapshot.enrich_nodes_with_dom(root, backend_ids)

        # Cache snapshot for browser_click reuse and write to temp file
        snapshot.cache_snapshot(token, root, sid, tab_id)

        text = snapshot.format_text(root, verbose=verbose)

        if file_path:
            resolved_path = file_path if os.path.isabs(file_path) else os.path.abspath(file_path)
            snapshot.save_to_file(text, resolved_path)
            return json.dumps({
                "status": "success",
                "msg": f"Saved snapshot to {resolved_path}",
                "snapshot_file": resolved_path,
            }, ensure_ascii=False)

        return json.dumps({
            "status": "success",
            "snapshot": text,
            "structured_content": snapshot.format_json(root),
        }, ensure_ascii=False, default=str)

    return await asyncio.to_thread(_run)


if __name__ == "__main__":
    mcp.run()
