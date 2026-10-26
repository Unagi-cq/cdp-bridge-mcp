// background.js - CDP Bridge（OpenHarmony / 国产 Chromium 内核适配版）
//
// 相对原版的改动：
//  1. 所有会「无限挂起」的 API 调用都加了超时竞速（withTimeout）。
//     在部分国产内核浏览器上 chrome.scripting.executeScript 与 chrome.debugger.* 会
//     既不 resolve 也不 reject，原版会永远卡死。
//  2. 执行 JS 改为三级降级：
//       scripting（官方路径） -> 内容脚本通道（chrome.tabs.sendMessage）
//       -> CDP（chrome.debugger）
//     后两条是兜底，前一条失败才启用，原版功能不受影响。
//  3. 新增 diag 命令，用于诊断各 API 在当前浏览器上的可用性。
//  4. CDP 调用（cmd=cdp / cmd=batch 中的 cdp）同样加超时保护。
try { importScripts('config.js'); } catch (_) {}

const DEFAULT_BRIDGE_CONFIG = {
  bridgeHost: typeof DEFAULT_BRIDGE_HOST !== 'undefined' ? DEFAULT_BRIDGE_HOST : '127.0.0.1',
  bridgePort: typeof DEFAULT_BRIDGE_PORT !== 'undefined' ? DEFAULT_BRIDGE_PORT : 18765,
  bridgeToken: '__default__',
};
let bridgeConfig = { ...DEFAULT_BRIDGE_CONFIG };
let bridgeWsUrl = buildWsUrl(bridgeConfig);
let connecting = false;

async function loadBridgeConfig() {
  bridgeConfig = await chrome.storage.local.get(DEFAULT_BRIDGE_CONFIG);
  bridgeConfig.bridgeHost = normalizeBridgeHost(bridgeConfig.bridgeHost || DEFAULT_BRIDGE_CONFIG.bridgeHost);
  bridgeConfig.bridgePort = normalizeBridgePort(bridgeConfig.bridgeHost, bridgeConfig.bridgePort);
  if (!bridgeConfig.bridgeToken) {
    bridgeConfig.bridgeToken = DEFAULT_BRIDGE_CONFIG.bridgeToken;
    await chrome.storage.local.set({ bridgeToken: bridgeConfig.bridgeToken });
  }
  bridgeWsUrl = buildWsUrl(bridgeConfig);
  return bridgeConfig;
}

function normalizeBridgeHost(host) {
  return String(host || DEFAULT_BRIDGE_CONFIG.bridgeHost).replace(/^wss?:\/\//, '').replace(/\/+$/, '');
}

function normalizeBridgePort(host, port) {
  const parsedPort = Number(port);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) return parsedPort;
  return isLocalBridge(host) ? DEFAULT_BRIDGE_CONFIG.bridgePort : '';
}

function buildWsUrl(config) {
  const host = normalizeBridgeHost(config.bridgeHost);
  const port = normalizeBridgePort(host, config.bridgePort);
  return port ? `ws://${host}:${port}` : `ws://${host}`;
}

function isLocalBridge(host) {
  return /^(127\.0\.0\.1|localhost)$/.test(host);
}

// 移除页面 CSP 响应头，否则页面会阻止扩展注入的脚本执行（eval / 内联脚本）。
// 注意：必须在每次 Service Worker 启动时都注册 —— chrome.runtime.reload() 不会
// 触发 onInstalled，只在 onInstalled 里注册会导致重载后规则丢失。
function stripCspHeaders() {
  try {
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9999],
      addRules: [{
        id: 9999, priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: [
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' }
        ]},
        condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] }
      }]
    }, () => { if (chrome.runtime.lastError) console.log('[CDP-Bridge] CSP rule error: ' + chrome.runtime.lastError.message); });
  } catch (e) {
    console.log('[CDP-Bridge] CSP rule exception: ' + e.message);
  }
}
stripCspHeaders();

chrome.runtime.onInstalled.addListener(() => {
  console.log('CDP Bridge installed (OHOS build)');
  stripCspHeaders();
});
chrome.runtime.onStartup.addListener(() => stripCspHeaders());

// ---------------------------------------------------------------------------
// 超时竞速工具：国产内核上部分 API 会永久挂起，必须自己设上限
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, label) {
  let timer = null;
  const guarded = Promise.resolve()
    .then(() => promise)
    .then(
      (v) => { if (timer) clearTimeout(timer); return { __ok: true, v }; },
      (e) => { if (timer) clearTimeout(timer); return { __ok: false, e: (e && e.message) || String(e) }; }
    );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __ok: false, e: `TIMEOUT: ${label} did not respond within ${ms}ms` }), ms);
  });
  return Promise.race([guarded, timeout]);
}

// ---------------------------------------------------------------------------
// API 健康记忆：已确认会挂起的 API 直接跳过，避免每次白等超时
// ---------------------------------------------------------------------------
const apiHealth = { scripting: null, debugger: null, legacy: null }; // null=未知 false=确认挂起
const apiHealthTs = { scripting: 0, debugger: 0, legacy: 0 };
const API_RETRY_AFTER = 5 * 60 * 1000;

