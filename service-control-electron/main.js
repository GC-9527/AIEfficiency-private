const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require("electron");
const { spawn, exec, execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { normalizeExternalUrl } = require("./external-url.js");
const {
  DEFAULT_DEGRADED_CONFIRMATIONS,
  DEFAULT_MISSING_CONFIRMATIONS,
  RUNTIME_EVIDENCE,
  decideStartAction,
  evaluateForceReleaseCandidate,
  evaluateForceReleaseProfileState,
  evaluateRuntimeHealth,
  isAIEfficiencyGatewayFingerprint,
  isAIEfficiencyWebCommand,
  isRuntimeHealthObservationCurrent,
  nextRuntimeHealthGeneration,
  resolveSyncScope,
} = require("./runtime-health-policy.cjs");
const {
  PRIMARY_DEVELOPMENT_PROFILE_ID,
  applyStartupRepoRoles,
  configuredDevelopmentIds,
  developmentIndexFromId,
  isDevelopmentProfileId,
  nextDevelopmentProfileId,
} = require("./profile-role-policy.cjs");
const { syncApiEnginesToGateway } = require("./api-engine-sync-runtime.cjs");
const { sourceUserDataPath } = require("./instance-identity.cjs");
const {
  BUILD_TARGETS,
  validateBuildTargets,
} = require("./build-policy.cjs");
const { ensureGatewaySqliteRuntime } = require("./gateway-native-runtime.cjs");

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Source checkouts can coexist on one workstation. Electron's single-instance
// lock is scoped to userData, so a shared directory makes one checkout show a
// different checkout's window when its desktop shortcut is clicked.
function configureSourceUserDataPath() {
  if (app.isPackaged) return;
  const sourceRoot = fs.realpathSync.native(path.resolve(__dirname, ".."));
  app.setPath("userData", sourceUserDataPath(app.getPath("appData"), sourceRoot));
}

configureSourceUserDataPath();

const PRODUCTION_PROFILE_ID = "production";
const DATABASE_WARNING_BYTES = 512 * 1024 * 1024;
const HEALTH_CHECK_ACTIVE_MS = 30_000;
const HEALTH_CHECK_DEGRADED_MS = 5_000;
const HEALTH_CHECK_IDLE_MS = 60_000;
const HEALTH_REQUEST_TIMEOUT_MS = 2_500;
const PORT_RELEASE_STABILITY_MS = 1_200;
const PORT_RELEASE_TIMEOUT_MS = 5_000;
const PRODUCTION_PROFILE_DEF = {
  id: PRODUCTION_PROFILE_ID,
  kind: "production",
  label: "Production",
  badge: "Stable",
  defaultGatewayPort: 3001,
  defaultWebPort: 3000,
  gatewayFallbackPorts: Array.from({ length: 8 }, (_, i) => 3002 + i),
  webFallbackPorts: Array.from({ length: 11 }, (_, i) => 3010 + i),
};

let mainWindow = null;
let tray = null;
let state = { profiles: {} };
let profileConfigs = {};
let operations = {};
let children = {};
let panelWindows = {};
let isQuitting = false;
let nodePath = null;
let npmPath = null;
let bundledGatewayDir = "";
let desktopRuntimeRoot = "";
let runtimeHealthTimer = null;
const buildStates = new Map();
const buildChildren = new Map();
const runtimeHealthObservations = new Map();
const runtimeHealthChecks = new Set();
const runtimeHealthGenerations = new Map();

function currentRuntimeHealthGeneration(profileId) {
  const id = normalizeProfileId(profileId);
  return Number(runtimeHealthGenerations.get(id) || 0);
}

function invalidateRuntimeHealthObservations(profileId) {
  const id = normalizeProfileId(profileId);
  const nextGeneration = nextRuntimeHealthGeneration(currentRuntimeHealthGeneration(id));
  runtimeHealthGenerations.set(id, nextGeneration);
  runtimeHealthObservations.delete(id);
  return nextGeneration;
}

function canApplyRuntimeHealthObservation(profileId, observedGeneration) {
  const id = normalizeProfileId(profileId);
  return !operations[id] && isRuntimeHealthObservationCurrent(
    observedGeneration,
    currentRuntimeHealthGeneration(id),
  );
}

function developmentPorts(index) {
  const base = 3100 + Math.max(0, index) * 100;
  return {
    defaultWebPort: base,
    defaultGatewayPort: base + 1,
    gatewayFallbackPorts: Array.from({ length: 8 }, (_, i) => base + 2 + i),
    webFallbackPorts: Array.from({ length: 11 }, (_, i) => base + 10 + i),
  };
}

function webPanelUrl(webPort) {
  return `http://127.0.0.1:${webPort}/`;
}

function profileDef(profileId) {
  const id = String(profileId || "");
  if (id === PRODUCTION_PROFILE_ID) return PRODUCTION_PROFILE_DEF;
  if (isDevelopmentProfileId(id)) {
    const index = developmentIndexFromId(id);
    return {
      id,
      kind: "development",
      label: index === 0 ? "Development" : `Development ${index + 1}`,
      badge: index === 0 ? "Active dev" : `Dev ${index + 1}`,
      ...developmentPorts(index),
    };
  }
  return PRODUCTION_PROFILE_DEF;
}

function profileIds(profiles = profileConfigs) {
  return [PRODUCTION_PROFILE_ID, ...configuredDevelopmentIds(profiles)];
}

function defaultProfileId(profiles = profileConfigs) {
  if (profiles?.[PRODUCTION_PROFILE_ID]?.repoRoot || isBundledMode()) return PRODUCTION_PROFILE_ID;
  const configuredDev = configuredDevelopmentIds(profiles).find((id) => profiles?.[id]?.repoRoot);
  return configuredDev || PRODUCTION_PROFILE_ID;
}

function normalizeProfileId(profileId) {
  const id = String(profileId || "");
  return profileIds().includes(id) ? id : defaultProfileId();
}

function ensureProfileProcessBucket(profileId) {
  const id = normalizeProfileId(profileId);
  if (!children[id]) children[id] = { gateway: null, web: null };
  return children[id];
}

function getArgValue(name) {
  const prefix = `${name}=`;
  for (let i = 0; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1] || "";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return "";
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isValidRepoRoot(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, "gateway", "server.js")) &&
    fs.existsSync(path.join(dir, "web-dashboard", "package.json"));
}

function findBundledGatewayDir() {
  const candidates = app.isPackaged
    ? [process.resourcesPath ? path.join(process.resourcesPath, "gateway") : ""]
    : (process.argv.includes("--bundled") ? [path.join(__dirname, "gateway-bundled")] : []);
  return candidates.find((dir) => dir && fs.existsSync(path.join(dir, "server.js"))) || "";
}

function isBundledMode() {
  return !!bundledGatewayDir;
}

function getConfigPath() {
  return path.join(app.getPath("userData"), "service-control-config.json");
}

function getStatePath() {
  return path.join(app.getPath("userData"), "service-control-state.json");
}

function loadConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfigFile(next) {
  mkdirp(path.dirname(getConfigPath()));
  fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2));
}

function normalizePort(value, fallback) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function normalizeSyncScope(value) {
  return String(value || "").trim().slice(0, 160);
}

function normalizeRepoRoot(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const resolved = path.resolve(raw);
  return isValidRepoRoot(resolved) ? resolved : "";
}

function desktopRuntimeCandidateRoots(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const resolved = path.resolve(raw);
  const candidates = [resolved];
  if (path.basename(resolved).toLowerCase() === "gateway") {
    candidates.push(path.dirname(resolved));
  }
  return candidates;
}

function isDesktopRuntimeRoot(value) {
  for (const root of desktopRuntimeCandidateRoots(value)) {
    if (!fs.existsSync(root)) continue;
    if (fs.existsSync(path.join(root, "connection.json"))) return true;
    if (fs.existsSync(path.join(root, "gateway", "server.js"))) return true;
    if (fs.existsSync(path.join(root, "gateway", "db", "data.db"))) return true;
    if (fs.existsSync(path.join(root, "configs", "market-projects.json"))) return true;
  }
  return false;
}

function normalizeDesktopRuntimeRoot(value) {
  for (const root of desktopRuntimeCandidateRoots(value)) {
    if (isDesktopRuntimeRoot(root)) return root;
  }
  return "";
}

function desktopRuntimeCandidates() {
  const appData = app.getPath("appData");
  const names = [
    "AI提效工具",
    "AI效率工具",
    "AIEfficiency",
    "AI Efficiency",
    "ai-efficiency-desktop",
  ];
  return [
    process.env.AIEFFICIENCY_DESKTOP_RUNTIME || "",
    ...names.map((name) => path.join(appData, name)),
  ].filter(Boolean);
}

function detectDesktopRuntimeRoot() {
  return desktopRuntimeCandidates().map(normalizeDesktopRuntimeRoot).find(Boolean) || "";
}

function samePath(a, b) {
  return !!a && !!b && normalizeText(path.resolve(a)) === normalizeText(path.resolve(b));
}

function localSourceRepoRoot() {
  if (isBundledMode()) return "";
  const candidates = [path.resolve(__dirname, ".."), process.cwd()];
  return candidates.map(normalizeRepoRoot).find(Boolean) || "";
}

function normalizeLabel(value) {
  const label = String(value || "").trim();
  return label.length > 40 ? label.slice(0, 40) : label;
}

function inferDevelopmentLabel(repoRoot, profileId) {
  const fromFolder = normalizeLabel(repoRoot ? path.basename(path.resolve(repoRoot)) : "");
  if (fromFolder) return fromFolder;
  return profileDef(profileId).label;
}

function normalizeConfig(raw = {}) {
  const sourceProfiles = raw.profiles && typeof raw.profiles === "object" ? raw.profiles : {};
  const profiles = {};
  for (const id of profileIds(sourceProfiles)) {
    const def = profileDef(id);
    const current = sourceProfiles[id] || {};
    const repoRoot = normalizeRepoRoot(current.repoRoot);
    profiles[id] = {
      repoRoot,
      gatewayPort: normalizePort(current.gatewayPort, def.defaultGatewayPort),
      webPort: normalizePort(current.webPort, def.defaultWebPort),
    };
    const label = normalizeLabel(current.label);
    if (label) profiles[id].label = label;
    const devbenchSyncScope = normalizeSyncScope(current.devbenchSyncScope);
    if (devbenchSyncScope) profiles[id].devbenchSyncScope = devbenchSyncScope;
  }
  if (!profiles.production.repoRoot && raw.repoRoot) {
    profiles.production.repoRoot = normalizeRepoRoot(raw.repoRoot);
  }
  return { ...raw, profiles, desktopRuntimeRoot: normalizeDesktopRuntimeRoot(raw.desktopRuntimeRoot) };
}

function saveProfileConfig(profileId, patch) {
  const id = normalizeProfileId(profileId);
  const raw = normalizeConfig(loadConfigFile());
  const next = {
    ...raw,
    profiles: {
      ...(raw.profiles || {}),
      [id]: {
        ...(raw.profiles?.[id] || {}),
        ...patch,
      },
    },
  };
  if (id === "production" && patch.repoRoot) next.repoRoot = patch.repoRoot;
  writeConfigFile(next);
  profileConfigs = normalizeConfig(next).profiles;
}

function findProfileByRoot(root, exceptId = "") {
  const normalized = normalizeText(path.resolve(root || ""));
  if (!normalized) return "";
  return profileIds().find((id) => {
    if (id === exceptId) return false;
    const currentRoot = profileConfigs[id]?.repoRoot || "";
    return currentRoot && normalizeText(path.resolve(currentRoot)) === normalized;
  }) || "";
}

function saveDesktopRuntimeRoot(root) {
  const normalized = normalizeDesktopRuntimeRoot(root);
  if (!normalized) throw new Error("Choose the desktop runtime folder that contains connection.json, gateway, or configs.");
  const raw = normalizeConfig(loadConfigFile());
  const next = {
    ...raw,
    desktopRuntimeRoot: normalized,
  };
  writeConfigFile(next);
  desktopRuntimeRoot = normalized;
}

function parseRepoList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => normalizeRepoRoot(item))
    .filter(Boolean);
}

function upsertDevelopmentRepo(configs, repoRoot) {
  const existing = configuredDevelopmentIds(configs).find((id) => configs?.[id]?.repoRoot && samePath(configs[id].repoRoot, repoRoot));
  if (existing) return existing;
  const id = nextDevelopmentProfileId(configs);
  const def = profileDef(id);
  configs[id] = {
    ...(configs[id] || {}),
    repoRoot,
    gatewayPort: normalizePort(configs[id]?.gatewayPort, def.defaultGatewayPort),
    webPort: normalizePort(configs[id]?.webPort, def.defaultWebPort),
    label: normalizeLabel(configs[id]?.label) || inferDevelopmentLabel(repoRoot, id),
  };
  return id;
}

