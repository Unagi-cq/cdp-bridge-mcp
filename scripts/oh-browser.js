#!/usr/bin/env node
'use strict';
// oh-browser —— 鸿蒙 PC 浏览器操控 CLI
//
// 通过 cdp-bridge-ohos 控制面驱动浏览器扩展。适合脚本化与调试。
//
// 环境变量：
//   CDP_BRIDGE_CTRL_PORT  控制面端口（默认 18766）
//   CDP_BRIDGE_WS_PORT    扩展 WS 端口（默认 18765）
//   CDP_BRIDGE_DIR        bridge-server.js 所在目录（默认本脚本的 ../mcp）
//
// 用法：
//   node oh-browser.js tabs                       列出所有可操控标签页
//   node oh-browser.js meta [tabId]               读标签页元信息
//   node oh-browser.js read [tabId] [maxchars]    读页面正文
//   node oh-browser.js query [tabId] <selector>   查询元素（带坐标/属性）
//   node oh-browser.js click [tabId] <selector> [index]   点击元素
//   node oh-browser.js type  [tabId] <selector> <text>     在输入框填字
//   node oh-browser.js shot  [tabId] <out.png>    截图
//   node oh-browser.js open  [tabId] <url>        新标签页打开 URL
//   node oh-browser.js close [tabId] <targetId>   关闭标签页
//   node oh-browser.js scroll [tabId] <px>        滚动
//   node oh-browser.js reload [tabId]             刷新
//
// 不传 tabId 时自动使用第一个标签页。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CTRL = parseInt(process.env.CDP_BRIDGE_CTRL_PORT || '18766', 10);
const WS_PORT = parseInt(process.env.CDP_BRIDGE_WS_PORT || '18765', 10);
const BRIDGE_DIR = process.env.CDP_BRIDGE_DIR || path.join(__dirname, '..', 'mcp');

function ctrl(obj, timeoutSec) {
  return new Promise((resolve) => {
    const body = JSON.stringify(obj);
    const req = http.request({
      host: '127.0.0.1', port: CTRL, method: 'POST', path: '/link',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: (timeoutSec || 30) * 1000,
    }, (res) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve(JSON.parse(b).r); } catch (e) { resolve({ error: 'bad ctrl response: ' + b.slice(0, 200) }); }
      });
    });
    req.on('error', (e) => resolve({ error: 'control plane unreachable: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'control plane timeout' }); });
    req.end(body);
  });
}

