import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  analyzeFlavorDiff,
  assertDeviceLeaseBinding,
  buildSystemCommitMessage,
  installStoryCommitMsgHook,
  validateFlavorAgainstCatalog,
  validateSystemCommitMessage,
  WorkflowV2BuildGateError,
} from "../services/devbench/workflow-v2/build-diff-gate.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-build-gate-"));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("M8 Flavor 白名单与 diff 门禁（FLV-001/002）", () => {
  it("catalog 外的 flavor 拒绝", () => {
    const verdict = validateFlavorAgainstCatalog({ flavor: "geelyss21", catalog: ["geelyss21", "geely14"] });
    assert.equal(verdict.ok, true);
    const denied = validateFlavorAgainstCatalog({ flavor: "hacker-flavor", catalog: ["geelyss21"] });
    assert.equal(denied.ok, false);
    assert.deepEqual(denied.known, ["geelyss21"]);
  });

  it("catalog 不可解析时放行（非 Android 工程）", () => {
    const verdict = validateFlavorAgainstCatalog({ flavor: "anything", catalog: [] });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.catalogUnavailable, true);
  });

  it("大小写与空白归一化后匹配", () => {
    assert.equal(validateFlavorAgainstCatalog({ flavor: "  GeelySS21 ", catalog: ["geelyss21"] }).ok, true);
  });

  it("其它 Flavor sourceSet 改动阻断（FLV-002）", () => {
    const sourceSets = { main: "app/src/main", prod: "app/src/prod", stg: "app/src/stg" };
    const verdict = analyzeFlavorDiff({
      targetFlavor: "prod",
      sourceSets,
      changedPaths: ["app/src/stg/features/Foo.kt", "app/src/main/Bar.kt", "app/src/prod/Ok.kt"],
    });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.blockers.map((entry) => entry.path), ["app/src/stg/features/Foo.kt"]);
    assert.equal(verdict.warnings.some((entry) => entry.path === "app/src/main/Bar.kt"), true);
  });

  it("目标 Flavor 与无关目录改动放行", () => {
    const verdict = analyzeFlavorDiff({
      targetFlavor: "prod",
      sourceSets: { main: "app/src/main", prod: "app/src/prod", stg: "app/src/stg" },
      changedPaths: ["app/src/prod/Ok.kt", "docs/note.md", "app/src/main/Bar.kt"],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.blockers.length, 0);
  });
});

describe("M8 系统提交信息与 commit-msg 门禁（GIT-001/002）", () => {
  it("系统生成 conventional 格式提交信息", () => {
    const message = buildSystemCommitMessage({
      storyId: "story-001",
      docSlug: "空指针修复",
      summary: "修复空指针未拦截问题",
      details: "补充判空与回归测试",
    });
    const verdict = validateSystemCommitMessage(message);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
    assert.match(message, /^fix\([a-z0-9-]+\):/);
    assert.ok(message.includes("storyId: story-001"));
  });

  it("禁止尾注（Co-Authored-By/Signed-off-by）拒绝", () => {
    const good = validateSystemCommitMessage("fix(scope): 修复问题\n\nbody");
    assert.equal(good.ok, true);
    for (const trailer of [
      "fix(scope): 修复问题\n\nCo-Authored-By: AI <ai@example.com>",
      "fix(scope): 修复问题\n\nSigned-off-by: dev",
    ]) {
      const verdict = validateSystemCommitMessage(trailer);
      assert.equal(verdict.ok, false);
      assert.ok(verdict.issues.some((issue) => issue.includes("尾注")), JSON.stringify(verdict.issues));
    }
  });

  it("绝对路径泄露与控制字符拒绝", () => {
    assert.equal(validateSystemCommitMessage(`fix(scope): 修复问题\n\nC:\\Users\\xskj\\secret`).ok, false);
    assert.equal(validateSystemCommitMessage("fix(scope): 修复\u0000问题").ok, false);
    assert.equal(validateSystemCommitMessage("非 conventional 主题").ok, false);
    assert.equal(validateSystemCommitMessage("").ok, false);
  });

  it("commit-msg hook 安装后在真实 worktree 拒绝违规提交", () => {
    const repo = path.join(tempRoot, "hook-repo");
    const worktree = path.join(tempRoot, "hook-worktree");
    fs.mkdirSync(repo, { recursive: true });
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "test@example.com"], repo);
    git(["config", "user.name", "Test"], repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "a", "utf8");
    git(["add", "a.txt"], repo);
    git(["commit", "-q", "-m", "chore: init"], repo);
    git(["worktree", "add", "-q", "-b", "story-hook", worktree], repo);
    const hook = installStoryCommitMsgHook({ worktreeRoot: worktree });
    assert.equal(hook.installed, true);
    assert.ok(fs.existsSync(hook.hookPath));

    fs.writeFileSync(path.join(worktree, "b.txt"), "b", "utf8");
    git(["add", "b.txt"], worktree);
    const bad = `fix(story): 修复问题\n\nCo-Authored-By: AI <ai@example.com>`;
    assert.throws(
      () => git(["commit", "-m", bad], worktree),
      /commit-msg rejected/,
    );
    const good = "fix(story): 修复问题\n\nstoryId: story-hook-test";
    git(["commit", "-q", "-m", good], worktree);
    const sha = git(["rev-parse", "HEAD"], worktree).trim();
    assert.ok(/^[a-f0-9]{40}$/.test(sha));
    const readback = git(["rev-parse", "HEAD"], worktree).trim();
    assert.equal(readback, sha, "GIT-002 回读 SHA 一致");
  });

  it("hook 安装幂等且失败 fail closed", () => {
    const worktree = path.join(tempRoot, "hook-worktree");
    const first = installStoryCommitMsgHook({ worktreeRoot: worktree });
    const second = installStoryCommitMsgHook({ worktreeRoot: worktree });
    assert.equal(first.hookPath, second.hookPath);
    assert.throws(
      () => installStoryCommitMsgHook({ worktreeRoot: "" }),
      (error) => error instanceof WorkflowV2BuildGateError && error.code === "WORKFLOW_V2_COMMIT_HOOK_INSTALL_FAILED",
    );
  });
});