function resolveInitialProfileConfigs() {
  const raw = normalizeConfig(loadConfigFile());
  let configs = raw.profiles;
  const explicitProd = normalizeRepoRoot(getArgValue("--repo") || process.env.AIEFFICIENCY_REPO || "");
  const explicitDev = normalizeRepoRoot(getArgValue("--dev-repo") || process.env.AIEFFICIENCY_DEV_REPO || "");
  const explicitDevRepos = [
    ...parseRepoList(getArgValue("--dev-repos") || process.env.AIEFFICIENCY_DEV_REPOS || ""),
    ...(explicitDev ? [explicitDev] : []),
  ];
  const sourceRoot = localSourceRepoRoot();

  configs = applyStartupRepoRoles(configs, {
    sourceRoot,
    explicitProductionRoot: explicitProd,
    explicitDevelopmentRoots: explicitDevRepos,
  });
  for (const id of configuredDevelopmentIds(configs)) {
    const def = profileDef(id);
    configs[id] = {
      ...(configs[id] || {}),
      gatewayPort: normalizePort(configs[id]?.gatewayPort, def.defaultGatewayPort),
      webPort: normalizePort(configs[id]?.webPort, def.defaultWebPort),
      label: normalizeLabel(configs[id]?.label) || inferDevelopmentLabel(configs[id]?.repoRoot, id),
    };
  }
  desktopRuntimeRoot = raw.desktopRuntimeRoot || detectDesktopRuntimeRoot();

  writeConfigFile({ ...raw, repoRoot: configs.production.repoRoot || "", profiles: configs, desktopRuntimeRoot });
  return configs;
}

function readStateFile() {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeStateFile() {
  mkdirp(path.dirname(getStatePath()));
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

function getRuntimeProfile(profileId, snapshot = null) {
  const id = normalizeProfileId(profileId);
  const def = profileDef(id);
  const cfg = profileConfigs[id] || {};
  const root = snapshot?.root || cfg.repoRoot || "";
  const bundled = id === PRODUCTION_PROFILE_ID && !root && isBundledMode();
  const gatewayPort = normalizePort(snapshot?.preferredGatewayPort || snapshot?.gatewayPort || cfg.gatewayPort, def.defaultGatewayPort);
  const webPort = normalizePort(snapshot?.preferredWebPort || snapshot?.webPort || cfg.webPort, def.defaultWebPort);
  return {
    ...def,
    label: normalizeLabel(cfg.label) || def.label,
    root,
    bundled,
    source: !bundled,
    gatewayPort,
    webPort,
    devbenchSyncScope: normalizeSyncScope(cfg.devbenchSyncScope),
  };
}

function resolveProfileSyncScope(profile) {
  const profileEnvKey = `DEVBENCH_SYNC_SCOPE_${String(profile.id || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;
  return resolveSyncScope({
    profileId: profile.id,
    profileValue: profile.devbenchSyncScope,
    profileEnvValue: process.env[profileEnvKey],
    globalEnvValue: process.env.DEVBENCH_SYNC_SCOPE,
  });
}

function getGatewayDir(profile) {
  if (profile.bundled) return bundledGatewayDir;
  return profile.root ? path.join(profile.root, "gateway") : "";
}

function getWebDir(profile) {
  return profile.root ? path.join(profile.root, "web-dashboard") : "";
}

function getProfileDatabaseDiagnostics(profile) {
  const gatewayDir = getGatewayDir(profile);
  const databasePath = gatewayDir ? path.join(gatewayDir, "db", "data.db") : "";
  if (!databasePath) {
    return {
      path: "",
      bytes: 0,
      walBytes: 0,
      totalBytes: 0,
      warning: false,
      warningThresholdBytes: DATABASE_WARNING_BYTES,
    };
  }
  const fileSize = (filePath) => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  };
  const bytes = fileSize(databasePath);
  const walBytes = fileSize(`${databasePath}-wal`);
  const totalBytes = bytes + walBytes;
  return {
    path: databasePath,
    bytes,
    walBytes,
    totalBytes,
    warning: totalBytes >= DATABASE_WARNING_BYTES,
    warningThresholdBytes: DATABASE_WARNING_BYTES,
  };
}

function getViteCliPath(webDir) {
  return path.join(webDir, "node_modules", "vite", "bin", "vite.js");
}

function getProfileTempDir(profile) {
  if (profile.root) return path.join(profile.root, "docs", "tempFiles", "service-control", profile.id);
  return path.join(app.getPath("userData"), "tempFiles", profile.id);
}

function getProfileLogDir(profile) {
  return path.join(getProfileTempDir(profile), "startup-logs");
}

function getIconPath() {
  const firstRoot = profileIds().map((id) => profileConfigs[id]?.repoRoot).find(Boolean);
  const candidates = [
    firstRoot ? path.join(firstRoot, "desktop", "icons", "icon.png") : "",
    path.join(__dirname, "..", "desktop", "icons", "icon.png"),
    process.resourcesPath ? path.join(process.resourcesPath, "icons", "icon.png") : "",
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function profileConfigured(profile) {
  return profile.bundled || isValidRepoRoot(profile.root);
}

function normalizeText(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function isStaleRecordedRuntimeMessage(value) {
  return /^Previously recorded\b/i.test(String(value || "").trim());
}

function profileRootPaths(profile) {
  const paths = [
    profile.root || "",
    getGatewayDir(profile),
    profile.source ? getWebDir(profile) : "",
    profile.bundled ? bundledGatewayDir : "",
    profile.bundled && process.resourcesPath ? process.resourcesPath : "",
  ];
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(item)))];
}

function processLooksOwnedByProfile(command, profile) {
  const text = normalizeText(command);
  return profileRootPaths(profile).some((root) => text.includes(normalizeText(root)));
}

function profileState(profileId) {
  const id = normalizeProfileId(profileId);
  return state.profiles?.[id] || {};
}

function buildProfileState(profileId, patch = {}) {
  const id = normalizeProfileId(profileId);
  const profile = getRuntimeProfile(id, patch);
  const preferredProfile = getRuntimeProfile(id);
  const configured = profileConfigured(profile);
  const previous = profileState(id);
  const rawStatus = patch.status || previous.status || "stopped";
  const rawPhase = patch.phase || previous.phase || "ready";
  const rawMessage = patch.message || previous.message || "Ready";
  const staleStatus = rawStatus === "repo_missing" || (!operations[id] && (rawStatus === "starting" || rawStatus === "stopping"));
  const staleRecordedMessage = isStaleRecordedRuntimeMessage(rawMessage);
  const nextStatus = configured && staleStatus ? "stopped" : rawStatus;
  const nextPhase = configured && (rawPhase === "repo" || (staleStatus && rawPhase !== "ready")) ? "ready" : rawPhase;
  const nextMessage = configured && (rawMessage === "Choose a valid AIEfficiency repository" || staleStatus || staleRecordedMessage) ? "Ready" : rawMessage;
  return {
    ...previous,
    ...patch,
    id,
    label: profile.label,
    badge: profile.badge,
    kind: profile.kind,
    mode: profile.bundled ? "bundled" : "source",
    root: profile.bundled ? null : profile.root || null,
    gatewayRoot: getGatewayDir(profile) || null,
    webRoot: profile.source ? getWebDir(profile) || null : null,
    preferredGatewayPort: preferredProfile.gatewayPort,
    preferredWebPort: preferredProfile.webPort,
    database: getProfileDatabaseDiagnostics(profile),
    logDir: getProfileLogDir(profile),
    configured,
    status: configured ? nextStatus : "repo_missing",
    phase: configured ? nextPhase : "repo",
    message: configured ? nextMessage : "Choose a valid AIEfficiency repository",
    updatedAt: new Date().toISOString(),
  };
}

function writeProfileState(profileId, patch = {}) {
  const id = normalizeProfileId(profileId);
  state = {
    ...state,
    mode: isBundledMode() ? "mixed" : "source",
    profiles: {
      ...(state.profiles || {}),
      [id]: buildProfileState(id, patch),
    },
    updatedAt: new Date().toISOString(),
  };
  writeStateFile();
  sendState();
  rebuildTrayMenu();
}

function publicState() {
  const runtimeRoot = desktopRuntimeRoot || detectDesktopRuntimeRoot();
  const profiles = Object.fromEntries(profileIds().map((id) => {
    const snapshot = profileState(id);
    const profile = getRuntimeProfile(id, snapshot);
    return [id, {
      ...snapshot,
      database: getProfileDatabaseDiagnostics(profile),
    }];
  }));
  return {
    ...state,
    profiles,
    profileOrder: profileIds(),
    defaultProfile: defaultProfileId(),
    developmentProfiles: configuredDevelopmentIds(),
    desktopRuntime: {
      root: runtimeRoot || "",
      configured: !!runtimeRoot,
      gatewayRoot: runtimeRoot ? path.join(runtimeRoot, "gateway") : "",
      configRoot: runtimeRoot ? path.join(runtimeRoot, "configs") : "",
    },
    buildTargets: BUILD_TARGETS,
    builds: Object.fromEntries(profileIds().map((id) => [id, publicBuildState(id)])),
    configPath: getConfigPath(),
    statePath: getStatePath(),
  };
}

function publicBuildState(profileId) {
  const id = normalizeProfileId(profileId);
  const current = buildStates.get(id);
  return current ? {
    ...current,
    targets: [...(current.targets || [])],
    completedTargets: [...(current.completedTargets || [])],
    logs: [...(current.logs || [])],
  } : {
    status: "idle",
    progress: 0,
    targets: [],
    completedTargets: [],
    logs: [],
  };
}

function hasActiveBuild() {
  return [...buildStates.values()].some((build) => build.status === "running") || buildChildren.size > 0;
}

function sendBuildProgress(profileId) {
  const id = normalizeProfileId(profileId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("build:progress", { profileId: id, build: publicBuildState(id) });
  }
}

function writeBuildState(profileId, patch) {
  const id = normalizeProfileId(profileId);
  const previousStatus = buildStates.get(id)?.status || "idle";
  const next = {
    status: "idle",
    progress: 0,
    targets: [],
    completedTargets: [],
    logs: [],
    ...(buildStates.get(id) || {}),
    ...patch,
  };
  buildStates.set(id, next);
  sendBuildProgress(id);
  if (previousStatus !== next.status) rebuildTrayMenu();
  return publicBuildState(id);
}

function appendBuildOutput(profileId, target, stream, chunk) {
  const id = normalizeProfileId(profileId);
  const text = String(chunk || "")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
  const lines = text.split("\n").filter((line, index, all) => line || index < all.length - 1);
  if (!lines.length) return;
  const current = publicBuildState(id);
  // Many successful build tools (including Vite) write warnings to stderr.
  // The process exit code remains the authoritative success/failure signal.
  const prefix = stream === "stderr" ? "[WARN] " : "";
  writeBuildState(id, {
    logs: [...current.logs, ...lines.map((line) => `${prefix}${line}`)].slice(-500),
    currentTarget: target,
  });
}

function powershellExecutable() {
  if (process.platform !== "win32") return "pwsh";
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runBuildTarget(profileId, root, target) {
  const id = normalizeProfileId(profileId);
  const buildScript = path.join(root, "scripts", "build.ps1");
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        buildScript,
        target,
        "-NoOpen",
      ],
      {
        cwd: root,
        env: { ...process.env },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    buildChildren.set(id, child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => appendBuildOutput(id, target, "stdout", chunk));
    child.stderr.on("data", (chunk) => appendBuildOutput(id, target, "stderr", chunk));
    child.on("error", (error) => {
      buildChildren.delete(id);
      reject(error);
    });
    child.on("exit", (code) => {
      buildChildren.delete(id);
      if (code === 0) resolve();
      else reject(new Error(`编译目标 ${target} 失败，退出码 ${code}。`));
    });
  });
}

async function runBuildQueue(profileId, root, targets) {
  const id = normalizeProfileId(profileId);
  const completedTargets = [];
  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const targetInfo = BUILD_TARGETS.find((item) => item.id === target);
      writeBuildState(id, {
        currentTarget: target,
        currentLabel: targetInfo?.label || target,
        currentIndex: index,
        progress: Math.max(5, Math.round((index / targets.length) * 100)),
        message: `正在执行 scripts/build.ps1 ${target} -NoOpen`,
      });
      await runBuildTarget(id, root, target);
      completedTargets.push(target);
      writeBuildState(id, {
        completedTargets: [...completedTargets],
        progress: Math.round((completedTargets.length / targets.length) * 100),
      });
    }
    writeBuildState(id, {
      status: "success",
      progress: 100,
      currentTarget: null,
      currentLabel: null,
      completedTargets,
      finishedAt: new Date().toISOString(),
      message: `已完成 ${completedTargets.length} 个编译目标`,
      error: null,
    });
  } catch (error) {
    writeBuildState(id, {
      status: "failed",
      currentTarget: null,
      currentLabel: null,
      completedTargets,
      finishedAt: new Date().toISOString(),
      message: "编译未完成",
      error: error.message || String(error),
    });
  }
}

function startBuild(profileId, requestedTargets) {
  const id = normalizeProfileId(profileId);
  const targets = validateBuildTargets(requestedTargets);
  const existing = publicBuildState(id);
  if (existing.status === "running" || buildChildren.has(id)) {
    throw new Error("当前环境已有编译任务正在运行。");
  }
  const profile = getRuntimeProfile(id, profileState(id));
  if (profile.bundled || !profile.root) {
    throw new Error("编译功能仅支持已配置源码仓库的环境。");
  }
  const root = path.resolve(profile.root);
  const buildScript = path.join(root, "scripts", "build.ps1");
  if (!fs.existsSync(buildScript)) {
    throw new Error(`未找到编译脚本：${buildScript}`);
  }
  const initial = writeBuildState(id, {
    status: "running",
    progress: 0,
    targets,
    completedTargets: [],
    currentTarget: null,
    currentLabel: null,
    currentIndex: 0,
    total: targets.length,
    logs: [`[Service Control] 开始编译：${targets.join(", ")}`],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message: "正在准备编译环境",
    error: null,
  });
  void runBuildQueue(id, root, targets);
  return initial;
}

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state", publicState());
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function appendControlLog(profileId, message, level = "INFO") {
  const id = normalizeProfileId(profileId);
  const profile = getRuntimeProfile(id, profileState(id));
  const logs = profileState(id).logs || {};
  const logFile = logs.controller || path.join(getProfileLogDir(profile), `control_${nowStamp()}.log`);
  mkdirp(path.dirname(logFile));
  fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] [${id}] ${message}${os.EOL}`);
}

function newLogContext(profileId) {
  const profile = getRuntimeProfile(profileId);
  const logDir = getProfileLogDir(profile);
  mkdirp(logDir);
  const stamp = nowStamp();
  return {
    controller: path.join(logDir, `control_${stamp}.log`),
    gatewayOut: path.join(logDir, `gateway_${stamp}.out.log`),
    gatewayErr: path.join(logDir, `gateway_${stamp}.err.log`),
    webOut: path.join(logDir, `web_${stamp}.out.log`),
    webErr: path.join(logDir, `web_${stamp}.err.log`),
    gatewayNpmOut: path.join(logDir, `npm_gateway_${stamp}.out.log`),
    gatewayNpmErr: path.join(logDir, `npm_gateway_${stamp}.err.log`),
    webNpmOut: path.join(logDir, `npm_web_${stamp}.out.log`),
    webNpmErr: path.join(logDir, `npm_web_${stamp}.err.log`),
  };
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function findCommand(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, {
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(command),
    });
    return command;
  } catch {
    return "";
  }
}

