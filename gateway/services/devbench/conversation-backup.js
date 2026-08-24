import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { normalizeConversation } from "./conversation/model.js";

export const CONVERSATION_BACKUP_SCHEMA = "aiefficiency.devbench.conversation-backup";
export const CONVERSATION_BACKUP_VERSION = 2;
export const CONVERSATION_BACKUP_EXTENSION = ".devbench-chat.json";

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const MAX_BACKUP_FILES = 200;

function cloneJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeFilePart(value, fallback = "story") {
  const text = String(value || "")
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function timestampPart(value) {
  const date = new Date(Number(value) || Date.now());
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function backupBody({ tab = {}, messages = [], conversation = null, createdAt = Date.now(), kind = "manual", liveIncluded = false } = {}) {
  const normalizedMessages = cloneJson(Array.isArray(messages) ? messages : [], []);
  const normalizedConversation = cloneJson(
    conversation && typeof conversation === "object" && !Array.isArray(conversation)
      ? conversation
      : normalizeConversation(normalizedMessages, { tabId: tab?.id || "" }),
    null,
  );
  const body = {
    schema: CONVERSATION_BACKUP_SCHEMA,
    version: CONVERSATION_BACKUP_VERSION,
    createdAt: Number(createdAt) || Date.now(),
    kind: String(kind || "manual"),
    liveIncluded: !!liveIncluded,
    sourceTab: {
      id: String(tab?.id || ""),
      title: String(tab?.title || ""),
      ticketUrl: String(tab?.ticketUrl || ""),
    },
    messages: normalizedMessages,
    conversation: normalizedConversation,
  };
  return { ...body, checksum: sha256(JSON.stringify(body)) };
}

export function serializeConversationBackup(input = {}) {
  return `${JSON.stringify(backupBody(input), null, 2)}\n`;
}

export function parseConversationBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch (error) {
    return { ok: false, error: `备份 JSON 解析失败：${error.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "备份文件结构无效" };
  }
  const version = Number(parsed.version);
  if (parsed.schema !== CONVERSATION_BACKUP_SCHEMA || ![1, CONVERSATION_BACKUP_VERSION].includes(version)) {
    return { ok: false, error: "不支持的完整对话备份格式或版本" };
  }
  if (!Array.isArray(parsed.messages)) return { ok: false, error: "备份文件缺少消息记录" };
  if (version >= 2 && (!parsed.conversation || typeof parsed.conversation !== "object" || Array.isArray(parsed.conversation))) {
    return { ok: false, error: "v2 完整对话备份缺少 conversation 图" };
  }
  const { checksum, ...body } = parsed;
  if (!/^[a-f0-9]{64}$/i.test(String(checksum || "")) || sha256(JSON.stringify(body)) !== String(checksum).toLowerCase()) {
    return { ok: false, error: "完整对话备份校验失败，文件可能已损坏或被修改" };
  }
  return { ok: true, data: parsed };
}

function resolveBackupDirectory(directory, { create = false } = {}) {
  const raw = String(directory || "").trim();
  if (!raw) return { ok: false, error: "请选择完整对话备份目录" };
  if (!path.isAbsolute(raw)) return { ok: false, error: "完整对话备份目录必须是全路径" };
  const resolved = path.resolve(raw);
  try {
    if (create) fs.mkdirSync(resolved, { recursive: true });
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: "完整对话备份目录不存在或不是目录" };
    }
  } catch (error) {
    return { ok: false, error: `无法访问完整对话备份目录：${error.message}` };
  }
  return { ok: true, directory: resolved };
}

export function writeConversationBackup({ directory, tab, messages, conversation = null, createdAt = Date.now(), kind = "manual", liveIncluded = false } = {}) {
  const dir = resolveBackupDirectory(directory, { create: true });
  if (!dir.ok) return dir;
  const source = serializeConversationBackup({ tab, messages, conversation, createdAt, kind, liveIncluded });
  const title = safeFilePart(tab?.title || tab?.id);
  const tabId = safeFilePart(String(tab?.id || "tab").slice(0, 12), "tab");
  const stem = `${title}-${tabId}-${timestampPart(createdAt)}`;
  let filePath = path.join(dir.directory, `${stem}${CONVERSATION_BACKUP_EXTENSION}`);
  let suffix = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir.directory, `${stem}-${suffix}${CONVERSATION_BACKUP_EXTENSION}`);
    suffix += 1;
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, source, "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    return { ok: false, error: `完整对话备份写入失败：${error.message}` };
  }
  return {
    ok: true,
    file: filePath,
    name: path.basename(filePath),
    directory: dir.directory,
    count: Array.isArray(messages) ? messages.length : 0,
    liveIncluded: !!liveIncluded,
    kind: String(kind || "manual"),
  };
}

export function readConversationBackup(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return { ok: false, error: "请选择完整对话备份文件" };
  if (!path.isAbsolute(raw)) return { ok: false, error: "完整对话备份文件必须是全路径" };
  const resolved = path.resolve(raw);
  if (!resolved.toLowerCase().endsWith(CONVERSATION_BACKUP_EXTENSION)) {
    return { ok: false, error: `请选择 ${CONVERSATION_BACKUP_EXTENSION} 格式的完整对话备份` };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: "完整对话备份文件不存在" };
  }
  if (!stat.isFile()) return { ok: false, error: "请选择完整对话备份文件，不是目录" };
  if (stat.size > MAX_BACKUP_BYTES) return { ok: false, error: "完整对话备份文件过大，暂不支持还原" };
  try {
    const parsed = parseConversationBackup(fs.readFileSync(resolved, "utf8"));
    return parsed.ok ? { ...parsed, file: resolved, size: stat.size, mtime: stat.mtimeMs } : parsed;
  } catch (error) {
    return { ok: false, error: `读取完整对话备份失败：${error.message}` };
  }
}

export function listConversationBackupFiles(directory) {
  const dir = resolveBackupDirectory(directory);
  if (!dir.ok) return dir;
  const files = [];
  const walk = (current, depth = 0) => {
    if (files.length >= MAX_BACKUP_FILES || depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_BACKUP_FILES) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "build", "dist"].includes(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(CONVERSATION_BACKUP_EXTENSION)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_BACKUP_BYTES) {
          files.push({ path: full, name: entry.name, size: stat.size, mtime: stat.mtimeMs, tooLarge: true, restorable: false });
          continue;
        }
        const parsed = readConversationBackup(full);
        files.push({
          path: full,
          name: entry.name,
          title: parsed.ok ? parsed.data.sourceTab?.title || entry.name : entry.name,
          size: stat.size,
          mtime: stat.mtimeMs,
          createdAt: parsed.ok ? parsed.data.createdAt : stat.mtimeMs,
          messageCount: parsed.ok ? parsed.data.messages.length : 0,
          turnCount: parsed.ok ? parsed.data.messages.filter((message) => message?.role === "user").length : 0,
          sourceTabId: parsed.ok ? parsed.data.sourceTab?.id || "" : "",
          liveIncluded: parsed.ok ? !!parsed.data.liveIncluded : false,
          kind: parsed.ok ? parsed.data.kind || "manual" : "",
          restorable: parsed.ok,
          tooLarge: false,
          ...(parsed.ok ? {} : { error: parsed.error || "备份文件无效" }),
        });
      } catch {}
    }
  };
  walk(dir.directory);
  files.sort((left, right) => Number(right.createdAt || right.mtime) - Number(left.createdAt || left.mtime));
  return { ok: true, directory: dir.directory, backups: files };
}
