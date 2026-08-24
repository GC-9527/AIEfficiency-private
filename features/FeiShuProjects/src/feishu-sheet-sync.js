import {
  getFeishuProjectSyncConfig,
  getSourceProblemSummary,
  getSourceWorkItemNo,
  normalizeFeishuWorkItem,
} from "./gateway-sync-service.js";
import { withFeishuWebPage } from "./feishu-web-session.js";

export const DEFAULT_FEISHU_SHEET_SYNC_URL = "https://hcn8isyrecyp.feishu.cn/sheets/Y9Gys3Ps5hiu1HtjCHaciDwenNf";
export const FEISHU_SHEET_COLUMNS = [
  "序号",
  "系统单号",
  "钉钉单号",
  "问题地址",
  "应用",
  "测试类型",
  "问题等级",
  "提单时间",
  "问题",
  "开发",
  "状态",
  "必解标签",
  "处理方",
  "结论",
  "可走单时间",
  "发版时间",
  "同步人",
];

const FEISHU_SHEET_MAPPING_COLUMNS = [
  "钉钉单号",
  "TB任务ID",
  "TB 任务 ID",
  "TB单号",
  "TB 单号",
  "任务ID",
  "任务 ID",
  "问题编号",
  "飞书问题编号",
];

const ACTION_LABELS = {
  create: "新增",
  update: "更新",
  "sync-children": "更新",
  delete: "删除",
};

export function getFeishuSheetSyncConfig(overrides = {}) {
  const cfg = getFeishuProjectSyncConfig(overrides);
  const sheet = cfg.sheetSync || cfg.feishu?.sheetSync || {};
  return {
    enabled: sheet.enabled !== false,
    url: sheet.url || sheet.sheetUrl || DEFAULT_FEISHU_SHEET_SYNC_URL,
    keyColumn: sheet.keyColumn || "系统单号",
    headerRowIndex: Math.max(0, Number(sheet.headerRowIndex ?? 0) || 0),
    columns: Array.isArray(sheet.columns) && sheet.columns.length ? sheet.columns : FEISHU_SHEET_COLUMNS,
  };
}

export function buildFeishuSheetUpdatePlan(syncResult = {}, options = {}) {
  const cfg = getFeishuProjectSyncConfig(options.config || {});
  const sheetCfg = {
    ...getFeishuSheetSyncConfig(options.config || {}),
    ...(options.sheet || {}),
  };
  const columns = sheetCfg.columns || FEISHU_SHEET_COLUMNS;
  const keyColumn = sheetCfg.keyColumn || "系统单号";
  const existingRows = normalizeSheetRows(options.existingRows || [], columns);
  const existingByKey = new Map();
  for (const row of existingRows) {
    const key = sheetSystemNo(row, keyColumn);
    if (key && !existingByKey.has(key)) existingByKey.set(key, row);
  }

  let nextIndex = nextSheetIndex(existingRows);
  const items = [];
  const skipped = [];
  const plannedKeys = new Set();
  const results = collectSyncResults(syncResult);
  for (const result of results) {
    if (!result || result.ok === false) {
      skipped.push({ reason: "sync result failed", result: compactResult(result) });
      continue;
    }
    const action = ACTION_LABELS[result.action] ? result.action : "";
    if (!action || action === "skip") {
      skipped.push({ reason: "no sheet update action", result: compactResult(result) });
      continue;
    }
    if (action === "delete") {
      skipped.push({ reason: "sheet sync is append-only", result: compactResult(result) });
      continue;
    }
    const item = normalizeFeishuWorkItem(result.item || result.raw || {}, cfg);
    const newRow = buildSheetRowFromSyncResult(result, item, columns);
    const sourceNo = sheetSystemNo(newRow, keyColumn);
    if (!sourceNo) {
      skipped.push({ reason: "missing system no", result: compactResult(result) });
      continue;
    }
    const oldRow = existingByKey.get(sourceNo) || null;
    if (oldRow) {
      skipped.push({ reason: "sheet row already exists", sourceNo });
      continue;
    }
    if (plannedKeys.has(sourceNo)) {
      skipped.push({ reason: "duplicate system no in sync result", sourceNo });
      continue;
    }
    plannedKeys.add(sourceNo);

    if (columns.includes("序号") && !newRow["序号"]) newRow["序号"] = String(nextIndex++);

    const changes = columns.map((column) => ({ column, before: "", after: newRow[column] || "" })).filter((x) => x.after);
    items.push({
      action: "新增",
      sourceWorkItemId: item.sourceWorkItemId,
      sourceWorkItemNo: sourceNo,
      targetTaskId: result.targetTaskId || result.existing?.targetTaskId || "",
      targetUniqueId: normalizeTbNo(result.targetUniqueId || result.state?.targetUniqueId || result.existing?.targetUniqueId || result.remoteExisting?.targetUniqueId || ""),
      key: sourceNo || item.sourceWorkItemId,
      oldRow: oldRow ? pickColumns(oldRow, columns) : null,
      newRow: pickColumns(newRow, columns),
      changedColumns: changes.map((change) => change.column),
      changes,
      previewRows: buildPreviewRows("新增", null, newRow, columns),
    });
  }

  return {
    ok: true,
    sheetUrl: sheetCfg.url,
    columns,
    totalSyncResults: results.length,
    existingRowCount: existingRows.length,
    updateCount: items.length,
    actionCounts: countBy(items, (item) => item.action),
    items,
    skipped,
    warnings: options.warnings || [],
    generatedAt: new Date().toISOString(),
  };
}

