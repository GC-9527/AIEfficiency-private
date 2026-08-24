/**
 * 故事点跨机一键备份/还原。
 *
 * 备份格式：单文件 zip（扩展名 .devbench-story.zip），内含：
 *   - manifest.json   schema/version/源机器信息/校验和
 *   - tab.json        故事点 tab 元数据（绝对路径已剥离为可移植形态）
 *   - conversation.json 对话图（v2，保留分支结构）
 *   - messages.json   旧版线性消息列表（兜底）
 *   - story-files/**  故事点资料目录下全部文件（ask/archives/reports/tempFiles），相对路径
 *
 * 路径可移植策略：
 *   - storyStorageRoot / archiveDir：剥离（还原时映射到本机 StoryDev 根目录）
 *   - archiveFile：转为相对 storyDirectory 的相对路径，还原时拼回
 *   - worktree.entries[].path / worktreePath / extraProjects[].path / remoteRepos[].path：
 *     剥离绝对路径，保留 branch/baseProjectId/role/flavor/remote 等身份信息；
 *     还原后用户通过既有「初始化配置」面板重新绑定本机工程。
 *   - primaryProjectId / deviceSerial / ticketUrl / tbContext：原样保留（身份信息可移植）。
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  getTab,
  getMessages,
  getConversation,
  getStoryStoragePaths,
  updateTab,
  replaceMessages,
  restoreConversationState,
  clearLiveDraft,
  ensureDocSlug,
} from "./store.js";

export const STORY_BACKUP_SCHEMA = "aiefficiency.devbench.story-backup";
export const STORY_BACKUP_VERSION = 1;
export const STORY_BACKUP_EXTENSION = ".devbench-story.zip";

const MANIFEST_NAME = "manifest.json";
const TAB_NAME = "tab.json";
const CONVERSATION_NAME = "conversation.json";
const MESSAGES_NAME = "messages.json";
const STORY_FILES_PREFIX = "story-files/";
const MAX_STORY_FILE_BYTES = 200 * 1024 * 1024; // 单文件 200MB 上限，避免误打包超大产物
const MAX_STORY_FILES = 5000;
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "build", "dist", ".DS_Store"]);

function safeFilePart(value, fallback = "story") {
  const text = String(value || "")
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function timestampPart(value = Date.now()) {
  const d = new Date(Number(value) || Date.now());
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function hostname() {
  try { return os.hostname(); } catch { return ""; }
}

function stripPortableTab(tab) {
  const clone = JSON.parse(JSON.stringify(tab || {}));
  // 剥离前先收集旧分支名 / 旧 worktree 目录 / 工程路径，随备份保留，
  // 供还原后把聊天记录中的旧引用更新为目标故事点的新分支/新目录。
  const legacyWorktree = Array.isArray(clone?.worktree?.entries)
    ? clone.worktree.entries.map((entry) => (entry && typeof entry === "object" ? {
      role: entry.role || "",
      baseProjectId: entry.baseProjectId || entry.projectId || "",
      branch: entry.branch || entry.cleanupBranch || entry.baseRef || "",
      path: entry.path || "",
      worktreePath: entry.worktreePath || "",
      basePath: entry.basePath || "",
    } : {}))
    : [];
  const legacyRefs = {
    worktree: legacyWorktree.filter((entry) => entry.branch || entry.path || entry.worktreePath || entry.basePath),
    storyStorageRoot: String(clone.storyStorageRoot || ""),
    storyStorageDirectory: String(clone.storyStorageDirectory || ""),
    archiveDir: String(clone.archiveDir || clone.effectiveArchiveDir || ""),
  };
  clone._legacyRefs = legacyRefs;
  // 本机暂存的待替换引用（还原后 worktree 未就绪时挂起）不随备份传播。
  delete clone.backupLegacyRefs;
  // 这些字段是本机绝对路径，跨机无意义，统一剥离（副本已保留在 _legacyRefs）。
  clone.storyStorageRoot = "";
  clone.archiveDir = null;
  clone.archiveFile = "";
  clone.conversationBackupDirectories = [];
  clone.conversationBackupFiles = [];
  // worktree 受管路径剥离绝对路径，保留身份/分支信息供还原后重新初始化。
  if (clone.worktree && typeof clone.worktree === "object") {
    const wt = { ...clone.worktree };
    if (Array.isArray(wt.entries)) {
      wt.entries = wt.entries.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const { path: _path, worktreePath: _wtp, basePath: _bp, ...rest } = entry;
        return rest;
      });
    }
    if (wt.worktreePath) wt.worktreePath = "";
    clone.worktree = wt;
  }
  if (Array.isArray(clone.extraProjects)) {
    clone.extraProjects = clone.extraProjects.map((ex) => {
      if (!ex || typeof ex !== "object") return ex;
      const { path: _p, ...rest } = ex;
      return rest;
    });
  }
  if (Array.isArray(clone.remoteRepos)) {
    clone.remoteRepos = clone.remoteRepos.map((r) => {
      if (!r || typeof r !== "object") return r;
      const { path: _p, ...rest } = r;
      return rest;
    });
  }
  // 运行态字段还原后无意义。
  clone.runningTaskId = null;
  clone.cliSessionId = null;
  clone.cliSessionEngine = null;
  clone.remoteAgentSessionId = null;
  clone.remoteAgentLastEventId = null;
  return clone;
}

function relativizeArchiveFile(archiveFile, storyDirectory) {
  if (!archiveFile || !storyDirectory) return "";
  try {
    const resolved = path.resolve(String(archiveFile));
    const rel = path.relative(storyDirectory, resolved);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join("/");
    }
  } catch {}
  return "";
}

function collectStoryFiles(storyDirectory) {
  const files = [];
  if (!storyDirectory || !fs.existsSync(storyDirectory)) return files;
  const walk = (current, depth = 0) => {
    if (files.length >= MAX_STORY_FILES || depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_STORY_FILES) break;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const stat = fs.statSync(full);
          if (stat.size > MAX_STORY_FILE_BYTES) continue;
          const rel = path.relative(storyDirectory, full).split(path.sep).join("/");
          if (!rel || rel.startsWith("..")) continue;
          files.push({ rel, full, size: stat.size });
        }
      } catch {}
    }
  };
  walk(storyDirectory);
  return files;
}

/**
 * 构建故事点备份 zip buffer。
 * @param {string} tabId
 * @returns {{ ok: boolean, buffer?: Buffer, fileName?: string, error?: string, statusCode?: number }}
 */
