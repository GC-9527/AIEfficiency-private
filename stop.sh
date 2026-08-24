#!/bin/bash
# AIEfficiency 停止脚本

echo "[AIEfficiency] 停止服务..."

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "mingw"* || "$OSTYPE" == "cygwin" ]]; then
  for port in 3001 3000; do
    pid=$(netstat -ano 2>/dev/null | grep ":$port.*LISTEN" | head -1 | awk '{print $5}')
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      taskkill //PID "$pid" //F &>/dev/null
      echo "[OK] 端口 $port 已停止 (PID $pid)"
    fi
  done
else
  for port in 3001 3000; do
    pid=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill -9 $pid 2>/dev/null
      echo "[OK] 端口 $port 已停止 (PID $pid)"
    fi
  done
fi

echo "[OK] 所有服务已停止"
