import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const LOCAL_SCHEMA_DIRECTORY = fileURLToPath(new URL("./schemas/", import.meta.url));
const ENVELOPE_SCHEMA_PATH = fileURLToPath(new URL("./schemas/workflow-envelope.schema.json", import.meta.url));

export const WORKFLOW_V2_SCHEMA_IDS = Object.freeze({
  stageContext: "https://example.local/schemas/stage-context-v2.json",
  workflowCheckpoint: "https://example.local/schemas/workflow-checkpoint-v2.json",
  evidenceManifest: "https://example.local/schemas/evidence-manifest-v2.json",
  evidenceReceipt: "https://example.local/schemas/evidence-receipt-v2.json",
  workflowEnvelope: "https://example.local/schemas/workflow-envelope-v2.json",
  compatibilitySourceCursor: "https://example.local/schemas/compatibility-source-cursor-v1.json",
  triageResult: "https://example.local/schemas/triage-result-v2.json",
  repairResult: "https://example.local/schemas/repair-result-v2.json",
  verificationPlan: "https://example.local/schemas/verification-plan-v2.json",
  verificationResult: "https://example.local/schemas/verification-result-v2.json",
  shortReportResult: "https://example.local/schemas/short-report-result-v2.json",
  expertReportResult: "https://example.local/schemas/expert-report-result-v2.json",
  stageResultRecord: "https://example.local/schemas/stage-result-record-v1.json",
});

const PHASE2_SCHEMA_FILES = Object.freeze([
  "workflow-checkpoint.schema.json",
  "stage-context.schema.json",
  "evidence-manifest.schema.json",
  "evidence-receipt.schema.json",
  "compatibility-source-cursor.schema.json",
  "triage-result.schema.json",
  "repair-result.schema.json",
  "verification-plan.schema.json",
  "verification-result.schema.json",
  "short-report-result.schema.json",
  "expert-report-result.schema.json",
  "stage-result-record.schema.json",
]);

function readJson(pathname) {
  return JSON.parse(readFileSync(pathname, "utf8"));
}

function cloneErrors(errors = []) {
  return errors.map((entry) => ({ ...entry, params: { ...(entry.params || {}) } }));
}

export class WorkflowV2SchemaValidationError extends Error {
  constructor(message, { schemaId = "", errors = [], code = "WORKFLOW_V2_SCHEMA_VALIDATION_FAILED" } = {}) {
    super(message);
    this.name = "WorkflowV2SchemaValidationError";
    this.code = code;
    this.schemaId = schemaId;
    this.validationErrors = cloneErrors(errors);
  }
}

export class WorkflowV2SchemaRegistry {
  constructor({ schemaDirectory = LOCAL_SCHEMA_DIRECTORY, envelopeSchemaPath = ENVELOPE_SCHEMA_PATH } = {}) {
    this.ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: true,
      strictTypes: false,
      validateFormats: true,
    });
    addFormats(this.ajv);

    this.schemaDocuments = new Map();
    for (const filename of PHASE2_SCHEMA_FILES) {
      const document = readJson(path.join(schemaDirectory, filename));
      this.schemaDocuments.set(document.$id, document);
      this.ajv.addSchema(document);
    }
    const envelopeDocument = readJson(envelopeSchemaPath);
    this.schemaDocuments.set(envelopeDocument.$id, envelopeDocument);
    this.ajv.addSchema(envelopeDocument);

    for (const schemaId of Object.values(WORKFLOW_V2_SCHEMA_IDS)) {
      if (!this.ajv.getSchema(schemaId)) {
        throw new WorkflowV2SchemaValidationError(`Workflow v2 Schema 未注册: ${schemaId}`, {
          schemaId,
          code: "WORKFLOW_V2_SCHEMA_NOT_REGISTERED",
        });
      }
    }
  }

  has(schemaId) {
    return this.schemaDocuments.has(schemaId);
  }

  getSchemaDocument(schemaId) {
    const document = this.schemaDocuments.get(schemaId);
    if (!document) {
      throw new WorkflowV2SchemaValidationError(`不支持的 Workflow v2 Schema: ${schemaId}`, {
        schemaId,
        code: "WORKFLOW_V2_SCHEMA_NOT_REGISTERED",
      });
    }
    return structuredClone(document);
  }

  validate(schemaId, value) {
    const validator = this.ajv.getSchema(schemaId);
    if (!validator) {
      return {
        valid: false,
        errors: [],
        code: "WORKFLOW_V2_SCHEMA_NOT_REGISTERED",
      };
    }
    const valid = validator(value);
    return {
      valid: !!valid,
      errors: valid ? [] : cloneErrors(validator.errors || []),
      code: valid ? null : "WORKFLOW_V2_SCHEMA_VALIDATION_FAILED",
    };
  }

  assertValid(schemaId, value, label = "payload") {
    const result = this.validate(schemaId, value);
    if (result.valid) return value;
    if (result.code === "WORKFLOW_V2_SCHEMA_NOT_REGISTERED") {
      throw new WorkflowV2SchemaValidationError(`不支持的 Workflow v2 Schema: ${schemaId}`, {
        schemaId,
        code: result.code,
      });
    }
    throw new WorkflowV2SchemaValidationError(`${label} 不符合 ${schemaId}`, {
      schemaId,
      errors: result.errors,
    });
  }
}

export const workflowV2SchemaRegistry = new WorkflowV2SchemaRegistry();

export const workflowV2SchemaSources = Object.freeze({
  schemaDirectory: LOCAL_SCHEMA_DIRECTORY,
  envelopeSchemaPath: ENVELOPE_SCHEMA_PATH,
});