function markApiDown(api) { apiHealth[api] = false; apiHealthTs[api] = Date.now(); }
function markApiUp(api) { apiHealth[api] = true; apiHealthTs[api] = Date.now(); }
function apiMaybeUp(api) {
  if (apiHealth[api] === false && Date.now() - apiHealthTs[api] < API_RETRY_AFTER) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 三条执行路径
// ---------------------------------------------------------------------------
function waitForTabComplete(tabId, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(fn); } catch (_) {}
      clearTimeout(timer);
      resolve();
    };
    const fn = (id, info) => { if (id === tabId && info && info.status === 'complete') finish(); };
    try { chrome.tabs.onUpdated.addListener(fn); } catch (_) {}
    const timer = setTimeout(finish, ms);
  });
}

async function execViaScripting(tabId, code, ms) {
  const r = await withTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (s) => await eval(s),
      args: [buildPageScript(code)]
    }), ms, 'chrome.scripting.executeScript');
  if (!r.__ok) return { ok: false, error: r.e, via: 'scripting' };
  const res = r.v && r.v[0] ? r.v[0].result : null;
  if (res === null || res === undefined) {
    return { ok: false, error: 'executeScript returned null (possible CSP or context issue)', csp: true, via: 'scripting' };
  }
  res.via = 'scripting';
  return res;
}

// 免 eval 的页面脚本包装：把用户代码作为【字面源码】嵌进 async IIFE，由浏览器原生编译，
// 运行时不再调用 eval / new Function —— 彻��绕开扩展 CSP 对 unsafe-eval 的限制。
function buildNoEvalScript(code) {
  const src = String(code);
  const lines = src.split(/\r?\n/);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { last = i; break; } }
  if (last >= 0) {
    const t = lines[last].trim();
    if (!/^(return\b|let\b|const\b|var\b|if\b|if\(|for\b|for\(|while\b|while\(|switch\b|try\b|throw\b|class\b|function\b|async\b|import\b|export\b|\/\/|\})/.test(t)) {
      lines[last] = lines[last].match(/^(\s*)/)[1] + 'return ' + t;
    }
  }
  const body = lines.join('\n');
  const share = 'window.__tmwdSmart = function(r){ if(r===null||r===undefined||typeof r!=="object") return r; ' +
    'try { if(r.window===r&&r.document) return "[Window]"; } catch(_){} ' +
    'try { if(typeof NodeList!=="undefined"&&r instanceof NodeList){ var a=[]; for(var i=0;i<r.length&&i<100;i++) a.push(r[i]&&r[i].nodeType===1?r[i].outerHTML:String(r[i])); return a;} }catch(_){} ' +
    'try { if(typeof HTMLCollection!=="undefined"&&r instanceof HTMLCollection){ var b=[]; for(var j=0;j<r.length&&j<100;j++) b.push(r[j]&&r[j].nodeType===1?r[j].outerHTML:String(r[j])); return b;} }catch(_){} ' +
    'try { if(r.nodeType===1) return r.outerHTML; }catch(_){} ' +
    'return JSON.parse(JSON.stringify(r,function(k,v){ if(typeof v==="object"&&v!==null){ if(v.nodeType===1) return v.outerHTML; try{ if(v.window===v&&v.document) return "[Window]"; }catch(_){} } return v; })); };';
  return '(async function(){\n' + share + '\n' +
    'try {\n' +
    '  var __r = await (async function(){\n' + body + '\n}).call(this);\n' +
    '  return { ok:true, data: window.__tmwdSmart(__r) };\n' +
    '} catch(e){ return { ok:false, error:{ name:(e&&e.name)||"Error", message:(e&&e.message)||String(e), stack:(e&&e.stack)||"" } }; }\n' +
    '})()';
}

// 路径 0：旧版 chrome.tabs.executeScript —— 浏览器原生编译 JS 字符串（不吃 eval/CSP 限制），
// 不依赖会挂起的 chrome.scripting。部分国产内核里它是唯一不挂的直通道。
async function execViaLegacy(tabId, code, ms) {
  const wrapped = buildNoEvalScript(code);
  const r = await withTimeout(new Promise((resolve, reject) => {
    try {
      chrome.tabs.executeScript(tabId, { code: wrapped }, (res) => {
        const e = chrome.runtime.lastError;
        if (e) { reject(new Error(e.message)); return; }
        if (!res || !res.length) { reject(new Error('legacy executeScript returned empty')); return; }
        resolve(res[0]);
      });
    } catch (e) { reject(e); }
  }), ms, 'chrome.tabs.executeScript(legacy)');
  if (!r.__ok) {
    if (/TIMEOUT/.test(String(r.e))) markApiDown('legacy');
    return { ok: false, error: r.e, via: 'legacy' };
  }
  markApiUp('legacy');
  if (!r.v || typeof r.v !== 'object') return { ok: false, error: 'bad legacy response', via: 'legacy' };
  r.v.via = 'legacy';
  return r.v;
}

async function execViaContentScript(tabId, code, ms) {
  const NEED_RELOAD = /Receiving end does not exist|Could not establish connection/i;

  async function once(timeoutMs) {
    const r = await withTimeout(new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, { __tmwd_eval: true, code, timeout: Math.max(2000, timeoutMs - 1000) }, (resp) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) { reject(new Error(lastErr.message)); return; }
          if (!resp) { reject(new Error('content script returned empty response')); return; }
          resolve(resp);
        });
      } catch (e) { reject(e); }
    }), timeoutMs, 'chrome.tabs.sendMessage -> content script');
    return r;
  }

  let r = await once(Math.max(2500, Math.min(ms, 5000)));

  // 内容脚本未注入（常见于扩展重载后，已打开的旧页面不会重新注入 content script）
  // -> 自动刷新该标签页，等加载完成后重试一次。
  if (!r.__ok && NEED_RELOAD.test(String(r.e))) {
    console.log('[CDP-Bridge] content script missing on tab ' + tabId + ', reloading page once...');
    const rl = await withTimeout(chrome.tabs.reload(tabId), 10000, 'chrome.tabs.reload');
    if (rl.__ok || String(rl.e).indexOf('TIMEOUT') === 0) {
      await waitForTabComplete(tabId, 20000);
      await new Promise(res => setTimeout(res, 600)); // 给 content script 一点注入时间
      r = await once(Math.max(4000, Math.min(ms, 8000)));
      if (r.__ok) r.__recovered = true;
    } else {
      return { ok: false, error: 'page reload failed: ' + rl.e, via: 'content-script' };
    }
  }

  if (!r.__ok) return { ok: false, error: r.e, via: 'content-script' };
  if (!r.v || typeof r.v !== 'object') return { ok: false, error: 'bad content-script response', via: 'content-script' };
  r.v.via = 'content-script';
  if (r.__recovered) r.v.recoveredByReload = true;
  return r.v;
}