export async function previewFeishuSheetUpdates(syncResult = {}, options = {}) {
  const sheetCfg = getFeishuSheetSyncConfig(options.config || {});
  const warnings = [];
  let existingRows = [];
  if (options.readSheet !== false) {
    try {
      const read = await readFeishuSheetRows({
        url: options.url || sheetCfg.url,
        timeoutMs: options.timeoutMs,
        columns: sheetCfg.columns,
      });
      existingRows = read.rows || [];
      warnings.push(...(read.warnings || []));
    } catch (err) {
      if (err?.needLogin) throw err;
      warnings.push(`读取飞书在线表格失败：${err?.message || String(err)}`);
    }
  }
  return buildFeishuSheetUpdatePlan(syncResult, {
    ...options,
    existingRows: options.existingRows || existingRows,
    warnings,
    sheet: { ...sheetCfg, url: options.url || sheetCfg.url },
  });
}

export async function readFeishuSheetRows({ url = DEFAULT_FEISHU_SHEET_SYNC_URL, timeoutMs = 60000, columns = FEISHU_SHEET_COLUMNS } = {}) {
  return withFeishuWebPage({ url, headless: true, timeoutMs }, async (page) => {
    await sleep(2500);
    let text = "";
    const domText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const domRows = parseTsvRows(domText, columns);
    if (domRows.length >= 1) return { ok: true, rows: domRows, source: "dom-text", warnings: [] };

    const origin = new URL(page.url()).origin;
    await page.browserContext?.().overridePermissions?.(origin, ["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.keyboard.down(modifierKey());
    await page.keyboard.press("A");
    await page.keyboard.press("C");
    await page.keyboard.up(modifierKey());
    await sleep(500);
    text = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch { return ""; }
    }).catch(() => "");
    const rows = parseTsvRows(text, columns);
    return {
      ok: true,
      rows,
      source: rows.length ? "clipboard" : "empty",
      warnings: rows.length ? [] : ["未能从飞书在线表格读取到可解析表格行，预览将只基于同步结果生成。"],
    };
  });
}