function getBundledNodePath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "node-runtime", process.platform === "win32" ? "node.exe" : path.join("bin", "node")) : "",
    path.join(__dirname, "node-runtime", process.platform === "win32" ? "node.exe" : path.join("bin", "node")),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

async function findNode() {
  if (nodePath) return nodePath;
  if (isBundledMode()) {
    const bundledNode = getBundledNodePath();
    if (bundledNode) {
      nodePath = bundledNode;
      return nodePath;
    }
  }
  const candidates = [
    "node",
    process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "",
    process.platform === "win32" ? "C:\\Program Files (x86)\\nodejs\\node.exe" : "",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    path.join(os.homedir(), ".volta", "bin", process.platform === "win32" ? "node.exe" : "node"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const found = await findCommand(candidate, ["-v"]);
    if (found) {
      nodePath = found;
      return found;
    }
  }
  throw new Error("Node.js was not found. Install Node.js 20+ and retry.");
}

function resolveWindowsCommand(command) {
  if (process.platform !== "win32" || !command) return "";
  const hasPath = path.isAbsolute(command) || /[\\/]/.test(command);
  const names = path.extname(command) ? [command] : [command, `${command}.cmd`, `${command}.exe`];
  const dirs = hasPath ? [""] : String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = hasPath ? path.resolve(name) : path.join(dir.replace(/^"|"$/g, ""), name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return "";
}

async function findNpm() {
  if (npmPath) return npmPath;
  const candidates = [
    process.platform === "win32" ? "npm.cmd" : "npm",
    process.platform === "win32" ? "C:\\Program Files\\nodejs\\npm.cmd" : "",
    process.platform === "win32" ? "C:\\Program Files (x86)\\nodejs\\npm.cmd" : "",
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "/usr/bin/npm",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (process.platform === "win32") {
      const resolved = resolveWindowsCommand(candidate);
      if (resolved) {
        npmPath = resolved;
        return resolved;
      }
      continue;
    }
    const found = await findCommand(candidate, ["-v"]);
    if (found) {
      npmPath = found;
      return found;
    }
  }
  throw new Error("npm was not found. Reinstall Node.js and retry.");
}

function getNpmCliPath(command) {
  if (process.platform !== "win32") return "";
  const resolved = resolveWindowsCommand(command);
  if (!resolved) return "";
  const candidates = [
    path.join(path.dirname(resolved), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(resolved), "node_modules", "npm", "bin", "npm-cli.mjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function canListen(port) {
  if ((await getPortPids(port)).length) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function findFreePort(preferred, fallbacks) {
  if (await canListen(preferred)) return preferred;
  for (const port of fallbacks) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free port found in ${[preferred, ...fallbacks].join(", ")}`);
}

function httpOk(url, timeoutMs = 2000, options = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      const status = Number(res.statusCode || 0);
      resolve(options.requireSuccess ? status >= 200 && status < 300 : status >= 200 && status < 500);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function httpHealthOk(url, timeoutMs = 2000) {
  return httpOk(url, timeoutMs, { requireSuccess: true });
}

function httpJson(url, timeoutMs = 2000, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (Number(res.statusCode || 0) < 200 || Number(res.statusCode || 0) >= 300) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

async function waitHttpOk(url, seconds, child = null) {
  const deadline = Date.now() + seconds * 1000;
  const requireSuccess = /\/api\/health(?:[?#]|$)/.test(url);
  while (Date.now() < deadline) {
    if (await httpOk(url, 2000, { requireSuccess })) return true;
    if (child && (child.exitCode !== null || child.signalCode)) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function tailFile(file, maxChars = 1800) {
  try {
    if (!file || !fs.existsSync(file)) return "";
    const text = fs.readFileSync(file, "utf8").trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

function startupFailureMessage(label, child, logFile) {
  const status = child && (child.exitCode !== null || child.signalCode)
    ? `${label} exited${child.exitCode !== null ? ` with code ${child.exitCode}` : ""}${child.signalCode ? ` (${child.signalCode})` : ""}.`
    : `${label} did not become healthy before the timeout.`;
  const tail = tailFile(logFile);
  return tail
    ? `${status} Last error: ${tail.split(/\r?\n/).slice(-8).join(" ")} Check ${logFile}`
    : `${status} Check ${logFile}`;
}

async function getPortPidSnapshot(port) {
  if (!Number(port)) return { known: true, pids: [] };
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], { timeout: 8000, windowsHide: true });
      const pids = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (pid > 0) pids.add(pid);
      }
      return { known: true, pids: [...pids] };
    }
    try {
      const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { timeout: 5000 });
      return { known: true, pids: stdout.split(/\s+/).map(Number).filter((pid) => pid > 0) };
    } catch {
      const { stdout } = await execAsync("ss -ltnp", { timeout: 5000 });
      const pids = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
        const match = line.match(/pid=(\d+)/);
        if (match) pids.add(Number(match[1]));
      }
      return { known: true, pids: [...pids] };
    }
  } catch {
    return { known: false, pids: [] };
  }
}

async function getPortPids(port) {
  return (await getPortPidSnapshot(port)).pids;
}

async function waitForStablePortRelease(port) {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  let freeSince = 0;
  let latest = { known: false, pids: [] };
  while (Date.now() < deadline) {
    latest = await getPortPidSnapshot(port);
    if (!latest.known) return { ...latest, stable: false };
    if (latest.pids.length) {
      freeSince = 0;
    } else {
      if (!freeSince) freeSince = Date.now();
      if (Date.now() - freeSince >= PORT_RELEASE_STABILITY_MS) {
        return { ...latest, stable: true };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ...latest, stable: false };
}

async function getProcessInfo(pid) {
  try {
    if (process.platform === "win32") {
      // 同时取 Name 与 CommandLine：部分进程（如被提升权限启动的网关）CommandLine 读不到，
      // 但 Name 仍可读，便于按 node.exe + 占用端口判定归属，避免启动死锁。
      const ps = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object Name,CommandLine | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", ps], { timeout: 5000, windowsHide: true });
      const text = String(stdout || "").trim();
      if (!text || text === "null") return { name: "", command: "" };
      const obj = JSON.parse(text);
      return { name: String(obj?.Name || "").trim(), command: String(obj?.CommandLine || "").trim() };
    }
    const { stdout } = await execAsync(`ps -p ${pid} -o command=`, { timeout: 5000 });
    return { name: "", command: String(stdout || "").trim() };
  } catch {
    return { name: "", command: "" };
  }
}

function profileOwningPid(pid) {
  const numericPid = Number(pid || 0);
  if (!numericPid) return null;
  for (const id of profileIds()) {
    const candidate = profileState(id);
    if (Number(candidate.gatewayPid || 0) === numericPid || Number(candidate.webPid || 0) === numericPid) {
      return {
        id,
        label: candidate.label || profileDef(id).label,
      };
    }
  }
  return null;
}

function configuredAIEfficiencyRepoRoots() {
  return profileIds()
    .map((id) => profileConfigs[id]?.repoRoot || "")
    .filter((root) => isValidRepoRoot(root));
}

async function inspectPortOccupants(port, expectedService = "") {
  const snapshot = await getPortPidSnapshot(port);
  const serviceFingerprintVerified = snapshot.known
    && snapshot.pids.length === 1
    && expectedService === "gateway"
    && isAIEfficiencyGatewayFingerprint(
      await httpJson(`http://127.0.0.1:${port}/api/discovery/info`, 1500),
    );
  const occupants = await Promise.all(snapshot.pids.map(async (pid) => {
    const [info, owner] = await Promise.all([
      getProcessInfo(pid),
      Promise.resolve(profileOwningPid(pid)),
    ]);
    const occupantFingerprintVerified = expectedService === "web"
      ? snapshot.known
        && snapshot.pids.length === 1
        && isAIEfficiencyWebCommand(info.command, configuredAIEfficiencyRepoRoots())
      : serviceFingerprintVerified;
    const release = evaluateForceReleaseCandidate({
      pid,
      name: info.name,
      command: info.command,
      managedProfileId: owner?.id,
      protectedPids: [process.pid],
      expectedService,
      serviceFingerprintVerified: occupantFingerprintVerified,
    });
    return {
      pid,
      name: info.name || "unknown process",
      command: info.command || "",
      managedProfileId: owner?.id || null,
      managedProfileLabel: owner?.label || null,
      forceReleaseEligible: release.eligible,
      forceReleaseReason: release.reason,
      serviceFingerprintVerified: occupantFingerprintVerified,
    };
  }));
  return { ...snapshot, occupants };
}

async function inspectPortFallback(service, preferredPort, actualPort) {
  const preferred = Number(preferredPort || 0);
  const actual = Number(actualPort || 0);
  if (!preferred || !actual || preferred === actual) return null;
  const snapshot = await inspectPortOccupants(preferred, service);
  const occupants = snapshot.occupants;
  const restartMayResolve = occupants.length > 0
    && occupants.every((item) => !!item.managedProfileId);
  return {
    service,
    preferredPort: preferred,
    actualPort: actual,
    reason: snapshot.known
      ? occupants.length
        ? "preferred_port_occupied"
        : "preferred_port_unavailable"
      : "port_owner_unknown",
    occupants,
    restartMayResolve,
  };
}

async function inspectPortFallbacks(profile, gatewayPort, webPort) {
  const checks = [
    inspectPortFallback("gateway", profile.gatewayPort, gatewayPort),
  ];
  if (!profile.bundled) {
    checks.push(inspectPortFallback("web", profile.webPort, webPort));
  }
  return (await Promise.all(checks)).filter(Boolean);
}

async function refreshInactivePortFallbacks(profileId, current, shouldApply = () => true) {
  const previousPortFallbacks = current.portFallbacks || [];
  const desiredProfile = getRuntimeProfile(profileId);
  const gatewayPortDrift = Number(current.gatewayPort || 0) !== Number(desiredProfile.gatewayPort || 0);
  const webPortDrift = Number(current.webPort || 0) !== Number(desiredProfile.webPort || 0);
  const fallbackCandidates = previousPortFallbacks.length
    ? previousPortFallbacks
    : [
        gatewayPortDrift
          ? {
              service: "gateway",
              preferredPort: desiredProfile.gatewayPort,
              actualPort: current.gatewayPort,
            }
          : null,
        !desiredProfile.bundled && webPortDrift
          ? {
              service: "web",
              preferredPort: desiredProfile.webPort,
              actualPort: current.webPort,
            }
          : null,
      ].filter(Boolean);
  if (!fallbackCandidates.length) return false;

  const refreshedPortFallbacks = (await Promise.all(fallbackCandidates.map(async (fallback) => {
    if (await canListen(fallback.preferredPort)) return null;
    return inspectPortFallback(
      fallback.service,
      fallback.preferredPort,
      fallback.actualPort,
    );
  }))).filter(Boolean);
  if (!shouldApply()) return false;
  const remainingServices = new Set(refreshedPortFallbacks.map((item) => item.service));
  const fallbackChanged = JSON.stringify(refreshedPortFallbacks) !== JSON.stringify(previousPortFallbacks);
  const gatewayResetRequired = gatewayPortDrift && !remainingServices.has("gateway");
  const webResetRequired = webPortDrift && !remainingServices.has("web");
  if (!fallbackChanged && !gatewayResetRequired && !webResetRequired) return false;

  const fallbackWarning = portFallbackMessage(refreshedPortFallbacks);
  const patch = {
    portFallbacks: refreshedPortFallbacks,
    phase: fallbackWarning ? "warning" : "ready",
    message: fallbackWarning || "Ready",
    lastError: null,
    gatewayPid: null,
    webPid: null,
    gatewayUrl: null,
    panelUrl: null,
  };
  if (!remainingServices.has("gateway")) {
    patch.gatewayPort = desiredProfile.gatewayPort;
    if (desiredProfile.bundled) patch.webPort = desiredProfile.gatewayPort;
  }
  if (!desiredProfile.bundled && !remainingServices.has("web")) {
    patch.webPort = desiredProfile.webPort;
  }
  writeProfileState(profileId, patch);
  return true;
}

function portFallbackMessage(portFallbacks) {
  const descriptions = (portFallbacks || []).map((item) => {
    const service = item.service === "web" ? "Web" : "Gateway";
    const owners = item.occupants?.length
      ? item.occupants.map((entry) => `${entry.name} PID ${entry.pid}`).join(", ")
      : "an unavailable listener";
    return `${service} preferred port ${item.preferredPort} is occupied by ${owners}; using ${item.actualPort}.`;
  });
  if (!descriptions.length) return "";
  const restartHint = portFallbacks.every((item) => item.restartMayResolve)
    ? "Fully exiting this panel may release the managed occupying processes before restart."
    : "Fully exiting and restarting this panel will not release external or untracked occupying processes.";
  return `${descriptions.join(" ")} ${restartHint}`;
}

async function getProcessCommand(pid) {
  return (await getProcessInfo(pid)).command;
}

async function inspectServiceRuntime(profile, port, recordedPid = 0, portSnapshot = null) {
  const snapshot = portSnapshot || await getPortPidSnapshot(port);
  let commandUnknown = false;

  for (const pid of snapshot.pids) {
    const command = await getProcessCommand(pid);
    if (!command) {
      commandUnknown = true;
      continue;
    }
    if (processLooksOwnedByProfile(command, profile)) {
      return {
        evidence: RUNTIME_EVIDENCE.OWNED_LISTENER,
        ownedPid: pid,
        listenerPids: snapshot.pids,
      };
    }
  }

  const trackedPid = Number(recordedPid || 0);
  if (trackedPid && isPidAlive(trackedPid)) {
    const command = await getProcessCommand(trackedPid);
    if (!command) {
      commandUnknown = true;
    } else if (processLooksOwnedByProfile(command, profile)) {
      return {
        evidence: RUNTIME_EVIDENCE.OWNED_PROCESS,
        ownedPid: trackedPid,
        listenerPids: snapshot.pids,
      };
    }
  }

  if (!snapshot.known || commandUnknown) {
    return {
      evidence: RUNTIME_EVIDENCE.UNKNOWN,
      ownedPid: 0,
      listenerPids: snapshot.pids,
    };
  }
  return {
    evidence: snapshot.pids.length ? RUNTIME_EVIDENCE.FOREIGN : RUNTIME_EVIDENCE.MISSING,
    ownedPid: 0,
    listenerPids: snapshot.pids,
  };
}

async function inspectProfileRuntime(profile, gatewayPort, webPort, current = {}) {
  const gatewaySnapshot = await getPortPidSnapshot(gatewayPort);
  const gateway = await inspectServiceRuntime(
    profile,
    gatewayPort,
    current.gatewayPid || (gatewayPort === webPort ? current.webPid : 0),
    gatewaySnapshot,
  );
  if (gatewayPort === webPort) {
    return {
      gateway,
      web: { ...gateway },
    };
  }
  const web = await inspectServiceRuntime(profile, webPort, current.webPid);
  return { gateway, web };
}

async function stopPid(profileId, pid, label) {
  if (!pid || !isPidAlive(pid)) return;
  appendControlLog(profileId, `Stopping ${label} PID ${pid}`);
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10000, windowsHide: true });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (isPidAlive(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
  } catch (err) {
    appendControlLog(profileId, `Failed to stop PID ${pid}: ${err.message}`, "WARN");
  }
}

async function forceTerminateProcessTree(profileId, pid, label) {
  const numericPid = Number(pid || 0);
  if (!numericPid || !isPidAlive(numericPid)) return;
  appendControlLog(profileId, `Force stopping ${label} PID ${numericPid}`, "WARN");
  const taskkillArgs = ["/PID", String(numericPid), "/T", "/F"];
  try {
    if (process.platform === "win32") {
      try {
        await execFileAsync("taskkill.exe", taskkillArgs, { timeout: 10000, windowsHide: true });
      } catch (firstError) {
        appendControlLog(
          profileId,
          `Direct taskkill for PID ${numericPid} failed; requesting administrator permission.`,
          "WARN",
        );
        const escapedArgs = taskkillArgs.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
        const elevateScript = `$p = Start-Process -FilePath 'taskkill.exe' -ArgumentList @(${escapedArgs}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
        try {
          await execFileAsync(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", elevateScript],
            { timeout: 30000, windowsHide: true },
          );
        } catch (elevatedError) {
          throw new Error(
            `无法结束 PID ${numericPid}。直接结束失败：${firstError.message}；管理员结束失败或被取消：${elevatedError.message}`,
          );
        }
      }
    } else {
      try {
        process.kill(-numericPid, "SIGKILL");
      } catch {
        process.kill(numericPid, "SIGKILL");
      }
    }
    for (let attempt = 0; attempt < 12 && isPidAlive(numericPid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (isPidAlive(numericPid)) {
      throw new Error(`PID ${numericPid} 在 3 秒后仍在运行`);
    }
  } catch (error) {
    appendControlLog(profileId, `Force stop PID ${numericPid} failed: ${error.message}`, "ERROR");
    throw error;
  }
}

async function stopProfileProcessOnPort(profileId, port, snapshot = null) {
  if (!port) return;
  const profile = getRuntimeProfile(profileId, snapshot);
  const pids = await getPortPids(port);
  for (const pid of pids) {
    const command = await getProcessCommand(pid);
    if (processLooksOwnedByProfile(command, profile)) {
      await stopPid(profileId, pid, `port ${port}`);
    }
  }
}

async function cleanupProfilePorts(profileId, profile, previous = {}) {
  const ports = new Set([
    previous.gatewayPort,
    previous.webPort,
    profile.gatewayPort,
    profile.webPort,
  ].map(Number).filter(Boolean));
  for (const port of ports) {
    await stopProfileProcessOnPort(profileId, port, previous);
  }
}

async function runLogged(profileId, command, args, cwd, outPath, errPath, label, envPatch = {}) {
  mkdirp(path.dirname(outPath));
  appendControlLog(profileId, `Running ${label}`);
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...envPatch },
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(command),
      stdio: ["ignore", out, err],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      fs.closeSync(out);
      fs.closeSync(err);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

function spawnLogged(profileId, command, args, cwd, outPath, errPath, label, envPatch = {}) {
  mkdirp(path.dirname(outPath));
  appendControlLog(profileId, `Starting ${label}`);
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...envPatch },
    detached: process.platform !== "win32",
    windowsHide: true,
    shell: process.platform === "win32" && /\.cmd$/i.test(command),
    stdio: ["ignore", out, err],
  });
  fs.closeSync(out);
  fs.closeSync(err);
  child.on("error", (e) => appendControlLog(profileId, `${label} spawn error: ${e.message}`, "ERROR"));
  child.on("exit", (code) => appendControlLog(profileId, `${label} exited with code ${code}`, code === 0 ? "INFO" : "WARN"));
  appendControlLog(profileId, `${label} PID ${child.pid}`);
  return child;
}

function packageInstallPath(dir, packageName) {
  return path.join(dir, "node_modules", ...String(packageName || "").split("/").filter(Boolean));
}

function missingPackageDependencies(dir) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const names = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  return [...new Set(names)].filter((name) => !fs.existsSync(packageInstallPath(dir, name)));
}

async function ensureDependencies(profileId, dir, name, outLog, errLog) {
  const missing = missingPackageDependencies(dir);
  if (fs.existsSync(path.join(dir, "node_modules")) && !missing.length) return;
  const message = missing.length
    ? `Installing missing ${name} dependencies: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` and ${missing.length - 6} more` : ""}`
    : `Installing ${name} dependencies`;
  writeProfileState(profileId, { phase: "installing", message });
  appendControlLog(profileId, message);
  const npmCommand = await findNpm();
  const npmCli = getNpmCliPath(npmCommand);
  if (npmCli) {
    await runLogged(profileId, await findNode(), [npmCli, "install"], dir, outLog, errLog, `npm install (${name})`);
  } else {
    await runLogged(profileId, npmCommand, ["install"], dir, outLog, errLog, `npm install (${name})`);
  }
}

async function rebuildGatewaySqliteBinding(profileId, gatewayDir, outLog, errLog) {
  writeProfileState(profileId, {
    phase: "native-runtime",
    message: "Rebuilding Gateway SQLite native dependency for the selected Node runtime",
  });
  appendControlLog(
    profileId,
    `Gateway SQLite native binding is incompatible with ${nodePath}; rebuilding better-sqlite3`,
    "WARN",
  );
  const npmCommand = await findNpm();
  const npmCli = getNpmCliPath(npmCommand);
  if (npmCli) {
    await runLogged(
      profileId,
      nodePath,
      [npmCli, "rebuild", "better-sqlite3"],
      gatewayDir,
      outLog,
      errLog,
      "npm rebuild better-sqlite3 (gateway)",
    );
  } else {
    await runLogged(
      profileId,
      npmCommand,
      ["rebuild", "better-sqlite3"],
      gatewayDir,
      outLog,
      errLog,
      "npm rebuild better-sqlite3 (gateway)",
    );
  }
}

async function ensureGatewayNativeRuntime(profileId, profile, gatewayDir, outLog, errLog) {
  const result = await ensureGatewaySqliteRuntime({
    nodeExecutable: nodePath,
    gatewayDirectory: gatewayDir,
    rebuild: profile.source
      ? () => rebuildGatewaySqliteBinding(profileId, gatewayDir, outLog, errLog)
      : null,
  });
  if (result.repaired) {
    appendControlLog(profileId, "Gateway SQLite native binding rebuild verified successfully");
  }
}

function syncPairRoots(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID) {
  const id = normalizeProfileId(profileId);
  if (!isDevelopmentProfileId(id)) return null;
  const productionRoot = profileConfigs[PRODUCTION_PROFILE_ID]?.repoRoot || "";
  const developmentRoot = profileConfigs[id]?.repoRoot || "";
  if (!productionRoot || !developmentRoot) return null;
  if (!isValidRepoRoot(productionRoot) || !isValidRepoRoot(developmentRoot)) return null;
  if (normalizeText(productionRoot) === normalizeText(developmentRoot)) return null;
  return { productionRoot, developmentRoot, profileId: id };
}

function dbOptionsFromSelection(selected = {}) {
  return {
    adminUsers: !!selected.adminUsers,
    projectDefs: !!(selected.sharedProjectDefs || selected.configProjectDefs),
    dingtalkMsgConfig: !!(selected.sharedDingtalkMsgConfig || selected.configDingtalkMsgConfig),
    keywordMappings: !!selected.keywordMappings,
    vehicleMap: !!selected.vehicleMap,
    replaceVehicleMap: !!selected.vehicleMap && selected.replaceVehicleMap === true,
    statusMap: !!selected.statusMap,
    configMemory: !!selected.configMemory,
    lessons: !!selected.lessons,
  };
}

function developmentRootForManualSync(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID) {
  const id = normalizeProfileId(profileId);
  if (!isDevelopmentProfileId(id)) throw new Error("Choose a development environment first.");
  const developmentRoot = profileConfigs[id]?.repoRoot || "";
  if (!developmentRoot || !isValidRepoRoot(developmentRoot)) {
    throw new Error(`Configure the ${profileDef(id).label} repository path first.`);
  }
  return developmentRoot;
}

// 把 source 工程的 apiEngines 推送到"正在运行"的 target gateway（PUT /api/config），
// 让目标网关内存配置即时生效。文件合并已由 sync-api-engines.cjs 完成；但运行中的网关不会重载
// 配置文件，且下次保存配置时会用内存值覆盖文件，导致同步"没有效果"。此处推送保证内存与文件一致。
async function pushApiEnginesToRunningTarget(targetRoot, sourceRoot) {
  const targetProfileId = findProfileByRoot(targetRoot);
  if (!targetProfileId) return { ok: true, skipped: true, reason: "target not a managed profile" };
  const current = profileState(targetProfileId);
  const targetProfile = getRuntimeProfile(targetProfileId);
  const port = Number(current.gatewayPort || targetProfile.gatewayPort || 0);
  if (!port) return { ok: true, skipped: true, reason: "target port unknown" };
  const healthy = await httpHealthOk(`http://127.0.0.1:${port}/api/health`, 1500);
  if (!healthy) {
    return current.status === "running"
      ? { ok: false, error: `target gateway :${port} is marked running but is not healthy` }
      : { ok: true, skipped: true, reason: "target gateway not running" };
  }
  let sourceEngines = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "gateway", "config.json"), "utf8") || "{}");
    sourceEngines = cfg.apiEngines || {};
  } catch (err) {
    return { ok: false, error: `failed to read source apiEngines: ${err.message}` };
  }
  if (!Object.keys(sourceEngines).length) return { ok: true, skipped: true, reason: "no source apiEngines" };
  const push = await syncApiEnginesToGateway(`http://127.0.0.1:${port}`, sourceEngines, { timeoutMs: 6000 });
  return { ...push, port };
}

async function syncDevelopmentDataToRoot({ profileId = PRIMARY_DEVELOPMENT_PROFILE_ID, targetRoot, options = {}, direction, stateKey, targetLabel }) {
  const id = normalizeProfileId(profileId);
  const developmentRoot = developmentRootForManualSync(id);
  const normalizedTarget = path.resolve(String(targetRoot || ""));
  if (!normalizedTarget) throw new Error(`Configure the ${targetLabel} path first.`);
  if (samePath(developmentRoot, normalizedTarget)) {
    throw new Error(`${profileDef(id).label} and ${targetLabel} paths must be different.`);
  }
  const selected = options && typeof options === "object" ? options : {};
  const anySelected = Object.values(selected).some(Boolean);
  if (!anySelected) throw new Error(`Select at least one data group to sync to ${targetLabel}.`);

  await findNode();
  const script = path.join(__dirname, "scripts", "sync-dev-profile-data.cjs");
  const dbOptions = dbOptionsFromSelection(selected);
  const needsDb = Object.values(dbOptions).some(Boolean);
  let dbResult = { ok: true, skipped: true, reason: "no database keys selected" };
  if (needsDb) {
    const { stdout } = await execFileAsync(nodePath, [script, developmentRoot, normalizedTarget, JSON.stringify(dbOptions)], {
      timeout: 15000,
      windowsHide: true,
    });
    try { dbResult = JSON.parse(String(stdout || "").trim() || "{}"); } catch { dbResult = { ok: true, raw: stdout }; }
    if (dbResult.ok === false) throw new Error(dbResult.error || `${direction} data sync failed`);
  }

  // API 引擎配置（apiEngines）走 gateway/config.json 合并，与数据库同步独立。
  // 增量合并：source 同名引擎覆盖 target（含 apiKey），target 独有引擎保留，_delete 删自定义引擎。defaultEngine 不同步。
  const needsApiEngines = !!selected.apiEngines;
  let apiEnginesResult = { ok: true, skipped: true, reason: "api engines not selected" };
  if (needsApiEngines) {
    const apiScript = path.join(__dirname, "scripts", "sync-api-engines.cjs");
    const { stdout: apiStdout } = await execFileAsync(nodePath, [apiScript, developmentRoot, normalizedTarget], {
      timeout: 15000,
      windowsHide: true,
    });
    try { apiEnginesResult = JSON.parse(String(apiStdout || "").trim() || "{}"); } catch { apiEnginesResult = { ok: true, raw: apiStdout }; }
    if (apiEnginesResult.ok === false) throw new Error(apiEnginesResult.error || `${direction} api engine sync failed`);
    // 文件已合并。若 target 网关正在运行，再经 HTTP 推送一次，使内存配置即时生效，避免运行中网关不重载文件、
    // 下次保存时覆盖掉同步结果——这正是“同步没有效果”的根因。
    const pushResult = await pushApiEnginesToRunningTarget(normalizedTarget, developmentRoot);
    if (pushResult.ok === false) {
      throw new Error(pushResult.error || `${direction} api engines were not applied to the running target gateway`);
    }
    apiEnginesResult = { ...apiEnginesResult, push: pushResult };
  }

  const result = {
    ok: true,
    profileId: id,
    direction,
    target: normalizedTarget,
    syncedAt: new Date().toISOString(),
    db: dbResult,
    apiEngines: apiEnginesResult,
    options: selected,
  };
  writeProfileState(id, { [stateKey]: result });
  appendControlLog(id, `Manual ${direction} sync completed: ${JSON.stringify({ db: dbResult, apiEngines: apiEnginesResult, target: normalizedTarget })}`);
  return result;
}

async function syncSharedDatabaseToDevelopment(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID) {
  const pair = syncPairRoots(profileId);
  if (!pair) return { ok: true, skipped: true, reason: "sync roots not configured" };
  const sourceDb = path.join(pair.productionRoot, "gateway", "db", "data.db");
  const targetDb = path.join(pair.developmentRoot, "gateway", "db", "data.db");
  if (!fs.existsSync(sourceDb) || !fs.existsSync(targetDb)) {
    return { ok: true, skipped: true, reason: "database missing", sourceDb: fs.existsSync(sourceDb), targetDb: fs.existsSync(targetDb) };
  }
  await findNode();
  const script = path.join(__dirname, "scripts", "sync-dev-profile-data.cjs");
  const { stdout } = await execFileAsync(nodePath, [script, pair.productionRoot, pair.developmentRoot], {
    timeout: 15000,
    windowsHide: true,
  });
  let result = {};
  try { result = JSON.parse(String(stdout || "").trim() || "{}"); } catch { result = { ok: true, raw: stdout }; }
  if (result.ok === false) throw new Error(result.error || "profile data sync failed");
  appendControlLog(pair.profileId, `Synced shared profile data to development repo: ${String(stdout || "").trim()}`);
  return result;
}

function isManualDevelopmentSyncRunning(profileId = "") {
  const suffix = profileId ? `:${profileId}` : "";
  return Object.entries(operations).some(([key, value]) => {
    if (!value) return false;
    if (suffix) return key === `__syncToProduction${suffix}` || key === `__syncToDesktopRuntime${suffix}`;
    return key.startsWith("__syncToProduction:") || key.startsWith("__syncToDesktopRuntime:");
  });
}

async function syncProductionDataToDevelopment({ includeDb = true, profileId = PRIMARY_DEVELOPMENT_PROFILE_ID } = {}) {
  const id = normalizeProfileId(profileId);
  if (!isDevelopmentProfileId(id)) return { ok: true, skipped: true, reason: "not a development profile" };
  if (isManualDevelopmentSyncRunning(id)) {
    const skipped = {
      lastSyncAt: new Date().toISOString(),
      skipped: true,
      reason: "manual development sync is running",
    };
    writeProfileState(id, { sync: skipped });
    return skipped;
  }
  let dbResult = { ok: true, skipped: true, reason: "database sync disabled" };
  if (includeDb) dbResult = await syncSharedDatabaseToDevelopment(id);
  const syncState = {
    lastSyncAt: new Date().toISOString(),
    db: dbResult,
  };
  writeProfileState(id, { sync: syncState });
  return syncState;
}

async function syncProductionDataToAllDevelopments({ includeDb = true } = {}) {
  const results = [];
  for (const id of configuredDevelopmentIds()) {
    const pair = syncPairRoots(id);
    if (!pair) continue;
    try {
      results.push({ profileId: id, result: await syncProductionDataToDevelopment({ includeDb, profileId: id }) });
    } catch (err) {
      appendControlLog(id, `Profile data sync failed: ${err.message}`, "WARN");
      writeProfileState(id, { sync: { ...(profileState(id).sync || {}), lastError: err.message, lastSyncAt: new Date().toISOString() } });
      results.push({ profileId: id, ok: false, error: err.message });
    }
  }
  return results;
}

async function syncDevelopmentDataToProduction(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID, options = {}) {
  const id = normalizeProfileId(profileId);
  const pair = syncPairRoots(id);
  if (!pair) throw new Error(`Configure separate Production and ${profileDef(id).label} repository paths first.`);
  return syncDevelopmentDataToRoot({
    profileId: id,
    targetRoot: pair.productionRoot,
    options,
    direction: "development-to-production",
    stateKey: "manualSyncToProduction",
    targetLabel: "Production",
  });
}

async function syncDevelopmentDataToDesktopRuntime(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID, options = {}) {
  const id = normalizeProfileId(profileId);
  const targetRoot = normalizeDesktopRuntimeRoot(desktopRuntimeRoot) || detectDesktopRuntimeRoot();
  if (!targetRoot) {
    throw new Error("Configure the Desktop Runtime path first.");
  }
  return syncDevelopmentDataToRoot({
    profileId: id,
    targetRoot,
    options,
    direction: "development-to-desktop-runtime",
    stateKey: "manualSyncToDesktopRuntime",
    targetLabel: "Desktop Runtime",
  });
}

async function adoptCurrentServicesIfHealthy(profileId, options = {}) {
  const id = normalizeProfileId(profileId);
  const current = profileState(id);
  const profile = getRuntimeProfile(id, current);
  const gatewayPort = Number(current.gatewayPort || 0);
  const webPort = Number(current.webPort || (profile.bundled ? gatewayPort : profile.webPort) || 0);
  if (!gatewayPort || !webPort) return false;
  return tryAdoptExisting(id, gatewayPort, webPort, {
    timeoutMs: options.timeoutMs || 1200,
    allowPartialOwnership: true,
    allowDegraded: options.allowDegraded !== false,
    blockOnUnknown: !!options.blockOnUnknown,
  });
}

async function refreshProfileRuntimeHealth(profileId) {
  const id = normalizeProfileId(profileId);
  if (runtimeHealthChecks.has(id)) return false;
  runtimeHealthChecks.add(id);
  try {
    return await refreshProfileRuntimeHealthOnce(id);
  } finally {
    runtimeHealthChecks.delete(id);
  }
}

async function refreshProfileRuntimeHealthOnce(profileId) {
  const id = normalizeProfileId(profileId);
  if (operations[id]) return false;
  const observedGeneration = currentRuntimeHealthGeneration(id);
  const observationIsCurrent = () => canApplyRuntimeHealthObservation(id, observedGeneration);
  const current = profileState(id);
  const status = current.status || "stopped";
  const busy = status === "starting" || status === "stopping" || status === "repo_missing";
  if (busy) return false;

  if (status !== "running") {
    const profile = getRuntimeProfile(id, current);
    if (!profileConfigured(profile)) return false;
    const gatewayPort = Number(current.gatewayPort || profile.gatewayPort || 0);
    const webPort = Number(current.webPort || (profile.bundled ? gatewayPort : profile.webPort) || 0);
    if (!gatewayPort || !webPort) return false;
    const adopted = await tryAdoptExisting(id, gatewayPort, webPort, {
      timeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
      allowPartialOwnership: true,
      allowDegraded: true,
      shouldApplyObservation: observationIsCurrent,
    });
    if (!observationIsCurrent()) return false;
    if (adopted) return true;
    if (await refreshInactivePortFallbacks(id, current, observationIsCurrent)) return true;
    if (!observationIsCurrent()) return false;
    if (isStaleRecordedRuntimeMessage(current.message)) {
      if (!observationIsCurrent()) return false;
      writeProfileState(id, {
        phase: "ready",
        message: "Ready",
        lastError: null,
        gatewayPid: null,
        webPid: null,
        gatewayUrl: null,
        panelUrl: null,
      });
      return true;
    }
    return false;
  }

  const profile = getRuntimeProfile(id, current);
  const gatewayPort = Number(current.gatewayPort || 0);
  const webPort = Number(current.webPort || 0);
  const [gatewayOk, webOk] = gatewayPort && webPort
    ? await Promise.all([
      httpHealthOk(`http://127.0.0.1:${gatewayPort}/api/health`, HEALTH_REQUEST_TIMEOUT_MS),
      httpOk(`http://127.0.0.1:${webPort}`, HEALTH_REQUEST_TIMEOUT_MS),
    ])
    : [false, false];
  if (!observationIsCurrent()) return false;

  if (gatewayOk && webOk) {
    const previousObservation = runtimeHealthObservations.get(id);
    const recordedPidsAlive = isPidAlive(Number(current.gatewayPid || 0))
      && isPidAlive(Number(current.webPid || 0));
    if (!previousObservation && current.phase !== "degraded" && recordedPidsAlive) return false;

    const ownership = recordedPidsAlive
      ? null
      : await inspectProfileRuntime(profile, gatewayPort, webPort, current);
    if (!observationIsCurrent()) return false;
    runtimeHealthObservations.delete(id);
    if (previousObservation?.visible || current.phase === "degraded") {
      appendControlLog(id, "Runtime health recovered; HTTP checks are responding again.");
    }
    if (!observationIsCurrent()) return false;
    const portFallbacks = current.portFallbacks || [];
    const fallbackWarning = portFallbackMessage(portFallbacks);
    writeProfileState(id, {
      status: "running",
      phase: fallbackWarning ? "warning" : "ready",
      message: fallbackWarning || "Services are running in background",
      gatewayPid: ownership?.gateway.ownedPid || current.gatewayPid || null,
      webPid: ownership?.web.ownedPid || current.webPid || null,
      lastError: null,
    });
    return true;
  }

  const ownership = await inspectProfileRuntime(profile, gatewayPort, webPort, current);
  if (!observationIsCurrent()) return false;
  const previousObservation = runtimeHealthObservations.get(id) || {
    missingStreak: 0,
    degradedStreak: 0,
    logKey: "",
    visible: false,
  };
  const decision = evaluateRuntimeHealth({
    gatewayHttpOk: gatewayOk,
    webHttpOk: webOk,
    gatewayEvidence: ownership.gateway.evidence,
    webEvidence: ownership.web.evidence,
    missingStreak: previousObservation.missingStreak,
    missingConfirmations: DEFAULT_MISSING_CONFIRMATIONS,
    degradedStreak: previousObservation.degradedStreak,
    degradedConfirmations: DEFAULT_DEGRADED_CONFIRMATIONS,
  });

  const missing = [
    gatewayOk ? "" : "gateway",
    webOk ? "" : "web panel",
  ].filter(Boolean).join(" and ");
  if (decision.shouldStop) {
    if (!observationIsCurrent()) return false;
    const message = `${missing || "Service"} process and listener evidence remained absent after ${decision.nextMissingStreak} checks.`;
    appendControlLog(id, `Runtime health confirmed services stopped: ${message}`, "WARN");
    runtimeHealthObservations.delete(id);
    if (!observationIsCurrent()) return false;
    writeProfileState(id, {
      status: "stopped",
      phase: "stopped",
      message,
      lastError: null,
      gatewayPid: null,
      webPid: null,
      gatewayUrl: null,
      panelUrl: null,
    });
    return true;
  }

  const message = decision.kind === "degraded"
    ? `HTTP health check is temporarily unavailable for ${missing || "services"}; owned processes are still running.`
    : decision.kind === "degraded_pending"
      ? `HTTP health check missed once for ${missing || "services"}; retrying before showing a warning.`
      : decision.kind === "missing_pending"
        ? `${missing || "Service"} process evidence is missing (${decision.nextMissingStreak}/${DEFAULT_MISSING_CONFIRMATIONS}); waiting for confirmation.`
        : `HTTP health check is inconclusive for ${missing || "services"}; preserving the recorded running state.`;
  const visible = decision.kind !== "degraded_pending";
  const logKey = [
    decision.kind,
    ownership.gateway.evidence,
    ownership.web.evidence,
    decision.nextMissingStreak,
    decision.nextDegradedStreak,
  ].join(":");
  if (visible && previousObservation.logKey !== logKey) {
    appendControlLog(id, `Runtime health degraded without clearing running state: ${message}`, "WARN");
  }
  if (!observationIsCurrent()) return false;
  runtimeHealthObservations.set(id, {
    missingStreak: decision.nextMissingStreak,
    degradedStreak: decision.nextDegradedStreak,
    logKey,
    visible,
  });
  if (!visible) return false;

  const gatewayPid = ownership.gateway.ownedPid || current.gatewayPid || null;
  const webPid = ownership.web.ownedPid || current.webPid || null;
  const stateChanged = current.phase !== "degraded"
    || current.message !== message
    || Number(current.gatewayPid || 0) !== Number(gatewayPid || 0)
    || Number(current.webPid || 0) !== Number(webPid || 0);
  if (!stateChanged) return false;
  if (!observationIsCurrent()) return false;
  writeProfileState(id, {
    status: "running",
    phase: "degraded",
    message,
    gatewayPid,
    webPid,
    lastError: null,
  });
  return true;
}

async function refreshRuntimeProfileStates() {
  await Promise.all(profileIds().map((id) => refreshProfileRuntimeHealth(id)));
}

function startRuntimeHealthTimer() {
  if (runtimeHealthTimer) clearTimeout(runtimeHealthTimer);
  const scheduleNext = (delayMs) => {
    runtimeHealthTimer = setTimeout(async () => {
      try {
        await refreshRuntimeProfileStates();
      } catch (err) {
        appendControlLog(defaultProfileId(), `Runtime health refresh failed: ${err.message}`, "WARN");
      }
      const profiles = Object.values(state.profiles || {});
      const degraded = profiles.some((item) => item.phase === "degraded")
        || runtimeHealthObservations.size > 0
        || Object.keys(operations).length > 0;
      const running = profiles.some((item) => item.status === "running");
      scheduleNext(degraded
        ? HEALTH_CHECK_DEGRADED_MS
        : running
          ? HEALTH_CHECK_ACTIVE_MS
          : HEALTH_CHECK_IDLE_MS);
    }, delayMs);
  };
  scheduleNext(HEALTH_CHECK_DEGRADED_MS);
}

async function tryAdoptExisting(profileId, gatewayPort, webPort, options = {}) {
  const current = profileState(profileId);
  const profile = getRuntimeProfile(profileId, current);
  const timeoutMs = options.timeoutMs || 2000;
  const allowPartialOwnership = !!options.allowPartialOwnership;
  const allowDegraded = !!options.allowDegraded;
  const blockOnUnknown = !!options.blockOnUnknown;
  const shouldApplyObservation = typeof options.shouldApplyObservation === "function"
    ? options.shouldApplyObservation
    : () => true;
  const [gatewayOk, webOk] = await Promise.all([
    httpHealthOk(`http://127.0.0.1:${gatewayPort}/api/health`, timeoutMs),
    httpOk(`http://127.0.0.1:${webPort}`, timeoutMs),
  ]);
  if (!shouldApplyObservation()) return false;
  const ownership = await inspectProfileRuntime(profile, gatewayPort, webPort, current);
  if (!shouldApplyObservation()) return false;
  const startAction = decideStartAction({
    gatewayHttpOk: gatewayOk,
    webHttpOk: webOk,
    gatewayEvidence: ownership.gateway.evidence,
    webEvidence: ownership.web.evidence,
  });
  if (startAction === "defer") {
    if (blockOnUnknown) {
      throw new Error("Existing service ownership could not be verified. Retry Start or use explicit Restart after checking the process.");
    }
    return false;
  }
  if (startAction === "launch" || (startAction === "adopt_degraded" && !allowDegraded)) return false;

  const gatewayPid = ownership.gateway.ownedPid;
  const webPid = ownership.web.ownedPid;
  if (startAction === "adopt_healthy" && (!gatewayPid || !webPid)) {
    if (!allowPartialOwnership || (!gatewayPid && !webPid)) return false;
    appendControlLog(
      profileId,
      `Adopting healthy services with partial process ownership: gateway PID ${gatewayPid || "untracked"}, web PID ${webPid || "untracked"}`,
      "WARN",
    );
  }
  if (startAction === "adopt_degraded") {
    appendControlLog(
      profileId,
      "Adopting owned services while HTTP health checks are temporarily unavailable.",
      "WARN",
    );
  }
  const panelUrl = webPanelUrl(webPort);
  const portFallbacks = await inspectPortFallbacks(profile, gatewayPort, webPort);
  const fallbackWarning = portFallbackMessage(portFallbacks);
  if (fallbackWarning) appendControlLog(profileId, fallbackWarning, "WARN");
  if (!shouldApplyObservation()) return false;
  runtimeHealthObservations.delete(normalizeProfileId(profileId));
  writeProfileState(profileId, {
    status: "running",
    phase: startAction === "adopt_degraded" ? "degraded" : fallbackWarning ? "warning" : "ready",
    message: startAction === "adopt_degraded"
      ? "Adopted existing owned services; health checks are temporarily unavailable"
      : fallbackWarning || (gatewayPid && webPid ? "Adopted existing services" : "Adopted existing healthy services"),
    gatewayPort,
    webPort,
    portFallbacks,
    gatewayPid: gatewayPid || null,
    webPid: webPid || (gatewayPort === webPort ? gatewayPid : null),
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    panelUrl,
    lastError: null,
  });
  return true;
}

function assertDistinctSourceRoot(profileId) {
  const profile = getRuntimeProfile(profileId);
  if (!profile.root) return;
  const duplicate = findProfileByRoot(profile.root, profile.id);
  if (duplicate) {
    throw new Error(`${profile.label} and ${profileDef(duplicate).label} repository paths must be different.`);
  }
}

async function spawnWebPanel(id, profile, gatewayPort, webPort, logs) {
  const webDir = getWebDir(profile);
  const viteCliPath = getViteCliPath(webDir);
  if (!fs.existsSync(viteCliPath)) {
    throw new Error(`Vite CLI was not found. Run npm install in ${webDir}`);
  }
  writeProfileState(id, { phase: "web", message: `Starting web panel :${webPort}` });
  const web = spawnLogged(
    id,
    nodePath,
    [viteCliPath, "--host", "0.0.0.0", "--port", String(webPort), "--strictPort"],
    webDir,
    logs.webOut,
    logs.webErr,
    `${profile.label} web`,
    { VITE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`, AIEFFICIENCY_PROFILE: id },
  );
  ensureProfileProcessBucket(id).web = web;
  if (!await waitHttpOk(`http://127.0.0.1:${webPort}`, 25, web)) {
    await stopPid(id, web.pid, "web");
    throw new Error(startupFailureMessage("Web panel", web, logs.webErr));
  }
  return web;
}

// 已采纳在运行的 gateway（常见于被提升权限启动、命令行读不到的残留网关）但 web 面板缺失时，
// 仅补起 web 面板并指向已采纳的 gateway，避免重复启动 gateway 造成同一 SQLite DB 双写冲突。
async function ensureAdoptedWebPanel(id, profile, logs) {
  if (profile.bundled) return;
  const current = profileState(id);
  const gatewayPort = Number(current.gatewayPort || profile.gatewayPort);
  if (!gatewayPort) return;
  const preferredWebPort = Number(current.webPort || profile.webPort);
  if (preferredWebPort && await httpOk(`http://127.0.0.1:${preferredWebPort}`, 1200)) return;
  appendControlLog(id, "Adopted gateway already running; starting the missing web panel");
  await findNode();
  if (profile.source) {
    await ensureDependencies(id, getWebDir(profile), "web-dashboard", logs.webNpmOut, logs.webNpmErr);
  }
  const webPort = await findFreePort(profile.webPort, profile.webFallbackPorts);
  const webFallback = await inspectPortFallback("web", profile.webPort, webPort);
  const portFallbacks = [
    ...(current.portFallbacks || []).filter((item) => item.service !== "web"),
    ...(webFallback ? [webFallback] : []),
  ];
  const fallbackWarning = portFallbackMessage(portFallbacks);
  if (fallbackWarning) appendControlLog(id, fallbackWarning, "WARN");
  const web = await spawnWebPanel(id, profile, gatewayPort, webPort, logs);
  writeProfileState(id, {
    status: "running",
    phase: fallbackWarning ? "warning" : "ready",
    message: fallbackWarning || "Services are running in background",
    webPort,
    webPid: web.pid,
    portFallbacks,
    panelUrl: webPanelUrl(webPort),
    lastError: null,
  });
}

// 启动兜底：首选端口上已有一个健康的 gateway，但其进程归属无法判定（命令行读不到，常见于被提升
// 权限启动的残留网关）。此时直接采纳该 gateway 并补起缺失的 web 面板，而非阻塞启动或另起一份
// gateway 造成同一 SQLite DB 双写冲突。仅在 Start 路径调用，不影响后台健康检查与 Stop 行为。
async function adoptUnverifiableGateway(id, profile, logs) {
  if (profile.bundled) return false;
  const gatewayPort = Number(profile.gatewayPort);
  const webPort = Number(profile.webPort);
  if (!gatewayPort || !webPort) return false;
  const gatewayHealthy = await httpHealthOk(`http://127.0.0.1:${gatewayPort}/api/health`, 1500);
  if (!gatewayHealthy) return false;
  const ownership = await inspectServiceRuntime(profile, gatewayPort, profileState(id).gatewayPid || 0);
  if (ownership.evidence !== RUNTIME_EVIDENCE.UNKNOWN) return false;
  const listenerPids = ownership.listenerPids || [];
  const gatewayPid = listenerPids[0] || null;
  const webHealthy = await httpOk(`http://127.0.0.1:${webPort}`, 1200);
  appendControlLog(
    id,
    `Adopting unverifiable gateway on :${gatewayPort} (PID ${gatewayPid || "unknown"}); process command line is unreadable.`,
    "WARN",
  );
  writeProfileState(id, {
    status: "running",
    phase: webHealthy ? "ready" : "degraded",
    message: webHealthy ? "Adopted existing services" : "Adopted existing gateway; starting missing web panel",
    gatewayPort,
    webPort,
    gatewayPid,
    webPid: null,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    panelUrl: webPanelUrl(webPort),
    lastError: null,
  });
  if (!webHealthy) {
    await ensureAdoptedWebPanel(id, profile, logs);
  }
  return true;
}

async function startServices(profileId, { openPanel = false } = {}) {
  const id = normalizeProfileId(profileId);
  invalidateRuntimeHealthObservations(id);
  const profile = getRuntimeProfile(id);
  if (!profileConfigured(profile)) {
    throw new Error(`${profile.label} repository root is not configured. Choose a valid AIEfficiency folder.`);
  }
  assertDistinctSourceRoot(id);

  const logs = newLogContext(id);
  writeProfileState(id, {
    status: "starting",
    phase: "initializing",
    message: "Initializing service startup",
    portFallbacks: [],
    logs,
    startedAt: new Date().toISOString(),
    lastError: null,
  });

  if (await adoptCurrentServicesIfHealthy(id, {
    timeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
    allowDegraded: true,
    blockOnUnknown: false,
  })) {
    await ensureAdoptedWebPanel(id, profile, logs);
    if (openPanel && profileState(id).panelUrl) shell.openExternal(profileState(id).panelUrl);
    return;
  }

  if (await tryAdoptExisting(id, profile.gatewayPort, profile.bundled ? profile.gatewayPort : profile.webPort, {
    timeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
    allowPartialOwnership: true,
    allowDegraded: true,
    blockOnUnknown: false,
  })) {
    await ensureAdoptedWebPanel(id, profile, logs);
    if (openPanel && profileState(id).panelUrl) shell.openExternal(profileState(id).panelUrl);
    return;
  }

  if (await adoptUnverifiableGateway(id, profile, logs)) {
    if (openPanel && profileState(id).panelUrl) shell.openExternal(profileState(id).panelUrl);
    return;
  }

  const gatewayDir = getGatewayDir(profile);
  const webDir = getWebDir(profile);
  await findNode();
  if (profile.source) {
    await ensureDependencies(id, gatewayDir, "gateway", logs.gatewayNpmOut, logs.gatewayNpmErr);
    await ensureDependencies(id, webDir, "web-dashboard", logs.webNpmOut, logs.webNpmErr);
  }
  await ensureGatewayNativeRuntime(id, profile, gatewayDir, logs.gatewayNpmOut, logs.gatewayNpmErr);

  writeProfileState(id, { phase: "ports", message: "Checking isolated ports" });
  await cleanupProfilePorts(id, profile, profileState(id));
  const gatewayPort = await findFreePort(profile.gatewayPort, profile.gatewayFallbackPorts);
  const webPort = profile.bundled ? gatewayPort : await findFreePort(profile.webPort, profile.webFallbackPorts);
  const portFallbacks = await inspectPortFallbacks(profile, gatewayPort, webPort);
  const fallbackWarning = portFallbackMessage(portFallbacks);
  if (fallbackWarning) {
    appendControlLog(id, fallbackWarning, "WARN");
  }

  writeProfileState(id, {
    phase: "gateway",
    message: fallbackWarning || `Starting gateway :${gatewayPort}`,
    gatewayPort,
    webPort,
    portFallbacks,
  });
  const gateway = spawnLogged(
    id,
    nodePath,
    [path.join(gatewayDir, "server.js")],
    gatewayDir,
    logs.gatewayOut,
    logs.gatewayErr,
    `${profile.label} gateway`,
    {
      PORT: String(gatewayPort),
      ELECTRON: "1",
      AIEFFICIENCY_PROFILE: id,
      DEVBENCH_SYNC_SCOPE: resolveProfileSyncScope(profile),
    },
  );
  ensureProfileProcessBucket(id).gateway = gateway;
  if (!await waitHttpOk(`http://127.0.0.1:${gatewayPort}/api/health`, 25, gateway)) {
    await stopPid(id, gateway.pid, "gateway");
    throw new Error(startupFailureMessage("Gateway", gateway, logs.gatewayErr));
  }
  if (isDevelopmentProfileId(id)) {
    writeProfileState(id, { phase: "sync", message: "Syncing shared production data to development", gatewayPid: gateway.pid });
    await syncProductionDataToDevelopment({ includeDb: true, profileId: id }).catch((err) => {
      appendControlLog(id, `Shared data sync failed after gateway start: ${err.message}`, "WARN");
      writeProfileState(id, { sync: { ...(profileState(id).sync || {}), lastError: err.message, lastSyncAt: new Date().toISOString() } });
    });
  }

  let web = null;
  if (profile.source) {
    try {
      web = await spawnWebPanel(id, profile, gatewayPort, webPort, logs);
    } catch (err) {
      await stopPid(id, gateway.pid, "gateway");
      throw err;
    }
  }

  const panelUrl = webPanelUrl(webPort);
  writeProfileState(id, {
    status: "running",
    phase: fallbackWarning ? "warning" : "ready",
    message: fallbackWarning || "Services are running in background",
    gatewayPort,
    webPort,
    portFallbacks,
    gatewayPid: gateway.pid,
    webPid: web ? web.pid : gateway.pid,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    panelUrl,
    lastError: null,
  });
  if (id === PRODUCTION_PROFILE_ID) {
    syncProductionDataToAllDevelopments({ includeDb: true }).catch((err) => {
      appendControlLog(PRODUCTION_PROFILE_ID, `Post-start development sync failed: ${err.message}`, "WARN");
    });
  }
  if (openPanel) shell.openExternal(panelUrl);
}

async function stopServices(profileId) {
  const id = normalizeProfileId(profileId);
  invalidateRuntimeHealthObservations(id);
  const previous = { ...profileState(id) };
  const profile = getRuntimeProfile(id, previous);
  writeProfileState(id, { status: "stopping", phase: "stopping", message: "Stopping services", lastError: null });

  if (panelWindows[id] && !panelWindows[id].isDestroyed()) {
    panelWindows[id].close();
  }
  await stopPid(id, Number(previous.webPid || 0), "web");
  await stopPid(id, Number(previous.gatewayPid || 0), "gateway");
  await cleanupProfilePorts(id, profile, previous);
  children[id] = { gateway: null, web: null };

  writeProfileState(id, {
    status: "stopped",
    phase: "stopped",
    message: "Services stopped",
    gatewayPid: null,
    webPid: null,
    gatewayUrl: null,
    panelUrl: null,
    portFallbacks: [],
  });
}

async function forceReleasePreferredPort(profileId, requestedPort) {
  const id = normalizeProfileId(profileId);
  const current = profileState(id);
  const preferredPort = Number(requestedPort || 0);
  const fallback = (current.portFallbacks || []).find(
    (item) => Number(item.preferredPort || 0) === preferredPort,
  );
  const profileEligibility = evaluateForceReleaseProfileState({
    configured: profileConfigured(getRuntimeProfile(id, current)),
    status: current.status,
    hasFallback: !!fallback && !!preferredPort,
  });
  if (profileEligibility.reason === "profile_not_configured") {
    throw new Error("当前环境的仓库未配置，不能释放端口并启动服务");
  }
  if (profileEligibility.reason === "profile_busy") {
    throw new Error("当前环境正在启动或停止，请稍后重试");
  }
  if (!profileEligibility.allowed) {
    throw new Error("端口回退状态已经变化，请刷新控制面板后重试");
  }

  const expectedEligiblePids = new Set(
    (fallback.occupants || [])
      .filter((item) => item.forceReleaseEligible)
      .map((item) => Number(item.pid || 0))
      .filter(Boolean),
  );
  const live = await inspectPortOccupants(preferredPort, fallback.service);
  if (!live.known) {
    throw new Error(`无法确认端口 ${preferredPort} 当前占用者，未执行强制结束`);
  }
  const candidates = live.occupants.filter(
    (item) => item.forceReleaseEligible && expectedEligiblePids.has(Number(item.pid)),
  );
  if (!candidates.length) {
    throw new Error("未发现仍在监听且可安全识别的旧 AIEfficiency Node 服务，未结束任何进程");
  }
  const blockers = live.occupants.filter((item) => !candidates.some((candidate) => candidate.pid === item.pid));
  if (blockers.length) {
    const description = blockers.map((item) => `${item.name} PID ${item.pid}`).join("、");
    throw new Error(`端口 ${preferredPort} 还有受保护、受管或无法识别的占用者：${description}`);
  }

  const serviceLabel = fallback.service === "web" ? "网页" : "Gateway";
  const processSummary = candidates.map((item) => `${item.name} PID ${item.pid}`).join("、");
  const dialogOptions = {
    type: "warning",
    buttons: ["取消", "强制结束并重启"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "确认强制结束旧进程",
    message: `强制结束占用 ${serviceLabel} 首选端口 ${preferredPort} 的旧进程？`,
    detail: `${processSummary}\n\n系统只会处理仍监听该端口、且识别为未受管 AIEfficiency Node 服务的进程。强制结束可能丢失旧进程中尚未保存的工作；成功后当前 ${current.label || id} 服务会自动重启并尝试恢复首选端口。`,
  };
  const confirmation = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  if (confirmation.response !== 1) {
    appendControlLog(id, `Force release of preferred port ${preferredPort} cancelled by user.`);
    return { ok: false, cancelled: true, preferredPort };
  }

  const verified = await inspectPortOccupants(preferredPort, fallback.service);
  const verifiedByPid = new Map(verified.occupants.map((item) => [Number(item.pid), item]));
  if (
    !verified.known
    || candidates.some((item) => {
      const latest = verifiedByPid.get(Number(item.pid));
      return !latest
        || latest.name !== item.name
        || latest.command !== item.command;
    })
    || verified.occupants.some((item) => !item.forceReleaseEligible || !expectedEligiblePids.has(Number(item.pid)))
  ) {
    throw new Error("确认期间端口占用者发生变化，为避免误杀已取消操作");
  }

  for (const candidate of candidates) {
    await forceTerminateProcessTree(id, candidate.pid, `unmanaged port ${preferredPort} occupant`);
  }
  try {
    if (profileEligibility.stopBeforeStart) {
      await stopServices(id);
    }
    const afterStop = await waitForStablePortRelease(preferredPort);
    if (!afterStop.known) {
      throw new Error(`无法确认端口 ${preferredPort} 是否已稳定释放，未重启当前服务`);
    }
    if (!afterStop.stable && afterStop.pids.length) {
      const rebound = await inspectPortOccupants(preferredPort, fallback.service);
      const description = rebound.occupants.length
        ? rebound.occupants.map((item) => `${item.name} PID ${item.pid}`).join("、")
        : afterStop.pids.map((pid) => `PID ${pid}`).join("、");
      throw new Error(`端口 ${preferredPort} 在旧进程结束后被 ${description} 重新占用；可能存在父进程或看门狗，当前服务未再次回退启动`);
    }
    if (!afterStop.stable) {
      throw new Error(`端口 ${preferredPort} 在等待期间未能连续保持空闲，当前服务未再次回退启动`);
    }
    appendControlLog(
      id,
      `Preferred port ${preferredPort} remained free; restarting ${current.label || id} to reclaim it.`,
      "WARN",
    );
    await startServices(id);
  } catch (error) {
    writeProfileState(id, {
      status: "failed",
      phase: "failed",
      message: error.message,
      lastError: error.message,
    });
    throw error;
  }
  const restarted = profileState(id);
  const actualPort = fallback.service === "web" ? restarted.webPort : restarted.gatewayPort;
  const restored = Number(actualPort || 0) === preferredPort;
  const remainingFallbacks = (restarted.portFallbacks || []).map((item) => ({
    service: item.service,
    preferredPort: item.preferredPort,
    actualPort: item.actualPort,
    occupantPids: (item.occupants || []).map((occupant) => occupant.pid),
  }));
  appendControlLog(
    id,
    restored
      ? `${serviceLabel} preferred port ${preferredPort} restored after force release.`
      : `${serviceLabel} restarted on ${actualPort}; preferred port ${preferredPort} was not restored.`,
    restored ? "INFO" : "WARN",
  );
  return {
    ok: true,
    cancelled: false,
    killedPids: candidates.map((item) => item.pid),
    preferredPort,
    actualPort,
    restored,
    remainingFallbacks,
  };
}

async function runOperation(profileId, name, fn) {
  const id = normalizeProfileId(profileId);
  if (operations[id]) return operations[id];
  invalidateRuntimeHealthObservations(id);
  operations[id] = (async () => {
    try {
      await fn();
    } catch (err) {
      appendControlLog(id, err.stack || err.message, "ERROR");
      writeProfileState(id, { status: "failed", phase: "failed", message: "Operation failed", lastError: err.message });
    } finally {
      operations[id] = null;
    }
  })();
  return operations[id];
}

async function runInteractiveProfileOperation(profileId, name, fn) {
  const id = normalizeProfileId(profileId);
  if (operations[id]) throw new Error(`${profileDef(id).label} 正在执行其他操作，请稍后重试`);
  invalidateRuntimeHealthObservations(id);
  const operation = (async () => {
    try {
      return await fn(id);
    } finally {
      operations[id] = null;
    }
  })();
  operations[id] = operation;
  return operation;
}

async function runGlobalOperation(name, fn) {
  if (operations.__global) return operations.__global;
  operations.__global = (async () => {
    try {
      await fn();
    } finally {
      operations.__global = null;
    }
  })();
  return operations.__global;
}

async function runManualSyncToProduction(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID, options = {}) {
  if (profileId && typeof profileId === "object") {
    options = profileId;
    profileId = PRIMARY_DEVELOPMENT_PROFILE_ID;
  }
  const id = normalizeProfileId(profileId);
  const opKey = `__syncToProduction:${id}`;
  if (operations[opKey]) return operations[opKey];
  operations[opKey] = (async () => {
    writeProfileState(id, {
      manualSyncToProduction: {
        status: "running",
        startedAt: new Date().toISOString(),
        options,
      },
    });
    try {
      const result = await syncDevelopmentDataToProduction(id, options);
      return result;
    } catch (err) {
      const result = {
        ok: false,
        profileId: id,
        error: err.message || String(err),
        syncedAt: new Date().toISOString(),
        options,
      };
      appendControlLog(id, `Manual development-to-production sync failed: ${result.error}`, "WARN");
      writeProfileState(id, { manualSyncToProduction: result });
      return result;
    } finally {
      operations[opKey] = null;
    }
  })();
  return operations[opKey];
}

async function runManualSyncToDesktopRuntime(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID, options = {}) {
  if (profileId && typeof profileId === "object") {
    options = profileId;
    profileId = PRIMARY_DEVELOPMENT_PROFILE_ID;
  }
  const id = normalizeProfileId(profileId);
  const opKey = `__syncToDesktopRuntime:${id}`;
  if (operations[opKey]) return operations[opKey];
  operations[opKey] = (async () => {
    writeProfileState(id, {
      manualSyncToDesktopRuntime: {
        status: "running",
        startedAt: new Date().toISOString(),
        options,
      },
    });
    try {
      const result = await syncDevelopmentDataToDesktopRuntime(id, options);
      return result;
    } catch (err) {
      const result = {
        ok: false,
        profileId: id,
        error: err.message || String(err),
        syncedAt: new Date().toISOString(),
        options,
      };
      appendControlLog(id, `Manual development-to-desktop-runtime sync failed: ${result.error}`, "WARN");
      writeProfileState(id, { manualSyncToDesktopRuntime: result });
      return result;
    } finally {
      operations[opKey] = null;
    }
  })();
  return operations[opKey];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 780,
    minWidth: 720,
    minHeight: 640,
    show: true,
    alwaysOnTop: true,
    resizable: true,
    title: "AIEfficiency Service Control",
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.on("did-finish-load", sendState);
  // 控制面板主窗口外链兜底：与 panelWindows 一致，只放行规范 http/https，
  // mailto/其它协议 window.open 或顶层导航一律不打开（避免唤起本机邮箱/文件/其它应用）。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safe = normalizeExternalUrl(url);
    if (safe) shell.openExternal(safe);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!normalizeExternalUrl(url)) event.preventDefault();
  });
}