async function execViaCDP(tabId, code, ms) {
  const wrapped = buildCdpScript(code);
  const r = await withTimeout((async () => {
    await chrome.debugger.attach({ tabId }, '1.3');
    try {
      const cdpRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: wrapped, awaitPromise: true, returnByValue: true
      });
      if (cdpRes && cdpRes.exceptionDetails) {
        const desc = (cdpRes.exceptionDetails.exception && cdpRes.exceptionDetails.exception.description) || 'CDP Error';
        return { ok: false, error: { name: 'Error', message: desc, stack: desc } };
      }
      return (cdpRes && cdpRes.result && cdpRes.result.value) || { ok: false, error: 'empty CDP result' };
    } finally {
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    }
  })(), ms, 'chrome.debugger (Runtime.evaluate)');
  if (!r.__ok) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { ok: false, error: r.e, via: 'cdp' };
  }
  if (!r.v || typeof r.v !== 'object') return { ok: false, error: 'bad CDP response', via: 'cdp' };
  r.v.via = 'cdp';
  return r.v;
}

// ---------------------------------------------------------------------------
// 结构化 DOM 命令通道（隔离世界内容脚本，无 eval）
// ---------------------------------------------------------------------------
async function domOnce(tabId, action, args, timeoutMs) {
  return await withTimeout(new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { __tmwd_dom: action, args: args || {}, reqId: Date.now() + Math.random() }, (resp) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) { reject(new Error(lastErr.message)); return; }
        if (!resp) { reject(new Error('content script returned empty response')); return; }
        resolve(resp);
      });
    } catch (e) { reject(e); }
  }), timeoutMs, 'content script dom');
}

async function handleDom(tabId, action, args, budgetMs) {
  const NEED_RELOAD = /Receiving end does not exist|Could not establish connection/i;
  let r = await domOnce(tabId, action, args, Math.max(3000, Math.min(budgetMs, 9000)));
  if (!r.__ok && NEED_RELOAD.test(String(r.e))) {
    const rl = await withTimeout(chrome.tabs.reload(tabId), 10000, 'chrome.tabs.reload');
    if (rl.__ok || String(rl.e).indexOf('TIMEOUT') === 0) {
      await waitForTabComplete(tabId, 20000);
      await new Promise(res => setTimeout(res, 600));
      r = await domOnce(tabId, action, args, Math.max(4000, Math.min(budgetMs, 10000)));
    } else {
      return { ok: false, error: 'page reload failed: ' + rl.e };
    }
  }
  if (!r.__ok) return { ok: false, error: r.e };
  return r.v; // { ok, data }
}

// 内联 eval（仅宽松 CSP 页面，作为 browser_execute_js 兜底）
async function evalViaContentScript(tabId, code, timeoutMs) {
  const r = await withTimeout(new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { __tmwd_eval: true, code, timeout: Math.max(2000, timeoutMs - 1000) }, (resp) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) { reject(new Error(lastErr.message)); return; }
        if (!resp) { reject(new Error('content script empty response')); return; }
        resolve(resp);
      });
    } catch (e) { reject(e); }
  }), timeoutMs, 'content script eval');
  if (!r.__ok) return { ok: false, error: r.e };
  return r.v;
}

// 截图：chrome.tabs.captureVisibleTab（需 tab 在前台，debugger 不可用时的替代）
async function handleCapture(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && t.windowId !== undefined) {
      await withTimeout(chrome.tabs.update(tabId, { active: true }), 5000, 'activate tab').catch(() => {});
      await withTimeout(chrome.windows.update(t.windowId, { focused: true }), 5000, 'focus window').catch(() => {});
    }
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));
  const data = await withTimeout(
    chrome.tabs.captureVisibleTab(chrome.windows.WINDOW_ID_CURRENT, { format: 'png' }),
    15000, 'captureVisibleTab');
  if (!data.__ok) return { ok: false, error: data.e };
  // 返回 base64（去掉 data: URL 前缀方便直接落盘）
  let b64 = data.v;
  if (typeof b64 === 'string' && b64.indexOf('base64,') >= 0) b64 = b64.split('base64,')[1];
  return { ok: true, data: { format: 'png', base64: b64 } };
}

