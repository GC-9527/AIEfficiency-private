import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, canonicalSha256 } from "./envelope-store.js";

const CAPABILITIES_PATH = fileURLToPath(new URL("./stage-capabilities.json", import.meta.url));
const POLICY_SCHEMA_VERSION = "workflow-v2-stage-tool-policy-v1";
const CAPABILITIES_SCHEMA_VERSION = "stage-capabilities-v2";
const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const POLICY_INTERNALS = new WeakMap();

const EXPECTED_STAGES = Object.freeze([
  "TRIAGE",
  "DIAGNOSE_PLAN",
  "REPAIR",
  "INDEPENDENT_REVIEW",
  "VERIFY_PLAN",
  "VERIFY_EXECUTE",
  "REPORT_SHORT",
  "REPORT_EXPERT",
  "MEMORY_DISTILL",
]);

const KNOWN_GROUPS = new Set([
  "FILES_READ",
  "SEARCH",
  "GIT_READ",
  "MEDIA_INSPECT",
  "ARCHIVE_READ",
  "FILES_PATCH",
  "LOCAL_BUILD_TEST",
  "GIT_COMMIT",
  "GIT_BRANCH_WRITE",
  "ADB",
  "TB_WRITE",
  "RECEIPT_READ",
  "TEST_TEMPLATE_READ",
  "CONTROLLED_BUILD",
  "CONTROLLED_TEST",
  "DEVICE_PROXY",
  "DB_QUERY",
  "EVIDENCE_CAPTURE",
  "RECEIPT_WRITE",
  "GIT_WRITE",
  "ASSET_READ",
  "REPORT_WRITE",
]);

const READ_TOOLS = Object.freeze(["list_dir", "read_file"]);
const MEDIA_TOOLS = Object.freeze(["inspect_image", "inspect_pdf", "inspect_video", "read_binary_metadata"]);
const ARCHIVE_TOOLS = Object.freeze(["extract_archive_entry", "list_archive"]);
const GIT_READ_TOOLS = Object.freeze(["git_diff", "git_inspect", "git_status"]);
const ASSET_READ_TOOLS = Object.freeze([...READ_TOOLS, ...MEDIA_TOOLS, ...ARCHIVE_TOOLS]);
const LOCAL_CHECK_TOOL = "run_local_check";
const VERIFICATION_CASE_TOOL = "run_verification_case";

// An empty expansion is deliberate. In particular, no free shell or generic
// process runner stands in for a controlled build, device, evidence, or receipt
// capability that the API tool catalog does not implement yet.
const GROUP_TOOL_NAMES = Object.freeze({
  FILES_READ: READ_TOOLS,
  SEARCH: Object.freeze(["search_files"]),
  GIT_READ: GIT_READ_TOOLS,
  MEDIA_INSPECT: MEDIA_TOOLS,
  ARCHIVE_READ: ARCHIVE_TOOLS,
  FILES_PATCH: Object.freeze(["apply_patch", "edit_file"]),
  LOCAL_BUILD_TEST: Object.freeze([LOCAL_CHECK_TOOL]),
  RECEIPT_READ: Object.freeze([]),
  TEST_TEMPLATE_READ: Object.freeze([]),
  CONTROLLED_BUILD: Object.freeze([VERIFICATION_CASE_TOOL]),
  CONTROLLED_TEST: Object.freeze([VERIFICATION_CASE_TOOL]),
  DEVICE_PROXY: Object.freeze([VERIFICATION_CASE_TOOL]),
  DB_QUERY: Object.freeze([VERIFICATION_CASE_TOOL]),
  EVIDENCE_CAPTURE: Object.freeze([VERIFICATION_CASE_TOOL]),
  RECEIPT_WRITE: Object.freeze([VERIFICATION_CASE_TOOL]),
  ASSET_READ: ASSET_READ_TOOLS,
  REPORT_WRITE: Object.freeze(["write_file"]),
});

