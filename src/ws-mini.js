'use strict';
// 零依赖 WebSocket (RFC6455) 最小实现 —— 仅服务端，纯 JS，无原生模块。
// 目的：绕开 OpenHarmony 对未签名 ELF/.so 的加载限制（Python 版 cdp-bridge 死在这里）。
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.closed = false;
    this.fragBufs = [];
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

    socket.on('data', (d) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, d]) : d;
      this._parse();
    });
    socket.on('close', () => { if (!this.closed) { this.closed = true; this.emit('close'); } });
    socket.on('error', (e) => {
      this.emit('error', e);
      if (!this.closed) { this.closed = true; this.emit('close'); }
    });
    socket.on('timeout', () => this.close());

    if (this.buffer.length) this._parse();
  }

  get readyState() { return this.closed ? 3 : 1; }

  _writeFrame(opcode, payload) {
    if (this.closed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode; // FIN
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (e) {
      return false;
    }
  }

  send(text) {
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    return this._writeFrame(0x1, buf);
  }

  pong(payload) { this._writeFrame(0xA, payload || Buffer.alloc(0)); }

  close() {
    if (this.closed) return;
    try { this._writeFrame(0x8, Buffer.alloc(0)); } catch (e) {}
    try { this.socket.end(); } catch (e) {}
    this.closed = true;
    this.emit('close');
  }

  _parse() {
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const hi = buf.readUInt32BE(off);
        const lo = buf.readUInt32BE(off + 4);
        if (hi !== 0) { this.close(); return; }
        len = lo;
        off += 8;
      }

      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.slice(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;

      let payload = buf.slice(off, off + len);
      if (mask) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buffer = buf.slice(off + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.pong(payload); continue; }
      if (opcode === 0xA) { continue; }
      if (opcode === 0x0) {
        this.fragBufs.push(payload);
        if (fin) {
          const total = Buffer.concat(this.fragBufs);
          this.fragBufs = [];
          this.emit('message', total.toString('utf8'));
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.emit('message', payload.toString('utf8'));
        } else {
          this.fragBufs = [payload];
        }
      }
    }
  }
}

// 在 http.Server 上启用 WebSocket。返回 (req, socket, head) => WSConnection|null
function attach(server, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      try { socket.destroy(); } catch (e) {}
      return;
    }
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
      );
    } catch (e) {
      try { socket.destroy(); } catch (e2) {}
      return;
    }
    socket.setNoDelay(true);
    const conn = new WSConnection(socket, head);
    if (typeof onConnection === 'function') onConnection(conn, req);
  });
}

module.exports = { attach, WSConnection, acceptKey };