async function handleExtMessage(msg, sender) {
  // 插件页面交互事件
  if (msg.cmd === 'bridge_config_get') return { ok: true, data: await loadBridgeConfig() };
  if (msg.cmd === 'bridge_config_set') {
    const nextConfig = { ...(msg.config || {}) };
    if (!nextConfig.bridgeToken) nextConfig.bridgeToken = DEFAULT_BRIDGE_CONFIG.bridgeToken;
    await chrome.storage.local.set(nextConfig);
    await loadBridgeConfig();
    if (ws) ws.close();
    ws = null;
    connectWS();
    return { ok: true, data: bridgeConfig };
  }

  // 诊断：探测各 API 在当前浏览器上的可用性
  if (msg.cmd === 'diag') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    const out = { tabId, ua: navigator.userAgent, checks: {} };
    if (!tabId) return { ok: false, error: 'no tabId for diag' };

    let r = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: () => 1 + 1 }),
      5000, 'chrome.scripting.executeScript');
    out.checks.scripting = r.__ok ? { ok: true, value: r.v && r.v[0] && r.v[0].result } : { ok: false, error: r.e };

    r = await withTimeout(new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, { __tmwd: 'exec', code: '1 + 1', timeout: 6000 }, (resp) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message)); else resolve(resp);
        });
      } catch (e) { reject(e); }
    }), 8000, 'content script channel');
    out.checks.contentScript = r.__ok ? { ok: true, value: r.v } : { ok: false, error: r.e };

    r = await withTimeout((async () => {
      await chrome.debugger.attach({ tabId }, '1.3');
      try {
        const x = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1+1', returnByValue: true });
        return x && x.result && x.result.value;
      } finally { try { await chrome.debugger.detach({ tabId }); } catch (_) {} }
    })(), 6000, 'chrome.debugger');
    out.checks.debugger = r.__ok ? { ok: true, value: r.v } : { ok: false, error: r.e };

    // CSP 移除规则是否已注册
    try {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      out.cspRulesRegistered = rules.length;
    } catch (e) { out.cspRulesRegistered = 'err: ' + e.message; }

    return { ok: true, data: out };
  }

  // 诊断2：重点测旧版 executeScript / 截图 / MAIN world 逃逸
  if (msg.cmd === 'diag2') {
    const tabId = Number(msg.tabId || (sender.tab && sender.tab.id));
    const out = { tabId, checks: {} };
    if (!tabId) return { ok: false, error: 'no tabId for diag2' };

    // A) 旧版 chrome.tabs.executeScript（浏览器原生编译，不吃 eval）—— MV3 可能已移除
    let r = await withTimeout(new Promise((resolve, reject) => {
      try {
        chrome.tabs.executeScript(tabId, { code: '(function(){ return { title: document.title, href: location.href, ready: document.readyState }; })()' }, (res) => {
          const e = chrome.runtime.lastError;
          if (e) { reject(new Error(e.message)); return; }
          if (!res || !res.length) { reject(new Error('legacy executeScript empty')); return; }
          resolve(res[0]);
        });
      } catch (e) { reject(e); }
    }), 8000, 'chrome.tabs.executeScript(legacy)');
    out.checks.legacyExec = r.__ok ? { ok: true, value: r.v } : { ok: false, error: r.e, hang: /TIMEOUT/.test(String(r.e)) };

    // B) 截图 captureVisibleTab
    r = await withTimeout((async () => {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
      const d = await chrome.tabs.captureVisibleTab(chrome.windows.WINDOW_ID_CURRENT, { format: 'png' });
      return String(d || '').length;
    })(), 15000, 'captureVisibleTab');
    out.checks.capture = r.__ok ? { ok: true, dataLen: r.v } : { ok: false, error: r.e, hang: /TIMEOUT/.test(String(r.e)) };

    // C) DNR 动态规则现状
    try { const rules = await chrome.declarativeNetRequest.getDynamicRules(); out.checks.dnrRules = rules.map(x => x.id); }
    catch (e) { out.checks.dnrRules = 'err: ' + e.message; }

    // D) 内容脚本连通性 + MAIN world 逃逸探针
    r = await withTimeout(new Promise((resolve, reject) => {
      try {
        chrome.tabs.sendMessage(tabId, { __tmwd_dom: 'probe_escape', args: {} }, (resp) => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message)); else resolve(resp);
        });
      } catch (e) { reject(e); }
    }), 8000, 'content script probe_escape');
    out.checks.escape = r.__ok ? r.v : { ok: false, error: r.e };

    // E) content 侧 fetch 到 18766（验证 CORS / 本地源可达）
    r = await withTimeout((async () => {
      const t = await (await fetch('http://127.0.0.1:18766/ping?x=' + Date.now())).text();
      return t.slice(0, 120);
    })(), 5000, 'fetch 18766');
    out.checks.bgFetch = r.__ok ? { ok: true, value: r.v } : { ok: false, error: (r.e || '').toString().slice(0, 120) };

    return { ok: true, data: out };
  }

  // 业务事件
  if (msg.cmd === 'cdp') return await handleCDP(msg, sender);
  if (msg.cmd === 'batch') return await handleBatch(msg, sender);
  if (msg.cmd === 'tabs') {
    try {
      if (msg.method === 'switch') {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      } else if (msg.method === 'reload') {
        // 刷新页面以注入/更新 content script（不依赖会挂起的 debugger API）
        const r = await withTimeout(chrome.tabs.reload(msg.tabId, { bypassCache: !!msg.bypassCache }), 10000, 'chrome.tabs.reload');
        if (!r.__ok) return { ok: false, error: r.e };
        return { ok: true };
      } else if (msg.method === 'create' || msg.method === 'open') {
        // 部分国产内核：chrome.tabs.create 会挂起 -> 多路 fallback（依次：tabs.create -> windows.create -> 当前 tab update）
        const url = msg.url;
        let r1 = { ok: false, error: 'not tried' };
        try {
          const p = withTimeout(chrome.tabs.create({ url, active: true }), 4000, 'tabs.create');
          r1 = await p;
        } catch (e) { r1 = { ok: false, error: String((e && e.message) || e) }; }
        if (r1.__ok && r1.v && r1.v.id !== undefined) return { ok: true, data: { id: r1.v.id, url, via: 'tabs.create' } };
        let r2 = { ok: false, error: 'not tried' };
        try {
          const p = withTimeout(chrome.windows.create({ url, focused: true }), 4000, 'windows.create');
          r2 = await p;
        } catch (e) { r2 = { ok: false, error: String((e && e.message) || e) }; }
        if (r2.__ok && r2.v) {
          const t = (r2.v.tabs && r2.v.tabs[0]) || {};
          return { ok: true, data: { id: t.id, url, via: 'windows.create' } };
        }
        // 最后手段：当前可见 tab 原地跳转
        const q = await chrome.tabs.query({ active: true, currentWindow: true });
        const cur = q && q[0] ? q[0] : null;
        if (cur && cur.id !== undefined) {
          await chrome.tabs.update(cur.id, { url }).catch(() => {});
          return { ok: true, data: { id: cur.id, url, via: 'same-tab', note: 'tabs.create/windows.create unavailable on this kernel' } };
        }
        return { ok: false, error: 'no way to open url: ' + (r1.error || '') + ' / ' + (r2.error || '') };
      } else if (msg.method === 'close') {
        // chrome.tabs.remove 在部分国产内核上不可用/挂起 -> 多路 fallback
        const tid = msg.tabId;
        if (tid === undefined || tid === null) return { ok: false, error: 'tabId required' };
        const r1 = await withTimeout(chrome.tabs.remove(tid), 4000, 'tabs.remove');
        if (r1 && r1.__ok) return { ok: true, data: { id: tid, via: 'tabs.remove' } };
        // 回退：让页面自己 window.close()（content script 通道）
        const r2 = await withTimeout(
          chrome.tabs.sendMessage(tid, { __tmwd_eval: true, code: 'window.close(); "closing"', timeout: 4000 }),
          8000, 'content-script window.close');
        if (r2 && r2.__ok && r2.v && r2.v.ok) return { ok: true, data: { id: tid, via: 'content-script window.close' } };
        return { ok: false, error: 'close failed: ' + ((r1 && r1.e) || '') + ' / ' + ((r2 && r2.e) || 'content script no response') };
      } else {
        const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
        const data = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
        return { ok: true, data };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (msg.cmd === 'management') {
    try {
      if (msg.method === 'list') {
        const all = await chrome.management.getAll();
        return { ok: true, data: all.map(e => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, version: e.version })) };
      }
      if (msg.method === 'reload') {
        chrome.alarms.create('tmwd-self-reload', { when: Date.now() + 200 });
        return { ok: true };
      }
      if (msg.method === 'disable') {
        await chrome.management.setEnabled(msg.extId, false);
        return { ok: true };
      }
      if (msg.method === 'enable') {
        await chrome.management.setEnabled(msg.extId, true);
        return { ok: true };
      }
      return { ok: false, error: 'Unknown method: ' + msg.method };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (msg.cmd === 'contentSettings') {
    try {
      const type = msg.type || 'automaticDownloads';
      const setting = msg.setting || 'allow';
      const pattern = msg.pattern || '<all_urls>';
      await chrome.contentSettings[type].set({ primaryPattern: pattern, setting });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'Unknown cmd: ' + msg.cmd };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleExtMessage(msg, sender).then(sendResponse);
  return true;
});

async function handleBatch(msg, sender) {
  const R = [];
  let attached = null;
  const resolve$N = (params) => JSON.parse(JSON.stringify(params || {}).replace(/"\$(\d+)\.([^"]+)"/g,
    (_, i, path) => { let v = R[+i]; for (const k of path.split('.')) v = v[k]; return JSON.stringify(v); }));
  try {
    for (const c of msg.commands) {
      if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
      if (c.cmd === 'tabs') {
        const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
        R.push({ ok: true, data: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) });
      } else if (c.cmd === 'cdp') {
        const tabId = c.tabId || msg.tabId || (sender.tab && sender.tab.id);
        if (attached !== tabId) {
          if (attached) { await chrome.debugger.detach({ tabId: attached }); attached = null; }
          const a = await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 6000, 'debugger.attach');
          if (!a.__ok) { R.push({ ok: false, error: a.e }); continue; }
          attached = tabId;
        }
        const s = await withTimeout(
          chrome.debugger.sendCommand({ tabId }, c.method, resolve$N(c.params)),
          8000, 'debugger.sendCommand(' + c.method + ')');
        R.push(s.__ok ? s.v : { ok: false, error: s.e });
      } else {
        R.push({ ok: false, error: 'unknown cmd: ' + c.cmd });
      }
    }
    if (attached) await chrome.debugger.detach({ tabId: attached });
    return { ok: true, results: R };
  } catch (e) {
    if (attached) try { await chrome.debugger.detach({ tabId: attached }); } catch (_) {}
    return { ok: false, error: e.message, results: R };
  }
}

