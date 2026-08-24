import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-store-"));
const cloneParent = path.join(tempRoot, "clone-parent");
const marketConfig = path.join(tempRoot, "market.json");
const localProjects = path.join(tempRoot, "local", "devbench-projects.json");
fs.mkdirSync(cloneParent, { recursive: true });
fs.mkdirSync(path.dirname(localProjects), { recursive: true });
fs.writeFileSync(marketConfig, "{}", "utf8");
fs.writeFileSync(localProjects, JSON.stringify({
  version: 4,
  cloneParent,
  projects: [],
}), "utf8");
process.env.DEVBENCH_CONFIG_PATH = marketConfig;
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = localProjects;
process.env.DEVBENCH_STORE_DIR = path.join(tempRoot, "devbench-store");
process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
process.env.AIEFFICIENCY_CLONE_PARENT = cloneParent;
fs.mkdirSync(process.env.DEVBENCH_STORE_DIR, { recursive: true });
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, "{}", "utf8");

const workflow = await import("../services/devbench/workflow-v2/envelope-store.js");
const { WORKFLOW_V2_SCHEMA_IDS } = await import("../services/devbench/workflow-v2/schema-registry.js");
const storyStorage = await import("../services/devbench/store.js");

let storySequence = 0;
function newTab(label) {
  storySequence += 1;
  return {
    id: `story-${storySequence}`,
    title: `${label}-${storySequence}`,
    docSlug: `${label}-${storySequence}`,
    closedAt: null,
  };
}

function checkpoint(tab, revision) {
  return {
    schemaVersion: "workflow-checkpoint-v2",
    storyId: String(tab.id),
    revision,
    summary: `checkpoint-${revision}`,
    claims: [],
    actions: [],
    changes: [],
    verification: [],
    openItems: [],
    userDecisions: [],
  };
}

function manifest(tab, suffix = "") {
  return {
    schemaVersion: "evidence-manifest-v2",
    storyId: String(tab.id),
    coverage: "COMPLETE",
    items: [{
      evidenceId: `evidence-${suffix || "1"}`,
      type: "LOG",
      name: `log-${suffix || "1"}`,
      availability: "AVAILABLE",
      required: true,
      contentRef: `storydev:/archives/log-${suffix || "1"}.txt`,
    }],
  };
}

function stageContext(tab, revision = 1, contextId = `context-${tab.id}`) {
  const idempotencyKey = `${tab.id}:${contextId}:${revision}`;
  return {
    schemaVersion: "tb-stage-context-v2",
    contextId,
    revision,
    idempotencyKey,
    story: { storyId: String(tab.id), title: tab.title },
    stage: { id: "TRIAGE", attempt: revision, riskLevel: "MEDIUM" },
    task: { instruction: "triage", successCriteria: [] },
    scope: { roots: [{ rootId: "main", kind: "MAIN", writable: false }] },
    capabilities: {
      allowedTools: [],
      canWriteSource: false,
      canReadGit: false,
      canWriteGit: false,
      canCommit: false,
      canUseDevice: false,
      canWriteTb: false,
      canWriteReport: false,
      maxToolIterations: 0,
    },
    checkpoint: { ref: `storydev:/workflow-v2/checkpoint/${revision}` },
    data: {},
    output: { schemaId: "https://example.local/schemas/triage-result-v2.json" },
  };
}

function triageResult(context) {
  return {
    schemaVersion: "triage-result-v2",
    contextId: context.contextId,
    contextRevision: context.revision,
    idempotencyKey: context.idempotencyKey,
    status: "COMPLETED",
    classification: "NON_CLIENT_ISSUE",
    confidence: "MEDIUM",
    rootCause: {
      symptom: "symptom",
      trigger: "trigger",
      observedBehavior: "observed",
      directCause: "cause",
      faultOwner: "owner",
      workaroundOwner: "workaround",
    },
    claims: [],
    evidenceRead: [],
    evidenceUnread: [],
    recommendedAction: "follow up",
    userSummary: "summary",
    nextStage: null,
  };
}

function stageResultRecord(tab, recordRevision = 1, context = stageContext(tab, recordRevision)) {
  const result = triageResult(context);
  return {
    schemaVersion: "stage-result-record-v1",
    storyId: String(tab.id),
    recordRevision,
    stageId: "TRIAGE",
    resultSchemaId: WORKFLOW_V2_SCHEMA_IDS.triageResult,
    contextId: context.contextId,
    contextRevision: context.revision,
    contextIdempotencyKey: context.idempotencyKey,
    resultSha256: workflow.canonicalSha256(result),
    result,
  };
}

