#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== 1. 构建前端 ==="
cd "$PROJECT_DIR/web-dashboard"
npm run build

echo "=== 2. 组装云端部署包 ==="
rm -rf "$SCRIPT_DIR/dist" "$SCRIPT_DIR/skills"
cp -r "$PROJECT_DIR/web-dashboard/dist" "$SCRIPT_DIR/dist"
cp -r "$PROJECT_DIR/skills" "$SCRIPT_DIR/skills"

echo "=== 3. 打包网关安装包 ==="
PACK_DIR="$SCRIPT_DIR/.pack"
rm -rf "$PACK_DIR"
mkdir -p "$PACK_DIR/gateway" "$PACK_DIR/skills"

# 复制 gateway 源码（不含 node_modules / data.db / config.json / .tmp）
for item in package.json package-lock.json server.js routes services db; do
  [ -e "$PROJECT_DIR/gateway/$item" ] && cp -r "$PROJECT_DIR/gateway/$item" "$PACK_DIR/gateway/"
done
rm -f "$PACK_DIR/gateway/db/data.db"*
rm -f "$PACK_DIR/gateway/config.json"

# 复制 skills
cp -r "$PROJECT_DIR/skills/"* "$PACK_DIR/skills/"

# 打包（Windows 环境用 PowerShell，Linux 用 zip）
rm -f "$SCRIPT_DIR/gateway-bundle.zip"
if command -v zip &>/dev/null; then
  cd "$PACK_DIR"
  zip -r "$SCRIPT_DIR/gateway-bundle.zip" gateway skills
else
  PACK_WIN="$(cygpath -w "$PACK_DIR" 2>/dev/null || echo "$PACK_DIR")"
  ZIP_WIN="$(cygpath -w "$SCRIPT_DIR/gateway-bundle.zip" 2>/dev/null || echo "$SCRIPT_DIR/gateway-bundle.zip")"
  powershell.exe -NoProfile -Command "Compress-Archive -Path '$PACK_WIN\\gateway','$PACK_WIN\\skills' -DestinationPath '$ZIP_WIN' -Force"
fi
rm -rf "$PACK_DIR"

echo "=== 4. Docker 构建 ==="
cd "$SCRIPT_DIR"
docker build -t ai-efficiency-cloud .

echo "=== 完成! ==="
echo "运行: docker run -p 3000:3000 ai-efficiency-cloud"