async function handleCDP(msg, sender) {
  const tabId = msg.tabId || (sender.tab && sender.tab.id);
  if (!tabId) return { ok: false, error: 'no tabId' };
  try {
    const a = await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 6000, 'debugger.attach');
    if (!a.__ok) return { ok: false, error: a.e, via: 'cdp' };
    const s = await withTimeout(
      chrome.debugger.sendCommand({ tabId }, msg.method, msg.params || {}),
      15000, 'debugger.sendCommand(' + msg.method + ')');
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    if (!s.__ok) return { ok: false, error: s.e, via: 'cdp' };
    return { ok: true, data: s.v };
  } catch (e) {
    try { await chrome.debugger.detach({ tabId }); } catch (_) {}
    return { ok: false, error: e.message, via: 'cdp' };
  }
}

// Filter out chrome:// and other internal tabs that can't be scripted
const isScriptable = url => url && /^https?:/.test(url);

// --- Shared page/CDP script builder core ---
function buildExecScript(code, errorHandler) {
  return `(async () => {
    function smartProcessResult(result) {
      if (result === null || result === undefined || typeof result !== 'object') return result;
      try { if (result.window === result && result.document) return '[Window: ' + (result.location?.href || 'about:blank') + ']'; } catch(_){}
      if (typeof jQuery !== 'undefined' && result instanceof jQuery) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result instanceof NodeList || result instanceof HTMLCollection) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result.nodeType === 1) return result.outerHTML;
      if (!Array.isArray(result) && typeof result === 'object' && 'length' in result && typeof result.length === 'number') {
        const firstElement = result[0];
        if (firstElement && firstElement.nodeType === 1) {
          const elements = []; const length = Math.min(result.length, 100);
          for (let i = 0; i < length; i++) { const elem = result[i]; if (elem && elem.nodeType === 1) elements.push(elem.outerHTML); } return elements;
        }
      }
      try { return JSON.parse(JSON.stringify(result, function(key, value) { if (typeof value === 'object' && value !== null) { if (value.nodeType === 1) return value.outerHTML; if (value === window || value === document) return '[Object]'; try { if (value.window === value && value.document) return '[Window]'; } catch(_){} } return value; })); } catch (e) { return '[无法序列化: ' + e.message + ']'; }
    }
    try {
      const jsCode = ${JSON.stringify(code)}.trim();
      const lines = jsCode.split(/\\r?\\n/).filter(l => l.trim());
      const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      let r;
      function _air(c) { const ls = c.split(/\\r?\\n/); let i = ls.length - 1; while (i >= 0 && !ls[i].trim()) i--; if (i < 0) return c; const t = ls[i].trim(); if (/^(return |return;|return$|let |const |var |if |if\\(|for |for\\(|while |while\\(|switch|try |throw |class |function |async |import |export |\\/\\/|})/.test(t)) return c; ls[i] = ls[i].match(/^(\\s*)/)[1] + 'return ' + t; return ls.join('\\n'); }
      if (lastLine.startsWith('return')) {
        r = await (new AsyncFunction(jsCode))();
      } else {
        try { r = eval(jsCode); if (r instanceof Promise) r = await r; } catch (e) {
          if (e instanceof SyntaxError && (/return/i.test(e.message) || /await/i.test(e.message))) { r = await (new AsyncFunction(_air(jsCode)))(); } else throw e;
        }
      }
      return { ok: true, data: smartProcessResult(r) };
    } catch (e) {
      ${errorHandler}
    }
  })()`;
}

