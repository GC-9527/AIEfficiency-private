/**
 * 金标集管理（方案 §12.1）
 *
 * JSONL 格式，每行一个 case：
 *   {
 *     "tb_id": "GS-0001",
 *     "package_name": "com.xxx.music",
 *     "title": "...",
 *     "raw_content": "...",
 *     "log_attachment": "...",
 *     "expected_category": "代码问题",
 *     "expected_sub_category": "Java Crash",
 *     "expected_evidence_refs": ["FATAL EXCEPTION: main"],
 *     "annotator": "张三",
 *     "annotated_at": "2026-04-24T00:00:00Z",
 *     "version": 1
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * 加载金标集 JSONL 文件。
 */
export async function loadGoldenSet(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const entries = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    try {
      entries.push(JSON.parse(s));
    } catch {
      // skip bad line
    }
  }
  return entries;
}

/**
 * 追加一条金标 case（JSONL append）。
 */
export function appendGoldenCase(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const required = ["tb_id", "package_name", "title", "raw_content", "expected_category"];
  for (const k of required) if (!entry[k]) throw new Error(`missing ${k}`);
  entry.annotated_at = entry.annotated_at || new Date().toISOString();
  entry.version = entry.version || 1;
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

/**
 * 验证金标集 schema + 重复检查。
 * 返回 { ok, errors: [...] }。
 */
export function validateGoldenSet(entries) {
  const errors = [];
  const seenIds = new Set();
  const CATEGORIES = new Set(["非问题", "UI 问题", "代码问题", "其他"]);

  entries.forEach((e, i) => {
    const prefix = `entry[${i}] (tb_id=${e.tb_id || "?"})`;
    if (!e.tb_id) errors.push(`${prefix}: missing tb_id`);
    else if (seenIds.has(e.tb_id)) errors.push(`${prefix}: duplicate tb_id`);
    else seenIds.add(e.tb_id);

    if (!e.package_name) errors.push(`${prefix}: missing package_name`);
    if (!e.raw_content) errors.push(`${prefix}: missing raw_content`);
    if (!CATEGORIES.has(e.expected_category)) errors.push(`${prefix}: invalid expected_category`);
  });

  return { ok: errors.length === 0, errors, count: entries.length };
}

/**
 * 默认金标路径（`<knowledge_root>/tests/golden_set_v1.jsonl`）
 */
export function defaultGoldenPath(storage) {
  if (storage.inMemory) throw new Error("golden-set requires on-disk storage");
  return path.join(storage.root, "tests", "golden_set_v1.jsonl");
}