export async function buildStoryBackupZip(tabId) {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, error: "故事点不存在" };
  let storage;
  try {
    storage = getStoryStoragePaths(tab, { create: false });
  } catch (error) {
    return { ok: false, statusCode: 400, error: `无法解析故事点存储目录：${error.message}` };
  }
  const messages = getMessages(tabId);
  const conversation = getConversation(tabId);
  const portableTab = stripPortableTab(tab);
  portableTab.archiveFile = relativizeArchiveFile(tab.archiveFile, storage.storyDirectory);
  const manifest = {
    schema: STORY_BACKUP_SCHEMA,
    version: STORY_BACKUP_VERSION,
    createdAt: Date.now(),
    sourceMachine: {
      hostname: hostname(),
      platform: process.platform,
      nodeVersion: process.version,
    },
    storySlug: ensureDocSlug(tab),
    storyDirectoryBasename: path.basename(storage.storyDirectory || ""),
    tabId: tab.id,
    tabTitle: tab.title,
    messageCount: messages.length,
    fileCount: 0,
    totalBytes: 0,
    // 旧分支名 / 旧 worktree 目录名（供还原后更新聊天记录引用）
    legacyRefs: {
      branches: (portableTab._legacyRefs?.worktree || []).map((entry) => entry.branch).filter(Boolean),
      worktreeDirs: (portableTab._legacyRefs?.worktree || []).map((entry) => entry.worktreePath || entry.path || entry.basePath).filter(Boolean),
    },
  };
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file(TAB_NAME, JSON.stringify(portableTab, null, 2));
  zip.file(CONVERSATION_NAME, JSON.stringify(conversation || {}, null, 2));
  zip.file(MESSAGES_NAME, JSON.stringify(messages || [], null, 2));
  const storyFiles = collectStoryFiles(storage.storyDirectory);
  let totalBytes = 0;
  for (const f of storyFiles) {
    try {
      const data = fs.readFileSync(f.full);
      totalBytes += data.length;
      zip.file(STORY_FILES_PREFIX + f.rel, data);
    } catch {}
  }
  manifest.fileCount = storyFiles.length;
  manifest.totalBytes = totalBytes;
  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const fileName = `${safeFilePart(tab.title)}-${safeFilePart(String(tab.id).slice(0, 12), "tab")}-${timestampPart()}${STORY_BACKUP_EXTENSION}`;
  return { ok: true, buffer, fileName, manifest };
}