function receipt({ receiptId, operationId, idempotencyKey = null, action = "READ" }) {
  return {
    schemaVersion: "evidence-receipt-v2",
    receiptId,
    evidenceId: null,
    operationId,
    action,
    status: "PASS",
    toolName: "read_file",
    rootId: "main",
    selector: { path: "src/file.txt" },
    startedAt: "2026-08-07T10:00:00.000Z",
    finishedAt: "2026-08-07T10:00:01.000Z",
    idempotencyKey,
  };
}

function workflowRoot(tab) {
  return path.join(
    storyStorage.getStoryStoragePaths(tab, { create: true, persist: false }).storyDirectory,
    "workflow-v2",
  );
}

function assertNoTransientFiles(tab) {
  const root = workflowRoot(tab);
  const all = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else all.push(entry.name);
    }
  };
  visit(root);
  assert.equal(all.includes(".envelope-store.lock"), false);
  assert.equal(all.some((name) => name.endsWith(".tmp")), false);
}

function rewriteEnvelope(pathname, mutatePayload) {
  const envelope = JSON.parse(fs.readFileSync(pathname, "utf8"));
  mutatePayload(envelope.payload);
  envelope.payloadSha256 = workflow.canonicalSha256(envelope.payload);
  const { envelopeSha256: _oldHash, ...unsigned } = envelope;
  envelope.envelopeSha256 = workflow.canonicalSha256(unsigned);
  fs.writeFileSync(pathname, workflow.canonicalJson(envelope), "utf8");
}

function spawnWorkflowChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`workflow-v2 child exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));
    });
  });
}

async function waitForFiles(files, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (!files.every((file) => fs.existsSync(file))) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`等待子进程就绪超时: ${files.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("canonical JSON 按 RFC 8785 UTF-16 code units 键序稳定，不静默丢弃非法值", () => {
  assert.equal(workflow.canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(workflow.canonicalJson({ "�": 2, "😀": 1 }), '{"😀":1,"�":2}');
  assert.equal(workflow.canonicalSha256({ b: 2, a: 1 }), workflow.canonicalSha256({ a: 1, b: 2 }));
  assert.throws(
    () => workflow.canonicalJson({ missing: undefined }),
    { code: "WORKFLOW_V2_NON_CANONICAL_VALUE" },
  );
  assert.throws(
    () => workflow.canonicalJson({ invalid: Number.POSITIVE_INFINITY }),
    { code: "WORKFLOW_V2_NON_CANONICAL_VALUE" },
  );
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => workflow.canonicalJson(sparse), { code: "WORKFLOW_V2_NON_CANONICAL_VALUE" });
  const symbolKey = { valid: true };
  symbolKey[Symbol("hidden")] = true;
  assert.throws(() => workflow.canonicalJson(symbolKey), { code: "WORKFLOW_V2_NON_CANONICAL_VALUE" });
  assert.throws(() => workflow.canonicalJson("\ud800"), { code: "WORKFLOW_V2_NON_CANONICAL_VALUE" });
  assert.throws(() => workflow.canonicalJson({ "\udc00": true }), { code: "WORKFLOW_V2_NON_CANONICAL_VALUE" });
});

test("typed API 按四条独立 revision stream 追加，且不修改输入", async () => {
  const tab = newTab("independent-streams");
  const cp1 = checkpoint(tab, 1);
  const cp1Before = structuredClone(cp1);
  const manifest1 = manifest(tab, "one");
  const context1 = stageContext(tab, 1);
  const receipt1 = receipt({ receiptId: "receipt-stream-1", operationId: "operation-stream-1" });

  const [checkpointResult, manifestResult, contextResult, receiptResult] = await Promise.all([
    workflow.appendWorkflowCheckpoint({ tab, revision: 1, idempotencyKey: `${tab.id}:checkpoint:1`, payload: cp1 }),
    workflow.appendEvidenceManifest({ tab, revision: 1, idempotencyKey: `${tab.id}:manifest:1`, payload: manifest1 }),
    workflow.appendStageContext({ tab, payload: context1 }),
    workflow.appendEvidenceReceipt({
      tab,
      revision: 1,
      idempotencyKey: `${tab.id}:receipt:1`,
      operationArgs: { rootId: "main", path: "src/file.txt" },
      payload: receipt1,
    }),
  ]);
  assert.deepEqual(cp1, cp1Before);
  assert.equal(checkpointResult.envelope.revision, 1);
  assert.equal(manifestResult.envelope.revision, 1);
  assert.equal(contextResult.envelope.revision, 1);
  assert.equal(receiptResult.envelope.revision, 1);

  await workflow.appendWorkflowCheckpoint({
    tab,
    revision: 2,
    idempotencyKey: `${tab.id}:checkpoint:2`,
    payload: checkpoint(tab, 2),
  });
  await workflow.appendEvidenceManifest({
    tab,
    revision: 2,
    idempotencyKey: `${tab.id}:manifest:2`,
    payload: manifest(tab, "two"),
  });
  assert.equal((await workflow.readWorkflowV2Envelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint })).length, 2);
  assert.equal((await workflow.readWorkflowV2Envelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest })).length, 2);
  assert.equal(path.basename(manifestResult.path), "000000000001.json");
  assert.match(manifestResult.path.replaceAll("\\", "/"), /\/evidence-manifest\/000000000001\.json$/);
  assertNoTransientFiles(tab);
});

