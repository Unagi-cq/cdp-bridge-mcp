"""
Unit tests for the CDP Bridge Snapshot module.

Covers: parse_ax_tree_response, build_tree, assign_uids,
format_text, format_json, save_to_file, SnapshotIdCounter.
"""

import os
import json
import tempfile
import pytest

from cdp_bridge.snapshot import (
    SnapshotNode,
    SnapshotIdCounter,
    parse_ax_tree_response,
    build_tree,
    assign_uids,
    format_text,
    format_json,
    save_to_file,
    collect_dom_info,
    enrich_nodes_with_dom,
    should_filter_node,
    BOOLEAN_PROPERTY_MAP,
    EXCLUDED_ATTRIBUTES,
)


# =============================================================================
# parse_ax_tree_response tests
# =============================================================================

class TestParseAxTreeResponse:
    """test_parse_ax_tree_response - Parse raw CDP response."""

    def test_parse_ax_tree_response(self):
        """Parse raw CDP response and return node list."""
        ax_data = {
            "nodes": [
                {"nodeId": "1", "role": {"value": "button"}},
                {"nodeId": "2", "role": {"value": "textbox"}},
            ]
        }
        result = parse_ax_tree_response(ax_data)
        assert len(result) == 2
        assert result[0]["nodeId"] == "1"
        assert result[1]["nodeId"] == "2"

    def test_parse_ax_tree_response_empty(self):
        """Parse response with no nodes returns empty list."""
        result = parse_ax_tree_response({"nodes": []})
        assert result == []

    def test_parse_ax_tree_response_missing_nodes_key(self):
        """Parse response without 'nodes' key returns empty list."""
        result = parse_ax_tree_response({})
        assert result == []


# =============================================================================
# build_tree tests
# =============================================================================

