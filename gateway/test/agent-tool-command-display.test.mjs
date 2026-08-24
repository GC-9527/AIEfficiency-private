import { test } from "node:test";
import assert from "node:assert/strict";
import { __testFormatClaudeToolUse, resolveAgentWorkingDirectory } from "../services/agent-runner.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Claude 工具命令向聊天框实时发送并完整保存，不再截断 512 字符", () => {
  const command = `powershell -Command "${"Write-Output 'story-worktree'; ".repeat(40)}"`;
  assert.ok(command.length > 512);

  const formatted = __testFormatClaudeToolUse("PowerShell", { command, cwd: "D:\\story-worktree" });

  assert.equal(formatted.toolName, "PowerShell");
  assert.ok(formatted.liveLabel.startsWith("PowerShell\n{"));
  assert.match(formatted.liveLabel, /story-worktree/);
  assert.equal(JSON.parse(formatted.fullInput).command, command);
  assert.equal(formatted.fullInput.includes("已截断"), false);
});

test("故事点任务的 worktree cwd 缺失或为相对路径时禁止回退到 Gateway 目录", () => {
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), "story-cwd-"));
  try {
    assert.equal(resolveAgentWorkingDirectory({ storyScoped: true, cwd: existing }, {}), existing);
    assert.throws(
      () => resolveAgentWorkingDirectory({ storyScoped: true, cwd: "." }, { workDir: existing }),
      (error) => error?.code === "STORY_WORKTREE_CWD_INVALID",
    );
    assert.throws(
      () => resolveAgentWorkingDirectory({ storyScoped: true, cwd: path.join(existing, "missing") }, { workDir: existing }),
      (error) => error?.code === "STORY_WORKTREE_CWD_INVALID",
    );
  } finally {
    fs.rmSync(existing, { recursive: true, force: true });
  }
});
