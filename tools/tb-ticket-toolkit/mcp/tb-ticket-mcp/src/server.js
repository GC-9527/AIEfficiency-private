import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ToolkitError, redactErrorMessage, redactSecrets } from "../../../packages/tb-domain/src/index.js";
import { toolsForProfile } from "./contracts.js";

function assertObject(value, name = "arguments") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolkitError("INVALID_ARGUMENT", `${name} must be an object`);
  return value;
}

function assertExact(value, allowed, required = []) {
  const input = assertObject(value);
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ToolkitError("INVALID_ARGUMENT", `unknown input field(s): ${unknown.join(", ")}`);
  const missing = required.filter((key) => input[key] === undefined || input[key] === null || input[key] === "");
  if (missing.length) throw new ToolkitError("INVALID_ARGUMENT", `missing input field(s): ${missing.join(", ")}`);
  return input;
}

function assertString(value, name, { min = 0, max = Infinity, optional = false } = {}) {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ToolkitError("INVALID_ARGUMENT", `${name} must be a string between ${min} and ${max} characters`);
  }
}

function assertEnum(value, name, allowed) {
  if (!allowed.includes(value)) throw new ToolkitError("INVALID_ARGUMENT", `${name} must be one of: ${allowed.join(", ")}`);
}

function validateTaskRef(value) {
  if (typeof value === "string" && value.trim() && value.length <= 120) return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length && keys.every((key) => ["taskId", "taskNo"].includes(key))) {
      for (const key of keys) assertString(value[key], `taskRef.${key}`, { min: 1, max: 120 });
      if (value.taskId || value.taskNo) return;
    }
  }
  throw new ToolkitError("INVALID_ARGUMENT", "taskRef must identify exactly one task");
}

function validateStatusRef(value, name, { optional = false } = {}) {
  if (value === undefined && optional) return;
  if (typeof value === "string") return assertString(value, name, { min: 1, max: 120 });
  const input = assertExact(value, ["statusId", "displayName"]);
  if (!input.statusId && !input.displayName) throw new ToolkitError("INVALID_ARGUMENT", `${name} must identify one status`);
  if (input.statusId !== undefined) assertString(input.statusId, `${name}.statusId`, { min: 1, max: 120 });
  if (input.displayName !== undefined) assertString(input.displayName, `${name}.displayName`, { min: 1, max: 120 });
}

function validateSelection(value) {
  if (value === undefined) return;
  const input = assertExact(value, ["mode", "attachmentIds"], ["mode"]);
  assertEnum(input.mode, "attachmentSelection.mode", ["selected", "all"]);
  if (input.mode === "all") {
    if (input.attachmentIds !== undefined) throw new ToolkitError("INVALID_ARGUMENT", "attachmentSelection.attachmentIds is unavailable for all mode");
    return;
  }
  if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length === 0 || new Set(input.attachmentIds).size !== input.attachmentIds.length) {
    throw new ToolkitError("INVALID_ARGUMENT", "attachmentSelection.attachmentIds must be a non-empty unique string array");
  }
  input.attachmentIds.forEach((id, index) => assertString(id, `attachmentSelection.attachmentIds[${index}]`, { min: 1, max: 200 }));
}

function validateEvidence(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) throw new ToolkitError("INVALID_ARGUMENT", "evidenceRefs must contain 1 to 20 items");
  const kinds = ["ticket_field", "attachment", "source", "unit_test", "integration_test", "build", "lint", "runtime", "manual", "other"];
  const results = ["PASS", "FAIL", "SKIPPED", "INCOMPLETE", "OBSERVED"];
  rows.forEach((row, index) => {
    const item = assertExact(row, ["kind", "result", "pathOrId", "command", "summary"], ["kind", "result", "summary"]);
    assertEnum(item.kind, `evidenceRefs[${index}].kind`, kinds);
    assertEnum(item.result, `evidenceRefs[${index}].result`, results);
    assertString(item.summary, `evidenceRefs[${index}].summary`, { min: 1, max: 800 });
    if (item.pathOrId !== undefined) assertString(item.pathOrId, `evidenceRefs[${index}].pathOrId`, { max: 500 });
    if (item.command !== undefined) assertString(item.command, `evidenceRefs[${index}].command`, { max: 500 });
  });
}

function validateSource(value) {
  const input = assertExact(value, ["repoPath", "branch", "commit", "workflowRunId", "actor"]);
  const maxima = { repoPath: 1000, branch: 300, commit: 200, workflowRunId: 200, actor: 200 };
  for (const [key, field] of Object.entries(input)) assertString(field, `source.${key}`, { max: maxima[key] });
}

