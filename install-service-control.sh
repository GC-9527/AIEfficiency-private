#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node "$ROOT/scripts/install-service-control.mjs" "$@"
