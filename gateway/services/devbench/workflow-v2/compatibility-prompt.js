import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "./envelope-store.js";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "./schema-registry.js";
import { resolveCompatibilityStage } from "./prompt-v2-rollout.js";

const TEMPLATE_FILES = Object.freeze({
  TRIAGE: "triage-current.md",
  REPAIR: "repair-current.md",
  VERIFY_EXECUTE: "verify-current.md",
  REPORT_SHORT: "report-short-current.md",
  REPORT_EXPERT: "report-expert-current.md",
});
const COMPATIBILITY_PROMPT_HARD_MAX = 30000;

const templateCache = new Map();

export class WorkflowV2CompatibilityPromptError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2CompatibilityPromptError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2CompatibilityPromptError(message, code, details);
}

function loadTemplate(stageId) {
  if (templateCache.has(stageId)) return templateCache.get(stageId);
  const filename = TEMPLATE_FILES[stageId];
  if (!filename) return "";
  let raw;
  try {
    raw = readFileSync(new URL(`./prompts/compatibility/${filename}`, import.meta.url), "utf8");
  } catch (error) {
    fail(`兼容 Prompt 模板不可读取: ${filename}`, "WORKFLOW_V2_PROMPT_TEMPLATE_UNAVAILABLE", {
      stageId,
      filename,
      causeCode: error?.code || "",
    });
  }
  if (raw.charCodeAt(0) === 0xfeff) {
    fail(`兼容 Prompt 模板含 BOM: ${filename}`, "WORKFLOW_V2_PROMPT_TEMPLATE_INVALID", { stageId, filename });
  }
  const normalized = raw.replace(/\r\n?/g, "\n");
  templateCache.set(stageId, normalized);
  return normalized;
}

function assertTemplatePlaceholders(template, stageId) {
  const expected = stageId === "REPORT_SHORT"
    ? ["{{MAX_CHARS}}", "{{REPORT_FACTS_JSON}}"]
    : stageId === "REPORT_EXPERT"
      ? []
      : ["{{STAGE_CONTEXT_JSON}}"];
  const actual = [...template.matchAll(/\{\{[A-Z0-9_]+\}\}/g)].map((match) => match[0]).sort();
  if (canonicalJson(actual) !== canonicalJson([...expected].sort())) {
    fail("兼容 Prompt 模板占位符集合无效", "WORKFLOW_V2_PROMPT_TEMPLATE_INVALID", {
      stageId,
      expected,
      actual,
    });
  }
}

function replaceExactlyOnce(template, placeholder, replacement, stageId) {
  const first = template.indexOf(placeholder);
  const last = template.lastIndexOf(placeholder);
  if (first < 0 || first !== last) {
    fail(`兼容模板占位符数量无效: ${placeholder}`, "WORKFLOW_V2_PROMPT_TEMPLATE_INVALID", {
      stageId,
      placeholder,
    });
  }
  return `${template.slice(0, first)}${replacement}${template.slice(first + placeholder.length)}`;
}

function assertJsonValue(value, field, stageId) {
  if (value === undefined) {
    fail(`兼容 Prompt 缺少 ${field}`, "WORKFLOW_V2_PROMPT_CONTEXT_INCOMPLETE", { stageId, field });
  }
  return encodeJsonForTaggedPrompt(canonicalJson(value));
}

