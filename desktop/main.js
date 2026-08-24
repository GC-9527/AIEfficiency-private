const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require("electron");
const { spawn, exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const { normalizeExternalUrl } = require("./external-url.js");
const {
  normalizeDeploymentRole,
  resolveConnectionDeploymentRole,
  applyDeploymentRoleToGatewayConfig,
  applyClientToStandaloneConfig,
} = require("./deployment-role.js");
const {
  verifyBetterSqliteRuntimeSync,
} = require("./gateway-runtime.cjs");
const {
  ensureCompatibleGatewayDependencies,
} = require("./gateway-dependency-manager.cjs");

// 获取内置 portable Node.js 路径
function getPortableNodePath() {
  const rt = isDev
    ? path.resolve(path.join(__dirname, "node-runtime"))
    : path.join(process.resourcesPath, "node-runtime");
  const nodeExe = path.join(rt, process.platform === "win32" ? "node.exe" : "bin/node");
  if (fs.existsSync(nodeExe)) return nodeExe;
  return null;
}

// 查找系统 Node.js（仅 fallback 使用，优先用内置）
function findNodePath() {
  // 优先使用内置 portable Node
  const portable = getPortableNodePath();
  if (portable) return portable;

  const candidates = [
    "node", // PATH 中直接找
    // Windows 常见安装路径
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    // nvm-windows
    path.join(process.env.APPDATA || "", "nvm", "current", "node.exe"),
    path.join(process.env.NVM_HOME || "", "current", "node.exe"),
    // fnm
    path.join(process.env.LOCALAPPDATA || "", "fnm_multishells", "node.exe"),
    // macOS / Linux
    "/opt/homebrew/bin/node", // Apple Silicon (brew)
    "/usr/local/bin/node",    // Intel mac (brew) / Linux
    "/usr/bin/node",
    path.join(process.env.HOME || "", ".nvm", "current", "bin", "node"),
    path.join(process.env.HOME || "", ".volta", "bin", "node"),
  ];

  for (const candidate of candidates) {
    try {
      if (candidate === "node") {
        // 先试 PATH
        const { execSync } = require("child_process");
        execSync("node -v", { stdio: "pipe", timeout: 3000 });
        return "node";
      }
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }

  // Windows: 从注册表查
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const regResult = execSync('reg query "HKLM\\SOFTWARE\\Node.js" /v InstallPath', { stdio: "pipe", timeout: 3000 }).toString();
      const match = regResult.match(/InstallPath\s+REG_SZ\s+(.+)/);
      if (match) {
        const p = path.join(match[1].trim(), "node.exe");
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }

  return null;
}

let nodePath = null;

function getNodeDir() {
  if (nodePath && nodePath !== "node") return path.dirname(nodePath);
  // nodePath 是 "node"（从 PATH 找到的），需要解析完整路径
  try {
    const { execSync: es } = require("child_process");
    const cmd = process.platform === "win32" ? "where node" : "which node";
    const fullPath = es(cmd, { stdio: "pipe", timeout: 5000 }).toString().trim().split("\n")[0].trim();
    return path.dirname(fullPath);
  } catch {}
  // fallback: 常见路径
  const common = "C:\\Program Files\\nodejs";
  if (fs.existsSync(path.join(common, "npm.cmd"))) return common;
  return ".";
}
const path = require("path");
const fs = require("fs");
const net = require("net");

// 防止多实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

const isDev = process.argv.includes("--dev");
const GATEWAY_PORT = 3001;
const DEFAULT_CLOUD_URL = "http://192.168.10.156:8080";

// 用户数据目录（可写）
const USER_DATA = app.getPath("userData");
const CONFIG_FILE = path.join(USER_DATA, "connection.json");
// 网关运行目录：放在用户数据目录下（避免 Program Files 权限问题）
const USER_GATEWAY_DIR = path.join(USER_DATA, "gateway");
const BUNDLED_FEATURE_RESOURCES = Object.freeze([
  Object.freeze({
    label: "飞书同步 feature 源码",
    relativePath: path.join("features", "FeiShuProjects", "src"),
  }),
  Object.freeze({
    label: "性能测试任务库",
    relativePath: path.join("features", "PerformanceFeature", "performance-test-scripts", "tasks"),
  }),
]);

let mainWindow = null;
let splashWindow = null;
let gatewayProcess = null;
let tray = null;
let connectionConfig = loadConfig();

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  return { mode: null, cloudUrl: DEFAULT_CLOUD_URL };
}

function saveConfig(cfg) {
  connectionConfig = cfg;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function gatewayConfigPath() {
  return path.join(USER_GATEWAY_DIR, "config.json");
}

function readGatewayConfig() {
  try {
    const cfgPath = gatewayConfigPath();
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch {}
  return {};
}

function writeGatewayConfig(cfg) {
  const cfgPath = gatewayConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// 首次选择页的“本机用途（部署角色）”与设置页使用同一组值：
// standalone=全功能，server=仅服务端，node=仅客户端。
function applyRoleToGatewayConfig() {
  const selected = resolveConnectionDeploymentRole(connectionConfig);
  if (!selected.role || connectionConfig.roleApplied) return;
  let cfg = readGatewayConfig();
  cfg = applyDeploymentRoleToGatewayConfig(cfg, selected.role, {
    // 旧版“服务端”选项实际代表全功能并共享本机 Claude，迁移时保持原行为。
    enableStandaloneProxy: selected.legacy && connectionConfig.role === "server",
  });
  try {
    writeGatewayConfig(cfg);
    const currentConnection = { ...connectionConfig };
    delete currentConnection.role;
    connectionConfig = {
      ...currentConnection,
      deploymentRole: selected.role,
      roleApplied: true,
    };
    saveConfig(connectionConfig);
    console.log(`[gateway] 已应用部署角色: ${selected.role}, claudeProxy.enabled=${cfg.claudeProxy.enabled}`);
  } catch (e) { console.error("[gateway] 写入角色失败:", e.message); }
}

// 资源路径（安装包内只读）
function resPath(sub) {
  if (isDev) return path.resolve(path.join(__dirname, "..", sub));
  return path.join(process.resourcesPath, sub);
}

// ========== 网关初始化（复制到用户目录 + npm install） ==========

async function ensureGateway() {
  const srcDir = resPath("gateway");
  const srcServerJs = path.join(srcDir, "server.js");

  if (!fs.existsSync(srcServerJs)) {
    dialog.showErrorBox("启动失败", `网关源文件不存在: ${srcServerJs}`);
    return false;
  }

  // 使用内置 portable Node.js（优先），不依赖用户系统环境
  nodePath = findNodePath();
  if (!nodePath) {
    const msg = process.platform === "darwin"
      ? "未找到 Node.js。请先安装 Node.js 20+：终端执行 `brew install node`（或到 https://nodejs.org 下载），再重启本应用。"
      : "未找到 Node.js 运行时（内置与系统均未找到）。请重装本应用，或安装 Node.js 20+。";
    dialog.showErrorBox("缺少 Node.js", msg);
    return false;
  }
  try {
    const { stdout } = await execAsync(`"${nodePath}" -v`, { timeout: 5000 });
    const isPortable = nodePath.includes("node-runtime");
    console.log(`[gateway] Node.js: ${stdout.trim()} (${isPortable ? "内置" : "系统"}: ${nodePath})`);
  } catch (err) {
    dialog.showErrorBox("Node.js 异常", `路径: ${nodePath}\n错误: ${err.message}`);
    return false;
  }

  // 同步源码到用户目录（跳过 node_modules 和 db 数据文件）
  const serverInUser = path.join(USER_GATEWAY_DIR, "server.js");
  const needCopy = !fs.existsSync(serverInUser);
  let needUpdate = false;

  if (!needCopy) {
    try {
      const srcPkg = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf-8"));
      const userPkg = JSON.parse(fs.readFileSync(path.join(USER_GATEWAY_DIR, "package.json"), "utf-8"));
      if (srcPkg.version !== userPkg.version) needUpdate = true;
    } catch {}
  }

  if (needCopy || needUpdate) {
    console.log(`[gateway] ${needCopy ? "首次运行" : "版本更新"}，复制文件...`);
    updateSplash(needCopy ? "正在初始化..." : "正在更新...");
    copyGatewaySource(srcDir, USER_GATEWAY_DIR);
    // 同步 skills 和 configs 到网关上层目录（代码中用 ../../skills 引用）
    const userRoot = path.join(USER_GATEWAY_DIR, "..");
    const skillsSrc = resPath("skills");
    const configsSrc = resPath("configs");
    const skillsDest = path.join(userRoot, "skills");
    const configsDest = path.join(userRoot, "configs");
    if (fs.existsSync(skillsSrc)) {
      copyGatewaySource(skillsSrc, skillsDest);
      console.log("[gateway] skills 已同步");
    }
    if (fs.existsSync(configsSrc)) {
      copyGatewaySource(configsSrc, configsDest);
      console.log("[gateway] configs 已同步");
    }
  } else {
    // 版本号相同也始终同步网关【代码】（routes/services/server.js 等，跳过 node_modules）。
    // 否则只要发版时忘了升 package.json 版本号，新增路由/修复就到不了已初始化的 AppData，
    // 导致"点开始AI甄别报 HTTP 404"这类陈旧副本问题。代码是纯文本、量小、耗时可忽略；
    // copyGatewaySource 会保留 data.db*，且打包网关不含 config.json，用户数据不受影响。
    try {
      copyGatewaySource(srcDir, USER_GATEWAY_DIR, { skipNodeModules: true });
      console.log("[gateway] 已同步最新网关代码（保留依赖与用户数据）");
    } catch (e) {
      console.error("[gateway] 同步网关代码失败（沿用现有副本）:", e.message);
    }
  }

  // 确保 skills/configs 目录存在（即使不是首次启动）
  const userRoot = path.join(USER_GATEWAY_DIR, "..");
  // Gateway 中有模块按 gateway 同级 features 目录解析运行资源。发布包与用户运行目录
  // 必须保持相同相对结构，并在每次启动时同步，避免 AppData 中的旧副本遗漏新增资源。
  for (const resource of BUNDLED_FEATURE_RESOURCES) {
    const source = resPath(resource.relativePath);
    const destination = path.join(userRoot, resource.relativePath);
    if (!fs.existsSync(source)) {
      const message = `${resource.label}不存在: ${source}`;
      console.error(`[gateway] ${message}`);
      dialog.showErrorBox("安装资源不完整", `${message}\n请重新安装桌面版。`);
      return false;
    }
    try {
      copyGatewaySource(source, destination, { skipNodeModules: true });
      console.log(`[gateway] ${resource.label}已同步`);
    } catch (error) {
      const message = `${resource.label}同步失败: ${error.message}`;
      console.error(`[gateway] ${message}`);
      dialog.showErrorBox("安装资源同步失败", message);
      return false;
    }
  }
  if (!fs.existsSync(path.join(userRoot, "skills"))) {
    const skillsSrc = resPath("skills");
    if (fs.existsSync(skillsSrc)) copyGatewaySource(skillsSrc, path.join(userRoot, "skills"));
  }
  if (!fs.existsSync(path.join(userRoot, "configs"))) {
    const configsSrc = resPath("configs");
    if (fs.existsSync(configsSrc)) copyGatewaySource(configsSrc, path.join(userRoot, "configs"));
  }

  try {
    await ensureCompatibleGatewayDependencies({
      bundledGatewayDirectory: resPath("gateway"),
      copyDirectory: copyGatewaySource,
      nodeExecutable: nodePath,
      onRepair: (error) => {
        console.error(
          `[gateway] better-sqlite3 原生运行时不兼容，`
          + `尝试从资源目录重新复制 node_modules: ${error.message}`,
        );
        updateSplash("正在修复依赖...");
      },
      userGatewayDirectory: USER_GATEWAY_DIR,
    });
  } catch (error) {
    dialog.showErrorBox(
      "依赖加载失败",
      (error.stderr || error.message || "").slice(-500),
    );
    return false;
  }

  return true;
}

function copyGatewaySource(src, dest, opts = {}) {
  const { skipNodeModules = false } = opts;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    // 数据文件保留（不覆盖用户数据）
    if (entry.name === "data.db" || entry.name === "data.db-shm" || entry.name === "data.db-wal") continue;
    // 可选跳过 node_modules（版本更新时保留已有的）
    if (skipNodeModules && entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      copyGatewaySource(srcPath, destPath, opts);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function updateSplash(msg) {
  if (splashWindow) {
    splashWindow.webContents.executeJavaScript(
      `document.querySelector('.sub')&&(document.querySelector('.sub').textContent='${msg.replace(/'/g, "\\'")}')`
    ).catch(() => {});
  }
}

// ========== 模式选择窗口 ==========

function showModeSelector() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 500, height: 496,
      frame: false, resizable: false, center: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        nodeIntegration: false, contextIsolation: true,
      },
    });
    win.loadFile(path.join(__dirname, "mode-select.html"));
    ipcMain.once("mode-selected", (e, data) => {
      saveConfig(data);
      win.close();
      resolve(data);
    });
    win.on("closed", () => {
      if (!connectionConfig.mode) { app.quit(); resolve(null); }
    });
  });
}

