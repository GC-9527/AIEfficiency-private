import express from "express";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

function generateSetupScript(serverUrl) {
  // Use regular string concatenation to avoid JS template literal
  // interpreting PowerShell $variables as JS interpolation
  const script = [
    '# AI工作提效网关 - 智能安装/更新脚本',
    '$GATEWAY_DIR = "$HOME\\ai-gateway"',
    '$SERVER_URL = "' + serverUrl + '"',
    '',
    'Write-Host "=====================================" -ForegroundColor Cyan',
    'Write-Host "  AI 工作提效网关 - 智能安装" -ForegroundColor Cyan',
    'Write-Host "=====================================" -ForegroundColor Cyan',
    '',
    '# === 辅助函数 ===',
    'function Show-GatewayAddress {',
    '    Write-Host "`n=====================================" -ForegroundColor Cyan',
    '    Write-Host "  请在云端面板填入以下网关地址：" -ForegroundColor Cyan',
    '    Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.*" } | ForEach-Object {',
    '        Write-Host "  http://$($_.IPAddress):3001" -ForegroundColor White',
    '    }',
    '    Write-Host "`n  网关已在后台运行（隐藏窗口），开机自动启动" -ForegroundColor Gray',
    '    Write-Host "  停止: Unregister-ScheduledTask -TaskName AIEfficiency-Gateway" -ForegroundColor DarkGray',
    '    Write-Host "=====================================" -ForegroundColor Cyan',
    '}',
    '',
    'function Start-Gateway {',
    '    $nodePath = (Get-Command node).Source',
    '    Get-Process node -ErrorAction SilentlyContinue | Where-Object {',
    '        try { ($_.MainModule.FileName -eq $nodePath) -and ($_.CommandLine -like "*server.js*") } catch { $false }',
    '    } | Stop-Process -Force -ErrorAction SilentlyContinue',
    '    # 先前台试运行检测错误，再后台启动',
    '    Write-Host "[..] 正在启动网关..." -ForegroundColor Yellow',
    '    $logFile = "$env:TEMP\\gateway-start.log"',
    '    $proc = Start-Process -FilePath $nodePath -ArgumentList "server.js" -WorkingDirectory $GATEWAY_DIR -RedirectStandardError $logFile -RedirectStandardOutput "$env:TEMP\\gateway-stdout.log" -PassThru -WindowStyle Hidden',
    '    Start-Sleep -Seconds 3',
    '    $test = try { Invoke-WebRequest -Uri "http://localhost:3001/api/health" -UseBasicParsing -TimeoutSec 3 } catch { $null }',
    '    if ($test -and $test.StatusCode -eq 200) {',
    '        Write-Host "[OK] 网关已启动 (PID $($proc.Id))" -ForegroundColor Green',
    '    } else {',
    '        Write-Host "[X] 网关启动失败!" -ForegroundColor Red',
    '        if (Test-Path $logFile) {',
    '            $errLog = Get-Content $logFile -Raw',
    '            if ($errLog) { Write-Host $errLog -ForegroundColor Red }',
    '        }',
    '        if (Test-Path "$env:TEMP\\gateway-stdout.log") {',
    '            $outLog = Get-Content "$env:TEMP\\gateway-stdout.log" -Raw',
    '            if ($outLog) { Write-Host $outLog -ForegroundColor Gray }',
    '        }',
    '        # 常见修复尝试',
    '        Write-Host "`n[..] 尝试修复: npm install ..." -ForegroundColor Yellow',
    '        Push-Location $GATEWAY_DIR',
    '        npm install 2>&1 | Out-Null',
    '        Pop-Location',
    '        # 重试启动',
    '        $proc2 = Start-Process -FilePath $nodePath -ArgumentList "server.js" -WorkingDirectory $GATEWAY_DIR -WindowStyle Hidden -PassThru',
    '        Start-Sleep -Seconds 3',
    '        $test2 = try { Invoke-WebRequest -Uri "http://localhost:3001/api/health" -UseBasicParsing -TimeoutSec 3 } catch { $null }',
    '        if ($test2 -and $test2.StatusCode -eq 200) {',
    '            Write-Host "[OK] 修复成功，网关已启动" -ForegroundColor Green',
    '        } else {',
    '            Write-Host "[X] 修复失败。请手动运行查看错误:" -ForegroundColor Red',
    '            Write-Host "    cd $GATEWAY_DIR && node server.js" -ForegroundColor White',
    '        }',
    '    }',
    '}',
    '',
    'function Install-GatewayBundle {',
    '    Write-Host "`n[..] 下载网关代码包..." -ForegroundColor Yellow',
    '    # 备份数据库 + 用户配置',
    '    $dbBackup = "$env:TEMP\\gateway-db-backup"',
    '    New-Item -ItemType Directory -Force -Path $dbBackup | Out-Null',
    '    if (Test-Path "$GATEWAY_DIR\\db\\data.db") {',
    '        Copy-Item "$GATEWAY_DIR\\db\\data.db*" "$dbBackup\\" -Force -ErrorAction SilentlyContinue',
    '    }',
    '    if (Test-Path "$GATEWAY_DIR\\config.json") {',
    '        Copy-Item "$GATEWAY_DIR\\config.json" "$dbBackup\\config.json" -Force -ErrorAction SilentlyContinue',
    '    }',
    '    # 清理旧目录',
    '    if (Test-Path $GATEWAY_DIR) {',
    '        Remove-Item $GATEWAY_DIR -Recurse -Force -ErrorAction SilentlyContinue',
    '    }',
    '    New-Item -ItemType Directory -Force -Path $GATEWAY_DIR | Out-Null',
    '    # 下载解压',
    '    $zipPath = "$env:TEMP\\gateway-bundle.zip"',
    '    $tmpDir = "$env:TEMP\\gateway-extract-" + [System.IO.Path]::GetRandomFileName()',
    '    Invoke-WebRequest -Uri "$SERVER_URL/download/gateway-bundle.zip" -OutFile $zipPath',
    '    Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force',
    '    if (Test-Path "$tmpDir\\gateway") { $srcDir = "$tmpDir\\gateway" } else { $srcDir = $tmpDir }',
    '    Copy-Item "$srcDir\\*" $GATEWAY_DIR -Recurse -Force',
    '    # skills 目录',
    '    if (Test-Path "$tmpDir\\skills") {',
    '        $skillsDir = Join-Path (Split-Path $GATEWAY_DIR) "skills"',
    '        New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null',
    '        Copy-Item "$tmpDir\\skills\\*" $skillsDir -Recurse -Force',
    '    }',
    '    # 恢复数据库 + 用户配置',
    '    if (Test-Path "$dbBackup\\data.db") {',
    '        New-Item -ItemType Directory -Force -Path "$GATEWAY_DIR\\db" | Out-Null',
    '        Copy-Item "$dbBackup\\data.db*" "$GATEWAY_DIR\\db\\" -Force -ErrorAction SilentlyContinue',
    '    }',
    '    if (Test-Path "$dbBackup\\config.json") {',
    '        Copy-Item "$dbBackup\\config.json" "$GATEWAY_DIR\\config.json" -Force -ErrorAction SilentlyContinue',
    '    }',
    '    Remove-Item $dbBackup -Recurse -Force -ErrorAction SilentlyContinue',
    '    # 清理临时文件',
    '    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue',
    '    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue',
    '    # 安装依赖（自动下载适配当前 Node 版本的预编译二进制）',
    '    Write-Host "[..] 安装依赖 (npm install) ..." -ForegroundColor Yellow',
    '    Push-Location $GATEWAY_DIR',
    '    npm install --prefer-offline 2>&1 | ForEach-Object { if ($_ -match "added|warn|error") { Write-Host "    $_" -ForegroundColor DarkGray } }',
    '    Pop-Location',
    '    Write-Host "[OK] 网关代码已就绪" -ForegroundColor Green',
    '}',
    '',
    'function Test-NativeModules {',
    '    Push-Location $GATEWAY_DIR',
    '    node -e "require(\'better-sqlite3\')" 2>$null',
    '    if ($LASTEXITCODE -eq 0) {',
    '        Write-Host "[OK] 原生依赖兼容 Node.js v$nodeVer" -ForegroundColor Green',
    '        Pop-Location',
    '        return',
    '    }',
    '    Write-Host "[..] 原生依赖需要重新安装..." -ForegroundColor Yellow',
    '    Remove-Item "$GATEWAY_DIR\\node_modules\\better-sqlite3" -Recurse -Force -ErrorAction SilentlyContinue',
    '    npm install better-sqlite3 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }',
    '    node -e "require(\'better-sqlite3\')" 2>$null',
    '    if ($LASTEXITCODE -eq 0) {',
    '        Write-Host "[OK] 修复成功" -ForegroundColor Green',
    '    } else {',
    '        Write-Host "[X] better-sqlite3 安装失败。请尝试: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red',
    '        Pop-Location',
    '        Read-Host "按回车退出"',
    '        exit 1',
    '    }',
    '    Pop-Location',
    '}',
    '',
    'function Register-GatewayAutoStart {',
    '    $taskName = "AIEfficiency-Gateway"',
    '    $nodePath = (Get-Command node).Source',
    '    $action = New-ScheduledTaskAction -Execute $nodePath -Argument "server.js" -WorkingDirectory $GATEWAY_DIR',
    '    $trigger = New-ScheduledTaskTrigger -AtLogon',
    '    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)',
    '    try {',
    '        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue',
    '        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Description "AI工作提效网关 - 后台服务" -ErrorAction Stop | Out-Null',
    '        Write-Host "[OK] 已注册开机自启（计划任务: $taskName）" -ForegroundColor Green',
    '    } catch {',
    '        Write-Host "[!] 注册开机自启需要管理员权限，已跳过（不影响使用）" -ForegroundColor Yellow',
    '        Write-Host "    手动启动: cd $GATEWAY_DIR && node server.js" -ForegroundColor Gray',
    '        Write-Host "    如需开机自启: 以管理员身份运行 PowerShell 再执行此脚本" -ForegroundColor Gray',
    '    }',
    '}',
    '',
    'function Setup-Firewall {',
    '    try {',
    '        $rule = netsh advfirewall firewall show rule name="AIEfficiency-Gateway" 2>&1',
    '        if ($rule -like "*---*") {',
    '            Write-Host "[OK] 防火墙规则已存在" -ForegroundColor Green',
    '        } else {',
    '            Write-Host "[..] 配置防火墙..." -ForegroundColor Yellow',
    "            Start-Process netsh -ArgumentList 'advfirewall firewall add rule name=AIEfficiency-Gateway dir=in action=allow protocol=tcp localport=3001 profile=private' -Verb RunAs -Wait",
    '            Write-Host "[OK] 防火墙已放行 3001 端口" -ForegroundColor Green',
    '        }',
    '    } catch {',
    '        Write-Host "[!] 防火墙配置跳过（非管理员权限），请手动放行 3001 端口" -ForegroundColor Yellow',
    '    }',
    '}',
    '',
    '# === 1. 检测 Node.js ===',
    'if (-not (Get-Command node -ErrorAction SilentlyContinue)) {',
    '    Write-Host "`n[..] 未检测到 Node.js，正在安装 LTS 版本..." -ForegroundColor Yellow',
    '    winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements',
    '    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")',
    '    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {',
    '        Write-Host "[X] Node.js 安装失败，请手动安装 https://nodejs.org/" -ForegroundColor Red',
    '        Read-Host "按回车退出"',
    '        exit 1',
    '    }',
    '}',
    '$nodeVer = (node --version) -replace "^v",""',
    '$nodeMajor = [int]($nodeVer.Split(".")[0])',
    'Write-Host "[OK] Node.js v$nodeVer" -ForegroundColor Green',
    'if ($nodeMajor -gt 22) {',
    '    Write-Host "    [!] 预编译依赖基于 Node.js 22 构建，v$nodeVer 可能不兼容" -ForegroundColor Yellow',
    '    Write-Host "    [!] 如启动失败请安装 Node.js 22 LTS: https://nodejs.org/" -ForegroundColor Yellow',
    '}',
    '',
    '# === 2. 状态检测 ===',
    '$installed = Test-Path "$GATEWAY_DIR\\package.json"',
    '$running = $false',
    'try {',
    '    $resp = Invoke-WebRequest -Uri "http://localhost:3001/api/status" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop',
    '    if ($resp.StatusCode -eq 200) { $running = $true }',
    '} catch {}',
    '',
    'if ($installed) {',
    '    # 已安装 — 检测版本更新',
    '    $localVer = "unknown"',
    '    try {',
    '        $pkgJson = Get-Content "$GATEWAY_DIR\\package.json" -Encoding UTF8 -Raw | ConvertFrom-Json',
    '        $localVer = $pkgJson.version',
    '    } catch {',
    '        try { $localVer = ([regex]::Match((Get-Content "$GATEWAY_DIR\\package.json" -Raw), \'"version"\\s*:\\s*"([^"]+)"\').Groups[1].Value) } catch {}',
    '    }',
    '    Write-Host "[OK] 已安装网关 v$localVer" -ForegroundColor Green',
    '',
    '    $remoteVer = $null',
    '    try {',
    '        $verResp = Invoke-WebRequest -Uri "$SERVER_URL/api/gateway-version" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop',
    '        $remoteVer = ($verResp.Content | ConvertFrom-Json).version',
    '    } catch {',
    '        Write-Host "[!] 无法连接云端，跳过版本检测" -ForegroundColor Yellow',
    '    }',
    '',
    '    $needUpdate = $false',
    '    if ($remoteVer -and $remoteVer -ne $localVer) {',
    '        Write-Host "`n[!!] 发现新版本: v$localVer -> v$remoteVer" -ForegroundColor Magenta',
    '        $choice = Read-Host "是否更新? (Y/n)"',
    '        if ($choice -ne "n" -and $choice -ne "N") {',
    '            $needUpdate = $true',
    '        } else {',
    '            Write-Host "已跳过更新" -ForegroundColor Gray',
    '        }',
    '    } else {',
    '        if ($remoteVer) { Write-Host "[OK] 已是最新版本" -ForegroundColor Green }',
    '    }',
    '',
    '    if ($needUpdate) {',
    '        Write-Host "`n[..] 正在更新 v$localVer -> v$remoteVer ..." -ForegroundColor Yellow',
    '        # 停止旧进程',
    '        $nodePath = (Get-Command node).Source',
    '        Get-Process node -ErrorAction SilentlyContinue | Where-Object {',
    '            try { ($_.MainModule.FileName -eq $nodePath) -and ($_.CommandLine -like "*server.js*") } catch { $false }',
    '        } | Stop-Process -Force -ErrorAction SilentlyContinue',
    '        $running = $false',
    '        # 下载替换',
    '        Install-GatewayBundle',
    '        Test-NativeModules',
    '        Register-GatewayAutoStart',
    '        Start-Gateway',
    '        Show-GatewayAddress',
    '        exit 0',
    '    }',
    '',
    '    if ($running) {',
    '        Write-Host "`n[OK] 网关已在运行 (v$localVer)，无需重复启动" -ForegroundColor Green',
    '        Show-GatewayAddress',
    '        exit 0',
    '    }',
    '',
    '    # 已安装未运行 — 直接启动',
    '    Write-Host "`n[..] 网关未运行，正在启动..." -ForegroundColor Yellow',
    '    Test-NativeModules',
    '    Setup-Firewall',
    '    Start-Gateway',
    '    Show-GatewayAddress',
    '    exit 0',
    '}',
    '',
    '# === 3. 首次安装 — 全量流程 ===',
    'Write-Host "`n[..] 首次安装，开始全量部署..." -ForegroundColor Yellow',
    'Install-GatewayBundle',
    'Test-NativeModules',
    'Setup-Firewall',
    'Register-GatewayAutoStart',
    'Start-Gateway',
    'Show-GatewayAddress',
  ].join("\r\n");
  return script;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
// 从 gateway-bundle 中的 package.json 动态读取版本号
const GATEWAY_VERSION = (() => {
  try {
    // bundle 解压后 gateway/package.json 在 zip 内，直接读本地打包好的
    const pkgPath = join(__dirname, "gateway-bundle-version.txt");
    if (existsSync(pkgPath)) return readFileSync(pkgPath, "utf-8").trim();
    return "2.0.0";
  } catch { return "2.0.0"; }
})();

// 静态文件（前端构建产物）
app.use(express.static(join(__dirname, "dist")));

// Skills API（只读，构建时复制进来）
app.get("/api/skills", (req, res) => {
  const skillsDir = join(__dirname, "skills");
  if (!existsSync(skillsDir)) {
    return res.json({ success: true, data: [] });
  }

  try {
    const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
    const skills = files.map((f) => {
      const content = readFileSync(join(skillsDir, f), "utf-8");
      const name = f.replace(".md", "");
      const firstLine = content.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---")) || "";
      return { id: name, name, description: firstLine.trim(), content };
    });
    res.json({ success: true, data: skills });
  } catch {
    res.json({ success: true, data: [] });
  }
});

// 接收局域网用户推送的 Skill
app.use(express.json({ limit: "2mb" }));

app.post("/api/skills/upload", (req, res) => {
  const { id, raw, author } = req.body;
  if (!id || !raw) {
    return res.status(400).json({ success: false, error: "缺少 id 或 raw 内容" });
  }
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(id)) {
    return res.status(400).json({ success: false, error: "无效的 Skill ID" });
  }

  const skillsDir = join(__dirname, "skills");
  mkdirSync(skillsDir, { recursive: true });

  // 支持子目录
  const filePath = join(skillsDir, `${id}.md`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, raw, "utf-8");

  console.log(`[skills] 收到 Skill 推送: ${id}${author ? ` (来自 ${author})` : ""}`);
  res.json({ success: true, data: { id, message: `Skill ${id} 已同步到云端` } });
});

