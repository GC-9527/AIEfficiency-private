// AI 配置/记忆/Skills 一键备份 · 迁移 · 还原
// 设计要点（见 plans/jolly-splashing-owl.md）：
//  - 不打包任何登录凭证（.credentials.json / auth.json / token 类），包可明文、不加密；
//  - 备份包是 zip（.aibak.zip），含 manifest.json + payload/ + README.txt；
//  - 路径迁移：manifest 记录源机三件套路径（HOME / 工程根 / Claude projects 编码目录名），
//    还原时把文本类配置里的「源路径」整体替换为「新机路径」，并按新工程路径重新编码 projects 目录名；
//  - 敏感字段（apiKey/secret/token/cookie/password 等）默认 redact，除非用户显式勾选「含敏感配置」。
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  copyFileSync, renameSync,
} from "fs";
import { join, dirname, basename, relative, sep, resolve } from "path";
import { homedir, hostname } from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import JSZip from "jszip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SCHEMA_VERSION = 1;

// 工程根 = gateway 的上一级目录
const WORKSPACE_ROOT = resolve(__dirname, "..", "..");
const GATEWAY_DIR = resolve(__dirname, "..");
const GATEWAY_CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH || join(GATEWAY_DIR, "config.json");

// ---------- Claude projects 目录名编码 ----------
// Claude Code 把工程绝对路径里的盘符冒号、路径分隔符逐字符转成 "-"，作为 ~/.claude/projects 下的目录名。
// 盘符与反斜杠会分别编码为 "-"，因此 Windows 盘符后会出现两个横线。
//（"D:\" 的冒号与反斜杠各转一个 "-"，故盘符后是双横线；不可用 + 合并连续分隔符）
export function encodeProjectDir(absPath) {
  return String(absPath).replace(/[:\\/]/g, "-");
}

// ---------- 黑名单（任何条目下都不打包这些）----------
const EXCLUDE_NAMES = new Set([
  ".credentials.json", "auth.json", "history.jsonl", "models_cache.json",
  ".last-cleanup", ".DS_Store",
]);
const EXCLUDE_DIR_NAMES = new Set([
  "node_modules", "cache", "debug", "sessions", "shell-snapshots",
  "paste-cache", "file-history", "daemon", "ide", "tasks", "plans",
  "tempFiles", "backups", ".system", "memories",
]);
function isExcluded(name, isDir) {
  if (isDir) return EXCLUDE_DIR_NAMES.has(name);
  if (EXCLUDE_NAMES.has(name)) return true;
  if (/\.lock$/i.test(name)) return true;
  if (/\.snapshot\./i.test(name)) return true;
  if (/^logs_.*\.sqlite/i.test(name)) return true;
  if (/\.(log|tmp)$/i.test(name)) return true;
  return false;
}

// ---------- 敏感字段 redact（仅作用于 JSON 配置）----------
const SECRET_KEY_RE = /(apikey|api_key|secret|token|cookie|password|passwd|webhook|credential|privatekey|private_key)/i;
const REDACTED = "__REDACTED__";
function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && (typeof v === "string" || typeof v === "number")) {
        out[k] = v === "" ? "" : REDACTED;
      } else {
        out[k] = redactJson(v);
      }
    }
    return out;
  }
  return value;
}

// ---------- 路径定位 ----------
function paths() {
  const home = homedir();
  const claudeDir = join(home, ".claude");
  const projectEncoded = encodeProjectDir(WORKSPACE_ROOT);
  const projectDir = join(claudeDir, "projects", projectEncoded);
  const codexDir = join(home, ".codex");
  return { home, claudeDir, projectEncoded, projectDir, codexDir };
}

