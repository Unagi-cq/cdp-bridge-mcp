import argparse
from importlib import resources

from .server import mcp


def main():
    """Run the CDP Bridge MCP server."""
    parser = argparse.ArgumentParser(
        description="Run the CDP Bridge MCP server for browser automation through the companion extension."
    )
    parser.parse_args()
    mcp.run()


def extension_path():
    """Print the packaged Chrome extension directory."""
    extension_dir = resources.files(__package__) / "tmwd_cdp_bridge"
    print(extension_dir)


if __name__ == "__main__":
    main()
