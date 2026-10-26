/**
 * 最小示例：如何用 MCP 协议驱动 cdp-bridge-ohos
 *
 * 依赖：Node.js 18+（零第三方依赖，直接用内置 http 模块手写 MCP 客户端）
 *
 * 运行：
 *   node examples/minimal-agent.js https://example.com
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const MCP_SERVER = path.join(__dirname, '..', 'mcp', 'mcp-stdio.js');
const CTRL_PORT = parseInt(process.env.CDP_BRIDGE_CTRL_PORT || '18766', 10);

// ---------- 极简 MCP stdio 客户端 ----------
class McpClient {
  constructor(serverPath) {
    this.child = spawn(process.execPath, [serverPath], {
      env: Object.assign({}, process.env, {
        CDP_BRIDGE_WS_PORT: process.env.CDP_BRIDGE_WS_PORT || '18765',
        CDP_BRIDGE_CTRL_PORT: String(CTRL_PORT),
      }),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.on('data', (d) => this._onData(d));
  }

  _onData(d) {
    this.buf += d.toString();
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      } catch (e) { /* 忽略非 JSON 行 */ }
    }
  }

  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('MCP 调用超时: ' + method));
      }, 40000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  tool(name, args) {
    return this.call('tools/call', { name, arguments: args || {} })
      .then((r) => {
        const text = r.content && r.content[0] && r.content[0].text;
        try { return JSON.parse(text); } catch (e) { return text; }
      });
  }

  close() { this.child.kill(); }
}

// ---------- 业务逻辑 ----------
async function main() {
  const url = process.argv[2] || 'https://example.com';

  const mcp = new McpClient(MCP_SERVER);
  try {
    // 1. 握手
    const init = await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'minimal-agent-example', version: '1.0' },
    });
    console.log('已连接 MCP Server:', init.serverInfo.name, 'v' + init.serverInfo.version);

    // 2. 看当前有哪些标签页
    const tabs = await mcp.tool('browser_get_tabs');
    console.log('\n[1] 当前标签页:');
    for (const t of tabs.tabs || []) {
      console.log('    #' + t.id, '-', t.title || '(无标题)', '|', t.url);
    }

    // 3. 导航到目标页面
    console.log('\n[2] 导航到', url);
    await mcp.tool('browser_navigate', { url });

    // 4. 等新页面就绪。
    //    注意：不能只等 document.readyState === 'complete' —— 导航是异步的，
    //    旧页面在跳转前就已经是 complete，条件会立刻满足而读到旧内容。
    //    正确做法是等 URL 变成目标地址。
    await mcp.tool('browser_wait', {
      condition_js: 'location.href.indexOf(' + JSON.stringify(new URL(url).host) + ') !== -1',
      timeout: 20,
    });
    await mcp.tool('browser_wait', {
      condition_js: 'document.readyState === "complete"',
      timeout: 20,
    });

    // 5. 读取页面
    const meta = await mcp.tool('browser_scan', { text_only: true, maxchars: 500 });
    console.log('\n[3] 页面标题:', meta.content && meta.content.title);
    console.log('\n[4] 页面正文（前 500 字）:');
    console.log('    ' + String(meta.content && meta.content.content || '').split('\n').slice(0, 12).join('\n    '));

    // 6. 查询可交互元素
    const els = await mcp.tool('browser_query', { selector: 'a, button, input', limit: 10 });
    console.log('\n[5] 可交互元素（前 10 个）:');
    for (const e of els.elements || []) {
      const t = (e.text || '').slice(0, 30);
      console.log('    #' + e.i, e.tag, t ? `"${t}"` : '', e.rect ? `(${e.rect.x},${e.rect.y})` : '');
    }
  } finally {
    mcp.close();
  }
}

main().catch(e => {
  console.error('执行失败:', e.message);
  process.exit(1);
});
