import json, threading, time, uuid, queue, socket, requests, traceback, sys
from typing import Dict, Any, Optional, List
from simple_websocket_server import WebSocketServer, WebSocket
import bottle
from bottle import request

def log(*args, **kwargs):
    print(*args, file=sys.stderr, flush=True, **kwargs)

def _tlog(token, *args, **kwargs):
    """Log with token prefix when token is meaningful."""
    if token and token != '__default__':
        print(f"[{token}]", *args, file=sys.stderr, flush=True, **kwargs)
    else:
        print(*args, file=sys.stderr, flush=True, **kwargs)

class Session:
    def __init__(self, session_id, info, client=None):
        self.id = session_id
        self.info = info
        self.connect_at = time.time()
        self.disconnect_at = None
        self.type = info.get('type', 'ext_ws')
        self.ws_client = client if self.type == 'ext_ws' else None
        self.http_queue = client if self.type == 'http' else None
    @property
    def url(self): return self.info.get('url', '')
    def is_active(self):
        if self.type == 'http' and self.disconnect_at is None and time.time() - self.connect_at > 60:
            self.mark_disconnected()
        return self.disconnect_at is None
    def reconnect(self, client, info):
        self.info = info
        self.type = info.get('type', 'ext_ws')
        if self.type == 'ext_ws':
            self.ws_client = client
            self.http_queue = None
        elif self.type == 'http':
            self.http_queue = client
            self.ws_client = None
        self.connect_at = time.time()
        self.disconnect_at = None
    def mark_disconnected(self):
        if self.disconnect_at is None:
            log(f"Tab disconnected: {self.url} (Session: {self.id})")
            self.disconnect_at = time.time()


class UserContext:
    """Per-token isolated state: sessions, results, acks."""
    def __init__(self, token: str):
        self.token = token
        self.sessions: Dict[str, Session] = {}
        self.results: Dict[str, Any] = {}
        self.acks: Dict[str, bool] = {}
        self.default_session_id: Optional[str] = None
        self.latest_session_id: Optional[str] = None
        self.created_at: float = time.time()
        self.last_active: float = time.time()

    def clean_sessions(self):
        sids = list(self.sessions.keys())
        for sid in sids:
            session = self.sessions[sid]
            if not session.is_active() and time.time() - session.disconnect_at > 600:
                del self.sessions[sid]

    def get_all_active_sessions(self):
        return [{'id': session.id, **session.info} for session in self.sessions.values()
                if session.is_active()]


class TokenManager:
    """Manages token -> UserContext mapping."""
    def __init__(self, allowed_tokens: Optional[List[str]] = None):
        self.contexts: Dict[str, UserContext] = {}
        self._lock = threading.Lock()
        self.allowed_tokens = set(allowed_tokens) if allowed_tokens else None

    def validate(self, token: str) -> bool:
        if self.allowed_tokens is None:
            return True
        return token in self.allowed_tokens

    def get_context(self, token: str) -> UserContext:
        with self._lock:
            if token not in self.contexts:
                self.contexts[token] = UserContext(token)
            ctx = self.contexts[token]
            ctx.last_active = time.time()
            return ctx

    def cleanup_expired(self, max_idle: float = 3600):
        with self._lock:
            expired = [t for t, ctx in self.contexts.items()
                       if time.time() - ctx.last_active > max_idle and t != '__default__']
            for t in expired:
                _tlog(t, "[TokenManager] Cleaning expired context")
                del self.contexts[t]


