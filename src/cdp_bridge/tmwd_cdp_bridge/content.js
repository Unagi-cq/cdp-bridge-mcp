;(function(){ if (/streamlit/i.test(document.title)) return;

// Remove meta CSP tags
document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(e => e.remove());

// Indicator badge at bottom-right (userscript style)
(function(){
  if(window.self!==window.top)return;
  if(document.getElementById('ljq-ind'))return;
  const d=document.createElement('div');
  d.id='ljq-ind';
  d.setAttribute('role','button');
  d.setAttribute('aria-label','CDP Bridge connected');
  d.title='CDP Bridge 已连接';
  d.innerHTML='<span class="ljq-ind-dot"></span><span class="ljq-ind-text">CDP Bridge</span>';
  const style=document.createElement('style');
  style.textContent=`
    #ljq-ind{position:fixed;right:14px;bottom:14px;display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border:1px solid rgba(18,24,38,.10);border-radius:999px;background:rgba(255,255,255,.92);color:#182033;font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;letter-spacing:0;box-shadow:0 6px 18px rgba(18,24,38,.12);z-index:2147483647;cursor:pointer;user-select:none;opacity:.82;backdrop-filter:saturate(140%) blur(10px);-webkit-backdrop-filter:saturate(140%) blur(10px);transition:opacity .16s ease, transform .16s ease, box-shadow .16s ease, border-color .16s ease;}
    #ljq-ind:hover{opacity:1;transform:translateY(-1px);border-color:rgba(23,122,92,.22);box-shadow:0 10px 24px rgba(18,24,38,.16);}
    #ljq-ind:active{transform:translateY(0);box-shadow:0 4px 12px rgba(18,24,38,.14);}
    #ljq-ind .ljq-ind-dot{width:7px;height:7px;border-radius:50%;background:#18a058;box-shadow:0 0 0 3px rgba(24,160,88,.14);flex:0 0 auto;}
    #ljq-ind .ljq-ind-text{white-space:nowrap;}
  `;
  function showBridgeNotice(message){
    if(!document.getElementById('tmwd-bridge-notice-style')){
      const s=document.createElement('style');
      s.id='tmwd-bridge-notice-style';
      s.textContent=`
        .tmwd-bridge-notice{position:fixed;right:14px;bottom:52px;z-index:2147483647;width:min(360px,calc(100vw - 28px));display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;padding:12px 13px;border:1px solid rgba(18,24,38,.10);border-radius:12px;background:rgba(255,255,255,.95);color:#182033;box-shadow:0 10px 28px rgba(18,24,38,.14);font:400 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;letter-spacing:0;opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease;backdrop-filter:saturate(140%) blur(10px);-webkit-backdrop-filter:saturate(140%) blur(10px);}
        .tmwd-bridge-notice.is-visible{opacity:1;transform:translateY(0);}
        .tmwd-bridge-notice-icon{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#eef8f3;color:#168456;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}
        .tmwd-bridge-notice-title{color:#182033;font-weight:650;margin:0 0 3px;}
        .tmwd-bridge-notice-message{color:#4c566a;margin:0;max-height:96px;overflow:hidden;word-break:break-word;}
      `;
      (document.head||document.documentElement).appendChild(s);
    }
    document.querySelectorAll('.tmwd-bridge-notice').forEach(n=>n.remove());
    const n=document.createElement('div');
    n.className='tmwd-bridge-notice';
    n.innerHTML='<div class="tmwd-bridge-notice-icon">i</div><div><div class="tmwd-bridge-notice-title">CDP Bridge 已连接</div><p class="tmwd-bridge-notice-message"></p></div>';
    n.querySelector('.tmwd-bridge-notice-message').textContent=message;
    (document.body||document.documentElement).appendChild(n);
    requestAnimationFrame(()=>n.classList.add('is-visible'));
    setTimeout(()=>n.classList.remove('is-visible'),3200);
    setTimeout(()=>n.remove(),3450);
  }
  d.addEventListener('click',()=>showBridgeNotice('会话活跃\nURL: '+location.href));
  (document.head||document.documentElement).appendChild(style);
  (document.body||document.documentElement).appendChild(d);
})();

new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.id === TID || (n.querySelector && n.querySelector('#' + TID))) {
      const el = n.id === TID ? n : n.querySelector('#' + TID);
      handle(el);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

async function handle(el) {
  try {
    const req = el.textContent.trim() ? JSON.parse(el.textContent) : { cmd: 'cookies' };
    const cmd = req.cmd || 'cookies';
    let resp;
    if (cmd === 'cookies') {
      resp = await chrome.runtime.sendMessage({ cmd: 'cookies', url: req.url || location.href });
    } else if (cmd === 'cdp') {
      resp = await chrome.runtime.sendMessage({ cmd: 'cdp', method: req.method, params: req.params || {}, tabId: req.tabId });
    } else if (cmd === 'batch') {
      resp = await chrome.runtime.sendMessage({ cmd: 'batch', commands: req.commands, tabId: req.tabId });
    } else if (cmd === 'tabs') {
      resp = await chrome.runtime.sendMessage({ cmd: 'tabs', method: req.method, tabId: req.tabId });
    } else {
      resp = { ok: false, error: 'unknown cmd: ' + cmd };
    }
    el.textContent = JSON.stringify(resp);
  } catch (e) {
    el.textContent = JSON.stringify({ ok: false, error: e.message });
  }
}
})();
