import argparse
import os
from pathlib import Path

from .server import configure_driver, mcp, current_token


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
        "--host",
        type=str,
        default="127.0.0.1",
        help="HTTP host for streamable-http transport. Defaults to 127.0.0.1.",
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
    parser.add_argument(
        "--tokens",
        type=str,
        default="",
        help="Comma-separated list of allowed tokens. Empty = accept any token.",
    )

    args = parser.parse_args()

    # Parse allowed tokens from arg or env
    tokens_str = args.tokens or os.environ.get("CDP_BRIDGE_TOKENS", "")
    allowed_tokens = [t.strip() for t in tokens_str.split(",") if t.strip()] or None

    mcp.settings.host = args.host
    mcp.settings.port = args.port

    if args.transport == "streamable-http" and args.host != "127.0.0.1" and args.host != "localhost":
        from mcp.server.fastmcp.server import TransportSecuritySettings

        if args.host == "0.0.0.0":
            # 配置为所有网卡ip，则直接关闭FastMCP DNS rebinding防护
            mcp.settings.transport_security = TransportSecuritySettings(
                enable_dns_rebinding_protection=False,
            )
        else:
            # 根据配置的--host推断FastMCP DNS rebinding防护规则，如--host配置为192.168.0.1，则规则为"192.168.0.1:*"
            mcp.settings.transport_security = TransportSecuritySettings(
                enable_dns_rebinding_protection=True,
                allowed_hosts=[f"{args.host}:*"],
            )

    if args.transport == "streamable-http":
        configure_driver(websocket_port=args.ws_port, multi_user=True, allowed_tokens=allowed_tokens)
        _run_with_token_middleware(args)
    else:
        configure_driver(websocket_port=args.ws_port, multi_user=False, allowed_tokens=None)
        mcp.run(transport=args.transport)


def _run_with_token_middleware(args):
    """Run streamable-http with token extraction middleware."""
    import anyio

    async def _serve():
        import uvicorn
        from starlette.middleware import Middleware
        from starlette.middleware.base import BaseHTTPMiddleware

        from .middleware import TokenAuthMiddleware

        # Get the base Starlette app from FastMCP
        starlette_app = mcp.streamable_http_app()

        # Add token middleware
        starlette_app.add_middleware(TokenAuthMiddleware)

        config = uvicorn.Config(
            starlette_app,
            host=mcp.settings.host,
            port=mcp.settings.port,
            log_level=mcp.settings.log_level.lower(),
        )
        server = uvicorn.Server(config)
        await server.serve()

    anyio.run(_serve)


def extension_path():
    """Print the packaged Chrome extension directory."""
    extension_dir = Path(__file__).resolve().parent / "tmwd_cdp_bridge"
    print(extension_dir)


if __name__ == "__main__":
    main()