async function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
  await refreshRuntimeProfileStates();
  sendState();
}

async function openWebTerminal(profileId) {
  const id = normalizeProfileId(profileId);
  await refreshProfileRuntimeHealth(id);
  const current = profileState(id);
  if (current.status === "running" && current.panelUrl) shell.openExternal(current.panelUrl);
}

async function openDesktopTerminal(profileId) {
  const id = normalizeProfileId(profileId);
  await refreshProfileRuntimeHealth(id);
  const current = profileState(id);
  if (current.status !== "running" || !current.panelUrl) return;
  if (panelWindows[id] && !panelWindows[id].isDestroyed()) {
    panelWindows[id].show();
    panelWindows[id].focus();
    return;
  }
  panelWindows[id] = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: `AIEfficiency ${current.label || id}`,
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  panelWindows[id].loadURL(current.panelUrl);
  panelWindows[id].once("ready-to-show", () => panelWindows[id] && panelWindows[id].show());
  panelWindows[id].webContents.setWindowOpenHandler(({ url }) => {
    // 外链协议白名单：只放行规范 http/https（normalizeExternalUrl 统一校验），
    // 其余协议（mailto/file:/自定义协议）一律不打开，避免误唤起本机邮箱/文件/其它应用（“一直打开邮箱”）。
    const safe = normalizeExternalUrl(url);
    if (safe) shell.openExternal(safe);
    return { action: "deny" };
  });
  // 顶层导航兜底：mailto 等外部协议若以 <a target=_self>/location.href 形式触发导航，
  // 不经过 setWindowOpenHandler；非 http/https 一律拦截，避免唤起系统邮箱。
  panelWindows[id].webContents.on("will-navigate", (event, url) => {
    if (!normalizeExternalUrl(url)) event.preventDefault();
  });
  panelWindows[id].on("closed", () => {
    panelWindows[id] = null;
  });
}