function buildPageScript(code) {
  return buildExecScript(code, `
      const errMsg = e.message || String(e);
      return { ok: false, error: { name: e.name || 'Error', message: errMsg, stack: e.stack || '' },
        csp: errMsg.includes('Refused to evaluate') || errMsg.includes('unsafe-eval') || errMsg.includes('Content Security Policy') };
  `);
}

function buildCdpScript(code) {
  return buildExecScript(code, `
      return { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } };
  `);
}

// --- WebSocket Client ---
let ws = null;

function scheduleProbe() {
  chrome.alarms.create('tmwd-ws-probe', { delayInMinutes: 0.083 }); // ~5s
}

function scheduleKeepalive() {
  chrome.alarms.create('tmwd-ws-keepalive', { delayInMinutes: 0.4 }); // ~24s
}

async function isServerAlive() {
  try {
    const config = await loadBridgeConfig();
    if (!isLocalBridge(config.bridgeHost)) return true;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch(`http://${config.bridgeHost}:${config.bridgePort}`, { signal: ctrl.signal });
    return true;
  } catch (e) {
    return false;
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tmwd-self-reload') {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === 'tmwd-ws-keepalive') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      scheduleKeepalive();
    } else {
      ws = null;
      scheduleProbe();
    }
  }
  if (alarm.name === 'tmwd-ws-probe') {
    if (ws && ws.readyState <= 1) return;
    if (await isServerAlive()) {
      console.log('[CDP-Bridge] Server detected, connecting...');
      connectWS();
    } else {
      scheduleProbe();
    }
  }
});

