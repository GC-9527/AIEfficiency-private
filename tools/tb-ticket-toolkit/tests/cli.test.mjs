import assert from "node:assert/strict";
import test from "node:test";

import { ToolkitError } from "../packages/tb-domain/src/index.js";
import { EXIT_CODES, runCli } from "../apps/tbfix-cli/src/cli.js";

function io() {
  let out = "";
  let error = "";
  return {
    stdout: (value) => { out += value; }, stderr: (value) => { error += value; },
    get out() { return out; }, get error() { return error; },
  };
}

function runtime(application, close = async () => {}) {
  return { application, close };
}

test("CLI 四个附件返回稳定输入等待退出码和机器可读候选", async () => {
  const streams = io();
  let closed = 0;
  const code = await runCli(["ticket", "prepare", "CARB-1", "--repo", "D:/arbitrary/repo", "--json"], {
    stdout: streams.stdout, stderr: streams.stderr,
    bootstrap: async (options) => {
      assert.equal(options.repoPath, "D:/arbitrary/repo");
      return runtime({
        async prepare() {
          return {
            state: "NEEDS_ATTACHMENT_SELECTION", task: { taskNo: "CARB-1" }, downloads: [],
            choices: Array.from({ length: 4 }, (_, index) => ({ index: index + 1, attachmentId: `file-${index + 1}`, name: `file-${index + 1}.log` })),
          };
        },
      }, async () => { closed += 1; });
    },
  });
  assert.equal(code, EXIT_CODES.INPUT_REQUIRED);
  assert.equal(JSON.parse(streams.out).state, "NEEDS_ATTACHMENT_SELECTION");
  assert.equal(streams.error, "");
  assert.equal(closed, 1);
});

test("CLI 将附件编号映射为稳定 ID，并仅向统一 application 传递一次选择", async () => {
  const streams = io();
  let preparedInput;
  const code = await runCli(["ticket", "prepare", "CARB-1", "--attachments", "1,3", "--json"], {
    cwd: "D:/fixture", stdout: streams.stdout, stderr: streams.stderr,
    bootstrap: async () => runtime({
      async readContext() { return { context: { attachments: [{ attachmentId: "a" }, { attachmentId: "b" }, { attachmentId: "c" }] } }; },
      async prepare(input) { preparedInput = input; return { state: "READY", task: { taskNo: "CARB-1" }, downloads: [] }; },
    }),
  });
  assert.equal(code, EXIT_CODES.OK);
  assert.deepEqual(preparedInput.selection, { mode: "selected", attachmentIds: ["a", "c"] });
});

test("CLI apply 强制 write profile 和显式 --apply，且输出 operation 状态", async () => {
  const streams = io();
  let bootstrapProfile;
  let applied;
  const code = await runCli([
    "update", "apply", "--plan", "plan-1", "--fingerprint", "a".repeat(64), "--idempotency-key", "idem-key", "--apply", "--json",
  ], {
    stdout: streams.stdout, stderr: streams.stderr,
    bootstrap: async ({ profile }) => {
      bootstrapProfile = profile;
      return runtime({ async updateApply(input) { applied = input; return { operationId: "operation-1", state: "COMPLETED" }; } });
    },
  });
  assert.equal(code, EXIT_CODES.OK);
  assert.equal(bootstrapProfile, "write");
  assert.equal(applied.apply, true);
  assert.equal(JSON.parse(streams.out).state, "COMPLETED");
});

test("CLI 错误保持 stdout/stderr 约定并移除凭据值", async () => {
  const jsonStreams = io();
  const jsonCode = await runCli(["workflow", "get", "CARB-1", "--json"], {
    stdout: jsonStreams.stdout, stderr: jsonStreams.stderr,
    bootstrap: async () => { throw new ToolkitError("AUTH_REQUIRED", "Authorization: Bearer secret at https://file.invalid/a?signature=secret"); },
  });
  assert.equal(jsonCode, EXIT_CODES.AUTH_REQUIRED);
  assert.equal(JSON.parse(jsonStreams.out).error.code, "AUTH_REQUIRED");
  assert.doesNotMatch(jsonStreams.out, /Bearer secret|signature=secret|file\.invalid/i);
  assert.equal(jsonStreams.error, "");

  const humanStreams = io();
  const humanCode = await runCli(["workflow", "get"], {
    stdout: humanStreams.stdout, stderr: humanStreams.stderr,
    bootstrap: async () => runtime({}),
  });
  assert.equal(humanCode, EXIT_CODES.INVALID_ARGUMENT);
  assert.equal(humanStreams.out, "");
  assert.match(humanStreams.error, /taskRef/);
});

