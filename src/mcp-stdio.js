'use strict';
// MCP server (stdio transport) —— 鸿蒙 OHOS 版 cdp-bridge
// 由 WorkBuddy 以 `node mcp-stdio.js` 启动；通过 127.0.0.1:18766 控制面与常驻 bridge-server 通信。
// 零第三方依赖，纯 Node 内置模块（OHOS 无法加载未签名的原生 .so，这是本文件的存在理由）。

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CTRL_PORT = parseInt(process.env.CDP_BRIDGE_CTRL_PORT || '18766', 10);
const WS_PORT = parseInt(process.env.CDP_BRIDGE_WS_PORT || '18765', 10);
const LOG_FILE = process.env.CDP_BRIDGE_LOG || path.join(__dirname, 'mcp.log');
const NODE = process.execPath;

// 日志只能写 stderr / 文件，stdout 是 MCP 协议通道
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
  try { process.stderr.write(line + '\n'); } catch (e) {}
}

// ---------------- 控制面调用 ----------------
function ctrlCall(payload, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: CTRL_PORT, method: 'POST', path: '/link',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: (timeoutMs || 30000) + 10000,
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

let bridgeBooting = null;
function ensureBridge() {
  if (bridgeBooting) return bridgeBooting;
  bridgeBooting = new Promise((resolve) => {
    const probe = http.request({ host: '127.0.0.1', port: CTRL_PORT, method: 'POST', path: '/status', timeout: 1200 }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    probe.on('error', () => {
      log('bridge-server not running, spawning...');
      try {
        const child = spawn(NODE, [path.join(__dirname, 'bridge-server.js')], {
          detached: true, stdio: 'ignore', cwd: __dirname,
          env: Object.assign({}, process.env, {
            CDP_BRIDGE_WS_PORT: String(WS_PORT),
            CDP_BRIDGE_CTRL_PORT: String(CTRL_PORT),
          }),
        });
        child.unref();
      } catch (e) { log('spawn bridge failed: ' + e.message); }
      setTimeout(() => resolve(true), 1200);
    });
    probe.on('timeout', () => { probe.destroy(); resolve(true); });
    probe.end();
  });
  return bridgeBooting;
}

// ---------------- 浏览器操作封装 ----------------
async function execJs(code, opts) {
  opts = opts || {};
  await ensureBridge();
  const r = await ctrlCall({
    cmd: 'execute_js', code, token: opts.token || '__default__',
    sessionId: opts.tabId || '', timeout: opts.timeout || 30,
  }, (opts.timeout || 30) * 1000);
  if (!r) return { error: 'no response from control plane' };
  if (r.error) return { error: r.error };
  return { data: r.data, newTabs: r.newTabs || [], tabId: r.tabId };
}

async function getTabs(opts) {
  await ensureBridge();
  const r = await ctrlCall({ cmd: 'get_all_sessions', token: (opts && opts.token) || '__default__' });
  return Array.isArray(r) ? r : [];
}

function ok(obj) { return JSON.stringify(obj, null, 0); }
function errObj(msg) { return JSON.stringify({ status: 'error', msg: String(msg) }); }

// 结构化 DOM 命令封装（无 eval，走 content script）
async function domAction(action, args, opts) {
  opts = opts || {};
  await ensureBridge();
  const code = JSON.stringify({ __dom: true, action, args: args || {}, timeout: opts.timeout || 30 });
  const r = await ctrlCall({
    cmd: 'execute_js', code, token: opts.token || '__default__',
    sessionId: opts.tabId || '', timeout: opts.timeout || 30,
  }, (opts.timeout || 30) * 1000);
  if (!r) return { error: 'no response from control plane' };
  if (r.error) return { error: r.error };
  const payload = (r.data && r.data.result) || r.data;
  if (payload && payload.ok === false) return { error: JSON.stringify(payload.error || 'dom command failed') };
  return { data: payload && payload.data !== undefined ? payload.data : payload, tabId: r.tabId };
}

// 页面内：注入 console 捕获钩子
const CONSOLE_HOOK = `(function(){ if(window.__wd_console_hooked) return 'already'; window.__wd_console_hooked=1; window.__wd_logs=[];
['log','warn','error','info','debug'].forEach(function(k){ var o=(console[k]||function(){}).bind(console);
console[k]=function(){ try{ window.__wd_logs.push({level:k,text:Array.prototype.map.call(arguments,function(a){ try{ return (a&&typeof a==='object')?JSON.stringify(a):String(a);}catch(e){return String(a);} }).join(' ')}); if(window.__wd_logs.length>300) window.__wd_logs.shift(); }catch(e){} return o.apply(null,arguments); }; });
return 'hooked'; })()`;

const META = `(function(){ return { url: location.href, title: document.title, logs: (window.__wd_logs||[]).slice(-30) }; })()`;

// 页面内：产出给 LLM 看的简化 HTML
function simplifyScript(maxchars, textOnly) {
  return `(function(){
  var MAX=${parseInt(maxchars, 10) || 35000};
  var body=document.body; if(!body) return '[no body]';
  if(${textOnly ? 'true' : 'false'}){
    var t=(body.innerText||'').replace(/\\n{3,}/g,'\\n\\n').replace(/[ \\t]{2,}/g,' ');
    return t.slice(0,MAX);
  }
  var orig=Array.prototype.slice.call(body.querySelectorAll('*'));
  var flags=orig.map(function(el){ try{ var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0') return 0; }catch(e){} return 1; });
  var clone=body.cloneNode(true);
  var cl=Array.prototype.slice.call(clone.querySelectorAll('*'));
  for(var i=cl.length-1;i>=0;i--){ if(!flags[i]){ try{ cl[i].remove(); }catch(e){} } }
  var rmSel='script,style,noscript,template,svg,canvas,iframe,link,meta,object,embed,br,hr';
  Array.prototype.slice.call(clone.querySelectorAll(rmSel)).forEach(function(e){ try{ e.remove(); }catch(_){} });
  var keep=['href','src','id','class','type','name','value','placeholder','aria-label','title','alt','role','checked','selected','disabled','readonly','for','action','method'];
  var all=Array.prototype.slice.call(clone.querySelectorAll('*'));
  for(var j=0;j<all.length;j++){
    var el=all[j];
    var attrs=Array.prototype.slice.call(el.attributes);
    for(var k=0;k<attrs.length;k++){
      var n=attrs[k].name;
      if(keep.indexOf(n)<0 && n.indexOf('data-')!==0 && n.indexOf('wd-')!==0){ el.removeAttribute(n); }
    }
    el.setAttribute('wd-i', j);
  }
  var html=clone.innerHTML.replace(/\\s+/g,' ').replace(/>\\s+</g,'><').trim();
  if(html.length>MAX) html=html.slice(0,MAX)+'\\n<!-- truncated at '+MAX+' chars -->';
  return html;
})()`;
}

// ---------------- MCP 工具定义 ----------------
const TOOLS = [
  {
    name: 'browser_get_tabs',
    description: 'Get all open browser tabs with their IDs, URLs and titles.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_scan',
    description: 'Get simplified HTML of the active tab plus the tab list. HTML is optimized for LLM consumption (scripts/styles/invisible elements stripped, each element tagged with wd-i index for later targeting).',
    inputSchema: {
      type: 'object',
      properties: {
        tabs_only: { type: 'boolean', description: 'Only return the tab list, no page content.' },
        switch_tab_id: { type: 'string', description: 'Switch to this tab before scanning.' },
        text_only: { type: 'boolean', description: 'Return plain text instead of simplified HTML.' },
        maxchars: { type: 'number', description: 'Max characters of content (default 35000).' },
      },
      required: [],
    },
  },
  {
    name: 'browser_execute_js',
    description: 'Execute JavaScript in the current browser tab and return the result. Runs in the page MAIN world, so it has full access to page globals and your logged-in session.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute, or a JSON string of a command object (e.g. {"cmd":"cdp","method":"Page.captureScreenshot"}).' },
        switch_tab_id: { type: 'string', description: 'Switch to this tab before executing.' },
        no_monitor: { type: 'boolean', description: 'Skip console capture and page meta (faster).' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 15).' },
      },
      required: ['script'],
    },
  },
  {
    name: 'browser_switch_tab',
    description: 'Set the active MCP tab (does not change the visible browser tab).',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'string', description: 'Tab ID from browser_get_tabs.' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_focus_tab',
    description: 'Bring a tab to the foreground: activate the tab AND focus its browser window.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the active tab to a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the active tab, returns base64 PNG.',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'string', description: 'Optional tab ID. Uses active tab if empty.' } }, required: [] },
  },
  {
    name: 'browser_batch',
    description: 'Run multiple CDP/extension commands in one request, e.g. {"cmd":"cdp","method":"Input.insertText","params":{"text":"hi"}}.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: { type: 'array', description: 'Array of command objects supported by the extension.', items: { type: 'object' } },
        tab_id: { type: 'string' },
        timeout: { type: 'number', description: 'Seconds (default 20).' },
      },
      required: ['commands'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait until a JavaScript condition returns a truthy value.',
    inputSchema: {
      type: 'object',
      properties: {
        condition_js: { type: 'string', description: 'JS expression tested for truthiness.' },
        timeout: { type: 'number', description: 'Max seconds (default 10).' },
        interval: { type: 'number', description: 'Seconds between checks (default 0.5).' },
        switch_tab_id: { type: 'string' },
      },
      required: ['condition_js'],
    },
  },
  {
    name: 'browser_save_image',
    description: 'Save base64 screenshot data (from browser_screenshot) to a PNG file.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot_json_str_or_file: { type: 'string', description: 'JSON string from browser_screenshot, or a path to a JSON file containing it.' },
        output_path: { type: 'string', description: 'Output PNG path. Directory -> auto filename. Empty -> auto-generate in cwd.' },
      },
      required: ['screenshot_json_str_or_file'],
    },
  },
  {
    name: 'browser_status',
    description: 'Check whether the CDP Bridge extension is connected and how many tabs are attached.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'browser_query',
    description: 'Query DOM elements in the active tab by CSS selector. Returns tag, snippet text, value, href and bounding rect for each match (indexed by i, use with browser_click/browser_type).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector, e.g. "input[name=q]" or "button" or "a" or "#login"' },
        limit: { type: 'number', description: 'Max elements to return (default 50).' },
        tab_id: { type: 'string', description: 'Optional tab ID.' },
        timeout: { type: 'number', description: 'Seconds (default 20).' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element in the active tab by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
        index: { type: 'number', description: 'Which match to click if multiple (default 0).' },
        tab_id: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input/textarea in the active tab. Uses native value setter + input/change events (works with React/Vue). Optionally press Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input.' },
        text: { type: 'string', description: 'Text to type.' },
        index: { type: 'number', description: 'Which match (default 0).' },
        clear: { type: 'boolean', description: 'Clear existing value first (default true).' },
        enter: { type: 'boolean', description: 'Press Enter after typing (default false).' },
        tab_id: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the active tab by x/y pixels (or to absolute top).',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number', description: 'Horizontal px (default 0).' }, y: { type: 'number', description: 'Vertical px (default 0).' }, top: { type: 'number', description: 'Absolute scrollTop (alternative to y).' }, tab_id: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until an element matching the CSS selector appears in the active tab (polls up to timeout).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, timeout: { type: 'number', description: 'Seconds (default 8).' }, tab_id: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_dom',
    description: 'Run a structured DOM command directly: read_page / query / click / type / scroll / scroll_to / navigate / wait_for / get_meta. The bridge executes it with native DOM APIs (no eval), so it works on strict-CSP pages where browser_execute_js cannot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of: read_page, query, click, type, scroll, scroll_to, navigate, wait_for, get_meta.' },
        args: { type: 'object', description: 'Arguments for the action, e.g. {selector:"#x"} or {url:"https://..."} or {text:"hi", clear:true, enter:true}.' },
        tab_id: { type: 'string' },
        timeout: { type: 'number' },
      },
      required: ['action'],
    },
  },
];

