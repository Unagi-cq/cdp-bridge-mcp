"""
CDP Bridge Snapshot Module

Processes Chrome accessibility tree data from CDP Accessibility.getFullAXTree
and formats it as text or JSON snapshots.
"""

from __future__ import annotations


class SnapshotNode:
    """Represents a node in the accessibility snapshot tree."""

    def __init__(self) -> None:
        self.id: str = ""
        self.role: str = ""
        self.name: str = ""
        self.children: list[SnapshotNode] = []
        self.backend_dom_node_id: int | None = None
        self.properties: dict = {}
        self.ignored: bool = False
        # DOM properties for precise element locating
        self.tag_name: str = ""
        self.dom_id: str = ""
        self.dom_classes: list[str] = []


class SnapshotIdCounter:
    """Global counter for snapshot IDs."""

    _counter: int = 1

    @classmethod
    def get_and_increment(cls) -> int:
        val = cls._counter
        cls._counter += 1
        return val

    @classmethod
    def reset(cls) -> None:
        cls._counter = 1


# Boolean property mappings (from SnapshotFormatter.ts)
BOOLEAN_PROPERTY_MAP = {
    "disabled": "disableable",
    "expanded": "expandable",
    "focused": "focusable",
    "selected": "selectable",
}

EXCLUDED_ATTRIBUTES = {
    "id", "role", "name", "children", "backendDOMNodeId",
    "parentId", "nodeId", "ignored", "childIds", "properties",
}


def collect_dom_info(ax_nodes: list[dict]) -> dict[int, dict]:
    """Collect backendDOMNodeId → DOM info mapping from AX nodes.

    Returns a dict mapping backendDOMNodeId to {tagName, id, className}.
    Only includes nodes that have a backendDOMNodeId.
    """
    backend_ids: set[int] = set()
    for node in ax_nodes:
        bid = node.get("backendDOMNodeId")
        if bid is not None:
            backend_ids.add(bid)

    if not backend_ids:
        return {}

    # Build a JS function that resolves all backendNodeIds in one call
    # We return the list of backend IDs that need resolving
    # The caller will use DOM.resolveNode + Runtime.callFunctionOn for each
    # For batch efficiency, we return the backend_ids for the caller to resolve
    return {bid: {} for bid in backend_ids}


