#!/usr/bin/env bash
set -euo pipefail

# Publish cdp-bridge to PyPI
# Usage:
#   ./scripts/publish.sh 0.2.0              # set version, build & publish
#   ./scripts/publish.sh 0.2.0 --token xxx  # with token
#   UV_PUBLISH_TOKEN=xxx ./scripts/publish.sh 0.2.0  # token via env var

VERSION="${1:?Usage: ./scripts/publish.sh <version> [--token xxx]}"
shift

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Setting version to $VERSION ..."
cd "$REPO_DIR"
uv run python scripts/sync-version.py --publish-version "$VERSION"

echo "==> Cleaning old dist files..."
rm -rf dist/

echo "==> Building source distribution and wheel..."
uv build

echo "==> Committing version bump..."
git add pyproject.toml src/cdp_bridge/tmwd_cdp_bridge/manifest.json
git commit -m "chore: bump version to $VERSION"

echo "==> Tagging $VERSION..."
git tag "v$VERSION"

echo "==> Publishing to PyPI..."
uv publish dist/* "$@"

echo "==> Done. Published v$VERSION:"
ls -lh dist/
echo ""
echo "Run:  git push origin main --tags"
