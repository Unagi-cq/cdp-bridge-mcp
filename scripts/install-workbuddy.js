'use strict';
// install-workbuddy.js —— 一键把 cdp-bridge-ohos 接入 WorkBuddy MCP
//
// 作用：把本项目的 MCP 服务器配置【合并】写入 WorkBuddy 的 ~/.workbuddy/mcp.json，
//   - 自动探测当前 node 可执行文件路径（process.execPath）
//   - 自动解析 src/mcp-stdio.js 的绝对路径
//   - 保留 mcp.json 里已有的其它服务器，不覆盖、不删除
//   - 写入前自动备份为 ~/.workbuddy/mcp.json.bak
//
// 用法：
//   node scripts/install-workbuddy.js
//
// 完成后还需要在 WorkBuddy 界面做一次"信任"（见 README「WorkBuddy 一键接入」）：
//   连接器 → 右上角「自定义连接器 / MCP 服务器」→ 看到 cdp-bridge-ohos → 点「信任」→ 启用
//
// 可选参数：
//   --home <dir>   指定 workbuddy 配置目录（默认使用系统 home）
//   --name <id>    自定义服务器名称（默认 cdp-bridge-ohos）
//   --dry-run      只打印将要写入的内容，不写盘

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const home = opt('--home') || os.homedir();
const serverName = opt('--name') || 'cdp-bridge-ohos';
const dryRun = argv.includes('--dry-run');

const mcpPath = path.join(home, '.workbuddy', 'mcp.json');
const stdioJs = path.resolve(__dirname, '..', 'src', 'mcp-stdio.js');

if (!fs.existsSync(stdioJs)) {
  console.error('[x] 找不到 ' + stdioJs + '，请在本项目目录内运行此脚本');
  process.exit(1);
}

// 读取现有配置（不存在则初始化为空对象）
let cfg = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  } catch (e) {
    console.error('[!] 解析 ' + mcpPath + ' 失败：' + e.message + '（先手动修复该 JSON 再运行）');
    process.exit(1);
  }
}
if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};

const entry = {
  command: process.execPath,
  args: [stdioJs],
  env: {
    CDP_BRIDGE_WS_PORT: '18765',
    CDP_BRIDGE_CTRL_PORT: '18766',
  },
};

const existed = Object.prototype.hasOwnProperty.call(cfg.mcpServers, serverName);
cfg.mcpServers[serverName] = entry;

const out = JSON.stringify(cfg, null, 2) + '\n';

console.log('服务器名称 : ' + serverName);
console.log('stdio 入口 : ' + stdioJs);
console.log('node 路径  : ' + process.execPath);
console.log('配置文件  : ' + mcpPath);
console.log('目标状态  : ' + (existed ? '更新已有条目' : '新增条目'));
console.log('');
console.log('---------- 写入后的 ' + serverName + ' 配置 ----------');
console.log(JSON.stringify({ [serverName]: entry }, null, 2));
console.log('-----------------------------------------------------');

if (dryRun) {
  console.log('\n(--dry-run) 未写盘。以上为将要写入的内容。');
  return;
}

// 备份 + 写入
if (fs.existsSync(mcpPath)) {
  fs.copyFileSync(mcpPath, mcpPath + '.bak');
  console.log('[✓] 已备份原配置到 ' + mcpPath + '.bak');
}
fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
fs.writeFileSync(mcpPath, out, 'utf8');

console.log('[✓] 已写入 ' + mcpPath);
console.log('');
console.log('最后一步（在 WorkBuddy 界面完成，一次性）：');
console.log('  1. 左侧边栏 → 连接器');
console.log('  2. 右上角 → 自定义连接器 / MCP 服务器');
console.log('  3. 找到 "' + serverName + '" → 点「信任」→ 启用');
console.log('  4. 状态为绿色（已连接）即表示接入成功');