// ---------------- 工具实现 ----------------
const handlers = {
  async browser_status() {
    await ensureBridge();
    const r = await ctrlCall({ cmd: 'status' });
    const tabs = await getTabs();
    return ok({ status: 'success', bridge: r, tabs });
  },

  async browser_get_tabs() {
    const tabs = await getTabs();
    if (!tabs.length) return errObj('No browser tabs connected. Make sure the CDP Bridge extension is installed and the bridge server is running.');
    return ok({ tabs, count: tabs.length });
  },

  async browser_scan(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const tabs = await getTabs();
    if (!tabs.length) return errObj('No browser tabs connected.');
    const out = { status: 'success', tabs_count: tabs.length, tabs: tabs.map(t => ({ id: t.id, url: (t.url || '').slice(0, 120), title: t.title })) };
    if (!args.tabs_only) {
      const r = await execJs(JSON.stringify({ __dom: true, action: 'read_page', args: { maxchars: args.maxchars || 35000, text_only: !!args.text_only } }), { timeout: args.timeout || 35 });
      if (r.error) return errObj(r.error);
      out.content = (r.data && r.data.result) || r.data;
    }
    return ok(out);
  },

  async browser_execute_js(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const timeout = args.timeout || 30;

    if (!args.no_monitor) {
      await execJs(CONSOLE_HOOK, { timeout: timeout }).catch(() => {});
    }

    const r = await execJs(args.script, { timeout });
    if (r.error) return errObj(r.error);

    const res = { status: 'success', result: r.data, tab_id: r.tabId };
    if (r.newTabs && r.newTabs.length) res.new_tabs = r.newTabs;

    if (!args.no_monitor) {
      const meta = await execJs(META, { timeout: 20 }).catch(() => null);
      if (meta && meta.data && typeof meta.data === 'object') {
        res.url = meta.data.url;
        res.title = meta.data.title;
        if (meta.data.logs && meta.data.logs.length) res.console_logs = meta.data.logs;
      }
    }
    return ok(res);
  },

  async browser_switch_tab(args) {
    const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.tab_id) });
    if (r && r.error) return errObj(r.error);
    const tabs = await getTabs();
    const t = tabs.find(x => String(x.id) === String(args.tab_id));
    return ok({ status: 'success', active_tab: String(args.tab_id), url: t ? t.url : '' });
  },

  async browser_focus_tab(args) {
    const r = await execJs(JSON.stringify({ cmd: 'tabs', method: 'switch', tabId: parseInt(args.tab_id, 10) }), { timeout: 10, tabId: args.tab_id });
    if (r.error) return errObj(r.error);
    await ctrlCall({ cmd: 'set_default', sessionId: String(args.tab_id) });
    return ok({ status: 'success', focused_tab: String(args.tab_id), extension_response: r.data });
  },

  async browser_navigate(args) {
    const r = await execJs(JSON.stringify({ __dom: true, action: 'navigate', args: { url: args.url } }), { timeout: 10 });
    if (r.error) return errObj(r.error);
    return ok({ status: 'success', msg: 'Navigating to ' + args.url, result: (r.data && r.data.result) || r.data });
  },

  async browser_screenshot(args) {
    const cmd = { cmd: 'capture' };
    if (args.tab_id) cmd.tabId = parseInt(args.tab_id, 10);
    const r = await execJs(JSON.stringify(cmd), { timeout: 30, tabId: args.tab_id });
    if (r.error) return errObj(r.error);
    const d = (r.data && r.data.result) || r.data;
    const b64 = (d && typeof d === 'object' && d.base64) ? d.base64 : null;
    if (b64) return ok({ status: 'success', format: d.format || 'png', base64: b64 });
    return ok({ status: 'success', data: d });
  },

  async browser_batch(args) {
    const cmd = { cmd: 'batch', commands: args.commands };
    if (args.tab_id) cmd.tabId = parseInt(args.tab_id, 10);
    const r = await execJs(JSON.stringify(cmd), { timeout: args.timeout || 30, tabId: args.tab_id });
    if (r.error) return errObj(r.error);
    return ok({ status: 'success', results: r.data });
  },

  async browser_wait(args) {
    const timeout = args.timeout || 10;
    const interval = Math.max(args.interval || 0.5, 0.2);
    const deadline = Date.now() + timeout * 1000;
    let attempts = 0, lastValue = null, lastError = null;
    while (true) {
      attempts++;
      const r = await execJs(args.condition_js, { timeout: Math.min(Math.max(interval, 1), 12) });
      if (r.error) lastError = r.error;
      else {
        lastValue = r.data;
        lastError = null;
        if (lastValue) return ok({ status: 'success', value: lastValue, attempts });
      }
      if (Date.now() >= deadline) {
        return ok({ status: 'timeout', value: lastValue, error: lastError, attempts });
      }
      await new Promise(r2 => setTimeout(r2, interval * 1000));
    }
  },

  async browser_save_image(args) {
    try {
      let content = args.screenshot_json_str_or_file;
      let inputPath = null;
      if (!content.trim().startsWith('{') && !content.trim().startsWith('[')) {
        const cand = path.resolve(content.replace(/^~/, process.env.HOME || ''));
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { inputPath = cand; content = fs.readFileSync(cand, 'utf8'); }
      }
      let data = JSON.parse(content);
      if (typeof data.result === 'string' && data.result.trim().startsWith('{')) data = JSON.parse(data.result);
      const b64 = data.base64 || '';
      if (!b64) return errObj('No base64 data found in screenshot JSON');
      const img = Buffer.from(b64, 'base64');
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      let savePath;
      if (args.output_path) {
        const p = path.resolve(args.output_path.replace(/^~/, process.env.HOME || ''));
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) savePath = path.join(p, `screenshot_${ts}.png`);
        else if (!fs.existsSync(path.dirname(p))) return errObj('Parent directory does not exist: ' + path.dirname(p));
        else savePath = p;
      } else if (inputPath) {
        savePath = path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + '.png');
      } else {
        savePath = path.join(process.cwd(), `screenshot_${ts}.png`);
      }
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, img);
      return ok({ status: 'success', saved_path: savePath, size_bytes: img.length });
    } catch (e) {
      return errObj(e.message);
    }
  },

  // ---- 结构化 DOM 命令工具（无 eval，走 content script，严格 CSP 页面可用）----
  async browser_query(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const r = await domAction('query', {
      selector: args.selector,
      limit: args.limit || 20,
      attrs: args.attrs,
    }, { tabId: args.tab_id, timeout: args.timeout || 20 });
    if (r.error) return errObj(r.error);
    const d = r.data || {};
    return ok({ status: 'success', tab_id: r.tabId, count: d.count || 0, elements: d.elements || [] });
  },

  async browser_click(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const r = await domAction('click', {
      selector: args.selector,
      index: args.index == null ? 0 : args.index,
    }, { tabId: args.tab_id, timeout: args.timeout || 20 });
    if (r.error) return errObj(r.error);
    return ok({ status: 'success', tab_id: r.tabId, result: r.data });
  },

  async browser_type(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const r = await domAction('type', {
      selector: args.selector,
      text: args.text,
      index: args.index == null ? 0 : args.index,
      clear: args.clear !== false,
      enter: !!args.enter,
    }, { tabId: args.tab_id, timeout: args.timeout || 20 });
    if (r.error) return errObj(r.error);
    return ok({ status: 'success', tab_id: r.tabId, result: r.data });
  },

  async browser_scroll(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const toTop = args.top !== undefined;
    const a = toTop ? { top: args.top } : { x: args.x || 0, y: args.y || 0 };
    const r = await domAction(toTop ? 'scroll_to' : 'scroll', a, { tabId: args.tab_id, timeout: args.timeout || 20 });
    if (r.error) return errObj(r.error);
    return ok({ status: 'success', tab_id: r.tabId, result: r.data });
  },

  async browser_wait_for(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const timeout = args.timeout || 8;
    const r = await domAction('wait_for', { selector: args.selector, timeout }, { tabId: args.tab_id, timeout: timeout + 5 });
    if (r.error) return errObj(r.error);
    const found = !!(r.data && r.data.found);
    return ok({ status: 'success', tab_id: r.tabId, found, result: r.data });
  },

  async browser_dom(args) {
    if (args.switch_tab_id) {
      const r = await ctrlCall({ cmd: 'set_default', sessionId: String(args.switch_tab_id) });
      if (r && r.error) return errObj(r.error);
    }
    const r = await domAction(args.action, args.args || {}, { tabId: args.tab_id, timeout: args.timeout || 30 });
    if (r.error) return errObj(r.error);
    return ok({ status: 'success', result: r.data, tab_id: r.tabId });
  },
};