// ========== 启动画面 ==========

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 400, height: 260,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.center();
}

// ========== 主窗口 ==========

function createMainWindow() {
  // 中文菜单
  const menuTemplate = [
    {
      label: "应用",
      submenu: [
        { label: "检查更新", click: () => mainWindow?.webContents.send("trigger-update-check") },
        { type: "separator" },
        { label: "重新加载", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.webContents.reload() },
        { label: "开发者工具", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
        { type: "separator" },
        { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => { app.isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", accelerator: "CmdOrCtrl+Z", role: "undo" },
        { label: "重做", accelerator: "CmdOrCtrl+Shift+Z", role: "redo" },
        { type: "separator" },
        { label: "剪切", accelerator: "CmdOrCtrl+X", role: "cut" },
        { label: "复制", accelerator: "CmdOrCtrl+C", role: "copy" },
        { label: "粘贴", accelerator: "CmdOrCtrl+V", role: "paste" },
        { label: "全选", accelerator: "CmdOrCtrl+A", role: "selectAll" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { label: "最小化", accelerator: "CmdOrCtrl+M", role: "minimize" },
        { label: "关闭", accelerator: "CmdOrCtrl+W", click: () => mainWindow?.hide() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  mainWindow = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 900, minHeight: 600,
    show: false,
    title: "AI 工作提效",
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, // 允许 preload 注入到远程页面
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:3000");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else if (connectionConfig.mode === "team") {
    const cloudUrl = connectionConfig.cloudUrl || DEFAULT_CLOUD_URL;
    const localGw = `http://localhost:${GATEWAY_PORT}`;
    mainWindow.loadURL(`${cloudUrl}?gateway=${encodeURIComponent(localGw)}`);
  } else {
    const webDist = resPath("web-dist");
    const indexHtml = path.join(webDist, "index.html");
    if (fs.existsSync(indexHtml)) {
      mainWindow.loadFile(indexHtml);
    } else {
      mainWindow.loadURL(`http://localhost:${GATEWAY_PORT}`);
    }
  }

  mainWindow.once("ready-to-show", () => {
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 外链协议白名单：只放行规范 http/https（normalizeExternalUrl 统一校验），
    // 其余协议（mailto/file:/自定义协议/无 hostname 的伪 URL）一律不打开，
    // 避免误唤起本机邮箱/文件/其它应用（用户反馈的“一直打开邮箱”即 mailto 被直接 shell.openExternal）。
    const safe = normalizeExternalUrl(url);
    if (safe) shell.openExternal(safe);
    return { action: "deny" };
  });

  // 顶层导航兜底：mailto 等外部协议若以 <a target=_self>/location.href 形式触发导航，
  // 不经过 setWindowOpenHandler（无 will-navigate 时 Chromium 会把外部协议直接交给系统打开）。
  // 主窗口为 HashRouter 路由 + 初始 loadURL，正常业务不受影响；非 http/https 一律拦截。
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!normalizeExternalUrl(url)) event.preventDefault();
  });

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ========== 网关进程 ==========

async function startGateway() {
  const serverJs = path.join(USER_GATEWAY_DIR, "server.js");
  let stderrLog = "";
  let exited = false;

  return new Promise((resolve) => {
    const nodeExe = nodePath || "node";
    gatewayProcess = spawn(nodeExe, [serverJs], {
      cwd: USER_GATEWAY_DIR,
      env: { ...process.env, PORT: String(GATEWAY_PORT), ELECTRON: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    gatewayProcess.stdout.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) console.log("[gateway]", msg);
    });

    gatewayProcess.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) { console.error("[gateway:err]", msg); stderrLog += msg + "\n"; }
    });

    gatewayProcess.on("exit", (code) => {
      console.log("[gateway] exited:", code);
      exited = true;
      gatewayProcess = null;
    });

    const check = setInterval(() => {
      if (exited) {
        clearInterval(check);
        dialog.showErrorBox("网关启动失败", stderrLog.slice(-600) || "进程异常退出");
        resolve(false);
        return;
      }
      const req = net.createConnection({ port: GATEWAY_PORT }, () => {
        req.end();
        clearInterval(check);
        resolve(true);
      });
      req.on("error", () => {});
    }, 500);

    // 超时 60 秒（首次启动飞书/TB 连接较慢），超时不阻断，改为警告继续
    setTimeout(() => {
      clearInterval(check);
      if (!exited) {
        console.warn("[gateway] 启动超过 60 秒，继续等待...");
        // 不弹错误框，继续轮询
        const retryCheck = setInterval(() => {
          if (exited) { clearInterval(retryCheck); resolve(false); return; }
          const req = net.createConnection({ port: GATEWAY_PORT }, () => {
            req.end();
            clearInterval(retryCheck);
            resolve(true);
          });
          req.on("error", () => {});
        }, 2000);
        // 最终超时 180 秒
        setTimeout(() => { clearInterval(retryCheck); resolve(true); }, 120000);
      } else {
        resolve(false);
      }
    }, 60000);
  });
}

function stopGateway() {
  if (gatewayProcess) { gatewayProcess.kill(); gatewayProcess = null; }
}

function stopGatewayAndWait(timeoutMs = 5000) {
  const processToStop = gatewayProcess;
  if (!processToStop || processToStop.exitCode !== null) {
    stopGateway();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn(`[gateway] 等待退出超过 ${timeoutMs}ms，继续重启 Desktop`);
      finish();
    }, timeoutMs);
    processToStop.once("exit", finish);
    stopGateway();
  });
}