function parseManifest(text) {
  let parsed;
  try { parsed = JSON.parse(String(text || "")); } catch { return { ok: false, error: "manifest.json 解析失败" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "manifest.json 结构无效" };
  }
  if (parsed.schema !== STORY_BACKUP_SCHEMA) {
    return { ok: false, error: "不是 devbench 故事点备份文件（schema 不匹配）" };
  }
  const version = Number(parsed.version);
  if (!Number.isFinite(version) || version > STORY_BACKUP_VERSION) {
    return { ok: false, error: "不支持的故事点备份版本" };
  }
  return { ok: true, data: parsed };
}

/**
 * 解析备份 zip，返回初始化配置快照（不创建 tab）。
 * 前端拿到 snapshot 后走「新建故事点初始化面板」流程，让用户绑定本机工程或配置远程克隆。
 * @param {Buffer|Uint8Array} zipBuffer
 * @returns {{ ok: boolean, data?: { snapshot: object, manifest: object, messageCount: number, fileCount: number, backupTab: object }, statusCode?: number, error?: string }}
 */
export async function parseStoryBackupZip(zipBuffer) {
  const parsed = await loadBackupZip(zipBuffer);
  if (!parsed.ok) return parsed;
  const { zip, manifest, backupTab } = parsed;
  let messageCount = 0;
  const msgFile = zip.file(MESSAGES_NAME);
  if (msgFile) {
    try {
      const messages = JSON.parse(await msgFile.async("string"));
      if (Array.isArray(messages)) messageCount = messages.length;
    } catch {}
  }
  let fileCount = 0;
  for (const entryName of Object.keys(zip.files || {})) {
    if (entryName.startsWith(STORY_FILES_PREFIX) && !entryName.endsWith("/")) fileCount++;
  }
  const snapshot = buildSnapshotFromPortableTab(backupTab);
  return {
    ok: true,
    data: {
      snapshot,
      manifest: manifest.data,
      messageCount,
      fileCount,
      backupTab,
    },
  };
}

/**
 * 把备份内容（对话/消息/资料文件）应用到已存在的 tab（由初始化面板创建并 provision worktree 后调用）。
 * 不会改动 tab 的工程/worktree 绑定，只还原对话历史和资料文件。
 * @param {Buffer|Uint8Array} zipBuffer
 * @param {string} tabId
 */
