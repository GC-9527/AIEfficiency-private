import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "../services/devbench/workflow-v2/schema-registry.js";
import { buildTrustedStageExecution } from "../services/devbench/workflow-v2/trusted-execution-profile.js";
import { buildVerificationEvidenceContract } from "../services/devbench/workflow-v2/verification-evidence-contract.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots = [{ rootId: "main", kind: "MAIN" }];
const tab = { id: "story-plan-001" };

function executor(executorId, action, overrides = {}) {
  if (["BUILD", "TEST"].includes(action)) {
    return {
      executorId,
      action,
      argv: ["npm", "test", "--", "--runInBand"],
      cwdRootId: "main",
      timeoutMs: 120_000,
      ...overrides,
    };
  }
  return {
    executorId,
    action,
    adapterId: `builtin.${action.toLowerCase()}`,
    cwdRootId: "main",
    timeoutMs: 120_000,
    ...overrides,
  };
}

function verifyCase(caseId, executorId, overrides = {}) {
  return {
    caseId,
    title: `执行 ${caseId}`,
    mandatory: true,
    executorId,
    requirements: ["可信配置覆盖"],
    target: { environment: "local" },
    preconditions: [],
    steps: ["执行冻结 executor"],
    assertions: ["退出状态为 PASS"],
    evidenceRequirements: ["receipt"],
    cleanup: [],
    failureDiagnostics: [],
    ...overrides,
  };
}

function configFor(stageId, stage) {
  return {
    workflowV2: {
      activeExecutionProfileId: "profile-main",
      executionProfiles: [{
        profileId: "profile-main",
        rootId: "main",
        stages: { [stageId]: stage },
      }],
    },
  };
}

function build(config, stageId) {
  return buildTrustedStageExecution({
    config,
    tab,
    stageId,
    roots,
    deviceProfile: { profileId: "device-profile-1" },
    flavorProfile: { flavor: "demoRelease", buildType: "release" },
  });
}

test("verification-plan schema 已注册，runtime 与 Phase2 package 镜像一致", () => {
  assert.equal(workflowV2SchemaRegistry.has(WORKFLOW_V2_SCHEMA_IDS.verificationPlan), true);
  const runtime = fs.readFileSync(path.join(
    repositoryRoot,
    "gateway/services/devbench/workflow-v2/schemas/verification-plan.schema.json",
  ), "utf8");
  const packaged = fs.readFileSync(path.join(
    repositoryRoot,
    "features/StoryDev/工作流/AI修复工作流/stepplan0/TB_AI_Workflow_Phase2_Optimization/schemas/verification-plan.schema.json",
  ), "utf8");
  assert.deepEqual(JSON.parse(runtime), JSON.parse(packaged));
});

test("Phase2 verification-plan example 同时通过 Schema 与 mandatory evidence 语义合同", () => {
  const example = JSON.parse(fs.readFileSync(path.join(
    repositoryRoot,
    "features/StoryDev/工作流/AI修复工作流/stepplan0/TB_AI_Workflow_Phase2_Optimization/examples/verification-plan.example.json",
  ), "utf8"));
  assert.equal(workflowV2SchemaRegistry.validate(
    WORKFLOW_V2_SCHEMA_IDS.verificationPlan,
    example,
  ).valid, true);
  const contract = buildVerificationEvidenceContract(example);
  assert.equal(contract.ok, true, contract.reason);
  assert.deepEqual([...contract.mandatoryCapabilities], ["BUILD", "CAPTURE", "DEVICE_ACTION"]);
  const captureCase = example.cases.find((entry) => entry.action === "CAPTURE");
  assert.ok(captureCase);
  assert.deepEqual(
    contract.casesById.get(captureCase.caseId).materialRequirements.map((entry) => entry.requirement),
    ["video", "screenshot", "logcat"],
  );
  assert.match(captureCase.requirements.join("\n"), /不复用为材料回执/);
});

test("缺少或歧义 execution profile 时生成可校验 BLOCKED metadata", () => {
  const missing = build({ workflowV2: {} }, "VERIFY_EXECUTE");
  assert.equal(missing.status, "BLOCKED");
  assert.equal(missing.executionProfile, null);
  assert.equal(missing.verificationPlan.status, "BLOCKED");
  assert.equal(missing.verificationPlan.cases.length, 0);
  assert.equal(missing.blockers.length, 1);
  assert.equal(workflowV2SchemaRegistry.validate(
    WORKFLOW_V2_SCHEMA_IDS.verificationPlan,
    missing.verificationPlan,
  ).valid, true);

  const ambiguousProfile = {
    profileId: "duplicate",
    rootId: "main",
    stages: { VERIFY_EXECUTE: { executors: [], cases: [] } },
  };
  const ambiguous = build({
    workflowV2: { executionProfiles: [ambiguousProfile, structuredClone(ambiguousProfile)] },
  }, "VERIFY_EXECUTE");
  assert.equal(ambiguous.status, "BLOCKED");
  assert.match(ambiguous.blockers[0], /不唯一/);
});