// ========== 托盘 ==========

function setupTray() {
  try {
    const { initTray } = require("./tray.js");
    tray = initTray(mainWindow, app);
  } catch (err) { console.warn("托盘初始化失败:", err.message); }
}

// ========== IPC ==========

// CarDev 模块原生能力（文件对话框 / show-in-folder 等），独立模块
require("./cardev-ipc.js").register();

ipcMain.handle("get-connection-config", () => connectionConfig);
ipcMain.handle("switch-mode", async (e, newConfig) => {
  saveConfig(newConfig);
  await stopGatewayAndWait();
  app.relaunch();
  app.exit(0);
});
ipcMain.handle("restart-for-deployment-role", async (e, requestedRole) => {
  const deploymentRole = normalizeDeploymentRole(requestedRole);
  if (!deploymentRole) return { success: false, error: "不支持的部署角色" };
  const currentConnection = { ...connectionConfig };
  delete currentConnection.role;
  saveConfig({
    ...currentConnection,
    deploymentRole,
    roleApplied: true,
  });
  await stopGatewayAndWait();
  app.relaunch();
  app.exit(0);
  return { success: true };
});
ipcMain.handle("switch-client-to-standalone", () => {
  try {
    const environmentRoleValue = String(process.env.ROLE || "").trim();
    const environmentRole = normalizeDeploymentRole(process.env.ROLE);
    if (environmentRoleValue && environmentRole !== "standalone") {
      return { success: false, error: `环境变量 ROLE=${environmentRoleValue} 正在覆盖设置，请先移除该环境变量` };
    }

    const nextConfig = applyClientToStandaloneConfig(readGatewayConfig());
    writeGatewayConfig(nextConfig);
    const currentConnection = { ...connectionConfig };
    delete currentConnection.role;
    saveConfig({
      ...currentConnection,
      deploymentRole: "standalone",
      roleApplied: true,
    });
    console.log("[gateway] 非管理员本机切换: node → standalone，准备重启 Desktop");

    // 先把成功结果返回给 renderer，再等待旧 Gateway 释放 3001 端口并 relaunch。
    setTimeout(async () => {
      await stopGatewayAndWait();
      app.relaunch();
      app.exit(0);
    }, 50);
    return { success: true, role: "standalone" };
  } catch (error) {
    console.error("[gateway] 非管理员本机切换失败:", error.message);
    return { success: false, error: error.message };
  }
});

