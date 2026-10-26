'use strict';
// cdp-bridge 桥接服务端 —— Node 版（鸿蒙 OpenHarmony 专用）
// 原版是 Python（依赖 pydantic-core/rpds 等原生 .so，在 OHOS 上因缺少代码签名无法加载）。
// 本文件为等价重写：零原生依赖，纯 Node 内置模块。
//
// 监听：
//   :18765  WebSocket —— 浏览器扩展(CDP Bridge 扩展)主动连入
//   :18765  HTTP GET  —— 扩展的存活探测 fetch('http://127.0.0.1:18765')
//   :18766  HTTP API  —— 控制面，供 MCP stdio 进程调用
//
// 协议（与 Python 原版完全兼容）：
//   扩展 -> 服务端: {"type":"ext_ready"|"tabs_update","tabs":[{id,url,title}],"token":...}
//                   {"type":"ack","id":...} / {"type":"result","id":...,"result":...,"newTabs":[...]}
//                   {"type":"error","id":...,"error":...}
//   服务端 -> 扩展: {"id":execId,"code":<JS字符串 或 带cmd的JSON对象字符串>,"tabId":tabId}

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const ws = require('./ws-mini.js');

const WS_PORT = parseInt(process.env.CDP_BRIDGE_WS_PORT || '18765', 10);
const CTRL_PORT = parseInt(process.env.CDP_BRIDGE_CTRL_PORT || '18766', 10);
const LOG_FILE = process.env.CDP_BRIDGE_LOG || path.join(__dirname, 'bridge.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
  console.log(line);
}

const state = {
  // tabId(string) -> { id, url, title, conn, connectedAt, disconnectAt }
  sessions: new Map(),
  results: new Map(),   // execId -> { success, data, newTabs }
  acks: new Set(),
  defaults: new Map(),  // token -> default tabId
  latest: new Map(),    // token -> latest tabId
  conns: new Set(),
};

function ctxGet(map, token) {
  const k = token || '__default__';
  if (!map.has(k)) map.set(k, null);
  return map.get(k);
}
function ctxSet(map, token, v) { map.set(token || '__default__', v); }

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

// ---------- 会话管理 ----------
function registerTabs(conn, tabs, token) {
  const current = new Set(tabs.map(t => String(t.id)));
  for (const [sid, sess] of state.sessions) {
    if (sess.conn === conn && !current.has(sid)) sess.disconnectAt = Date.now();
  }
  let added = 0;
  for (const tab of tabs) {
    const sid = String(tab.id);
    const info = { id: sid, url: tab.url || '', title: tab.title || '', connectedAt: Date.now(), type: 'ext_ws' };
    const existing = state.sessions.get(sid);
    if (existing && existing.conn === conn && !existing.disconnectAt) {
      existing.url = info.url; existing.title = info.title; existing.connectedAt = info.connectedAt;
    } else {
      state.sessions.set(sid, Object.assign({ conn, disconnectAt: null }, info));
      added++;
    }
    ctxSet(state.latest, token, sid);
    if (!ctxGet(state.defaults, token)) ctxSet(state.defaults, token, sid);
  }
  log(`tabs sync: ${tabs.length} tabs (${added} new) from ${conn.remoteAddress || 'ext'}`);
}

function dropConn(conn) {
  state.conns.delete(conn);
  for (const sess of state.sessions.values()) {
    if (sess.conn === conn && !sess.disconnectAt) sess.disconnectAt = Date.now();
  }
}

function getActiveSessions() {
  const out = [];
  for (const sess of state.sessions.values()) {
    if (sess.disconnectAt) continue;
    out.push({ id: sess.id, url: sess.url, title: sess.title });
  }
  return out;
}

function findSession(sessionId, token) {
  let sid = sessionId;
  if (!sid) sid = ctxGet(state.defaults, token);
  if (!sid) return null;
  let sess = state.sessions.get(String(sid));
  if (sess && !sess.disconnectAt) return sess;
  // 兜底：切到任意活动会话
  const alive = getActiveSessions();
  if (alive.length) {
    sess = state.sessions.get(alive[0].id);
    ctxSet(state.defaults, token, sess.id);
    return sess;
  }
  return null;
}

// ---------- 命令下发 ----------
function executeOnTab(sess, code, timeoutMs) {
  return new Promise((resolve, reject) => {
    const execId = uuid();
    const payload = JSON.stringify({
      id: execId, code,
      tabId: parseInt(sess.id, 10),
      timeout: Math.round(timeoutMs / 1000), // 扩展据此分配三级降级的时间预算
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      const acked = state.acks.has(execId);
      state.acks.delete(execId);
      resolve({
        data: acked
          ? `No response data in ${Math.round(timeoutMs / 1000)}s (ACK received, script may still be running)`
          : `No response data in ${Math.round(timeoutMs / 1000)}s (no ACK, script may not have been delivered)`,
        timedOut: true,
      });
    }, timeoutMs);

    const poll = setInterval(() => {
      if (state.results.has(execId)) {
        const r = state.results.get(execId);
        state.results.delete(execId);
        state.acks.delete(execId);
        if (settled) return;
        settled = true;
        clearInterval(poll); clearTimeout(timer);
        if (r.success) resolve({ data: r.data, newTabs: r.newTabs });
        else reject(new Error(typeof r.data === 'string' ? r.data : JSON.stringify(r.data)));
      }
    }, 30);

    log('EXEC send id=' + execId + ' tab=' + sess.id + ' code=' + String(code).slice(0, 200));
    try {
      sess.conn.send(payload);
    } catch (e) {
      settled = true; clearInterval(poll); clearTimeout(timer);
      reject(new Error('send failed: ' + e.message));
    }
  });
}

