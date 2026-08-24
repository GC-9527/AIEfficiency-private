/**
 * 生成客户端一键安装 PowerShell 脚本（由 LAN 服务端 /setup.ps1 下发）。
 * 与 cloud/server.js 的安装脚本同源，额外：可把本机自动配成「客户端(node) + 已连下发的这台服务端」。
 * 注意：PowerShell 变量是 $name / $env:X / $($expr)，均不含 ${ ，故可安全用 JS 模板字符串插值。
 */
import { normalizeHttpOrigin } from "./m2m-auth.js";

export function generateSetupScript({ serverUrl, asClient = true, token = "", serverName = "" } = {}) {
  const centerOrigin = normalizeHttpOrigin(serverUrl);
  if (asClient && !centerOrigin) throw new Error("serverUrl 必须是纯 http(s) origin");
  const clientCfg = asClient
    ? JSON.stringify({
      role: "node",
      servers: {
        discoverySeeds: [centerOrigin],
        peers: [centerOrigin],
        selectedHost: centerOrigin,
      },
      claudeProxyClient: { enabled: true, host: centerOrigin, token: String(token || "") },
    }, null, 2)
    : null;

  const writeClientCfg = asClient ? `
# 自动配成「客户端 + 已连本服务端」（仅当本机尚无配置时写，避免覆盖既有设置）
$cfgPath = "$GATEWAY_DIR\\config.json"
if (-not (Test-Path $cfgPath)) {
    $clientCfg = @'
${clientCfg}
'@
    Set-Content -Path $cfgPath -Value $clientCfg -Encoding UTF8
    Write-Host "[OK] 已自动配置为客户端，连接服务端 ${serverName || serverUrl}" -ForegroundColor Green
} else {
    Write-Host "[!] 检测到已有配置，保留你现有设置（如需连本服务端：设置→运行模式→借用服务端）" -ForegroundColor Yellow
}
` : "";

  return `# AI 提效 - 客户端一键安装（由局域网服务端下发）
$ErrorActionPreference = "Stop"
$GATEWAY_DIR = "$HOME\\ai-gateway"
$SERVER_URL = "${serverUrl}"

Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  AI 提效 客户端 - 一键安装" -ForegroundColor Cyan
Write-Host "  服务端: ${serverName || serverUrl}" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan

# 1. 检测 / 安装 Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[..] 未检测到 Node.js，正在安装 LTS ..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "[X] Node.js 安装失败，请手动安装 https://nodejs.org/ 后重试" -ForegroundColor Red
        Read-Host "按回车退出"; exit 1
    }
}
$nodeVer = (node --version) -replace "^v",""
Write-Host "[OK] Node.js v$nodeVer" -ForegroundColor Green

# 2. 下载网关代码包并解压
Write-Host "[..] 下载网关代码包 ..." -ForegroundColor Yellow
$zipPath = "$env:TEMP\\ai-gateway-bundle.zip"
$tmpDir  = "$env:TEMP\\ai-gw-extract-" + [System.IO.Path]::GetRandomFileName()
Invoke-WebRequest -Uri "$SERVER_URL/download/gateway-bundle.zip" -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
New-Item -ItemType Directory -Force -Path $GATEWAY_DIR | Out-Null
if (Test-Path "$tmpDir\\gateway") { $srcDir = "$tmpDir\\gateway" } else { $srcDir = $tmpDir }
Copy-Item "$srcDir\\*" $GATEWAY_DIR -Recurse -Force
# skills / configs（与 gateway 同级）复制到网关上层目录
foreach ($sib in @("skills","configs")) {
    if (Test-Path "$tmpDir\\$sib") {
        $dest = Join-Path (Split-Path $GATEWAY_DIR) $sib
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item "$tmpDir\\$sib\\*" $dest -Recurse -Force
    }
}
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Write-Host "[OK] 网关代码已就绪" -ForegroundColor Green
${writeClientCfg}
# 3. 安装依赖
Write-Host "[..] 安装依赖 (npm install) ..." -ForegroundColor Yellow
Push-Location $GATEWAY_DIR
npm install --prefer-offline 2>&1 | ForEach-Object { if ($_ -match "added|warn|error") { Write-Host "    $_" -ForegroundColor DarkGray } }
node -e "require('better-sqlite3')" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[..] 重装原生依赖 better-sqlite3 ..." -ForegroundColor Yellow
    Remove-Item "$GATEWAY_DIR\\node_modules\\better-sqlite3" -Recurse -Force -ErrorAction SilentlyContinue
    npm install better-sqlite3 2>&1 | Out-Null
}
Pop-Location

# 4. 防火墙放行 3001（需管理员，失败可跳过）
try {
    Start-Process netsh -ArgumentList 'advfirewall firewall add rule name=AIEfficiency-Gateway dir=in action=allow protocol=tcp localport=3001 profile=private' -Verb RunAs -Wait -ErrorAction SilentlyContinue
    Write-Host "[OK] 防火墙已放行 3001" -ForegroundColor Green
} catch { Write-Host "[!] 防火墙未配置（非管理员），如需局域网互访请手动放行 3001" -ForegroundColor Yellow }

# 5. 注册开机自启（计划任务）
try {
    $nodePath = (Get-Command node).Source
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument "server.js" -WorkingDirectory $GATEWAY_DIR
    $trigger = New-ScheduledTaskTrigger -AtLogon
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Unregister-ScheduledTask -TaskName "AIEfficiency-Gateway" -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName "AIEfficiency-Gateway" -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -ErrorAction Stop | Out-Null
    Write-Host "[OK] 已注册开机自启" -ForegroundColor Green
} catch { Write-Host "[!] 开机自启需管理员权限，已跳过（不影响使用）" -ForegroundColor Yellow }

# 6. 启动网关（后台隐藏）
$nodePath = (Get-Command node).Source
Get-Process node -ErrorAction SilentlyContinue | Where-Object { try { ($_.MainModule.FileName -eq $nodePath) -and ($_.CommandLine -like "*server.js*") } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $nodePath -ArgumentList "server.js" -WorkingDirectory $GATEWAY_DIR -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 3
$ok = try { (Invoke-WebRequest -Uri "http://localhost:3001/api/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false }

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
if ($ok) { Write-Host "  [OK] 客户端网关已启动 (localhost:3001)" -ForegroundColor Green }
else { Write-Host "  [X] 启动未确认，手动运行排查: cd $GATEWAY_DIR; node server.js" -ForegroundColor Red }
Write-Host "  打开面板使用： $SERVER_URL" -ForegroundColor White
Write-Host "  (面板里若提示填网关地址，填 http://localhost:3001)" -ForegroundColor Gray
Write-Host "=====================================" -ForegroundColor Cyan
`;
}