// 获取本地网关版本
ipcMain.handle("get-local-version", () => {
  try {
    const pkgPath = path.join(USER_GATEWAY_DIR, "package.json");
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || "unknown";
    }
    // fallback: 安装包内的版本
    const resPkg = path.join(resPath("gateway"), "package.json");
    if (fs.existsSync(resPkg)) {
      return JSON.parse(fs.readFileSync(resPkg, "utf-8")).version || "unknown";
    }
  } catch {}
  return "unknown";
});

// 语义化版本比较：remote 是否「严格新于」local（按 . 分段比数字）。
// 只在云端确实更新时才提示，避免云端落后(更旧)时误报"发现新版本"导致降级 + 死循环。
function isNewerVersion(remote, local) {
  if (!remote || !local || remote === "unknown" || local === "unknown") return false;
  if (remote === local) return false;
  const pa = String(remote).split(".").map((n) => parseInt(n, 10));
  const pb = String(local).split(".").map((n) => parseInt(n, 10));
  // 含非数字段无法可靠比较 → 回退为「不同即更新」（保守，避免漏更新）
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return remote !== local;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const a = pa[i] || 0, b = pb[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

// 检查更新（对比云端版本）
ipcMain.handle("check-update", async () => {
  const cloudUrl = connectionConfig.cloudUrl || DEFAULT_CLOUD_URL;
  try {
    let localVersion = "unknown";
    try {
      const pkgPath = path.join(USER_GATEWAY_DIR, "package.json");
      if (fs.existsSync(pkgPath)) {
        localVersion = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || "unknown";
      }
    } catch {}

    const resp = await fetch(`${cloudUrl}/api/gateway-version`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const remoteVersion = data.version || "unknown";
    const hasUpdate = isNewerVersion(remoteVersion, localVersion);
    console.log(`[check-update] 网关: 本地=${localVersion} 云端=${remoteVersion} hasUpdate=${hasUpdate}`);
    return { localVersion, remoteVersion, hasUpdate };
  } catch (err) {
    console.error("[check-update] 失败:", err.message);
    return { error: err.message };
  }
});

// 一键更新并重启
ipcMain.handle("do-update", async () => {
  const cloudUrl = connectionConfig.cloudUrl || DEFAULT_CLOUD_URL;
  try {
    // 1. 下载 gateway-bundle.zip
    const resp = await fetch(`${cloudUrl}/download/gateway-bundle.zip`);
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const zipPath = path.join(USER_DATA, "gateway-update.zip");
    fs.writeFileSync(zipPath, buffer);
    console.log("[update] 下载完成:", buffer.length, "bytes");

    // 2. 解压覆盖（保留 node_modules 和 db）
    const extractDir = path.join(USER_DATA, "gateway-update-tmp");
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });

    const { execSync: execSyncLocal } = require("child_process");
    if (process.platform === "win32") {
      execSyncLocal(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { timeout: 30000 });
    } else {
      execSyncLocal(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 30000 });
    }

    // 3. 复制源码文件到 USER_GATEWAY_DIR（不覆盖 node_modules 和 db 数据）
    const srcDir = path.join(extractDir, "gateway");
    if (fs.existsSync(srcDir)) {
      copyGatewaySource(srcDir, USER_GATEWAY_DIR);
      console.log("[update] 源码已覆盖");
    }

    // 4. 清理
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);

    // 5. 实际打开数据库，检查原生模块 ABI 是否需要 rebuild
    try {
      const nodeExe = nodePath || "node";
      verifyBetterSqliteRuntimeSync(nodeExe, USER_GATEWAY_DIR);
    } catch (nativeError) {
      console.log(`[update] better-sqlite3 原生运行时不兼容，需要 rebuild: ${nativeError.message}`);
      const nd = getNodeDir();
      const npm = process.platform === "win32" ? `"${path.join(nd, "npm.cmd")}"` : "npm";
      execSyncLocal(`${npm} rebuild better-sqlite3`, { cwd: USER_GATEWAY_DIR, timeout: 120000, env: { ...process.env, PATH: `${nd}${path.delimiter}${process.env.PATH}` } });
      verifyBetterSqliteRuntimeSync(nodePath || "node", USER_GATEWAY_DIR);
    }

    console.log("[update] 更新完成，准备重启");
    return { success: true };
  } catch (err) {
    console.error("[update] 失败:", err.message);
    return { success: false, error: err.message };
  }
});