// ---------------- MCP stdio 协议 ----------------
function send(obj) {
  if (outMode === 'lsp') {
    const s = JSON.stringify(obj);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(s, 'utf8')}\r\n\r\n${s}`);
  } else {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}

let outMode = 'ndjson';
let buf = Buffer.alloc(0);
let inMode = null;

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  if (method === 'initialize') {
    const requested = (params && params.protocolVersion) || '2024-11-05';
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: supported.includes(requested) ? requested : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cdp-bridge-ohos', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || (method || '').startsWith('notifications/')) return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'resources/list') { send({ jsonrpc: '2.0', id, result: { resources: [] } }); return; }
  if (method === 'prompts/list') { send({ jsonrpc: '2.0', id, result: { prompts: [] } }); return; }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const fn = handlers[name];
    if (!fn) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errObj('Unknown tool: ' + name) }], isError: true } });
      return;
    }
    Promise.resolve()
      .then(() => fn(args))
      .then(text => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } }))
      .catch(e => {
        log('tool error', name, e && e.stack || e);
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: errObj((e && e.message) || e) }], isError: true } });
      });
    return;
  }

  // 未实现的方法
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

function drain() {
  for (;;) {
    if (inMode === null) {
      const s = buf.toString('utf8');
      if (/^\s*Content-Length:/i.test(s)) { inMode = 'lsp'; outMode = 'lsp'; }
      else if (s.indexOf('\n') >= 0) inMode = 'ndjson';
      else return;
    }
    if (inMode === 'ndjson') {
      const idx = buf.indexOf(0x0a);
      if (idx < 0) return;
      const line = buf.slice(0, idx).toString('utf8').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line)); } catch (e) { log('parse error: ' + e.message + ' | line: ' + line.slice(0, 200)); }
    } else {
      const s = buf.toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(s);
      if (!m) return;
      let he = s.indexOf('\r\n\r\n');
      if (he < 0) return;
      he += 4;
      const need = parseInt(m[1], 10);
      if (buf.length < he + need) return;
      const body = buf.slice(he, he + need).toString('utf8');
      buf = buf.slice(he + need);
      try { handleMessage(JSON.parse(body)); } catch (e) { log('parse error(lsp): ' + e.message); }
    }
  }
}

process.stdin.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); drain(); });
process.stdin.on('end', () => { log('stdin closed, exiting'); process.exit(0); });
process.stdin.on('error', (e) => log('stdin error: ' + e.message));

log('cdp-bridge-ohos MCP stdio started (node ' + process.version + ')');
