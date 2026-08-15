#!/usr/bin/env bash
set -euo pipefail

venv="${1:-.venv}"
repo="https://github.com/cactus-compute/needle.git"
commit="c152cc4d9821a002285f85aaf58876c6d60541fe"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

python3 -m venv "$venv"
git clone --filter=blob:none --no-checkout "$repo" "$tmp/needle"
git -C "$tmp/needle" checkout --detach "$commit"
"$venv/bin/pip" install "$tmp/needle"
"$venv/bin/needle" fetch
"$venv/bin/python" - <<'PY'
import importlib.metadata
print("distribution:", importlib.metadata.version("cactus-needle"))
PY