const TOOL_ARGUMENT_KEYS = Object.freeze({
  search_files: ["rootId", "pattern", "path", "glob", "case_sensitive", "max_results"],
  read_file: ["rootId", "path", "start_line", "line_count", "start_byte", "max_bytes"],
  list_dir: ["rootId", "path"],
  git_status: ["rootId", "path"],
  git_diff: ["rootId", "path", "file", "staged", "stat", "max_chars"],
  git_inspect: ["rootId", "operation", "path", "revision", "base", "target", "file", "pattern", "stat", "max_count", "max_chars"],
  write_file: ["rootId", "path", "content"],
  edit_file: ["rootId", "path", "old_string", "new_string"],
  apply_patch: ["rootId", "path", "patch"],
  read_binary_metadata: ["rootId", "path"],
  inspect_image: ["rootId", "path", "prompt"],
  inspect_pdf: ["rootId", "path", "max_chars", "render_pages", "output_dir"],
  list_archive: ["rootId", "path", "max_entries"],
  extract_archive_entry: ["rootId", "path", "entry_path", "output_path", "max_bytes"],
  inspect_video: ["rootId", "path", "timestamps", "output_dir"],
  run_local_check: ["rootId", "checkId"],
  run_verification_case: ["rootId", "caseId"],
});

const FILE_PATH_TOOLS = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "read_binary_metadata",
  "inspect_image",
  "inspect_pdf",
  "list_archive",
  "extract_archive_entry",
  "inspect_video",
]);
const ROOT_PATH_TOOLS = new Set(["search_files", "list_dir", "git_status", "git_diff", "git_inspect", "apply_patch"]);
const CONTROLLED_EXECUTION_TOOLS = new Set([LOCAL_CHECK_TOOL, VERIFICATION_CASE_TOOL]);

export class WorkflowV2StageToolPolicyError extends Error {
  constructor(message, code = "WORKFLOW_V2_STAGE_TOOL_POLICY_DENIED", details = {}) {
    super(message);
    this.name = "WorkflowV2StageToolPolicyError";
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2StageToolPolicyError(message, code, details);
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function clonePlainData(value, label = "value", seen = new Map(), depth = 0) {
  if (depth > 80) fail(`${label} nesting is too deep`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
    return value;
  }
  if (typeof value !== "object") {
    fail(`${label} contains a non-data value`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
  }
  if (seen.has(value)) fail(`${label} contains a cycle`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail(`${label} has an unsafe array prototype`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
    if (keys.some((key) => typeof key !== "string" || !/^\d+$/.test(key))) {
      fail(`${label} has non-index array properties`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
    }
    if (keys.length !== value.length) fail(`${label} is a sparse array`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
    seen.set(value, true);
    const output = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        fail(`${label}[${index}] is not a plain data property`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
      }
      output.push(clonePlainData(descriptor.value, `${label}[${index}]`, seen, depth + 1));
    }
    seen.delete(value);
    return output;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} has an unsafe object prototype`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    fail(`${label} contains symbol properties`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label });
  }
  seen.set(value, true);
  const output = {};
  for (const key of keys.sort(compareCodeUnits)) {
    const descriptor = descriptors[key];
    if (DANGEROUS_KEYS.has(key) || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${label}.${key} is not a safe data property`, "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT", { label, key });
    }
    output[key] = clonePlainData(descriptor.value, `${label}.${key}`, seen, depth + 1);
  }
  seen.delete(value);
  return output;
}

function assertPlainObject(value, label, code = "WORKFLOW_V2_STAGE_TOOL_POLICY_INVALID_INPUT") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, code, { label });
  return value;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !value || value.length > 300 || CONTROL_PATTERN.test(value)) {
    fail(`${label} is invalid`, "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH", { label });
  }
  return value;
}

function assertStringArray(value, label, { known = null } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID", { label });
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item || seen.has(item) || (known && !known.has(item))) {
      fail(`${label} contains an unknown or duplicate value`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID", { label, item });
    }
    seen.add(item);
  }
  return value;
}