def resolve_dom_info_by_query(driver, token: str | None, tab_id: int, ax_nodes: list[dict], backend_ids: dict[int, dict] | None = None) -> dict[int, dict]:
    """Resolve DOM info by querying elements that match AX node properties.

    For each AX node with backendDOMNodeId, tries to find a matching DOM element
    by role/name/text and extract its tagName, id, className.

    Args:
        driver: TMWebDriver instance.
        token: Auth token.
        tab_id: Browser tab ID.
        ax_nodes: List of AX node dicts.
        backend_ids: Optional dict of backendNodeId → {} to populate.

    Returns:
        Dict of backendNodeId → {tagName, id, className}.
    """
    if backend_ids is None:
        backend_ids = {}
    import json as _json

    # Build list of nodes that need DOM info
    nodes_to_resolve = []
    for node in ax_nodes:
        bid = node.get("backendDOMNodeId")
        if bid is None:
            continue
        role_obj = node.get("role", {})
        role = role_obj.get("value", "") if isinstance(role_obj, dict) else str(role_obj)
        name_obj = node.get("name", {})
        name = name_obj.get("value", "") if isinstance(name_obj, dict) else str(name_obj)
        nodes_to_resolve.append({
            "backendNodeId": bid,
            "role": role,
            "name": name,
        })

    if not nodes_to_resolve:
        return {}

    # Build JS that resolves each node via DOM properties and returns a map
    # We can't use backendNodeId from page JS, so we use a different approach:
    # Query all interactive elements and build an index by aria-label/text/tag
    nodes_json = _json.dumps(nodes_to_resolve)
    js_code = (
        "(function() {"
        "const nodes = " + nodes_json + ";"
        "const result = {};"
        "const allElements = document.querySelectorAll('input, button, a, select, textarea, [role=\"button\"], [role=\"checkbox\"], [role=\"link\"], label, h1, h2, h3, h4, h5, h6, [id]');"
        "const index = [];"
        "for (const el of allElements) {"
        "  index.push({"
        "    tag: el.tagName.toLowerCase(),"
        "    id: el.id || '',"
        "    cls: typeof el.className === 'string' ? el.className : '',"
        "    ariaLabel: el.getAttribute('aria-label') || '',"
        "    text: (el.textContent || '').trim().substring(0, 100),"
        "    type: el.type || '',"
        "    name: el.name || '',"
        "    placeholder: el.getAttribute('placeholder') || '',"
        "  });"
        "}"
        "for (const axNode of nodes) {"
        "  let bestMatch = null;"
        "  for (const el of index) {"
        "    let score = 0;"
        "    if (axNode.name && el.id && el.id.toLowerCase().includes(axNode.name.toLowerCase().replace(/\\s+/g, ''))) { score += 100; }"
        "    if (axNode.name && el.ariaLabel === axNode.name) { score += 80; }"
        "    if (axNode.name && el.text === axNode.name) { score += 60; }"
        "    else if (axNode.name && el.text.startsWith(axNode.name)) { score += 40; }"
        "    if (axNode.role === 'textbox' && (el.tag === 'input' || el.tag === 'textarea')) { score += 20; }"
        "    else if (axNode.role === 'button' && (el.tag === 'button' || el.type === 'submit')) { score += 20; }"
        "    else if (axNode.role === 'checkbox' && el.tag === 'input' && el.type === 'checkbox') { score += 20; }"
        "    else if (axNode.role === 'link' && el.tag === 'a') { score += 20; }"
        "    else if (axNode.role === 'heading' && el.tag.startsWith('h')) { score += 20; }"
        "    if (axNode.role === 'textbox' && el.placeholder && axNode.name && el.placeholder.includes(axNode.name)) { score += 30; }"
        "    if (axNode.name && el.name && el.name.toLowerCase().includes(axNode.name.toLowerCase().replace(/\\s+/g, ''))) { score += 30; }"
        "    if (score > 0 && (!bestMatch || score > bestMatch.score)) { bestMatch = { ...el, score }; }"
        "  }"
        "  if (bestMatch) {"
        "    result[String(axNode.backendNodeId)] = {"
        "      tagName: bestMatch.tag.toUpperCase(),"
        "      id: bestMatch.id,"
        "      className: bestMatch.cls,"
        "    };"
        "  }"
        "}"
        "return JSON.stringify(result);"
        "})()"
    )

    try:
        cmd = {"cmd": "cdp", "method": "Runtime.evaluate", "params": {"expression": js_code, "returnByValue": True}, "tabId": tab_id}
        result = driver.execute_js(_json.dumps(cmd), timeout=10, token=token)
        data = result.get("data", result)
        if isinstance(data, dict) and "result" in data:
            result_obj = data["result"]
            if isinstance(result_obj, dict) and "value" in result_obj:
                dom_map = _json.loads(result_obj["value"])
                # Convert string keys back to int and build dom_info
                dom_info: dict[int, dict] = {}
                for key_str, info in dom_map.items():
                    try:
                        bid = int(key_str)
                        dom_info[bid] = info
                    except (ValueError, KeyError):
                        pass
                # Populate the caller's backend_ids dict
                backend_ids.update(dom_info)
    except Exception as e:
        print(f"[snapshot] resolve_dom_info_by_query failed: {e}")

    return backend_ids


