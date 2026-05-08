import argparse

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
    print("src/cdp_bridge/tmwd_cdp_bridge")


if __name__ == "__main__":
    main()
