const DEFAULT_CONFIG = {
  bridgeHost: '127.0.0.1',
  bridgePort: 18765,
  bridgeToken: '__default__',
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveBridge').addEventListener('click', saveBridgeConfig);
  document.getElementById('genToken').addEventListener('click', generateToken);
  for (const id of ['bridgeHost', 'bridgePort']) {
    document.getElementById(id).addEventListener('input', updatePreview);
  }
  loadBridgeConfig();
});

async function loadBridgeConfig() {
  const resp = await chrome.runtime.sendMessage({ cmd: 'bridge_config_get' });
  const config = resp?.data || DEFAULT_CONFIG;
  document.getElementById('bridgeHost').value = config.bridgeHost || DEFAULT_CONFIG.bridgeHost;
  document.getElementById('bridgePort').value = config.bridgePort ?? DEFAULT_CONFIG.bridgePort;
  document.getElementById('bridgeToken').value = config.bridgeToken || '';
  updatePreview();
}

function readBridgeConfig() {
  const bridgeHost = normalizeBridgeHost(document.getElementById('bridgeHost').value.trim() || DEFAULT_CONFIG.bridgeHost);
  const rawPort = document.getElementById('bridgePort').value.trim();
  const bridgeToken = document.getElementById('bridgeToken').value.trim();
  return {
    bridgeHost,
    bridgePort: normalizeBridgePort(bridgeHost, rawPort),
    bridgeToken,
  };
}

function normalizeBridgeHost(host) {
  return host.replace(/^wss?:\/\//, '').replace(/\/+$/, '');
}

function normalizeBridgePort(host, port) {
  const parsedPort = Number(port);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) return parsedPort;
  return isLocalBridge(host) ? DEFAULT_CONFIG.bridgePort : '';
}

function isLocalBridge(host) {
  return /^(127\.0\.0\.1|localhost)$/.test(host);
}

function buildWsUrl(config) {
  return config.bridgePort ? `ws://${config.bridgeHost}:${config.bridgePort}` : `ws://${config.bridgeHost}`;
}

function updatePreview() {
  document.getElementById('wsPreview').textContent = buildWsUrl(readBridgeConfig());
}

async function saveBridgeConfig() {
  const state = document.getElementById('state');
  const config = readBridgeConfig();
  const resp = await chrome.runtime.sendMessage({ cmd: 'bridge_config_set', config });
  if (resp?.data?.bridgeToken) {
    document.getElementById('bridgeToken').value = resp.data.bridgeToken;
  }
  state.textContent = 'Bridge config saved';
}

function generateToken() {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  const token = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  document.getElementById('bridgeToken').value = token;
}
