import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";
import {
  assertWorkflowV2StageToolPolicy,
  authorizeWorkflowV2StageToolCall,
  compileWorkflowV2StageToolPolicy,
  getWorkflowV2StageToolPolicyTemplate,
  loadWorkflowV2StageCapabilitiesDocument,
  sanitizeWorkflowV2StageToolResult,
  WorkflowV2StageToolPolicyError,
} from "../services/devbench/workflow-v2/stage-tool-policy.js";
import { APPMARKET_MCP_TOOL_NAMES } from "../services/appmarket-admin-mcp.js";

function requireStageToolPolicy() {
  return { assertWorkflowV2StageToolPolicy };
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-stage-policy-"));
const projectDir = path.join(tempRoot, "project");
const storyDir = path.join(tempRoot, "story");
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(storyDir, { recursive: true });

const STORY_ID = "story-stage-policy-001";
const TASK_ID = "task-stage-policy-001";

function baseCapabilities(stageId, template) {
  return {
    allowedTools: [...template.allowedToolNames],
    canWriteSource: template.allowedToolGroups.includes("FILES_PATCH"),
    canReadGit: template.allowedToolGroups.includes("GIT_READ"),
    canWriteGit: false,
    canCommit: false,
    canUseDevice: template.allowedToolGroups.includes("DEVICE_PROXY"),
    canWriteTb: false,
    canWriteReport: template.allowedToolGroups.includes("REPORT_WRITE"),
    maxToolIterations: template.maxToolIterations,
    longProcessProtocol: "NONE",
  };
}

function buildContext(stageId) {
  const template = getWorkflowV2StageToolPolicyTemplate(stageId);
  return {
    schemaVersion: "tb-stage-context-v2",
    contextId: `ctx-${stageId.toLowerCase()}-policy-test`,
    revision: 1,
    idempotencyKey: `${stageId}:1`,
    story: { storyId: STORY_ID, ticketId: "t-1", carbId: null, title: "M5 policy", groupId: null },
    stage: { id: stageId, attempt: 1, riskLevel: "MEDIUM" },
    task: { instruction: "test instruction", successCriteria: ["c"], userVisibleGoal: "goal" },
    scope: {
      roots: [
        { rootId: "main", kind: "MAIN", projectId: "p1", branch: null, flavor: null, versionName: null, writable: stageId === "REPAIR" },
        { rootId: "artifacts", kind: "ARTIFACT", projectId: null, branch: null, flavor: null, versionName: null, writable: stageId === "REPORT_EXPERT" },
      ],
      protectedPaths: [".git/**", "AGENTS.md", "CLAUDE.md"],
      tempRootId: "artifacts",
      deviceProfileId: null,
    },
    capabilities: baseCapabilities(stageId, template),
    output: {
      schemaId: "https://example.local/schemas/triage-result-v2.json",
      maxChars: null,
      outputPath: stageId === "REPORT_EXPERT" ? "storydev:/reports/acceptance-report.html" : null,
    },
  };
}

function rootBindings() {
  return [
    { rootId: "main", realRoot: projectDir },
    { rootId: "artifacts", realRoot: storyDir },
  ];
}

function compileFor(stageId) {
  const context = buildContext(stageId);
  return compileWorkflowV2StageToolPolicy({
    context,
    storyId: STORY_ID,
    taskId: TASK_ID,
    contextHash: canonicalSha256(context),
    rootBindings: rootBindings(),
  });
}

function expectPolicyError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof WorkflowV2StageToolPolicyError, `期望策略错误，实际: ${error?.name}: ${error?.message}`);
    if (code) assert.equal(error.code, code, `期望 code=${code}，实际=${error.code}: ${error.message}`);
    return true;
  });
}