// 删除云端 Skill
app.delete("/api/skills/:id", (req, res) => {
  const id = req.params.id;
  const filePath = join(__dirname, "skills", `${id}.md`);
  if (!existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "Skill 不存在" });
  }
  unlinkSync(filePath);
  res.json({ success: true, data: { id, message: `已从云端删除 ${id}` } });
});

// 网关版本接口（供安装脚本检测更新）
app.get("/api/gateway-version", (req, res) => {
  res.json({ version: GATEWAY_VERSION });
});

// 动态生成 PowerShell 安装脚本
app.get("/setup.ps1", (req, res) => {
  const serverUrl = `${req.protocol}://${req.headers.host}`;
  const script = generateSetupScript(serverUrl);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(script);
});

// 提供网关包下载
app.get("/download/gateway-bundle.zip", (req, res) => {
  const zipPath = join(__dirname, "gateway-bundle.zip");
  if (existsSync(zipPath)) {
    res.download(zipPath, "gateway-bundle.zip");
  } else {
    res.status(404).json({ error: "安装包未找到" });
  }
});

// 桌面版（Electron）版本号
app.get("/api/desktop-version", (req, res) => {
  try {
    const versionFile = join(__dirname, "desktop-version.txt");
    if (existsSync(versionFile)) {
      return res.json({ version: readFileSync(versionFile, "utf-8").trim() });
    }
  } catch {}
  res.json({ version: "unknown" });
});

// 桌面版安装包下载
app.get("/download/desktop-setup.exe", (req, res) => {
  const exePath = join(__dirname, "desktop-setup.exe");
  if (existsSync(exePath)) {
    res.download(exePath, "AI提效工具-Setup.exe");
  } else {
    res.status(404).json({ error: "桌面版安装包未找到" });
  }
});

// 健康检查（标记为云端模式，前端据此判断是否需要配置网关）
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", mode: "cloud", timestamp: new Date().toISOString() });
});

// 共享配置（公用字段：TB appId/appSecret/orgId 等，不含个人信息）
app.get("/api/shared-config", (req, res) => {
  try {
    const sharedPath = join(__dirname, "shared-config.json");
    if (existsSync(sharedPath)) {
      const cfg = JSON.parse(readFileSync(sharedPath, "utf-8"));
      return res.json({ success: true, data: cfg });
    }
  } catch {}
  res.json({ success: true, data: {} });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`AI工作提效云端面板已启动 → http://localhost:${PORT}`);
});
