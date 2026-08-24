#!/bin/bash
# 把 ../gateway 的源码同步到 desktop/gateway-bundled/
# 用法：在 desktop/ 目录下执行 `bash sync-gateway.sh`
# 每次改完 gateway 代码、重新打 desktop 安装包之前先跑这个。
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/../gateway"
DEST="$SCRIPT_DIR/gateway-bundled"

if [ ! -d "$SRC" ]; then
  echo "错误：找不到源 $SRC"
  exit 1
fi
if [ ! -d "$DEST" ]; then
  echo "错误：找不到目标 $DEST（首次需手动 npm install 一次依赖）"
  exit 1
fi

echo "同步 gateway → gateway-bundled..."

# 用 rsync 排除掉运行期/敏感文件
# - node_modules：bundled 自带预装的
# - db/data.db*：用户运行时数据
# - .tmp / knowledge：dev 期产物
# - config.json：本机敏感配置
RSYNC_AVAILABLE=$(command -v rsync || true)

if [ -n "$RSYNC_AVAILABLE" ]; then
  rsync -a --delete \
    --exclude 'node_modules' \
    --exclude '.tmp' \
    --exclude 'knowledge' \
    --exclude 'scripts' \
    --exclude 'db/data.db' \
    --exclude 'db/data.db-shm' \
    --exclude 'db/data.db-wal' \
    --exclude 'config.json' \
    --filter='P node_modules' \
    --filter='P db/data.db*' \
    --filter='P config.json' \
    "$SRC/" "$DEST/"
else
  # Fallback：用 find + cp（不删除目标多余文件）
  cd "$SRC"
  find . \
    -path './node_modules' -prune -o \
    -path './.tmp' -prune -o \
    -path './knowledge' -prune -o \
    -path './scripts' -prune -o \
    -name 'data.db*' -prune -o \
    -name 'config.json' -prune -o \
    -type f -print | while read -r f; do
      mkdir -p "$DEST/$(dirname "$f")"
      cp "$f" "$DEST/$f"
  done
fi

echo "同步完成。"
echo
echo "差异检查："
diff -rq "$SRC" "$DEST" 2>/dev/null | grep -v 'node_modules' | grep -v 'data.db' | grep -v 'config.json' | grep -vE '\.tmp|knowledge|scripts' || echo "  （无差异）"

echo
echo "下一步："
echo "  1. cd $SCRIPT_DIR"
echo "  2. npx electron-builder --win  # 重新打包"