async function handleWsExec(data) {
  const tabId = data.tabId;
  console.log('[CDP-Bridge] Exec request', data.id, 'on tab', tabId);
  try { ws.send(JSON.stringify({ type: 'ack', id: data.id })); } catch (_) {}
  if (!tabId) {
    try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' })); } catch (_) {}
    return;
  }

  const newTabIds = new Set();
  const onCreated = (tab) => { newTabIds.add(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);

  try {
    const budget = Math.max(4000, Math.min(parseFloat(data.timeout) || 15000, 60000));
    const per = Math.max(3000, Math.min(9000, Math.floor(budget / 2)));
    const trail = [];
    let res = null;

    const isTimeout = (x) => /TIMEOUT/.test(typeof x === 'string' ? x : JSON.stringify(x || ''));

    // 路径 0：旧版 chrome.tabs.executeScript（原生编译，不挂起的首选）
    if (apiMaybeUp('legacy')) {
      const r0 = await execViaLegacy(tabId, data.code, per);
      if (r0 && r0.ok) res = r0;
      else if (isTimeout(r0 && r0.error)) markApiDown('legacy');
      else trail.push({ via: 'legacy', error: (r0 && r0.error) || 'null result' });
    } else {
      trail.push({ via: 'legacy', error: 'skipped (confirmed hanging on this browser)' });
    }

    // 路径 1：chrome.scripting（官方路径，最快）—— 已知挂起则直接跳过
    if (apiMaybeUp('scripting')) {
      const r1 = await execViaScripting(tabId, data.code, per);
      if (r1 && r1.ok) { markApiUp('scripting'); res = r1; }
      else {
        if (isTimeout(r1 && r1.error)) markApiDown('scripting');
        trail.push({ via: 'scripting', error: (r1 && r1.error) || 'null result' });
      }
    } else {
      trail.push({ via: 'scripting', error: 'skipped (confirmed hanging on this browser)' });
    }

    // 路径 2：内容脚本通道（绕开会挂起的 scripting/debugger，必要时自动刷新页面恢复）
    if (!res || res.ok === false) {
      const r2 = await execViaContentScript(tabId, data.code, Math.max(per, 14000));
      if (r2 && r2.ok) res = r2;
      else trail.push({ via: 'content-script', error: (r2 && r2.error) || 'null result' });
    }

    // 路径 3：CDP
    if (!res || res.ok === false) {
      if (apiMaybeUp('debugger')) {
        const r3 = await execViaCDP(tabId, data.code, per);
        if (r3 && r3.ok) { markApiUp('debugger'); res = r3; }
        else {
          if (isTimeout(r3 && r3.error)) markApiDown('debugger');
          trail.push({ via: 'cdp', error: (r3 && r3.error) || 'null result' });
        }
      } else {
        trail.push({ via: 'cdp', error: 'skipped (confirmed hanging on this browser)' });
      }
    }

    // Grace period for async tab creation
    if (newTabIds.size === 0) await new Promise(r => setTimeout(r, 200));
    chrome.tabs.onCreated.removeListener(onCreated);
    const newTabs = [];
    for (const id of newTabIds) {
      try { const t = await chrome.tabs.get(id); newTabs.push({ id: t.id, url: t.url, title: t.title }); } catch (_) {}
    }

    if (res && res.ok) {
      const payload = { result: res.data, via: res.via, trail };
      try { ws.send(JSON.stringify({ type: 'result', id: data.id, result: payload, newTabs })); } catch (_) {}
    } else {
      const err = (res && res.error) || { name: 'AllExecPathsFailed', message: 'all execution paths failed', trail };
      try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: err, newTabs })); } catch (_) {}
    }
  } catch (e) {
    try {
      ws.send(JSON.stringify({
        type: 'error', id: data.id,
        error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' }
      }));
    } catch (_) {}
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

// 结构化 DOM 命令（WS 入口）：content script 执行，无 eval
async function handleWsDom(data) {
  const tabId = data.tabId;
  console.log('[CDP-Bridge] DOM request', data.id, JSON.stringify({ action: data.action, args: data.args, tabId }), 'on tab', tabId);
  try { ws.send(JSON.stringify({ type: 'ack', id: data.id, echo: { action: data.action } })); } catch (_) {}
  if (!tabId) { try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' })); } catch (_) {} return; }
  const budget = Math.max(4000, Math.min(parseFloat(data.timeout) || 15000, 60000));
  try {
    const res = await handleDom(tabId, data.action, data.args, budget);
    if (res && res.ok) {
      try { ws.send(JSON.stringify({ type: 'result', id: data.id, result: { result: res.data, via: 'dom' } })); } catch (_) {}
    } else {
      const err = (res && res.error) || { name: 'DomFailed', message: 'dom command failed' };
      try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: err })); } catch (_) {}
    }
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e) } })); } catch (_) {}
  }
}

