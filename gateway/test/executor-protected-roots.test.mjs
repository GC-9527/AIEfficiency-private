import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "executor-protected-"));
const base = path.join(root, "base");
const ordinary = path.join(root, "ordinary");
const cloneParent = path.join(root, "clone-parent");
const controllerRoot = path.join(cloneParent, ".devbench", "git-controller");
for (const directory of [base, ordinary, controllerRoot]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(base, "readme.txt"), "protected base", "utf8");

process.env.NODE_ENV = "production";
process.env.GATEWAY_CONFIG_PATH = path.join(root, "gateway.json");
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");
process.env.DEVBENCH_CONFIG_PATH = path.join(root, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(root, "devbench-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(root, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = cloneParent;

fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
  executor: {
    enabled: true,
    allowedRoots: [base, ordinary, root, controllerRoot],
  },
  distributedExecution: { commandPolicy: "trusted" },
}), "utf8");
fs.writeFileSync(process.env.DEVBENCH_CONFIG_PATH, "{}", "utf8");
fs.writeFileSync(process.env.DEVBENCH_LOCAL_PROJECTS_PATH, JSON.stringify({
  version: 2,
  cloneParent,
  projects: [{ id: "base", name: "Base", path: base, webAppPath: "" }],
}), "utf8");

const {
  classifyProtectedExecutionRoot,
  runTool,
} = await import("../services/executor.js");
const { default: database } = await import("../db/sqlite.js");

after(() => {
  try { database.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

test("生产 Executor 可读基础仓，但拒绝所有 Gateway 身份写入口", async () => {
  assert.equal(classifyProtectedExecutionRoot(base)?.kind, "base");
  const read = await runTool(base, "read_file", { path: "readme.txt" }, {
    commandPolicy: "read_only",
  });
  assert.equal(read.ok, true, read.error);
  assert.match(String(read.result), /protected base/);

  for (const name of ["write_file", "apply_patch", "run_command", "start_process"]) {
    const result = await runTool(base, name, name === "write_file"
      ? { path: "forbidden.txt", content: "no" }
      : name === "apply_patch"
        ? { patch: "*** Begin Patch\n*** Add File: forbidden.txt\n+no\n*** End Patch\n" }
        : { command: `${JSON.stringify(process.execPath)} --version` });
    assert.equal(result.ok, false, `${name} should be blocked`);
    assert.equal(result.code, "EXECUTOR_PROTECTED_REPOSITORY_MUTATION_FORBIDDEN");
  }
  assert.equal(fs.existsSync(path.join(base, "forbidden.txt")), false);
});

test("包含基础仓的父 root 与 Controller 数据目录同样不可作为自由 shell 根", async () => {
  const parent = await runTool(root, "run_command", {
    command: `${JSON.stringify(process.execPath)} --version`,
  });
  assert.equal(parent.ok, false);
  assert.equal(parent.code, "EXECUTOR_PROTECTED_REPOSITORY_MUTATION_FORBIDDEN");

  const controller = await runTool(controllerRoot, "write_file", {
    path: "forbidden.txt",
    content: "no",
  });
  assert.equal(controller.ok, false);
  assert.equal(controller.code, "EXECUTOR_PROTECTED_REPOSITORY_MUTATION_FORBIDDEN");
});

test("未受保护且精确登记的普通根仍可执行受限写工具", async () => {
  const result = await runTool(ordinary, "write_file", {
    path: "ok.txt",
    content: "ordinary",
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(ordinary, "ok.txt"), "utf8"), "ordinary");
});
