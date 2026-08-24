const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const sourceRoot = path.resolve(process.argv[2] || "");
const targetRoot = path.resolve(process.argv[3] || "");
const rawOptions = process.argv[4] || "";

function parseOptions() {
  if (!rawOptions) {
    return {
      adminUsers: true,
      sharedAll: true,
    };
  }
  try {
    const parsed = JSON.parse(rawOptions);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const options = parseOptions();

if (!sourceRoot || !targetRoot || sourceRoot === targetRoot) {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: "invalid roots" }));
  process.exit(0);
}

const sourceDb = path.join(sourceRoot, "gateway", "db", "data.db");
const targetDb = path.join(targetRoot, "gateway", "db", "data.db");
if (!fs.existsSync(sourceDb) || !fs.existsSync(targetDb)) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: "database missing", sourceDb: fs.existsSync(sourceDb), targetDb: fs.existsSync(targetDb) }));
  process.exit(0);
}

const requireFromGateway = createRequire(path.join(sourceRoot, "gateway", "package.json"));
const Database = requireFromGateway("better-sqlite3");

const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
const target = new Database(targetDb);

function tableExists(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function uniqueById(list = []) {
  const byId = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item?.id || item?.key || "").trim();
    const key = id || JSON.stringify(item);
    byId.set(key, item);
  }
  return [...byId.values()];
}

function rowIdentity(item) {
  return String(item?.id || item?.key || "").trim() || JSON.stringify(item);
}

function mergeBoundedRows(targetRows, sourceRows, limit = 200) {
  const target = uniqueById(targetRows);
  const source = uniqueById(sourceRows).slice(-limit);
  const sourceById = new Map(source.map((row) => [rowIdentity(row), row]));
  const targetIds = new Set(target.map(rowIdentity));
  const merged = target.map((row) => sourceById.get(rowIdentity(row)) || row);
  for (const row of source) if (!targetIds.has(rowIdentity(row))) merged.push(row);

  // 容量不足时先淘汰 target-only 的最旧行，保留 source 全集；重叠 ID 原位更新，
  // source-only 末尾追加，因此直接快照顺序与 Gateway set/delete 重放结果一致。
  let overflow = Math.max(0, merged.length - limit);
  const bounded = merged.filter((row) => {
    if (overflow > 0 && !sourceById.has(rowIdentity(row))) {
      overflow -= 1;
      return false;
    }
    return true;
  });
  return bounded.slice(-limit);
}