export async function applyStoryBackupToTab(zipBuffer, tabId) {
  if (!tabId) return { ok: false, statusCode: 400, error: "缺少目标故事点 ID" };
  const tab = getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, error: "目标故事点不存在" };
  const parsed = await loadBackupZip(zipBuffer);
  if (!parsed.ok) return parsed;
  const { zip, backupTab } = parsed;

  // 还原对话 + 消息。
  let conversation = null;
  let messages = [];
  const convFile = zip.file(CONVERSATION_NAME);
  const msgFile = zip.file(MESSAGES_NAME);
  if (convFile) {
    try { conversation = JSON.parse(await convFile.async("string")); } catch {}
  }
  if (msgFile) {
    try { messages = JSON.parse(await msgFile.async("string")); } catch {}
  }
  if (!Array.isArray(messages)) messages = [];
  const hasConversationNodes = !!(
    conversation && typeof conversation === "object" && !Array.isArray(conversation)
    && Array.isArray(conversation.nodes) && conversation.nodes.length > 0
  );
  // 防御「聊天记录全部丢失」：只有对话图真的有节点时才按对话图还原；
  // 对话图缺失/空图/还原异常时一律回退到备份消息列表兜底。
  let restoredMessages = [];
  if (hasConversationNodes) {
    try {
      const restored = restoreConversationState(tabId, conversation, messages);
      restoredMessages = Array.isArray(restored.messages) ? restored.messages : [];
    } catch {
      restoredMessages = [];
    }
  }
  if (!restoredMessages.length && messages.length) {
    try {
      replaceMessages(tabId, messages, { preserveExactMetadata: true });
      restoredMessages = messages;
    } catch {
      restoredMessages = [];
    }
  }
  try { clearLiveDraft(tabId); } catch {}

  // 分支名 / worktree 目录名更新：备份保留旧引用（_legacyRefs），
  // 目标故事点 worktree 已就绪时立即替换聊天记录中的旧分支名/旧目录；
  // 尚未就绪（异步 provision）时把旧引用暂存 tab，由前端在 worktree 就绪后调
  // applyStoryBackupRefRemap 补齐替换。
  const legacyRefs = backupTab?._legacyRefs && typeof backupTab._legacyRefs === "object"
    ? backupTab._legacyRefs
    : null;
  let refRemapApplied = false;
  let pendingRefRemap = null;
  if (legacyRefs && (Array.isArray(legacyRefs.worktree) ? legacyRefs.worktree.length : false)) {
    const targetNow = getTab(tabId);
    const remap = buildStoryRefRemap(legacyRefs, targetNow);
    const worktreeReady = Array.isArray(targetNow?.worktree?.entries)
      && targetNow.worktree.entries.some((entry) => entry && (entry.worktreePath || entry.path));
    if (remap.length && restoredMessages.length) {
      try {
        const remappedConversation = applyRemapToConversation(conversation, remap);
        const remappedMessages = restoredMessages.map((item) => ({
          ...item,
          content: applyTextRemap(item.content, remap),
        }));
        restoreConversationState(tabId, remappedConversation, remappedMessages);
        refRemapApplied = true;
      } catch {}
    }
    if (refRemapApplied) {
      // 替换成功即清除本机暂存，避免 worktree 就绪后前端用旧 legacyRefs 重复替换。
      try { updateTab(tabId, { backupLegacyRefs: null }); } catch {}
    } else if (!worktreeReady) {
      try { updateTab(tabId, { backupLegacyRefs: legacyRefs }); pendingRefRemap = legacyRefs; } catch {}
    }
  }

  // 还原资料文件到目标故事点目录。
  let storage;
  try {
    storage = getStoryStoragePaths(getTab(tabId), { create: true });
  } catch (error) {
    return { ok: true, tab: getTab(tabId), warning: `对话已还原但资料目录初始化失败：${error.message}`, restoredFiles: 0, messageCount: messages.length };
  }
  let restoredFiles = 0;
  const storyDir = storage.storyDirectory;
  for (const entryName of Object.keys(zip.files || {})) {
    if (!entryName.startsWith(STORY_FILES_PREFIX) || entryName.endsWith("/")) continue;
    const rel = entryName.slice(STORY_FILES_PREFIX.length);
    if (!rel || rel.includes("..")) continue;
    const target = path.join(storyDir, ...rel.split("/"));
    try {
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true });
      const entry = zip.file(entryName);
      if (!entry) continue;
      const data = await entry.async("nodebuffer");
      fs.writeFileSync(target, data);
      restoredFiles++;
    } catch {}
  }

  // 拼回 archiveFile（若备份里有相对路径，且文件已还原）。
  const remap = {};
  if (backupTab.archiveFile) {
    const candidate = path.join(storyDir, ...String(backupTab.archiveFile).split("/"));
    if (fs.existsSync(candidate)) {
      remap.archiveFile = candidate;
    }
  }
  const turns = messages.filter((m) => m?.role === "user").length;
  if (Object.keys(remap).length || turns) {
    try { updateTab(tabId, { turns, ...remap }); } catch {}
  }

  return {
    ok: true,
    tab: getTab(tabId),
    restoredFiles,
    messageCount: messages.length,
    refRemapApplied,
    pendingRefRemap: pendingRefRemap ? { worktreeCount: Array.isArray(pendingRefRemap.worktree) ? pendingRefRemap.worktree.length : 0 } : null,
  };
}

/**
 * 还原完成后补齐分支名 / worktree 目录名替换（worktree 异步 provision 就绪后由前端调用）。
 * 用备份时保留的旧引用（tab.backupLegacyRefs）与目标故事点当前 worktree 构建映射，
 * 更新聊天记录中的旧分支名/旧目录，替换完成即清除暂存。
 */