function profileMenu(profileId) {
  const id = normalizeProfileId(profileId);
  const current = profileState(id);
  const running = current.status === "running";
  const busy = current.status === "starting" || current.status === "stopping" || !!operations[id];
  const missing = current.status === "repo_missing";
  return {
    label: current.label || profileDef(id).label,
    submenu: [
      { label: "Open Web", enabled: running && !!current.panelUrl, click: () => openWebTerminal(id) },
      { label: "Open Desktop", enabled: running && !!current.panelUrl, click: () => openDesktopTerminal(id) },
      { type: "separator" },
      { label: "Start", enabled: !busy && !running && !missing, click: () => runOperation(id, "start", () => startServices(id)) },
      { label: "Stop", enabled: !busy && running, click: () => runOperation(id, "stop", () => stopServices(id)) },
      { label: "Restart", enabled: !busy && !missing, click: () => runOperation(id, "restart", async () => { await stopServices(id); await startServices(id); }) },
      { type: "separator" },
      { label: "Logs", click: () => shell.openPath(current.logDir || getProfileLogDir(getRuntimeProfile(id))) },
      { label: "Repo", enabled: !!current.root, click: () => current.root && shell.openPath(current.root) },
      { label: "Choose Repo", click: () => chooseRepoRoot(id) },
      ...(isDevelopmentProfileId(id) ? [
        {
          label: "Sync Selected Data To Production",
          enabled: !!syncPairRoots(id),
          click: showWindow,
        },
        {
          label: "Remove Development Environment",
          enabled: !busy && !running,
          click: () => removeDevelopmentProfile(id).catch((err) => dialog.showErrorBox("Remove failed", err.message)),
        },
      ] : []),
    ],
  };
}

