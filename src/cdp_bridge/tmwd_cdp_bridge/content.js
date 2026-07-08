;(function(){ if (/streamlit/i.test(document.title)) return;

// Remove meta CSP tags
document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(e => e.remove());

// Indicator badge at bottom-right (userscript style)
(function(){
  if(window.self!==window.top)return;

  let badgeEl=null;

  function createStyle(){
    if(document.getElementById('ljq-ind-style'))return;
    const style=document.createElement('style');
    style.id='ljq-ind-style';
    style.textContent=`
      #ljq-ind{position:fixed;right:14px;bottom:14px;display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border:1px solid rgba(18,24,38,.10);border-radius:999px;background:rgba(255,255,255,.92);color:#182033;font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;letter-spacing:0;box-shadow:0 6px 18px rgba(18,24,38,.12);z-index:2147483647;cursor:grab;user-select:none;opacity:.82;backdrop-filter:saturate(140%) blur(10px);-webkit-backdrop-filter:saturate(140%) blur(10px);transition:opacity .16s ease, transform .16s ease, box-shadow .16s ease, border-color .16s ease;}
      #ljq-ind:hover{opacity:1;transform:translateY(-1px);border-color:rgba(23,122,92,.22);box-shadow:0 10px 24px rgba(18,24,38,.16);}
      #ljq-ind:active{transform:translateY(0);box-shadow:0 4px 12px rgba(18,24,38,.14);}
      #ljq-ind .ljq-ind-dot{width:7px;height:7px;border-radius:50%;background:#18a058;box-shadow:0 0 0 3px rgba(24,160,88,.14);flex:0 0 auto;}
      #ljq-ind .ljq-ind-text{white-space:nowrap;}
      #ljq-ind .ljq-ind-close{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;margin-left:1px;border-radius:50%;font-size:13px;line-height:1;color:#8e98a9;cursor:pointer;flex:0 0 auto;transition:color .12s ease,background .12s ease;}
      #ljq-ind .ljq-ind-close:hover{color:#4c566a;background:rgba(18,24,38,.07);}
    `;
    (document.head||document.documentElement).appendChild(style);
  }

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

  function createBadge(savedPosition){
    if(document.getElementById('ljq-ind'))return;
    createStyle();

    const d=document.createElement('div');
    d.id='ljq-ind';
    d.setAttribute('role','button');
    d.setAttribute('aria-label','CDP Bridge connected');
    d.title='CDP Bridge 已连接';
    d.innerHTML='<span class="ljq-ind-dot"></span><span class="ljq-ind-text">CDP Bridge</span><span class="ljq-ind-close" title="关闭浮标">×</span>';

    if(savedPosition){
      d.style.left=savedPosition.left+'px';d.style.top=savedPosition.top+'px';
      d.style.right='auto';d.style.bottom='auto';
    }

    let _dragging=false,_hasDragged=false,_sX,_sY,_sL,_sT;
    function _start(cx,cy,e){
      _dragging=true;_hasDragged=false;
      const r=d.getBoundingClientRect();
      _sX=cx;_sY=cy;_sL=r.left;_sT=r.top;
      e.preventDefault();
    }
    function _move(cx,cy){
      if(!_dragging)return;
      const dx=cx-_sX,dy=cy-_sY;
      if(!_hasDragged&&(Math.abs(dx)>3||Math.abs(dy)>3)){
        _hasDragged=true;
        d.style.left=_sL+'px';d.style.top=_sT+'px';
        d.style.right='auto';d.style.bottom='auto';
        d.style.cursor='grabbing';d.style.transition='none';
      }
      if(_hasDragged){d.style.left=(_sL+dx)+'px';d.style.top=(_sT+dy)+'px';}
    }
    function _end(){
      if(!_dragging)return;
      _dragging=false;
      if(_hasDragged){
        d.style.cursor='grab';d.style.transition='';
        d._preventClick=true;
        const r=d.getBoundingClientRect();
        chrome.storage.local.set({badgePosition:{left:r.left,top:r.top}});
      }
    }
    d.addEventListener('mousedown',e=>{if(e.button===0)_start(e.clientX,e.clientY,e);});
    d.addEventListener('touchstart',e=>{const t=e.touches[0];_start(t.clientX,t.clientY,e);},{passive:false});
    document.addEventListener('mousemove',e=>_move(e.clientX,e.clientY));
    document.addEventListener('touchmove',e=>{const t=e.touches[0];_move(t.clientX,t.clientY);},{passive:false});
    document.addEventListener('mouseup',_end);
    document.addEventListener('touchend',_end);
    d.querySelector('.ljq-ind-close').addEventListener('click',e=>{e.stopPropagation();hideBadge();});
    d.addEventListener('click',()=>{if(d._preventClick){d._preventClick=false;return;}showBridgeNotice('会话活跃\nURL: '+location.href);});
    (document.body||document.documentElement).appendChild(d);
    badgeEl=d;
  }

  function hideBadge(){
    if(badgeEl){badgeEl.remove();badgeEl=null;}
    chrome.storage.local.set({badgeHidden:true});
  }

  function showBadge(){
    chrome.storage.local.set({badgeHidden:false});
    createBadge(null);
  }

  chrome.storage.local.get(['badgePosition','badgeHidden'],stored=>{
    if(!stored.badgeHidden)createBadge(stored.badgePosition);
  });

  chrome.storage.onChanged.addListener(changes=>{
    if(changes.badgeHidden){
      if(changes.badgeHidden.newValue)hideBadge();
      else showBadge();
    }
  });
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
    const text = el.textContent.trim();
    if (!text) { el.textContent = JSON.stringify({ ok: false, error: 'empty request' }); return; }
    const req = JSON.parse(text);
    const cmd = req.cmd;
    let resp;
    if (cmd === 'cdp') {
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