// ---------- 条目定义 ----------
// kind: file | dir ；toPayload：在 zip payload/ 下的相对落点；optional：前端可取消勾选
function itemDefs() {
  const p = paths();
  return [
    { id: "claude-global-md", label: "Claude 全局记忆 (CLAUDE.md)", kind: "file",
      src: join(p.claudeDir, "CLAUDE.md"), payload: "claude/CLAUDE.md", optional: false },
    { id: "claude-settings", label: "Claude 全局配置 (settings.json)", kind: "file",
      src: join(p.claudeDir, "settings.json"), payload: "claude/settings.json", optional: false, json: true },
    { id: "claude-keybindings", label: "Claude 快捷键 (keybindings.json)", kind: "file",
      src: join(p.claudeDir, "keybindings.json"), payload: "claude/keybindings.json", optional: true },
    { id: "claude-skills", label: "Claude 全局 Skills", kind: "dir",
      src: join(p.claudeDir, "skills"), payload: "claude/skills", optional: false },
    { id: "claude-memory", label: "本项目 AI 记忆 (memory/)", kind: "dir",
      src: join(p.projectDir, "memory"), payload: "claude/project-memory", optional: false },
    { id: "claude-sessions", label: "本项目会话历史 (*.jsonl，体积较大)", kind: "dir",
      src: p.projectDir, payload: "claude/project-sessions", optional: true, sessionsOnly: true },
    { id: "project-claude-md", label: "工程级规范 (项目 CLAUDE.md)", kind: "file",
      src: join(WORKSPACE_ROOT, "CLAUDE.md"), payload: "project/CLAUDE.md", optional: false },
    { id: "project-dot-claude", label: "工程内 .claude/ 设置", kind: "dir",
      src: join(WORKSPACE_ROOT, ".claude"), payload: "project/dot-claude", optional: true },
    { id: "gateway-config", label: "网关配置 (gateway/config.json)", kind: "file",
      src: GATEWAY_CONFIG_PATH, payload: "project/gateway-config.json", optional: false, json: true, redactable: true },
    { id: "codex-config", label: "Codex 全局配置 (config.toml)", kind: "file",
      src: join(p.codexDir, "config.toml"), payload: "codex/config.toml", optional: false, text: true },
    { id: "codex-agents-md", label: "Codex AGENTS.md", kind: "file",
      src: join(p.codexDir, "AGENTS.md"), payload: "codex/AGENTS.md", optional: true },
    { id: "codex-rules", label: "Codex 规则 (rules/)", kind: "dir",
      src: join(p.codexDir, "rules"), payload: "codex/rules", optional: true },
    { id: "codex-skills", label: "Codex 用户 Skills", kind: "dir",
      src: join(p.codexDir, "skills"), payload: "codex/skills", optional: true },
  ];
}

// 递归统计目录大小/文件数（已过滤黑名单；sessionsOnly 时只算 *.jsonl）
function dirStat(root, { sessionsOnly = false } = {}) {
  let bytes = 0, files = 0;
  if (!existsSync(root)) return { bytes, files };
  const walk = (cur) => {
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (isExcluded(e.name, e.isDirectory())) continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        if (sessionsOnly && !/\.jsonl$/i.test(e.name)) continue;
        try { bytes += statSync(full).size; files += 1; } catch { /* ignore */ }
      }
    }
  };
  // sessionsOnly 仅取顶层 *.jsonl，不下钻 memory 等子目录
  if (sessionsOnly) {
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of entries) {
      if (e.isFile() && /\.jsonl$/i.test(e.name)) {
        try { bytes += statSync(join(root, e.name)).size; files += 1; } catch { /* ignore */ }
      }
    }
    return { bytes, files };
  }
  walk(root);
  return { bytes, files };
}

