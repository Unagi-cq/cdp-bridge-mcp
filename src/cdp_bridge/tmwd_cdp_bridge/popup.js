const DEFAULT_CONFIG = {
  bridgeHost: '127.0.0.1',
  bridgePort: 18765,
};

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('refresh');
  btn.addEventListener('click', fetchCookies);
  document.getElementById('saveBridge').addEventListener('click', saveBridgeConfig);
  for (const id of ['bridgeHost', 'bridgePort']) {
    document.getElementById(id).addEventListener('input', updatePreview);
  }
  loadBridgeConfig();
  fetchCookies();
});

async function loadBridgeConfig() {
  const resp = await chrome.runtime.sendMessage({ cmd: 'bridge_config_get' });
  const config = resp?.data || DEFAULT_CONFIG;
  document.getElementById('clientId').textContent = config.clientId || chrome.runtime.id || 'Unavailable';
  document.getElementById('bridgeHost').value = config.bridgeHost || DEFAULT_CONFIG.bridgeHost;
  document.getElementById('bridgePort').value = config.bridgePort || DEFAULT_CONFIG.bridgePort;
  updatePreview();
}

function readBridgeConfig() {
  return {
    bridgeHost: document.getElementById('bridgeHost').value.trim() || DEFAULT_CONFIG.bridgeHost,
    bridgePort: Number(document.getElementById('bridgePort').value) || DEFAULT_CONFIG.bridgePort,
  };
}

function buildWsUrl(config) {
  return `ws://${config.bridgeHost}:${config.bridgePort}`;
}

function updatePreview() {
  document.getElementById('wsPreview').textContent = buildWsUrl(readBridgeConfig());
}

async function saveBridgeConfig() {
  const state = document.getElementById('state');
  const config = readBridgeConfig();
  await chrome.runtime.sendMessage({ cmd: 'bridge_config_set', config });
  state.textContent = 'Bridge config saved';
}

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
    out.textContent = resp.data.map(c =>
      `${c.name}=${c.value}` + (c.httpOnly ? ' [H]' : '') + (c.secure ? ' [S]' : '') + (c.partitionKey ? ' [P]' : '')
    ).join('\n');
    count.textContent = `${resp.data.length} item${resp.data.length === 1 ? '' : 's'}`;
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