def enrich_nodes_with_dom(root, dom_info: dict[int, dict]) -> None:
    """Enrich SnapshotNode tree with resolved DOM info.

    Args:
        root: Root SnapshotNode.
        dom_info: Dict of backendDOMNodeId → {tagName, id, className}.
    """
    if root is None or not dom_info:
        return

    queue = [root]
    while queue:
        node = queue.pop(0)
        if node.backend_dom_node_id is not None and node.backend_dom_node_id in dom_info:
            info = dom_info[node.backend_dom_node_id]
            node.tag_name = info.get("tagName", "")
            node.dom_id = info.get("id", "")
            classes = info.get("className", "")
            if classes:
                node.dom_classes = [c for c in classes.split(" ") if c]
        queue.extend(node.children)


def should_filter_node(node) -> bool:
    """Check if a node should be filtered out from click targets.

    Filter out nodes that:
    - Have no backendDOMNodeId (can't be clicked via DOM)
    - Are ignored
    - Are pure text containers (InlineTextBox, StaticText) without their own DOM
    """
    if node.ignored:
        return True
    if node.backend_dom_node_id is None:
        # Keep nodes with a name and role that might be clickable
        # (e.g., links with url property)
        if node.properties.get("url"):
            return False
        return True
    return False


def parse_ax_tree_response(ax_data: dict) -> list[dict]:
    """Parse the raw CDP Accessibility.getFullAXTree response into a list of nodes."""
    return ax_data.get("nodes", [])


def build_tree(ax_nodes: list[dict], interesting_only: bool = True) -> SnapshotNode | None:
    """Build a tree structure from flat AX nodes.

    Args:
        ax_nodes: List of AX node dicts from CDP response.
        interesting_only: If True, filter out nodes with ignored=True.

    Returns:
        Root SnapshotNode of the tree, or None if no valid nodes.
    """
    # Build full map (all nodes) for parent chain resolution
    full_map: dict[str, dict] = {node["nodeId"]: node for node in ax_nodes}

    # Build interesting-only map
    node_map: dict[str, dict] = {}
    for node in ax_nodes:
        if interesting_only and node.get("ignored", False):
            continue
        node_map[node["nodeId"]] = node

    if not node_map:
        return None

    def resolve_effective_parent_id(node_id: str) -> str | None:
        """Find the nearest non-ignored ancestor's nodeId."""
        raw = full_map.get(node_id)
        if not raw:
            return None
        parent_id = raw.get("parentId")
        if parent_id is None:
            return None
        # If parent is in node_map (non-ignored), use it
        if parent_id in node_map:
            return parent_id
        # Otherwise, walk up the chain to find nearest non-ignored ancestor
        current = parent_id
        visited: set[str] = set()
        while current and current not in node_map and current not in visited:
            visited.add(current)
            parent = full_map.get(current)
            if not parent:
                break
            current = parent.get("parentId")
        return current if current in node_map else None

    # Group children by their effective parent
    children_by_parent: dict[str, list[str]] = {}
    for node_id, raw in node_map.items():
        effective_parent = resolve_effective_parent_id(node_id)
        if effective_parent:
            children_by_parent.setdefault(effective_parent, []).append(node_id)

    def to_snapshot(node_id: str) -> SnapshotNode | None:
        if node_id not in node_map:
            return None
        raw = node_map[node_id]
        node = SnapshotNode()
        node.backend_dom_node_id = raw.get("backendDOMNodeId")
        node.ignored = raw.get("ignored", False)

        role_obj = raw.get("role", {})
        node.role = role_obj.get("value", "") if isinstance(role_obj, dict) else str(role_obj)

        name_obj = raw.get("name", {})
        node.name = name_obj.get("value", "") if isinstance(name_obj, dict) else str(name_obj)

        props: dict = {}
        for prop in raw.get("properties", []):
            prop_name = prop.get("name", "")
            prop_value_obj = prop.get("value", {})
            if isinstance(prop_value_obj, dict):
                props[prop_name] = prop_value_obj.get("value")
            else:
                props[prop_name] = prop_value_obj
        node.properties = props

        # Use resolved children instead of raw childIds
        for child_id in children_by_parent.get(node_id, []):
            child = to_snapshot(child_id)
            if child is not None:
                node.children.append(child)

        return node

    # Find root (no effective parent)
    root: SnapshotNode | None = None
    for node_id in node_map:
        if resolve_effective_parent_id(node_id) is None:
            root = to_snapshot(node_id)
            break

    if root is None:
        first_id = next(iter(node_map))
        root = to_snapshot(first_id)

    return root