export async function applyFeishuSheetUpdatePlan(plan = {}, options = {}) {
  const items = Array.isArray(plan.items) ? plan.items : [];
  const columns = plan.columns || FEISHU_SHEET_COLUMNS;
  const editableItems = items.filter((item) => item.action === "新增" || item.action === "更新");
  const deleteItems = items.filter((item) => item.action === "删除");
  if (!editableItems.length && !deleteItems.length) return { ok: true, applied: 0, skipped: 0, message: "没有需要追加的飞书表格记录" };
  if (deleteItems.length) {
    return {
      ok: false,
      applied: 0,
      skipped: deleteItems.length,
      error: "当前网页态自动写表暂不执行删除行，请先人工确认删除后再继续。",
    };
  }

  const sheetUrl = options.url || plan.sheetUrl || DEFAULT_FEISHU_SHEET_SYNC_URL;
  const read = await readFeishuSheetRows({ url: sheetUrl, columns, timeoutMs: options.timeoutMs });
  const currentRows = normalizeSheetRows(read.rows || [], columns);
  const merged = mergeSheetRows(currentRows, editableItems, columns);
  if (!merged.applied) {
    return {
      ok: true,
      applied: 0,
      skipped: deleteItems.length + merged.skipped.length,
      message: "没有可追加的飞书表格记录",
      sheetUrl,
      rowCount: currentRows.length,
      readSource: read.source,
      warnings: [...(read.warnings || []), ...merged.skipped.map((item) => item.reason).filter(Boolean)],
    };
  }
  const matrix = [columns, ...merged.rows.map((row) => columns.map((column) => row[column] || ""))];
  const tsv = matrix.map((row) => row.map(escapeTsvCell).join("\t")).join("\n");

  return withFeishuWebPage({ url: sheetUrl, headless: false, timeoutMs: options.timeoutMs || 60000 }, async (page) => {
    await sleep(2000);
    const origin = new URL(page.url()).origin;
    await page.browserContext?.().overridePermissions?.(origin, ["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.evaluate((value) => navigator.clipboard?.writeText(value), tsv).catch(() => {});
    await page.keyboard.down(modifierKey());
    await page.keyboard.press("Home");
    await page.keyboard.up(modifierKey());
    await sleep(300);
    await page.keyboard.down(modifierKey());
    await page.keyboard.press("V");
    await page.keyboard.up(modifierKey());
    await sleep(1800);
    return {
      ok: true,
      applied: merged.applied,
      skipped: deleteItems.length + merged.skipped.length,
      mode: "rewrite-visible-table",
      sheetUrl,
      rowCount: merged.rows.length,
      readSource: read.source,
      warnings: [...(read.warnings || []), ...merged.skipped.map((item) => item.reason).filter(Boolean)],
    };
  });
}

function buildSheetRowFromSyncResult(result = {}, item = {}, columns = FEISHU_SHEET_COLUMNS) {
  const sourceNo = getSourceWorkItemNo(item);
  const targetTaskId = result.targetTaskId || result.existing?.targetTaskId || result.remoteExisting?.targetTaskId || "";
  const targetUniqueId = normalizeTbNo(result.targetUniqueId || result.state?.targetUniqueId || result.existing?.targetUniqueId || result.remoteExisting?.targetUniqueId || "");
  const problemName = buildSheetProblemName(item, sourceNo);
  const row = {
    "序号": readField(item, ["序号"]),
    "系统单号": sourceNo,
    "飞书问题编号": sourceNo,
    "问题编号": sourceNo,
    "钉钉单号": targetUniqueId,
    "TB单号": targetUniqueId,
    "TB 单号": targetUniqueId,
    "TB任务ID": targetTaskId,
    "TB 任务 ID": targetTaskId,
    "任务ID": targetTaskId,
    "任务 ID": targetTaskId,
    "问题地址": item.sourceWorkItemUrl || "",
    "应用": readField(item, ["应用", "所属应用", "功能模块", "模块", "field_95a8a4"]),
    "测试机构": readField(item, ["测试机构", "测试团队", "机构"]),
    "测试类型": readField(item, ["测试类型", "测试类别", "类型"]),
    "问题等级": item.severity || item.priority || readField(item, ["问题等级", "严重程度", "优先级"]),
    "提单时间": formatMonthDay(item.createdAt || item.updatedAt),
    "提单人": item.reporter?.name || item.reporter?.email || readField(item, ["提单人", "报告人", "创建人", "Reporter"]),
    "问题": problemName,
    "开发": readField(item, ["开发", "开发人员", "开发负责人", "问题责任人（角色）", "问题责任人", "role_bd6222", "当前负责人", "current_status_operator", "负责人"]) || peopleDisplay(item.assignees),
    "状态": item.status || readField(item, ["状态", "work_item_status"]),
    "必解标签": readField(item, ["必解标签", "必解", "标签"]),
    "处理方": readField(item, ["处理方", "责任部门", "所属部门", "field_3ec280"]),
    "结论": buildSheetConclusion(item),
    "可走单时间": formatMonthDay(readField(item, ["可走单时间", "走单时间", "可提测时间"])),
    "发版时间": formatMonthDay(readField(item, ["发版时间", "发布时间", "发布版本时间"])),
    "同步人": result.syncedBy || result.syncUser || result.operator || readField(item, ["同步人"]),
    "问题名称": problemName,
  };
  return pickColumns(row, columns);
}

function collectSyncResults(data = {}) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.result?.results)) return data.result.results;
  if (Array.isArray(data.result?.result?.results)) return data.result.result.results;
  return [];
}