// 等待首个扩展连入（最多 waitMs）
function waitForTab(waitMs, token) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      const s = findSession(null, token);
      if (s) { clearInterval(t); resolve(s); }
      else if (Date.now() - start > waitMs) { clearInterval(t); resolve(null); }
    }, 200);
  });
}

// ---------- HTTP 控制面 (18766) ----------
const ctrl = http.createServer((req, res) => {
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  let body = '';
  req.on('data', d => { body += d; if (body.length > 20 * 1024 * 1024) req.destroy(); });
  req.on('end', async () => {
    const send = (obj) => { res.writeHead(200, cors); res.end(JSON.stringify(obj)); };
    try {
      const data = body ? JSON.parse(body) : {};
      const cmd = data.cmd || (req.url || '').replace(/^\/+/, '').split('?')[0];
      const token = data.token || '__default__';

      if (cmd === 'status' || cmd === '' ) {
        return send({ r: { ok: true, connections: state.conns.size, tabs: getActiveSessions().length } });
      }
      if (cmd === 'get_all_sessions') {
        return send({ r: getActiveSessions() });
      }
      if (cmd === 'find_session') {
        const pat = data.url_pattern || '';
        const list = getActiveSessions().filter(s => (s.url || '').includes(pat));
        return send({ r: list });
      }
      if (cmd === 'set_default') {
        ctxSet(state.defaults, token, String(data.sessionId));
        return send({ r: { ok: true, default: String(data.sessionId) } });
      }
      if (cmd === 'execute_js') {
        const timeoutMs = Math.max(1000, parseFloat(data.timeout || 15) * 1000);
        let sess = data.sessionId ? state.sessions.get(String(data.sessionId)) : null;
        if (!sess || sess.disconnectAt) sess = findSession(null, token);
        if (!sess) {
          // 给扩展 3 秒连上来的机会
          sess = await waitForTab(3000, token);
        }
        if (!sess) return send({ r: { error: 'No browser tabs connected. Ensure the CDP Bridge extension is running.' } });
        try {
          const out = await executeOnTab(sess, data.code, timeoutMs);
          return send({ r: { data: out.data, newTabs: out.newTabs || [], tabId: sess.id } });
        } catch (e) {
          return send({ r: { error: e.message } });
        }
      }
      return send({ r: { error: 'unknown cmd: ' + cmd } });
    } catch (e) {
      res.writeHead(400, cors);
      res.end(JSON.stringify({ r: { error: 'bad request: ' + e.message } }));
    }
  });
});

// ---------- 主服务 (18765): HTTP 探测 + WebSocket ----------
const server = http.createServer((req, res) => {
  // 扩展 isServerAlive() 会 fetch('http://host:port') —— 只需能拿到 HTTP 响应即可
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    service: 'cdp-bridge-ohos',
    ok: true,
    connections: state.conns.size,
    tabs: getActiveSessions().length,
  }));
});

ws.attach(server, (conn, req) => {
  state.conns.add(conn);
  log('WS connected from', req.socket.remoteAddress);

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const token = msg.token || '__default__';

    if (msg.type === 'ext_ready' || msg.type === 'tabs_update') {
      registerTabs(conn, msg.tabs || [], token);
    } else if (msg.type === 'ack') {
      state.acks.add(msg.id);
      log('ACK  id=' + msg.id);
    } else if (msg.type === 'result') {
      state.results.set(msg.id, { success: true, data: msg.result, newTabs: msg.newTabs || [] });
      log('RESULT id=' + msg.id + ' :: ' + JSON.stringify(msg.result).slice(0, 400));
    } else if (msg.type === 'error') {
      state.results.set(msg.id, { success: false, data: msg.error, newTabs: msg.newTabs || [] });
      log('ERROR  id=' + msg.id + ' :: ' + JSON.stringify(msg.error).slice(0, 600));
    } else if (msg.type === 'ping') {
      // 扩展的 keepalive，忽略即可（连接本身保持活跃）
    } else {
      log('UNKNOWN msg type=' + msg.type + ' raw=' + raw.slice(0, 200));
    }
  });

  conn.on('close', () => { log('WS closed'); dropConn(conn); });
  conn.on('error', (e) => log('WS error', e.message));
});

server.listen(WS_PORT, '0.0.0.0', () => {
  log(`bridge-server up: ws://127.0.0.1:${WS_PORT} (extension)  ctrl: http://127.0.0.1:${CTRL_PORT}`);
});
server.on('error', (e) => {
  log('FATAL server error: ' + e.message);
  process.exit(1);
});

ctrl.listen(CTRL_PORT, '127.0.0.1', () => {
  log(`control API up: http://127.0.0.1:${CTRL_PORT}`);
});
ctrl.on('error', (e) => {
  log('FATAL ctrl error: ' + e.message);
  process.exit(1);
});

// 定期清理断开超 10 分钟的会话
setInterval(() => {
  const cutoff = Date.now() - 600000;
  for (const [sid, sess] of state.sessions) {
    if (sess.disconnectAt && sess.disconnectAt < cutoff) state.sessions.delete(sid);
  }
}, 60000).unref();

process.on('uncaughtException', (e) => log('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack || e)));
