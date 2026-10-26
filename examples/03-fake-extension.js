'use strict';
// 模拟浏览器扩展的 WebSocket 客户端，用于验证 bridge-server 的协议正确性。
// 它不做真实页面执行，只把收到的 code 回显成结果，借此验证整条链路。
const http = require('http');
const crypto = require('crypto');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.TEST_WS_PORT || '18765', 10);
const TAB_ID = 123;

function maskSend(ws, text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  header[0] = 0x81;
  ws.write(Buffer.concat([header, mask, masked]));
}

function connect(cb) {
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    host: HOST, port: PORT, path: '/', method: 'GET',
    headers: {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
    },
  });
  req.on('upgrade', (res, socket, head) => {
    const expect = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const got = res.headers['sec-websocket-accept'];
    console.log('[fake-ext] handshake accept ' + (got === expect ? 'OK' : 'MISMATCH got=' + got));
    cb(socket, head);
  });
  req.on('error', (e) => { console.log('[fake-ext] connect error: ' + e.message); process.exit(1); });
  req.end();
}

connect((socket, head) => {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  socket.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      try {
        const msg = JSON.parse(payload);
        console.log('[fake-ext] <- server:', JSON.stringify(msg).slice(0, 300));
        maskSend(socket, JSON.stringify({ type: 'ack', id: msg.id }));
        // 模拟页面执行结果
        let result;
        const code = msg.code;
        if (typeof code === 'string' && code.trim().startsWith('{')) {
          let cmd;
          try { cmd = JSON.parse(code); } catch (e) { cmd = null; }
          if (cmd && cmd.cmd === 'batch') {
            result = { ok: true, results: (cmd.commands || []).map(c => ({ ok: true, echo: c.method || c.cmd })) };
          } else if (cmd && cmd.cmd === 'cdp') {
            if (cmd.method === 'Page.captureScreenshot') result = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
            else result = { ok: true, method: cmd.method };
          } else if (cmd && cmd.cmd === 'tabs') {
            result = { ok: true };
          } else {
            result = { ok: false, error: 'unhandled cmd' };
          }
        } else if (typeof code === 'string' && /__wd_logs/.test(code)) {
          result = { url: 'https://example.com/', title: 'Example Domain', logs: [{ level: 'log', text: 'hello from page' }] };
        } else if (typeof code === 'string' && /window\.__wd_console_hooked/.test(code)) {
          result = 'hooked';
        } else if (typeof code === 'string' && /wd-i/.test(code)) {
          result = '<div wd-i="0"><h1 wd-i="1">Example Domain</h1><p wd-i="2">Hello from fake page</p></div>';
        } else if (typeof code === 'string' && /window\.location\.href/.test(code)) {
          result = 'navigated';
        } else {
          result = { echoed: String(code).slice(0, 200), ranAt: Date.now() };
        }
        maskSend(socket, JSON.stringify({ type: 'result', id: msg.id, result, newTabs: [] }));
        console.log('[fake-ext] -> result sent for', msg.id);
      } catch (e) {
        console.log('[fake-ext] bad frame: ' + e.message);
      }
    }
  });

  // 先探测 HTTP（扩展 isServerAlive 的行为）
  http.get(`http://${HOST}:${PORT}/`, (res) => {
    console.log('[fake-ext] HTTP probe status:', res.statusCode);
  }).on('error', (e) => console.log('[fake-ext] HTTP probe failed:', e.message));

  setTimeout(() => {
    maskSend(socket, JSON.stringify({
      type: 'ext_ready',
      token: '__default__',
      tabs: [{ id: TAB_ID, url: 'https://example.com/', title: 'Example Domain' }],
    }));
    console.log('[fake-ext] sent ext_ready with 1 tab');
  }, 300);

  setInterval(() => { try { maskSend(socket, JSON.stringify({ type: 'ping' })); } catch (e) {} }, 20000);
  socket.on('close', () => { console.log('[fake-ext] closed'); process.exit(0); });
  socket.on('error', (e) => console.log('[fake-ext] socket error: ' + e.message));
});

setTimeout(() => { console.log('[fake-ext] test window over, exiting'); process.exit(0); }, 60000);
