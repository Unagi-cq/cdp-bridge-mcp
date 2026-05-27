"""
Pytest configuration and shared fixtures for cdp-bridge tests.
"""

import pytest


@pytest.fixture
def sample_ax_nodes():
    """Basic AX tree with heading, paragraph, and button."""
    return [
        {
            "nodeId": "root_1",
            "ignored": False,
            "role": {"type": "internalValue", "value": "RootWebArea"},
            "name": {"type": "string", "value": "Test Page"},
            "parentId": None,
            "backendDOMNodeId": 1,
            "childIds": ["node_2", "node_3", "node_4"],
            "properties": [
                {"name": "focused", "value": {"type": "boolean", "value": True}},
            ],
        },
        {
            "nodeId": "node_2",
            "ignored": False,
            "role": {"type": "internalValue", "value": "heading"},
            "name": {"type": "string", "value": "Welcome"},
            "parentId": "root_1",
            "backendDOMNodeId": 2,
            "childIds": [],
            "properties": [],
        },
        {
            "nodeId": "node_3",
            "ignored": False,
            "role": {"type": "internalValue", "value": "statictext"},
            "name": {"type": "string", "value": "Some text"},
            "parentId": "root_1",
            "backendDOMNodeId": 3,
            "childIds": [],
            "properties": [],
        },
        {
            "nodeId": "node_4",
            "ignored": False,
            "role": {"type": "internalValue", "value": "button"},
            "name": {"type": "string", "value": "Click me"},
            "parentId": "root_1",
            "backendDOMNodeId": 4,
            "childIds": [],
            "properties": [
                {"name": "disabled", "value": {"type": "boolean", "value": False}},
            ],
        },
    ]


@pytest.fixture
def ax_nodes_with_ignored():
    """AX tree that includes ignored nodes."""
    return [
        {
            "nodeId": "root_1",
            "ignored": False,
            "role": {"type": "internalValue", "value": "RootWebArea"},
            "name": {"type": "string", "value": "Test Page"},
            "parentId": None,
            "backendDOMNodeId": 1,
            "childIds": ["node_2", "node_3"],
            "properties": [],
        },
        {
            "nodeId": "node_2",
            "ignored": False,
            "role": {"type": "internalValue", "value": "button"},
            "name": {"type": "string", "value": "Visible button"},
            "parentId": "root_1",
            "backendDOMNodeId": 2,
            "childIds": [],
            "properties": [],
        },
        {
            "nodeId": "node_3",
            "ignored": True,
            "role": {"type": "internalValue", "value": "genericcontainer"},
            "name": {"type": "string", "value": "Hidden"},
            "parentId": "root_1",
            "backendDOMNodeId": 3,
            "childIds": [],
            "properties": [],
        },
    ]


@pytest.fixture
def deep_nested_nodes():
    """AX tree with 5+ levels of nesting."""
    return [
        {"nodeId": "n1", "ignored": False, "role": {"type": "internalValue", "value": "RootWebArea"}, "name": {"type": "string", "value": "Root"}, "parentId": None, "backendDOMNodeId": 1, "childIds": ["n2"], "properties": []},
        {"nodeId": "n2", "ignored": False, "role": {"type": "internalValue", "value": "group"}, "name": {"type": "string", "value": "Level 1"}, "parentId": "n1", "backendDOMNodeId": 2, "childIds": ["n3"], "properties": []},
        {"nodeId": "n3", "ignored": False, "role": {"type": "internalValue", "value": "group"}, "name": {"type": "string", "value": "Level 2"}, "parentId": "n2", "backendDOMNodeId": 3, "childIds": ["n4"], "properties": []},
        {"nodeId": "n4", "ignored": False, "role": {"type": "internalValue", "value": "group"}, "name": {"type": "string", "value": "Level 3"}, "parentId": "n3", "backendDOMNodeId": 4, "childIds": ["n5"], "properties": []},
        {"nodeId": "n5", "ignored": False, "role": {"type": "internalValue", "value": "group"}, "name": {"type": "string", "value": "Level 4"}, "parentId": "n4", "backendDOMNodeId": 5, "childIds": ["n6"], "properties": []},
        {"nodeId": "n6", "ignored": False, "role": {"type": "internalValue", "value": "button"}, "name": {"type": "string", "value": "Deep button"}, "parentId": "n5", "backendDOMNodeId": 6, "childIds": [], "properties": []},
    ]


@pytest.fixture
def textbox_with_properties():
    """Textbox matching TypeScript reference test: textbox with value, live, relevant, errormessage, details."""
    return [
        {
            "nodeId": "root_1",
            "ignored": False,
            "role": {"type": "internalValue", "value": "textbox"},
            "name": {"type": "string", "value": "my textbox"},
            "parentId": None,
            "backendDOMNodeId": 1,
            "childIds": [],
            "properties": [
                {"name": "value", "value": {"type": "string", "value": "some"}},
                {"name": "live", "value": {"type": "string", "value": "assertive"}},
                {"name": "relevant", "value": {"type": "string", "value": "all"}},
                {"name": "errormessage", "value": {"type": "idref", "value": "error_node"}},
                {"name": "details", "value": {"type": "string", "value": "my details"}},
            ],
        },
    ]


@pytest.fixture
def disabled_button_nodes():
    """Button matching TypeScript reference: disabled, busy, atomic booleans."""
    return [
        {
            "nodeId": "root_1",
            "ignored": False,
            "role": {"type": "internalValue", "value": "button"},
            "name": {"type": "string", "value": "button"},
            "parentId": None,
            "backendDOMNodeId": 1,
            "childIds": [],
            "properties": [
                {"name": "disabled", "value": {"type": "boolean", "value": True}},
                {"name": "busy", "value": {"type": "boolean", "value": True}},
                {"name": "atomic", "value": {"type": "boolean", "value": True}},
            ],
        },
    ]


@pytest.fixture
def checkbox_checked_nodes():
    """Checkbox matching TypeScript reference: checked boolean."""
    return [
        {
            "nodeId": "root_1",
            "ignored": False,
            "role": {"type": "internalValue", "value": "checkbox"},
            "name": {"type": "string", "value": "checkbox"},
            "parentId": None,
            "backendDOMNodeId": 1,
            "childIds": [],
            "properties": [
                {"name": "checked", "value": {"type": "boolean", "value": True}},
            ],
        },
    ]


@pytest.fixture
def mixed_root_with_children():
    """Mixed root with button and textbox children matching TypeScript reference."""
    return [
        {
            "nodeId": "root_1",
            "ignored": False,
            "role": {"type": "internalValue", "value": "RootWebArea"},
            "name": {"type": "string", "value": "body"},
            "parentId": None,
            "backendDOMNodeId": 1,
            "childIds": ["node_2", "node_3"],
            "properties": [],
        },
        {
            "nodeId": "node_2",
            "ignored": False,
            "role": {"type": "internalValue", "value": "button"},
            "name": {"type": "string", "value": "button"},
            "parentId": "root_1",
            "backendDOMNodeId": 2,
            "childIds": [],
            "properties": [],
        },
        {
            "nodeId": "node_3",
            "ignored": False,
            "role": {"type": "internalValue", "value": "textbox"},
            "name": {"type": "string", "value": "textbox"},
            "parentId": "root_1",
            "backendDOMNodeId": 3,
            "childIds": [],
            "properties": [],
        },
    ]