// ---------- buildManifest：给前端渲染勾选清单 ----------
export function buildManifest() {
  const p = paths();
  const items = itemDefs().map((d) => {
    const exists = existsSync(d.src);
    let bytes = 0, files = 0;
    if (exists) {
      if (d.kind === "dir") {
        const s = dirStat(d.src, { sessionsOnly: d.sessionsOnly });
        bytes = s.bytes; files = s.files;
      } else {
        try { bytes = statSync(d.src).size; files = 1; } catch { /* ignore */ }
      }
    }
    return {
      id: d.id, label: d.label, kind: d.kind, optional: d.optional,
      sessionsOnly: !!d.sessionsOnly, redactable: !!d.redactable,
      exists, bytes, files,
      defaultChecked: exists && !d.sessionsOnly, // 会话历史默认不勾
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    host: hostname(),
    sourceHome: p.home,
    sourceWorkspaceRoot: WORKSPACE_ROOT,
    projectEncodedDir: p.projectEncoded,
    items,
  };
}

// 把单个文件加入 zip（json 条目按需 redact；不改写文本，路径迁移交还原阶段按 manifest 源路径替换）
function addFileToZip(zip, payloadPath, srcPath, def, { includeSecrets }) {
  if (!existsSync(srcPath)) return false;
  if (def.json) {
    let raw;
    try { raw = readFileSync(srcPath, "utf8"); } catch { return false; }
    let obj;
    try { obj = JSON.parse(raw); } catch { zip.file(payloadPath, raw); return true; }
    if (def.redactable && !includeSecrets) obj = redactJson(obj);
    zip.file(payloadPath, JSON.stringify(obj, null, 2));
    return true;
  }
  // 二进制安全读取
  try { zip.file(payloadPath, readFileSync(srcPath)); return true; } catch { return false; }
}

function addDirToZip(zip, payloadPrefix, srcDir, { sessionsOnly = false } = {}) {
  if (!existsSync(srcDir)) return 0;
  let count = 0;
  if (sessionsOnly) {
    let entries = [];
    try { entries = readdirSync(srcDir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      if (e.isFile() && /\.jsonl$/i.test(e.name)) {
        try { zip.file(`${payloadPrefix}/${e.name}`, readFileSync(join(srcDir, e.name))); count += 1; } catch { /* ignore */ }
      }
    }
    return count;
  }
  const walk = (cur, rel) => {
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (isExcluded(e.name, e.isDirectory())) continue;
      const full = join(cur, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, relPath);
      else if (e.isFile()) {
        try { zip.file(`${payloadPrefix}/${relPath}`, readFileSync(full)); count += 1; } catch { /* ignore */ }
      }
    }
  };
  walk(srcDir, "");
  return count;
}

// ---------- createBackup → Buffer ----------
export async function createBackup({ items = null, includeSessions = false, includeSecrets = false } = {}) {
  const p = paths();
  const zip = new JSZip();
  const selected = items && items.length ? new Set(items) : null; // null = 全部默认项
  const defs = itemDefs();
  const manifestItems = [];

  for (const d of defs) {
    const isSession = d.sessionsOnly;
    // 选择逻辑：显式勾选优先；未传 items 时用 defaultChecked（会话默认不含）
    let want;
    if (selected) want = selected.has(d.id);
    else want = !isSession;
    if (isSession && !includeSessions) want = false;
    if (!want) continue;
    if (!existsSync(d.src)) continue;

    let count = 0;
    if (d.kind === "dir") {
      count = addDirToZip(zip, `payload/${d.payload}`, d.src, { sessionsOnly: isSession });
    } else {
      const ok = addFileToZip(zip, `payload/${d.payload}`, d.src, d, { includeSecrets });
      count = ok ? 1 : 0;
    }
    if (count > 0) {
      manifestItems.push({
        id: d.id, label: d.label, kind: d.kind, payload: d.payload,
        files: count, redacted: !!(d.redactable && !includeSecrets),
      });
    }
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    host: hostname(),
    sourceHome: p.home,
    sourceWorkspaceRoot: WORKSPACE_ROOT,
    projectEncodedDir: p.projectEncoded,
    includeSessions: !!includeSessions,
    includeSecrets: !!includeSecrets,
    items: manifestItems,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("README.txt", buildReadme(manifest));

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const filename = `ai-backup-${sanitize(hostname())}-${stamp}.aibak.zip`;
  return { buffer: buf, filename, manifest };
}

function sanitize(s) { return String(s || "host").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32); }

function buildReadme(manifest) {
  return [
    "AI 配置 / 记忆 / Skills 备份包",
    "================================",
    `来源主机: ${manifest.host}`,
    `生成时间: ${manifest.createdAt}`,
    `源工程根: ${manifest.sourceWorkspaceRoot}`,
    "",
    "【还原方式】在目标设备的 AI 提效工具 → 设置 → AI 配置备份与迁移 → 选择本包 → 一键还原。",
    "",
    "【重要】本包不含任何登录凭证：",
    "  - 还原后需在目标设备重新登录 Claude Code（claude）与 Codex（codex）。",
    manifest.includeSecrets
      ? "  - 本包按用户选择包含了明文敏感配置（API Key 等），请妥善保管，勿外发。"
      : "  - 网关配置中的 API Key / Cookie / 密钥等已被抹除（__REDACTED__），还原后需在设置页重填。",
    "",
    "包含条目:",
    ...manifest.items.map((i) => `  - ${i.label}（${i.files} 个文件${i.redacted ? "，已脱敏" : ""}）`),
  ].join("\n");
}

// ---------- 解析 manifest（预览/还原共用）----------
export async function readManifest(zipBuffer) {
  const zip = await JSZip.loadAsync(zipBuffer);
  const mf = zip.file("manifest.json");
  if (!mf) throw new Error("无效备份包：缺少 manifest.json");
  const manifest = JSON.parse(await mf.async("string"));
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`备份包版本(${manifest.schemaVersion})高于当前支持(${SCHEMA_VERSION})，请升级工具`);
  }
  return { zip, manifest };
}

