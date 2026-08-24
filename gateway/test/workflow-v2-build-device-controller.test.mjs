import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createWorkflowV2BuildController,
  WORKFLOW_V2_BUILD_EXECUTOR_ATTESTATION,
} from "../services/devbench/workflow-v2/build-controller.js";
import {
  WORKFLOW_V2_SCHEMA_IDS,
  workflowV2SchemaRegistry,
} from "../services/devbench/workflow-v2/schema-registry.js";
import {
  createStoryLeaseDeviceProxy,
  freezeStoryDeviceLeaseContext,
  WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION,
} from "../services/devbench/device-operation-guard-service.js";

let tempRoot;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function buildFixture() {
  const repositoryPath = path.join(tempRoot, `repo-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(repositoryPath, { recursive: true });
  git(["init", "-q", "-b", "main"], repositoryPath);
  git(["config", "user.email", "test@example.com"], repositoryPath);
  git(["config", "user.name", "Test"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "flavorConfig.json"), JSON.stringify({
    demo: { versionName: "1.2.30", versionCode: 10230 },
  }), "utf8");
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n", "utf8");
  git(["add", "flavorConfig.json", "README.md"], repositoryPath);
  git(["commit", "-q", "-m", "chore: 初始化测试仓库"], repositoryPath);
  const tab = {
    id: "story-build-1",
    primaryProjectId: "repo-main",
    flavors: [{ path: repositoryPath, flavor: "demo" }],
  };
  const storyStore = {
    getTab: () => tab,
    tabProjectPaths: () => [{ path: repositoryPath, role: "primary", name: "Main" }],
    getTabFlavor: (story, targetPath) => story.flavors.find((entry) => path.resolve(entry.path) === path.resolve(targetPath))?.flavor || null,
    getAndroidFlavors: () => ({ isAndroid: true, flavors: ["demo"], buildVariants: ["demo"] }),
    expandAndroidBuildFlavors: (_targetPath, flavors) => flavors,
    readProjectVersion: () => ({ ok: true, versionName: "1.2.30", versionCode: 10230 }),
  };
  return { repositoryPath, tab, storyStore };
}

function trustedBuildBroker(repositoryPath, calls, mutateResult = null) {
  return {
    async attest(input) {
      calls.attest += 1;
      return {
        ok: true,
        kind: WORKFLOW_V2_BUILD_EXECUTOR_ATTESTATION,
        rootId: input.rootId,
        repositoryId: input.repositoryId,
      };
    },
    async execute(input) {
      calls.execute += 1;
      calls.input = input;
      const artifactPath = path.join(repositoryPath, "app", "build", "outputs", "apk", "demo", "release", "app-demo-release.apk");
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, `apk-for-${input.head}`, "utf8");
      const sha256 = await import("node:crypto").then(({ createHash }) => (
        createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex")
      ));
      const result = {
        exitCode: 0,
        artifactPath,
        provenance: {
          head: input.head,
          task: input.task,
          flavor: input.flavor,
          buildType: input.buildType,
          versionName: input.version.versionName,
          versionCode: input.version.versionCode,
          artifactSha256: sha256,
        },
      };
      return mutateResult ? mutateResult(result, input) : result;
    },
  };
}

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-build-device-"));
});

describe("M8 Build Controller", () => {
  it("只用故事/仓库/root/buildType 派生 Flavor/task，并回读 HEAD/版本/产物 hash", async () => {
    const fixture = buildFixture();
    const calls = { attest: 0, execute: 0, input: null };
    const controller = createWorkflowV2BuildController({
      storyStore: fixture.storyStore,
      executorBroker: trustedBuildBroker(fixture.repositoryPath, calls),
    });
    const result = await controller.execute({
      storyId: fixture.tab.id,
      repositoryId: "repo-main",
      rootId: "main",
      buildType: "release",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.execute, 1);
    assert.equal(calls.input.flavor, "demo");
    assert.equal(calls.input.task, "assembleDemoRelease");
    assert.equal(result.receipt.status, "PASS");
    assert.equal(result.receipt.selector.head, git(["rev-parse", "HEAD"], fixture.repositoryPath));
    assert.deepEqual(result.receipt.selector.version, { versionName: "1.2.30", versionCode: 10230 });
    assert.match(result.receipt.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.receipt.selector.artifact.sha256, result.receipt.sha256);
    assert.equal(result.receipt.outputRef.startsWith("root://main/"), true);
    assert.equal(result.receipt.outputRef.includes(fixture.repositoryPath), false);
    assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, result.receipt).valid, true);
  });

  it("拒绝模型提供 task/flavor/命令字段且零执行", async () => {
    const fixture = buildFixture();
    const calls = { attest: 0, execute: 0 };
    const controller = createWorkflowV2BuildController({
      storyStore: fixture.storyStore,
      executorBroker: trustedBuildBroker(fixture.repositoryPath, calls),
    });
    for (const extra of [
      { task: "clean" },
      { flavor: "other" },
      { command: "gradlew clean" },
    ]) {
      const result = await controller.execute({
        storyId: fixture.tab.id,
        repositoryId: "repo-main",
        rootId: "main",
        buildType: "release",
        ...extra,
      });
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.code, "WORKFLOW_V2_BUILD_INPUT_FORBIDDEN_FIELD");
    }
    assert.equal(calls.attest, 0);
    assert.equal(calls.execute, 0);
  });

  it("catalog 外 Flavor、错误仓库/root、其它构建变体均在执行前阻断", async () => {
    const fixture = buildFixture();
    const calls = { attest: 0, execute: 0 };
    const broker = trustedBuildBroker(fixture.repositoryPath, calls);
    const invalidBindings = [
      { repositoryId: "repo-other", rootId: "main" },
      { repositoryId: "repo-main", rootId: "webapp" },
    ];
    for (const binding of invalidBindings) {
      const result = await createWorkflowV2BuildController({ storyStore: fixture.storyStore, executorBroker: broker }).execute({
        storyId: fixture.tab.id,
        ...binding,
        buildType: "release",
      });
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.code, "WORKFLOW_V2_BUILD_ROOT_BINDING_MISMATCH");
    }
    fixture.tab.flavors[0].flavor = "other";
    const catalogBlocked = await createWorkflowV2BuildController({ storyStore: fixture.storyStore, executorBroker: broker }).execute({
      storyId: fixture.tab.id,
      repositoryId: "repo-main",
      rootId: "main",
      buildType: "release",
    });
    assert.equal(catalogBlocked.code, "WORKFLOW_V2_BUILD_FLAVOR_NOT_ALLOWED");
    fixture.tab.flavors[0].flavor = "demo";
    const variantBlocked = await createWorkflowV2BuildController({
      storyStore: fixture.storyStore,
      executorBroker: broker,
      resolveBuildTarget: () => ({ flavor: "other", task: "assembleOtherRelease" }),
    }).execute({
      storyId: fixture.tab.id,
      repositoryId: "repo-main",
      rootId: "main",
      buildType: "release",
    });
    assert.equal(variantBlocked.code, "WORKFLOW_V2_BUILD_TASK_FLAVOR_MISMATCH");
    assert.equal(calls.execute, 0);
  });

  it("生产未接可信执行器时返回可审计 BLOCKED 且不启动进程", async () => {
    const fixture = buildFixture();
    const result = await createWorkflowV2BuildController({ storyStore: fixture.storyStore }).execute({
      storyId: fixture.tab.id,
      repositoryId: "repo-main",
      rootId: "main",
      buildType: "debug",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKFLOW_V2_BUILD_CONFINED_EXECUTOR_UNAVAILABLE");
    assert.equal(result.receipt.status, "BLOCKED");
    assert.equal(result.receipt.selector.task, "assembleDemoDebug");
    assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, result.receipt).valid, true);
  });

  it("产物越界或 provenance 不一致不得生成 PASS receipt", async () => {
    const fixture = buildFixture();
    const outside = path.join(tempRoot, "outside.apk");
    fs.writeFileSync(outside, "outside", "utf8");
    const outsideCalls = { attest: 0, execute: 0 };
    const outsideResult = await createWorkflowV2BuildController({
      storyStore: fixture.storyStore,
      executorBroker: trustedBuildBroker(fixture.repositoryPath, outsideCalls, (result) => ({ ...result, artifactPath: outside })),
    }).execute({ storyId: fixture.tab.id, repositoryId: "repo-main", rootId: "main", buildType: "release" });
    assert.equal(outsideResult.code, "WORKFLOW_V2_BUILD_ARTIFACT_OUTSIDE_ROOT");
    assert.equal(outsideResult.receipt.status, "BLOCKED");

    const mismatchCalls = { attest: 0, execute: 0 };
    const mismatchResult = await createWorkflowV2BuildController({
      storyStore: fixture.storyStore,
      executorBroker: trustedBuildBroker(fixture.repositoryPath, mismatchCalls, (result) => ({
        ...result,
        provenance: { ...result.provenance, task: "assembleOtherRelease" },
      })),
    }).execute({ storyId: fixture.tab.id, repositoryId: "repo-main", rootId: "main", buildType: "release" });
    assert.equal(mismatchResult.code, "WORKFLOW_V2_BUILD_PROVENANCE_MISMATCH");
    assert.equal(mismatchResult.receipt.status, "BLOCKED");
  });
});

function activeLease(overrides = {}) {
  return {
    serial: "SERIAL-1",
    storyId: "story-device-1",
    leaseId: "lease-1",
    fencingToken: 7,
    leaseTtlMs: 30_000,
    expiresAt: 50_000,
    expired: false,
    ...overrides,
  };
}

function deviceHarness({ storyReader, snapshot, heartbeatLease, adapter, nowMs = () => 10_000 } = {}) {
  const story = { id: "story-device-1", deviceSerial: "SERIAL-1" };
  const lease = activeLease();
  const frozenContext = freezeStoryDeviceLeaseContext({ story, lease });
  const calls = { handler: 0, heartbeat: 0, storyRead: 0, snapshotRead: 0, input: null };
  const actionAdapter = adapter || {
    receiptAction: "INSTALL",
    attest: async ({ businessAction }) => ({
      ok: true,
      kind: WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION,
      businessAction,
    }),
    execute: async (input) => {
      calls.handler += 1;
      calls.input = input;
      return { ok: true, businessAction: input.businessAction, installed: true };
    },
  };
  const proxy = createStoryLeaseDeviceProxy({
    frozenContext,
    actions: { install_release: actionAdapter },
    readStory: async () => {
      calls.storyRead += 1;
      return storyReader ? storyReader(calls.storyRead) : story;
    },
    readRuntimeSnapshot: async () => {
      calls.snapshotRead += 1;
      const selected = typeof snapshot === "function"
        ? snapshot(calls.snapshotRead, lease)
        : (snapshot === undefined ? lease : snapshot);
      return { status: selected ? "acquired" : "idle", serial: "SERIAL-1", lease: selected };
    },
    heartbeat: async () => {
      calls.heartbeat += 1;
      const selected = typeof heartbeatLease === "function"
        ? heartbeatLease(calls.heartbeat, lease)
        : (heartbeatLease === undefined ? { ...lease, expiresAt: 80_000 } : heartbeatLease);
      return selected?.ok === false
        ? selected
        : { ok: true, status: "renewed", lease: selected };
    },
    nowMs,
  });
  return { proxy, calls, story, lease };
}

describe("M8 Device Proxy same-story lease reuse", () => {
  it("正确同故事有效 lease 注入 serial/leaseId/fencingToken 并执行一次", async () => {
    const { proxy, calls } = deviceHarness();
    const result = await proxy.execute({ businessAction: "install_release" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.snapshotRead, 2);
    assert.equal(calls.storyRead, 4);
    assert.equal(calls.heartbeat, 2);
    assert.equal(calls.handler, 1);
    assert.deepEqual(calls.input, {
      businessAction: "install_release",
      storyId: "story-device-1",
      serial: "SERIAL-1",
      leaseId: "lease-1",
      fencingToken: 7,
    });
    assert.equal(result.receipt.action, "INSTALL");
    assert.equal(result.receipt.status, "PASS");
    assert.equal(JSON.stringify(result.receipt).includes("SERIAL-1"), false);
    assert.equal(workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, result.receipt).valid, true);
  });

  it("模型传 serial/lease/自由参数时零设备调用", async () => {
    for (const extra of [{ serial: "OTHER" }, { leaseId: "other" }, { args: ["shell", "reboot"] }]) {
      const { proxy, calls } = deviceHarness();
      const result = await proxy.execute({ businessAction: "install_release", ...extra });
      assert.equal(result.code, "WORKFLOW_V2_DEVICE_PROXY_INPUT_INVALID");
      assert.equal(calls.snapshotRead, 0);
      assert.equal(calls.heartbeat, 0);
      assert.equal(calls.handler, 0);
    }
  });

  it("missing/wrong/stale/other-story lease 均零 handler 调用", async () => {
    const scenarios = [
      { expected: "WORKFLOW_V2_DEVICE_LEASE_REQUIRED", snapshot: null },
      { expected: "WORKFLOW_V2_DEVICE_LEASE_ID_MISMATCH", snapshot: activeLease({ leaseId: "lease-other" }) },
      { expected: "WORKFLOW_V2_DEVICE_FENCING_TOKEN_MISMATCH", snapshot: activeLease({ fencingToken: 8 }) },
      { expected: "WORKFLOW_V2_DEVICE_LEASE_STORY_MISMATCH", snapshot: activeLease({ storyId: "story-other" }) },
      { expected: "WORKFLOW_V2_DEVICE_LEASE_EXPIRED", snapshot: activeLease({ expiresAt: 9_000 }) },
    ];
    for (const scenario of scenarios) {
      const { proxy, calls } = deviceHarness({ snapshot: scenario.snapshot });
      const result = await proxy.execute({ businessAction: "install_release" });
      assert.equal(result.code, scenario.expected, JSON.stringify(result));
      assert.equal(calls.handler, 0);
      assert.equal(calls.heartbeat, 0);
    }
  });

  it("binding 在首次读取前或 heartbeat 后漂移均零 handler 调用", async () => {
    const before = deviceHarness({ storyReader: () => ({ id: "story-device-1", deviceSerial: "SERIAL-2" }) });
    const beforeResult = await before.proxy.execute({ businessAction: "install_release" });
    assert.equal(beforeResult.code, "WORKFLOW_V2_DEVICE_BINDING_DRIFT");
    assert.equal(before.calls.snapshotRead, 0);
    assert.equal(before.calls.handler, 0);

    const during = deviceHarness({
      storyReader: (read) => ({ id: "story-device-1", deviceSerial: read === 1 ? "SERIAL-1" : "SERIAL-2" }),
    });
    const duringResult = await during.proxy.execute({ businessAction: "install_release" });
    assert.equal(duringResult.code, "WORKFLOW_V2_DEVICE_LEASE_MISMATCH");
    assert.equal(during.calls.heartbeat, 1);
    assert.equal(during.calls.handler, 0);
  });

  it("heartbeat 回读变成错误 lease 时零 handler 调用", async () => {
    const { proxy, calls } = deviceHarness({ heartbeatLease: activeLease({ leaseId: "lease-new", fencingToken: 8 }) });
    const result = await proxy.execute({ businessAction: "install_release" });
    assert.equal(result.code, "WORKFLOW_V2_DEVICE_LEASE_ID_MISMATCH");
    assert.equal(calls.handler, 0);
  });
});

describe("M8 Device Proxy adapter result attestation", () => {
  it("blocks missing, false, non-boolean, or wrong-action acknowledgements without a PASS receipt", async () => {
    const invalidResults = [
      undefined,
      {},
      { ok: false, businessAction: "install_release", error: "failed" },
      { ok: "true", businessAction: "install_release" },
      { ok: true },
      { ok: true, businessAction: "reboot" },
    ];
    for (const adapterResult of invalidResults) {
      let handlerCalls = 0;
      const { proxy } = deviceHarness({
        adapter: {
          attest: async ({ businessAction }) => ({
            ok: true,
            kind: WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION,
            businessAction,
          }),
          execute: async () => {
            handlerCalls += 1;
            return adapterResult;
          },
        },
      });
      const result = await proxy.execute({ businessAction: "install_release" });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.receipt.status, "BLOCKED");
      assert.notEqual(result.receipt.status, "PASS");
      assert.equal(handlerCalls, 1);
      assert.match(result.code, /^WORKFLOW_V2_DEVICE_ADAPTER_RESULT_/);
    }
  });
});

describe("M8 Device Proxy completion lease confirmation", () => {
  it("renews and revalidates the same live lease after a timed action before signing PASS", async () => {
    let observedNow = 10_000;
    let executions = 0;
    const { proxy, calls } = deviceHarness({
      nowMs: () => observedNow,
      snapshot: (read, lease) => ({
        ...lease,
        expiresAt: read === 1 ? 50_000 : 60_000,
      }),
      heartbeatLease: (call, lease) => ({
        ...lease,
        expiresAt: call === 1 ? 60_000 : 90_000,
      }),
      adapter: {
        attest: async ({ businessAction }) => ({
          ok: true,
          kind: WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION,
          businessAction,
        }),
        execute: async ({ businessAction }) => {
          executions += 1;
          observedNow = 30_000;
          return { ok: true, businessAction };
        },
      },
    });
    const result = await proxy.execute({ businessAction: "install_release" });
    assert.equal(result.status, "PASS", JSON.stringify(result));
    assert.equal(result.receipt.status, "PASS");
    assert.equal(executions, 1);
    assert.equal(calls.storyRead, 4);
    assert.equal(calls.snapshotRead, 2);
    assert.equal(calls.heartbeat, 2);
  });

  it("blocks when the lease expires while the adapter is executing", async () => {
    let observedNow = 10_000;
    const { proxy, calls } = deviceHarness({
      nowMs: () => observedNow,
      snapshot: (read, lease) => ({
        ...lease,
        expiresAt: read === 1 ? 50_000 : 60_000,
      }),
      heartbeatLease: (_call, lease) => ({ ...lease, expiresAt: 60_000 }),
      adapter: {
        attest: async ({ businessAction }) => ({
          ok: true,
          kind: WORKFLOW_V2_DEVICE_ADAPTER_ATTESTATION,
          businessAction,
        }),
        execute: async ({ businessAction }) => {
          observedNow = 60_000;
          return { ok: true, businessAction };
        },
      },
    });
    const result = await proxy.execute({ businessAction: "install_release" });
    assert.equal(result.status, "BLOCKED", JSON.stringify(result));
    assert.equal(result.code, "WORKFLOW_V2_DEVICE_LEASE_EXPIRED");
    assert.equal(result.receipt.status, "BLOCKED");
    assert.equal(calls.storyRead, 3);
    assert.equal(calls.snapshotRead, 2);
    assert.equal(calls.heartbeat, 1);
  });

  it("blocks an unbound, replaced, or re-fenced lease observed after execution", async () => {
    const scenarios = [
      { expected: "WORKFLOW_V2_DEVICE_COMPLETION_LEASE_UNCONFIRMED", completionLease: null },
      { expected: "WORKFLOW_V2_DEVICE_LEASE_ID_MISMATCH", completionLease: activeLease({ leaseId: "lease-2" }) },
      { expected: "WORKFLOW_V2_DEVICE_FENCING_TOKEN_MISMATCH", completionLease: activeLease({ fencingToken: 8 }) },
      { expected: "WORKFLOW_V2_DEVICE_LEASE_EXPIRED", completionLease: activeLease({ expired: true }) },
    ];
    for (const scenario of scenarios) {
      const { proxy, calls } = deviceHarness({
        snapshot: (read, lease) => (read === 1 ? lease : scenario.completionLease),
      });
      const result = await proxy.execute({ businessAction: "install_release" });
      assert.equal(result.status, "BLOCKED", JSON.stringify(result));
      assert.equal(result.code, scenario.expected);
      assert.equal(result.receipt.status, "BLOCKED");
      assert.equal(calls.handler, 1);
      assert.equal(calls.snapshotRead, 2);
      assert.equal(calls.heartbeat, 1);
    }
  });

  it("blocks story binding drift observed after adapter execution", async () => {
    const { proxy, calls } = deviceHarness({
      storyReader: (read) => ({
        id: "story-device-1",
        deviceSerial: read < 3 ? "SERIAL-1" : "SERIAL-2",
      }),
    });
    const result = await proxy.execute({ businessAction: "install_release" });
    assert.equal(result.status, "BLOCKED", JSON.stringify(result));
    assert.equal(result.code, "WORKFLOW_V2_DEVICE_BINDING_DRIFT");
    assert.equal(result.receipt.status, "BLOCKED");
    assert.equal(calls.handler, 1);
    assert.equal(calls.storyRead, 3);
    assert.equal(calls.snapshotRead, 1);
    assert.equal(calls.heartbeat, 1);
  });
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