class TMWebDriver:
    def __init__(self, host: str = '127.0.0.1', port: int = 18765, multi_user: bool = False, allowed_tokens: Optional[List[str]] = None):
        self.host, self.port = host, port
        self.multi_user = multi_user

        if multi_user:
            self.token_manager = TokenManager(allowed_tokens=allowed_tokens)
        else:
            self._default_ctx = UserContext("__default__")

        # Legacy attributes for backward compat (delegate to default context in single-user mode)
        self.is_remote = socket.socket().connect_ex((host, port+1)) == 0
        if not self.is_remote:
            self.start_ws_server()
            self.start_http_server()
        else:
            self.remote = f'http://{self.host}:{self.port+1}/link'

    def get_context(self, token: Optional[str] = None) -> UserContext:
        if not self.multi_user:
            return self._default_ctx
        if not token:
            return self.token_manager.get_context("__default__")
        if not self.token_manager.validate(token):
            raise ValueError(f"Token rejected: {token}")
        return self.token_manager.get_context(token)

    # Backward-compatible properties that delegate to default context
    @property
    def sessions(self):
        return self._default_ctx.sessions if not self.multi_user else {}
    @property
    def results(self):
        return self._default_ctx.results if not self.multi_user else {}
    @property
    def acks(self):
        return self._default_ctx.acks if not self.multi_user else {}
    @property
    def default_session_id(self):
        return self._default_ctx.default_session_id if not self.multi_user else None
    @default_session_id.setter
    def default_session_id(self, value):
        if not self.multi_user:
            self._default_ctx.default_session_id = value
    @property
    def latest_session_id(self):
        return self._default_ctx.latest_session_id if not self.multi_user else None
    @latest_session_id.setter
    def latest_session_id(self, value):
        if not self.multi_user:
            self._default_ctx.latest_session_id = value

    def start_http_server(self):
        self.app = app = bottle.Bottle()

        @app.route('/api/longpoll', method=['GET', 'POST'])
        def long_poll():
            data = request.json
            token = data.get('token', '__default__') if self.multi_user else '__default__'
            ctx = self.get_context(token)
            session_id = data.get('sessionId')
            session_info = {'url': data.get('url'), 'title': data.get('title', ''), 'type': 'http'}
            if session_id not in ctx.sessions:
                session = Session(session_id, session_info, queue.Queue())
                _tlog(token, f"Browser http connected: {session.url} (Session: {session_id})")
                ctx.sessions[session_id] = session
            session = ctx.sessions[session_id]
            if session.disconnect_at is not None and session.type != 'http': session.reconnect(queue.Queue(), session_info)
            session.disconnect_at = None
            if session.type == 'http': msgQ = session.http_queue
            else: return json.dumps({"id": "", "ret": "use ws"})
            session.connect_at = start_time = time.time()
            while time.time() - start_time < 5:
                try:
                    msg = msgQ.get(timeout=0.2)
                    try: ctx.acks[json.loads(msg).get('id','')] = True
                    except: traceback.print_exc()
                    return msg
                except queue.Empty: continue
            return json.dumps({"id": "", "ret": "next long-poll"})

        @app.route('/api/result', method=['GET','POST'])
        def result():
            data = request.json
            token = data.get('token', '__default__') if self.multi_user else '__default__'
            ctx = self.get_context(token)
            if data.get('type') == 'result':
                ctx.results[data.get('id')] = {'success': True, 'data': data.get('result'), 'newTabs': data.get('newTabs', [])}
            elif data.get('type') == 'error':
                ctx.results[data.get('id')] = {'success': False, 'data': data.get('error'), 'newTabs': data.get('newTabs', [])}
            return 'ok'

        @app.route('/link', method=['GET','POST'])
        def link():
            data = request.json
            token = data.get('token') if self.multi_user else None
            if data.get('cmd') == 'get_all_sessions': return json.dumps({'r': self.get_all_sessions(token=token)}, ensure_ascii=False)
            if data.get('cmd') == 'find_session':
                url_pattern = data.get('url_pattern', '')
                return json.dumps({'r': self.find_session(url_pattern, token=token)}, ensure_ascii=False)
            if data.get('cmd') == 'execute_js':
                session_id = data.get('sessionId')
                code = data.get('code')
                timeout = float(data.get('timeout', 10.0))
                try:
                    result = self.execute_js(code, timeout=timeout, session_id=session_id, token=token)
                    _tlog(token, '[remote result]', (str(code)[:50] + ' RESULT:' +str(result)[:50]).replace('\n', ' '))
                    return json.dumps({'r': result}, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'r': {'error': str(e)}}, ensure_ascii=False)
            return 'ok'
        def run():
            from wsgiref.simple_server import make_server, WSGIServer, WSGIRequestHandler
            from socketserver import ThreadingMixIn
            class _T(ThreadingMixIn, WSGIServer): pass
            class _H(WSGIRequestHandler):
                def log_request(self, *a): pass
            make_server(self.host, self.port+1, app, server_class=_T, handler_class=_H).serve_forever()
        http_thread = threading.Thread(target=run, daemon=True)
        http_thread.start()  

    def clean_sessions(self, token=None):
        ctx = self.get_context(token)
        ctx.clean_sessions()

    def start_ws_server(self) -> None:
        driver = self
        class JSExecutor(WebSocket):
            def handle(self) -> None:
                try:
                    data = json.loads(self.data)
                    if data.get('type') in ['ext_ready', 'tabs_update']:
                        token = data.get('token', '__default__') if driver.multi_user else '__default__'
                        ctx = driver.get_context(token)
                        self._token = token
                        tabs = data.get('tabs', [])
                        current_tab_ids = {str(tab['id']) for tab in tabs}
                        _tlog(token, f"Received tabs update: {current_tab_ids}")
                        for sid in list(ctx.sessions.keys()):
                            sess = ctx.sessions[sid]
                            if sess.type == 'ext_ws' and sid not in current_tab_ids:
                                sess.mark_disconnected()
                        for tab in tabs:
                            session_id = str(tab['id'])
                            session_info = {'url': tab.get('url'), 'title': tab.get('title', ''), 'connected_at': time.time(), 'type': 'ext_ws'}
                            sess = ctx.sessions.get(session_id)
                            if sess and sess.is_active() and sess.ws_client is self:
                                sess.info = session_info
                            else: driver._register_client(session_id, self, session_info, token=token)
                    elif data.get('type') == 'ack':
                        token = getattr(self, '_token', '__default__')
                        ctx = driver.get_context(token)
                        ctx.acks[data.get('id','')] = True
                    elif data.get('type') == 'result':
                        token = getattr(self, '_token', '__default__')
                        ctx = driver.get_context(token)
                        ctx.results[data.get('id')] = {'success': True, 'data': data.get('result'), 'newTabs': data.get('newTabs', [])}
                    elif data.get('type') == 'error':
                        token = getattr(self, '_token', '__default__')
                        ctx = driver.get_context(token)
                        ctx.results[data.get('id')] = {'success': False, 'data': data.get('error'), 'newTabs': data.get('newTabs', [])}
                except Exception as e:
                    _tlog(getattr(self, '_token', None), f"Error handling message: {e}")
                    if hasattr(self, 'data'): _tlog(getattr(self, '_token', None), self.data)
            def connected(self): (f"New connection from {self.address}")
            def handle_close(self):
                _tlog(getattr(self, '_token', None), f"WS Connection closed: {self.address}")
                driver._unregister_client(self)

        self.server = WebSocketServer(self.host, self.port, JSExecutor)
        server_thread = threading.Thread(target=self.server.serve_forever)
        server_thread.daemon = True
        server_thread.start()
        log(f"WebSocket server running on ws://{self.host}:{self.port}")

    def _register_client(self, session_id: str, client: WebSocket, session_info, token: Optional[str] = None) -> None:
        ctx = self.get_context(token)
        is_new_session = session_id not in ctx.sessions

        if is_new_session:
            session = Session(session_id, session_info, client)
            ctx.sessions[session_id] = session
            _tlog(token, f"New tab connected: {session.url} (Session: {session_id})")
        else:
            session = ctx.sessions[session_id]
            session.reconnect(client, session_info)
            _tlog(token, f"Tab reconnected: {session.url} (Session: {session_id})")

        ctx.latest_session_id = session_id
        if ctx.default_session_id is None: ctx.default_session_id = session_id

    def _unregister_client(self, client: WebSocket) -> None:
        if self.multi_user:
            for ctx in self.token_manager.contexts.values():
                for session in ctx.sessions.values():
                    if session.ws_client == client: session.mark_disconnected()
        else:
            for session in self._default_ctx.sessions.values():
                if session.ws_client == client: session.mark_disconnected()

    def execute_js(self, code, timeout=15, session_id=None, token=None) -> Any:
        ctx = self.get_context(token)
        if session_id is None: session_id = ctx.default_session_id
        if self.is_remote:
            _tlog(token, 'remote_execute_js')
            cmd = {"cmd": "execute_js", "sessionId": session_id,
                   "code": code, "timeout": str(timeout)}
            if token: cmd["token"] = token
            response = self._remote_cmd(cmd).get('r', {})
            if response.get('error'): raise Exception(response['error'])
            return response

        session = ctx.sessions.get(session_id)
        if not session or not session.is_active():
            time.sleep(3)
            session = ctx.sessions.get(session_id)
            if not session or not session.is_active():
                alive_sessions = [s for s in ctx.sessions.values() if s.is_active()]
                if alive_sessions:
                    session = alive_sessions[0]
                    _tlog(token, f"会话 {session_id} 未连接，自动切换到最新活动会话: {session.id}")
                    session_id = ctx.default_session_id = session.id
                if not session or not session.is_active():
                    raise ValueError(f"会话ID {session_id} 未连接")

        tp = session.type
        if tp not in ('http', 'ext_ws'):
            raise ValueError(f"Unsupported session type: {tp}")
        exec_id = str(uuid.uuid4())
        payload_dict = {'id': exec_id, 'code': code}
        if tp == 'ext_ws': payload_dict['tabId'] = int(session.id)
        payload = json.dumps(payload_dict)

        if tp == 'ext_ws': session.ws_client.send_message(payload)
        elif tp == 'http': session.http_queue.put(payload)

        start_time = time.time()
        ctx.clean_sessions()
        hasjump = acked = False

        while exec_id not in ctx.results:
            time.sleep(0.2)
            if not acked and exec_id in ctx.acks:
                acked = True; start_time = time.time()
            if tp == 'ext_ws':
                if not session.is_active(): hasjump = True
                if hasjump and session.is_active():
                    return {'result': f"Session {session_id} reloaded.", "closed":1}
            if time.time() - start_time > timeout:
                if tp == 'ext_ws':
                    if hasjump: return {'result': f"Session {session_id} reloaded and new page is loading...", 'closed':1}
                    if acked: return {"result": f"No response data in {timeout}s (ACK received, script may still be running)"}
                    return {"result": f"No response data in {timeout}s (no ACK, script may not have been delivered)"}
                elif tp == 'http':
                    if acked: return {"result": f"Session {session_id} no response in {timeout}s (delivered but no result)"}
                    return {"result": f"Session {session_id} no response in {timeout}s (script not polled)"}

        result = ctx.results.pop(exec_id)
        if exec_id in ctx.acks: ctx.acks.pop(exec_id)
        if not result['success']: raise Exception(result['data'])
        rr = {'data': result['data']}
        newtabs = result.get('newTabs', []); [x.pop('ts', None) for x in newtabs]
        if newtabs: rr['newTabs'] = newtabs
        return rr

    def _remote_cmd(self, cmd):
        try:
            session = requests.Session()
            session.trust_env = False
            resp = session.post(self.remote, headers={"Content-Type": "application/json"}, json=cmd, timeout=30)
            resp.raise_for_status()
            if not resp.text.strip():
                raise RuntimeError(f"TMWebDriver master returned an empty response for {cmd.get('cmd')}")
            try:
                return resp.json()
            except ValueError as e:
                snippet = resp.text[:200].replace("\n", " ")
                raise RuntimeError(f"TMWebDriver master returned non-JSON response for {cmd.get('cmd')}: {snippet}") from e
        except (ConnectionError, requests.exceptions.ConnectionError):
            raise ConnectionError("TMWebDriver master未运行，看tmwebdriver_sop启动master")

    def get_all_sessions(self, token=None):
        if self.is_remote:
            cmd = {"cmd": "get_all_sessions"}
            if token: cmd["token"] = token
            return self._remote_cmd(cmd).get('r', [])
        ctx = self.get_context(token)
        return ctx.get_all_active_sessions()

    def get_session_dict(self, token=None):
        return {session['id']: session['url'] for session in self.get_all_sessions(token=token)}

    def find_session(self, url_pattern: str, token=None):
        ctx = self.get_context(token)
        if url_pattern == '':
            session = ctx.sessions.get(ctx.latest_session_id)
            return [(session.id, session.info)] if session else []
        matching_sessions = []
        for session in ctx.sessions.values():
            if not session.is_active(): continue
            if 'url' in session.info and url_pattern in session.info['url']:
                matching_sessions.append((session.id, session.info))
        return matching_sessions

    def set_session(self, url_pattern: str, token=None) -> bool:
        ctx = self.get_context(token)
        if self.is_remote:
            cmd = {"cmd": "find_session", "url_pattern": url_pattern}
            if token: cmd["token"] = token
            matched = self._remote_cmd(cmd).get('r', [])
        else:
            matched = self.find_session(url_pattern, token=token)
        if not matched: return _tlog(token, f"警告: 未找到URL包含 '{url_pattern}' 的会话")
        if len(matched) > 1: _tlog(token, f"警告: 找到多个URL包含 '{url_pattern}' 的会话，选择第一个")
        ctx.default_session_id, info = matched[0]
        _tlog(token, f"成功设置默认会话: {ctx.default_session_id}: {info['url']}")
        return ctx.default_session_id

    def jump(self, url, timeout=10, token=None):
        self.execute_js(
            f"window.location.href = {json.dumps(url, ensure_ascii=False)}",
            timeout=timeout,
            token=token,
        )
    
if __name__ == "__main__":
    driver = TMWebDriver(host='127.0.0.1', port=18765)