class TestBuildTree:
    """Build tree from flat AX nodes."""

    def test_build_tree_basic(self, sample_ax_nodes):
        """Build tree from flat AX nodes with a simple page structure (heading + paragraph + button)."""
        root = build_tree(sample_ax_nodes)
        assert root is not None
        assert root.role == "RootWebArea"
        assert root.name == "Test Page"
        assert len(root.children) == 3

        roles = {c.role for c in root.children}
        assert "heading" in roles
        assert "statictext" in roles
        assert "button" in roles

        heading = next(c for c in root.children if c.role == "heading")
        assert heading.name == "Welcome"

        button = next(c for c in root.children if c.role == "button")
        assert button.name == "Click me"

    def test_build_tree_filters_ignored(self, ax_nodes_with_ignored):
        """When interesting_only=True, nodes with ignored=True should be excluded."""
        root = build_tree(ax_nodes_with_ignored, interesting_only=True)
        assert root is not None
        assert len(root.children) == 1
        assert root.children[0].role == "button"
        assert root.children[0].name == "Visible button"

    def test_build_tree_no_interesting_only(self, ax_nodes_with_ignored):
        """When interesting_only=False, all nodes including ignored ones should be included."""
        root = build_tree(ax_nodes_with_ignored, interesting_only=False)
        assert root is not None
        assert len(root.children) == 2
        roles = {c.role for c in root.children}
        assert "button" in roles
        assert "genericcontainer" in roles

    def test_build_tree_empty(self):
        """Empty node list returns None."""
        root = build_tree([])
        assert root is None

    def test_build_tree_single_node(self):
        """Single node returns as root."""
        nodes = [
            {
                "nodeId": "solo_1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "button"},
                "name": {"type": "string", "value": "Solo"},
                "parentId": None,
                "backendDOMNodeId": 10,
                "childIds": [],
                "properties": [],
            }
        ]
        root = build_tree(nodes)
        assert root is not None
        assert root.role == "button"
        assert root.name == "Solo"
        assert root.backend_dom_node_id == 10
        assert root.children == []

    def test_build_tree_deep_nesting(self, deep_nested_nodes):
        """5+ levels deep tree."""
        root = build_tree(deep_nested_nodes)
        assert root is not None
        assert root.role == "RootWebArea"

        node = root
        depth = 0
        while node.children:
            node = node.children[0]
            depth += 1

        assert depth == 5  # 5 levels of children below root
        assert node.role == "button"
        assert node.name == "Deep button"

    def test_build_tree_properties_parsed(self):
        """Properties are correctly extracted from AX nodes."""
        nodes = [
            {
                "nodeId": "p1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "textbox"},
                "name": {"type": "string", "value": "Input"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [
                    {"name": "value", "value": {"type": "string", "value": "hello"}},
                    {"name": "focused", "value": {"type": "boolean", "value": True}},
                ],
            },
        ]
        root = build_tree(nodes)
        assert root is not None
        assert root.properties["value"] == "hello"
        assert root.properties["focused"] is True


# =============================================================================
# assign_uids tests
# =============================================================================

class TestAssignUids:
    """Assign UIDs to snapshot nodes."""

    def test_assign_uids(self, sample_ax_nodes):
        """UIDs are assigned correctly in format 'snapshotId_counter'."""
        root = build_tree(sample_ax_nodes)
        uid_map = assign_uids(root, snapshot_id=5)

        assert len(uid_map) == 4  # root + 3 children

        expected_uids = {"5_0", "5_1", "5_2", "5_3"}
        assert set(uid_map.keys()) == expected_uids

        root_uid = root.id
        assert root_uid == "5_0"
        assert uid_map[root_uid] is root

    def test_assign_uids_stability(self, sample_ax_nodes):
        """Same tree gets same UIDs on repeated calls."""
        root1 = build_tree(sample_ax_nodes)
        uid_map1 = assign_uids(root1, snapshot_id=10)

        root2 = build_tree(sample_ax_nodes)
        uid_map2 = assign_uids(root2, snapshot_id=10)

        assert set(uid_map1.keys()) == set(uid_map2.keys())

        # Verify UIDs are assigned in traversal order
        root1_uids = sorted(uid_map1.keys())
        root2_uids = sorted(uid_map2.keys())
        assert root1_uids == root2_uids

    def test_assign_uids_none(self):
        """None input returns empty dict."""
        result = assign_uids(None, snapshot_id=1)
        assert result == {}

    def test_assign_uids_counter_increments(self):
        """UID counter increments correctly through tree traversal."""
        nodes = [
            {"nodeId": "a", "ignored": False, "role": {"value": "RootWebArea"}, "name": {"value": "Root"}, "parentId": None, "backendDOMNodeId": 1, "childIds": ["b", "c"], "properties": []},
            {"nodeId": "b", "ignored": False, "role": {"value": "button"}, "name": {"value": "Btn1"}, "parentId": "a", "backendDOMNodeId": 2, "childIds": [], "properties": []},
            {"nodeId": "c", "ignored": False, "role": {"value": "button"}, "name": {"value": "Btn2"}, "parentId": "a", "backendDOMNodeId": 3, "childIds": [], "properties": []},
        ]
        root = build_tree(nodes)
        uid_map = assign_uids(root, snapshot_id=42)

        assert root.id == "42_0"
        # Children get 42_1 and 42_2
        child_uids = {c.id for c in root.children}
        assert child_uids == {"42_1", "42_2"}


# =============================================================================
# format_text tests
# =============================================================================

class TestFormatText:
    """Format snapshot tree as text."""

    def test_format_text_basic(self, sample_ax_nodes):
        """Basic formatting matches expected output."""
        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        # Root node at depth 0
        assert 'uid=1_0' in text
        assert 'RootWebArea' in text
        assert '"Test Page"' in text

        # Should have heading, statictext, button
        assert 'heading' in text
        assert '"Welcome"' in text
        assert 'statictext' in text
        assert '"Some text"' in text
        assert 'button' in text
        assert '"Click me"' in text

    def test_format_text_boolean_properties(self):
        """Boolean properties map correctly (disabled→disableable disabled, focused→focusable focused, etc.)."""
        nodes = [
            {
                "nodeId": "b1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "button"},
                "name": {"type": "string", "value": "Submit"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [
                    {"name": "disabled", "value": {"type": "boolean", "value": True}},
                    {"name": "focused", "value": {"type": "boolean", "value": True}},
                    {"name": "expanded", "value": {"type": "boolean", "value": True}},
                    {"name": "selected", "value": {"type": "boolean", "value": True}},
                ],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        assert "disableable" in text
        assert "disabled" in text
        assert "focusable" in text
        assert "focused" in text
        assert "expandable" in text
        assert "expanded" in text
        assert "selectable" in text
        assert "selected" in text

    def test_format_text_role_none(self):
        """role='none' displays as 'ignored'."""
        nodes = [
            {
                "nodeId": "n1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "none"},
                "name": {"type": "string", "value": "Nothing"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        assert "ignored" in text
        assert '"Nothing"' in text

    def test_format_text_string_values(self):
        """String property values formatted as attr="value"."""
        nodes = [
            {
                "nodeId": "t1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "textbox"},
                "name": {"type": "string", "value": "Email"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [
                    {"name": "value", "value": {"type": "string", "value": "user@example.com"}},
                    {"name": "placeholder", "value": {"type": "string", "value": "Enter email"}},
                ],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        assert 'value="user@example.com"' in text
        assert 'placeholder="Enter email"' in text

    def test_format_text_indentation(self, deep_nested_nodes):
        """Each level has 2-space indentation."""
        root = build_tree(deep_nested_nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        lines = text.strip().split("\n")
        for i, line in enumerate(lines):
            stripped = line.lstrip(" ")
            indent = len(line) - len(stripped)
            assert indent == i * 2, f"Line {i}: expected indent {i*2}, got {indent}"

    def test_format_text_empty(self):
        """None root returns empty string."""
        result = format_text(None)
        assert result == ""

    def test_format_text_no_name(self):
        """Node without name omits quoted name."""
        nodes = [
            {
                "nodeId": "x1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "genericcontainer"},
                "name": {"type": "string", "value": ""},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        assert '""' not in text
        assert "uid=1_0" in text
        assert "genericcontainer" in text

    def test_format_text_false_boolean_skipped(self):
        """False boolean properties are skipped in text output."""
        nodes = [
            {
                "nodeId": "f1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "button"},
                "name": {"type": "string", "value": "Active"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [
                    {"name": "disabled", "value": {"type": "boolean", "value": False}},
                    {"name": "busy", "value": {"type": "boolean", "value": False}},
                ],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        assert "disableable" not in text
        assert "disabled" not in text
        assert "busy" not in text


# =============================================================================
# format_json tests
# =============================================================================

class TestFormatJson:
    """Format snapshot tree as JSON."""

    def test_format_json_basic(self, sample_ax_nodes):
        """JSON output has correct structure."""
        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert result["id"] == "1_0"
        assert result["role"] == "RootWebArea"
        assert result["name"] == "Test Page"

    def test_format_json_boolean_mapping(self):
        """Boolean properties mapped correctly in JSON."""
        nodes = [
            {
                "nodeId": "j1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "button"},
                "name": {"type": "string", "value": "Submit"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [
                    {"name": "disabled", "value": {"type": "boolean", "value": True}},
                    {"name": "focused", "value": {"type": "boolean", "value": True}},
                ],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert result["disableable"] is True
        assert result["disabled"] is True
        assert result["focusable"] is True
        assert result["focused"] is True

    def test_format_json_children(self, mixed_root_with_children):
        """Nested children in JSON."""
        root = build_tree(mixed_root_with_children)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert "children" in result
        assert len(result["children"]) == 2

        child_roles = {c["role"] for c in result["children"]}
        assert "button" in child_roles
        assert "textbox" in child_roles

    def test_format_json_empty(self):
        """None root returns empty dict."""
        result = format_json(None)
        assert result == {}

    def test_format_json_false_boolean_skipped(self):
        """False boolean properties are skipped in JSON output."""
        nodes = [
            {
                "nodeId": "jf1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "button"},
                "name": {"type": "string", "value": "Active"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [
                    {"name": "disabled", "value": {"type": "boolean", "value": False}},
                    {"name": "busy", "value": {"type": "boolean", "value": False}},
                ],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert "disableable" not in result
        assert "disabled" not in result
        assert "busy" not in result

    def test_format_json_string_property(self):
        """String property values preserved in JSON."""
        nodes = [
            {
                "nodeId": "js1",
                "ignored": False,
                "role": {"type": "internalValue", "value": "textbox"},
                "name": {"type": "string", "value": "Name"},
                "parentId": None,
                "backendDOMNodeId": 1,
                "childIds": [],
                "properties": [
                    {"name": "value", "value": {"type": "string", "value": "John"}},
                ],
            },
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert result["value"] == "John"


# =============================================================================
# save_to_file tests
# =============================================================================

class TestSaveToFile:
    """Save snapshot text to file."""

    def test_save_to_file_absolute(self):
        """Save to absolute path."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "output.txt")
            result = save_to_file("hello world", path)

            assert os.path.isabs(result)
            assert os.path.isfile(path)
            with open(path, "r", encoding="utf-8") as f:
                assert f.read() == "hello world"

    def test_save_to_file_relative(self):
        """Save to relative path (resolved to absolute)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            original_cwd = os.getcwd()
            try:
                os.chdir(tmpdir)
                result = save_to_file("relative content", "subdir/test.txt")

                assert os.path.isabs(result)
                assert os.path.isfile(result)
                with open(result, "r", encoding="utf-8") as f:
                    assert f.read() == "relative content"
            finally:
                os.chdir(original_cwd)

    def test_save_to_file_creates_directory(self):
        """save_to_file creates parent directories if they don't exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "deep", "nested", "dir", "file.txt")
            save_to_file("nested", path)
            assert os.path.isfile(path)


# =============================================================================
# SnapshotIdCounter tests
# =============================================================================

class TestSnapshotIdCounter:
    """test_snapshot_id_counter - Counter increments and can reset."""

    def setup_method(self):
        """Reset counter before each test."""
        SnapshotIdCounter.reset()

    def test_counter_increments(self):
        """Counter increments on each call."""
        val1 = SnapshotIdCounter.get_and_increment()
        val2 = SnapshotIdCounter.get_and_increment()
        val3 = SnapshotIdCounter.get_and_increment()

        assert val1 == 1
        assert val2 == 2
        assert val3 == 3

    def test_counter_reset(self):
        """Counter can be reset."""
        SnapshotIdCounter.get_and_increment()
        SnapshotIdCounter.get_and_increment()
        SnapshotIdCounter.reset()

        val = SnapshotIdCounter.get_and_increment()
        assert val == 1

    def test_counter_is_class_level(self):
        """Counter is shared across instances."""
        SnapshotIdCounter.reset()
        SnapshotIdCounter.get_and_increment()
        SnapshotIdCounter.get_and_increment()

        val = SnapshotIdCounter.get_and_increment()
        assert val == 3


# =============================================================================
# Full pipeline tests
# =============================================================================

class TestFullPipeline:
    """End-to-end pipeline tests."""

    def test_full_pipeline(self, sample_ax_nodes):
        """End-to-end: parse -> build_tree -> assign_uids -> format_text."""
        raw_response = {"nodes": sample_ax_nodes}

        # Parse
        nodes = parse_ax_tree_response(raw_response)
        assert len(nodes) == 4

        # Build tree
        root = build_tree(nodes)
        assert root is not None
        assert root.role == "RootWebArea"

        # Assign UIDs
        uid_map = assign_uids(root, snapshot_id=7)
        assert len(uid_map) == 4
        assert root.id == "7_0"

        # Format text
        text = format_text(root)
        assert 'uid=7_0' in text
        assert 'RootWebArea' in text
        assert '"Test Page"' in text
        assert 'heading' in text
        assert 'button' in text

    def test_full_pipeline_json(self, sample_ax_nodes):
        """End-to-end: parse -> build_tree -> assign_uids -> format_json."""
        raw_response = {"nodes": sample_ax_nodes}
        nodes = parse_ax_tree_response(raw_response)
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=42)

        result = format_json(root)
        assert result["id"] == "42_0"
        assert result["role"] == "RootWebArea"
        assert "children" in result
        assert len(result["children"]) == 3

        # Verify JSON serializable
        json_str = json.dumps(result)
        parsed = json.loads(json_str)
        assert parsed["id"] == "42_0"


# =============================================================================
# TypeScript reference matching tests
# =============================================================================

class TestTypeScriptReferenceMatching:
    """test_format_text_matches_typescript_reference - Test cases that exactly match
    the TypeScript snapshotFormatter.test.ts expected outputs."""

    def test_textbox_with_properties(self, textbox_with_properties):
        """Textbox with value, live, relevant, errormessage, details properties."""
        root = build_tree(textbox_with_properties)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        # Check each property appears in output
        assert 'uid=1_0' in text
        assert 'textbox' in text
        assert '"my textbox"' in text
        assert 'value="some"' in text
        assert 'live="assertive"' in text
        assert 'relevant="all"' in text
        assert 'errormessage="error_node"' in text
        assert 'details="my details"' in text

    def test_button_disabled_busy_atomic(self, disabled_button_nodes):
        """Button with disabled, busy, atomic booleans."""
        root = build_tree(disabled_button_nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        assert 'uid=1_0' in text
        assert 'button' in text
        assert '"button"' in text
        # disabled=True -> disableable disabled both appear
        assert 'disableable' in text
        assert 'disabled' in text
        # busy and atomic are not in BOOLEAN_PROPERTY_MAP, so they appear as-is
        assert 'busy' in text
        assert 'atomic' in text

    def test_checkbox_checked(self, checkbox_checked_nodes):
        """Checkbox with checked boolean."""
        root = build_tree(checkbox_checked_nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        assert 'uid=1_0' in text
        assert 'checkbox' in text
        assert '"checkbox"' in text
        # checked is not in BOOLEAN_PROPERTY_MAP, appears as-is
        assert 'checked' in text

    def test_mixed_root_with_button_and_textbox(self, mixed_root_with_children):
        """Mixed root with button and textbox children."""
        root = build_tree(mixed_root_with_children)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        lines = text.strip().split("\n")

        # Root line (no indentation)
        root_line = lines[0]
        assert root_line.startswith("uid=1_0")
        assert "RootWebArea" in root_line
        assert '"body"' in root_line

        # Children (2-space indentation)
        child_lines = [l for l in lines[1:] if l.startswith("  ") and not l.startswith("    ")]
        assert len(child_lines) == 2

        # Check button child
        button_line = next(l for l in child_lines if "button" in l)
        assert "uid=1_1" in button_line or "uid=1_2" in button_line
        assert '"button"' in button_line

        # Check textbox child
        textbox_line = next(l for l in child_lines if "textbox" in l)
        assert "uid=1_1" in textbox_line or "uid=1_2" in textbox_line
        assert '"textbox"' in textbox_line

    def test_json_textbox_with_properties(self, textbox_with_properties):
        """JSON output for textbox with all properties."""
        root = build_tree(textbox_with_properties)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert result["id"] == "1_0"
        assert result["role"] == "textbox"
        assert result["name"] == "my textbox"
        assert result["value"] == "some"
        assert result["live"] == "assertive"
        assert result["relevant"] == "all"
        assert result["errormessage"] == "error_node"
        assert result["details"] == "my details"

    def test_json_button_disabled_busy_atomic(self, disabled_button_nodes):
        """JSON output for button with disabled, busy, atomic."""
        root = build_tree(disabled_button_nodes)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert result["id"] == "1_0"
        assert result["role"] == "button"
        assert result["name"] == "button"
        assert result["disableable"] is True
        assert result["disabled"] is True
        assert result["busy"] is True
        assert result["atomic"] is True

    def test_json_mixed_root_with_children(self, mixed_root_with_children):
        """JSON output for mixed root with button and textbox children."""
        root = build_tree(mixed_root_with_children)
        assign_uids(root, snapshot_id=1)
        result = format_json(root)

        assert result["id"] == "1_0"
        assert result["role"] == "RootWebArea"
        assert result["name"] == "body"
        assert "children" in result
        assert len(result["children"]) == 2

        child_roles = {c["role"] for c in result["children"]}
        assert "button" in child_roles
        assert "textbox" in child_roles


# =============================================================================
# DOM info tests
# =============================================================================

class TestCollectDomInfo:
    """Collect backendDOMNodeId from AX nodes."""

    def test_collect_dom_info_basic(self, sample_ax_nodes):
        """Collect all backendDOMNodeIds from AX nodes."""
        result = collect_dom_info(sample_ax_nodes)
        assert len(result) == 4
        assert 1 in result
        assert 2 in result
        assert 3 in result
        assert 4 in result

    def test_collect_dom_info_no_backend_ids(self):
        """AX nodes without backendDOMNodeId return empty dict."""
        nodes = [
            {"nodeId": "1", "role": {"value": "button"}, "name": {"value": "Click"}},
            {"nodeId": "2", "role": {"value": "textbox"}},
        ]
        result = collect_dom_info(nodes)
        assert result == {}

    def test_collect_dom_info_mixed(self):
        """Only nodes with backendDOMNodeId are collected."""
        nodes = [
            {"nodeId": "1", "role": {"value": "button"}, "backendDOMNodeId": 10},
            {"nodeId": "2", "role": {"value": "textbox"}},
            {"nodeId": "3", "role": {"value": "link"}, "backendDOMNodeId": 30},
        ]
        result = collect_dom_info(nodes)
        assert len(result) == 2
        assert 10 in result
        assert 30 in result


class TestEnrichNodesWithDom:
    """Enrich snapshot nodes with resolved DOM info."""

    def test_enrich_basic(self, sample_ax_nodes):
        """DOM info is populated on nodes with matching backendDOMNodeId."""
        root = build_tree(sample_ax_nodes)
        dom_info = {
            1: {"tagName": "HTML", "id": "", "className": ""},
            2: {"tagName": "H1", "id": "main-heading", "className": "title primary"},
            3: {"tagName": "P", "id": "", "className": "content text-body"},
            4: {"tagName": "BUTTON", "id": "submit-btn", "className": "btn btn-primary flex w-full"},
        }
        enrich_nodes_with_dom(root, dom_info)

        # Root - tag_name stores raw DOM value (uppercase)
        assert root.tag_name == "HTML"
        assert root.dom_id == ""

        # Find heading child
        heading = next(c for c in root.children if c.role == "heading")
        assert heading.tag_name == "H1"
        assert heading.dom_id == "main-heading"
        assert "title" in heading.dom_classes
        assert "primary" in heading.dom_classes

        # Find button child
        button = next(c for c in root.children if c.role == "button")
        assert button.tag_name == "BUTTON"
        assert button.dom_id == "submit-btn"
        assert "btn" in button.dom_classes
        assert "btn-primary" in button.dom_classes
        # Utility classes stored as-is in dom_classes (filtered only in format_text)
        assert "flex" in button.dom_classes
        assert "w-full" in button.dom_classes

    def test_enrich_no_match(self):
        """Nodes without matching backendDOMNodeId are not enriched."""
        nodes = [
            {"nodeId": "1", "ignored": False, "role": {"value": "button"}, "name": {"value": "Click"}, "parentId": None, "backendDOMNodeId": 99, "childIds": [], "properties": []},
        ]
        root = build_tree(nodes)
        dom_info = {1: {"tagName": "DIV", "id": "", "className": ""}}
        enrich_nodes_with_dom(root, dom_info)

        assert root.tag_name == ""
        assert root.dom_id == ""

    def test_enrich_none_root(self):
        """None root is handled gracefully."""
        enrich_nodes_with_dom(None, {1: {"tagName": "DIV"}})


class TestShouldFilterNode:
    """Filter nodes that cannot be clicked."""

    def test_ignored_node(self):
        """Ignored nodes are filtered."""
        node = SnapshotNode()
        node.ignored = True
        node.backend_dom_node_id = 1
        assert should_filter_node(node) is True

    def test_no_backend_id(self):
        """Nodes without backendDOMNodeId are filtered."""
        node = SnapshotNode()
        node.ignored = False
        node.backend_dom_node_id = None
        assert should_filter_node(node) is True

    def test_no_backend_id_but_url(self):
        """Nodes without backendDOMNodeId but with URL are kept (clickable links)."""
        node = SnapshotNode()
        node.ignored = False
        node.backend_dom_node_id = None
        node.properties["url"] = "https://example.com"
        assert should_filter_node(node) is False

    def test_has_backend_id(self):
        """Nodes with backendDOMNodeId are kept."""
        node = SnapshotNode()
        node.ignored = False
        node.backend_dom_node_id = 42
        assert should_filter_node(node) is False


class TestFormatTextWithDomInfo:
    """format_text includes DOM info when available."""

    def test_dom_info_in_output(self, sample_ax_nodes):
        """DOM info (tagName, id, classes) appears in formatted text."""
        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=1)

        # Enrich with DOM info
        dom_info = {
            1: {"tagName": "HTML", "id": "app", "className": "app-root"},
            2: {"tagName": "H1", "id": "main-heading", "className": "title primary flex"},
            3: {"tagName": "P", "id": "", "className": "content text-body"},
            4: {"tagName": "BUTTON", "id": "submit-btn", "className": "btn btn-primary"},
        }
        enrich_nodes_with_dom(root, dom_info)

        text = format_text(root)

        # Root should have html#app.app-root
        assert "html#app.app-root" in text
        # Heading should have h1#main-heading.title.primary (flex filtered)
        assert "h1#main-heading.title.primary" in text
        # Paragraph should have p.content.text-body (no id)
        assert "p.content.text-body" in text
        # Button should have button#submit-btn.btn.btn-primary
        assert "button#submit-btn.btn.btn-primary" in text

    def test_no_dom_info_falls_back(self, sample_ax_nodes):
        """Without DOM info, output format is unchanged from before."""
        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=1)
        text = format_text(root)

        # Should still have uid, role, name
        assert "uid=1_0" in text
        assert "RootWebArea" in text
        assert '"Test Page"' in text
        # But no DOM selector
        assert "html#" not in text

    def test_feature_classes_filter_utility(self):
        """Utility classes like flex, grid, w-full are filtered out."""
        node = SnapshotNode()
        node.id = "1_0"
        node.role = "button"
        node.name = "Click"
        node.dom_classes = ["btn", "flex", "w-full", "btn-primary", "mx-auto", "custom-class"]

        root = node
        text = format_text(root)

        # Feature classes should exclude utility
        assert "btn.btn-primary.custom-class" in text


class TestFormatJsonWithDomInfo:
    """format_json includes DOM info when available."""

    def test_dom_info_in_json(self, sample_ax_nodes):
        """JSON output includes tagName, domId, domClasses."""
        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=1)

        dom_info = {
            1: {"tagName": "HTML", "id": "app", "className": "app-root"},
            2: {"tagName": "H1", "id": "heading", "className": "title"},
            3: {"tagName": "P", "id": "", "className": ""},
            4: {"tagName": "BUTTON", "id": "btn", "className": "btn primary"},
        }
        enrich_nodes_with_dom(root, dom_info)

        result = format_json(root)

        # Root
        assert result["tagName"] == "HTML"
        assert result["domId"] == "app"
        assert result["domClasses"] == ["app-root"]

        # Find heading child
        heading = next(c for c in result.get("children", []) if c["role"] == "heading")
        assert heading["tagName"] == "H1"
        assert heading["domId"] == "heading"
        assert heading["domClasses"] == ["title"]

    def test_json_no_dom_info(self):
        """Without DOM info, JSON has no tagName/domId/domClasses."""
        nodes = [
            {"nodeId": "1", "ignored": False, "role": {"value": "button"}, "name": {"value": "Click"}, "parentId": None, "backendDOMNodeId": 1, "childIds": [], "properties": []},
        ]
        root = build_tree(nodes)
        assign_uids(root, snapshot_id=1)
        # Don't enrich

        result = format_json(root)
        assert "tagName" not in result
        assert "domId" not in result
        assert "domClasses" not in result


# =============================================================================
# Snapshot cache tests
# =============================================================================

class TestSnapshotCache:
    """Snapshot cache for browser_click reuse."""

    def setup_method(self):
        """Reset cache and clean temp files before each test."""
        from cdp_bridge.snapshot import _snapshot_cache, _get_snapshot_dir, cleanup_old_snapshot_files
        import glob, os
        _snapshot_cache.clear()
        # Clean any leftover test files
        for token in ["test_token_a", "test_token_b", ""]:
            cleanup_old_snapshot_files(token)

    def test_cache_and_retrieve(self, sample_ax_nodes):
        """Cache a snapshot and retrieve it with matching tab_id."""
        from cdp_bridge.snapshot import cache_snapshot, get_cached_snapshot

        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=5)

        file_path = cache_snapshot("test_token_a", root, 5, "tab_123")

        assert os.path.isfile(file_path)
        assert "uid=5_0" in open(file_path).read()

        cached = get_cached_snapshot("test_token_a", "tab_123")
        assert cached is not None
        assert cached["root"] is root
        assert cached["sid"] == 5
        assert cached["tab_id"] == "tab_123"

    def test_cache_tab_mismatch(self, sample_ax_nodes):
        """Cache returns None when tab_id doesn't match."""
        from cdp_bridge.snapshot import cache_snapshot, get_cached_snapshot

        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=5)
        cache_snapshot("test_token_a", root, 5, "tab_123")

        cached = get_cached_snapshot("test_token_a", "tab_456")
        assert cached is None

    def test_cache_token_isolation(self, sample_ax_nodes):
        """Different tokens have isolated caches."""
        from cdp_bridge.snapshot import cache_snapshot, get_cached_snapshot

        root_a = build_tree(sample_ax_nodes)
        assign_uids(root_a, snapshot_id=5)
        cache_snapshot("test_token_a", root_a, 5, "tab_123")

        root_b = build_tree(sample_ax_nodes)
        assign_uids(root_b, snapshot_id=6)
        cache_snapshot("test_token_b", root_b, 6, "tab_456")

        # Token A sees its own cache
        cached_a = get_cached_snapshot("test_token_a", "tab_123")
        assert cached_a["sid"] == 5

        # Token B sees its own cache
        cached_b = get_cached_snapshot("test_token_b", "tab_456")
        assert cached_b["sid"] == 6

        # Token A can't see Token B's tab
        cached_cross = get_cached_snapshot("test_token_a", "tab_456")
        assert cached_cross is None

    def test_cache_overwrites_old_file(self, sample_ax_nodes):
        """Caching a new snapshot deletes the old temp file for the same token."""
        from cdp_bridge.snapshot import cache_snapshot, get_cached_snapshot, _get_snapshot_dir
        import glob

        root1 = build_tree(sample_ax_nodes)
        assign_uids(root1, snapshot_id=5)
        path1 = cache_snapshot("test_token_a", root1, 5, "tab_123")

        root2 = build_tree(sample_ax_nodes)
        assign_uids(root2, snapshot_id=6)
        path2 = cache_snapshot("test_token_a", root2, 6, "tab_123")

        # Old file should be deleted
        assert not os.path.exists(path1)
        # New file exists
        assert os.path.isfile(path2)

        # Only one file for this token
        pattern = os.path.join(_get_snapshot_dir(), "cdp-bridge-snapshot-test_token_a-*.txt")
        files = glob.glob(pattern)
        assert len(files) == 1

    def test_cache_empty_token(self, sample_ax_nodes):
        """Empty string token (single-user mode) works correctly."""
        from cdp_bridge.snapshot import cache_snapshot, get_cached_snapshot

        root = build_tree(sample_ax_nodes)
        assign_uids(root, snapshot_id=5)
        cache_snapshot("", root, 5, "tab_123")

        cached = get_cached_snapshot("", "tab_123")
        assert cached is not None
        assert cached["sid"] == 5

    def test_cache_no_entry(self):
        """get_cached_snapshot returns None for unknown token."""
        from cdp_bridge.snapshot import get_cached_snapshot
        assert get_cached_snapshot("nonexistent", "tab_123") is None