// ---------- 文本路径改写：源机三件套 → 目标机 ----------
// 仅对运行相关的 JSON/TOML 生效（.md 文档不改）。把源 HOME、源工程根、源 projects 编码目录名
// 在文本里的各种出现形态（正斜杠/反斜杠/JSON 转义反斜杠）都替换成目标值。
function rewritePaths(text, fromVals, toVals) {
  let out = text;
  const pairs = [
    [fromVals.workspaceRoot, toVals.workspaceRoot],
    [fromVals.home, toVals.home],
    [fromVals.projectEncoded, toVals.projectEncoded],
  ];
  for (const [from, to] of pairs) {
    if (!from || !to || from === to) continue;
    for (const variant of pathVariants(from)) {
      const repl = variant.includes("\\\\") ? to.replace(/\\/g, "\\\\")
        : variant.includes("\\") ? to.replace(/\//g, "\\")
        : to.replace(/\\/g, "/");
      out = out.split(variant).join(repl);
    }
  }
  return out;
}
function pathVariants(p) {
  const fwd = p.replace(/\\/g, "/");
  const back = p.replace(/\//g, "\\");
  const jsonBack = back.replace(/\\/g, "\\\\"); // JSON 里 \\ 转义形态
  return Array.from(new Set([p, fwd, back, jsonBack]));
}

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }); }

// 写文件，若目标已存在且非 overwrite，则把旧文件备份到 restore-bak 目录
function safeWrite(targetPath, data, { overwrite, bakRoot, report }) {
  ensureDir(dirname(targetPath));
  if (existsSync(targetPath)) {
    if (!overwrite) {
      // 备份旧文件后再覆盖（默认就保留旧件，不静默丢弃）
      const rel = relative(homedir(), targetPath).replace(/[:\\/]+/g, "_");
      const bak = join(bakRoot, rel);
      ensureDir(dirname(bak));
      try { copyFileSync(targetPath, bak); report.backedUp.push(targetPath); } catch { /* ignore */ }
    }
  }
  writeFileSync(targetPath, data);
  report.written.push(targetPath);
}

// ---------- restoreBackup ----------
// targetWorkspaceRoot：用户在还原界面指定的新工程根（默认= 本机当前工程根）
export async function restoreBackup({ zipBuffer, targetWorkspaceRoot = null, items = null, overwrite = false } = {}) {
  const { zip, manifest } = await readManifest(zipBuffer);
  const p = paths();
  const toWorkspace = resolve(targetWorkspaceRoot || WORKSPACE_ROOT);
  const fromVals = {
    home: manifest.sourceHome,
    workspaceRoot: manifest.sourceWorkspaceRoot,
    projectEncoded: manifest.projectEncodedDir,
  };
  const toVals = {
    home: p.home,
    workspaceRoot: toWorkspace,
    projectEncoded: encodeProjectDir(toWorkspace),
  };
  const bakRoot = join(p.home, ".ai-backup-restore-bak", new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14));
  const report = { written: [], backedUp: [], skipped: [], needRelogin: [], rewritten: [], targetWorkspaceRoot: toWorkspace };
  const wantSet = items && items.length ? new Set(items) : null;

  // 目标落点：把 payload 相对路径映射回磁盘绝对路径
  const targetClaude = join(p.home, ".claude");
  const targetCodex = join(p.home, ".codex");
  const targetProjectDir = join(targetClaude, "projects", toVals.projectEncoded);

  // payload 前缀 → 目标根目录 + 是否做文本路径改写
  const routes = [
    { prefix: "payload/claude/CLAUDE.md", to: join(targetClaude, "CLAUDE.md"), file: true, id: "claude-global-md" },
    { prefix: "payload/claude/settings.json", to: join(targetClaude, "settings.json"), file: true, rewrite: true, id: "claude-settings" },
    { prefix: "payload/claude/keybindings.json", to: join(targetClaude, "keybindings.json"), file: true, id: "claude-keybindings" },
    { prefix: "payload/claude/skills", to: join(targetClaude, "skills"), id: "claude-skills" },
    { prefix: "payload/claude/project-memory", to: join(targetProjectDir, "memory"), id: "claude-memory" },
    { prefix: "payload/claude/project-sessions", to: targetProjectDir, id: "claude-sessions" },
    { prefix: "payload/project/CLAUDE.md", to: join(toWorkspace, "CLAUDE.md"), file: true, id: "project-claude-md" },
    { prefix: "payload/project/dot-claude", to: join(toWorkspace, ".claude"), id: "project-dot-claude" },
    { prefix: "payload/project/gateway-config.json", to: join(toWorkspace, "gateway", "config.json"), file: true, rewrite: true, id: "gateway-config" },
    { prefix: "payload/codex/config.toml", to: join(targetCodex, "config.toml"), file: true, rewrite: true, id: "codex-config" },
    { prefix: "payload/codex/AGENTS.md", to: join(targetCodex, "AGENTS.md"), file: true, id: "codex-agents-md" },
    { prefix: "payload/codex/rules", to: join(targetCodex, "rules"), id: "codex-rules" },
    { prefix: "payload/codex/skills", to: join(targetCodex, "skills"), id: "codex-skills" },
  ];

  // zip 内所有文件路径
  const allPaths = Object.keys(zip.files).filter((k) => !zip.files[k].dir && k.startsWith("payload/"));

  for (const route of routes) {
    if (wantSet && !wantSet.has(route.id)) { continue; }
    if (route.file) {
      const entry = zip.file(route.prefix);
      if (!entry) continue;
      let data;
      if (route.rewrite) {
        let txt = await entry.async("string");
        const before = txt;
        txt = rewritePaths(txt, fromVals, toVals);
        if (txt !== before) report.rewritten.push(route.to);
        data = Buffer.from(txt, "utf8");
      } else {
        data = await entry.async("nodebuffer");
      }
      safeWrite(route.to, data, { overwrite, bakRoot, report });
    } else {
      // 目录：把 prefix 下所有文件铺到目标
      const prefix = route.prefix.endsWith("/") ? route.prefix : route.prefix + "/";
      const members = allPaths.filter((k) => k.startsWith(prefix));
      for (const k of members) {
        const rel = k.slice(prefix.length);
        if (!rel) continue;
        const targetPath = join(route.to, rel.split("/").join(sep));
        const data = await zip.file(k).async("nodebuffer");
        safeWrite(targetPath, data, { overwrite, bakRoot, report });
      }
    }
  }

  // 还原后提示：凭证类需重新登录
  report.needRelogin = ["Claude Code（命令：claude，需重新登录）", "Codex（命令：codex，需重新登录）"];
  report.needRefill = manifest.includeSecrets ? [] : ["gateway/config.json 中的 API Key / TB Cookie / 钉钉飞书密钥（已脱敏，请在设置页重填）"];
  report.manifest = { host: manifest.host, createdAt: manifest.createdAt, sourceWorkspaceRoot: manifest.sourceWorkspaceRoot, items: manifest.items };
  return report;
}

