#!/usr/bin/env bash
set -euo pipefail

# Publish cdp-bridge to PyPI
# Usage:
#   ./scripts/publish.sh              # interactive, will prompt for token
#   ./scripts/publish.sh --token xxx   # non-interactive with token
#   UV_PUBLISH_TOKEN=xxx ./scripts/publish.sh  # token via env var

echo "==> Cleaning old dist files..."
rm -rf ../dist/

cd ../
echo "==> Building source distribution and wheel..."
uv build

echo "==> Publishing to PyPI..."
uv publish dist/* "$@"

echo "==> Done. Published:"
ls -lh dist/
