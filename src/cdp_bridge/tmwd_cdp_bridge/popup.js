document.addEventListener('DOMContentLoaded', () => {
  const out = document.getElementById('out');
  const btn = document.getElementById('refresh');
  btn.addEventListener('click', fetchCookies);
  fetchCookies();
});

async function fetchCookies() {
  const out = document.getElementById('out');
  const state = document.getElementById('state');
  const count = document.getElementById('count');
  const btn = document.getElementById('refresh');
  state.textContent = 'Loading';
  count.textContent = '0 items';
  btn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) { out.textContent = 'No active tab'; state.textContent = 'No active tab'; return; }
    const resp = await chrome.runtime.sendMessage({ cmd: 'cookies', url: tab.url });
    if (!resp?.ok) { out.textContent = 'Error: ' + (resp?.error || 'unknown'); state.textContent = 'Error'; return; }
    if (!resp.data.length) { out.textContent = '(no cookies)'; state.textContent = 'No cookies'; return; }
    // 展示带标记
    out.textContent = resp.data.map(c =>
      `${c.name}=${c.value}` + (c.httpOnly ? ' [H]' : '') + (c.secure ? ' [S]' : '') + (c.partitionKey ? ' [P]' : '')
    ).join('\n');
    count.textContent = `${resp.data.length} item${resp.data.length === 1 ? '' : 's'}`;
    // 自动复制 name=value; 格式到剪贴板
    const str = resp.data.map(c => `${c.name}=${c.value}`).join('; ');
    await navigator.clipboard.writeText(str);
    state.textContent = 'Copied to clipboard';
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
    state.textContent = 'Error';
  } finally {
    btn.disabled = false;
  }
}
