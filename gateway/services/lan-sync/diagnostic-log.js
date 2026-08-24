import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, "..", "..", "logs", "lan-sync");
const SENSITIVE_FIELD = /payload|private.?key|access.?token|refresh.?token|secret|password|credential|authorization|cookie|certificate/i;
const SENSITIVE_TEXT = /BEGIN [A-Z ]*PRIVATE KEY|access.?token|refresh.?token|private.?key|password|authorization\s*:|bearer\s+[a-z0-9._~+/-]+/i;
const SAFE_FIELDS = new Set([
  "changeSetId",
  "deleted",
  "error",
  "memberCount",
  "mtlsEnabled",
  "nodeId",
  "operationCount",
  "outbound",
  "peerNodeId",
  "projectId",
  "reason",
  "retentionDays",
  "syncMode",
  "target",
  "tlsAuthorized",
]);
let lastPrunedAt = 0;

function settings() {
  const config = getConfig().lanSync?.diagnosticLog || {};
  return {
    enabled: config.enabled !== false,
    directory: path.resolve(process.env.LAN_SYNC_LOG_DIR || config.directory || DEFAULT_DIR),
    maxBytes: Math.max(256 * 1024, Math.min(20 * 1024 * 1024, Number(config.maxBytes) || 2 * 1024 * 1024)),
    maxFiles: Math.max(2, Math.min(20, Number(config.maxFiles) || 5)),
    retentionDays: Math.max(1, Math.min(90, Number(config.retentionDays) || 7)),
  };
}

function sanitize(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,48}$/.test(key)) continue;
    if (SENSITIVE_FIELD.test(key)) continue;
    if (!SAFE_FIELDS.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") {
      const text = value.slice(0, 300);
      out[key] = SENSITIVE_TEXT.test(text) ? "[redacted-sensitive-text]" : text;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).map((item) => {
        const text = String(item).slice(0, 100);
        return SENSITIVE_TEXT.test(text) ? "[redacted-sensitive-text]" : text;
      });
    }
  }
  return out;
}

function prune(config, now = Date.now()) {
  if (now - lastPrunedAt < 60 * 60_000) return;
  lastPrunedAt = now;
  const cutoff = now - config.retentionDays * 24 * 60 * 60_000;
  for (const name of readdirSync(config.directory).filter((item) => /^lan-sync\.log(?:\.\d+)?$/.test(item))) {
    const target = path.join(config.directory, name);
    try {
      if (statSync(target).mtimeMs < cutoff) unlinkSync(target);
    } catch {}
  }
}

function rotate(config, target, incomingBytes) {
  let size = 0;
  try { size = statSync(target).size; } catch {}
  if (size + incomingBytes <= config.maxBytes) return;
  const oldest = `${target}.${config.maxFiles - 1}`;
  try { if (existsSync(oldest)) unlinkSync(oldest); } catch {}
  for (let index = config.maxFiles - 2; index >= 1; index--) {
    const source = `${target}.${index}`;
    try { if (existsSync(source)) renameSync(source, `${target}.${index + 1}`); } catch {}
  }
  try { if (existsSync(target)) renameSync(target, `${target}.1`); } catch {}
}

export function lanSyncDiagnostic(level, event, fields = {}) {
  const config = settings();
  if (!config.enabled) return false;
  try {
    mkdirSync(config.directory, { recursive: true });
    prune(config);
    const runtimeConfig = getConfig();
    const eventName = String(event || "unknown").slice(0, 80);
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      level: ["debug", "info", "warn", "error"].includes(String(level).toLowerCase())
        ? String(level).toLowerCase()
        : "info",
      event: /^[a-z][a-z0-9_.-]{0,79}$/i.test(eventName) && !SENSITIVE_TEXT.test(eventName)
        ? eventName
        : "redacted_event",
      nodeId: String(process.env.NODE_ID || runtimeConfig.servers?.nodeId || "").slice(0, 120),
      runtimeProfile: String(process.env.AIEFFICIENCY_PROFILE || "production").slice(0, 80),
      ...sanitize(fields),
    })}\n`;
    const target = path.join(config.directory, "lan-sync.log");
    rotate(config, target, Buffer.byteLength(line, "utf8"));
    appendFileSync(target, line, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function lanSyncDiagnosticSettings() {
  const config = settings();
  return {
    enabled: config.enabled,
    directory: config.directory,
    maxBytes: config.maxBytes,
    maxFiles: config.maxFiles,
    retentionDays: config.retentionDays,
    maximumDiskBytes: config.maxBytes * config.maxFiles,
  };
}
