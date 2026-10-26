#!/bin/sh
# update-to-v0.2.0.sh —— 把已有仓库更新到 v0.2.0
#
# 兼容 Alpine Linux：使用 POSIX sh，不依赖 bash、不依赖 GNU coreutils 专有选项。
#   - 可直接 ./update-to-v0.2.0.sh 执行（busybox ash 会走 sh 解释器）
#   - 也可 sh update-to-v0.2.0.sh
#
# 用法：
#   ./update-to-v0.2.0.sh            # 只提交，不推送
#   ./update-to-v0.2.0.sh --push     # 提交并推送
#   ./update-to-v0.2.0.sh --dry-run  # 只演示会做什么，不改文件不提交

set -eu

VERSION="v0.2.0"
DO_PUSH=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --push)    DO_PUSH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "用法: $0 [--push] [--dry-run]"
      echo "  --push     提交后推送到 origin"
      echo "  --dry-run  只预览，不修改文件、不提交"
      exit 0
      ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

# 定位脚本所在目录（POSIX 写法，兼容 busybox）
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

# 自动定位仓库根：从脚本目录向上最多找 4 层，找带 .git 的
REPO_ROOT=""
d="$SCRIPT_DIR"
i=0
while [ "$i" -lt 4 ]; do
  if [ -d "$d/.git" ]; then REPO_ROOT="$d"; break; fi
  [ "$d" = "/" ] && break
  d=$(dirname -- "$d")
  i=$((i + 1))
done

echo "==========================================="
echo " cdp-bridge-ohos 更新到 $VERSION"
echo "==========================================="

# --- 1. 环境检查 ---
if ! command -v git >/dev/null 2>&1; then
  echo ""
  echo "[错误] 未找到 git。Alpine 上安装：" >&2
  echo "" >&2
  echo "  apk add git" >&2
  echo "" >&2
  echo "（如果你在 Alpine 上且没有 root 权限，可改用便携版 git，详见 UPDATE-GUIDE.md）" >&2
  exit 1
fi

if [ -z "$REPO_ROOT" ]; then
  echo ""
  echo "[错误] 找不到 git 仓库。" >&2
  echo "" >&2
  echo "请这样操作：" >&2
  echo "  1) clone 仓库" >&2
  echo "     git clone https://github.com/torobucks/cdp-bridge-mcp-ohos.git" >&2
  echo "     cd cdp-bridge-mcp-ohos" >&2
  echo "  2) 解压本更新包到仓库根目录" >&2
  echo "     unzip cdp-bridge-mcp-ohos-v0.2.0-update.zip -d ." >&2
  echo "     # Alpine 若没有 unzip: apk add unzip" >&2
  echo "     # 或用 busybox: busybox unzip cdp-bridge-mcp-ohos-v0.2.0-update.zip -d ." >&2
  echo "  3) 运行本脚本" >&2
  echo "     ./update-v0.2.0/update-to-v0.2.0.sh" >&2
  exit 1
fi

cd "$REPO_ROOT"
echo "仓库: $REPO_ROOT"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "*** DRY-RUN 模式：不修改文件、不提交 ***"
fi

# --- 排除更新包自身 ---
# 更新包解压在仓库内时，它自己会变成未跟踪文件，触发下面的"工作区不干净"检查。
# 这里把它写进 .git/info/exclude（仅本地生效，不污染仓库的 .gitignore）。
PKG_REL=$(basename -- "$SCRIPT_DIR")
if [ -f "$REPO_ROOT/.git/info/exclude" ]; then
  if ! grep -qx "$PKG_REL/" "$REPO_ROOT/.git/info/exclude" 2>/dev/null; then
    echo "$PKG_REL/" >> "$REPO_ROOT/.git/info/exclude"
    echo "已将更新包目录加入本地排除: $PKG_REL/"
  fi
fi

# --- 2. 工作区检查 ---
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  echo ""
  echo "[中止] 工作区有未提交的改动：" >&2
  git status --short >&2 || true
  echo "" >&2
  echo "请先提交或 stash：" >&2
  echo "  git add -A && git commit -m 'wip'" >&2
  echo "  # 或" >&2
  echo "  git stash" >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