function mergeObjects(targetObj, sourceObj) {
  return { ...(targetObj && typeof targetObj === "object" ? targetObj : {}), ...(sourceObj && typeof sourceObj === "object" ? sourceObj : {}) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function projectDefsById(value) {
  return new Map((Array.isArray(value) ? value : [])
    .filter((item) => item && String(item.id || "").trim())
    .map((item) => [String(item.id).trim(), item]));
}

function syncAdminUsers() {
  if (!options.adminUsers) return 0;
  if (!tableExists(source, "admin_users") || !tableExists(target, "admin_users")) return 0;
  const rows = source.prepare("SELECT ding_userid, name, role, added_by, created_at, updated_at, deleted_at, node FROM admin_users").all();
  const stmt = target.prepare(`
    INSERT INTO admin_users (ding_userid, name, role, added_by, created_at, updated_at, deleted_at, node)
    VALUES (@ding_userid, @name, @role, @added_by, @created_at, @updated_at, @deleted_at, @node)
    ON CONFLICT(ding_userid) DO UPDATE SET
      name=excluded.name,
      role=excluded.role,
      added_by=excluded.added_by,
      created_at=MIN(admin_users.created_at, excluded.created_at),
      updated_at=excluded.updated_at,
      deleted_at=excluded.deleted_at,
      node=excluded.node
    WHERE COALESCE(excluded.updated_at, 0) >= COALESCE(admin_users.updated_at, 0)
      AND (
        admin_users.name IS NOT excluded.name
        OR admin_users.role IS NOT excluded.role
        OR admin_users.added_by IS NOT excluded.added_by
        OR admin_users.created_at IS NOT MIN(admin_users.created_at, excluded.created_at)
        OR admin_users.updated_at IS NOT excluded.updated_at
        OR admin_users.deleted_at IS NOT excluded.deleted_at
        OR admin_users.node IS NOT excluded.node
      )
  `);
  const tx = target.transaction((items) => {
    let changed = 0;
    for (const row of items) {
      const result = stmt.run({
        ding_userid: String(row.ding_userid || ""),
        name: String(row.name || row.ding_userid || ""),
        role: String(row.role || "admin"),
        added_by: String(row.added_by || ""),
        created_at: Number(row.created_at || row.updated_at || Date.now()),
        updated_at: Number(row.updated_at || row.created_at || Date.now()),
        deleted_at: Number(row.deleted_at || 0),
        node: String(row.node || ""),
      });
      changed += result.changes;
    }
    return changed;
  });
  return tx(rows);
}

function readShared(db) {
  if (!tableExists(db, "devbench_userdata")) return null;
  const row = db.prepare(`
    SELECT user_key, kind, data, updated_at, node
    FROM devbench_userdata
    WHERE user_key='__devbench_shared__' AND kind='shared'
  `).get();
  if (!row) return null;
  return {
    row,
    data: safeJson(row.data, {}),
  };
}

function writeShared(db, data, updatedAt, node) {
  db.prepare(`
    INSERT INTO devbench_userdata (user_key, kind, data, updated_at, node)
    VALUES ('__devbench_shared__', 'shared', @data, @updated_at, @node)
    ON CONFLICT(user_key, kind) DO UPDATE SET
      data=excluded.data,
      updated_at=excluded.updated_at,
      node=excluded.node
  `).run({
    data: JSON.stringify(data || {}),
    updated_at: updatedAt,
    node: node || "service-control",
  });
}

function selectedSharedKeys() {
  if (options.sharedAll) return ["keywordMappings", "vehicleMap", "statusMap", "configMemory", "lessons"];
  return [
    options.keywordMappings ? "keywordMappings" : "",
    options.vehicleMap ? "vehicleMap" : "",
    options.statusMap ? "statusMap" : "",
    options.configMemory ? "configMemory" : "",
    options.lessons ? "lessons" : "",
  ].filter(Boolean);
}

function syncSharedDevbenchData() {
  const keys = selectedSharedKeys();
  const includeProjectDefs = !!(options.sharedAll || options.projectDefs);
  const includeDingtalk = !!(options.sharedAll || options.dingtalkMsgConfig);
  const selectedKeys = [
    ...(includeProjectDefs ? ["projectDefs"] : []),
    ...keys,
    ...(includeDingtalk ? ["dingtalkMsgConfig"] : []),
  ];
  if (!selectedKeys.length) return { updated: false, projectBuckets: 0, keys: [] };
  if (!tableExists(source, "devbench_userdata") || !tableExists(target, "devbench_userdata")) {
    return { updated: false, projectBuckets: 0, keys: selectedKeys };
  }

  const sourceShared = readShared(source);
  if (!sourceShared) return { updated: false, projectBuckets: 0, keys: selectedKeys };
  const sourceData = sourceShared.data || {};
  const syncNode = `service-control:${path.basename(sourceRoot)}`;

  return target.transaction(() => {
    // 在 IMMEDIATE 事务中重读目标，避免 Gateway 在比较与写回之间插入更新。
    const targetShared = readShared(target) || { row: {}, data: {} };
    const targetData = targetShared.data || {};
    const next = {
      ...targetData,
      byProject: mergeObjects(targetData.byProject, {}),
      sharedOps: Array.isArray(targetData.sharedOps) ? [...targetData.sharedOps] : [],
      sharedOpClocks: targetData.sharedOpClocks && typeof targetData.sharedOpClocks === "object"
        ? { ...targetData.sharedOpClocks }
        : {},
    };
    let versionCursor = Math.max(
      Date.now(),
      Number(targetData._sharedVersion || 0),
      Number(sourceData._sharedVersion || 0),
    );
    let sharedChanged = false;
    let touchedBuckets = 0;
    let generatedOps = 0;
    const restoreEpoch = String(targetData.sharedRestoreClock?.id || "").trim();

    const appendConfigOp = (type, payload, key) => {
      versionCursor += 1;
      const op = {
        type,
        ...payload,
        id: `${syncNode}:${versionCursor}:${Math.random().toString(36).slice(2, 8)}`,
        node: syncNode,
        version: versionCursor,
        at: Date.now(),
        ...(restoreEpoch ? { restoreEpoch } : {}),
      };
      next.sharedOps.push(op);
      next.sharedOpClocks[key] = {
        version: op.version,
        node: op.node,
        id: op.id,
        at: op.at,
      };
      generatedOps += 1;
    };
    const encodedPath = (parts) => parts.map((part) => encodeURIComponent(String(part))).join("/");
    const appendByProjectOp = (type, projectId, pathParts, value) => {
      appendConfigOp(
        type,
        { projectId, path: pathParts, ...(type === "byProject.set" ? { value } : {}) },
        `byProject/${encodeURIComponent(String(projectId))}/${encodedPath(pathParts)}`,
      );
    };
    const syncLeafMap = (projectId, prefix, targetValue, sourceValue) => {
      const targetMap = targetValue && typeof targetValue === "object" && !Array.isArray(targetValue) ? targetValue : {};
      const sourceMap = sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) ? sourceValue : {};
      for (const itemKey of new Set([...Object.keys(targetMap), ...Object.keys(sourceMap)])) {
        if (sameJson(targetMap[itemKey], sourceMap[itemKey])) continue;
        const pathParts = [...prefix, itemKey];
        if (Object.hasOwn(sourceMap, itemKey)) appendByProjectOp("byProject.set", projectId, pathParts, sourceMap[itemKey]);
        else appendByProjectOp("byProject.delete", projectId, pathParts);
      }
    };
    const syncKeywordMappings = (projectId, targetValue, sourceValue) => {
      const targetGroups = targetValue && typeof targetValue === "object" && !Array.isArray(targetValue) ? targetValue : {};
      const sourceGroups = sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) ? sourceValue : {};
      for (const group of new Set([...Object.keys(targetGroups), ...Object.keys(sourceGroups)])) {
        syncLeafMap(projectId, ["keywordMappings", group], targetGroups[group], sourceGroups[group]);
      }
    };
    const syncRows = (typePrefix, projectId, targetRows, candidateRows) => {
      const targetById = new Map((Array.isArray(targetRows) ? targetRows : [])
        .filter((row) => row && String(row.id || "").trim())
        .map((row) => [String(row.id).trim(), row]));
      const candidateById = new Map((Array.isArray(candidateRows) ? candidateRows : [])
        .filter((row) => row && String(row.id || "").trim())
        .map((row) => [String(row.id).trim(), row]));
      for (const id of new Set([...targetById.keys(), ...candidateById.keys()])) {
        const targetRow = targetById.get(id);
        const candidateRow = candidateById.get(id);
        if (sameJson(targetRow, candidateRow)) continue;
        appendConfigOp(
          `${typePrefix}.${candidateById.has(id) ? "set" : "delete"}`,
          candidateById.has(id) ? { projectId, value: candidateRow } : { projectId, idValue: id },
          `${typePrefix}/${encodeURIComponent(String(projectId))}/${encodeURIComponent(id)}`,
        );
      }
    };

    if (includeProjectDefs && Array.isArray(sourceData.projectDefs)) {
      const sourceDefs = projectDefsById(sourceData.projectDefs);
      const targetDefs = projectDefsById(targetData.projectDefs);
      const changedIds = [...new Set([...sourceDefs.keys(), ...targetDefs.keys()])]
        .filter((id) => !sameJson(sourceDefs.get(id) ?? null, targetDefs.get(id) ?? null));
      if (changedIds.length) {
        next.projectDefs = sourceData.projectDefs;
        sharedChanged = true;
        for (const id of changedIds) {
          const encoded = encodeURIComponent(id);
          if (sourceDefs.has(id)) {
            appendConfigOp("projectDef.set", { value: sourceDefs.get(id) }, `projectDef/${encoded}`);
          } else {
            appendConfigOp("projectDef.delete", { idValue: id }, `projectDef/${encoded}`);
          }
        }
      }
    }

    if (includeDingtalk
      && sourceData.dingtalkMsgConfig
      && typeof sourceData.dingtalkMsgConfig === "object"
      && !sameJson(targetData.dingtalkMsgConfig, sourceData.dingtalkMsgConfig)) {
      next.dingtalkMsgConfig = sourceData.dingtalkMsgConfig;
      sharedChanged = true;
      appendConfigOp("dingtalkMsgConfig.set", { value: sourceData.dingtalkMsgConfig }, "dingtalkMsgConfig.set");
    }

    const sourceByProject = sourceData.byProject && typeof sourceData.byProject === "object" ? sourceData.byProject : {};
    for (const [projectId, sourceBucket] of Object.entries(sourceByProject)) {
      if (!sourceBucket || typeof sourceBucket !== "object") continue;
      const targetBucket = next.byProject[projectId] && typeof next.byProject[projectId] === "object" ? next.byProject[projectId] : {};
      const mergedBucket = { ...targetBucket };
      let bucketChanged = false;
      for (const key of keys) {
        if (!(key in sourceBucket)) continue;
        const candidate = key === "configMemory" || key === "lessons"
          ? mergeBoundedRows(targetBucket[key], sourceBucket[key], 200)
          : (key === "vehicleMap" && options.replaceVehicleMap !== true
            ? mergeObjects(targetBucket[key], sourceBucket[key])
            : sourceBucket[key]);
        if (sameJson(targetBucket[key], candidate)) continue;
        if (key === "vehicleMap") syncLeafMap(projectId, ["vehicleMap"], targetBucket[key], candidate);
        else if (key === "keywordMappings") syncKeywordMappings(projectId, targetBucket[key], candidate);
        else if (key === "statusMap") syncLeafMap(projectId, ["statusMap"], targetBucket[key], candidate);
        else if (key === "configMemory") syncRows("configMemory", projectId, targetBucket[key], candidate);
        else if (key === "lessons") syncRows("lesson", projectId, targetBucket[key], candidate);
        mergedBucket[key] = candidate;
        bucketChanged = true;
      }
      if (bucketChanged) {
        next.byProject[projectId] = mergedBucket;
        touchedBuckets += 1;
      }
    }

    if (!sharedChanged && touchedBuckets === 0) {
      return { updated: false, projectBuckets: 0, generatedOps: 0, keys: selectedKeys };
    }
    if (!generatedOps) versionCursor = Math.max(versionCursor + 1, Number(targetData._sharedVersion || 0) + 1);
    next._sharedVersion = versionCursor;
    writeShared(target, next, versionCursor, syncNode);
    return { updated: true, projectBuckets: touchedBuckets, generatedOps, keys: selectedKeys };
  }).immediate();
}

try {
  const adminRows = syncAdminUsers();
  const shared = syncSharedDevbenchData();
  source.close();
  target.close();
  console.log(JSON.stringify({ ok: true, adminRows, shared }));
} catch (err) {
  try { source.close(); } catch {}
  try { target.close(); } catch {}
  console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
}
