'use strict';
// 01-mcp-smoke.js —— MCP 冒烟测试：走完整协议栈验证 17 个工具可用
// 运行：node examples/01-mcp-smoke.js        （或在已安装浏览器扩展的环境直接跑）
// 说明：spawn 本项目 src/mcp-stdio.js（stdio 传输），依次调用
//   initialize -> tools/list -> browser_status -> browser_get_tabs
//   -> browser_dom(get_meta) -> browser_query
// 只做只读操作，不会跳转 / 刷新任何页面。
const { spawn } = require('child_process');
const path = require('path');

const STDIO_JS = path.join(__dirname, '..', 'src', 'mcp-stdio.js');
const child = spawn(process.execPath, [STDIO_JS], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
let id = 0;
const pending = new Map();

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { console.log('non-JSON out:', line.slice(0, 300)); continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function call(method, params) {
  return new Promise((resolve) => {
    const mid = String(++id);
    pending.set(mid, { resolve });
    const payload = { jsonrpc: '2.0', id: mid, method, params: params || {} };
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function out(res) {
  if (!res || !res.result) return { error: 'no result', raw: res };
  const c = (res.result.content && res.result.content[0] && res.result.content[0].text) || '';
  try { return JSON.parse(c); } catch (e) { return { raw_text: c.slice(0, 500) }; }
}

function show(label, obj) {
  console.log('\n=== ' + label + ' ===');
  console.log(JSON.stringify(obj, null, 1).slice(0, 1200));
}

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  show('initialize', (await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-smoke', version: '1' } })).result);

  // 通知类消息：发完即走（服务端对 notifications/* 不回响应）
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

  const tools = await call('tools/list', {});
  const names = (((tools.result && tools.result.tools) || []).map((t) => t.name));
  console.log('\n工具数:', names.length);
  console.log('工具列表:', names.join(', '));

  show('browser_status', out(await call('tools/call', { name: 'browser_status', arguments: {} })));
  show('browser_get_tabs', out(await call('tools/call', { name: 'browser_get_tabs', arguments: {} })));

  // 当前默认 tab 的页面元信息（url / title / readyState）
  show('browser_dom get_meta', out(await call('tools/call', { name: 'browser_dom', arguments: { action: 'get_meta' } })));

  // 列出当前页面上前 15 个 input/button/a/select 元素
  show('browser_query', out(await call('tools/call', { name: 'browser_query', arguments: { selector: 'input,button,a,select', limit: 15 } })));

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('fatal', e); child.kill(); process.exit(1); });
