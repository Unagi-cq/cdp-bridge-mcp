from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .server import current_token, get_driver


class TokenAuthMiddleware(BaseHTTPMiddleware):
    """Extract Bearer token from Authorization header and set it in ContextVar."""

    async def dispatch(self, request, call_next):
        # Skip health check / non-MCP paths
        path = request.url.path
        if path in ("/health", "/favicon.ico"):
            return await call_next(request)

        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:].strip()
        else:
            token = request.query_params.get("token", "")

        # Validate token if whitelist is configured
        if token:
            d = get_driver()
            if d.multi_user and d.token_manager.allowed_tokens and not d.token_manager.validate(token):
                return JSONResponse({"error": "Invalid token"}, status_code=403)

        # Set token in ContextVar for downstream tool functions
        # Empty token maps to "__default__" context (backward compat)
        tok = current_token.set(token)
        try:
            response = await call_next(request)
        finally:
            current_token.reset(tok)
        return response