function validateCapabilitiesDocument(document) {
  const source = assertPlainObject(document, "stage capabilities", "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
  if (source.schemaVersion !== CAPABILITIES_SCHEMA_VERSION) {
    fail("stage capabilities schemaVersion is unsupported", "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
  }
  assertPlainObject(source.stages, "stage capabilities stages", "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
  const stageIds = Object.keys(source.stages).sort(compareCodeUnits);
  if (canonicalJson(stageIds) !== canonicalJson([...EXPECTED_STAGES].sort(compareCodeUnits))) {
    fail("stage capabilities contains a missing or unknown stage", "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID", { stageIds });
  }
  for (const stageId of EXPECTED_STAGES) {
    const stage = assertPlainObject(source.stages[stageId], `stage ${stageId}`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
    if (typeof stage.readOnly !== "boolean") fail(`${stageId}.readOnly must be boolean`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
    assertStringArray(stage.allowedToolGroups, `${stageId}.allowedToolGroups`, { known: KNOWN_GROUPS });
    if (!Number.isSafeInteger(stage.maxToolIterations) || stage.maxToolIterations < 0 || stage.maxToolIterations > 40) {
      fail(`${stageId}.maxToolIterations is invalid`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
    }
    const denied = stage.denied === undefined ? [] : assertStringArray(stage.denied, `${stageId}.denied`, { known: KNOWN_GROUPS });
    if (denied.some((group) => stage.allowedToolGroups.includes(group))) {
      fail(`${stageId} both allows and denies a tool group`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
    }
    const writeRoots = stage.writeRoots === undefined ? [] : assertStringArray(stage.writeRoots, `${stageId}.writeRoots`);
    if (writeRoots.some((root) => root !== "REPORT_ROOT") || (stage.readOnly && writeRoots.length)) {
      fail(`${stageId}.writeRoots is unsupported`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID");
    }
    for (const group of stage.allowedToolGroups) {
      if (!Object.hasOwn(GROUP_TOOL_NAMES, group)) {
        fail(`${stageId} uses a group without an explicit expansion`, "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID", { group });
      }
    }
  }
  return source;
}

export function loadWorkflowV2StageCapabilitiesDocument() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(CAPABILITIES_PATH, "utf8"));
  } catch (error) {
    fail("unable to load stage capabilities", "WORKFLOW_V2_STAGE_TOOL_POLICY_ASSET_INVALID", { cause: error.message });
  }
  return deepFreeze(validateCapabilitiesDocument(clonePlainData(parsed, "stage capabilities")));
}

function templateForStage(document, stageId) {
  const stage = document.stages[stageId];
  if (!stage) fail("unknown workflow-v2 stage", "WORKFLOW_V2_STAGE_TOOL_POLICY_STAGE_UNKNOWN", { stageId });
  const allowedToolNames = sortedUnique(stage.allowedToolGroups.flatMap((group) => GROUP_TOOL_NAMES[group]));
  const unsupportedToolGroups = stage.allowedToolGroups.filter((group) => GROUP_TOOL_NAMES[group].length === 0);
  return {
    allowedToolGroups: [...stage.allowedToolGroups],
    allowedToolNames,
    maxToolIterations: stage.maxToolIterations,
    readOnly: stage.readOnly,
    unsupportedToolGroups,
  };
}

export function getWorkflowV2StageToolPolicyTemplate(stageId) {
  if (typeof stageId !== "string" || !stageId) {
    fail("stageId is required", "WORKFLOW_V2_STAGE_TOOL_POLICY_STAGE_UNKNOWN", { stageId: stageId ?? null });
  }
  return deepFreeze(templateForStage(loadWorkflowV2StageCapabilitiesDocument(), stageId));
}

function expectedBooleanCapabilities(template) {
  const groups = new Set(template.allowedToolGroups);
  return {
    canWriteSource: groups.has("FILES_PATCH"),
    canReadGit: groups.has("GIT_READ"),
    canWriteGit: groups.has("GIT_WRITE") || groups.has("GIT_BRANCH_WRITE"),
    canCommit: groups.has("GIT_COMMIT"),
    canUseDevice: groups.has("DEVICE_PROXY") || groups.has("ADB"),
    canWriteTb: groups.has("TB_WRITE"),
    canWriteReport: groups.has("REPORT_WRITE"),
  };
}

function validateContextAgainstTemplate(context, template, { storyId, taskId, contextHash }) {
  const source = assertPlainObject(context, "context");
  const stage = assertPlainObject(source.stage, "context.stage");
  const story = assertPlainObject(source.story, "context.story");
  const task = assertPlainObject(source.task, "context.task");
  const scope = assertPlainObject(source.scope, "context.scope");
  const capabilities = assertPlainObject(source.capabilities, "context.capabilities");
  const stageId = assertIdentifier(stage.id, "context.stage.id");
  if (story.storyId !== storyId) {
    fail("story identity does not match context", "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH", { storyId });
  }
  const contextTaskId = task.taskId ?? task.id;
  if (contextTaskId !== undefined && contextTaskId !== taskId) {
    fail("task identity does not match context", "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH", { taskId });
  }
  const actualHash = canonicalSha256(source);
  if (actualHash !== contextHash) {
    fail("contextHash does not bind the supplied context", "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH", { expected: actualHash, actual: contextHash });
  }
  if (!Array.isArray(capabilities.allowedTools)
    || canonicalJson(capabilities.allowedTools) !== canonicalJson(template.allowedToolNames)) {
    fail("context allowedTools does not exactly match the stage expansion", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", {
      stageId,
      expected: template.allowedToolNames,
    });
  }
  if (capabilities.maxToolIterations !== template.maxToolIterations) {
    fail("context maxToolIterations conflicts with the stage asset", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { stageId });
  }
  if (capabilities.readOnly !== undefined && capabilities.readOnly !== template.readOnly) {
    fail("context readOnly conflicts with the stage asset", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { stageId });
  }
  for (const [field, expected] of Object.entries(expectedBooleanCapabilities(template))) {
    if (capabilities[field] !== expected) {
      fail(`context ${field} conflicts with the stage asset`, "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { stageId, field, expected });
    }
  }
  if (!Array.isArray(scope.roots) || scope.roots.length < 1) {
    fail("context scope.roots is required", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { stageId });
  }
  const rootIds = new Set();
  for (const root of scope.roots) {
    assertPlainObject(root, "context.scope.roots[]");
    if (!ROOT_ID_PATTERN.test(root.rootId || "") || rootIds.has(root.rootId) || typeof root.writable !== "boolean") {
      fail("context contains an invalid or duplicate root", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { rootId: root.rootId ?? null });
    }
    if (template.readOnly && root.writable) {
      fail("read-only stage contains a writable root", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { rootId: root.rootId });
    }
    rootIds.add(root.rootId);
  }
  return stageId;
}

function realpathExistingDirectory(realRoot, rootId) {
  if (typeof realRoot !== "string" || !realRoot || CONTROL_PATTERN.test(realRoot) || !path.isAbsolute(realRoot)) {
    fail("root binding realRoot must be an absolute path", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
  }
  try {
    const resolved = realpathSync.native(realRoot);
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch (error) {
    fail("root binding realRoot must resolve to an existing directory", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", {
      rootId,
      cause: error.message,
    });
  }
}

function normalizeRootBindings(rootBindings, context) {
  const contextRoots = new Map(context.scope.roots.map((root) => [root.rootId, root]));
  let entries;
  if (Array.isArray(rootBindings)) {
    entries = rootBindings.map((entry, index) => {
      const cloned = clonePlainData(entry, `rootBindings[${index}]`);
      assertPlainObject(cloned, `rootBindings[${index}]`);
      if (!cloned.rootId) fail("root binding is missing rootId", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { index });
      return cloned;
    });
  } else {
    const map = clonePlainData(rootBindings, "rootBindings");
    assertPlainObject(map, "rootBindings");
    entries = Object.keys(map).map((rootId) => {
      const value = map[rootId];
      if (typeof value === "string") return { rootId, realRoot: value };
      assertPlainObject(value, `rootBindings.${rootId}`);
      if (value.rootId !== undefined && value.rootId !== rootId) {
        fail("root binding key conflicts with rootId", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
      }
      return { ...value, rootId };
    });
  }
  const normalized = new Map();
  for (const entry of entries) {
    const rootId = entry.rootId;
    if (!ROOT_ID_PATTERN.test(rootId || "") || normalized.has(rootId)) {
      fail("root binding has an invalid or duplicate rootId", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId: rootId ?? null });
    }
    const contextRoot = contextRoots.get(rootId);
    if (!contextRoot) fail("root binding references an unknown root", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
    if (entry.writable !== undefined && typeof entry.writable !== "boolean") {
      fail("root binding writable must be boolean", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
    }
    if (entry.readOnly !== undefined && typeof entry.readOnly !== "boolean") {
      fail("root binding readOnly must be boolean", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
    }
    if (entry.writable === true && entry.readOnly === true) {
      fail("root binding has contradictory write flags", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
    }
    const writable = entry.readOnly === true ? false : (entry.writable ?? contextRoot.writable);
    const role = entry.role ?? (contextRoot.kind === "ARTIFACT" ? "REPORT_ROOT" : "");
    if (role && role !== "REPORT_ROOT") fail("root binding role is unknown", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId, role });
    normalized.set(rootId, {
      rootId,
      requestedRoot: path.resolve(entry.realRoot),
      realRoot: realpathExistingDirectory(entry.realRoot, rootId),
      writable,
      sourceWritable: contextRoot.writable,
      role,
    });
  }
  for (const rootId of contextRoots.keys()) {
    if (!normalized.has(rootId)) fail("context root is missing a root binding", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
  }
  return normalized;
}

function normalizeProtectedPaths(context) {
  const values = [".git/**", "AGENTS.md", "CLAUDE.md", ...(context.scope.protectedPaths || [])];
  const output = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || CONTROL_PATTERN.test(value) || path.isAbsolute(value)
      || /^[a-zA-Z]:/.test(value) || value.includes("\\") || value.includes(":")) {
      fail("context contains an invalid protected path", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { path: value });
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      fail("context contains an invalid protected path segment", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT", { path: value });
    }
    output.push(value);
  }
  return sortedUnique(output);
}

function normalizeRelativePath(value, label, { allowEmpty = false, allowGlob = false } = {}) {
  if (typeof value !== "string" || CONTROL_PATTERN.test(value)) {
    fail(`${label} must be a safe relative path`, "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID", { field: label });
  }
  if (!value && allowEmpty) return "";
  if (!value || path.isAbsolute(value) || value.startsWith("/") || value.startsWith("\\")
    || /^[a-zA-Z]:/.test(value) || value.includes(":") || value.includes("\\")) {
    fail(`${label} must be a root-relative portable path`, "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID", { field: label });
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} contains an empty or dot segment`, "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID", { field: label });
  }
  if (!allowGlob && /[*?\[\]]/.test(value)) {
    fail(`${label} contains path metacharacters`, "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID", { field: label });
  }
  return segments.join("/");
}

function globPatternToRegExp(pattern) {
  let rendered = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        rendered += ".*";
        index += 1;
      } else rendered += "[^/]*";
    } else if (char === "?") rendered += "[^/]";
    else rendered += char.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${rendered}$`, "iu");
}

function isProtectedPath(relativePath, protectedPaths) {
  if (!relativePath) return false;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return true;
  const basename = segments.at(-1).toLowerCase();
  if (basename === "agents.md" || basename === "claude.md") return true;
  return protectedPaths.some((pattern) => globPatternToRegExp(pattern).test(relativePath));
}

function sameRealPath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWithinRoot(realRoot, candidate) {
  const relative = path.relative(realRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingRealPath(candidate, realRoot, rootId) {
  let current = candidate;
  while (true) {
    try {
      lstatSync(current);
      const resolved = realpathSync.native(current);
      if (!isWithinRoot(realRoot, resolved)) {
        fail("path escapes its root through a symlink or junction", "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_DENIED", { rootId });
      }
      return resolved;
    } catch (error) {
      if (error instanceof WorkflowV2StageToolPolicyError) throw error;
      const parent = path.dirname(current);
      if (parent === current) fail("path has no existing parent", "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_DENIED", { rootId });
      current = parent;
    }
  }
}

function revalidateBinding(binding) {
  let current;
  try {
    current = realpathSync.native(binding.requestedRoot);
  } catch (error) {
    fail("bound root no longer resolves", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId: binding.rootId, cause: error.message });
  }
  if (!sameRealPath(current, binding.realRoot)) {
    fail("bound root identity changed", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId: binding.rootId });
  }
}

function resolvePathRef(state, rootId, relativePath, field, access) {
  const binding = state.bindings.get(rootId);
  if (!binding) fail("tool call references an unknown rootId", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId });
  revalidateBinding(binding);
  if (isProtectedPath(relativePath, state.protectedPaths)) {
    fail("tool call targets a protected path", "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_DENIED", { rootId, path: relativePath });
  }
  if (access === "write") {
    const reportWrite = state.stageId === "REPORT_EXPERT"
      && state.reportWritePrefix
      && rootId === state.reportWritePrefix.rootId
      && (relativePath === state.reportWritePrefix.path || relativePath.startsWith(`${state.reportWritePrefix.path}/`));
    const sourceWrite = state.stageId === "REPAIR" && binding.sourceWritable;
    if (!binding.writable || (!sourceWrite && !reportWrite)) {
      fail("tool call attempts to write a read-only root", "WORKFLOW_V2_STAGE_TOOL_POLICY_WRITE_DENIED", { rootId, path: relativePath });
    }
  }
  const absolutePath = path.resolve(binding.realRoot, ...relativePath.split("/").filter(Boolean));
  if (!isWithinRoot(binding.realRoot, absolutePath)) {
    fail("tool path escapes its root", "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_DENIED", { rootId, path: relativePath });
  }
  // This is a point-in-time authorization check, not a promise that the path
  // cannot change later. The executor should consume the returned reference
  // immediately and retain its own no-follow/open-time controls where possible.
  nearestExistingRealPath(absolutePath, binding.realRoot, rootId);
  return { field, rootId, path: relativePath, absolutePath, access };
}

function reportPrefixFromContext(context, bindings) {
  const raw = context.data?.outputPath ?? context.output?.outputPath;
  if (typeof raw !== "string" || !raw) return null;
  const uri = raw.match(/^([a-z][a-z0-9+.-]*):\/(.+)$/i);
  const relative = normalizeRelativePath(uri ? uri[2] : raw, "context report outputPath");
  const directory = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
  if (!directory) fail("REPORT_EXPERT outputPath must have a bounded directory prefix", "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT");
  let rootId = uri && bindings.has(uri[1]) ? uri[1] : null;
  if (!rootId) rootId = [...bindings.values()].find((binding) => binding.role === "REPORT_ROOT")?.rootId || null;
  if (!rootId) fail("REPORT_EXPERT has no REPORT_ROOT binding", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID");
  return { rootId, path: directory };
}

function unsignedPolicy(policy) {
  const { policySha256: _ignored, ...unsigned } = policy;
  return unsigned;
}

function authenticatePolicy(policy) {
  if (!policy || typeof policy !== "object" || !Object.isFrozen(policy)) {
    fail("policy is not an immutable compiled policy", "WORKFLOW_V2_STAGE_TOOL_POLICY_TAMPERED");
  }
  const state = POLICY_INTERNALS.get(policy);
  if (!state || canonicalSha256(unsignedPolicy(policy)) !== policy.policySha256) {
    fail("policy is unknown or has been tampered with", "WORKFLOW_V2_STAGE_TOOL_POLICY_TAMPERED");
  }
  return state;
}

export function compileWorkflowV2StageToolPolicy({ context, storyId, taskId, contextHash, rootBindings } = {}) {
  const safeStoryId = assertIdentifier(storyId, "storyId");
  const safeTaskId = assertIdentifier(taskId, "taskId");
  if (typeof contextHash !== "string" || !SHA256_PATTERN.test(contextHash)) {
    fail("contextHash must be a lowercase SHA-256", "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH");
  }
  const contextSnapshot = clonePlainData(context, "context");
  const stageId = contextSnapshot?.stage?.id;
  const template = getWorkflowV2StageToolPolicyTemplate(stageId);
  validateContextAgainstTemplate(contextSnapshot, template, {
    storyId: safeStoryId,
    taskId: safeTaskId,
    contextHash,
  });
  const bindings = normalizeRootBindings(rootBindings, contextSnapshot);
  const protectedPaths = normalizeProtectedPaths(contextSnapshot);
  const reportWritePrefix = stageId === "REPORT_EXPERT" ? reportPrefixFromContext(contextSnapshot, bindings) : null;
  const base = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    identity: { storyId: safeStoryId, taskId: safeTaskId, stageId, contextHash },
    readOnly: template.readOnly,
    allowedToolGroups: [...template.allowedToolGroups],
    allowedToolNames: [...template.allowedToolNames],
    unsupportedToolGroups: [...template.unsupportedToolGroups],
    maxToolIterations: template.maxToolIterations,
    roots: [...bindings.keys()].sort(compareCodeUnits).map((rootId) => ({ rootId })),
    protectedPaths,
    ...(reportWritePrefix ? { reportWritePrefix } : {}),
  };
  const policy = deepFreeze({ ...base, policySha256: canonicalSha256(base) });
  POLICY_INTERNALS.set(policy, {
    bindings,
    contextSnapshot,
    protectedPaths,
    reportWritePrefix,
    stageId,
  });
  return policy;
}

export function assertWorkflowV2StageToolPolicy(policy, { context, storyId, taskId, contextHash } = {}) {
  const state = authenticatePolicy(policy);
  if (storyId !== policy.identity.storyId || taskId !== policy.identity.taskId || contextHash !== policy.identity.contextHash) {
    fail("policy identity does not match invocation", "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH");
  }
  const contextSnapshot = clonePlainData(context, "context");
  if (canonicalSha256(contextSnapshot) !== contextHash || canonicalJson(contextSnapshot) !== canonicalJson(state.contextSnapshot)) {
    fail("policy context does not match invocation", "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH");
  }
  const template = getWorkflowV2StageToolPolicyTemplate(policy.identity.stageId);
  validateContextAgainstTemplate(contextSnapshot, template, { storyId, taskId, contextHash });
  return policy;
}

function assertAllowedArgumentKeys(name, args) {
  const keys = TOOL_ARGUMENT_KEYS[name];
  if (!keys) return;
  const allowed = new Set(keys);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) fail("tool call contains an unknown argument", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { name, field: key });
  }
}

function requireRootId(args, state) {
  if (typeof args.rootId !== "string" || !ROOT_ID_PATTERN.test(args.rootId) || !state.bindings.has(args.rootId)) {
    fail("filesystem tool call requires a known rootId", "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID", { rootId: args.rootId ?? null });
  }
  return args.rootId;
}

function assertStringArgument(args, field, { required = false, allowControl = false } = {}) {
  const value = args[field];
  if (value === undefined && !required) return;
  if (typeof value !== "string" || (required && !value) || (!allowControl && CONTROL_PATTERN.test(value))) {
    fail("tool call contains an invalid string argument", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { field });
  }
}

function assertBooleanArgument(args, field) {
  if (args[field] !== undefined && typeof args[field] !== "boolean") {
    fail("tool call contains an invalid boolean argument", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { field });
  }
}

function assertIntegerArgument(args, field, minimum = 0) {
  if (args[field] !== undefined && (!Number.isSafeInteger(args[field]) || args[field] < minimum)) {
    fail("tool call contains an invalid integer argument", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { field });
  }
}

function assertNumberArray(args, field, { integers = false, minimum = 0 } = {}) {
  if (args[field] === undefined) return [];
  if (!Array.isArray(args[field]) || args[field].length > 100 || args[field].some((value) => !Number.isFinite(value)
    || value < minimum || (integers && !Number.isSafeInteger(value)))) {
    fail("tool call contains an invalid numeric array", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { field });
  }
  return args[field];
}

function joinRelative(base, child, label) {
  const normalizedChild = normalizeRelativePath(child, label);
  return base ? normalizeRelativePath(`${base}/${normalizedChild}`, label) : normalizedChild;
}

function patchTargetPaths(patchText) {
  if (typeof patchText !== "string" || !patchText.trim() || patchText.includes("\u0000")) {
    fail("apply_patch requires a non-empty unified diff", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { field: "patch" });
  }
  const targets = [];
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("+++ ")) continue;
    let target = line.slice(4).split("\t", 1)[0];
    if (target === "/dev/null") continue;
    if (target.startsWith("b/")) target = target.slice(2);
    if (!target || target.startsWith('"')) {
      fail("apply_patch contains an unsupported quoted path", "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID");
    }
    targets.push(normalizeRelativePath(target, "patch target"));
  }
  if (!targets.length) fail("apply_patch has no authorized target path", "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID");
  return sortedUnique(targets);
}

function validateCommonArguments(name, args) {
  for (const field of ["pattern", "glob", "revision", "base", "target", "operation", "prompt", "entry_path"] ) {
    assertStringArgument(args, field, { required: ["pattern", "operation", "entry_path"].includes(field) && Object.hasOwn(args, field) });
  }
  for (const field of ["case_sensitive", "staged", "stat"]) assertBooleanArgument(args, field);
  for (const field of ["max_results", "start_line", "line_count", "start_byte", "max_bytes", "max_chars", "max_count", "max_entries"] ) {
    assertIntegerArgument(args, field, field === "start_byte" ? 0 : 1);
  }
  if (name === "write_file") {
    assertStringArgument(args, "content", { required: true, allowControl: true });
  }
  if (name === "edit_file") {
    assertStringArgument(args, "old_string", { required: true, allowControl: true });
    assertStringArgument(args, "new_string", { required: true, allowControl: true });
  }
}

export function authorizeWorkflowV2StageToolCall(policy, name, args = {}) {
  const state = authenticatePolicy(policy);
  if (typeof name !== "string" || !policy.allowedToolNames.includes(name)) {
    fail("tool is not authorized for this stage", "WORKFLOW_V2_STAGE_TOOL_POLICY_TOOL_DENIED", { name: String(name || "") });
  }
  const normalized = clonePlainData(args, "tool args");
  assertPlainObject(normalized, "tool args");
  if (canonicalJson(normalized).length > 2_000_000) {
    fail("tool arguments exceed the policy limit", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { name });
  }
  assertAllowedArgumentKeys(name, normalized);
  validateCommonArguments(name, normalized);
  const rootId = requireRootId(normalized, state);
  const pathRefs = [];
  if (CONTROLLED_EXECUTION_TOOLS.has(name)) {
    const identityField = name === LOCAL_CHECK_TOOL ? "checkId" : "caseId";
    assertStringArgument(normalized, identityField, { required: true });
    if (normalized[identityField].length > 160) {
      fail("controlled execution identity is too long", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", {
        field: identityField,
      });
    }
    pathRefs.push(resolvePathRef(state, rootId, "", "controlledRoot", "read"));
    return deepFreeze({ name, args: normalized, pathRefs });
  }
  let basePath = "";
  if (FILE_PATH_TOOLS.has(name)) {
    basePath = normalizeRelativePath(normalized.path, "path");
    normalized.path = basePath;
    const access = ["edit_file", "write_file"].includes(name) ? "write" : "read";
    pathRefs.push(resolvePathRef(state, rootId, basePath, "path", access));
  } else if (ROOT_PATH_TOOLS.has(name)) {
    basePath = normalized.path === undefined ? "" : normalizeRelativePath(normalized.path, "path", { allowEmpty: true });
    if (normalized.path !== undefined) normalized.path = basePath;
    pathRefs.push(resolvePathRef(state, rootId, basePath, "path", "read"));
  }

  if (name === "git_diff" || name === "git_inspect") {
    if (normalized.file !== undefined) {
      const filePath = joinRelative(basePath, normalized.file, "file");
      normalized.file = normalizeRelativePath(normalized.file, "file");
      pathRefs.push(resolvePathRef(state, rootId, filePath, "file", "read"));
    }
  }
  if (name === "apply_patch") {
    assertStringArgument(normalized, "patch", { required: true, allowControl: true });
    for (const target of patchTargetPaths(normalized.patch)) {
      pathRefs.push(resolvePathRef(state, rootId, joinRelative(basePath, target, "patch target"), "patch", "write"));
    }
  }
  if (name === "extract_archive_entry" && normalized.output_path !== undefined) {
    const output = normalizeRelativePath(normalized.output_path, "output_path");
    normalized.output_path = output;
    pathRefs.push(resolvePathRef(state, rootId, output, "output_path", "write"));
  }
  if (name === "inspect_pdf") {
    const pages = assertNumberArray(normalized, "render_pages", { integers: true, minimum: 1 });
    if (normalized.output_dir !== undefined && pages.length === 0) {
      fail("inspect_pdf output_dir has no declared render effect", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { field: "output_dir" });
    }
    // Rendered pages are Gateway-generated evidence, not source-root writes.
    // The API engine resolves this optional relative subdirectory beneath the
    // story's validated external tempRoot.
    if (pages.length && normalized.output_dir !== undefined) {
      normalized.output_dir = normalizeRelativePath(normalized.output_dir, "output_dir");
    }
  }
  if (name === "inspect_video") {
    const timestamps = assertNumberArray(normalized, "timestamps", { minimum: 0 });
    if (normalized.output_dir !== undefined && timestamps.length === 0) {
      fail("inspect_video output_dir has no declared frame effect", "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID", { field: "output_dir" });
    }
    if (timestamps.length && normalized.output_dir !== undefined) {
      normalized.output_dir = normalizeRelativePath(normalized.output_dir, "output_dir");
    }
  }
  return deepFreeze({ name, args: normalized, pathRefs });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sanitizeWorkflowV2StageToolResult(policy, text) {
  const state = authenticatePolicy(policy);
  let output = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  const roots = [];
  for (const binding of state.bindings.values()) {
    roots.push({ rootId: binding.rootId, value: binding.realRoot });
    if (!sameRealPath(binding.realRoot, binding.requestedRoot)) roots.push({ rootId: binding.rootId, value: binding.requestedRoot });
  }
  roots.sort((left, right) => right.value.length - left.value.length);
  for (const root of roots) {
    const variants = sortedUnique([root.value, root.value.replaceAll("\\", "/"), root.value.replaceAll("/", "\\")]);
    for (const value of variants) {
      output = output.replace(new RegExp(escapeRegExp(value), process.platform === "win32" ? "giu" : "gu"), `<root:${root.rootId}>`);
    }
  }
  output = output
    .replace(/(^|[\s('"=])(?:[a-zA-Z]:[\\/][^\s'"<>|]*)/gu, "$1<absolute-path>")
    .replace(/(^|[\s('"=])(?:\\\\[^\\/\s]+[\\/][^\s'"<>|]*)/gu, "$1<absolute-path>")
    .replace(/(^|[\s('"=])(\/(?:[^/\s'"<>]+\/)*[^\s'"<>]*)/gu, "$1<absolute-path>");
  return output;
}