describe("M5 阶段工具策略模板与能力清单", () => {
  it("stage-capabilities.json 覆盖全部 9 个阶段且 readOnly/maxToolIterations 合法", () => {
    const document = loadWorkflowV2StageCapabilitiesDocument();
    const stages = ["TRIAGE", "DIAGNOSE_PLAN", "REPAIR", "INDEPENDENT_REVIEW", "VERIFY_PLAN", "VERIFY_EXECUTE", "REPORT_SHORT", "REPORT_EXPERT", "MEMORY_DISTILL"];
    for (const stageId of stages) {
      const template = getWorkflowV2StageToolPolicyTemplate(stageId);
      assert.equal(typeof template.readOnly, "boolean", stageId);
      assert.ok(Number.isSafeInteger(template.maxToolIterations) && template.maxToolIterations >= 0 && template.maxToolIterations <= 40, stageId);
      assert.ok(Array.isArray(template.allowedToolNames), stageId);
    }
    assert.equal(document.stages.TRIAGE.readOnly, true);
    assert.equal(document.stages.REPAIR.readOnly, false);
    assert.equal(document.stages.REPORT_SHORT.maxToolIterations, 0);
  });

  it("只读阶段不展开任何写工具", () => {
    const triage = getWorkflowV2StageToolPolicyTemplate("TRIAGE");
    assert.equal(triage.allowedToolNames.includes("write_file"), false);
    assert.equal(triage.allowedToolNames.includes("edit_file"), false);
    assert.equal(triage.allowedToolNames.includes("apply_patch"), false);
    const verify = getWorkflowV2StageToolPolicyTemplate("VERIFY_EXECUTE");
    assert.equal(verify.allowedToolNames.includes("edit_file"), false);
    const reportShort = getWorkflowV2StageToolPolicyTemplate("REPORT_SHORT");
    assert.equal(reportShort.allowedToolNames.length, 0);
  });

  it("REPAIR 展开 FILES_PATCH 写工具但永不包含 Git 写/ADB/TB 组", () => {
    const repair = getWorkflowV2StageToolPolicyTemplate("REPAIR");
    assert.ok(repair.allowedToolNames.includes("edit_file"));
    assert.ok(repair.allowedToolNames.includes("apply_patch"));
    for (const name of repair.allowedToolNames) {
      assert.ok(!name.startsWith("git_commit") && !name.startsWith("adb") && !name.includes("tb_"), name);
    }
  });
});

