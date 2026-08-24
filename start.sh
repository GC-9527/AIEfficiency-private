#!/bin/bash
# AIEfficiency 一键启动脚本（Mac / Linux / Git Bash on Windows）
# 用法: bash start.sh [dev|prod]

set -e

MODE="${1:-dev}"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
GATEWAY_DIR="$ROOT_DIR/gateway"
WEB_DIR="$ROOT_DIR/web-dashboard"
APPMARKET_MCP_DIR="$ROOT_DIR/mcp-servers/devServer"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}[AIEfficiency]${NC} $1"; }
ok()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 Node.js
check_node() {
  if ! command -v node &>/dev/null; then
    err "Node.js 未安装。请安装 Node.js 22+: https://nodejs.org"
    exit 1
  fi
  local ver
  ver=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$ver" -lt 18 ]; then
    err "Node.js 版本过低 ($(node -v))，需要 18+"
    exit 1
  fi
  ok "Node.js $(node -v)"
}

# 检查并安装依赖
check_deps() {
  local dir="$1"
  local name="$2"
  shift 2
  local ready=1
  if [ ! -d "$dir/node_modules" ]; then
    ready=0
  fi
  for package_path in "$@"; do
    if [ ! -f "$dir/node_modules/$package_path" ]; then
      ready=0
    fi
  done
  if [ "$ready" -eq 0 ]; then
    log "安装 $name 依赖..."
    cd "$dir" && npm install
    ok "$name 依赖已安装"
  fi
}

# 终止占用端口的进程
kill_port() {
  local port="$1"
  local pid
  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "mingw"* || "$OSTYPE" == "cygwin" ]]; then
    # Windows (Git Bash)
    pid=$(netstat -ano 2>/dev/null | grep ":$port.*LISTEN" | head -1 | awk '{print $5}')
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      taskkill //PID "$pid" //F &>/dev/null || true
      log "已终止端口 $port 上的进程 (PID $pid)"
    fi
  else
    # Mac / Linux
    pid=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill -9 $pid 2>/dev/null || true
      log "已终止端口 $port 上的进程 (PID $pid)"
    fi
  fi
}

# 启动网关（等待就绪后再返回）
start_gateway() {
  kill_port 3001
  log "启动网关 (端口 3001)..."
  cd "$GATEWAY_DIR"
  if [ "$MODE" = "dev" ]; then
    node --watch server.js &
  else
    node server.js &
  fi
  GATEWAY_PID=$!

  # 等待网关就绪（最多 15 秒）
  local retries=0
  while [ $retries -lt 15 ]; do
    if curl -s http://localhost:3001/api/health 2>/dev/null | grep -q "status"; then
      ok "网关已启动 → http://localhost:3001 (PID $GATEWAY_PID)"
      return 0
    fi
    retries=$((retries + 1))
    sleep 1
  done
  warn "网关启动超时（15秒），继续启动 Web 面板..."
}

# 启动 Web 面板
start_web() {
  kill_port 3000
  if [ "$MODE" = "dev" ]; then
    log "启动 Web 面板 (开发模式, 端口 3000)..."
    cd "$WEB_DIR" && npx vite --host &
    WEB_PID=$!
    ok "Web 面板 → http://localhost:3000 (PID $WEB_PID)"
  else
    log "构建 Web 面板..."
    cd "$WEB_DIR" && npx vite build
    ok "Web 面板已构建到 dist/"
    log "如需预览: cd web-dashboard && npx vite preview"
  fi
}

# 打印系统信息
print_info() {
  echo ""
  echo -e "${CYAN}============================================${NC}"
  echo -e "${CYAN}  AIEfficiency — AAOS AI 提效工具${NC}"
  echo -e "${CYAN}============================================${NC}"
  echo ""
  echo -e "  平台:    $(uname -s) $(uname -m)"
  echo -e "  Node:    $(node -v)"
  echo -e "  模式:    $MODE"
  echo ""
  echo -e "  网关:    ${GREEN}http://localhost:3001${NC}"
  [ "$MODE" = "dev" ] && echo -e "  面板:    ${GREEN}http://localhost:3000${NC}"
  echo ""

  # 检查引擎
  for eng in claude gemini codex; do
    if command -v "$eng" &>/dev/null; then
      echo -e "  $eng:   ${GREEN}已安装${NC}"
    else
      echo -e "  $eng:   ${YELLOW}未安装${NC}"
    fi
  done

  echo ""
  echo -e "  按 ${YELLOW}Ctrl+C${NC} 停止所有服务"
  echo ""
}

# 信号处理：Ctrl+C 时清理
cleanup() {
  echo ""
  log "正在停止服务..."
  [ -n "$GATEWAY_PID" ] && kill $GATEWAY_PID 2>/dev/null
  [ -n "$WEB_PID" ] && kill $WEB_PID 2>/dev/null
  kill_port 3001
  kill_port 3000
  ok "已停止"
  exit 0
}
trap cleanup SIGINT SIGTERM

# === 主流程 ===
log "初始化..."
check_node
check_deps "$GATEWAY_DIR" "网关" "@modelcontextprotocol/sdk/package.json" "zod/package.json"
check_deps "$WEB_DIR" "Web面板"
check_deps "$APPMARKET_MCP_DIR" "应用市场只读 MCP" "@modelcontextprotocol/sdk/package.json" "zod/package.json"

start_gateway
start_web
print_info

# 保持前台运行
wait