export function applyStoryBackupRefRemap(tabId) {
  const tab = getTab(tabId);
  if (!tab) return { ok: false, statusCode: 404, error: "故事点不存在" };
  const legacyRefs = tab.backupLegacyRefs;
  if (!legacyRefs || typeof legacyRefs !== "object") {
    return { ok: true, applied: false, reason: "无待替换的旧分支/目录引用" };
  }
  const remap = buildStoryRefRemap(legacyRefs, tab);
  if (!remap.length) {
    // 目标 worktree 尚未就绪或新旧无差异：保留待替换记录，等待下次调用。
    return { ok: true, applied: false, reason: "目标 worktree 尚未就绪或引用无差异" };
  }
  const conversation = getConversation(tabId);
  const messages = getMessages(tabId);
  if (Array.isArray(messages) && messages.length) {
    const remappedConversation = applyRemapToConversation(conversation, remap);
    const remappedMessages = messages.map((item) => ({
      ...item,
      content: applyTextRemap(item.content, remap),
    }));
    restoreConversationState(tabId, remappedConversation, remappedMessages);
  }
  try { updateTab(tabId, { backupLegacyRefs: null }); } catch {}
  return { ok: true, applied: true, replaced: remap };
}

// ===== 分支名 / worktree 目录名引用替换 =====

function buildStoryRefRemap(legacyRefs = {}, targetTab = {}) {
  const remap = [];
  if (!legacyRefs || typeof legacyRefs !== "object") return remap;
  const entries = Array.isArray(targetTab?.worktree?.entries) ? targetTab.worktree.entries : [];
  const entryFor = (role, baseProjectId) => entries.find((entry) => (
    entry?.role === role && text(entry?.baseProjectId || entry?.projectId) === text(baseProjectId)
  ));
  for (const legacy of Array.isArray(legacyRefs.worktree) ? legacyRefs.worktree : []) {
    const target = entryFor(legacy?.role, legacy?.baseProjectId);
    if (!target) continue;
    const oldBranch = String(legacy?.branch || "").trim();
    const newBranch = String(target.branch || "").trim();
    if (oldBranch && newBranch && oldBranch !== newBranch) {
      remap.push({ kind: "branch", from: oldBranch, to: newBranch });
    }
    const oldPath = String(legacy?.worktreePath || legacy?.path || legacy?.basePath || "").trim();
    const newPath = String(target.worktreePath || target.path || "").trim();
    if (oldPath && newPath && oldPath !== newPath) {
      remap.push({ kind: "path", from: oldPath, to: newPath });
    }
  }
  const oldStorageRoot = String(legacyRefs.storyStorageRoot || "").trim();
  const newStorageRoot = String(targetTab?.storyStorageRoot || "").trim();
  if (oldStorageRoot && newStorageRoot && oldStorageRoot !== newStorageRoot) {
    remap.push({ kind: "path", from: oldStorageRoot, to: newStorageRoot });
  }
  // 去重（同一 from 保留第一个非空 to）
  const seen = new Set();
  const unique = remap.filter((row) => {
    const key = row.from;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 长/具体的条目优先（路径 > 分支名），避免短串先替换后破坏长串匹配。
  return unique.sort((left, right) => right.from.length - left.from.length);
}

// 分支名/路径替换统一加字符边界，避免误伤兄弟串：
//  分支名 story/release_CARB_123 不得替换 story/release_CARB_1234；
//  路径 D:/worktrees/AAA 不得替换 D:/worktrees/AAA2；允许路径分隔符延续
//  （D:/worktrees/AAA/foo → C:/worktrees/NEW-AAA/foo）。

function applyTextRemap(text, remap) {
  let out = String(text ?? "");
  if (!out || !Array.isArray(remap) || !remap.length) return out;
  for (const row of remap) {
    if (!row?.from || !row?.to) continue;
    if (row.kind === "branch") {
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9._/\\-])${escapeRegExp(row.from)}(?![\\w./\\-])`, "g"),
        () => row.to,
      );
    } else {
      // 路径：整段匹配（前面不能是路径字符；后面允许路径分隔符 / 或 \ 延续，
      // 以便 D:/old/AAA/foo 这类旧目录下的子路径引用也同步更新前缀）。
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9_\\-/\\\\])${escapeRegExp(row.from)}(?![A-Za-z0-9_\\-\\\\])`, "g"),
        () => row.to,
      );
    }
  }
  return out;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyRemapToConversation(conversation, remap) {
  if (!Array.isArray(remap) || !remap.length) return conversation;
  if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) return conversation;
  const clone = JSON.parse(JSON.stringify(conversation));
  if (Array.isArray(clone.nodes)) {
    for (const node of clone.nodes) {
      if (node && typeof node?.content === "string") {
        node.content = applyTextRemap(node.content, remap);
      }
      for (const metaKey of ["aiSnapshot", "actualAi"]) {
        const meta = node?.[metaKey];
        if (meta && typeof meta === "object") {
          for (const field of ["path", "cwd", "directory", "branch", "command"]) {
            if (typeof meta[field] === "string") meta[field] = applyTextRemap(meta[field], remap);
          }
        }
      }
    }
  }
  return clone;
}

