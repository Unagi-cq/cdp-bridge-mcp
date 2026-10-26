#!/usr/bin/env node
'use strict';
// verify-mcp —— cdp-bridge-ohos MCP Server 端到端自检
//
// 启动 MCP Server（stdio），走完 initialize -> tools/list -> tools/call 全流程，
// 并调用 browser_get_tabs / browser_status 验证与浏览器的真实连通性。
//
// 用法：node verify-mcp.js
// 退出码：0 = 全部通过，1 = 存在失败项

const { spawn } = require('child_process');
const path = require('path');

const MCP_DIR = process.env.CDP_BRIDGE_MCP_DIR || path.join(__dirname, '..', 'mcp');
const SERVER = path.join(MCP_DIR, 'mcp-stdio.js');
const NODE = process.execPath;

const child = spawn(NODE, [SERVER], {
  env: Object.assign({}, process.env, {
    CDP_BRIDGE_WS_PORT: process.env.CDP_BRIDGE_WS_PORT || '18765',
    CDP_BRIDGE_CTRL_PORT: process.env.CDP_BRIDGE_CTRL_PORT || '18766',
  }),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;
let failed = 0;

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    } catch (e) { /* 非 JSON 行忽略 */ }
  }
});
child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s && !/bridge-server not running/.test(s)) {
    process.stderr.write('[server] ' + s.split('\n')[0] + '\n');
  }
});

function call(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ error: 'timeout: ' + method }); }
    }, 40000);
  });
}

function check(label, ok, detail) {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ->  ' + detail : ''));
  if (!ok) failed++;
}

(async () => {
  console.log('cdp-bridge-ohos MCP 自检');
  console.log('  server: ' + SERVER);
  console.log('');

  // 1. initialize
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify-mcp', version: '1.0' },
  });
  const si = init.result && init.result.serverInfo;
  check('initialize 握手', !!si, si ? si.name + ' v' + si.version : JSON.stringify(init.error || init));
  if (!si) { child.kill(); process.exit(1); }

  // 2. tools/list
  const list = await call('tools/list', {});
  const tools = (list.result && list.result.tools) || [];
  check('tools/list 返回工具', tools.length > 0, tools.length + ' 个');

  const expected = [
    'browser_get_tabs', 'browser_scan', 'browser_execute_js', 'browser_switch_tab',
    'browser_focus_tab', 'browser_navigate', 'browser_screenshot', 'browser_batch',
    'browser_wait', 'browser_save_image', 'browser_status', 'browser_query',
    'browser_click', 'browser_type', 'browser_scroll', 'browser_wait_for', 'browser_dom',
  ];
  const names = tools.map(t => t.name);
  const missing = expected.filter(n => !names.includes(n));
  check('关键工具齐全', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : '全部 ' + expected.length + ' 个就位');

  // 3. browser_status —— 检查桥接服务
  const st = await call('tools/call', { name: 'browser_status', arguments: {} });
  const stText = st.result && st.result.content && st.result.content[0] && st.result.content[0].text;
  let stObj = null;
  try { stObj = JSON.parse(stText); } catch (e) {}
  const bridgeOk = stObj && stObj.bridge && stObj.bridge.ok;
  check('桥接服务在线', !!bridgeOk, bridgeOk ? 'ok=true' : String(stText).slice(0, 120));

  const conns = stObj && stObj.bridge && stObj.bridge.connections;
  check('扩展已连接', conns >= 1, 'connections=' + conns);
  if (conns < 1) {
    console.log('');
    console.log('  提示: 扩展未连接。在浏览器里切一下标签页即可唤醒 Service Worker 重连。');
  }

  // 4. browser_get_tabs —— 检查真实页面
  const tabsRes = await call('tools/call', { name: 'browser_get_tabs', arguments: {} });
  const tabsText = tabsRes.result && tabsRes.result.content && tabsRes.result.content[0] && tabsRes.result.content[0].text;
  let tabsObj = null;
  try { tabsObj = JSON.parse(tabsText); } catch (e) {}
  const tabCount = tabsObj && tabsObj.tabs ? tabsObj.tabs.length : 0;
  check('可操控标签页', tabCount > 0, tabCount + ' 个' + (tabCount ? ': ' + tabsObj.tabs.map(t => t.title || t.url).join(' | ').slice(0, 60) : ''));
  if (tabCount === 0) {
    console.log('');
    console.log('  提示: 没有可操控的标签页。扩展只上报 http/https 页面，请在浏览器打开一个网页。');
  }

  console.log('');
  console.log(failed === 0 ? '全部通过 ✓' : failed + ' 项失败 ✗');
  child.kill();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('自检异常: ' + e.message);
  child.kill();
  process.exit(1);
});