test("VERIFY 从可信 profile 确定生成 plan，并且 Prompt 计划不泄漏 argv", () => {
  const stage = {
    executors: [
      executor("build-release", "BUILD", { argv: ["gradlew.bat", "assembleDemoRelease"] }),
      executor("device-smoke", "DEVICE_ACTION"),
    ],
    cases: [
      verifyCase("case-build", "build-release"),
      verifyCase("case-device", "device-smoke"),
    ],
  };
  const config = configFor("VERIFY_EXECUTE", stage);
  const first = build(config, "VERIFY_EXECUTE");
  const second = build(structuredClone(config), "VERIFY_EXECUTE");
  assert.equal(first.status, "READY");
  assert.equal(first.verificationPlan.planId, second.verificationPlan.planId);
  assert.equal(first.verificationPlan.profileId, "profile-main");
  assert.deepEqual(first.verificationPlan.storyIds, [tab.id]);
  assert.deepEqual(first.verificationPlan.mandatoryCapabilities, ["BUILD", "DEVICE_ACTION"]);
  assert.equal(first.verificationPlan.cases.every((entry) => entry.storyIds[0] === tab.id), true);
  assert.equal(first.verificationPlan.cases.every((entry) => entry.executorId && entry.action), true);
  assert.equal(JSON.stringify(first.verificationPlan).includes("assembleDemoRelease"), false);
  assert.equal(first.executionProfile.executors[0].argv.includes("assembleDemoRelease"), true);
  assert.equal(workflowV2SchemaRegistry.validate(
    WORKFLOW_V2_SCHEMA_IDS.verificationPlan,
    first.verificationPlan,
  ).valid, true);

  const drifted = structuredClone(config);
  drifted.workflowV2.executionProfiles[0].stages.VERIFY_EXECUTE.executors[0].argv[1] = "assembleOtherRelease";
  assert.notEqual(build(drifted, "VERIFY_EXECUTE").verificationPlan.planId, first.verificationPlan.planId);
});

test("REPAIR 只冻结 mandatory BUILD/TEST localChecks", () => {
  const ready = build(configFor("REPAIR", {
    executors: [executor("unit-test", "TEST")],
    localChecks: [{ checkId: "unit", executorId: "unit-test", mandatory: true, rootId: "main" }],
  }), "REPAIR");
  assert.equal(ready.status, "READY");
  assert.deepEqual(ready.localChecks, [{
    checkId: "unit",
    name: "unit",
    executorId: "unit-test",
    action: "TEST",
    mandatory: true,
    rootId: "main",
  }]);

  const optionalOnly = build(configFor("REPAIR", {
    executors: [executor("unit-test", "TEST")],
    localChecks: [{ checkId: "unit", executorId: "unit-test", mandatory: false }],
  }), "REPAIR");
  assert.equal(optionalOnly.status, "BLOCKED");
  assert.match(optionalOnly.blockers[0], /mandatory BUILD\/TEST/);
});

test("不可信字段、重复 caseId、未注册 executor 都 fail closed", () => {
  const commandProfile = build(configFor("VERIFY_EXECUTE", {
    executors: [{ ...executor("build", "BUILD"), command: "npm test" }],
    cases: [verifyCase("case-build", "build")],
  }), "VERIFY_EXECUTE");
  assert.equal(commandProfile.status, "BLOCKED");
  assert.match(commandProfile.blockers[0], /command/);

  const duplicateCase = build(configFor("VERIFY_EXECUTE", {
    executors: [executor("build", "BUILD")],
    cases: [verifyCase("case-build", "build"), verifyCase("case-build", "build")],
  }), "VERIFY_EXECUTE");
  assert.equal(duplicateCase.status, "BLOCKED");
  assert.match(duplicateCase.blockers[0], /重复 caseId/);

  const unknownExecutor = build(configFor("VERIFY_EXECUTE", {
    executors: [executor("build", "BUILD")],
    cases: [verifyCase("case-build", "missing")],
  }), "VERIFY_EXECUTE");
  assert.equal(unknownExecutor.status, "BLOCKED");
  assert.match(unknownExecutor.blockers[0], /未绑定可信 executor/);

  const unknownEvidenceRequirement = build(configFor("VERIFY_EXECUTE", {
    executors: [executor("device", "DEVICE_ACTION")],
    cases: [verifyCase("case-device", "device", {
      evidenceRequirements: ["operator says evidence exists"],
    })],
  }), "VERIFY_EXECUTE");
  assert.equal(unknownEvidenceRequirement.status, "BLOCKED");
  assert.match(unknownEvidenceRequirement.blockers[0], /evidenceRequirement 无可信映射/);
});

test("schema 单独拒绝缺 executor、重复 story 和 READY 空 cases", () => {
  const base = {
    schemaVersion: "verification-plan-v2",
    planId: "plan-1",
    profileId: "profile-main",
    status: "READY",
    storyIds: [tab.id],
    mandatoryCapabilities: ["BUILD"],
    blockers: [],
    cases: [{
      caseId: "case-1",
      title: "build",
      storyIds: [tab.id],
      mandatory: true,
      executorId: "build",
      action: "BUILD",
      requirements: [],
      target: { rootId: "main", flavor: null, buildType: null, deviceProfileId: null, environment: null },
      steps: ["run"],
      assertions: ["pass"],
      evidenceRequirements: [],
      cleanup: [],
    }],
  };
  assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.verificationPlan, base).valid, true);
  const missingExecutor = structuredClone(base);
  delete missingExecutor.cases[0].executorId;
  assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.verificationPlan, missingExecutor).valid, false);
  const duplicateStory = structuredClone(base);
  duplicateStory.storyIds.push(tab.id);
  assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.verificationPlan, duplicateStory).valid, false);
  const emptyReady = structuredClone(base);
  emptyReady.cases = [];
  assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.verificationPlan, emptyReady).valid, false);
});
