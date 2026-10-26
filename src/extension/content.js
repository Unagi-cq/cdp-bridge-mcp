// content.js - CDP Bridge 内容脚本（OpenHarmony / 国产 Chromium 内核适配版）
//
// 关键约束（海泰浏览器，Chrome 132 / htbrowser 2.0.22）：
//   * chrome.scripting.executeScript 与 chrome.debugger.* 在 Service Worker 中永久挂起。
//   * 扩展 CSP 默认禁止 unsafe-eval，页面 CSP 又拦截内联脚本注入 -> 全程没有 eval。
// 因此本脚本**不使用任何 eval / new Function**，所有操作都用原生 DOM / 扩展 API 完成。
// 隔离世界内容脚本对页面 DOM 有完全访问权，足以覆盖读页面 / 点按 / 输入 / 滚动 / 跳转。
;(function () {
  if (/streamlit/i.test(document.title)) return;

  // 移除页面 <meta http-equiv=CSP> 标签（尽量放宽，对部分页面有帮助）
  try {
    document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((e) => e.remove());
  } catch (_) {}

  // ------------------------------------------------------------------ 工具
  function isScriptableUrl() { return !!location.href && /^https?:/.test(location.href); }

  function getEl(selector, index) {
    if (!selector) return null;
    const all = document.querySelectorAll(selector);
    const i = index || 0;
    return all[i] || null;
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { return null; }
  }

  function relevantAttrs(el, want) {
    const out = {};
    const keep = want && want.length ? want :
      ['id', 'name', 'value', 'href', 'src', 'type', 'placeholder', 'aria-label', 'title', 'alt', 'role', 'checked', 'selected', 'disabled', 'readonly', 'for', 'action', 'method'];
    for (const n of keep) {
      if (el.hasAttribute(n)) {
        let v = el.getAttribute(n);
        if (v && v.length > 300) v = v.slice(0, 300);
        out[n] = v;
      }
    }
    return out;
  }

  // 兼容 React 受控输入：用原生 setter 设值后派发 input/change
  function setNativeValue(el, value) {
    const proto = (el.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function makeClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    // 兜底：部分元素需要真实指针事件
    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const opt = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent('mousemove', opt));
      el.dispatchEvent(new MouseEvent('mousedown', opt));
      el.dispatchEvent(new MouseEvent('mouseup', opt));
      el.dispatchEvent(new MouseEvent('click', opt));
    } catch (_) {}
  }

  function elSummary(el, i, want) {
    let text = '';
    try { text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); } catch (_) {}
    if (text.length > 300) text = text.slice(0, 300);
    const res = {
      i,
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text,
      rect: rectOf(el),
      attrs: relevantAttrs(el, want),
    };
    // 实时值（用户输入后的 .value），getAttribute('value') 只读默认属性读不到
    try {
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && el.value !== undefined) {
        res.value = String(el.value).slice(0, 300);
      }
    } catch (_) {}
    return res;
  }

  // ------------------------------------------------------- 结构化命令执行
  async function runDom(action, args) {
    args = args || {};
    if (!isScriptableUrl() && action !== 'navigate') {
      return { ok: false, error: 'unscriptable url: ' + location.href };
    }
    switch (action) {
      case 'get_meta':
        return { ok: true, data: { url: location.href, title: document.title, readyState: document.readyState } };

      case 'read_page': {
        const max = Math.max(500, Math.min(parseInt(args.maxchars, 10) || 35000, 200000));
        const body = document.body;
        if (!body) return { ok: false, error: 'no body' };
        let content;
        if (args.text_only) {
          content = (body.innerText || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
        } else {
          // 简化 HTML，供 LLM 消费
          const clone = body.cloneNode(true);
          clone.querySelectorAll('script,style,noscript,template,svg,canvas,iframe,link,meta,object,embed,br,hr').forEach((e) => { try { e.remove(); } catch (_) {} });
          const all = Array.prototype.slice.call(clone.querySelectorAll('*'));
          for (const el of all) {
            const attrs = Array.prototype.slice.call(el.attributes);
            for (const a of attrs) {
              const n = a.name;
              if (!['href', 'src', 'id', 'class', 'type', 'name', 'value', 'placeholder', 'aria-label', 'title', 'alt', 'role', 'checked', 'selected', 'disabled', 'readonly', 'for', 'action', 'method'].includes(n) && !n.startsWith('data-')) {
                el.removeAttribute(n);
              }
            }
            const idx = all.indexOf(el);
            if (idx >= 0) el.setAttribute('wd-i', idx);
          }
          content = clone.innerHTML.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
        }
        if (content.length > max) content = content.slice(0, max) + '\n<!-- truncated -->';
        return {
          ok: true,
          data: {
            url: location.href, title: document.title,
            readyState: document.readyState,
            scrollY: Math.round(window.scrollY || 0),
            scrollHeight: Math.round(document.documentElement.scrollHeight || 0),
            viewportH: Math.round(window.innerHeight || 0),
            content,
          },
        };
      }

      case 'query': {
        const sel = args.selector;
        if (!sel) return { ok: false, error: 'query requires selector' };
        let nodes;
        try { nodes = document.querySelectorAll(sel); } catch (e) { return { ok: false, error: 'bad selector: ' + e.message }; }
        const limit = Math.max(1, Math.min(parseInt(args.limit, 10) || 50, 200));
        const out = [];
        for (let i = 0; i < nodes.length && i < limit; i++) out.push(elSummary(nodes[i], i, args.attrs));
        return { ok: true, data: { count: nodes.length, shown: out.length, elements: out } };
      }

      case 'click': {
        const el = getEl(args.selector, args.index);
        if (!el) return { ok: false, error: 'element not found: ' + args.selector + (args.index ? ' #' + args.index : '') };
        makeClick(el);
        return { ok: true, data: { clicked: args.selector, tag: el.tagName ? el.tagName.toLowerCase() : '' } };
      }

      case 'type': {
        const el = getEl(args.selector, args.index);
        if (!el) return { ok: false, error: 'element not found: ' + args.selector };
        if (args.clear !== false) {
          if (el.value !== undefined) { try { setNativeValue(el, ''); } catch (_) { el.value = ''; } }
        }
        if (args.text !== undefined && args.text !== null) {
          if (el.value !== undefined) setNativeValue(el, String(args.text));
          else el.textContent = String(args.text);
        }
        if (args.enter) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }
        return { ok: true, data: { typed: args.selector, value: (el.value !== undefined ? el.value : el.textContent) } };
      }

      case 'scroll': {
        const x = parseInt(args.x, 10) || 0;
        const y = parseInt(args.y, 10) || 0;
        window.scrollBy(x, y);
        return { ok: true, data: { scrollY: Math.round(window.scrollY || 0) } };
      }

      case 'scroll_to': {
        const top = parseInt(args.top, 10);
        if (!isNaN(top)) window.scrollTo({ top });
        return { ok: true, data: { scrollY: Math.round(window.scrollY || 0) } };
      }

      case 'navigate': {
        const url = args.url;
        if (!url) return { ok: false, error: 'navigate requires url' };
        location.href = /^https?:\/\//.test(url) ? url : (/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url);
        return { ok: true, data: { navigating: url } };
      }

      case 'wait_for': {
        const sel = args.selector;
        if (!sel) return { ok: false, error: 'wait_for requires selector' };
        const timeout = Math.max(1000, Math.min(parseInt(args.timeout, 10) || 8000, 30000));
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const el = document.querySelector(sel);
          if (el) return { ok: true, data: { found: sel, waited_ms: timeout - (deadline - Date.now()) } };
          await new Promise((r) => setTimeout(r, 200));
        }
        return { ok: false, error: 'timeout waiting for: ' + sel };
      }

      case 'read_ls': {
        // 读 localStorage 键（隔离世界与页面共享同 origin 的 localStorage），找鉴权 token
        const out = { keys: [], entries: [] };
        try {
          const maxV = parseInt(args.maxchar, 10) || 120;
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k == null) continue;
            let v = '';
            try { v = localStorage.getItem(k) || ''; } catch (_) {}
            if (v && v.length > maxV) v = v.slice(0, maxV) + '...';
            out.entries.push({ k, v });
            out.keys.push(k);
          }
        } catch (e) { out.err = String((e && e.message) || e); }
        return { ok: true, data: out };
      }

      case 'fetchx': {
        // 页面内 fetch（带 cookie / origin），用于探测同源后端接口。返回截断文本。
        const url = args.url;
        if (!url) return { ok: false, error: 'fetchx requires url' };
        const headers = (args.headers && typeof args.headers === 'object') ? Object.assign({}, args.headers) : {};
        if (args.auth) {
          let tok = '';
          try { tok = localStorage.getItem('token') || ''; } catch (_) {}
          if (tok) {
            if (!headers.Authorization) headers.Authorization = 'Bearer ' + tok;
            if (!headers.token && !headers['Token']) headers.token = tok;
            if (!headers['X-Access-Token']) headers['X-Access-Token'] = tok;
          }
        }
        try {
          const resp = await fetch(url, { credentials: 'include', headers, method: (args.method || 'GET') });
          const text = await resp.text();
          return { ok: true, data: { status: resp.status, len: text.length, url: url.slice(0, 200), body: text.slice(0, args.maxchars || 24000) } };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) + ' @ ' + url.slice(0, 120) }; }
      }

      case 'perf_resources': {
        // 列出页面已加载/请求过的资源 URL（Performance API，无 eval），用于反推后端 API 路���
        let names = [], nav = null, err = null;
        try {
          const all = performance.getEntries ? performance.getEntries() : [];
          names = all.map((e) => e.name && e.name.length > 40 ? e.name.slice(0, 200) : (e.name || ''));
          const n = all.filter((e) => e.entryType === 'navigation');
          if (n && n.length) nav = { url: n[0].name, ts: Math.round(n[0].startTime) };
        } catch (e) { err = String((e && e.message) || e); }
        return { ok: true, data: { count: names.length, nav, err, resources: names } };
      }

      case 'arm_open': {
        // 在(共享的) window 上挂 window.open 代理：页面 JS 调 window.open 时先记录 URL，
        // 再走原始方法。即使被弹窗拦截(非 isTrusted)导致没开窗，URL 也已捕获，
        // 供外部用 chrome.tabs.create 重新打开。幂等。
        try {
          if (window.__tmwdOpenArmed) return { ok: true, data: { armed: true, already: true } };
          window.__tmwdOpens = [];
          const orig = window.open;
          const proxy = function (url, name, features) {
            try { window.__tmwdOpens.push(String(url)); } catch (_) {}
            try { return orig.apply(this, arguments); } catch (e) { return null; }
          };
          try { proxy.toString = () => 'function open() { [native code] }'; } catch (_) {}
          try { Object.defineProperty(window, 'open', { value: proxy, writable: true, configurable: true }); } catch (_) { try { window.open = proxy; } catch (__) {} }
          window.__tmwdOpenArmed = 1;
          return { ok: true, data: { armed: true, already: false } };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }

      case 'read_opens': {
        let arr = [];
        try { arr = (window.__tmwdOpens || []).slice(); } catch (_) {}
        window.__tmwdOpens = [];
        return { ok: true, data: { opens: arr } };
      }

      case 'probe_escape': {
        const out = { url: location.href };
        const metas = Array.prototype.slice.call(document.querySelectorAll('meta'));
        out.metaCspList = metas
          .filter((e) => (e.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy')
          .map((e) => (e.getAttribute('content') || '').slice(0, 300));
        document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((e) => { try { e.remove(); } catch (_) {} });
        const id = 'tmwd_es_' + Math.random().toString(36).slice(2, 8);
        const aRun = 'data-' + id + '-run', aRes = 'data-' + id + '-res';
        const s = document.createElement('script');
        s.textContent = [
          '(function(){',
          'try{',
          'document.documentElement.setAttribute(' + JSON.stringify(aRun) + ',"y");',
          'var ev = ""; try { ev = "ok:" + eval("1+1"); } catch(e){ ev = "err:" + ((e&&e.message)||e); }',
          'var pa = ""; try { pa = "ok:" + JSON.stringify(Object.keys(window).slice(0,12)); } catch(e){ pa = "err:" + ((e&&e.message)||e); }',
          'document.documentElement.setAttribute(' + JSON.stringify(aRes) + ', JSON.stringify({ url: location.href, ev: ev, prodKeys: pa }));',
          '}catch(e){',
          'document.documentElement.setAttribute(' + JSON.stringify(aRes) + ', JSON.stringify({ fatal: String(e) }));',
          '}',
          '})();',
        ].join('');
        (document.head || document.documentElement).appendChild(s);
        await new Promise((r) => setTimeout(r, 2000));
        out.inlineRan = document.documentElement.getAttribute(aRun) === 'y';
        const resRaw = document.documentElement.getAttribute(aRes);
        try { out.mainWorld = resRaw ? JSON.parse(resRaw) : { err: 'no result marker' }; } catch (_) { out.mainWorld = resRaw; }
        const s2 = document.getElementById(s.id); if (s2) { try { s2.remove(); } catch (_) {} }
        document.documentElement.removeAttribute(aRun);
        document.documentElement.removeAttribute(aRes);
        // 内容脚本自己的 eval 能力（扩展 CSP 是否允许）——仅探测用
        let csEval = '';
        try { csEval = 'ok:' + eval('1+1'); } catch (e) { csEval = 'err:' + ((e && e.message) || e).toString().slice(0, 160); }
        out.contentScriptEval = csEval;
        return { ok: true, data: out };
      }

      default:
        return { ok: false, error: 'unknown dom action: ' + action };
    }
  }

  // --------------------------------------------------- 内联 eval（仅宽松 CSP 页面兜底）
  function inlineEval(code, timeoutMs) {
    return new Promise((resolve) => {
      const id = 'tmwd_ev_' + Math.random().toString(36).slice(2, 10);
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(fast); window.removeEventListener('message', onMsg); const s = document.getElementById(id); if (s) try { s.remove(); } catch (_) {} resolve(r); };
      function onMsg(e) { if (e.source !== window) return; const d = e.data; if (!d || d.__tmwd_id !== id) return; finish(d.__tmwd_result); }
      const timer = setTimeout(() => finish({ ok: false, error: 'inline eval timed out (page CSP likely blocks it)' }), timeoutMs);
      const fast = setTimeout(() => { if (document.documentElement.getAttribute('data-tmwd-run') !== id) finish({ ok: false, error: 'page CSP blocked inline script (MAIN world unreachable)' }); }, 1000);
      window.addEventListener('message', onMsg);
      const s = document.createElement('script');
      s.id = id;
      s.textContent = [
        'document.documentElement.setAttribute("data-tmwd-run",' + JSON.stringify(id) + ');',
        '(function(){var __id=' + JSON.stringify(id) + ',__c=' + JSON.stringify(String(code)) + ';',
        'function __ser(r){if(r===null||r===undefined||typeof r!=="object")return r;try{if(r.window===r&&r.document)return"[Window]";}catch(e){}',
        'try{if(typeof NodeList!=="undefined"&&r instanceof NodeList){var a=[];for(var i=0;i<r.length&&i<100;i++)a.push(r[i]&&r[i].nodeType===1?r[i].outerHTML:r[i]);return a;}',
        'if(typeof HTMLCollection!=="undefined"&&r instanceof HTMLCollection){var b=[];for(var j=0;j<r.length&&j<100;j++)b.push(r[j]&&r[j].nodeType===1?r[j].outerHTML:r[j]);return b;}',
        'if(r.nodeType===1)return r.outerHTML;',
        'return JSON.parse(JSON.stringify(r,function(k,v){if(typeof v==="object"&&v!==null){if(v.nodeType===1)return v.outerHTML;try{if(v.window===v&&v.document)return"[Window]";}catch(e){}}return v;}));}catch(e){return"[unserializable]";}}',
        'try{var rr,__t=__c.trim();',
        'if(/^return[\\s;]/.test(__t)){rr=eval(__c);}',
        'else{try{rr=eval(__c);}catch(e){if(e instanceof SyntaxError&&/return|await/i.test(e.message)){rr=(new (Object.getPrototypeOf(async function(){}).constructor)(__c))();}else throw e;}}',
        'if(rr&&typeof rr.then==="function")rr=await rr;',
        'window.postMessage({__tmwd_id:__id,__tmwd_result:{ok:true,data:__ser(rr)}},"*");',
        '}catch(e){window.postMessage({__tmwd_id:__id,__tmwd_result:{ok:false,error:{name:(e&&e.name)||"Error",message:(e&&e.message)||String(e)}}},"*");}})();})();',
      ].join('');
      (document.head || document.documentElement).appendChild(s);
    });
  }

  // ----------------------------------------------------------------- 消息入口
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.__tmwd_dom) {
      runDom(msg.__tmwd_dom, msg.args || {})
        .then((r) => { try { sendResponse(r); } catch (e) {} })
        .catch((e) => { try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (_) {} });
      return true; // 异步
    }
    if (msg.__tmwd_eval) {
      inlineEval(msg.code, Math.max(2000, msg.timeout || 12000))
        .then((r) => { try { sendResponse(r); } catch (e) {} })
        .catch((e) => { try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (_) {} });
      return true;
    }
    // 兼容原版的「注入 div 文本请求」机制（无 eval 时仅放行结构化命令）
    if (msg.__tmwd === 'exec') {
      // 原版传入的是 JS 字符串或 cdp 命令对象；此处仅透传 cdp/batch/tabs 结构命令
      // 任意 JS 已不可行，统一回错并提示用结构化工具。
      try { sendResponse({ ok: false, error: 'arbitrary JS execution is disabled on this kernel (no eval). Use structured browser tools instead.' }); } catch (_) {}
      return true;
    }
    return false;
  });
})();