function normalizeSheetRows(rows = [], columns = FEISHU_SHEET_COLUMNS) {
  return (rows || []).map((row) => Array.isArray(row)
    ? Object.fromEntries(columns.map((column, index) => [column, String(row[index] ?? "").trim()]))
    : pickColumns(row, columns));
}

function parseTsvRows(text = "", columns = FEISHU_SHEET_COLUMNS) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  let headerIndex = -1;
  const headerCandidates = Array.from(new Set([...(columns || []), ...FEISHU_SHEET_MAPPING_COLUMNS]));
  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitCells(lines[i]);
    const score = headerCandidates.filter((column) => cells.includes(column)).length;
    const hasMappingHeader = cells.includes("系统单号") && FEISHU_SHEET_MAPPING_COLUMNS.some((column) => cells.includes(column));
    if (score >= Math.min(5, Math.max(2, columns.length)) || hasMappingHeader) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return [];
  const header = splitCells(lines[headerIndex]);
  const indexes = columns.map((column) => header.indexOf(column));
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = splitCells(line);
    const row = {};
    for (let i = 0; i < header.length; i += 1) {
      const column = String(header[i] || "").trim();
      if (column) row[column] = String(cells[i] || "").trim();
    }
    for (let i = 0; i < columns.length; i += 1) row[columns[i]] = indexes[i] >= 0 ? String(cells[indexes[i]] || "").trim() : "";
    if (Object.values(row).some((value) => String(value || "").trim())) rows.push(row);
  }
  return rows;
}

function splitCells(line = "") {
  return String(line).split(/\t| {2,}/).map((cell) => cell.trim());
}

function mergeSheetRows(currentRows = [], items = [], columns = FEISHU_SHEET_COLUMNS) {
  const rows = currentRows.map((row) => pickColumns(row, columns));
  const indexByKey = new Map();
  rows.forEach((row, index) => {
    const key = sheetSystemNo(row);
    if (key && !indexByKey.has(key)) indexByKey.set(key, index);
  });
  let nextIndex = nextSheetIndex(rows);
  const skipped = [];
  let applied = 0;
  for (const item of items) {
    const row = pickColumns(item.newRow || {}, columns);
    if (columns.includes("序号") && !row["序号"]) row["序号"] = String(nextIndex++);
    const key = sheetSystemNo(row);
    if (!key) {
      skipped.push({ reason: "缺少系统单号，跳过表格追加" });
      continue;
    }
    if (indexByKey.has(key)) {
      skipped.push({ reason: `系统单号 ${key} 已存在，跳过重复追加`, sourceNo: key });
      continue;
    }
    indexByKey.set(key, rows.length);
    rows.push(row);
    applied += 1;
  }
  return { rows, applied, skipped };
}

function buildPreviewRows(action, oldRow, newRow, columns) {
  const rows = [
    { kind: "action", label: `动作：${action}` },
    { kind: "header", cells: columns },
  ];
  if (action === "更新" && oldRow) rows.push({ kind: "before", label: "当前", cells: columns.map((column) => oldRow[column] || "") });
  if (action === "删除" && oldRow) rows.push({ kind: "delete", label: "删除", cells: columns.map((column) => oldRow[column] || "") });
  else rows.push({ kind: action === "更新" ? "after" : "new", label: action === "更新" ? "变更为" : action, cells: columns.map((column) => newRow[column] || "") });
  return rows;
}

