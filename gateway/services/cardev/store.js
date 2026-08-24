/**
 * CarDev 模块 - 持久化（自定义命令、最近使用文本）
 *
 * 写入 gateway/.tmp/cardev/store.json，避免污染主数据库。
 * .tmp/ 已在仓库 .gitignore 列表内。
 */
import fs from "fs";
import path from "path";

const STORE_DIR = path.resolve(process.cwd(), ".tmp", "cardev");
const STORE_FILE = path.join(STORE_DIR, "store.json");

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try {
    if (!fs.existsSync(STORE_FILE)) return defaultStore();
    return { ...defaultStore(), ...JSON.parse(fs.readFileSync(STORE_FILE, "utf-8")) };
  } catch {
    return defaultStore();
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function defaultStore() {
  return { customCommands: [], lastTexts: {} };
}

export function listCommands() {
  return load().customCommands;
}

export function addCommand(cmd) {
  if (!cmd || !cmd.name || !cmd.command) return { ok: false, error: "name/command required" };
  const data = load();
  const id = cmd.id || `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    name: String(cmd.name),
    command: String(cmd.command),
    args: Array.isArray(cmd.args) ? cmd.args : [],
    createdAt: Date.now(),
  };
  data.customCommands = [entry, ...data.customCommands.filter((c) => c.id !== id)];
  save(data);
  return { ok: true, command: entry };
}

export function deleteCommand(id) {
  const data = load();
  const before = data.customCommands.length;
  data.customCommands = data.customCommands.filter((c) => c.id !== id);
  save(data);
  return { ok: true, removed: before - data.customCommands.length };
}

export function getLastText(key) {
  return load().lastTexts[key] || "";
}

export function setLastText(key, value) {
  const data = load();
  data.lastTexts = { ...data.lastTexts, [key]: String(value || "") };
  save(data);
  return { ok: true };
}