function text(value) {
  return String(value ?? "").trim();
}

async function loadBackupZip(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) && !(zipBuffer instanceof Uint8Array)) {
    return { ok: false, statusCode: 400, error: "备份内容不是有效的二进制流" };
  }
  const JSZip = (await import("jszip")).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (error) {
    return { ok: false, statusCode: 400, error: `无法读取备份 zip：${error.message}` };
  }
  const manifestFile = zip.file(MANIFEST_NAME);
  if (!manifestFile) return { ok: false, statusCode: 400, error: "备份文件缺少 manifest.json" };
  const manifest = parseManifest(await manifestFile.async("string"));
  if (!manifest.ok) return { ok: false, statusCode: 400, error: manifest.error };
  const tabFile = zip.file(TAB_NAME);
  if (!tabFile) return { ok: false, statusCode: 400, error: "备份文件缺少 tab.json" };
  let backupTab;
  try { backupTab = JSON.parse(await tabFile.async("string")); } catch { return { ok: false, statusCode: 400, error: "tab.json 解析失败" }; }
  if (!backupTab || typeof backupTab !== "object") {
    return { ok: false, statusCode: 400, error: "tab.json 结构无效" };
  }
  return { ok: true, zip, manifest, backupTab };
}

/**
 * 从 portable tab 构建初始化面板可消费的配置快照。
 * 保留可移植的身份信息（projectId/branch/flavor/role/remotePull/deviceSerial），
 * 不含本机绝对路径——路径由初始化面板让用户重新绑定本机工程或配置远程克隆。
 */
function buildSnapshotFromPortableTab(tab) {
  const t = tab || {};
  const mode = t.mode === "remote" ? "remote" : "local";
  const entries = Array.isArray(t?.worktree?.entries) ? t.worktree.entries : [];
  const activeEntries = entries.filter((e) => e && e.role !== "inactive" && e.active !== false);
  const primary = activeEntries.find((e) => e.role === "primary") || activeEntries[0] || {};
  const extras = activeEntries.filter((e) => e.role === "extra" || e.role === "webapp");
  const flavors = activeEntries
    .filter((e) => (e.flavor && (e.baseProjectId || e.projectId)))
    .map((e) => ({ projectId: e.baseProjectId || e.projectId || "", flavor: e.flavor }));
  const baseExtraProjects = extras.map((e) => ({
    baseProjectId: e.baseProjectId || e.projectId || "",
    name: e.name || "",
    branch: e.branch || "",
    flavor: e.flavor || "",
  }));
  const snapshot = {
    mode,
    primaryProjectId: t.primaryProjectId || primary.baseProjectId || primary.projectId || "",
    basePrimaryProjectId: primary.baseProjectId || t.primaryProjectId || "",
    baseExtraProjects,
    flavors,
    deviceSerial: t.deviceSerial || null,
    projectDefId: t.projectDefId || "",
    ticketUrl: t.ticketUrl || "",
    tbContext: t.tbContext || null,
    worktreeNaming: t.worktreeNaming || null,
    reportMode: t.reportMode || "short",
    engine: t.engine || "codex",
    aiPrefs: t.aiPrefs || {},
  };
  if (t.remotePull) snapshot.remotePull = t.remotePull;
  if (t.remoteRepos) snapshot.remoteRepos = t.remoteRepos;
  return snapshot;
}
