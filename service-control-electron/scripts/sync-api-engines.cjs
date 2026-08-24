// 把 source 工程的 gateway/config.json.apiEngines 增量合并到 target 工程的 gateway/config.json。
// 增量语义：source 同名引擎按字段覆盖 target（含 apiKey）；target 独有引擎保留；
// source 标记 _delete:true 的自定义引擎在 target 也删（内置引擎不可删）。
// defaultEngine 不同步，仅替换 apiEngines 字段，其余字段原样保留。
// 合并核心内联自 gateway/services/config.js，保持行为一致（该模块为 ESM 且依赖 gateway 运行时，这里自包含无外部依赖）。
const fs = require("fs");
const path = require("path");

const sourceRoot = path.resolve(process.argv[2] || "");
const targetRoot = path.resolve(process.argv[3] || "");

if (!sourceRoot || !targetRoot || sourceRoot === targetRoot) {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: "invalid roots" }));
  process.exit(0);
}

// ---- 内联自 gateway/services/config.js 的合并核心（行为一致，勿单独修改）----
const BUILTIN_API_ENGINE_IDS = new Set(["qwen", "kimi", "deepseek", "openai", "bigmodel", "volcengine"]);
const RESERVED_ENGINE_IDS = new Set(["claude", "claude-volcengine", "gemini", "codex", ...BUILTIN_API_ENGINE_IDS]);

function isBuiltinApiEngineId(id) {
  return BUILTIN_API_ENGINE_IDS.has(String(id || "").trim());
}

function isValidCustomApiEngineId(id) {
  const key = String(id || "").trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(key)) return false;
  if (RESERVED_ENGINE_IDS.has(key)) return false;
  return true;
}

function normalizeApiEngines(engines) {
  const normalized = {};
  for (const [id, value] of Object.entries(engines || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (value._delete === true) continue;
    const engine = { ...value };
    delete engine._delete;
    for (const field of ["baseUrl", "apiKey", "model", "name", "docsUrl"]) {
      if (typeof engine[field] === "string") engine[field] = engine[field].trim();
    }
    if (Array.isArray(engine.availableModels)) {
      engine.availableModels = engine.availableModels.map((m) => String(m || "").trim()).filter(Boolean);
    }
    engine.builtin = isBuiltinApiEngineId(id);
    if (!engine.builtin) engine.custom = true;
    normalized[id] = engine;
  }
  return normalized;
}

// 合并 apiEngines 更新：支持新增自定义引擎、字段覆盖、以及 { _delete:true } / null 删除自定义引擎。
// 同步场景 apiKey 直接覆盖，不走 masked 逻辑（与手动复制 config.json 行为一致）。
function mergeApiEnginesUpdate(currentEngines = {}, incomingEngines = {}) {
  const next = { ...(currentEngines || {}) };
  for (const [id, engine] of Object.entries(incomingEngines || {})) {
    if (engine == null || engine._delete === true) {
      if (isBuiltinApiEngineId(id)) continue;
      delete next[id];
      continue;
    }
    if (typeof engine !== "object" || Array.isArray(engine)) continue;
    if (!next[id] && !isBuiltinApiEngineId(id) && !isValidCustomApiEngineId(id)) {
      return {
        engines: next,
        error: `无效的自定义引擎 ID「${id}」：须为小写字母开头、2-32 位 [a-z0-9_-]，且不能与内置引擎冲突`,
      };
    }
    next[id] = { ...(next[id] || {}), ...engine };
    delete next[id]._delete;
    if (isBuiltinApiEngineId(id)) {
      next[id].builtin = true;
      delete next[id].custom;
    } else {
      next[id].custom = true;
      next[id].builtin = false;
    }
  }
  return { engines: normalizeApiEngines(next) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function readConfig(root) {
  const file = path.join(root, "gateway", "config.json");
  if (!fs.existsSync(file)) return { config: {}, file, exists: false };
  try {
    return { config: JSON.parse(fs.readFileSync(file, "utf8") || "{}"), file, exists: true };
  } catch (err) {
    return { config: {}, file, exists: true, parseError: err.message };
  }
}

try {
  const sourceCfg = readConfig(sourceRoot);
  const targetCfg = readConfig(targetRoot);
  if (sourceCfg.parseError) {
    console.log(JSON.stringify({ ok: false, error: `source config.json parse failed: ${sourceCfg.parseError}` }));
    process.exit(0);
  }
  if (targetCfg.parseError) {
    console.log(JSON.stringify({ ok: false, error: `target config.json parse failed: ${targetCfg.parseError}` }));
    process.exit(0);
  }

  const sourceEngines = (sourceCfg.config && sourceCfg.config.apiEngines) || {};
  if (!sourceCfg.exists || !Object.keys(sourceEngines).length) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: sourceCfg.exists ? "no source apiEngines" : "source config.json missing",
    }));
    process.exit(0);
  }

  const targetEngines = (targetCfg.config && targetCfg.config.apiEngines) || {};
  const targetBefore = Object.keys(targetEngines).length;

  const merged = mergeApiEnginesUpdate(targetEngines, sourceEngines);
  if (merged.error) {
    console.log(JSON.stringify({ ok: false, error: merged.error }));
    process.exit(0);
  }

  const mergedEngines = merged.engines;
  const mergedIds = new Set(Object.keys(mergedEngines));
  // 统计变化：source 标记 _delete 的不计入 added。
  const sourceIds = new Set(Object.keys(sourceEngines).filter((id) => !(sourceEngines[id] && sourceEngines[id]._delete === true)));
  const targetIds = new Set(Object.keys(targetEngines));
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const id of sourceIds) {
    if (!targetIds.has(id)) added += 1;
    else if (!sameJson(targetEngines[id], mergedEngines[id])) updated += 1;
  }
  for (const id of targetIds) {
    if (!mergedIds.has(id)) removed += 1;
  }

  // 只替换 apiEngines 字段，其余字段原样保留。
  const nextConfig = { ...(targetCfg.config || {}), apiEngines: mergedEngines };
  fs.writeFileSync(targetCfg.file, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    sourceCount: Object.keys(sourceEngines).length,
    targetBefore,
    targetAfter: mergedIds.size,
    added,
    updated,
    removed,
  }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(0);
}