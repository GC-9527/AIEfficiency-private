import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-operation-journal-"));
const moduleUrl = new URL("../services/devbench/workflow-v2/controlled-operation-journal.js", import.meta.url).href;

const childSource = String.raw`
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const { createWorkflowV2ControlledOperationJournal } = await import(process.env.TEST_JOURNAL_MODULE);

const storyDirectory = process.env.TEST_STORY_DIRECTORY;
const startedPath = process.env.TEST_STARTED_PATH;
const releasePath = process.env.TEST_RELEASE_PATH;
const actionLogPath = process.env.TEST_ACTION_LOG_PATH;
fs.mkdirSync(storyDirectory, { recursive: true });

function validateTarget(targetPath, { baseDirectory = storyDirectory, createDirectory = false, mustExist = false, expectedType = "" } = {}) {
  const base = path.resolve(baseDirectory);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("path escape");
  let current = base;
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink base");
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink target");
  }
  if (createDirectory && !fs.existsSync(target)) {
    try { fs.mkdirSync(target); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (mustExist && !fs.existsSync(target)) throw new Error("missing target");
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error("symlink leaf");
    if (expectedType === "directory" && !stat.isDirectory()) throw new Error("not directory");
    if (expectedType === "file" && !stat.isFile()) throw new Error("not file");
  }
  return target;
}

const journal = createWorkflowV2ControlledOperationJournal({ storyDirectory, validateTarget });
const operationArgs = { executionSha256: "b".repeat(64) };
const identity = {
  operationId: "cross-process-operation",
  receiptId: "cross-process-receipt",
  operationArgsSha256: createHash("sha256").update(JSON.stringify(operationArgs)).digest("hex")
};
try {
  const reservation = journal.reserve(identity);
  if (reservation.kind === "SETTLED") process.exit(24);
  if (reservation.kind !== "RESERVED") process.exit(31);
  fs.appendFileSync(actionLogPath, process.pid + "\n", "utf8");
  fs.writeFileSync(startedPath, String(process.pid), { flag: "wx" });
  if (process.env.TEST_CRASH_AFTER_ACTION === "1") process.exit(22);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(releasePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!fs.existsSync(releasePath)) process.exit(32);
  journal.settle(reservation, {
    operationArgs,
    output: "ok",
    payload: {
      schemaVersion: "evidence-receipt-v2",
      receiptId: identity.receiptId,
      action: "TEST",
      status: "PASS",
      toolName: "run_local_check",
      operationId: identity.operationId,
      idempotencyKey: identity.operationId,
      startedAt: "2026-08-08T08:00:00.000Z",
      finishedAt: "2026-08-08T08:00:01.000Z"
    }
  });
  process.exit(0);
} catch (error) {
  if (error?.code === "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS") process.exit(23);
  process.stderr.write(String(error?.stack || error));
  process.exit(99);
}
`;

function runChild(env) {
  const state = { completed: false, result: null };
  const promise = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      state.completed = true;
      state.result = { code: null, signal: null, stderr, spawnError: error.message };
      reject(error);
    });
    child.on("exit", (code, signal) => {
      state.completed = true;
      state.result = { code, signal, stderr };
      resolve(state.result);
    });
  });
  promise.state = state;
  return promise;
}

async function waitForFile(pathname, children, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(pathname) && Date.now() < deadline) {
    const unexpected = children
      .map((child) => child.state)
      .find((state) => state.completed && ![23, 24].includes(state.result?.code));
    if (unexpected) {
      assert.fail(`child exited before creating ${pathname}: ${JSON.stringify(unexpected.result)}`);
    }
    if (children.every((child) => child.state.completed)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    fs.existsSync(pathname),
    true,
    `timed out waiting for ${pathname}; children=${JSON.stringify(children.map((child) => child.state.result))}`,
  );
}

test("two Node processes acquire one no-replace reservation and invoke the external action once", async () => {
  const storyDirectory = path.join(tempRoot, "story");
  const startedPath = path.join(tempRoot, "started");
  const releasePath = path.join(tempRoot, "release");
  const actionLogPath = path.join(tempRoot, "external-actions.log");
  const env = {
    TEST_JOURNAL_MODULE: moduleUrl,
    TEST_STORY_DIRECTORY: storyDirectory,
    TEST_STARTED_PATH: startedPath,
    TEST_RELEASE_PATH: releasePath,
    TEST_ACTION_LOG_PATH: actionLogPath,
  };
  const first = runChild(env);
  const second = runChild(env);
  await waitForFile(startedPath, [first, second]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(releasePath, "release", { flag: "wx" });
  const results = await Promise.all([first, second]);
  const exitCodes = results.map((entry) => entry.code).sort((a, b) => a - b);
  assert.equal(exitCodes[0], 0, JSON.stringify(results));
  assert.equal([23, 24].includes(exitCodes[1]), true, JSON.stringify(results));
  const actions = fs.readFileSync(actionLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(actions.length, 1);
});

test("a process crash after the external action but before settlement stays ambiguous and never re-executes", async () => {
  const storyDirectory = path.join(tempRoot, "crash-story");
  const startedPath = path.join(tempRoot, "crash-started");
  const releasePath = path.join(tempRoot, "crash-release-unused");
  const actionLogPath = path.join(tempRoot, "crash-external-actions.log");
  const env = {
    TEST_JOURNAL_MODULE: moduleUrl,
    TEST_STORY_DIRECTORY: storyDirectory,
    TEST_STARTED_PATH: startedPath,
    TEST_RELEASE_PATH: releasePath,
    TEST_ACTION_LOG_PATH: actionLogPath,
  };

  const crashed = await runChild({ ...env, TEST_CRASH_AFTER_ACTION: "1" });
  assert.equal(crashed.code, 22, crashed.stderr);
  const retry = await runChild(env);
  assert.equal(retry.code, 23, retry.stderr);
  const actions = fs.readFileSync(actionLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(actions.length, 1);
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
