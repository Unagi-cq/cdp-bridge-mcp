// Disable alert/confirm/prompt to prevent page JS from blocking extension
(function() {
  const _log = console.log.bind(console);
  const TYPE_LABELS = {
    alert: 'Alert',
    confirm: 'Confirm',
    prompt: 'Prompt'
  };

  function ensureStyle() {
    if (document.getElementById('tmwd-dialog-style')) return;
    const style = document.createElement('style');
    style.id = 'tmwd-dialog-style';
    style.textContent = `
      #tmwd-dialog-stack{position:fixed;top:14px;right:14px;z-index:2147483647;display:flex;flex-direction:column;gap:10px;width:min(380px,calc(100vw - 28px));pointer-events:none;}
      .tmwd-dialog-toast{display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;padding:12px 13px;border:1px solid rgba(18,24,38,.10);border-radius:12px;background:rgba(255,255,255,.95);color:#182033;box-shadow:0 10px 28px rgba(18,24,38,.14);font:400 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;letter-spacing:0;opacity:0;transform:translateY(-6px);transition:opacity .18s ease,transform .18s ease;backdrop-filter:saturate(140%) blur(10px);-webkit-backdrop-filter:saturate(140%) blur(10px);}
      .tmwd-dialog-toast.is-visible{opacity:1;transform:translateY(0);}
      .tmwd-dialog-icon{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#eef8f3;color:#168456;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;}
      .tmwd-dialog-title{color:#182033;font-weight:650;margin:0 0 3px;}
      .tmwd-dialog-message{color:#4c566a;margin:0;max-height:96px;overflow:hidden;word-break:break-word;}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureStack() {
    let stack = document.getElementById('tmwd-dialog-stack');
    if (stack) return stack;
    stack = document.createElement('div');
    stack.id = 'tmwd-dialog-stack';
    (document.body || document.documentElement).appendChild(stack);
    return stack;
  }

  function toast(type, msg) {
    _log('[TMWD] ' + type + ' suppressed:', msg);
    try {
      ensureStyle();
      const stack = ensureStack();
      const d = document.createElement('div');
      d.className = 'tmwd-dialog-toast';
      const text = String(msg ?? '');
      d.innerHTML =
        '<div class="tmwd-dialog-icon">!</div>' +
        '<div>' +
          '<div class="tmwd-dialog-title">CDP Bridge : Blocked ' + (TYPE_LABELS[type] || type) + '</div>' +
          '<p class="tmwd-dialog-message"></p>' +
        '</div>';
      d.querySelector('.tmwd-dialog-message').textContent = text || '(empty message)';
      stack.prepend(d);
      requestAnimationFrame(() => d.classList.add('is-visible'));
      setTimeout(() => { d.classList.remove('is-visible'); }, 3200);
      setTimeout(() => { d.remove(); if (!stack.children.length) stack.remove(); }, 3450);
    } catch(e) {}
  }
  window.alert = function(msg) { toast('alert', msg); };
  window.confirm = function(msg) { toast('confirm', msg); return true; };
  window.prompt = function(msg, def) { toast('prompt', msg); return def || null; };
})();