def assign_uids(root: SnapshotNode | None, snapshot_id: int) -> dict[str, SnapshotNode]:
    """Assign unique uids to all nodes in the tree.

    Args:
        root: Root SnapshotNode.
        snapshot_id: Snapshot ID number.

    Returns:
        Map of uid -> SnapshotNode.
    """
    if root is None:
        return {}

    id_to_node: dict[str, SnapshotNode] = {}
    counter = [0]

    def walk(node: SnapshotNode) -> None:
        uid = f"{snapshot_id}_{counter[0]}"
        counter[0] += 1
        node.id = uid
        id_to_node[uid] = node
        for child in node.children:
            walk(child)

    walk(root)
    return id_to_node


def format_text(root: SnapshotNode | None, verbose: bool = False) -> str:
    """Format the snapshot tree as a text string.

    Format: uid=<id> tagName#id.class1.class2 role "name" attr1 attr2="val" ...
    Each level indented by 2 spaces.

    DOM info (tagName, id, feature classes) is included when available
    to enable precise element locating for browser_click.

    Args:
        root: Root SnapshotNode with uids assigned.
        verbose: If True, include more details.

    Returns:
        Formatted text string.
    """
    if root is None:
        return ""

    chunks: list[str] = []

    def _feature_classes(classes: list[str]) -> str:
        """Extract feature classes (first 3 meaningful classes, skip common utility classes)."""
        skip = {"flex", "grid", "block", "inline", "w-full", "h-full", "mx-auto", "my-auto",
                "text-center", "text-left", "text-right", "relative", "absolute", "fixed",
                "overflow-hidden", "overflow-auto", "hidden", "visible", "opacity-0", "opacity-100"}
        meaningful = [c for c in classes if c and c.lower() not in skip]
        return ".".join(meaningful[:3])

    def format_node(node: SnapshotNode, depth: int) -> None:
        attrs = [f"uid={node.id}"]

        # DOM info: tagName#id.class1.class2
        dom_parts = []
        tag = node.tag_name.lower() if node.tag_name else ""
        if tag:
            dom_parts.append(tag)
        if node.dom_id:
            dom_parts.append(f"#{node.dom_id}")
        feature_cls = _feature_classes(node.dom_classes)
        if feature_cls:
            dom_parts.append(f".{feature_cls}")
        if dom_parts:
            attrs.append("".join(dom_parts))

        role = node.role if node.role else "unknown"
        if role == "none":
            role = "ignored"
        attrs.append(role)

        if node.name:
            attrs.append(f'"{node.name}"')

        prop_keys = sorted(node.properties.keys())
        for key in prop_keys:
            if key in EXCLUDED_ATTRIBUTES:
                continue
            val = node.properties[key]

            if val is True:
                mapped = BOOLEAN_PROPERTY_MAP.get(key)
                if mapped:
                    attrs.append(mapped)
                attrs.append(key)
            elif val is False:
                continue
            elif isinstance(val, str):
                attrs.append(f'{key}="{val}"')
            elif isinstance(val, (int, float)):
                attrs.append(f'{key}="{val}"')

        line = "  " * depth + " ".join(attrs)
        chunks.append(line)

        for child in node.children:
            format_node(child, depth + 1)

    format_node(root, 0)
    return "\n".join(chunks) + "\n"


