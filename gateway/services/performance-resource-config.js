import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, updateConfig } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PERFORMANCE_FEATURE_ROOT = path.join(REPO_ROOT, "features", "PerformanceFeature");
const DEFAULT_TASK_SCRIPT_ROOT_RELATIVE = "features/PerformanceFeature/performance-test-scripts/tasks";
const DEFAULT_TASK_PACKAGE_RELATIVE = `${DEFAULT_TASK_SCRIPT_ROOT_RELATIVE}/android/appmarket-cpu-memory`;
const TASK_SCRIPT_ROOT_RELATIVE = String(
  process.env.APPMARKET_PERFORMANCE_TASK_LIBRARY_ROOT || DEFAULT_TASK_SCRIPT_ROOT_RELATIVE,
).trim().replace(/\\/g, "/").replace(/^\.\//, "");
const TASK_SCRIPT_ROOT = path.resolve(REPO_ROOT, ...TASK_SCRIPT_ROOT_RELATIVE.split("/"));
const TASK_MANIFEST_NAME = "task.json";
const DEFAULT_RUNNER_RELATIVE = `${DEFAULT_TASK_PACKAGE_RELATIVE}/runner.py`;
const DEFAULT_FLOW_PATH = path.resolve(
  REPO_ROOT,
  ...DEFAULT_TASK_PACKAGE_RELATIVE.split("/"),
  "config",
  "appmarket_flow_config.json",
);

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SELECTOR_GROUPS = 100;
const MAX_SELECTORS_PER_GROUP = 100;
const MAX_SECONDARY_MENUS = 100;
const MAX_TASK_SCRIPTS = 100;
const MAX_WORKFLOW_STEPS = 100;
const MAX_UI_RUN_SECTIONS = 20;
const MAX_UI_VIEWS = 20;
const MAX_UI_FIELDS = 40;
const MAX_TASK_MANIFEST_BYTES = 128 * 1024;
// The task tree also contains source, tests, templates and documentation. Keep
// directory traversal bounded without letting those ordinary files consume a
// tiny manifest budget and hide otherwise valid tasks.
const MAX_TASK_LIBRARY_ENTRIES = 5000;
const MAX_TASK_LIBRARY_MANIFESTS = 100;
const TASK_DIRECTORY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PYTHON_REGEX_VALIDATION_TIMEOUT_MS = 5000;
const PYTHON_REGEX_VALIDATOR = String.raw`
import json
import re
import sys

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))

try:
    values = json.load(sys.stdin)
except Exception as exc:
    emit({"ok": False, "kind": "input", "error": str(exc)})
    sys.exit(3)

for item in values:
    try:
        re.compile(item["pattern"])
    except Exception as exc:
        emit({"ok": False, "kind": "regex", "path": item.get("path", "regex"), "error": str(exc)})
        sys.exit(2)

emit({"ok": True, "count": len(values)})
`;

const CONFIG_KEYS = new Set(["run", "flow", "defaultScriptId", "scripts", "managedScriptOverrides"]);
const MANAGED_SCRIPT_OVERRIDE_KEYS = new Set(["enabled", "run", "flow"]);
const MANAGED_SCRIPT_BASES = Symbol("managedScriptBases");
const RUN_KEYS = new Set([
  "serial",
  "flavor",
  "package",
  "duration",
  "interval",
  "samplingMode",
  "executeFlow",
  "captureScreenrecord",
  "capturePerfetto",
  "testAppTitle",
]);
const FLOW_KEYS = new Set([
  "schema_version",
  "package",
  "fixed_test_app_title",
  "timeouts",
  "thresholds",
  "selectors",
  "secondary_menus",
]);
const TIMEOUT_KEYS = new Set(["page_ready_s", "home_stable_samples", "install_s", "menu_dwell_s"]);
const THRESHOLD_KEYS = new Set([
  "required_duration_s",
  "required_sample_rows",
  "expected_logical_cpus",
  "cpu_customer_single_peak_pct",
  "cpu_multi_core_peak_pct",
  "cpu_customer_mean_pct",
  "pss_peak_mb",
  "pss_mean_mb",
  "minimum_valid_sample_ratio",
]);
const SELECTOR_KEYS = new Set([
  "resource_id",
  "resource_id_regex",
  "text",
  "text_regex",
  "desc_regex",
  "clickable",
  "enabled",
]);
const REGEX_SELECTOR_KEYS = new Set(["resource_id_regex", "text_regex", "desc_regex"]);
const MENU_KEYS = new Set(["id", "label", "selectors"]);
const SCRIPT_KEYS = new Set([
  "id",
  "name",
  "description",
  "enabled",
  "runner",
  "workflow",
  "ui",
  "run",
  "flow",
  "category",
  "tags",
  "sourceFiles",
  "version",
  "managed",
  "manifestPath",
  "available",
  "availabilityReason",
]);
const WORKFLOW_KEYS = new Set(["steps"]);
const WORKFLOW_STEP_KEYS = new Set(["key", "label", "eventSteps", "modes"]);
const WORKFLOW_MODES = new Set(["full", "launch-only"]);
const SAMPLING_MODES = new Set(["standard", "realtime"]);
const TASK_UI_KEYS = new Set(["schemaVersion", "defaultView", "runSections", "views"]);
const TASK_UI_SECTION_KEYS = new Set([
  "id",
  "kind",
  "label",
  "title",
  "description",
  "source",
  "samplingModes",
  "showInHistory",
  "metrics",
  "columns",
  "artifactKeys",
  "emptyText",
]);
const TASK_UI_FIELD_KEYS = new Set(["key", "label", "unit", "color", "decimals"]);
const TASK_UI_RUN_KINDS = new Set(["workflow", "live"]);
const TASK_UI_VIEW_KINDS = new Set(["dashboard", "live", "table", "artifacts", "report", "json"]);
const TASK_UI_BUILTIN_SOURCES = new Set(["samples", "diagnosticSamples"]);
const REQUIRED_SELECTOR_GROUPS = [
  "home_ready",
  "catalog_empty",
  "app_card",
  "detail_ready",
  "download",
  "installed",
  "installer_action",
  "home_tab",
  "my_tab",
  "my_ready",
];

const DEFAULT_FLOW = JSON.parse(fs.readFileSync(DEFAULT_FLOW_PATH, "utf8"));
let cachedRegexPython = null;
let latestTaskLibraryIssues = [];
export const DEFAULT_PERFORMANCE_RESOURCE_RUN = Object.freeze({
  serial: "",
  flavor: "",
  package: DEFAULT_FLOW.package || "com.appmarket.automotive",
  duration: 180,
  interval: 5,
  samplingMode: "standard",
  executeFlow: true,
  captureScreenrecord: true,
  capturePerfetto: false,
  testAppTitle: "",
});

const DEFAULT_WORKFLOW = Object.freeze({
  steps: Object.freeze([
    Object.freeze({ key: "launch", label: "启动并等待首页", eventSteps: Object.freeze(["launch", "select_home"]), modes: Object.freeze(["full", "launch-only"]) }),
    Object.freeze({ key: "detail", label: "进入应用详情", eventSteps: Object.freeze(["scroll_catalog", "open_detail"]), modes: Object.freeze(["full"]) }),
    Object.freeze({ key: "scroll", label: "下滑至详情底部", eventSteps: Object.freeze(["scroll_detail"]), modes: Object.freeze(["full"]) }),
    Object.freeze({ key: "install", label: "下载并安装", eventSteps: Object.freeze(["download_install", "installer_confirm"]), modes: Object.freeze(["full"]) }),
    Object.freeze({ key: "home", label: "返回应用市场首页", eventSteps: Object.freeze(["return_home"]), modes: Object.freeze(["full"]) }),
    Object.freeze({ key: "mine", label: "进入“我的”页面", eventSteps: Object.freeze(["open_my"]), modes: Object.freeze(["full"]) }),
    Object.freeze({ key: "menus", label: "浏览二级菜单", eventSteps: Object.freeze(["browse_menu"]), modes: Object.freeze(["full"]) }),
    Object.freeze({ key: "flow", label: "自动化脚本结束", eventSteps: Object.freeze(["flow"]), modes: Object.freeze(["full", "launch-only"]) }),
  ]),
});

const DEFAULT_TASK_UI = Object.freeze({
  schemaVersion: 1,
  defaultView: "dashboard",
  runSections: Object.freeze([
    Object.freeze({
      id: "workflow",
      kind: "workflow",
      label: "测试任务工作流",
      title: "测试任务工作流",
      description: "采集主线与脚本任务并行；页面按本轮冻结的工作流快照映射步骤事件。",
      source: "",
      showInHistory: true,
      metrics: Object.freeze([]),
      columns: Object.freeze([]),
      artifactKeys: Object.freeze([]),
      emptyText: "",
    }),
  ]),
  views: Object.freeze([
    Object.freeze({ id: "dashboard", kind: "dashboard", label: "仪表盘", title: "仪表盘", description: "", source: "", showInHistory: true, metrics: Object.freeze([]), columns: Object.freeze([]), artifactKeys: Object.freeze([]), emptyText: "" }),
    Object.freeze({ id: "raw", kind: "table", label: "原始数据", title: "逐点原始数据", description: "", source: "samples", showInHistory: true, metrics: Object.freeze([]), columns: Object.freeze([]), artifactKeys: Object.freeze([]), emptyText: "本轮未返回逐点样本" }),
    Object.freeze({ id: "report", kind: "report", label: "报表", title: "采集报告", description: "", source: "", showInHistory: true, metrics: Object.freeze([]), columns: Object.freeze([]), artifactKeys: Object.freeze([]), emptyText: "本轮尚未生成报表" }),
  ]),
});

export const DEFAULT_PERFORMANCE_RESOURCE_SCRIPT_ID = "appmarket-default";
export const DEFAULT_PERFORMANCE_RESOURCE_SCRIPT = Object.freeze({
  id: DEFAULT_PERFORMANCE_RESOURCE_SCRIPT_ID,
  name: "应用市场完整性能测试",
  description: "启动应用市场、下载安装应用并遍历“我的”二级菜单，同时采集 CPU 与内存。",
  category: "应用市场",
  tags: Object.freeze(["CPU", "内存", "完整流程"]),
  sourceFiles: Object.freeze([
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/runner.py`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/src/appmarket_perf_runner.py`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/src/android_app_perf_sampler.py`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/src/appmarket_flow.py`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/src/analyze_appmarket_perf.py`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/src/performance_pdf_report.py`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/src/performance_json_io.py`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/config/appmarket_flow_config.json`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/config/appmarket_perfetto.pbtxt`,
    `${DEFAULT_TASK_PACKAGE_RELATIVE}/requirements.txt`,
  ]),
  version: "1",
  managed: false,
  manifestPath: "",
  available: true,
  availabilityReason: "",
  enabled: true,
  runner: DEFAULT_RUNNER_RELATIVE,
  workflow: DEFAULT_WORKFLOW,
  run: Object.freeze({}),
  flow: Object.freeze({}),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function configError(pathName, message) {
  const error = new Error(`${pathName} ${message}`);
  error.code = "INVALID_PERFORMANCE_RESOURCE_CONFIG";
  return error;
}

function requireObject(value, pathName) {
  if (!isPlainObject(value)) throw configError(pathName, "必须是 JSON 对象");
  return value;
}

function rejectUnknownKeys(value, allowed, pathName) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw configError(`${pathName}.${key}`, "不是支持的配置项");
  }
}

function requireString(value, pathName, { maxLength, allowEmpty = true, pattern } = {}) {
  if (typeof value !== "string") throw configError(pathName, "必须是字符串");
  if (/\0|[\r\n]/.test(value)) throw configError(pathName, "不能包含换行或 NUL 字符");
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw configError(pathName, "不能为空");
  if (maxLength && normalized.length > maxLength) {
    throw configError(pathName, `长度不能超过 ${maxLength}`);
  }
  if (pattern && normalized && !pattern.test(normalized)) throw configError(pathName, "格式无效");
  return normalized;
}

function requireBoolean(value, pathName) {
  if (typeof value !== "boolean") throw configError(pathName, "必须是布尔值");
  return value;
}

function requireNumber(value, pathName, { min, max, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw configError(pathName, "必须是有限数字");
  if (integer && !Number.isInteger(value)) throw configError(pathName, "必须是整数");
  if (min !== undefined && value < min) throw configError(pathName, `不能小于 ${min}`);
  if (max !== undefined && value > max) throw configError(pathName, `不能大于 ${max}`);
  return value;
}

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function validateRunnerPath(value, pathName, { requireFile = true } = {}) {
  const raw = requireString(value, pathName, { maxLength: 500, allowEmpty: false });
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || raw.includes(":")) {
    throw configError(pathName, "必须是仓库内的相对路径");
  }
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    !normalized.startsWith("features/PerformanceFeature/")
    || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
    || !/\.py$/i.test(normalized)
  ) {
    throw configError(pathName, "必须指向 features/PerformanceFeature 下的 .py 文件");
  }
  const candidate = path.resolve(REPO_ROOT, ...parts);
  if (!isContained(PERFORMANCE_FEATURE_ROOT, candidate) || candidate === PERFORMANCE_FEATURE_ROOT) {
    throw configError(pathName, "路径越界");
  }
  if (requireFile) {
    try {
      const featureRootReal = fs.realpathSync.native(PERFORMANCE_FEATURE_ROOT);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not a regular file");
      const real = fs.realpathSync.native(candidate);
      if (!isContained(featureRootReal, real) || real === featureRootReal) throw new Error("outside feature root");
    } catch {
      throw configError(pathName, "必须是现有的普通文件，且不能是符号链接");
    }
  }
  return normalized;
}

function validateFeatureFilePath(value, pathName, { requireFile = true } = {}) {
  const raw = requireString(value, pathName, { maxLength: 500, allowEmpty: false });
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw) || raw.includes(":")) {
    throw configError(pathName, "必须是仓库内的相对路径");
  }
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    !normalized.startsWith("features/PerformanceFeature/")
    || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))
  ) {
    throw configError(pathName, "必须指向 features/PerformanceFeature 下的文件");
  }
  const candidate = path.resolve(REPO_ROOT, ...parts);
  if (!isContained(PERFORMANCE_FEATURE_ROOT, candidate) || candidate === PERFORMANCE_FEATURE_ROOT) {
    throw configError(pathName, "路径越界");
  }
  if (requireFile) {
    try {
      const featureRootReal = fs.realpathSync.native(PERFORMANCE_FEATURE_ROOT);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("not a regular file");
      const real = fs.realpathSync.native(candidate);
      if (!isContained(featureRootReal, real) || real === featureRootReal) throw new Error("outside feature root");
    } catch {
      throw configError(pathName, "必须是现有的普通文件，且不能是符号链接");
    }
  }
  return normalized;
}

function validateStringArray(raw, pathName, { maxItems = 20, maxLength = 120 } = {}) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw configError(pathName, "必须是数组");
  if (raw.length > maxItems) throw configError(pathName, `不能超过 ${maxItems} 项`);
  const seen = new Set();
  return raw.map((value, index) => {
    const normalized = requireString(value, `${pathName}[${index}]`, { maxLength, allowEmpty: false });
    if (seen.has(normalized)) throw configError(`${pathName}[${index}]`, "不能重复");
    seen.add(normalized);
    return normalized;
  });
}

function validateTaskManifestLocation(absolute) {
  const relative = path.relative(TASK_SCRIPT_ROOT, absolute).replace(/\\/g, "/");
  const parts = relative.split("/");
  if (
    parts.length !== 5
    || parts[2] !== "profiles"
    || parts[4] !== TASK_MANIFEST_NAME
    || !TASK_DIRECTORY_NAME_PATTERN.test(parts[0])
    || !TASK_DIRECTORY_NAME_PATTERN.test(parts[1])
    || !TASK_DIRECTORY_NAME_PATTERN.test(parts[3])
  ) {
    throw new Error(
      "task.json 必须位于 tasks/<platform>/<task-package>/profiles/<profile-id>/task.json，目录名使用小写 kebab-case",
    );
  }
  return relative;
}

function discoverTaskManifestDefinitions() {
  const definitions = [];
  const issues = [];
  let visitedEntries = 0;
  let manifestsSeen = 0;
  let entryLimitReached = false;
  let manifestLimitReached = false;
  let rootReal;
  const rootParts = TASK_SCRIPT_ROOT_RELATIVE.split("/");
  if (
    !TASK_SCRIPT_ROOT_RELATIVE.startsWith("features/PerformanceFeature/")
    || path.isAbsolute(TASK_SCRIPT_ROOT_RELATIVE)
    || path.win32.isAbsolute(TASK_SCRIPT_ROOT_RELATIVE)
    || rootParts.some((part) => !part || part === "." || part === "..")
    || !isContained(PERFORMANCE_FEATURE_ROOT, TASK_SCRIPT_ROOT)
    || TASK_SCRIPT_ROOT === PERFORMANCE_FEATURE_ROOT
  ) {
    return {
      definitions,
      issues: [{
        manifestPath: DEFAULT_TASK_SCRIPT_ROOT_RELATIVE,
        message: "脚本库根目录必须是 features/PerformanceFeature 下的仓库相对目录",
      }],
    };
  }
  try {
    const rootStat = fs.lstatSync(TASK_SCRIPT_ROOT);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("脚本库根目录不是普通目录");
    rootReal = fs.realpathSync.native(TASK_SCRIPT_ROOT);
  } catch (error) {
    return {
      definitions,
      issues: [{ manifestPath: TASK_SCRIPT_ROOT_RELATIVE, message: `脚本库不可用：${error.message}` }],
    };
  }

  const visit = (directory) => {
    if (entryLimitReached) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      issues.push({
        manifestPath: path.relative(REPO_ROOT, directory).replace(/\\/g, "/"),
        message: `目录读取失败：${error.message}`,
      });
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (visitedEntries >= MAX_TASK_LIBRARY_ENTRIES) {
        entryLimitReached = true;
        break;
      }
      visitedEntries += 1;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({
          manifestPath: path.relative(REPO_ROOT, absolute).replace(/\\/g, "/"),
          message: "脚本库不允许符号链接",
        });
        continue;
      }
      if (entry.isDirectory()) {
        let real;
        try {
          real = fs.realpathSync.native(absolute);
        } catch (error) {
          issues.push({
            manifestPath: path.relative(REPO_ROOT, absolute).replace(/\\/g, "/"),
            message: `目录解析失败：${error.message}`,
          });
          continue;
        }
        if (!isContained(rootReal, real)) {
          issues.push({
            manifestPath: path.relative(REPO_ROOT, absolute).replace(/\\/g, "/"),
            message: "目录越过脚本库边界",
          });
          continue;
        }
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || entry.name !== TASK_MANIFEST_NAME) continue;
      const manifestPath = path.relative(REPO_ROOT, absolute).replace(/\\/g, "/");
      manifestsSeen += 1;
      if (manifestsSeen > MAX_TASK_LIBRARY_MANIFESTS) {
        manifestLimitReached = true;
        continue;
      }
      try {
        validateTaskManifestLocation(absolute);
        const stat = fs.lstatSync(absolute);
        if (stat.size <= 0 || stat.size > MAX_TASK_MANIFEST_BYTES) {
          throw new Error(`task.json 大小必须在 1~${MAX_TASK_MANIFEST_BYTES} 字节之间`);
        }
        const raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
        if (!isPlainObject(raw)) throw new Error("task.json 必须是 JSON 对象");
        definitions.push({
          ...raw,
          managed: true,
          manifestPath,
          available: true,
          availabilityReason: "",
        });
      } catch (error) {
        issues.push({ manifestPath, message: error.message });
      }
    }
  };
  visit(TASK_SCRIPT_ROOT);
  if (entryLimitReached) {
    issues.push({
      manifestPath: TASK_SCRIPT_ROOT_RELATIVE,
      message: `脚本库目录项超过 ${MAX_TASK_LIBRARY_ENTRIES}，后续条目未扫描`,
    });
  }
  if (manifestLimitReached) {
    issues.push({
      manifestPath: TASK_SCRIPT_ROOT_RELATIVE,
      message: `脚本库 task.json 超过 ${MAX_TASK_LIBRARY_MANIFESTS} 个，超出清单已忽略`,
    });
  }
  return { definitions, issues };
}

function validateWorkflow(raw, pathName) {
  const workflow = requireObject(raw, pathName);
  rejectUnknownKeys(workflow, WORKFLOW_KEYS, pathName);
  if (!Array.isArray(workflow.steps)) throw configError(`${pathName}.steps`, "必须是数组");
  if (!workflow.steps.length) throw configError(`${pathName}.steps`, "不能为空");
  if (workflow.steps.length > MAX_WORKFLOW_STEPS) {
    throw configError(`${pathName}.steps`, `不能超过 ${MAX_WORKFLOW_STEPS} 项`);
  }
  const keys = new Set();
  const mappedEvents = new Set();
  const steps = workflow.steps.map((rawStep, index) => {
    const stepPath = `${pathName}.steps[${index}]`;
    const step = requireObject(rawStep, stepPath);
    rejectUnknownKeys(step, WORKFLOW_STEP_KEYS, stepPath);
    const key = requireString(step.key, `${stepPath}.key`, {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    });
    if (keys.has(key)) throw configError(`${stepPath}.key`, "不能重复");
    keys.add(key);
    if (!Array.isArray(step.eventSteps) || !step.eventSteps.length) {
      throw configError(`${stepPath}.eventSteps`, "必须是非空数组");
    }
    if (step.eventSteps.length > 20) throw configError(`${stepPath}.eventSteps`, "不能超过 20 项");
    const eventSteps = step.eventSteps.map((value, eventIndex) => {
      const eventPath = `${stepPath}.eventSteps[${eventIndex}]`;
      const eventStep = requireString(value, eventPath, {
        maxLength: 80,
        allowEmpty: false,
        pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
      });
      if (mappedEvents.has(eventStep)) throw configError(eventPath, "已映射到其他工作流节点");
      mappedEvents.add(eventStep);
      return eventStep;
    });
    const rawModes = step.modes === undefined ? ["full", "launch-only"] : step.modes;
    if (!Array.isArray(rawModes) || !rawModes.length) throw configError(`${stepPath}.modes`, "必须是非空数组");
    const modes = rawModes.map((value, modeIndex) => {
      const mode = requireString(value, `${stepPath}.modes[${modeIndex}]`, { maxLength: 20, allowEmpty: false });
      if (!WORKFLOW_MODES.has(mode)) throw configError(`${stepPath}.modes[${modeIndex}]`, "仅支持 full 或 launch-only");
      return mode;
    });
    if (new Set(modes).size !== modes.length) throw configError(`${stepPath}.modes`, "不能重复");
    return {
      key,
      label: requireString(step.label, `${stepPath}.label`, { maxLength: 120, allowEmpty: false }),
      eventSteps,
      modes,
    };
  });
  return { steps };
}

function validateTaskUiField(raw, pathName, { color = true } = {}) {
  const field = requireObject(raw, pathName);
  rejectUnknownKeys(field, TASK_UI_FIELD_KEYS, pathName);
  const normalized = {
    key: requireString(field.key, `${pathName}.key`, {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    }),
    label: requireString(field.label, `${pathName}.label`, { maxLength: 120, allowEmpty: false }),
    unit: requireString(field.unit ?? "", `${pathName}.unit`, { maxLength: 24 }),
    color: requireString(field.color ?? "", `${pathName}.color`, { maxLength: 7 }),
    decimals: requireNumber(field.decimals ?? 2, `${pathName}.decimals`, { min: 0, max: 6, integer: true }),
  };
  if (normalized.color && (!color || !/^#[0-9A-Fa-f]{6}$/.test(normalized.color))) {
    throw configError(`${pathName}.color`, "必须是 #RRGGBB 颜色");
  }
  return normalized;
}

function validateTaskUiSection(raw, pathName, kinds) {
  const section = requireObject(raw, pathName);
  rejectUnknownKeys(section, TASK_UI_SECTION_KEYS, pathName);
  const kind = requireString(section.kind, `${pathName}.kind`, { maxLength: 40, allowEmpty: false });
  if (!kinds.has(kind)) throw configError(`${pathName}.kind`, `不支持 ${kind}`);
  const source = requireString(section.source ?? "", `${pathName}.source`, { maxLength: 100 });
  if (source && !TASK_UI_BUILTIN_SOURCES.has(source) && !/^event:[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(source)) {
    throw configError(`${pathName}.source`, "仅支持 samples、diagnosticSamples 或 event:<channel>");
  }
  if (kind === "live" && !source) throw configError(`${pathName}.source`, "实时区块必须声明数据源");
  const rawSamplingModes = section.samplingModes ?? ["standard", "realtime"];
  if (!Array.isArray(rawSamplingModes) || !rawSamplingModes.length || rawSamplingModes.length > SAMPLING_MODES.size) {
    throw configError(`${pathName}.samplingModes`, "必须是 standard/realtime 的非空数组");
  }
  const samplingModes = rawSamplingModes.map((mode, index) => {
    const value = requireString(mode, `${pathName}.samplingModes[${index}]`, { maxLength: 20, allowEmpty: false });
    if (!SAMPLING_MODES.has(value)) throw configError(`${pathName}.samplingModes[${index}]`, "仅支持 standard 或 realtime");
    return value;
  });
  if (new Set(samplingModes).size !== samplingModes.length) throw configError(`${pathName}.samplingModes`, "不能重复");
  const metricsRaw = section.metrics ?? [];
  const columnsRaw = section.columns ?? [];
  if (!Array.isArray(metricsRaw) || metricsRaw.length > MAX_UI_FIELDS) {
    throw configError(`${pathName}.metrics`, `必须是数组且不能超过 ${MAX_UI_FIELDS} 项`);
  }
  if (!Array.isArray(columnsRaw) || columnsRaw.length > MAX_UI_FIELDS) {
    throw configError(`${pathName}.columns`, `必须是数组且不能超过 ${MAX_UI_FIELDS} 项`);
  }
  const metrics = metricsRaw.map((item, index) => validateTaskUiField(item, `${pathName}.metrics[${index}]`));
  const columns = columnsRaw.map((item, index) => validateTaskUiField(item, `${pathName}.columns[${index}]`, { color: false }));
  for (const [key, values] of [["metrics", metrics], ["columns", columns]]) {
    const seen = new Set();
    for (const value of values) {
      if (seen.has(value.key)) throw configError(`${pathName}.${key}`, `字段 ${value.key} 不能重复`);
      seen.add(value.key);
    }
  }
  if (kind === "live" && !metrics.length) throw configError(`${pathName}.metrics`, "实时区块至少需要一个指标");
  const artifactKeys = validateStringArray(section.artifactKeys, `${pathName}.artifactKeys`, {
    maxItems: 50,
    maxLength: 120,
  });
  artifactKeys.forEach((key, index) => {
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key)) {
      throw configError(`${pathName}.artifactKeys[${index}]`, "格式无效");
    }
  });
  return {
    id: requireString(section.id, `${pathName}.id`, {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    }),
    kind,
    label: requireString(section.label, `${pathName}.label`, { maxLength: 120, allowEmpty: false }),
    title: requireString(section.title ?? section.label, `${pathName}.title`, { maxLength: 160, allowEmpty: false }),
    description: requireString(section.description ?? "", `${pathName}.description`, { maxLength: 500 }),
    source,
    samplingModes,
    showInHistory: section.showInHistory === undefined
      ? kind !== "live"
      : requireBoolean(section.showInHistory, `${pathName}.showInHistory`),
    metrics,
    columns,
    artifactKeys,
    emptyText: requireString(section.emptyText ?? "", `${pathName}.emptyText`, { maxLength: 300 }),
  };
}

function validateTaskUi(raw, pathName) {
  if (raw === undefined) return clone(DEFAULT_TASK_UI);
  const ui = requireObject(raw, pathName);
  rejectUnknownKeys(ui, TASK_UI_KEYS, pathName);
  const schemaVersion = requireNumber(ui.schemaVersion ?? 1, `${pathName}.schemaVersion`, { min: 1, max: 1, integer: true });
  const runRaw = ui.runSections ?? [];
  const viewsRaw = ui.views ?? [];
  if (!Array.isArray(runRaw) || runRaw.length > MAX_UI_RUN_SECTIONS) {
    throw configError(`${pathName}.runSections`, `必须是数组且不能超过 ${MAX_UI_RUN_SECTIONS} 项`);
  }
  if (!Array.isArray(viewsRaw) || !viewsRaw.length || viewsRaw.length > MAX_UI_VIEWS) {
    throw configError(`${pathName}.views`, `必须是非空数组且不能超过 ${MAX_UI_VIEWS} 项`);
  }
  const runSections = runRaw.map((item, index) => validateTaskUiSection(item, `${pathName}.runSections[${index}]`, TASK_UI_RUN_KINDS));
  const views = viewsRaw.map((item, index) => validateTaskUiSection(item, `${pathName}.views[${index}]`, TASK_UI_VIEW_KINDS));
  const ids = new Set();
  for (const section of [...runSections, ...views]) {
    if (ids.has(section.id)) throw configError(pathName, `区块 ID ${section.id} 不能重复`);
    ids.add(section.id);
  }
  const defaultView = requireString(ui.defaultView ?? views[0].id, `${pathName}.defaultView`, {
    maxLength: 80,
    allowEmpty: false,
    pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
  });
  if (!views.some((view) => view.id === defaultView)) {
    throw configError(`${pathName}.defaultView`, "必须引用 views 中存在的 ID");
  }
  return { schemaVersion, defaultView, runSections, views };
}

function validateSelector(raw, pathName) {
  const selector = requireObject(raw, pathName);
  rejectUnknownKeys(selector, SELECTOR_KEYS, pathName);
  const keys = Object.keys(selector);
  if (!keys.length) throw configError(pathName, "至少需要一个匹配字段");
  const normalized = {};
  for (const key of keys) {
    if (key === "clickable" || key === "enabled") {
      normalized[key] = requireBoolean(selector[key], `${pathName}.${key}`);
    } else {
      const value = requireString(selector[key], `${pathName}.${key}`, {
        maxLength: 500,
        allowEmpty: false,
      });
      normalized[key] = value;
    }
  }
  return normalized;
}

function validateSelectorList(raw, pathName) {
  if (!Array.isArray(raw)) throw configError(pathName, "必须是数组");
  if (!raw.length) throw configError(pathName, "不能为空");
  if (raw.length > MAX_SELECTORS_PER_GROUP) {
    throw configError(pathName, `不能超过 ${MAX_SELECTORS_PER_GROUP} 项`);
  }
  return raw.map((selector, index) => validateSelector(selector, `${pathName}[${index}]`));
}

function validateRun(raw, pathName = "run") {
  const run = requireObject(raw, pathName);
  rejectUnknownKeys(run, RUN_KEYS, pathName);
  const duration = requireNumber(run.duration, `${pathName}.duration`, { min: 5, max: 3600 });
  const interval = requireNumber(run.interval, `${pathName}.interval`, { min: 1, max: 60 });
  const samplingMode = requireString(run.samplingMode ?? "standard", `${pathName}.samplingMode`, {
    maxLength: 20,
    allowEmpty: false,
  });
  if (!SAMPLING_MODES.has(samplingMode)) {
    throw configError(`${pathName}.samplingMode`, "必须是 standard 或 realtime");
  }
  if (samplingMode === "realtime" && Math.abs(interval - 5) > 1e-9) {
    throw configError(`${pathName}.interval`, "实时诊断的正式 CPU/PSS 采样间隔必须为 5 秒");
  }
  if (Math.abs(duration / interval - Math.round(duration / interval)) > 1e-9) {
    throw configError(`${pathName}.duration`, `必须是 ${pathName}.interval 的整数倍`);
  }
  const capturePerfetto = requireBoolean(run.capturePerfetto, `${pathName}.capturePerfetto`);
  return {
    serial: requireString(run.serial, `${pathName}.serial`, {
      maxLength: 128,
      pattern: /^[A-Za-z0-9._:-]+$/,
    }),
    flavor: requireString(run.flavor, `${pathName}.flavor`, {
      maxLength: 80,
      pattern: /^[A-Za-z0-9_.-]+$/,
    }),
    package: requireString(run.package, `${pathName}.package`, {
      maxLength: 160,
      allowEmpty: false,
      pattern: /^[A-Za-z0-9_.]+$/,
    }),
    duration,
    interval,
    samplingMode,
    executeFlow: requireBoolean(run.executeFlow, `${pathName}.executeFlow`),
    captureScreenrecord: requireBoolean(run.captureScreenrecord, `${pathName}.captureScreenrecord`),
    capturePerfetto: samplingMode === "realtime" || capturePerfetto,
    testAppTitle: requireString(run.testAppTitle, `${pathName}.testAppTitle`, { maxLength: 120 }),
  };
}

function validateFlow(raw, runPackage, pathName = "flow") {
  const flow = requireObject(raw, pathName);
  rejectUnknownKeys(flow, FLOW_KEYS, pathName);
  requireString(flow.package, `${pathName}.package`, {
    maxLength: 160,
    allowEmpty: false,
    pattern: /^[A-Za-z0-9_.]+$/,
  });
  const timeouts = requireObject(flow.timeouts, `${pathName}.timeouts`);
  rejectUnknownKeys(timeouts, TIMEOUT_KEYS, `${pathName}.timeouts`);
  const thresholds = requireObject(flow.thresholds, `${pathName}.thresholds`);
  rejectUnknownKeys(thresholds, THRESHOLD_KEYS, `${pathName}.thresholds`);
  const selectors = requireObject(flow.selectors, `${pathName}.selectors`);
  const selectorEntries = Object.entries(selectors);
  if (!selectorEntries.length) throw configError(`${pathName}.selectors`, "不能为空");
  if (selectorEntries.length > MAX_SELECTOR_GROUPS) {
    throw configError(`${pathName}.selectors`, `不能超过 ${MAX_SELECTOR_GROUPS} 组`);
  }
  const normalizedSelectors = {};
  for (const [name, list] of selectorEntries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name)) {
      throw configError(`${pathName}.selectors.${name}`, "分组名称格式无效");
    }
    normalizedSelectors[name] = validateSelectorList(list, `${pathName}.selectors.${name}`);
  }
  for (const name of REQUIRED_SELECTOR_GROUPS) {
    if (!normalizedSelectors[name]) throw configError(`${pathName}.selectors.${name}`, "是固定流程必需的选择器分组");
  }

  if (!Array.isArray(flow.secondary_menus)) throw configError(`${pathName}.secondary_menus`, "必须是数组");
  if (flow.secondary_menus.length > MAX_SECONDARY_MENUS) {
    throw configError(`${pathName}.secondary_menus`, `不能超过 ${MAX_SECONDARY_MENUS} 项`);
  }
  const menuIds = new Set();
  const secondaryMenus = flow.secondary_menus.map((rawMenu, index) => {
    const menuPath = `${pathName}.secondary_menus[${index}]`;
    const menu = requireObject(rawMenu, menuPath);
    rejectUnknownKeys(menu, MENU_KEYS, menuPath);
    const id = requireString(menu.id, `${menuPath}.id`, {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z0-9_.-]+$/,
    });
    if (menuIds.has(id)) throw configError(`${menuPath}.id`, "不能重复");
    menuIds.add(id);
    return {
      id,
      label: requireString(menu.label, `${menuPath}.label`, { maxLength: 120, allowEmpty: false }),
      selectors: validateSelectorList(menu.selectors, `${menuPath}.selectors`),
    };
  });

  return {
    schema_version: requireNumber(flow.schema_version, `${pathName}.schema_version`, { min: 1, max: 100, integer: true }),
    // 实际运行包名由 run 参数控制；保存时同步，避免配置页出现两套互相冲突的包名。
    package: runPackage,
    fixed_test_app_title: requireString(flow.fixed_test_app_title, `${pathName}.fixed_test_app_title`, { maxLength: 120 }),
    timeouts: {
      page_ready_s: requireNumber(timeouts.page_ready_s, `${pathName}.timeouts.page_ready_s`, { min: 1, max: 300 }),
      home_stable_samples: requireNumber(timeouts.home_stable_samples ?? 3, `${pathName}.timeouts.home_stable_samples`, { min: 1, max: 20, integer: true }),
      install_s: requireNumber(timeouts.install_s, `${pathName}.timeouts.install_s`, { min: 1, max: 1800 }),
      menu_dwell_s: requireNumber(timeouts.menu_dwell_s, `${pathName}.timeouts.menu_dwell_s`, { min: 0, max: 60 }),
    },
    thresholds: {
      required_duration_s: requireNumber(thresholds.required_duration_s, `${pathName}.thresholds.required_duration_s`, { min: 5, max: 3600 }),
      required_sample_rows: requireNumber(thresholds.required_sample_rows, `${pathName}.thresholds.required_sample_rows`, { min: 1, max: 3600, integer: true }),
      expected_logical_cpus: requireNumber(thresholds.expected_logical_cpus, `${pathName}.thresholds.expected_logical_cpus`, { min: 1, max: 256, integer: true }),
      cpu_customer_single_peak_pct: requireNumber(thresholds.cpu_customer_single_peak_pct, `${pathName}.thresholds.cpu_customer_single_peak_pct`, { min: 0, max: 10000 }),
      cpu_multi_core_peak_pct: requireNumber(thresholds.cpu_multi_core_peak_pct, `${pathName}.thresholds.cpu_multi_core_peak_pct`, { min: 0, max: 10000 }),
      cpu_customer_mean_pct: requireNumber(thresholds.cpu_customer_mean_pct, `${pathName}.thresholds.cpu_customer_mean_pct`, { min: 0, max: 10000 }),
      pss_peak_mb: requireNumber(thresholds.pss_peak_mb, `${pathName}.thresholds.pss_peak_mb`, { min: 0, max: 1_000_000 }),
      pss_mean_mb: requireNumber(thresholds.pss_mean_mb, `${pathName}.thresholds.pss_mean_mb`, { min: 0, max: 1_000_000 }),
      minimum_valid_sample_ratio: requireNumber(thresholds.minimum_valid_sample_ratio, `${pathName}.thresholds.minimum_valid_sample_ratio`, { min: 0, max: 1 }),
    },
    selectors: normalizedSelectors,
    secondary_menus: secondaryMenus,
  };
}

function mergeFlow(base, override = {}) {
  return {
    ...base,
    ...override,
    timeouts: { ...(base.timeouts || {}), ...(override.timeouts || {}) },
    thresholds: { ...(base.thresholds || {}), ...(override.thresholds || {}) },
    // 配置 Tab 编辑的是完整 selectors JSON；显式提供时允许删除旧的自定义分组。
    selectors: Object.prototype.hasOwnProperty.call(override, "selectors")
      ? override.selectors
      : base.selectors,
    secondary_menus: Object.prototype.hasOwnProperty.call(override, "secondary_menus")
      ? override.secondary_menus
      : base.secondary_menus,
  };
}

function validateRunOverride(raw, baseRun, pathName) {
  if (raw === undefined) return {};
  const override = requireObject(raw, pathName);
  rejectUnknownKeys(override, RUN_KEYS, pathName);
  const effective = validateRun({ ...baseRun, ...override }, `${pathName}（有效配置）`);
  return Object.fromEntries(Object.keys(override).map((key) => [key, effective[key]]));
}

function validateFlowOverride(raw, baseFlow, effectiveRun, pathName) {
  if (raw === undefined) return {};
  const override = requireObject(raw, pathName);
  rejectUnknownKeys(override, FLOW_KEYS, pathName);
  if (Object.hasOwn(override, "timeouts")) {
    rejectUnknownKeys(requireObject(override.timeouts, `${pathName}.timeouts`), TIMEOUT_KEYS, `${pathName}.timeouts`);
  }
  if (Object.hasOwn(override, "thresholds")) {
    rejectUnknownKeys(requireObject(override.thresholds, `${pathName}.thresholds`), THRESHOLD_KEYS, `${pathName}.thresholds`);
  }
  const effective = validateFlow(mergeFlow(baseFlow, override), effectiveRun.package, `${pathName}（有效配置）`);
  const normalized = {};
  for (const key of Object.keys(override)) {
    if (key === "timeouts" || key === "thresholds") {
      normalized[key] = Object.fromEntries(
        Object.keys(override[key]).map((nestedKey) => [nestedKey, effective[key][nestedKey]]),
      );
    } else {
      normalized[key] = effective[key];
    }
  }
  return normalized;
}

function validateTaskScripts(raw, baseRun, baseFlow) {
  if (!Array.isArray(raw)) throw configError("scripts", "必须是数组");
  if (!raw.length) throw configError("scripts", "不能为空");
  if (raw.length > MAX_TASK_SCRIPTS) throw configError("scripts", `不能超过 ${MAX_TASK_SCRIPTS} 项`);
  const ids = new Set();
  return raw.map((rawScript, index) => {
    const scriptPath = `scripts[${index}]`;
    const script = requireObject(rawScript, scriptPath);
    rejectUnknownKeys(script, SCRIPT_KEYS, scriptPath);
    const id = requireString(script.id, `${scriptPath}.id`, {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    });
    if (ids.has(id)) throw configError(`${scriptPath}.id`, "不能重复");
    ids.add(id);
    const run = validateRunOverride(script.run, baseRun, `${scriptPath}.run`);
    const effectiveRun = validateRun({ ...baseRun, ...run }, `${scriptPath}.run（有效配置）`);
    const flow = validateFlowOverride(script.flow, baseFlow, effectiveRun, `${scriptPath}.flow`);
    const sourceFiles = validateStringArray(script.sourceFiles, `${scriptPath}.sourceFiles`, {
      maxItems: 50,
      maxLength: 500,
    }).map((value, sourceIndex) => validateFeatureFilePath(
      value,
      `${scriptPath}.sourceFiles[${sourceIndex}]`,
      { requireFile: script.managed === true },
    ));
    return {
      id,
      name: requireString(script.name, `${scriptPath}.name`, { maxLength: 120, allowEmpty: false }),
      description: requireString(script.description ?? "", `${scriptPath}.description`, { maxLength: 500 }),
      category: requireString(script.category ?? "未分类", `${scriptPath}.category`, { maxLength: 80, allowEmpty: false }),
      tags: validateStringArray(script.tags, `${scriptPath}.tags`, { maxItems: 20, maxLength: 40 }),
      sourceFiles,
      version: requireString(script.version ?? "1", `${scriptPath}.version`, { maxLength: 40, allowEmpty: false }),
      managed: script.managed === true,
      manifestPath: script.manifestPath
        ? validateFeatureFilePath(script.manifestPath, `${scriptPath}.manifestPath`, { requireFile: script.managed === true })
        : "",
      available: script.available === undefined ? true : requireBoolean(script.available, `${scriptPath}.available`),
      availabilityReason: requireString(
        script.availabilityReason ?? "",
        `${scriptPath}.availabilityReason`,
        { maxLength: 500 },
      ),
      enabled: script.enabled === undefined ? true : requireBoolean(script.enabled, `${scriptPath}.enabled`),
      runner: validateRunnerPath(script.runner, `${scriptPath}.runner`),
      workflow: validateWorkflow(script.workflow, `${scriptPath}.workflow`),
      ui: validateTaskUi(script.ui, `${scriptPath}.ui`),
      run,
      flow,
    };
  });
}

function loadManagedTaskLibrary(baseRun, baseFlow) {
  const discovered = discoverTaskManifestDefinitions();
  const scripts = [];
  const issues = [...discovered.issues];
  const ids = new Set();
  for (const definition of discovered.definitions) {
    try {
      const script = validateTaskScripts([definition], baseRun, baseFlow)[0];
      if (ids.has(script.id)) {
        throw configError(`${definition.manifestPath}.id`, "与其他 task.json 重复");
      }
      ids.add(script.id);
      const effectiveRun = validateRun({ ...baseRun, ...(script.run || {}) });
      const effectiveFlow = validateFlow(
        mergeFlow(baseFlow, script.flow || {}),
        effectiveRun.package,
        `${definition.manifestPath}.flow（有效配置）`,
      );
      validateRegexesWithPython(effectiveFlow, `${definition.manifestPath}.flow`);
      if (scripts.length >= MAX_TASK_SCRIPTS) {
        issues.push({
          manifestPath: definition.manifestPath || TASK_SCRIPT_ROOT_RELATIVE,
          message: `脚本库任务超过 ${MAX_TASK_SCRIPTS} 项，当前任务已忽略`,
        });
        continue;
      }
      scripts.push(script);
    } catch (error) {
      issues.push({
        manifestPath: definition.manifestPath || TASK_SCRIPT_ROOT_RELATIVE,
        message: error.message,
      });
    }
  }
  scripts.sort((left, right) => (
    left.category.localeCompare(right.category, "zh-CN")
    || left.name.localeCompare(right.name, "zh-CN")
    || left.id.localeCompare(right.id)
  ));
  return { scripts, issues };
}

function mergePartialFlowOverrides(base = {}, override = {}) {
  const merged = { ...base, ...override };
  for (const key of ["timeouts", "thresholds"]) {
    if (Object.hasOwn(base, key) || Object.hasOwn(override, key)) {
      merged[key] = { ...(base[key] || {}), ...(override[key] || {}) };
    }
  }
  return merged;
}

function validateConfiguredScriptSourceEnvelope(raw) {
  if (!Array.isArray(raw)) throw configError("scripts", "必须是数组");
  if (raw.length > MAX_TASK_SCRIPTS * 2) {
    throw configError("scripts", `自定义脚本与受管任务配置合计不能超过 ${MAX_TASK_SCRIPTS * 2} 项`);
  }
  const ids = new Set();
  return raw.map((rawScript, index) => {
    const scriptPath = `scripts[${index}]`;
    const script = requireObject(rawScript, scriptPath);
    rejectUnknownKeys(script, SCRIPT_KEYS, scriptPath);
    const id = requireString(script.id, `${scriptPath}.id`, {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    });
    if (ids.has(id)) throw configError(`${scriptPath}.id`, "不能重复");
    ids.add(id);
    return script;
  });
}

function validateManagedScriptOverrides(raw) {
  if (raw === undefined) return {};
  const overrides = requireObject(raw, "managedScriptOverrides");
  if (Object.keys(overrides).length > MAX_TASK_SCRIPTS) {
    throw configError("managedScriptOverrides", `不能超过 ${MAX_TASK_SCRIPTS} 项`);
  }
  const normalized = {};
  for (const [rawId, rawOverride] of Object.entries(overrides)) {
    const id = requireString(rawId, "managedScriptOverrides 的任务 ID", {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    });
    const overridePath = `managedScriptOverrides.${id}`;
    const override = requireObject(rawOverride, overridePath);
    rejectUnknownKeys(override, MANAGED_SCRIPT_OVERRIDE_KEYS, overridePath);
    normalized[id] = override;
  }
  return normalized;
}

function mergeTaskScriptSources(managedScripts, configuredScripts, managedOverrides = {}) {
  const configured = Array.isArray(configuredScripts) ? configuredScripts : [];
  const managedIds = new Set(managedScripts.map((script) => script.id));
  const configuredById = new Map();
  for (const raw of configured) {
    if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id.trim()) continue;
    if (!configuredById.has(raw.id.trim())) configuredById.set(raw.id.trim(), raw);
  }
  const mergedManaged = managedScripts.map((script) => {
    const override = configuredById.get(script.id);
    const persistedOverride = isPlainObject(managedOverrides[script.id])
      ? managedOverrides[script.id]
      : {};
    if (!override && !Object.keys(persistedOverride).length) return script;
    return {
      ...script,
      // 文件清单是名称、入口和工作流的唯一来源；页面配置只覆盖运行开关与参数。
      enabled: override?.enabled === undefined
        ? (persistedOverride.enabled === undefined ? script.enabled : persistedOverride.enabled)
        : override.enabled,
      run: {
        ...(script.run || {}),
        ...(isPlainObject(persistedOverride.run) ? persistedOverride.run : {}),
        ...(isPlainObject(override?.run) ? override.run : {}),
      },
      flow: mergePartialFlowOverrides(
        mergePartialFlowOverrides(
          script.flow || {},
          isPlainObject(persistedOverride.flow) ? persistedOverride.flow : {},
        ),
        isPlainObject(override?.flow) ? override.flow : {},
      ),
    };
  });
  const custom = configured.filter((script) => (
    !isPlainObject(script)
    || typeof script.id !== "string"
    || !managedIds.has(script.id.trim())
  ));
  return [...mergedManaged, ...custom];
}

function taskLibrarySummary(config, issues = []) {
  const scripts = Array.isArray(config?.scripts) ? config.scripts : [];
  const managed = scripts.filter((script) => script.managed === true);
  return {
    root: TASK_SCRIPT_ROOT_RELATIVE,
    manifestName: TASK_MANIFEST_NAME,
    strategy: "platform/task-package/profiles/profile-id/task.json",
    managedScriptCount: managed.length,
    customScriptCount: scripts.length - managed.length,
    categories: [...new Set(managed.map((script) => script.category))],
    issues: issues.map((issue) => ({
      manifestPath: String(issue?.manifestPath || TASK_SCRIPT_ROOT_RELATIVE),
      message: String(issue?.message || "未知脚本库错误"),
    })),
  };
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffManagedOverride(current, baseline) {
  if (!isPlainObject(current)) return valuesEqual(current, baseline) ? undefined : current;
  const result = {};
  for (const [key, value] of Object.entries(current)) {
    const baseValue = isPlainObject(baseline) ? baseline[key] : undefined;
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      const nested = diffManagedOverride(value, baseValue);
      if (nested && Object.keys(nested).length) result[key] = nested;
    } else if (!valuesEqual(value, baseValue)) {
      result[key] = value;
    }
  }
  return result;
}

function managedScriptOverridesForPersistence(config) {
  const bases = Array.isArray(config?.[MANAGED_SCRIPT_BASES]) ? config[MANAGED_SCRIPT_BASES] : [];
  const baseById = new Map(bases.map((script) => [script.id, script]));
  const overrides = {};
  for (const script of config.scripts.filter((candidate) => candidate.managed === true)) {
    const baseline = baseById.get(script.id);
    if (!baseline) continue;
    const override = {};
    if (script.enabled !== baseline.enabled) override.enabled = script.enabled;
    const run = diffManagedOverride(script.run || {}, baseline.run || {});
    const flow = diffManagedOverride(script.flow || {}, baseline.flow || {});
    if (run && Object.keys(run).length) override.run = run;
    if (flow && Object.keys(flow).length) override.flow = flow;
    if (Object.keys(override).length) overrides[script.id] = override;
  }
  return overrides;
}

function persistablePerformanceResourceConfig(config) {
  return {
    run: config.run,
    flow: config.flow,
    defaultScriptId: config.defaultScriptId,
    // 文件托管任务每次从 task.json 重新发现，避免把旧入口/工作流副本固化到 gateway/config.json。
    scripts: config.scripts.filter((script) => script.managed !== true),
    // 受管任务只保存明确允许的差异；名称、入口和工作流始终以 task.json 为准。
    managedScriptOverrides: managedScriptOverridesForPersistence(config),
  };
}

function validatePartialShape(raw) {
  const config = requireObject(raw, "config");
  rejectUnknownKeys(config, CONFIG_KEYS, "config");
  if (Object.prototype.hasOwnProperty.call(config, "run")) {
    rejectUnknownKeys(requireObject(config.run, "run"), RUN_KEYS, "run");
  }
  if (Object.prototype.hasOwnProperty.call(config, "flow")) {
    const flow = requireObject(config.flow, "flow");
    rejectUnknownKeys(flow, FLOW_KEYS, "flow");
    if (Object.prototype.hasOwnProperty.call(flow, "timeouts")) {
      rejectUnknownKeys(requireObject(flow.timeouts, "flow.timeouts"), TIMEOUT_KEYS, "flow.timeouts");
    }
    if (Object.prototype.hasOwnProperty.call(flow, "thresholds")) {
      rejectUnknownKeys(requireObject(flow.thresholds, "flow.thresholds"), THRESHOLD_KEYS, "flow.thresholds");
    }
  }
  if (Object.hasOwn(config, "defaultScriptId")) {
    requireString(config.defaultScriptId, "defaultScriptId", {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    });
  }
  if (Object.hasOwn(config, "scripts") && !Array.isArray(config.scripts)) {
    throw configError("scripts", "必须是数组");
  }
  if (Object.hasOwn(config, "managedScriptOverrides")) {
    validateManagedScriptOverrides(config.managedScriptOverrides);
  }
  return config;
}

function collectRegexFields(flow, pathName = "flow") {
  const values = [];
  const collect = (selectors, basePath) => {
    selectors.forEach((selector, index) => {
      for (const key of REGEX_SELECTOR_KEYS) {
        if (Object.prototype.hasOwnProperty.call(selector, key)) {
          values.push({ path: `${basePath}[${index}].${key}`, pattern: selector[key] });
        }
      }
    });
  };

  for (const [name, selectors] of Object.entries(flow.selectors || {})) {
    collect(selectors, `${pathName}.selectors.${name}`);
  }
  (flow.secondary_menus || []).forEach((menu, index) => {
    collect(menu.selectors, `${pathName}.secondary_menus[${index}].selectors`);
  });
  return values;
}

function regexPythonCandidates() {
  const configured = String(process.env.APPMARKET_REGEX_VALIDATOR_PYTHON || "").trim();
  if (configured) {
    const isPyLauncher = process.platform === "win32" && /^py(?:\.exe)?$/i.test(path.basename(configured));
    return [{ executable: configured, prefix: isPyLauncher ? ["-3"] : [], configured: true }];
  }
  if (process.platform === "win32") {
    return [
      { executable: "py", prefix: ["-3"], configured: false },
      { executable: "python", prefix: [], configured: false },
    ];
  }
  return [
    { executable: "python3", prefix: [], configured: false },
    { executable: "python", prefix: [], configured: false },
  ];
}

function parsePythonValidatorOutput(result) {
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch {
    return null;
  }
}

function validateRegexesWithPython(flow, pathName = "flow") {
  const input = JSON.stringify(collectRegexFields(flow, pathName));
  const discovered = regexPythonCandidates();
  const candidates = cachedRegexPython
    ? [cachedRegexPython, ...discovered.filter((candidate) => (
      candidate.executable !== cachedRegexPython.executable
      || candidate.prefix.join("\0") !== cachedRegexPython.prefix.join("\0")
    ))]
    : discovered;
  const failures = [];

  for (const candidate of candidates) {
    let result;
    try {
      result = spawnSync(
        candidate.executable,
        [...candidate.prefix, "-c", PYTHON_REGEX_VALIDATOR],
        {
          input,
          encoding: "utf8",
          windowsHide: true,
          shell: false,
          timeout: PYTHON_REGEX_VALIDATION_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
          },
        },
      );
    } catch (error) {
      failures.push(`${candidate.executable}: ${error.message}`);
      if (cachedRegexPython === candidate) cachedRegexPython = null;
      continue;
    }

    const output = parsePythonValidatorOutput(result);
    if (result.status === 0 && output?.ok === true) {
      cachedRegexPython = candidate;
      return;
    }
    if (output?.kind === "regex") {
      cachedRegexPython = candidate;
      throw configError(output.path || "flow.selectors", `Python re 正则语法无效：${output.error || "未知错误"}`);
    }

    const detail = result.error?.message
      || output?.error
      || String(result.stderr || "").trim()
      || `退出码 ${result.status}`;
    failures.push(`${candidate.executable}: ${detail}`);
    if (cachedRegexPython === candidate) cachedRegexPython = null;
    if (candidate.configured) break;
  }

  throw configError(
    "flow.selectors",
    `无法使用 Python 3 re 校验正则；请安装 Python 3 或设置 APPMARKET_REGEX_VALIDATOR_PYTHON（${failures.join("；")}）`,
  );
}

export function validatePerformanceResourceConfig(raw, baseConfig = null, { recoverInvalidDefault = false } = {}) {
  const serialized = JSON.stringify(raw);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw configError("config", `大小不能超过 ${MAX_CONFIG_BYTES} 字节`);
  }
  const partial = validatePartialShape(raw);
  const base = baseConfig || {};
  const baseRun = validateRun({ ...clone(DEFAULT_PERFORMANCE_RESOURCE_RUN), ...(base.run || {}) });
  const baseFlow = validateFlow(mergeFlow(clone(DEFAULT_FLOW), base.flow || {}), baseRun.package);
  const mergedRun = { ...baseRun, ...(partial.run || {}) };
  const run = validateRun(mergedRun);
  const flow = validateFlow(mergeFlow(baseFlow, partial.flow || {}), run.package);
  const configuredScriptSource = Object.hasOwn(partial, "scripts")
    ? partial.scripts
    : (Array.isArray(base.scripts) && base.scripts.length
      ? base.scripts
      : []);
  const managedLibrary = loadManagedTaskLibrary(run, flow);
  const taskLibraryIssues = [...managedLibrary.issues];
  const managedOverrides = validateManagedScriptOverrides(
    Object.hasOwn(partial, "managedScriptOverrides")
      ? partial.managedScriptOverrides
      : base.managedScriptOverrides,
  );
  const configuredScripts = configuredScriptSource.length
    ? validateConfiguredScriptSourceEnvelope(configuredScriptSource)
    : [];
  const scriptSource = mergeTaskScriptSources(
    managedLibrary.scripts.length ? managedLibrary.scripts : [clone(DEFAULT_PERFORMANCE_RESOURCE_SCRIPT)],
    configuredScripts,
    managedOverrides,
  );
  const scripts = validateTaskScripts(scriptSource, run, flow);
  const requestedDefaultScriptId = requireString(
    partial.defaultScriptId ?? base.defaultScriptId ?? DEFAULT_PERFORMANCE_RESOURCE_SCRIPT_ID,
    "defaultScriptId",
    {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    },
  );
  const requestedDefaultScript = scripts.find((script) => script.id === requestedDefaultScriptId);
  let defaultScriptId = requestedDefaultScriptId;
  const defaultIsRunnable = requestedDefaultScript?.enabled === true && requestedDefaultScript.available !== false;
  if (!defaultIsRunnable) {
    if (!recoverInvalidDefault) {
      if (!requestedDefaultScript) throw configError("defaultScriptId", "必须指向 scripts 中存在的脚本");
      if (!requestedDefaultScript.enabled) throw configError("defaultScriptId", "不能指向已禁用的脚本");
      throw configError("defaultScriptId", "不能指向当前不可用的脚本");
    }
    const fallback = scripts.find((script) => script.enabled === true && script.available !== false);
    if (!fallback) throw configError("defaultScriptId", "对应任务不可用，且脚本库中没有可运行任务可供回退");
    defaultScriptId = fallback.id;
    taskLibraryIssues.push({
      manifestPath: requestedDefaultScript?.manifestPath || TASK_SCRIPT_ROOT_RELATIVE,
      message: `持久化默认任务 ${requestedDefaultScriptId} 已缺失、禁用或不可用，GET 已自动回退为 ${fallback.id}`,
    });
  }
  latestTaskLibraryIssues = taskLibraryIssues;
  const result = { run, flow, defaultScriptId, scripts };
  Object.defineProperty(result, MANAGED_SCRIPT_BASES, {
    value: managedLibrary.scripts,
    enumerable: false,
  });
  return result;
}

export function getPerformanceResourceConfig() {
  const stored = getConfig().appmarketPerformance;
  const config = validatePerformanceResourceConfig(
    isPlainObject(stored) ? stored : {},
    null,
    { recoverInvalidDefault: true },
  );
  return { ...config, scriptLibrary: taskLibrarySummary(config, latestTaskLibraryIssues) };
}

export function savePerformanceResourceConfig(raw) {
  const current = getPerformanceResourceConfig();
  const next = validatePerformanceResourceConfig(raw, current);
  validateRegexesWithPython(next.flow);
  for (const [index, script] of next.scripts.entries()) {
    const effectiveRun = validateRun({ ...next.run, ...(script.run || {}) });
    const effectiveFlow = validateFlow(mergeFlow(next.flow, script.flow || {}), effectiveRun.package);
    validateRegexesWithPython(effectiveFlow, `scripts[${index}].flow`);
  }
  updateConfig({ appmarketPerformance: persistablePerformanceResourceConfig(next) });
  return clone({ ...next, scriptLibrary: taskLibrarySummary(next, latestTaskLibraryIssues) });
}

export function resetPerformanceResourceConfig() {
  const defaults = validatePerformanceResourceConfig({}, null, { recoverInvalidDefault: true });
  updateConfig({ appmarketPerformance: persistablePerformanceResourceConfig(defaults) });
  return clone({ ...defaults, scriptLibrary: taskLibrarySummary(defaults, latestTaskLibraryIssues) });
}

export function selectPerformanceResourceScript(config, requestedScriptId) {
  const scriptId = requestedScriptId === undefined || requestedScriptId === null
    ? config.defaultScriptId
    : requireString(requestedScriptId, "scriptId", {
      maxLength: 80,
      allowEmpty: false,
      pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
    });
  const script = config.scripts.find((candidate) => candidate.id === scriptId);
  if (!script) throw configError("scriptId", "对应的测试任务脚本不存在");
  if (!script.enabled) throw configError("scriptId", "对应的测试任务脚本已禁用");
  if (script.available === false) {
    throw configError("scriptId", script.availabilityReason || "对应的测试任务脚本当前不可用");
  }
  // 启动前再次检查普通文件与目录边界，避免配置保存后 runner 被替换。
  const runner = validateRunnerPath(script.runner, `scripts.${script.id}.runner`);
  const run = validateRun({ ...config.run, ...(script.run || {}) }, `scripts.${script.id}.run`);
  const flow = validateFlow(mergeFlow(config.flow, script.flow || {}), run.package, `scripts.${script.id}.flow`);
  return {
    script: {
      id: script.id,
      name: script.name,
      description: script.description,
      category: script.category,
      tags: clone(script.tags || []),
      sourceFiles: clone(script.sourceFiles || []),
      version: script.version,
      managed: script.managed === true,
      manifestPath: script.manifestPath || "",
      runner,
      workflow: clone(script.workflow),
      ui: clone(script.ui),
    },
    run,
    flow,
    runnerPath: path.resolve(REPO_ROOT, ...runner.split("/")),
  };
}

export function summarizePerformanceResourceFlow(flow = {}) {
  return {
    schema_version: flow.schema_version,
    package: flow.package,
    fixed_test_app_title: flow.fixed_test_app_title,
    timeouts: { ...(flow.timeouts || {}) },
    thresholds: { ...(flow.thresholds || {}) },
    selectorGroups: Object.keys(flow.selectors || {}),
    secondaryMenus: Array.isArray(flow.secondary_menus)
      ? flow.secondary_menus.map((menu) => ({ id: menu.id, label: menu.label }))
      : [],
  };
}

export function parsePerformanceResourceConfigEvidence(raw) {
  const source = requireObject(raw, "effectiveConfig");
  const evidence = requireObject(source._performance_script, "effectiveConfig._performance_script");
  rejectUnknownKeys(
    evidence,
    new Set([
      "id",
      "name",
      "description",
      "category",
      "tags",
      "sourceFiles",
      "version",
      "managed",
      "manifestPath",
      "runner",
      "workflow",
      "ui",
    ]),
    "effectiveConfig._performance_script",
  );
  const id = requireString(evidence.id, "effectiveConfig._performance_script.id", {
    maxLength: 80,
    allowEmpty: false,
    pattern: /^[A-Za-z][A-Za-z0-9_.-]*$/,
  });
  const script = {
    id,
    name: requireString(evidence.name, "effectiveConfig._performance_script.name", { maxLength: 120, allowEmpty: false }),
    description: requireString(evidence.description ?? "", "effectiveConfig._performance_script.description", { maxLength: 500 }),
    category: requireString(evidence.category ?? "未分类", "effectiveConfig._performance_script.category", { maxLength: 80, allowEmpty: false }),
    tags: validateStringArray(evidence.tags, "effectiveConfig._performance_script.tags", { maxItems: 20, maxLength: 40 }),
    sourceFiles: validateStringArray(evidence.sourceFiles, "effectiveConfig._performance_script.sourceFiles", {
      maxItems: 50,
      maxLength: 500,
    }).map((value, index) => validateFeatureFilePath(
      value,
      `effectiveConfig._performance_script.sourceFiles[${index}]`,
      { requireFile: false },
    )),
    version: requireString(evidence.version ?? "1", "effectiveConfig._performance_script.version", { maxLength: 40, allowEmpty: false }),
    managed: evidence.managed === true,
    manifestPath: evidence.manifestPath
      ? validateFeatureFilePath(evidence.manifestPath, "effectiveConfig._performance_script.manifestPath", { requireFile: false })
      : "",
    // 历史 runner 可能已移动；详情只校验路径边界，不要求文件当前仍存在。
    runner: validateRunnerPath(evidence.runner, "effectiveConfig._performance_script.runner", { requireFile: false }),
    workflow: validateWorkflow(evidence.workflow, "effectiveConfig._performance_script.workflow"),
    ui: validateTaskUi(evidence.ui, "effectiveConfig._performance_script.ui"),
  };
  const flow = { ...source };
  delete flow._performance_script;
  return { run: null, script, flow: summarizePerformanceResourceFlow(flow) };
}