echo "分支: $BRANCH"

# --- 3. 拉取远端 ---
echo ""
echo "[1/6] 拉取远端最新..."
if [ "$DRY_RUN" = "1" ]; then
  echo "  (dry-run: 跳过)"
else
  # 新建的分支在远端还不存在，直接 pull 会报 "couldn't find remote ref"。
  # 只有当远端确实有这个分支时才 pull。
  if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    if ! git pull --rebase origin "$BRANCH" 2>/dev/null; then
      git pull origin "$BRANCH"
    fi
  else
    echo "  远端暂无分支 $BRANCH（新建分支，跳过拉取）"
    # 新分支：仅把远端 main 的最新提交取回来作为基底，不改动工作区与已有提交
    if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
      git fetch origin main >/dev/null 2>&1 || true
      # 若当前分支正好停在 origin/main 上，无需额外处理
      if git rev-parse --verify origin/main >/dev/null 2>&1; then
        BASE=$(git rev-parse origin/main)
        CUR=$(git rev-parse HEAD)
        if [ "$BASE" != "$CUR" ]; then
          # 仅在本地没有额外提交时快进；否则用 merge 保留历史
          if git diff --quiet HEAD origin/main 2>/dev/null; then
            git merge --ff-only origin/main >/dev/null 2>&1 || true
          else
            git merge --no-edit origin/main >/dev/null 2>&1 || true
          fi
        fi
      fi
    fi
  fi
fi

# --- 4. 覆盖文件 ---
echo ""
echo "[2/6] 应用更新..."

APPLIED_COUNT=0
SKIPPED_COUNT=0

# apply <更新包内路径> <仓库内目标路径>
apply() {
  src="$SCRIPT_DIR/$1"
  dst="$REPO_ROOT/$2"
  if [ ! -f "$src" ]; then
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    echo "    跳过 $2（更新包中不存在）"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    APPLIED_COUNT=$((APPLIED_COUNT + 1))
    return 0
  fi
  dstdir=$(dirname -- "$dst")
  if [ ! -d "$dstdir" ]; then
    mkdir -p "$dstdir"
  fi
  if cp "$src" "$dst"; then
    APPLIED_COUNT=$((APPLIED_COUNT + 1))
  else
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    echo "    失败 $2"
  fi
}

# --- 核心代码（对齐远端 src/ 布局）---
apply "src/extension/background.js"        "src/extension/background.js"
apply "src/extension/content.js"           "src/extension/content.js"
apply "src/extension/config.js"            "src/extension/config.js"
apply "src/extension/disable_dialogs.js"   "src/extension/disable_dialogs.js"
apply "src/extension/manifest.json"        "src/extension/manifest.json"
apply "src/extension/popup.html"           "src/extension/popup.html"
apply "src/extension/popup.js"             "src/extension/popup.js"
apply "src/extension/icons/icon-16.png"    "src/extension/icons/icon-16.png"
apply "src/extension/icons/icon-32.png"    "src/extension/icons/icon-32.png"
apply "src/extension/icons/icon-48.png"    "src/extension/icons/icon-48.png"
apply "src/extension/icons/icon-128.png"   "src/extension/icons/icon-128.png"
apply "src/extension/icons/icon-256.png"   "src/extension/icons/icon-256.png"
apply "src/mcp-stdio.js"                   "src/mcp-stdio.js"
apply "src/bridge-server.js"              "src/bridge-server.js"
apply "src/ws-mini.js"                    "src/ws-mini.js"

# --- 新增工具 ---
apply "scripts/oh-browser.js"             "scripts/oh-browser.js"
apply "scripts/verify-mcp.js"             "scripts/verify-mcp.js"
apply "examples/minimal-agent.js"         "examples/minimal-agent.js"
apply "docs/integration-guide.md"         "docs/integration-guide.md"

# --- 文档 ---
apply "README_EN.md"                      "README_EN.md"
apply "CHANGELOG.md"                      "CHANGELOG.md"

echo "  已覆盖 $APPLIED_COUNT 个文件，跳过 $SKIPPED_COUNT 个"

