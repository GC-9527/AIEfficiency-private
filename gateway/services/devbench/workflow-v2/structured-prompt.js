import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./envelope-store.js";
import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "./schema-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = path.join(__dirname, "prompts", "structured");
const PROMPT_HARD_MAX_CHARS = 50000;

const RESULT_SCHEMA_BY_STAGE = Object.freeze({
  TRIAGE: WORKFLOW_V2_SCHEMA_IDS.triageResult,
  REPAIR: WORKFLOW_V2_SCHEMA_IDS.repairResult,
  VERIFY_EXECUTE: WORKFLOW_V2_SCHEMA_IDS.verificationResult,
  REPORT_SHORT: WORKFLOW_V2_SCHEMA_IDS.shortReportResult,
  REPORT_EXPERT: WORKFLOW_V2_SCHEMA_IDS.expertReportResult,
});

const STAGE_TEMPLATE_BY_ID = Object.freeze({
  TRIAGE: "triage.md",
  REPAIR: "repair.md",
  VERIFY_EXECUTE: "verification-execute.md",
  REPORT_SHORT: "report-short.md",
  REPORT_EXPERT: "report-expert.md",
});

export class WorkflowV2StructuredPromptError extends Error {
  constructor(message, code = "WORKFLOW_V2_STRUCTURED_PROMPT_INVALID", details = {}) {
    super(message);
    this.name = "WorkflowV2StructuredPromptError";
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}

function fail(message, code, details) {
  throw new WorkflowV2StructuredPromptError(message, code, details);
}

function readTemplate(relativePath) {
  const pathname = path.join(TEMPLATE_ROOT, ...relativePath.split("/"));
  let value;
  try {
    value = readFileSync(pathname, "utf8");
  } catch (error) {
    fail(`缺少 structured Prompt 运行资产: ${relativePath}`, "WORKFLOW_V2_STRUCTURED_PROMPT_ASSET_MISSING", {
      cause: error?.message || String(error),
    });
  }
  if (value.charCodeAt(0) === 0xfeff) {
    fail(`structured Prompt 运行资产含 BOM: ${relativePath}`, "WORKFLOW_V2_STRUCTURED_PROMPT_ASSET_INVALID");
  }
  return value.replace(/\r\n?/g, "\n").trim();
}

function encodeTaggedJson(value) {
  return value.replace(/[<>&]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
  })[character]);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function resultSchemaIdForStage(stageId) {
  const schemaId = RESULT_SCHEMA_BY_STAGE[String(stageId || "")];
  if (!schemaId) {
    fail(`structured Prompt 不支持阶段: ${stageId || "(empty)"}`, "WORKFLOW_V2_STRUCTURED_STAGE_UNSUPPORTED");
  }
  return schemaId;
}

export function composeStructuredPrompt({
  context,
  canonical = "",
  strategy = "json_text",
  registry = workflowV2SchemaRegistry,
} = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    fail("structured Prompt 缺少 StageContext");
  }
  const stageId = String(context?.stage?.id || "");
  const schemaId = resultSchemaIdForStage(stageId);
  if (context?.output?.schemaId !== schemaId) {
    fail("StageContext output.schemaId 与冻结阶段不一致", "WORKFLOW_V2_STRUCTURED_SCHEMA_IDENTITY_MISMATCH", {
      expected: schemaId,
      actual: context?.output?.schemaId,
    });
  }
  if (!["finish_stage", "json_text"].includes(strategy)) {
    fail(`不支持的 structured strategy: ${strategy}`, "WORKFLOW_V2_STRUCTURED_STRATEGY_UNSUPPORTED");
  }
  const schema = registry.getSchemaDocument(schemaId);
  registry.assertValid("https://example.local/schemas/stage-context-v2.json", context, "structured StageContext");
  const contextCanonical = canonical || canonicalJson(context);
  if (contextCanonical !== canonicalJson(context)) {
    fail("调用方提供的 StageContext canonical bytes 不一致", "WORKFLOW_V2_STRUCTURED_CONTEXT_CANONICAL_MISMATCH");
  }
  const schemaCanonical = canonicalJson(schema);
  const providerInstruction = strategy === "finish_stage"
    ? [
      readTemplate("providers/api-agent-system.md"),
      "最终结果不得作为普通文本输出；只能单独调用一次 `finish_stage`，参数必须是符合下方 RESULT_SCHEMA_JSON 的完整对象。",
    ].join("\n")
    : readTemplate("shared/cli-json-output.md");
  const prompt = [
    readTemplate("shared/system-core.md"),
    readTemplate(`stages/${STAGE_TEMPLATE_BY_ID[stageId]}`),
    providerInstruction,
    `结果身份必须原样回传：contextId=${context.contextId}，contextRevision=${context.revision}，idempotencyKey=${context.idempotencyKey}。`,
    `<STAGE_CONTEXT_JSON>${encodeTaggedJson(contextCanonical)}</STAGE_CONTEXT_JSON>`,
    `<RESULT_SCHEMA_JSON>${encodeTaggedJson(schemaCanonical)}</RESULT_SCHEMA_JSON>`,
  ].join("\n\n");
  const promptChars = Array.from(prompt).length;
  if (promptChars > PROMPT_HARD_MAX_CHARS) {
    fail(`structured Prompt 超过硬上限: ${promptChars}/${PROMPT_HARD_MAX_CHARS}`, "WORKFLOW_V2_STRUCTURED_PROMPT_BUDGET_EXCEEDED", {
      promptChars,
      hardMaxChars: PROMPT_HARD_MAX_CHARS,
    });
  }
  return {
    stageId,
    templateId: `structured/${stageId.toLowerCase()}`,
    prompt,
    promptChars,
    promptSha256: sha256(prompt),
    contextHash: sha256(contextCanonical),
    resultSchemaId: schemaId,
    resultSchemaSha256: sha256(schemaCanonical),
    structuredStrategy: strategy,
    structuredOutput: {
      mode: "structured",
      strategy,
      schemaId,
      schema,
      contextId: context.contextId,
      contextRevision: context.revision,
      idempotencyKey: context.idempotencyKey,
    },
  };
}

export const structuredPromptTemplateFiles = Object.freeze([
  "shared/system-core.md",
  "shared/cli-json-output.md",
  "providers/api-agent-system.md",
  ...Object.values(STAGE_TEMPLATE_BY_ID).map((name) => `stages/${name}`),
]);