async function handleWsCapture(data) {
  const tabId = data.tabId;
  console.log('[CDP-Bridge] Capture request', data.id, 'on tab', tabId);
  try { ws.send(JSON.stringify({ type: 'ack', id: data.id })); } catch (_) {}
  if (!tabId) { try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' })); } catch (_) {} return; }
  try {
    const res = await handleCapture(tabId);
    if (res.ok) try { ws.send(JSON.stringify({ type: 'result', id: data.id, result: { result: res.data, via: 'capture' } })); } catch (_) {}
    else try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: res.error })); } catch (_) {}
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e) } })); } catch (_) {}
  }
}

async function connectWS() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  ws = null;
  await loadBridgeConfig();
  console.log('[CDP-Bridge] Connecting to', bridgeWsUrl);
  try {
    ws = new WebSocket(bridgeWsUrl);
  } catch (e) {
    console.error('[CDP-Bridge] Constructor error:', e);
    ws = null;
    connecting = false;
    scheduleProbe();
    return;
  }
  ws.onopen = async () => {
    connecting = false;
    console.log('[CDP-Bridge] Connected!');
    scheduleKeepalive();
    const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
    const msg = { type: 'ext_ready', tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title })) };
    if (bridgeConfig.bridgeToken) msg.token = bridgeConfig.bridgeToken;
    ws.send(JSON.stringify(msg));
    console.log('[CDP-Bridge] Sent ext_ready with', tabs.length, 'tabs');
  };
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && data.code) {
        let code = data.code;
        if (typeof code === 'string') {
          try { const p = JSON.parse(code); if (p && typeof p === 'object') code = p; } catch (_) {}
        }
        // 结构化 DOM 命令：{"__dom":true,"action":...,"args":...}
        if (typeof code === 'object' && code !== null && code.__dom) {
          await handleWsDom({
            id: data.id,
            tabId: (code.tabId !== undefined ? code.tabId : data.tabId),
            action: code.action,
            args: code.args || {},
            timeout: code.timeout || data.timeout,
          });
          return;
        }
        // 原生截图命令：{"cmd":"capture"}
        if (typeof code === 'object' && code !== null && code.cmd === 'capture') {
          await handleWsCapture({ id: data.id, tabId: (code.tabId !== undefined ? code.tabId : data.tabId) });
          return;
        }
        if (typeof code === 'object' && code !== null && code.cmd) {
          if (code.tabId === undefined && data.tabId !== undefined) code.tabId = data.tabId;
          const res = await handleExtMessage(code, {});
          try {
            ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
          } catch (_) {}
        } else if (typeof code === 'string') {
          await handleWsExec(data);
        } else if (typeof code === 'object' && code !== null) {
          const msg = code.tabId === undefined && data.tabId !== undefined ? { ...code, tabId: data.tabId } : code;
          const res = await handleExtMessage(msg, {});
          try {
            ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
          } catch (_) {}
        }
      }
    } catch (e) {
      console.error('[CDP-Bridge] message parse error', e);
    }
  };
  ws.onclose = () => {
    console.log('[CDP-Bridge] Disconnected');
    connecting = false;
    ws = null;
    scheduleProbe();
  };
  ws.onerror = (e) => {
    console.error('[CDP-Bridge] Error:', e);
  };
}

// Initial connect + wake-up hooks
connectWS();
chrome.runtime.onStartup.addListener(() => connectWS());
chrome.runtime.onInstalled.addListener(() => connectWS());

// MV3 的 Service Worker 空闲时会被冻结，chrome.alarms 定时器随之停摆。
// 结果：桥接服务重启后扩展无法自行重连（表现为 tools/list 有工具，但调用报
// "No browser tabs connected"）。这里用浏览器事件作为唤醒源——任何用户活动
// （切换/更新/创建标签页、窗口聚焦）都会唤醒 Service Worker 并重试连接。
function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (ws && ws.readyState <= 1) return;   // 正在连接中
  connectWS();
}
try {
  chrome.tabs.onActivated.addListener(() => ensureConnected());
  chrome.tabs.onUpdated.addListener(() => ensureConnected());
  chrome.tabs.onCreated.addListener(() => ensureConnected());
  chrome.tabs.onRemoved.addListener(() => ensureConnected());
  chrome.windows.onFocusChanged.addListener(() => ensureConnected());
} catch (_) {}

// Sync tab list on changes
async function sendTabsUpdate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url) && !/streamlit/i.test(t.title));
  const msg = { type: 'tabs_update', tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title })) };
  if (bridgeConfig.bridgeToken) msg.token = bridgeConfig.bridgeToken;
  try { ws.send(JSON.stringify(msg)); } catch (_) {}
}
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === 'complete') sendTabsUpdate();
});
chrome.tabs.onRemoved.addListener(() => sendTabsUpdate());
chrome.tabs.onCreated.addListener(() => sendTabsUpdate());