# --- 5. 展示差异 ---
echo ""
echo "[3/6] 待提交的变更："
git status --short || true
echo ""
echo "变更统计："
git diff --stat || true

# --- 6. 语法自检 ---
echo ""
echo "[4/6] 语法自检..."
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
elif command -v nodejs >/dev/null 2>&1; then
  # Debian/Ubuntu 常见；Alpine 默认命令名就是 node
  NODE_BIN="nodejs"
fi

if [ -n "$NODE_BIN" ]; then
  SYNTAX_OK=1
  for f in \
    src/mcp-stdio.js \
    src/bridge-server.js \
    src/ws-mini.js \
    src/extension/background.js \
    src/extension/content.js \
    scripts/oh-browser.js \
    scripts/verify-mcp.js \
    examples/minimal-agent.js
  do
    if [ -f "$REPO_ROOT/$f" ]; then
      if "$NODE_BIN" --check "$REPO_ROOT/$f" >/dev/null 2>&1; then
        echo "  OK   $f"
      else
        echo "  FAIL $f"
        SYNTAX_OK=0
      fi
    fi
  done
  if [ "$SYNTAX_OK" != "1" ]; then
    echo "[中止] 语法检查未通过，未提交。"
    exit 1
  fi

  # musl libc 环境（Alpine）常见问题：glibc 版 Node 二进制无法运行，
  # 表现为 `not found` / `Error relocating`。这里主动检测并给出明确指引。
  if ! "$NODE_BIN" -e 'process.exit(0)' >/dev/null 2>&1; then
    echo ""
    echo "[警告] Node 二进制无法执行。Alpine 使用 musl libc，需安装 musl 版 Node：" >&2
    echo "  apk add nodejs" >&2
    echo "" >&2
    echo "若已安装却仍失败，多半是装了 glibc 版：先用 apk 覆盖安装。" >&2
  fi
else
  echo "  未找到 node/nodejs，跳过语法检查"
  echo "  提示: apk add nodejs"
fi

# --- 7. 提交 ---
echo ""
echo "[5/6] 提交..."

if [ "$DRY_RUN" = "1" ]; then
  echo "  (dry-run: 跳过提交与打 tag)"
else
  git add -A
  git commit -F - <<'COMMIT_MSG'
feat: v0.2.0 — 扩展可控性修复 + 新增工具与文档

扩展修复：
- 新增 tabs.close 命令（chrome.tabs.remove + content script window.close 双路降级）
- 新增 Service Worker 唤醒钩子（tabs/windows 事件驱动重连），
  解决桥接服务重启后扩展无法自愈、tools/list 有工具但调用报
  No browser tabs connected 的问题

新增：
- scripts/oh-browser.js        命令行客户端
- scripts/verify-mcp.js        端到端自检（握手/工具清单/连通性）
- examples/minimal-agent.js    零依赖 MCP 客户端示例
- docs/integration-guide.md    完整接入文档
- README_EN.md / CHANGELOG.md  英文文档与变更记录

兼容性：mcp-stdio.js、content.js、bridge-server.js 与 v0.1.23 保持一致，
本次为增量发布，不破坏既有目录结构与 API。
COMMIT_MSG

  git tag -a "$VERSION" -m "$VERSION"
  echo "  已提交并打 tag: $VERSION"
fi

# --- 8. 完成 ---
echo ""
echo "[6/6] 完成"
echo "==========================================="

if [ "$DRY_RUN" = "1" ]; then
  echo " DRY-RUN 完成，未做任何修改 ✓"
  exit 0
fi

echo ""
echo "接下来执行："
echo "  git push origin $BRANCH"
echo "  git push origin $VERSION"
echo ""
echo "然后可在 GitHub 创建 Release："
echo "  https://github.com/torobucks/cdp-bridge-mcp-ohos/releases/new?tag=$VERSION"
echo ""

if [ "$DO_PUSH" = "1" ]; then
  echo "自动 push（--push）..."
  git push origin "$BRANCH"
  git push origin "$VERSION"
  echo ""
  echo "已推送 ✓"
fi