test("stage-context 按 (storyId, contextId, revision) 哈希子流独立连续", async () => {
  const tab = newTab("context-streams");
  const contextA = `context-${tab.id}-A`;
  const contextB = `context-${tab.id}-B`;
  const firstA = await workflow.appendStageContext({ tab, payload: stageContext(tab, 1, contextA) });
  const firstB = await workflow.appendStageContext({ tab, payload: stageContext(tab, 1, contextB) });
  const secondA = await workflow.appendStageContext({ tab, payload: stageContext(tab, 2, contextA) });

  assert.equal(path.basename(firstA.path), "000000000001.json");
  assert.equal(path.basename(firstB.path), "000000000001.json");
  assert.equal(path.basename(secondA.path), "000000000002.json");
  const expectedDirectory = createHash("sha256").update(contextA, "utf8").digest("hex");
  assert.equal(path.basename(path.dirname(firstA.path)), expectedDirectory);
  assert.equal(firstA.path.includes(contextA), false, "contextId 不得直接进入文件系统路径");

  const stored = await workflow.readWorkflowV2Envelopes({
    tab,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageContext,
  });
  assert.equal(stored.length, 3);
  assert.equal(
    (await workflow.workflowV2EnvelopeStore.readRevision({
      tab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageContext,
      contextId: contextB,
      revision: 1,
    })).contextId,
    contextB,
  );
  await assert.rejects(
    workflow.workflowV2EnvelopeStore.readRevision({ tab, revision: 1 }),
    { code: "WORKFLOW_V2_SCHEMA_NOT_REGISTERED" },
  );
  await assert.rejects(
    workflow.workflowV2EnvelopeStore.readRevision({ tab, payloadSchemaId: "", revision: 1 }),
    { code: "WORKFLOW_V2_SCHEMA_NOT_REGISTERED" },
  );
  await assert.rejects(
    workflow.appendStageContext({ tab, payload: stageContext(tab, 4, contextA) }),
    { code: "WORKFLOW_V2_REVISION_GAP" },
  );
  const staleB = stageContext(tab, 1, contextB);
  staleB.idempotencyKey = `${staleB.idempotencyKey}:stale`;
  await assert.rejects(
    workflow.appendStageContext({ tab, payload: staleB }),
    { code: "WORKFLOW_V2_STALE_REVISION" },
  );
  assertNoTransientFiles(tab);
});

test("stage/checkpoint/manifest/receipt 跨字段 identity 不一致时写入前拒绝", async () => {
  const tab = newTab("identity");
  const wrongStage = stageContext(tab, 1);
  wrongStage.story.storyId = "another-story";
  await assert.rejects(
    workflow.appendStageContext({ tab, payload: wrongStage }),
    { code: "WORKFLOW_V2_IDENTITY_MISMATCH" },
  );

  await assert.rejects(
    workflow.appendWorkflowV2Envelope({
      tab,
      recordId: "forged-checkpoint",
      contextId: "forged-context",
      revision: 1,
      idempotencyKey: `${tab.id}:checkpoint:1`,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.workflowCheckpoint,
      payload: checkpoint(tab, 1),
    }),
    { code: "WORKFLOW_V2_IDENTITY_MISMATCH" },
  );

  const unsafeTab = { ...newTab("unsafe"), storyStorageRoot: tempRoot };
  await assert.rejects(
    workflow.appendEvidenceManifest({
      tab: unsafeTab,
      revision: 1,
      idempotencyKey: `${unsafeTab.id}:manifest:1`,
      payload: manifest(unsafeTab),
    }),
    { code: "WORKFLOW_V2_PATH_BOUNDARY_REJECTED" },
  );
  assertNoTransientFiles(tab);
});

