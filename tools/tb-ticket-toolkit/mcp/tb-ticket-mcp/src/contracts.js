const taskRef = {
  anyOf: [
    { type: "string", minLength: 1, maxLength: 120 },
    {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        taskId: { type: "string", minLength: 1, maxLength: 120 },
        taskNo: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
  ],
};

const statusRef = {
  anyOf: [
    { type: "string", minLength: 1, maxLength: 120 },
    {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        statusId: { type: "string", minLength: 1, maxLength: 120 },
        displayName: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
  ],
};

export const TB_TICKET_TOOL_NAMES = Object.freeze([
  "tb_ticket_prepare",
  "tb_workflow_get",
  "tb_update_plan",
  "tb_update_apply",
  "tb_operation_get",
]);

export const READ_PROFILE_TOOL_NAMES = Object.freeze(TB_TICKET_TOOL_NAMES.filter((name) => name !== "tb_update_apply"));
export const WRITE_PROFILE_TOOL_NAMES = TB_TICKET_TOOL_NAMES;

export const TB_TICKET_TOOLS = Object.freeze([
  {
    name: "tb_ticket_prepare",
    description: "Resolve one Teambition ticket through the official MCP, supplement audited gaps, prepare complete context, and safely download selected attachments.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object", additionalProperties: false, required: ["taskRef", "repoRoot"],
      properties: {
        taskRef,
        repoRoot: { type: "string", minLength: 1, maxLength: 1000 },
        attachmentSelection: {
          type: "object", additionalProperties: false, required: ["mode"],
          properties: {
            mode: { enum: ["selected", "all"] },
            attachmentIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
          },
        },
        refreshContext: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "tb_workflow_get",
    description: "Read the current task's official Teambition workflow and resolve the exact AI甄别 status in that workflow.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", additionalProperties: false, required: ["taskRef"], properties: { taskRef } },
  },
  {
    name: "tb_update_plan",
    description: "Create a local, expiring, fingerprinted TRIAGE or RESOLUTION update plan. This never writes Teambition.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["phase", "taskRef", "targetStatus", "contextDigest", "reason", "measure", "evidenceRefs", "source"],
      properties: {
        phase: { enum: ["TRIAGE", "RESOLUTION"] }, taskRef,
        expectedCurrentStatus: statusRef, targetStatus: statusRef,
        contextDigest: { type: "string", minLength: 16, maxLength: 128 },
        reason: { type: "string", minLength: 1, maxLength: 200 },
        measure: { type: "string", minLength: 1, maxLength: 300 },
        evidenceRefs: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object", additionalProperties: false, required: ["kind", "result", "summary"],
            properties: {
              kind: { enum: ["ticket_field", "attachment", "source", "unit_test", "integration_test", "build", "lint", "runtime", "manual", "other"] },
              result: { enum: ["PASS", "FAIL", "SKIPPED", "INCOMPLETE", "OBSERVED"] },
              pathOrId: { type: "string", maxLength: 500 }, command: { type: "string", maxLength: 500 }, summary: { type: "string", minLength: 1, maxLength: 800 },
            },
          },
        },
        source: {
          type: "object", additionalProperties: false,
          properties: {
            repoPath: { type: "string", maxLength: 1000 }, branch: { type: "string", maxLength: 300 },
            commit: { type: "string", maxLength: 200 }, workflowRunId: { type: "string", maxLength: 200 }, actor: { type: "string", maxLength: 200 },
          },
        },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 240 },
      },
    },
  },
  {
    name: "tb_update_apply",
    description: "Apply one authorized, allowlisted update plan through official Teambition MCP write tools with lock, idempotency and readback.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object", additionalProperties: false, required: ["planId", "fingerprint", "idempotencyKey", "apply"],
      properties: {
        planId: { type: "string", minLength: 1, maxLength: 200 }, fingerprint: { type: "string", minLength: 16, maxLength: 128 },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 240 }, apply: { const: true },
      },
    },
  },
  {
    name: "tb_operation_get",
    description: "Read a durable local operation record and its safe recovery action.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object", additionalProperties: false, required: ["operationId"],
      properties: { operationId: { type: "string", minLength: 1, maxLength: 200 } },
    },
  },
]);

export function toolsForProfile(profile) {
  const names = new Set(profile === "write" ? WRITE_PROFILE_TOOL_NAMES : READ_PROFILE_TOOL_NAMES);
  return TB_TICKET_TOOLS.filter((tool) => names.has(tool.name));
}
