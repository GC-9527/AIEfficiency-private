#!/bin/bash
# 发布桌面版到云端（需先 npx electron-builder --win 构建）
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION=$(node -e "console.log(require('./package.json').version)")
EXE_PATH="dist/AI提效工具 Setup ${VERSION}.exe"
if [ ! -f "$EXE_PATH" ]; then
  echo "错误: $EXE_PATH 不存在，请先执行 npm run dist:win"
  exit 1
fi

echo "发布桌面版 v$VERSION"

docker cp "$EXE_PATH" ai-efficiency-cloud:/app/desktop-setup.exe
echo "$VERSION" > /tmp/desktop-version.txt
docker cp /tmp/desktop-version.txt ai-efficiency-cloud:/app/desktop-version.txt
docker commit ai-efficiency-cloud ai-efficiency-cloud:latest > /dev/null

echo "已同步到云端: v$VERSION"
curl -s http://192.168.10.156:8080/api/desktop-version
echo