test("manifest revision 与 checkpoint 独立，gap/旧 revision 被拒绝", async () => {
  const tab = newTab("revision");
  await workflow.appendEvidenceManifest({
    tab,
    revision: 1,
    idempotencyKey: `${tab.id}:manifest:1`,
    payload: manifest(tab, "one"),
  });
  await assert.rejects(
    workflow.appendEvidenceManifest({
      tab,
      revision: 3,
      idempotencyKey: `${tab.id}:manifest:3`,
      payload: manifest(tab, "three"),
    }),
    { code: "WORKFLOW_V2_REVISION_GAP" },
  );
  await assert.rejects(
    workflow.appendEvidenceManifest({
      tab,
      revision: 1,
      idempotencyKey: `${tab.id}:manifest:old`,
      payload: manifest(tab, "old"),
    }),
    { code: "WORKFLOW_V2_STALE_REVISION" },
  );
  const independent = await workflow.appendWorkflowCheckpoint({
    tab,
    revision: 1,
    idempotencyKey: `${tab.id}:checkpoint:1`,
    payload: checkpoint(tab, 1),
  });
  assert.equal(independent.envelope.revision, 1);
  assertNoTransientFiles(tab);
});

test("同 key+同 identity/revision/hash 回放成功，冲突 payload 失败", async () => {
  const tab = newTab("replay");
  const input = {
    tab,
    revision: 1,
    idempotencyKey: `${tab.id}:manifest:1`,
    payload: manifest(tab, "replay"),
  };
  const first = await workflow.appendEvidenceManifest(input);
  const replay = await workflow.appendEvidenceManifest(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.envelope.envelopeSha256, first.envelope.envelopeSha256);

  const conflictPayload = structuredClone(input.payload);
  conflictPayload.items[0].name = "changed";
  await assert.rejects(
    workflow.appendEvidenceManifest({ ...input, payload: conflictPayload }),
    { code: "WORKFLOW_V2_IDEMPOTENCY_CONFLICT" },
  );
  assert.equal((await workflow.readWorkflowV2Envelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest })).length, 1);
  assertNoTransientFiles(tab);
});

test("并发同写只落一份 envelope，另一请求幂等回放", async () => {
  const tab = newTab("concurrent");
  const input = {
    tab,
    revision: 1,
    idempotencyKey: `${tab.id}:manifest:1`,
    payload: manifest(tab, "concurrent"),
  };
  const results = await Promise.all([
    workflow.appendEvidenceManifest(input),
    workflow.appendEvidenceManifest(input),
  ]);
  assert.deepEqual(results.map((entry) => entry.replayed).sort(), [false, true]);
  assert.equal((await workflow.readWorkflowV2Envelopes({ tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest })).length, 1);
  assertNoTransientFiles(tab);
});

