/**
 * 生成客户端一键安装 Bash 脚本（macOS / Linux），由 LAN 服务端 /setup.sh 下发。
 * 与 setup-script.js(Windows PowerShell) 对应：装 Node、下载 bundle、装依赖、
 * 可自动配成「客户端(node)+已连本服务端」、launchd 开机自启(mac)、启动。
 * 注意：bash 用 $var / $(...)，无 ${ 故可安全用 JS 模板字符串插值；脚本内无反引号。
 */
import { normalizeHttpOrigin } from "./m2m-auth.js";

export function generateSetupScriptSh({ serverUrl, asClient = true, token = "", serverName = "" } = {}) {
  const centerOrigin = normalizeHttpOrigin(serverUrl);
  if (asClient && !centerOrigin) throw new Error("serverUrl 必须是纯 http(s) origin");
  const clientCfg = JSON.stringify({
    role: "node",
    servers: {
      discoverySeeds: [centerOrigin],
      peers: [centerOrigin],
      selectedHost: centerOrigin,
    },
    claudeProxyClient: { enabled: true, host: centerOrigin, token: String(token || "") },
  }, null, 2);
  const writeClientCfg = asClient ? `
# 自动配成「客户端 + 已连本服务端」（仅当本机尚无配置时写，避免覆盖既有设置）
CFG="$GATEWAY_DIR/config.json"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" <<'CFGEOF'
${clientCfg}
CFGEOF
  echo "[OK] 已自动配置为客户端，连接服务端 ${serverName || serverUrl}"
else
  echo "[!] 已有配置，保留现有设置（如需连本服务端：设置→运行模式→借用服务端）"
fi
` : "";

  return `#!/usr/bin/env bash
# AI 提效 - 客户端一键安装（macOS / Linux，由局域网服务端下发）
set -e
GATEWAY_DIR="$HOME/ai-gateway"
SERVER_URL="${serverUrl}"
echo "====================================="
echo "  AI 提效 客户端 - 一键安装"
echo "  服务端: ${serverName || serverUrl}"
echo "====================================="

# 1. 检测 / 安装 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[..] 未检测到 Node.js"
  if command -v brew >/dev/null 2>&1; then
    echo "[..] 用 Homebrew 安装 Node ..."; brew install node
  else
    echo "[X] 请先安装 Node.js 20+ : https://nodejs.org/  (macOS 亦可: brew install node)"; exit 1
  fi
fi
echo "[OK] Node.js $(node -v)"

# 2. 下载并解压网关代码包
echo "[..] 下载网关代码包 ..."
ZIP="$(mktemp -t aigw).zip"
TMP="$(mktemp -d)"
curl -fsSL "$SERVER_URL/download/gateway-bundle.zip" -o "$ZIP"
unzip -q -o "$ZIP" -d "$TMP"
mkdir -p "$GATEWAY_DIR"
if [ -d "$TMP/gateway" ]; then SRC="$TMP/gateway"; else SRC="$TMP"; fi
cp -R "$SRC/." "$GATEWAY_DIR/"
PARENT="$(dirname "$GATEWAY_DIR")"
for sib in skills configs; do
  if [ -d "$TMP/$sib" ]; then mkdir -p "$PARENT/$sib"; cp -R "$TMP/$sib/." "$PARENT/$sib/"; fi
done
rm -rf "$TMP" "$ZIP"
echo "[OK] 网关代码已就绪"
${writeClientCfg}
# 3. 安装依赖（含为本平台编译 better-sqlite3）
echo "[..] 安装依赖 (npm install) ..."
cd "$GATEWAY_DIR"
npm install --prefer-offline >/dev/null 2>&1 || npm install
node -e "require('better-sqlite3')" 2>/dev/null || { echo "[..] 重装原生依赖 better-sqlite3 ..."; rm -rf node_modules/better-sqlite3; npm install better-sqlite3 >/dev/null 2>&1; }

# 4. 自启(mac launchd) + 启动
NODE_BIN="$(command -v node)"
pkill -f "$GATEWAY_DIR/server.js" 2>/dev/null || true
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.aiefficiency.gateway.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aiefficiency.gateway</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>server.js</string></array>
  <key>WorkingDirectory</key><string>$GATEWAY_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/ai-gateway.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-gateway.err</string>
</dict></plist>
PLISTEOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || true
  echo "[OK] 已注册开机自启 (launchd)"
else
  nohup "$NODE_BIN" server.js >/tmp/ai-gateway.log 2>&1 &
  echo "[!] 非 macOS：已后台启动（如需开机自启可自行配 systemd --user）"
fi

# 5. 健康检查（launchd 未及时拉起则兜底前台起一次）
sleep 3
if ! curl -fsS "http://localhost:3001/api/health" >/dev/null 2>&1; then
  nohup "$NODE_BIN" server.js >/tmp/ai-gateway.log 2>&1 &
  sleep 3
fi
echo ""
echo "====================================="
if curl -fsS "http://localhost:3001/api/health" >/dev/null 2>&1; then
  echo "  [OK] 客户端网关已启动 (localhost:3001)"
else
  echo "  [X] 启动未确认，手动排查: cd $GATEWAY_DIR && node server.js"
fi
echo "  打开面板使用: $SERVER_URL"
echo "  (面板里若提示填网关地址，填 http://localhost:3001)"
echo "====================================="
`;
}
