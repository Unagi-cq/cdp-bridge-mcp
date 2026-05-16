import argparse
from pathlib import Path

from .server import configure_driver, mcp


def main():
    """Run the CDP Bridge MCP server."""
    parser = argparse.ArgumentParser(
        description="Run the CDP Bridge MCP server for browser automation through the companion extension."
    )
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default="stdio",
        help="MCP transport to use. Defaults to stdio.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="HTTP port for streamable-http transport. Defaults to 8000.",
    )
    parser.add_argument(
        "--ws-port",
        type=int,
        default=18765,
        help="WebSocket port for the companion extension. Defaults to 18765.",
    )
    args = parser.parse_args()
    mcp.settings.port = args.port
    configure_driver(websocket_port=args.ws_port)
    mcp.run(transport=args.transport)


def extension_path():
    """Print the packaged Chrome extension directory."""
    extension_dir = Path(__file__).resolve().parent / "tmwd_cdp_bridge"
    print(extension_dir)


if __name__ == "__main__":
    main()