// ---------- checkEnv：检测 node/claude/codex，给安装指引（不安装）----------
function quoteCmdArg(value) {
  const s = String(value);
  if (/^[a-zA-Z0-9_./:=+\-\\]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function winAttempt(cmd, args) {
  return {
    cmd: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", [cmd, ...args].map(quoteCmdArg).join(" ")],
  };
}

function probe(cmd, args) {
  const isWin = process.platform === "win32";
  const attempts = isWin && !/\.(cmd|exe|bat)$/i.test(cmd)
    ? [winAttempt(cmd, args), winAttempt(`${cmd}.cmd`, args)]
    : [{ cmd, args }];

  for (const attempt of attempts) {
    try {
      const r = spawnSync(attempt.cmd, attempt.args, {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (r.error || r.status !== 0) continue;
      const first = String(`${r.stdout || ""}${r.stderr || ""}`).trim().split(/\r?\n/).find(Boolean);
      if (first) return first;
    } catch { /* try next */ }
  }
  return null;
}

function markDetected(tool) {
  tool.found = !!(tool.version || tool.path);
  if (tool.found && !tool.version) tool.version = "已安装（版本检测失败）";
  return tool;
}
export function checkEnv() {
  const isWin = process.platform === "win32";
  const which = (name) => probe(isWin ? "where" : "which", [name]);

  const node = { name: "Node.js", found: false, version: "", path: "", installHint: "" };
  node.version = probe("node", ["-v"]) || "";
  node.path = which("node") || process.execPath || "";
  node.installHint = isWin
    ? "下载安装 https://nodejs.org/ (LTS 20+)，或 winget install OpenJS.NodeJS.LTS"
    : "建议用 nvm 安装：nvm install --lts；或见 https://nodejs.org/";

  const claude = { name: "Claude Code CLI", found: false, version: "", path: "", installHint: "" };
  claude.version = probe("claude", ["--version"]) || "";
  claude.path = which("claude") || "";
  claude.installHint = "npm i -g @anthropic-ai/claude-code  （装好后运行 claude 登录）";

  const codex = { name: "Codex CLI", found: false, version: "", path: "", installHint: "" };
  codex.version = probe("codex", ["--version"]) || "";
  codex.path = which("codex") || "";
  codex.installHint = "npm i -g @openai/codex  （装好后运行 codex 登录）";

  const tools = [node, claude, codex].map(markDetected);
  return { platform: process.platform, checkedAt: new Date().toISOString(), tools };
}