def format_json(root: SnapshotNode | None) -> dict:
    """Format the snapshot tree as a JSON-serializable dict.

    Includes DOM info (tagName, id, classes) when available.

    Args:
        root: Root SnapshotNode with uids assigned.

    Returns:
        Dict suitable for json.dumps.
    """
    if root is None:
        return {}

    def to_dict(node: SnapshotNode) -> dict:
        result: dict = {
            "id": node.id,
            "role": node.role,
        }
        if node.name:
            result["name"] = node.name

        # DOM info
        if node.tag_name:
            result["tagName"] = node.tag_name
        if node.dom_id:
            result["domId"] = node.dom_id
        if node.dom_classes:
            result["domClasses"] = node.dom_classes

        for key, val in sorted(node.properties.items()):
            if key in EXCLUDED_ATTRIBUTES:
                continue
            if val is True:
                mapped = BOOLEAN_PROPERTY_MAP.get(key)
                if mapped:
                    result[mapped] = True
                result[key] = True
            elif val is False:
                continue
            elif isinstance(val, (str, int, float)):
                result[key] = val

        if node.children:
            result["children"] = [to_dict(c) for c in node.children]

        return result

    return to_dict(root)


def find_node_by_uid(root: SnapshotNode | None, uid: str) -> SnapshotNode | None:
    """Find a node in the tree by its uid.

    Args:
        root: Root SnapshotNode with uids assigned.
        uid: The uid to search for.

    Returns:
        The matching SnapshotNode, or None if not found.
    """
    if root is None:
        return None

    queue = [root]
    while queue:
        node = queue.pop(0)
        if node.id == uid:
            return node
        queue.extend(node.children)

    return None


def save_to_file(text: str, file_path: str) -> str:
    """Save snapshot text to a file.

    Args:
        text: Snapshot text.
        file_path: File path (absolute or relative).

    Returns:
        The resolved file path.
    """
    import os

    path = file_path
    if not os.path.isabs(path):
        path = os.path.abspath(path)

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)

    return path


# ─── Snapshot Cache (for browser_click reuse) ───

import os
import glob

_snapshot_cache: dict[str, dict] = {}


def _get_snapshot_dir() -> str:
    """Return the temporary directory for snapshot files."""
    d = "/tmp/cdp-bridge-snapshots"
    os.makedirs(d, exist_ok=True)
    return d


def cleanup_old_snapshot_files(token: str) -> None:
    """Delete all old snapshot temp files for a given token."""
    pattern = os.path.join(_get_snapshot_dir(), f"cdp-bridge-snapshot-{token}-*.txt")
    for f in glob.glob(pattern):
        try:
            os.remove(f)
        except OSError:
            pass


def cache_snapshot(token: str, root, sid: int, tab_id: str) -> str:
    """Cache a snapshot and write it to a temp file. Returns the file path.

    Cleans up old snapshot files for the same token and stale cache entries before writing.

    Args:
        token: Auth token (empty string for single-user mode).
        root: Root SnapshotNode with UIDs assigned.
        sid: Snapshot ID.
        tab_id: Browser tab ID.

    Returns:
        Path to the written snapshot file.
    """
    cleanup_old_snapshot_files(token)
    # Evict stale cache entries for other tokens
    stale_keys = [k for k in _snapshot_cache if k != token]
    for k in stale_keys:
        del _snapshot_cache[k]
    file_path = os.path.join(_get_snapshot_dir(), f"cdp-bridge-snapshot-{token}-{sid}.txt")
    text = format_text(root, verbose=False)
    save_to_file(text, file_path)
    _snapshot_cache[token] = {"root": root, "sid": sid, "tab_id": tab_id, "file_path": file_path}
    return file_path


def get_cached_snapshot(token: str, tab_id: str) -> dict | None:
    """Get the cached snapshot if it matches the current tab.

    Args:
        token: Auth token.
        tab_id: Current browser tab ID.

    Returns:
        Dict with "root", "sid", "tab_id", "file_path" or None if no match.
    """
    cached = _snapshot_cache.get(token)
    if cached and cached["tab_id"] == tab_id:
        return cached
    return None