function encodeJsonForTaggedPrompt(json) {
  return String(json)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function composeReportExpert(template, context) {
  const stageId = context.stage.id;
  const reportFacts = assertJsonValue(context.data?.reportFacts, "data.reportFacts", stageId);
  const assetManifest = assertJsonValue(context.data?.assetManifest, "data.assetManifest", stageId);
  const reportPath = String(context.output?.outputPath || "").trim();
  if (!reportPath) {
    fail("专家报告兼容 Prompt 缺少 reportPath", "WORKFLOW_V2_PROMPT_CONTEXT_INCOMPLETE", {
      stageId,
      field: "data.outputPath",
    });
  }
  if (context.data?.outputPath !== undefined && context.data.outputPath !== reportPath) {
    fail("专家报告 data.outputPath 与可信 output.outputPath 不一致", "WORKFLOW_V2_PROMPT_CONTEXT_CONTROL_MISMATCH", {
      stageId,
      field: "data.outputPath",
    });
  }
  return [
    template.trimEnd(),
    "",
    `<REPORT_FACTS_JSON>${reportFacts}</REPORT_FACTS_JSON>`,
    `<ASSET_MANIFEST_JSON>${assetManifest}</ASSET_MANIFEST_JSON>`,
    `<REPORT_PATH>${encodeJsonForTaggedPrompt(JSON.stringify(reportPath))}</REPORT_PATH>`,
    "",
  ].join("\n");
}

export { resolveCompatibilityStage };

export function composeCompatibilityPrompt({ context, canonical = "" } = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    fail("兼容 Prompt context 必须是对象", "WORKFLOW_V2_PROMPT_CONTEXT_INVALID");
  }
  workflowV2SchemaRegistry.assertValid(
    WORKFLOW_V2_SCHEMA_IDS.stageContext,
    context,
    "workflow v2 compatibility prompt context",
  );
  const stageId = String(context.stage?.id || "");
  const template = loadTemplate(stageId);
  if (!template) {
    fail(`没有可用的兼容 Prompt: ${stageId || "<empty>"}`, "WORKFLOW_V2_PROMPT_STAGE_UNSUPPORTED", { stageId });
  }
  const contextCanonical = canonicalJson(context);
  if (canonical && canonical !== contextCanonical) {
    fail("StageContext canonical 与 payload 不一致", "WORKFLOW_V2_PROMPT_CONTEXT_HASH_MISMATCH", { stageId });
  }
  assertTemplatePlaceholders(template, stageId);

  let prompt;
  if (stageId === "REPORT_SHORT") {
    const reportFacts = assertJsonValue(context.data?.reportFacts, "data.reportFacts", stageId);
    const maxChars = context.output?.maxChars;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      fail("简短报告兼容 Prompt 的 maxChars 无效", "WORKFLOW_V2_PROMPT_CONTEXT_INCOMPLETE", {
        stageId,
        field: "data.maxChars",
      });
    }
    if (context.data?.maxChars !== undefined && context.data.maxChars !== maxChars) {
      fail("简短报告 data.maxChars 与可信 output.maxChars 不一致", "WORKFLOW_V2_PROMPT_CONTEXT_CONTROL_MISMATCH", {
        stageId,
        field: "data.maxChars",
      });
    }
    prompt = replaceExactlyOnce(template, "{{REPORT_FACTS_JSON}}", reportFacts, stageId);
    prompt = replaceExactlyOnce(prompt, "{{MAX_CHARS}}", String(maxChars), stageId);
  } else if (stageId === "REPORT_EXPERT") {
    prompt = composeReportExpert(template, context);
  } else {
    prompt = replaceExactlyOnce(
      template,
      "{{STAGE_CONTEXT_JSON}}",
      encodeJsonForTaggedPrompt(contextCanonical),
      stageId,
    );
  }

  const promptChars = Array.from(prompt).length;
  if (promptChars > COMPATIBILITY_PROMPT_HARD_MAX) {
    fail("兼容 Prompt 超出最终字符上限", "WORKFLOW_V2_PROMPT_BUDGET_EXCEEDED", {
      stageId,
      promptChars,
      maxChars: COMPATIBILITY_PROMPT_HARD_MAX,
    });
  }
  return {
    prompt,
    stageId,
    templateFile: TEMPLATE_FILES[stageId],
    contextCanonical,
    contextHash: createHash("sha256").update(contextCanonical, "utf8").digest("hex"),
    promptChars,
    promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
  };
}

export const compatibilityPromptTemplateFiles = TEMPLATE_FILES;