// 重启应用
ipcMain.handle("restart-app", async () => {
  await stopGatewayAndWait();
  app.relaunch();
  app.exit(0);
});

// 获取桌面版本号（app.getVersion）
ipcMain.handle("get-desktop-version", () => {
  return app.getVersion();
});

// 检查桌面版更新
ipcMain.handle("check-desktop-update", async () => {
  const cloudUrl = connectionConfig.cloudUrl || DEFAULT_CLOUD_URL;
  try {
    const resp = await fetch(`${cloudUrl}/api/desktop-version`);
    const data = await resp.json();
    const remote = data.version || "unknown";
    const local = app.getVersion();
    return {
      localVersion: local,
      remoteVersion: remote,
      hasUpdate: isNewerVersion(remote, local),
    };
  } catch (err) {
    return { error: err.message };
  }
});

// 下载桌面版安装包并启动
ipcMain.handle("do-desktop-update", async () => {
  const cloudUrl = connectionConfig.cloudUrl || DEFAULT_CLOUD_URL;
  try {
    const resp = await fetch(`${cloudUrl}/download/desktop-setup.exe`);
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const tmpExe = path.join(app.getPath("temp"), `AI提效工具-Setup-${Date.now()}.exe`);
    fs.writeFileSync(tmpExe, buffer);
    console.log("[desktop-update] 已下载:", tmpExe, buffer.length, "bytes");

    // Windows: 启动安装程序（NSIS 安装器会自动关闭本应用并安装新版）
    shell.openPath(tmpExe).then((err) => {
      if (err) console.error("[desktop-update] 启动安装器失败:", err);
    });

    // 延迟退出，让安装器启动完成
    setTimeout(() => { app.isQuitting = true; app.exit(0); }, 2000);
    return { success: true };
  } catch (err) {
    console.error("[desktop-update] 失败:", err.message);
    return { success: false, error: err.message };
  }
});

// ========== 生命周期 ==========

app.on("ready", async () => {
  if (!connectionConfig.mode) {
    const selected = await showModeSelector();
    if (!selected) return;
    connectionConfig = selected;
  }

  createSplash();

  // 初始化网关（复制源码 + 安装依赖）
  const ready = await ensureGateway();
  if (!ready) { app.quit(); return; }

  // 首次按所选角色写入网关配置（仅一次）
  applyRoleToGatewayConfig();

  // 启动网关
  updateSplash("正在启动网关...");
  const ok = await startGateway();
  if (!ok) { app.quit(); return; }

  createMainWindow();
  setupTray();
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", () => { app.isQuitting = true; stopGateway(); });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") { stopGateway(); app.quit(); }
});

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
  else createMainWindow();
});
