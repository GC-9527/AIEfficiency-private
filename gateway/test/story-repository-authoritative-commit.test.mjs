import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StoryRepositoryController } from "../services/devbench/story-repository-controller.js";
import { independentStoryRepositoryPath } from "../services/devbench/git-controller/story-repository.js";
import { validateControllerCommand } from "../services/devbench/git-controller-process-protocol.js";
import { deriveWorkflowV2EditState } from "../services/devbench/workflow-v2/edit-state-binding.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "m8g-"));
let harnessSequence = 0;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function canonicalSha(value) {
  const stable = (input) => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function createJournal() {
  const operations = new Map();
  const idempotency = new Map();
  const rows = new Map();
  const persistence = {
    listGitControllerJournal(operationId) {
      return rows.get(operationId) || [];
    },
    getGitControllerRepositoryLease() {
      return null;
    },
    listGitControllerRecoverableOperations() {
      return [...operations.values()].filter((operation) => (
        operation.status === "RUNNING" || operation.status === "RECOVERY_REQUIRED"
      ));
    },
  };
  const journal = {
    persistence,
    begin(input) {
      const key = `${input.repositoryId}\0${input.operationType}\0${input.idempotencyKey}`;
      if (idempotency.has(key)) {
        return { created: false, operation: idempotency.get(key) };
      }
      const operation = {
        ...input,
        operationId: randomUUID(),
        status: "RUNNING",
        phase: "PREVIEWED",
        result: null,
        startedAt: Date.now(),
      };
      operations.set(operation.operationId, operation);
      idempotency.set(key, operation);
      rows.set(operation.operationId, [{ phase: "PREVIEWED", data: {} }]);
      return { created: true, operation };
    },
    append(operation, phase, data, fencingToken) {
      operation.phase = phase;
      operation.fencingToken = fencingToken;
      rows.get(operation.operationId).push({ phase, data, fencingToken });
      return operation;
    },
    succeed(operation, result, fencingToken) {
      this.append(operation, "VERIFIED", { resultCode: result.resultCode }, fencingToken);
      operation.status = "SUCCEEDED";
      operation.result = result;
      return operation;
    },
    fail(operation, error, { fencingToken = null, recoveryRequired = false } = {}) {
      operation.status = recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED";
      operation.phase = recoveryRequired ? "RECOVERY_REQUIRED" : "FAILED";
      operation.error = { code: error.code, message: error.message, details: error.details || {} };
      operation.fencingToken = fencingToken;
      return operation;
    },
  };
  return { journal, operations };
}

function createHarness({
  targetFlavor = "prod",
  faultInjector = null,
  withFlavorCatalog = false,
} = {}) {
  harnessSequence += 1;
  const storyRoot = path.join(tempRoot, `s${harnessSequence}`);
  const tabId = `story-${harnessSequence}`;
  const repositoryId = `repo-${harnessSequence}`;
  const repositoryPath = independentStoryRepositoryPath(storyRoot, tabId, repositoryId);
  fs.mkdirSync(repositoryPath, { recursive: true });
  git(repositoryPath, ["init", "-q", "-b", "story/fix"]);
  git(repositoryPath, ["config", "user.name", "Test"]);
  git(repositoryPath, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "base\n", "utf8");
  if (withFlavorCatalog) {
    fs.writeFileSync(
      path.join(repositoryPath, "flavorConfig.json"),
      `${JSON.stringify({ prod: {}, stg: {} })}\n`,
      "utf8",
    );
  }
  git(repositoryPath, ["add", "README.md", ...(withFlavorCatalog ? ["flavorConfig.json"] : [])]);
  git(repositoryPath, ["commit", "-q", "-m", "chore: 初始化"]);
  const expectedHead = git(repositoryPath, ["rev-parse", "HEAD"]);
  const hooks = path.join(storyRoot, "disabled-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const { journal } = createJournal();
  let fence = 0;
  const audits = [];
  const row = {
    storyId: tabId,
    repositoryId,
    repositoryPath,
    headRevision: expectedHead,
    branch: "story/fix",
  };
  const entry = { repositoryId, lockPath: path.join(storyRoot, "lock") };
  const controller = {
    registry: {
      get(id) {
        assert.equal(id, repositoryId);
        return entry;
      },
      async verify(id) {
        assert.equal(id, repositoryId);
        return true;
      },
    },
    leaseManager: {
      acquire() {
        fence += 1;
        return {
          fencingToken: fence,
          assertCurrent() { return true; },
          release() {},
        };
      },
    },
    journal,
    audit: { write(value) { audits.push(value); } },
  };
  const instance = Object.create(StoryRepositoryController.prototype);
  Object.assign(instance, {
    controller,
    storyRoot,
    dataRoot: storyRoot,
    gitBinary: "git",
    disabledHooksPath: hooks,
    gitSpawnGuard: null,
    faultInjector,
    requiredCheckVerifier: async ({ receiptIds }) => ({
      ok: true,
      verifiedReceiptIds: [...receiptIds],
      evidenceDigest: "a".repeat(64),
    }),
    flavorPolicyResolver: async () => ({
      catalog: [targetFlavor, "stg"],
      sourceSets: {
        main: "app/src/main",
        [targetFlavor]: `app/src/${targetFlavor}`,
        stg: "app/src/stg",
      },
    }),
  });
  instance.registryEntry = (story, repository) => (
    story === tabId && repository === repositoryId ? row : null
  );
  instance.updateMetadata = async (_story, _repository, patch) => {
    Object.assign(row, patch);
    return row;
  };
  const request = (overrides = {}) => ({
    tabId,
    repositoryId,
    operationId: `commit-${randomUUID()}`,
    expectedHead,
    expectedBranch: "story/fix",
    targetFlavor,
    changeSummary: "修复目标功能并补充回归保护",
    declaredChanges: ["app/src/prod/Feature.kt"],
    requiredCheckReceiptIds: ["receipt-build", "receipt-test"],
    ...overrides,
  });
  return { instance, repositoryPath, expectedHead, request, row, audits, journal };
}

function writeChange(harness, relativePath = "app/src/prod/Feature.kt", content = "fixed\n") {
  const target = path.join(harness.repositoryPath, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

before(() => {
  process.env.NODE_ENV = "test";
});

test("process protocol 精确允许并规范化 story.repository.commit payload", () => {
  const payload = {
    tabId: "story-1",
    repositoryId: "repo-1",
    operationId: "attempt-1",
    expectedHead: "a".repeat(40),
    expectedBranch: "story/fix",
    targetFlavor: "prod",
    changeSummary: "修复目标功能",
    declaredChanges: ["b.txt", "a.txt"],
    requiredCheckReceiptIds: ["receipt-test", "receipt-build"],
  };
  const validated = validateControllerCommand("story.repository.commit", payload);
  assert.deepEqual(validated.payload.declaredChanges, ["a.txt", "b.txt"]);
  assert.deepEqual(validated.payload.requiredCheckReceiptIds, ["receipt-build", "receipt-test"]);
  assert.throws(
    () => validateControllerCommand("story.repository.commit", { ...payload, noVerify: true }),
    (error) => error.code === "GIT_CONTROLLER_COMMAND_FIELD_REJECTED",
  );
  assert.throws(
    () => validateControllerCommand("story.repository.commit", { ...payload, declaredChanges: ["../escape"] }),
    (error) => error.code === "GIT_CONTROLLER_COMMAND_FIELD_INVALID",
  );
});

test("production Controller rejects an injected required-check verifier", async () => {
  const h = createHarness();
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      h.instance.verifyCommitRequiredChecks(h.request()),
      (error) => error.code === "STORY_REPOSITORY_CHECK_VERIFIER_OVERRIDE_FORBIDDEN",
    );
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

test("wrong HEAD/branch、undeclared change、missing checks 与其它 Flavor 全部 fail closed", async () => {
  {
    const h = createHarness();
    writeChange(h);
    await assert.rejects(
      h.instance.commit(h.request({ declaredChanges: ["../escape"] })),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_PATH_INVALID",
    );
  }
  {
    const h = createHarness();
    writeChange(h);
    await assert.rejects(
      h.instance.commit(h.request({ expectedHead: "b".repeat(40) })),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_HEAD_MISMATCH",
    );
  }
  {
    const h = createHarness();
    writeChange(h);
    await assert.rejects(
      h.instance.commit(h.request({ expectedBranch: "story/other" })),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_BRANCH_MISMATCH",
    );
  }
  {
    const h = createHarness();
    writeChange(h);
    fs.writeFileSync(path.join(h.repositoryPath, "undeclared.txt"), "x", "utf8");
    await assert.rejects(
      h.instance.commit(h.request()),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_UNDECLARED_CHANGE",
    );
  }
  {
    const h = createHarness();
    writeChange(h);
    await assert.rejects(
      h.instance.commit(h.request({ requiredCheckReceiptIds: [] })),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_REQUEST_INVALID",
    );
  }
  {
    const h = createHarness();
    writeChange(h, "app/src/stg/Other.kt");
    await assert.rejects(
      h.instance.commit(h.request({ declaredChanges: ["app/src/stg/Other.kt"] })),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_OTHER_FLAVOR_CHANGED",
    );
  }
});

test("生产默认 Flavor resolver 空 catalog fail closed，公共 main 无可信审批也阻断", async () => {
  {
    const h = createHarness();
    h.instance.flavorPolicyResolver = null;
    fs.writeFileSync(path.join(h.repositoryPath, "notes.txt"), "change", "utf8");
    await assert.rejects(
      h.instance.commit(h.request({ declaredChanges: ["notes.txt"] })),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_FLAVOR_CATALOG_REQUIRED",
    );
  }
  {
    const h = createHarness();
    writeChange(h, "app/src/main/Common.kt");
    await assert.rejects(
      h.instance.commit(h.request({ declaredChanges: ["app/src/main/Common.kt"] })),
      (error) => error.code === "STORY_REPOSITORY_COMMIT_MAIN_IMPACT_APPROVAL_REQUIRED",
    );
  }
  {
    const h = createHarness({ withFlavorCatalog: true });
    h.instance.flavorPolicyResolver = null;
    writeChange(h);
    const result = await h.instance.commit(h.request());
    assert.equal(result.ok, true, "标准 src/prod 目录可由 Controller 自行解析为非空 catalog");
  }
});

test("生产默认 required-check verifier 从 Controller 可读 hash-chain receipt 与输出哈希验真", async () => {
  const h = createHarness();
  h.instance.requiredCheckVerifier = null;
  writeChange(h);
  const evidenceRoot = path.join(tempRoot, `e${++harnessSequence}`);
  h.instance.workflowEvidenceRoot = evidenceRoot;
  const storyDirectory = path.join(evidenceRoot, "story-doc");
  const receiptDirectory = path.join(
    storyDirectory,
    "workflow-v2",
    "envelopes",
    "evidence-receipt",
  );
  const outputDirectory = path.join(storyDirectory, "workflow-v2", "evidence-blobs");
  fs.mkdirSync(receiptDirectory, { recursive: true });
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, "build.blob");
  fs.writeFileSync(outputPath, "trusted build output", "utf8");
  const relativeChange = "app/src/prod/Feature.kt";
  const changedPath = path.join(h.repositoryPath, ...relativeChange.split("/"));
  const changedSha = createHash("sha256").update(fs.readFileSync(changedPath)).digest("hex");
  const envelopes = [];
  const appendEnvelope = (payload) => {
    const revision = envelopes.length + 1;
    const unsigned = {
      storyId: h.request().tabId,
      recordId: payload.receiptId,
      contextId: null,
      revision,
      idempotencyKey: payload.idempotencyKey,
      payloadSchemaId: "https://example.local/schemas/evidence-receipt-v2.json",
      payloadSha256: canonicalSha(payload),
      operationArgsSha256: "b".repeat(64),
      previousEnvelopeSha256: envelopes.at(-1)?.envelopeSha256 || null,
      createdAt: Date.now(),
      payload,
    };
    const envelope = { ...unsigned, envelopeSha256: canonicalSha(unsigned) };
    envelopes.push(envelope);
    fs.writeFileSync(
      path.join(receiptDirectory, `${String(revision).padStart(12, "0")}.json`),
      `${JSON.stringify(envelope)}\n`,
      "utf8",
    );
    return envelope;
  };
  appendEnvelope({
    receiptId: "receipt-edit",
    operationId: "edit-operation",
    idempotencyKey: "edit-key",
    action: "EDIT",
    status: "PASS",
    rootId: "main",
    selector: {
      contextId: "context-controller-commit",
      contextRevision: 1,
      path: relativeChange,
      beforeExists: false,
      beforeSha256: null,
      afterExists: true,
      afterSha256: changedSha,
    },
    startedAt: "2026-08-08T00:59:00.000Z",
    finishedAt: "2026-08-08T00:59:01.000Z",
  });
  const editState = deriveWorkflowV2EditState({
    envelopes,
    storyId: h.request().tabId,
    contextId: "context-controller-commit",
    contextRevision: 1,
    rootId: "main",
    requireChanges: true,
  });
  const payload = {
    receiptId: "receipt-build",
    operationId: "build-operation",
    idempotencyKey: "build-key",
    action: "BUILD",
    status: "PASS",
    rootId: "main",
    selector: {
      contextId: "context-controller-commit",
      contextRevision: 1,
      editStateSha256: editState.editStateSha256,
      editStateVersionSha256: editState.editStateVersionSha256,
    },
    startedAt: "2026-08-08T01:00:00.000Z",
    finishedAt: "2026-08-08T01:01:00.000Z",
    outputRef: "storydev:/workflow-v2/evidence-blobs/build.blob",
    sha256: createHash("sha256").update(fs.readFileSync(outputPath)).digest("hex"),
  };
  appendEnvelope(payload);
  const request = h.request({ requiredCheckReceiptIds: ["receipt-build"] });
  const evidence = await h.instance.verifyCommitRequiredChecks(request);
  assert.deepEqual(evidence.receiptIds, ["receipt-build"]);
  assert.equal(evidence.editStateSha256, editState.editStateSha256);
  git(h.repositoryPath, ["add", "--", relativeChange]);
  h.instance.verifyStagedCommitEditState(request, evidence.editState);
  git(h.repositoryPath, ["reset", "-q", "HEAD", "--", relativeChange]);
  fs.writeFileSync(outputPath, "tampered", "utf8");
  await assert.rejects(
    h.instance.verifyCommitRequiredChecks(request),
    (error) => error.code === "STORY_REPOSITORY_COMMIT_REQUIRED_CHECK_FAILED",
  );
  fs.writeFileSync(outputPath, "trusted build output", "utf8");

  fs.writeFileSync(changedPath, "changed after checks\n", "utf8");
  const secondSha = createHash("sha256").update(fs.readFileSync(changedPath)).digest("hex");
  appendEnvelope({
    receiptId: "receipt-edit-second",
    operationId: "edit-operation-second",
    idempotencyKey: "edit-key-second",
    action: "EDIT",
    status: "PASS",
    rootId: "main",
    selector: {
      contextId: "context-controller-commit",
      contextRevision: 1,
      path: relativeChange,
      beforeExists: true,
      beforeSha256: changedSha,
      afterExists: true,
      afterSha256: secondSha,
    },
    startedAt: "2026-08-08T01:02:00.000Z",
    finishedAt: "2026-08-08T01:02:01.000Z",
  });
  await assert.rejects(
    h.instance.commit(request),
    (error) => error.code === "STORY_REPOSITORY_COMMIT_REQUIRED_CHECK_FAILED",
    "direct Controller call must not bypass stale check/edit-state verification",
  );
  assert.equal(git(h.repositoryPath, ["rev-parse", "HEAD"]), h.expectedHead);
});

test("Controller 只 stage 精确路径、禁用 hooks，并回读 SHA 与中文 Conventional message", async () => {
  const h = createHarness();
  writeChange(h);
  const hook = path.join(h.repositoryPath, ".git", "hooks", "commit-msg");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 91\n", "utf8");
  fs.chmodSync(hook, 0o755);
  const result = await h.instance.commit(h.request());
  assert.equal(result.ok, true);
  assert.equal(result.beforeSha, h.expectedHead);
  assert.match(result.commitSha, /^[0-9a-f]{40}$/);
  assert.match(result.message, /^fix\([a-z0-9-]+\): .*?[\u3400-\u9fff]/u);
  assert.ok(result.message.includes(`操作标识: ${result.operationId}`));
  assert.deepEqual(result.changedPaths, ["app/src/prod/Feature.kt"]);
  assert.deepEqual(result.requiredCheckReceiptIds, ["receipt-build", "receipt-test"]);
  assert.deepEqual(result.dirtyAfterCommit, []);
  assert.equal(git(h.repositoryPath, ["rev-parse", "HEAD"]), result.commitSha);
  assert.equal(git(h.repositoryPath, ["show", "-s", "--format=%B", result.commitSha]), result.message);
  assert.equal(h.audits.length, 1);
});

test("同 operationId 同绑定重放原结果，异绑定冲突", async () => {
  const h = createHarness();
  writeChange(h);
  const payload = h.request();
  const first = await h.instance.commit(payload);
  const replayed = await h.instance.commit(payload);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.commitSha, first.commitSha);
  await assert.rejects(
    h.instance.commit({ ...payload, changeSummary: "修复另一个完全不同的问题" }),
    (error) => error.code === "GIT_CONTROLLER_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(git(h.repositoryPath, ["rev-list", "--count", "HEAD"]), "2");
});

test("commit 后 journal 前崩溃可按 operationId 归因恢复且不二次提交", async () => {
  let injected = false;
  const h = createHarness({
    faultInjector: async (phase) => {
      if (phase === "after-story-repository-commit" && !injected) {
        injected = true;
        const error = new Error("simulated crash after commit");
        error.code = "TEST_CRASH_AFTER_COMMIT";
        throw error;
      }
    },
  });
  writeChange(h);
  const payload = h.request();
  await assert.rejects(
    h.instance.commit(payload),
    (error) => error.code === "TEST_CRASH_AFTER_COMMIT",
  );
  const committedSha = git(h.repositoryPath, ["rev-parse", "HEAD"]);
  const recovered = await h.instance.commit(payload);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.commitSha, committedSha);
  assert.equal(git(h.repositoryPath, ["rev-list", "--count", "HEAD"]), "2");
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
