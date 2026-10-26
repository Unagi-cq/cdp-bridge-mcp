'use strict';
// 02-e2e-basic.js —— 端到端基础操作演示：读页 / 查询 / 滚动 / 输入 / 点击 / 等待
// 运行：node examples/02-e2e-basic.js
// 说明：所有动作都在浏览器【当前默认 tab】上执行。脚本不依赖任何特定站点——
// 输入/点击用的选择器是通用占位（第一个 input），请按你的目标站点改成真实选择器，
// 例如：selector = '#search' 或 'input[name="q"]'。
// 设计为只读 + 非破坏：不提交表单、不联跳（type 时 enter:false）。
const { spawn } = require('child_process');
const path = require('path');

const STDIO_JS = path.join(__dirname, '..', 'src', 'mcp-stdio.js');
const child = spawn(process.execPath, [STDIO_JS], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '', id = 0;
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  }
});
function call(method, params) { return new Promise((res) => { const mid = String(++id); pending.set(mid, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params: params || {} }) + '\n'); }); }
function out(res) { if (!res || !res.result) return { error: 'no result' }; const t = (res.result.content && res.result.content[0] && res.result.content[0].text) || ''; try { return JSON.parse(t); } catch (e) { return { raw: t.slice(0, 400) }; } }
function show(label, v) { console.log('\n== ' + label + ' =='); console.log(JSON.stringify(v, null, 1).slice(0, 1400)); }

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e-basic', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  await new Promise((r) => setTimeout(r, 300));

  // 1. 读取当前页面元信息
  show('get_meta', out(await call('tools/call', { name: 'browser_dom', arguments: { action: 'get_meta' } })));

  // 2. 读取页面正文（文本模式，截断 800 字符）
  show('read_page(text_only)', out(await call('tools/call', { name: 'browser_scan', arguments: { text_only: true, maxchars: 800 } })));

  // 3. 查询页面上元素（看有哪些 input/button）
  show('query inputs', out(await call('tools/call', { name: 'browser_query', arguments: { selector: 'input', limit: 10 } })));

  // 4. 滚动到顶部，再向下 300px（页面可滚动时才有效果）
  show('scroll top', out(await call('tools/call', { name: 'browser_scroll', arguments: { top: 0 } })));
  show('scroll y+300', out(await call('tools/call', { name: 'browser_scroll', arguments: { y: 300 } })));
  show('scroll top again', out(await call('tools/call', { name: 'browser_scroll', arguments: { top: 0 } })));

  // 5. 往第一个 input 输入文本（不回车，不触发提交）——按需改成你的选择器
  show('type', out(await call('tools/call', { name: 'browser_type', arguments: { selector: 'input', index: 0, text: 'hello from mcp', clear: true, enter: false } })));

  // 6. 读回输入框 value 验证输入成功（content script 返回实时 value）
  show('verify value', out(await call('tools/call', { name: 'browser_query', arguments: { selector: 'input', limit: 1 } })));

  // 7. 等待一个元素出现（通用：body 必然存在）
  show('wait_for body', out(await call('tools/call', { name: 'browser_wait_for', arguments: { selector: 'body', timeout: 3 } })));

  child.kill();
  process.exit(0);
})().catch((e) => { console.error('fatal', e); child.kill(); process.exit(1); });