test("两个 Gateway 冷启动并发建目录和同写可收敛且无锁/临时文件残留", async () => {
  const tab = newTab("cross-process-cold-start");
  const payload = manifest(tab, "cross-process");
  const startFile = path.join(tempRoot, `workflow-v2-go-${tab.id}`);
  const readyFiles = [
    path.join(tempRoot, `workflow-v2-ready-${tab.id}-1`),
    path.join(tempRoot, `workflow-v2-ready-${tab.id}-2`),
  ];
  const moduleUrl = new URL("../services/devbench/workflow-v2/envelope-store.js", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    const workflow = await import(process.env.WORKFLOW_V2_MODULE_URL);
    fs.writeFileSync(process.env.WORKFLOW_V2_READY_FILE, "ready", "utf8");
    while (!fs.existsSync(process.env.WORKFLOW_V2_START_FILE)) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const result = await workflow.appendEvidenceManifest({
      tab: JSON.parse(process.env.WORKFLOW_V2_TAB),
      revision: 1,
      idempotencyKey: process.env.WORKFLOW_V2_KEY,
      payload: JSON.parse(process.env.WORKFLOW_V2_PAYLOAD),
    });
    process.stdout.write(JSON.stringify({ replayed: result.replayed }));
  `;
  const commonEnv = {
    WORKFLOW_V2_MODULE_URL: moduleUrl,
    WORKFLOW_V2_START_FILE: startFile,
    WORKFLOW_V2_TAB: JSON.stringify(tab),
    WORKFLOW_V2_KEY: `${tab.id}:manifest:1`,
    WORKFLOW_V2_PAYLOAD: JSON.stringify(payload),
  };
  const children = readyFiles.map((readyFile) => spawnWorkflowChild(script, {
    ...commonEnv,
    WORKFLOW_V2_READY_FILE: readyFile,
  }));
  await waitForFiles(readyFiles);
  fs.writeFileSync(startFile, "go", "utf8");
  const results = await Promise.all(children);
  assert.deepEqual(results.map((entry) => entry.replayed).sort(), [false, true]);
  assert.equal((await workflow.readWorkflowV2Envelopes({
    tab,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest,
  })).length, 1);
  assertNoTransientFiles(tab);
});

test("Receipt 绑定 receiptId/operationId/canonical args，READ 允许 payload key=null", async () => {
  const tab = newTab("receipt");
  const original = receipt({ receiptId: "receipt-1", operationId: "operation-1" });
  const args = { rootId: "main", selector: { path: "src/file.txt" } };
  const first = await workflow.appendEvidenceReceipt({
    tab,
    revision: 1,
    idempotencyKey: `${tab.id}:receipt:1`,
    operationArgs: args,
    payload: original,
  });
  assert.equal(first.envelope.payload.idempotencyKey, null);

  const exactReplay = await workflow.appendEvidenceReceipt({
    tab,
    revision: 1,
    idempotencyKey: `${tab.id}:receipt:1`,
    operationArgs: structuredClone(args),
    payload: structuredClone(original),
  });
  assert.equal(exactReplay.replayed, true);

  await assert.rejects(
    workflow.appendEvidenceReceipt({
      tab,
      revision: 2,
      idempotencyKey: `${tab.id}:receipt:1`,
      operationArgs: structuredClone(args),
      payload: receipt({ receiptId: "receipt-same-key-changed", operationId: "operation-1" }),
    }),
    { code: "WORKFLOW_V2_IDEMPOTENCY_CONFLICT" },
  );

  const operationReplay = await workflow.appendEvidenceReceipt({
    tab,
    revision: 2,
    idempotencyKey: `${tab.id}:receipt:retry`,
    operationArgs: structuredClone(args),
    payload: receipt({ receiptId: "receipt-retry", operationId: "operation-1" }),
  });
  assert.equal(operationReplay.replayed, true);
  assert.equal(operationReplay.envelope.recordId, "receipt-1");
  assert.equal(operationReplay.envelope.revision, 1);

  await assert.rejects(
    workflow.appendEvidenceReceipt({
      tab,
      revision: 2,
      idempotencyKey: `${tab.id}:receipt:conflict`,
      operationArgs: { ...args, selector: { path: "other.txt" } },
      payload: receipt({ receiptId: "receipt-other", operationId: "operation-1" }),
    }),
    { code: "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT" },
  );
  const selectorChanged = receipt({ receiptId: "receipt-selector-conflict", operationId: "operation-1" });
  selectorChanged.selector.path = "different-payload-selector.txt";
  await assert.rejects(
    workflow.appendEvidenceReceipt({
      tab,
      revision: 2,
      idempotencyKey: `${tab.id}:receipt:selector-conflict`,
      operationArgs: structuredClone(args),
      payload: selectorChanged,
    }),
    { code: "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT" },
  );
  await assert.rejects(
    workflow.appendEvidenceReceipt({
      tab,
      revision: 2,
      idempotencyKey: `${tab.id}:receipt:null-args`,
      operationArgs: null,
      payload: receipt({ receiptId: "receipt-null-args", operationId: "operation-null-args" }),
    }),
    { code: "WORKFLOW_V2_RECEIPT_ARGS_REQUIRED" },
  );
  await assert.rejects(
    workflow.appendEvidenceReceipt({
      tab,
      revision: 2,
      idempotencyKey: `${tab.id}:receipt:new-operation`,
      operationArgs: { path: "new.txt" },
      payload: receipt({ receiptId: "receipt-1", operationId: "operation-2" }),
    }),
    { code: "WORKFLOW_V2_RECEIPT_APPEND_ONLY_CONFLICT" },
  );
  const untrustedRecordId = await workflow.appendEvidenceReceipt({
    tab,
    revision: 2,
    idempotencyKey: `${tab.id}:receipt:path-safe`,
    operationArgs: { path: "safe.txt" },
    payload: receipt({ receiptId: "../../escape", operationId: "operation-path-safe" }),
  });
  assert.equal(path.basename(untrustedRecordId.path), "000000000002.json");
  assert.match(untrustedRecordId.path.replaceAll("\\", "/"), /\/evidence-receipt\/000000000002\.json$/);
  assert.equal(fs.existsSync(path.join(workflowRoot(tab), "escape")), false);
  assertNoTransientFiles(tab);
});

test("读取时同时执行 envelope/payload Schema 校验与篡改检测", async () => {
  const schemaTab = newTab("schema-tamper");
  const schemaWrite = await workflow.appendEvidenceManifest({
    tab: schemaTab,
    revision: 1,
    idempotencyKey: `${schemaTab.id}:manifest:1`,
    payload: manifest(schemaTab, "schema"),
  });
  const malformed = JSON.parse(fs.readFileSync(schemaWrite.path, "utf8"));
  delete malformed.createdAt;
  fs.writeFileSync(schemaWrite.path, workflow.canonicalJson(malformed), "utf8");
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({ tab: schemaTab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest }),
    { code: "WORKFLOW_V2_SCHEMA_VALIDATION_FAILED" },
  );

  const hashTab = newTab("hash-tamper");
  const hashWrite = await workflow.appendEvidenceManifest({
    tab: hashTab,
    revision: 1,
    idempotencyKey: `${hashTab.id}:manifest:1`,
    payload: manifest(hashTab, "hash"),
  });
  const tampered = JSON.parse(fs.readFileSync(hashWrite.path, "utf8"));
  tampered.payload.items[0].name = "tampered-but-schema-valid";
  fs.writeFileSync(hashWrite.path, workflow.canonicalJson(tampered), "utf8");
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({ tab: hashTab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest }),
    { code: "WORKFLOW_V2_TAMPER_DETECTED" },
  );

  const chainTab = newTab("chain-tamper");
  await workflow.appendEvidenceManifest({
    tab: chainTab,
    revision: 1,
    idempotencyKey: `${chainTab.id}:manifest:1`,
    payload: manifest(chainTab, "chain-one"),
  });
  const chainWrite = await workflow.appendEvidenceManifest({
    tab: chainTab,
    revision: 2,
    idempotencyKey: `${chainTab.id}:manifest:2`,
    payload: manifest(chainTab, "chain-two"),
  });
  const brokenChain = JSON.parse(fs.readFileSync(chainWrite.path, "utf8"));
  brokenChain.previousEnvelopeSha256 = "0".repeat(64);
  const { envelopeSha256: _oldEnvelopeSha256, ...brokenChainUnsigned } = brokenChain;
  brokenChain.envelopeSha256 = workflow.canonicalSha256(brokenChainUnsigned);
  fs.writeFileSync(chainWrite.path, workflow.canonicalJson(brokenChain), "utf8");
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({ tab: chainTab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest }),
    { code: "WORKFLOW_V2_CHAIN_MISMATCH" },
  );

  const utf8Tab = newTab("utf8-tamper");
  const utf8Payload = manifest(utf8Tab, "utf8");
  utf8Payload.items[0].name = "valid-replacement-�-character";
  const utf8Write = await workflow.appendEvidenceManifest({
    tab: utf8Tab,
    revision: 1,
    idempotencyKey: `${utf8Tab.id}:manifest:1`,
    payload: utf8Payload,
  });
  const validBytes = fs.readFileSync(utf8Write.path);
  const replacementBytes = Buffer.from("�", "utf8");
  const replacementOffset = validBytes.indexOf(replacementBytes);
  assert.notEqual(replacementOffset, -1);
  fs.writeFileSync(utf8Write.path, Buffer.concat([
    validBytes.subarray(0, replacementOffset),
    Buffer.from([0xff]),
    validBytes.subarray(replacementOffset + replacementBytes.length),
  ]));
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({ tab: utf8Tab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest }),
    { code: "WORKFLOW_V2_TAMPER_DETECTED" },
  );

  const bomTab = newTab("bom-tamper");
  const bomWrite = await workflow.appendEvidenceManifest({
    tab: bomTab,
    revision: 1,
    idempotencyKey: `${bomTab.id}:manifest:1`,
    payload: manifest(bomTab, "bom"),
  });
  fs.writeFileSync(bomWrite.path, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    fs.readFileSync(bomWrite.path),
  ]));
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({ tab: bomTab, payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.evidenceManifest }),
    { code: "WORKFLOW_V2_TAMPER_DETECTED" },
  );
  assertNoTransientFiles(schemaTab);
  assertNoTransientFiles(hashTab);
  assertNoTransientFiles(chainTab);
  assertNoTransientFiles(utf8Tab);
  assertNoTransientFiles(bomTab);
});

test("M1 模块未被旧 Prompt/状态机/报告链静态 import", () => {
  const gatewayRoot = fileURLToPath(new URL("../", import.meta.url));
  const legacyFiles = [
    "server.js",
    "db/sqlite.js",
    "services/agent-runner.js",
    "services/agent-telemetry.js",
    "services/api-engine.js",
    "services/devbench/index.js",
    "services/devbench/report.js",
  ];
  for (const relative of legacyFiles) {
    const source = fs.readFileSync(path.join(gatewayRoot, relative), "utf8");
    assert.doesNotMatch(source, /workflow-v2\/(?:envelope-store|schema-registry)/, relative);
  }
  const tbWorkflowSource = fs.readFileSync(
    path.join(gatewayRoot, "services/devbench/tb-workflow.js"),
    "utf8",
  );
  const tbWorkflowV2Imports = Array.from(
    tbWorkflowSource.matchAll(/from\s+["']\.\/workflow-v2\/([^"']+)["']/g),
    (match) => match[1],
  ).sort();
  assert.deepEqual(
    tbWorkflowV2Imports,
    ["envelope-store.js", "tb-sync-saga.js"],
    "TB workflow may only use the reviewed M9 Saga and canonical hashing boundary",
  );
});

test("stage-result is a story-wide append-only stream with derived replay identity", async () => {
  const tab = newTab("stage-result-stream");
  const firstContext = stageContext(tab);
  await workflow.appendStageContext({ tab, payload: firstContext });
  const payload = stageResultRecord(tab, 1, firstContext);
  const before = structuredClone(payload);
  const first = await workflow.appendStageResultRecord({ tab, payload });

  assert.deepEqual(payload, before, "append must not mutate the trusted result record");
  assert.equal(first.replayed, false);
  assert.equal(first.envelope.recordId, "stage-result");
  assert.equal(first.envelope.contextId, null);
  assert.equal(first.envelope.revision, 1);
  assert.equal(
    first.envelope.idempotencyKey,
    workflow.deriveStageResultEnvelopeIdempotencyKey(payload),
  );
  assert.match(first.envelope.idempotencyKey, /^stage-result:[a-f0-9]{64}$/);
  assert.notEqual(first.envelope.idempotencyKey, payload.contextIdempotencyKey);
  assert.match(first.path.replaceAll("\\", "/"), /\/stage-result\/000000000001\.json$/);

  const replay = await workflow.appendStageResultRecord({ tab, payload: structuredClone(payload) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.envelope.envelopeSha256, first.envelope.envelopeSha256);

  const conflict = structuredClone(payload);
  conflict.result.userSummary = "different valid result";
  conflict.resultSha256 = workflow.canonicalSha256(conflict.result);
  assert.equal(
    workflow.deriveStageResultEnvelopeIdempotencyKey(conflict),
    first.envelope.idempotencyKey,
    "result bytes are deliberately excluded from the envelope replay identity",
  );
  await assert.rejects(
    workflow.appendStageResultRecord({ tab, payload: conflict }),
    { code: "WORKFLOW_V2_IDEMPOTENCY_CONFLICT" },
  );

  const secondContext = stageContext(tab, 2);
  await workflow.appendStageContext({ tab, payload: secondContext });
  const second = stageResultRecord(tab, 2, secondContext);
  const secondWrite = await workflow.appendStageResultRecord({ tab, payload: second });
  assert.equal(secondWrite.envelope.revision, 2);
  assert.equal((await workflow.readWorkflowV2Envelopes({
    tab,
    payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
  })).length, 2);

  await assert.rejects(
    workflow.appendStageResultRecord({ tab, payload: stageResultRecord(tab, 4, secondContext) }),
    { code: "WORKFLOW_V2_REVISION_GAP" },
  );
  const forgedContextKey = stageResultRecord(tab, 3, secondContext);
  forgedContextKey.contextIdempotencyKey = "forged-context-key";
  forgedContextKey.result.idempotencyKey = forgedContextKey.contextIdempotencyKey;
  forgedContextKey.resultSha256 = workflow.canonicalSha256(forgedContextKey.result);
  await assert.rejects(
    workflow.appendStageResultRecord({ tab, payload: forgedContextKey }),
    { code: "WORKFLOW_V2_IDENTITY_MISMATCH" },
  );
  const wrongStory = stageResultRecord(tab, 3, secondContext);
  wrongStory.storyId = "another-story";
  await assert.rejects(
    workflow.appendStageResultRecord({ tab, payload: wrongStory }),
    { code: "WORKFLOW_V2_IDENTITY_MISMATCH" },
  );

  const missingContextTab = newTab("stage-result-missing-context");
  await assert.rejects(
    workflow.appendStageResultRecord({
      tab: missingContextTab,
      payload: stageResultRecord(missingContextTab),
    }),
    { code: "WORKFLOW_V2_STAGE_CONTEXT_NOT_FOUND" },
  );

  const reservedNamespaceTab = newTab("stage-result-reserved-namespace");
  const reservedContext = stageContext(reservedNamespaceTab);
  reservedContext.idempotencyKey = `stage-result:${"a".repeat(64)}`;
  await assert.rejects(
    workflow.appendStageContext({ tab: reservedNamespaceTab, payload: reservedContext }),
    { code: "WORKFLOW_V2_IDEMPOTENCY_NAMESPACE_RESERVED" },
  );
  assertNoTransientFiles(tab);
  assertNoTransientFiles(missingContextTab);
  assertNoTransientFiles(reservedNamespaceTab);
});

test("stage-result read revalidates nested AJV schema, identity, and result hash", async () => {
  const schemaTab = newTab("stage-result-nested-schema-tamper");
  const schemaContext = stageContext(schemaTab);
  await workflow.appendStageContext({ tab: schemaTab, payload: schemaContext });
  const schemaWrite = await workflow.appendStageResultRecord({
    tab: schemaTab,
    payload: stageResultRecord(schemaTab, 1, schemaContext),
  });
  rewriteEnvelope(schemaWrite.path, (payload) => {
    delete payload.result.userSummary;
    payload.resultSha256 = workflow.canonicalSha256(payload.result);
  });
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({
      tab: schemaTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    }),
    { code: "WORKFLOW_V2_SCHEMA_VALIDATION_FAILED" },
  );

  const identityTab = newTab("stage-result-identity-tamper");
  const identityContext = stageContext(identityTab);
  await workflow.appendStageContext({ tab: identityTab, payload: identityContext });
  const identityWrite = await workflow.appendStageResultRecord({
    tab: identityTab,
    payload: stageResultRecord(identityTab, 1, identityContext),
  });
  rewriteEnvelope(identityWrite.path, (payload) => {
    payload.result.contextRevision += 1;
    payload.resultSha256 = workflow.canonicalSha256(payload.result);
  });
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({
      tab: identityTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    }),
    { code: "WORKFLOW_V2_IDENTITY_MISMATCH" },
  );

  const hashTab = newTab("stage-result-hash-tamper");
  const hashContext = stageContext(hashTab);
  await workflow.appendStageContext({ tab: hashTab, payload: hashContext });
  const hashWrite = await workflow.appendStageResultRecord({
    tab: hashTab,
    payload: stageResultRecord(hashTab, 1, hashContext),
  });
  rewriteEnvelope(hashWrite.path, (payload) => {
    payload.result.userSummary = "tampered but valid";
  });
  await assert.rejects(
    workflow.readWorkflowV2Envelopes({
      tab: hashTab,
      payloadSchemaId: WORKFLOW_V2_SCHEMA_IDS.stageResultRecord,
    }),
    { code: "WORKFLOW_V2_TAMPER_DETECTED" },
  );

  assertNoTransientFiles(schemaTab);
  assertNoTransientFiles(identityTab);
  assertNoTransientFiles(hashTab);
});