function diffSheetRows(oldRow = {}, newRow = {}, columns = FEISHU_SHEET_COLUMNS) {
  const changes = [];
  for (const column of columns) {
    const before = String(oldRow[column] || "").trim();
    const after = String(newRow[column] || "").trim();
    if (before !== after) changes.push({ column, before, after });
  }
  return changes;
}

function buildSheetProblemName(item = {}, sourceNo = "") {
  const title = stripLeadingSourceNo(String(item.title || getSourceProblemSummary(item) || "").trim(), sourceNo);
  return `【缺陷转载-8678】【阿维塔】${sourceNo || ""}${title || ""}`;
}

function buildSheetConclusion(item = {}) {
  const direct = readField(item, ["结论", "处理结论"]);
  if (direct) return direct;
  const cause = readField(item, ["原因", "根本原因", "问题原因", "field_52333f"]);
  const solution = readField(item, ["解决方案", "解决措施", "field_98c2a6"]);
  const improvement = readField(item, ["整改措施", "field_f73e06"]);
  return [
    labeledText("原因", cause),
    labeledText("解决方案", solution),
    labeledText("整改措施", improvement),
  ].filter(Boolean).join("\n");
}

function labeledText(label, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return new RegExp(`^${label}\\s*[：:]`).test(text) ? text : `${label}：${text}`;
}

function stripLeadingSourceNo(title = "", sourceNo = "") {
  const text = String(title || "").trim();
  const no = String(sourceNo || "").trim();
  if (!text || !no) return text;
  const escaped = no.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^${escaped}\\s*[-_：:、]?\\s*`, "i"), "").trim();
}

function sheetSystemNo(row = {}, keyColumn = "系统单号") {
  return String(row?.[keyColumn] || row?.["系统单号"] || "").trim();
}

function pickColumns(row = {}, columns = FEISHU_SHEET_COLUMNS) {
  const out = {};
  for (const column of columns) out[column] = String(row[column] ?? "").trim();
  return out;
}

function readField(item = {}, names = []) {
  const wanted = names.map(norm);
  for (const field of item.fields || []) {
    const key = norm(field.key || field.field_key || "");
    const name = norm(field.name || field.field_name || "");
    if (!wanted.includes(key) && !wanted.includes(name)) continue;
    return displayValue(field.value ?? field.displayValue ?? field.display_value);
  }
  for (const key of names) {
    const value = item.raw?.[key] ?? item[key];
    const text = displayValue(value);
    if (text) return text;
  }
  return "";
}

function displayValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join("、");
  if (typeof value === "object") return displayValue(value.name || value.label || value.value || value.text || value.email || value.user_key || value.id);
  return "";
}

function peopleDisplay(people = []) {
  return (Array.isArray(people) ? people : []).map((person) => person?.name || person?.email || person?.userKey || person?.id).filter(Boolean).join("、");
}

function normalizeTbNo(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^CARB-\d+$/i.test(raw)) return raw.toUpperCase();
  if (/^\d+$/.test(raw)) return `CARB-${raw}`;
  return raw;
}

function formatMonthDay(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value || "");
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function nextSheetIndex(rows = []) {
  const max = rows.reduce((acc, row) => Math.max(acc, Number(row?.["序号"]) || 0), 0);
  return max + 1;
}

function countBy(rows, keyFn) {
  return (rows || []).reduce((acc, row) => {
    const key = keyFn(row) || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function compactResult(result = {}) {
  return {
    ok: result?.ok,
    action: result?.action,
    targetTaskId: result?.targetTaskId,
    sourceWorkItemId: result?.item?.sourceWorkItemId || result?.item?.work_item_id,
  };
}

function escapeTsvCell(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\t/g, " ");
}

function modifierKey() {
  return process.platform === "darwin" ? "Meta" : "Control";
}

function norm(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_\-()（）]/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