function validateCall(name, raw) {
  const rules = {
    tb_ticket_prepare: { allowed: ["taskRef", "repoRoot", "attachmentSelection", "refreshContext"], required: ["taskRef", "repoRoot"] },
    tb_workflow_get: { allowed: ["taskRef"], required: ["taskRef"] },
    tb_update_plan: { allowed: ["phase", "taskRef", "expectedCurrentStatus", "targetStatus", "contextDigest", "reason", "measure", "evidenceRefs", "source", "idempotencyKey"], required: ["phase", "taskRef", "targetStatus", "contextDigest", "reason", "measure", "evidenceRefs", "source"] },
    tb_update_apply: { allowed: ["planId", "fingerprint", "idempotencyKey", "apply"], required: ["planId", "fingerprint", "idempotencyKey", "apply"] },
    tb_operation_get: { allowed: ["operationId"], required: ["operationId"] },
  };
  const rule = rules[name];
  if (!rule) throw new ToolkitError("TOOL_NOT_FOUND", `unknown tool: ${name}`);
  const input = assertExact(raw || {}, rule.allowed, rule.required);
  if ("taskRef" in input) validateTaskRef(input.taskRef);
  if (name === "tb_ticket_prepare") {
    assertString(input.repoRoot, "repoRoot", { min: 1, max: 1000 });
    validateSelection(input.attachmentSelection);
    if (input.refreshContext !== undefined && typeof input.refreshContext !== "boolean") throw new ToolkitError("INVALID_ARGUMENT", "refreshContext must be a boolean");
  }
  if (name === "tb_update_plan") {
    assertEnum(input.phase, "phase", ["TRIAGE", "RESOLUTION"]);
    validateStatusRef(input.expectedCurrentStatus, "expectedCurrentStatus", { optional: true });
    validateStatusRef(input.targetStatus, "targetStatus");
    assertString(input.contextDigest, "contextDigest", { min: 16, max: 128 });
    assertString(input.reason, "reason", { min: 1, max: 200 });
    assertString(input.measure, "measure", { min: 1, max: 300 });
    validateEvidence(input.evidenceRefs);
    validateSource(input.source);
    if (input.idempotencyKey !== undefined) assertString(input.idempotencyKey, "idempotencyKey", { min: 8, max: 240 });
  }
  if (name === "tb_update_apply") {
    assertString(input.planId, "planId", { min: 1, max: 200 });
    assertString(input.fingerprint, "fingerprint", { min: 16, max: 128 });
    assertString(input.idempotencyKey, "idempotencyKey", { min: 8, max: 240 });
    if (input.apply !== true) throw new ToolkitError("WRITE_DISABLED", "apply=true is required");
  }
  if (name === "tb_operation_get") assertString(input.operationId, "operationId", { min: 1, max: 200 });
  return input;
}

function result(value) {
  const safe = redactSecrets(value);
  return { content: [{ type: "text", text: JSON.stringify(safe) }] };
}

function errorResult(error) {
  const code = error instanceof ToolkitError ? error.code : "INTERNAL_ERROR";
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message: redactErrorMessage(error) } }) }],
  };
}

export function createTbTicketMcpServer({ application, profile = "read" } = {}) {
  if (!application) throw new ToolkitError("APPLICATION_REQUIRED", "tb-ticket-mcp requires an application instance");
  const tools = toolsForProfile(profile);
  const names = new Set(tools.map((tool) => tool.name));
  const server = new Server(
    { name: "tb-ticket-mcp", version: "0.6.0" },
    { capabilities: { tools: {} }, instructions: "One-ticket Teambition workflow. Call tb_ticket_prepare first. Remote writes are disabled unless the write profile and all apply guards are satisfied." },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = request.params.name;
      if (!names.has(name)) throw new ToolkitError(name === "tb_update_apply" ? "WRITE_DISABLED" : "TOOL_NOT_FOUND", `tool unavailable in ${profile} profile`);
      const input = validateCall(name, request.params.arguments);
      if (name === "tb_ticket_prepare") return result(await application.prepare({ taskRef: input.taskRef, repoPath: input.repoRoot, selection: input.attachmentSelection || null }));
      if (name === "tb_workflow_get") return result(await application.workflowGet(input.taskRef));
      if (name === "tb_update_plan") return result(await application.updatePlan(input));
      if (name === "tb_update_apply") return result(await application.updateApply(input));
      return result(await application.operationGet(input.operationId));
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}
