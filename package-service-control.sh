#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT/service-control-electron"

if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi

case "$(uname -s)" in
  Darwin) npm run dist:mac ;;
  Linux) npm run dist:linux ;;
  *) npm run dist ;;
esac