function rebuildTrayMenu() {
  if (!tray) return;
  const template = [
    { label: "Open Control", click: showWindow },
    { label: "Add Development Environment", click: () => addDevelopmentProfileFromDialog().catch((err) => dialog.showErrorBox("Add failed", err.message)) },
    { type: "separator" },
    ...profileIds().map((id) => profileMenu(id)),
    { type: "separator" },
    {
      label: "Exit All",
      enabled: !hasActiveBuild(),
      click: async () => {
        await runGlobalOperation("exit", stopAllServices);
        isQuitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const iconPath = getIconPath();
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("AIEfficiency Service Control");
  tray.on("click", showWindow);
  rebuildTrayMenu();
}

async function chooseRepoRoot(profileId) {
  const id = normalizeProfileId(profileId);
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: `Choose ${profileDef(id).label} AIEfficiency repository`,
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return;
  const selected = path.resolve(result.filePaths[0]);
  if (!isValidRepoRoot(selected)) {
    dialog.showErrorBox("Invalid repository", "The folder must contain gateway/server.js and web-dashboard/package.json.");
    return;
  }
  const duplicate = findProfileByRoot(selected, id);
  if (duplicate) {
    dialog.showErrorBox("Duplicate repository", `${profileDef(duplicate).label} already uses this repository folder.`);
    return;
  }
  const patch = { repoRoot: selected };
  if (isDevelopmentProfileId(id) && !profileConfigs[id]?.label) patch.label = inferDevelopmentLabel(selected, id);
  saveProfileConfig(id, patch);
  ensureProfileProcessBucket(id);
  writeProfileState(id, { status: "stopped", phase: "ready", message: "Repository configured", lastError: null });
  if (isDevelopmentProfileId(id)) {
    syncProductionDataToDevelopment({ includeDb: true, profileId: id }).catch((err) => {
      appendControlLog(id, `Profile sync after repository selection failed: ${err.message}`, "WARN");
    });
  } else if (id === PRODUCTION_PROFILE_ID) {
    syncProductionDataToAllDevelopments({ includeDb: true }).catch((err) => {
      appendControlLog(id, `Profile sync after repository selection failed: ${err.message}`, "WARN");
    });
  }
}

async function addDevelopmentProfileFromRoot(root) {
  const selected = normalizeRepoRoot(root);
  if (!selected) {
    throw new Error("The folder must contain gateway/server.js and web-dashboard/package.json.");
  }
  const duplicate = findProfileByRoot(selected);
  if (duplicate) {
    throw new Error(`${profileDef(duplicate).label} already uses this repository folder.`);
  }
  const raw = normalizeConfig(loadConfigFile());
  const id = nextDevelopmentProfileId(raw.profiles);
  const def = profileDef(id);
  const next = {
    ...raw,
    profiles: {
      ...(raw.profiles || {}),
      [id]: {
        repoRoot: selected,
        gatewayPort: def.defaultGatewayPort,
        webPort: def.defaultWebPort,
        label: inferDevelopmentLabel(selected, id),
      },
    },
  };
  writeConfigFile(next);
  profileConfigs = normalizeConfig(next).profiles;
  ensureProfileProcessBucket(id);
  writeProfileState(id, { status: "stopped", phase: "ready", message: "Development repository configured", lastError: null });
  syncProductionDataToDevelopment({ includeDb: true, profileId: id }).catch((err) => {
    appendControlLog(id, `Profile sync after development repository add failed: ${err.message}`, "WARN");
  });
  return { ok: true, profileId: id, profile: profileState(id) };
}

async function addDevelopmentProfileFromDialog() {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "Add Development AIEfficiency repository",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return addDevelopmentProfileFromRoot(result.filePaths[0]);
}

async function removeDevelopmentProfile(profileId) {
  const id = normalizeProfileId(profileId);
  if (!isDevelopmentProfileId(id)) throw new Error("Only development environments can be removed.");
  const current = profileState(id);
  if (current.status === "running" || current.status === "starting" || current.status === "stopping" || current.gatewayPid || current.webPid) {
    throw new Error("Stop this development environment before removing it.");
  }
  const raw = normalizeConfig(loadConfigFile());
  const nextProfiles = { ...(raw.profiles || {}) };
  delete nextProfiles[id];
  const next = { ...raw, profiles: nextProfiles };
  writeConfigFile(next);
  profileConfigs = normalizeConfig(next).profiles;
  delete children[id];
  delete panelWindows[id];
  state = {
    ...state,
    profiles: Object.fromEntries(Object.entries(state.profiles || {}).filter(([profileId]) => profileId !== id)),
    updatedAt: new Date().toISOString(),
  };
  writeStateFile();
  sendState();
  rebuildTrayMenu();
  return { ok: true, removedProfileId: id, defaultProfile: defaultProfileId() };
}

async function chooseDesktopRuntimeRoot(profileId = PRIMARY_DEVELOPMENT_PROFILE_ID) {
  const requestedId = normalizeProfileId(profileId);
  const id = isDevelopmentProfileId(requestedId) ? requestedId : PRIMARY_DEVELOPMENT_PROFILE_ID;
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "Choose AI desktop runtime folder",
    defaultPath: desktopRuntimeRoot || app.getPath("appData"),
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return;
  try {
    saveDesktopRuntimeRoot(result.filePaths[0]);
    writeProfileState(id, {
      manualSyncToDesktopRuntime: {
        status: "configured",
        desktopRuntimeRoot,
        configuredAt: new Date().toISOString(),
      },
    });
    sendState();
  } catch (err) {
    dialog.showErrorBox("Invalid desktop runtime", err.message);
  }
}

function openDesktopRuntimeRoot() {
  const root = desktopRuntimeRoot || detectDesktopRuntimeRoot();
  if (root) return shell.openPath(root);
  return "";
}

async function stopAllServices() {
  for (const id of profileIds()) {
    const current = profileState(id);
    if (current.status === "running" || current.gatewayPid || current.webPid) {
      await stopServices(id);
    }
  }
}

function initializeProfileStates() {
  const saved = readStateFile();
  const ids = profileIds();
  state = {
    ...saved,
    profiles: Object.fromEntries(Object.entries(saved.profiles || {}).filter(([id]) => ids.includes(id))),
  };
  for (const id of ids) {
    ensureProfileProcessBucket(id);
    const current = state.profiles[id] || {};
    const profile = getRuntimeProfile(id);
    const configured = profileConfigured(profile);
    const staleStatus = current.status === "repo_missing" || current.status === "starting" || current.status === "stopping";
    const staleRecordedMessage = isStaleRecordedRuntimeMessage(current.message);
    const restoredStatus = configured && staleStatus ? "stopped" : current.status;
    const restoredPhase = configured && (current.phase === "repo" || (staleStatus && current.phase !== "ready")) ? "ready" : current.phase;
    const restoredMessage = configured && (current.message === "Choose a valid AIEfficiency repository" || staleStatus || staleRecordedMessage) ? "Ready" : current.message;
    const manualSync = current.manualSyncToProduction || null;
    const restoredManualSync = manualSync?.status === "running"
      ? {
        ...manualSync,
        ok: false,
        status: "failed",
        error: "Previous manual sync was interrupted.",
        syncedAt: manualSync.startedAt || new Date().toISOString(),
      }
      : manualSync;
    const desktopSync = current.manualSyncToDesktopRuntime || null;
    const restoredDesktopSync = desktopSync?.status === "running"
      ? {
        ...desktopSync,
        ok: false,
        status: "failed",
        error: "Previous desktop runtime sync was interrupted.",
        syncedAt: desktopSync.startedAt || new Date().toISOString(),
      }
      : desktopSync;
    writeProfileState(id, {
      ...current,
      status: configured ? (restoredStatus || "stopped") : "repo_missing",
      phase: configured ? (restoredPhase || "ready") : "repo",
      message: configured ? (restoredMessage || "Ready") : "Choose a valid AIEfficiency repository",
      lastError: configured ? current.lastError || null : null,
      manualSyncToProduction: restoredManualSync,
      manualSyncToDesktopRuntime: restoredDesktopSync,
    });
  }
}

ipcMain.handle("state:get", async () => {
  await refreshRuntimeProfileStates();
  return publicState();
});
ipcMain.handle("control:start", async (_event, profileId) => runOperation(profileId, "start", () => startServices(profileId)));
ipcMain.handle("control:stop", async (_event, profileId) => runOperation(profileId, "stop", () => stopServices(profileId)));
ipcMain.handle("control:restart", async (_event, profileId) => runOperation(profileId, "restart", async () => { await stopServices(profileId); await startServices(profileId); }));
ipcMain.handle("control:forceReleasePort", async (_event, profileId, preferredPort) => (
  runInteractiveProfileOperation(
    profileId,
    "force-release-port",
    (id) => forceReleasePreferredPort(id, preferredPort),
  )
));
ipcMain.handle("control:openPanel", async (_event, profileId) => openWebTerminal(profileId));
ipcMain.handle("control:openWebTerminal", async (_event, profileId) => openWebTerminal(profileId));
ipcMain.handle("control:openDesktopTerminal", async (_event, profileId) => openDesktopTerminal(profileId));
ipcMain.handle("control:openLogs", async (_event, profileId) => {
  const current = profileState(profileId);
  return shell.openPath(current.logDir || getProfileLogDir(getRuntimeProfile(profileId)));
});
ipcMain.handle("control:openRepo", async (_event, profileId) => {
  const current = profileState(profileId);
  if (current.root) return shell.openPath(current.root);
  return "";
});
ipcMain.handle("control:chooseRepo", async (_event, profileId) => chooseRepoRoot(profileId));
ipcMain.handle("control:addDevelopment", async () => addDevelopmentProfileFromDialog());
ipcMain.handle("control:removeDevelopment", async (_event, profileId) => removeDevelopmentProfile(profileId));
ipcMain.handle("control:syncToProduction", async (_event, profileId, options) => runManualSyncToProduction(profileId, options));
ipcMain.handle("control:chooseDesktopRuntime", async (_event, profileId) => chooseDesktopRuntimeRoot(profileId));
ipcMain.handle("control:openDesktopRuntime", openDesktopRuntimeRoot);
ipcMain.handle("control:syncToDesktopRuntime", async (_event, profileId, options) => runManualSyncToDesktopRuntime(profileId, options));
ipcMain.handle("build:start", async (_event, profileId, targets) => startBuild(profileId, targets));
ipcMain.handle("control:exitAll", async () => {
  if (hasActiveBuild()) throw new Error("请等待编译完成后再退出 Service Control。");
  await runGlobalOperation("exit", stopAllServices);
  isQuitting = true;
  app.quit();
});

app.on("second-instance", showWindow);
app.on("window-all-closed", () => {});
app.on("activate", showWindow);
app.on("before-quit", (event) => {
  if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    mainWindow.hide();
  }
  if (runtimeHealthTimer) clearTimeout(runtimeHealthTimer);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    bundledGatewayDir = findBundledGatewayDir();
    profileConfigs = resolveInitialProfileConfigs();
    initializeProfileStates();
    await refreshRuntimeProfileStates();
    startRuntimeHealthTimer();
    createWindow();
    createTray();
  });
}