describe("M8 设备租约绑定（ADB-001/002）", () => {
  it("无租约拒绝设备操作", () => {
    assert.throws(
      () => assertDeviceLeaseBinding({}),
      (error) => error.code === "WORKFLOW_V2_DEVICE_LEASE_REQUIRED",
    );
  });

  it("VERIFY 强制完整 active lease，只有绑定 serial 仍拒绝", () => {
    assert.throws(
      () => assertDeviceLeaseBinding({ requireLease: true, boundSerial: "SERIAL-A" }),
      (error) => error instanceof WorkflowV2BuildGateError
        && error.code === "WORKFLOW_V2_DEVICE_LEASE_REQUIRED",
    );
    assert.deepEqual(assertDeviceLeaseBinding({
      requireLease: true,
      boundSerial: "SERIAL-A",
      leasedSerial: "SERIAL-A",
      frozenStoryId: "story-1",
      leasedStoryId: "story-1",
      expectedLeaseId: "lease-1",
      leaseId: "lease-1",
      expectedFencingToken: 9,
      fencingToken: 9,
      expiresAt: 20_000,
      now: 10_000,
    }), {
      serial: "SERIAL-A",
      storyId: "story-1",
      leaseId: "lease-1",
      fencingToken: 9,
    });
  });

  it("模型指定其它 serial 被拒绝", () => {
    assert.throws(
      () => assertDeviceLeaseBinding({ boundSerial: "S1", leasedSerial: "S1", requestedSerial: "S2" }),
      (error) => error.code === "WORKFLOW_V2_DEVICE_SERIAL_MISMATCH",
    );
  });

  it("租约/绑定/验收快照不一致被拒绝", () => {
    assert.throws(
      () => assertDeviceLeaseBinding({ boundSerial: "S1", leasedSerial: "S2" }),
      (error) => error.code === "WORKFLOW_V2_DEVICE_LEASE_MISMATCH",
    );
    assert.throws(
      () => assertDeviceLeaseBinding({ boundSerial: "S1", leasedSerial: "S1", assessedSerial: "S3" }),
      (error) => error.code === "WORKFLOW_V2_DEVICE_ASSESSMENT_MISMATCH",
    );
  });

  it("绑定一致的租约放行并返回 serial", () => {
    const result = assertDeviceLeaseBinding({ boundSerial: "S1", leasedSerial: "S1", assessedSerial: "S1" });
    assert.equal(result.serial, "S1");
  });
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