function ensureBridge() {
  return new Promise((resolve) => {
    const probe = http.request({ host: '127.0.0.1', port: CTRL, method: 'POST', path: '/status', timeout: 1200 }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    probe.on('error', () => {
      // 桥接服务没起 -> 拉起来
      const child = spawn(process.execPath, [path.join(BRIDGE_DIR, 'bridge-server.js')], {
        detached: true, stdio: 'ignore', cwd: BRIDGE_DIR,
        env: Object.assign({}, process.env, {
          CDP_BRIDGE_WS_PORT: String(WS_PORT),
          CDP_BRIDGE_CTRL_PORT: String(CTRL),
        }),
      });
      child.unref();
      setTimeout(() => resolve(true), 2500);
    });
    probe.end();
  });
}

// 结构化 DOM 命令（走 content script，不依赖会挂起的 debugger API）
async function dom(tabId, action, args, timeoutSec) {
  const code = JSON.stringify({ __dom: true, action, args: args || {}, timeout: timeoutSec || 30 });
  const r = await ctrl({ cmd: 'execute_js', code, sessionId: tabId || '', timeout: timeoutSec || 30 }, timeoutSec || 30);
  if (!r) return { error: 'no response' };
  if (r.error) return { error: r.error };
  const payload = (r.data && r.data.result) || r.data;
  if (payload && payload.ok === false) return { error: JSON.stringify(payload.error || 'dom failed') };
  return { data: payload && payload.data !== undefined ? payload.data : payload, tabId: r.tabId };
}

async function sessions() {
  const r = await ctrl({ cmd: 'get_all_sessions' });
  return Array.isArray(r) ? r : [];
}

async function pickTab(explicit) {
  const list = await sessions();
  if (!list.length) return null;
  if (explicit) {
    const hit = list.find(t => String(t.id) === String(explicit));
    return hit ? hit.id : null;
  }
  return list[0].id;
}

function out(v) { console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    out('用法: node oh-browser.js <tabs|meta|read|query|click|type|shot|open|close|scroll|reload> ...');
    return;
  }

  await ensureBridge();

  if (cmd === 'tabs') {
    const st = await ctrl({ cmd: 'status' });
    const list = await sessions();
    out({ status: st, tabs: list });
    return;
  }

  // open/close 的参数顺序特殊，先特殊处理
  if (cmd === 'open') {
    const url = rest[0];
    const srcTab = await pickTab(rest[1]);
    if (!srcTab) { out({ error: '无可用标签页' }); return; }
    const r = await ctrl({ cmd: 'execute_js', code: JSON.stringify({ cmd: 'tabs', method: 'create', url }), sessionId: srcTab, timeout: 25 }, 30);
    out(r);
    return;
  }
  if (cmd === 'close') {
    const target = rest[0];
    const srcTab = await pickTab(rest[1]);
    if (!srcTab) { out({ error: '无可用标签页' }); return; }
    const r = await ctrl({ cmd: 'execute_js', code: JSON.stringify({ cmd: 'tabs', method: 'close', tabId: Number(target) }), sessionId: srcTab, timeout: 20 }, 25);
    out(r);
    return;
  }

  const tabId = await pickTab(rest[0]);
  if (!tabId) { out({ error: '无可用标签页（请在浏览器中打开一个 http/https 页面）' }); return; }

  switch (cmd) {
    case 'meta': {
      const r = await dom(tabId, 'get_meta', {}, 25);
      out(r.error || r.data);
      break;
    }
    case 'read': {
      const max = parseInt(rest[1] || '3000', 10);
      const r = await dom(tabId, 'read_page', { text_only: true, maxchars: max }, 25);
      out(r.error || (r.data && r.data.content) || r.data);
      break;
    }
    case 'query': {
      const sel = rest[1] || 'a, button, input';
      const r = await dom(tabId, 'query', { selector: sel, limit: 40, attrs: ['href', 'type', 'placeholder', 'name', 'id', 'class', 'value'] }, 25);
      if (r.error) { out(r.error); break; }
      const els = (r.data && r.data.elements) || [];
      out(els.map(e => ({ i: e.i, tag: e.tag, text: (e.text || '').slice(0, 40), rect: e.rect, attrs: e.attrs })));
      break;
    }
    case 'click': {
      const sel = rest[1];
      const idx = parseInt(rest[2] || '0', 10);
      const r = await dom(tabId, 'click', { selector: sel, index: idx }, 25);
      out(r.error || r.data);
      break;
    }
    case 'type': {
      const sel = rest[1];
      const text = rest.slice(2).join(' ');
      const r = await dom(tabId, 'type', { selector: sel, text }, 25);
      out(r.error || r.data);
      break;
    }
    case 'shot': {
      const file = rest[1] || 'shot.png';
      const r = await ctrl({ cmd: 'execute_js', code: JSON.stringify({ cmd: 'capture', tabId: Number(tabId) }), sessionId: tabId, timeout: 25 }, 30);
      if (r && r.error) { out(r.error); break; }
      const b64 = r && r.data && r.data.result && r.data.result.base64;
      if (!b64) { out(r); break; }
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      out({ saved: file, bytes: fs.statSync(file).size, tabId });
      break;
    }
    case 'scroll': {
      const px = parseInt(rest[1] || '500', 10);
      const r = await dom(tabId, 'scroll', { y: px }, 25);
      out(r.error || r.data);
      break;
    }
    case 'reload': {
      const r = await ctrl({ cmd: 'execute_js', code: JSON.stringify({ cmd: 'tabs', method: 'reload', tabId: Number(tabId) }), sessionId: tabId, timeout: 20 }, 25);
      out(r);
      break;
    }
    default:
      out('未知命令: ' + cmd);
  }
}

main().catch(e => { out({ error: e.message }); process.exit(1); });