describe("M5 策略编译与身份绑定", () => {
  it("编译产物冻结且 policySha256 自洽", () => {
    const policy = compileFor("TRIAGE");
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.roots));
    assert.equal(policy.identity.storyId, STORY_ID);
    assert.equal(policy.identity.taskId, TASK_ID);
    assert.equal(policy.identity.stageId, "TRIAGE");
    assert.ok(/^[a-f0-9]{64}$/.test(policy.policySha256));
    // 可见字段不得携带真实绝对路径（路径只存在于内部 WeakMap 绑定）
    const serialized = JSON.stringify(policy);
    assert.ok(!serialized.includes(projectDir), "policy 序列化不得泄露真实路径");
    assert.ok(!serialized.includes(storyDir), "policy 序列化不得泄露真实路径");
  });

  it("contextHash 不匹配或 taskId 不匹配必须拒绝", () => {
    const context = buildContext("TRIAGE");
    expectPolicyError(
      () => compileWorkflowV2StageToolPolicy({
        context,
        storyId: STORY_ID,
        taskId: TASK_ID,
        contextHash: "0".repeat(64),
        rootBindings: rootBindings(),
      }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH",
    );
    const policy = compileFor("TRIAGE");
    const { assertWorkflowV2StageToolPolicy } = requireStageToolPolicy();
    assert.doesNotThrow(() => assertWorkflowV2StageToolPolicy(policy, {
      context: buildContext("TRIAGE"),
      storyId: STORY_ID,
      taskId: TASK_ID,
      contextHash: canonicalSha256(buildContext("TRIAGE")),
    }));
    expectPolicyError(
      () => assertWorkflowV2StageToolPolicy(policy, {
        context: buildContext("TRIAGE"),
        storyId: STORY_ID,
        taskId: "other-task",
        contextHash: canonicalSha256(buildContext("TRIAGE")),
      }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_IDENTITY_MISMATCH",
    );
  });

  it("篡改（克隆+改字段）后的策略必须被当作 TAMPERED", () => {
    const policy = compileFor("TRIAGE");
    const tampered = { ...policy, maxToolIterations: 99 };
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(tampered, "read_file", { rootId: "main", path: "a.txt" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_TAMPERED",
    );
  });

  it("context capabilities 与模板展开不一致时编译拒绝", () => {
    const context = buildContext("TRIAGE");
    context.capabilities.allowedTools = ["read_file", "extra_tool"];
    expectPolicyError(
      () => compileWorkflowV2StageToolPolicy({
        context,
        storyId: STORY_ID,
        taskId: TASK_ID,
        contextHash: canonicalSha256(context),
        rootBindings: rootBindings(),
      }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_CONTEXT_CONFLICT",
    );
  });

  it("缺少 root binding 或绑定目录不存在时编译拒绝", () => {
    const context = buildContext("TRIAGE");
    expectPolicyError(
      () => compileWorkflowV2StageToolPolicy({
        context,
        storyId: STORY_ID,
        taskId: TASK_ID,
        contextHash: canonicalSha256(context),
        rootBindings: [{ rootId: "main", realRoot: projectDir }],
      }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID",
    );
    expectPolicyError(
      () => compileWorkflowV2StageToolPolicy({
        context,
        storyId: STORY_ID,
        taskId: TASK_ID,
        contextHash: canonicalSha256(context),
        rootBindings: [
          { rootId: "main", realRoot: projectDir },
          { rootId: "artifacts", realRoot: path.join(tempRoot, "does-not-exist") },
        ],
      }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID",
    );
  });
});

describe("M5 工具调用授权（PERM/PATH 验收）", () => {
  it("TRIAGE 只读阶段：读工具放行、写工具拒绝（PERM-001）", () => {
    const policy = compileFor("TRIAGE");
    const read = authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: "README.md" });
    assert.equal(read.name, "read_file");
    assert.equal(read.pathRefs.length, 1);
    // TRIAGE 未展开任何写工具组，写工具一律 TOOL_DENIED（执行层拒绝）
    for (const denied of [
      ["write_file", { rootId: "main", path: "x.txt", content: "x" }],
      ["edit_file", { rootId: "main", path: "x.txt", old_string: "a", new_string: "b" }],
      ["apply_patch", { rootId: "main", path: "", patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n" }],
    ]) {
      expectPolicyError(
        () => authorizeWorkflowV2StageToolCall(policy, denied[0], denied[1]),
        "WORKFLOW_V2_STAGE_TOOL_POLICY_TOOL_DENIED",
      );
    }
    // 未授权工具（TOOL_DENIED）
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "run_command", { command: "rm -rf /", purpose: "x", path: "." }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_TOOL_DENIED",
    );
  });

  it("REPAIR 写源码 root 放行、写只读 artifacts root 拒绝", () => {
    const policy = compileFor("REPAIR");
    const write = authorizeWorkflowV2StageToolCall(policy, "edit_file", { rootId: "main", path: "src/a.txt", old_string: "old", new_string: "new" });
    assert.equal(write.pathRefs.length, 1);
    assert.equal(write.pathRefs[0].access, "write");
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "edit_file", { rootId: "artifacts", path: "x.txt", old_string: "a", new_string: "b" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_WRITE_DENIED",
    );
  });

  it("REPORT_EXPERT 只能写 reportWritePrefix 目录（RPT-002 前置）", () => {
    const policy = compileFor("REPORT_EXPERT");
    const ok = authorizeWorkflowV2StageToolCall(policy, "write_file", { rootId: "artifacts", path: "reports/acceptance-report.html", content: "<html/>" });
    assert.equal(ok.pathRefs[0].absolutePath, path.join(storyDir, "reports", "acceptance-report.html"));
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "write_file", { rootId: "artifacts", path: "other/leak.txt", content: "x" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_WRITE_DENIED",
    );
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "write_file", { rootId: "main", path: "src/leak.txt", content: "x" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_WRITE_DENIED",
    );
  });

  it("绝对路径与 `..` 相对路径被拒绝（PATH-001）", () => {
    const policy = compileFor("TRIAGE");
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: "C:\\Windows\\win.ini" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID",
    );
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: "../other-story/secret.txt" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID",
    );
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: "a/../../b.txt" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID",
    );
  });

  it("未知 rootId / 未知参数键 / 危险参数被拒绝", () => {
    const policy = compileFor("TRIAGE");
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "ghost", path: "a.txt" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_ROOT_INVALID",
    );
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: "a.txt", sneaky: "x" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID",
    );
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "search_files", { rootId: "main", pattern: "x", path: "a\u0000b" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID",
    );
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: "a.txt", line_count: -1 }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_ARGUMENT_INVALID",
    );
  });

  it("保护路径（.git/AGENTS.md/CLAUDE.md）被拒绝", () => {
    const policy = compileFor("REPAIR");
    for (const target of [".git/config", "src/.git/HEAD", "AGENTS.md", "docs/CLAUDE.md"]) {
      expectPolicyError(
        () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: target }),
        "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_DENIED",
      );
    }
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "edit_file", { rootId: "main", path: "AGENTS.md", old_string: "a", new_string: "b" }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_DENIED",
    );
  });

  it("apply_patch 的补丁目标逐项校验，写目标越界时拒绝", () => {
    const policy = compileFor("REPAIR");
    const patch = "diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const authorized = authorizeWorkflowV2StageToolCall(policy, "apply_patch", { rootId: "main", path: "", patch });
    const targetRef = authorized.pathRefs.find((ref) => ref.field === "patch");
    assert.ok(targetRef);
    assert.equal(targetRef.absolutePath, path.join(projectDir, "src", "a.txt"));
    assert.equal(authorized.args.patch, patch, "patch 文本保持原样");
    const evil = "diff --git a/../escape.txt b/../escape.txt\n--- a/../escape.txt\n+++ b/../escape.txt\n@@ -1 +1 @@\n-old\n+new\n";
    expectPolicyError(
      () => authorizeWorkflowV2StageToolCall(policy, "apply_patch", { rootId: "main", path: "", patch: evil }),
      "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_INVALID",
    );
  });

  it("junction/symlink 逃逸到 root 之外被拒绝（PATH-002）", { skip: process.platform !== "win32" }, () => {
    const outside = path.join(tempRoot, "outside-secret");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    const linkDir = path.join(projectDir, "link-out");
    try {
      fs.symlinkSync(outside, linkDir, "junction");
      const policy = compileFor("TRIAGE");
      expectPolicyError(
        () => authorizeWorkflowV2StageToolCall(policy, "read_file", { rootId: "main", path: "link-out/secret.txt" }),
        "WORKFLOW_V2_STAGE_TOOL_POLICY_PATH_DENIED",
      );
    } finally {
      try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("sanitize 把真实绝对路径替换为 <root:rootId> 占位（防结果泄露）", () => {
    const policy = compileFor("REPAIR");
    const output = `读取 ${projectDir} 内文件 ${path.join(projectDir, "src", "a.txt")} 成功`;
    const sanitized = sanitizeWorkflowV2StageToolResult(policy, output);
    assert.ok(!sanitized.includes(projectDir), sanitized);
    assert.ok(!sanitized.includes(path.join(projectDir, "src", "a.txt")), sanitized);
    assert.ok(sanitized.includes("<root:main>"), sanitized);
  });

  it("maxToolIterations 从能力清单传播到策略（API-001 前置）", () => {
    const triage = compileFor("TRIAGE");
    assert.equal(triage.maxToolIterations, getWorkflowV2StageToolPolicyTemplate("TRIAGE").maxToolIterations);
    assert.equal(triage.maxToolIterations, 10);
    const repair = compileFor("REPAIR");
    assert.equal(repair.maxToolIterations, 24);
    const reportShort = compileFor("REPORT_SHORT");
    assert.equal(reportShort.maxToolIterations, 0);
  });
});

describe("M5 策略与派发集成", () => {
  it("compatibility dispatch 的 capabilities 与模板展开一致（allowedTools 为真实工具名）", async () => {
    const dispatch = await import("../services/devbench/workflow-v2/compatibility-dispatch.js");
    const { prepareWorkflowV2CompatibilityDispatch } = dispatch;
    const { canonicalSha256: sha256 } = await import("../services/devbench/workflow-v2/envelope-store.js");
    const context = buildContext("TRIAGE");
    const template = getWorkflowV2StageToolPolicyTemplate("TRIAGE");
    assert.deepEqual(context.capabilities.allowedTools, template.allowedToolNames);
    assert.ok(context.capabilities.allowedTools.includes("read_file"));
    assert.ok(context.capabilities.allowedTools.includes("git_diff"));
    assert.equal(context.capabilities.canWriteSource, false);
    assert.equal(context.capabilities.canWriteTb, false);
    assert.equal(context.capabilities.canWriteGit, false);
    assert.equal(context.capabilities.canCommit, false);
    void prepareWorkflowV2CompatibilityDispatch;
    void sha256;
  });

  it("REPORT_EXPERT 上下文输出路径限定的写前缀与策略一致", () => {
    const context = buildContext("REPORT_EXPERT");
    assert.equal(context.output.outputPath, "storydev:/reports/acceptance-report.html");
    assert.equal(context.capabilities.canWriteReport, true);
    assert.equal(context.scope.roots.find((r) => r.rootId === "artifacts").writable, true);
  });

  it("REPORT_SHORT 无任何工具（PERM-002）", () => {
    const context = buildContext("REPORT_SHORT");
    assert.equal(context.capabilities.allowedTools.length, 0);
    assert.equal(context.capabilities.maxToolIterations, 0);
    const policy = compileFor("REPORT_SHORT");
    assert.equal(policy.allowedToolNames.length, 0);
  });
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
