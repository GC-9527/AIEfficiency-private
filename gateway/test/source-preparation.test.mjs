import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSourcePreparationTarget,
  canonicalGitRemote,
  createSourcePreparationService,
  sourcePreparationGitArgs,
} from "../services/devbench/source-preparation.js";

const REMOTE_SSH = "git@example.test:vehicle/app-market.git";
const REMOTE_HTTPS = "https://example.test/vehicle/app-market.git";

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-preparation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeGitExecutor({ beforeClone, mutateClone, failClone } = {}) {
  const checkouts = new Map();
  const calls = [];
  let cloneCalls = 0;
  const key = (value) => path.resolve(value).toLowerCase();

  function register(checkoutPath, {
    origin = REMOTE_HTTPS,
    branch = "main",
    topLevel = checkoutPath,
  } = {}) {
    fs.mkdirSync(checkoutPath, { recursive: true });
    const checkout = {
      origin,
      branch,
      topLevel: path.resolve(topLevel),
    };
    checkouts.set(key(checkoutPath), checkout);
    fs.writeFileSync(path.join(checkoutPath, ".fake-checkout.json"), JSON.stringify({ origin, branch }));
  }

  function checkoutFor(checkoutPath) {
    const checkoutKey = key(checkoutPath);
    const registered = checkouts.get(checkoutKey);
    if (registered) return registered;
    try {
      const persisted = JSON.parse(fs.readFileSync(path.join(checkoutPath, ".fake-checkout.json"), "utf8"));
      const restored = { ...persisted, topLevel: path.resolve(checkoutPath) };
      checkouts.set(checkoutKey, restored);
      return restored;
    } catch {
      return null;
    }
  }

  async function executor(args, options = {}) {
    calls.push([...args]);
    if (args[0] === "clone") {
      cloneCalls += 1;
      const branch = args[args.indexOf("--branch") + 1];
      const remote = args.at(-2);
      const targetPath = args.at(-1);
      if (beforeClone) await beforeClone({ args, branch, remote, targetPath, cloneCalls });
      options.onStderr?.("Receiving objects: 42% (42/100)\n");
      if (failClone?.({ args, branch, remote, targetPath, cloneCalls })) {
        fs.mkdirSync(targetPath, { recursive: true });
        fs.writeFileSync(path.join(targetPath, "partial-clone"), "incomplete");
        return { ok: false, stderr: "simulated clone failure" };
      }
      const clone = { origin: remote, branch, topLevel: targetPath };
      if (mutateClone) mutateClone(clone, { args, targetPath });
      register(targetPath, clone);
      return { ok: true, stdout: "" };
    }

    if (args[0] !== "-C") return { ok: false, stderr: "unsupported fake Git command" };
    const checkoutPath = args[1];
    const command = args.slice(2);
    const checkout = checkoutFor(checkoutPath);
    if (!checkout) return { ok: false, stderr: "not a git repository" };
    if (command[0] === "rev-parse" && command[1] === "--show-toplevel") {
      return { ok: true, stdout: `${checkout.topLevel}\n` };
    }
    if (command[0] === "remote" && command[1] === "get-url" && command[2] === "origin") {
      return checkout.origin
        ? { ok: true, stdout: `${checkout.origin}\n` }
        : { ok: false, stderr: "origin missing" };
    }
    if (command[0] === "remote" && command[1] === "set-url" && command[2] === "origin") {
      checkout.origin = command[3];
      fs.writeFileSync(path.join(checkoutPath, ".fake-checkout.json"), JSON.stringify({
        origin: checkout.origin,
        branch: checkout.branch,
      }));
      return { ok: true, stdout: "" };
    }
    if (command[0] === "symbolic-ref") {
      return checkout.branch
        ? { ok: true, stdout: `${checkout.branch}\n` }
        : { ok: false, stderr: "detached HEAD" };
    }
    return { ok: false, stderr: "unsupported fake Git command" };
  }

  return {
    executor,
    register,
    calls,
    get cloneCalls() { return cloneCalls; },
  };
}

function request(cloneParent, branch = "release/8678", knownCheckouts = []) {
  return {
    cloneParent,
    target: { repositoryId: "appMarket", branch },
    repository: {
      id: "appMarket",
      ssh: REMOTE_SSH,
      https: REMOTE_HTTPS,
    },
    knownCheckouts,
  };
}

function runPreparationWorker(input) {
  const workerSource = `
    const { createSourcePreparationService } = await import(process.env.SOURCE_PREPARATION_MODULE_URL);
    const input = JSON.parse(process.env.SOURCE_PREPARATION_INPUT);
    const result = await createSourcePreparationService({ lockPollMs: 10 }).prepare(input);
    process.stdout.write(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
      windowsHide: true,
      env: {
        ...process.env,
        SOURCE_PREPARATION_MODULE_URL: new URL("../services/devbench/source-preparation.js", import.meta.url).href,
        SOURCE_PREPARATION_INPUT: JSON.stringify(input),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `source preparation worker exited with ${code}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`${error.message}: ${stdout}`)); }
    });
  });
}

test("stable cache target is keyed by repository and exact branch", (t) => {
  const root = temporaryRoot(t);
  const cloneParent = path.join(root, "clones");
  const first = buildSourcePreparationTarget({
    cloneParent,
    repositoryId: "appMarket",
    branch: "release/8678",
  });
  const same = buildSourcePreparationTarget({
    cloneParent,
    repositoryId: "appMarket",
    branch: "release/8678",
  });
  const otherBranch = buildSourcePreparationTarget({
    cloneParent,
    repositoryId: "appMarket",
    branch: "release/8155",
  });

  assert.equal(first.targetPath, same.targetPath);
  assert.equal(first.targetKey, same.targetKey);
  assert.notEqual(first.targetPath, otherBranch.targetPath);
  const relativeParts = path.relative(cloneParent, first.targetPath).split(path.sep);
  assert.deepEqual(relativeParts.slice(0, 2), ["SourceCache", "appMarket"]);
  assert.match(relativeParts[2], /^release_8678-[a-f\d]{16}$/);
  assert.equal(canonicalGitRemote(REMOTE_SSH), canonicalGitRemote(REMOTE_HTTPS));
  assert.throws(() => buildSourcePreparationTarget({
    cloneParent,
    repositoryId: "appMarket",
    branch: "release/8678",
  }, { hashTarget: () => "../escape" }), /path-safe token/);
});

test("Windows source preparation forces command-scoped long path support", () => {
  assert.deepEqual(
    sourcePreparationGitArgs(["clone", "remote", "target"], "win32"),
    ["-c", "core.longpaths=true", "clone", "remote", "target"],
  );
  assert.deepEqual(
    sourcePreparationGitArgs(["-c", "core.longpaths=true", "clone", "remote", "target"], "win32"),
    ["-c", "core.longpaths=true", "clone", "remote", "target"],
    "the hardening flag must remain idempotent",
  );
  assert.deepEqual(
    sourcePreparationGitArgs(["clone", "remote", "target"], "linux"),
    ["clone", "remote", "target"],
  );
});

test("Windows SourceCache can clone and checkout a tracked path beyond legacy MAX_PATH", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = temporaryRoot(t);
  const repository = path.join(root, "long-path-source");
  fs.mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.name", "Source Preparation Long Path"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "source-preparation-long-path@example.test"], { cwd: repository });
  const deepRelativePath = path.join(
    ...Array.from({ length: 6 }, (_, index) => `long-source-segment-${index}-${"x".repeat(28)}`),
    "WebAppVoiceControlAccTreeDebugOrRelease.kt",
  );
  const trackedFile = path.join(repository, deepRelativePath);
  assert.ok(trackedFile.length > 260, `fixture path must exceed MAX_PATH: ${trackedFile.length}`);
  fs.mkdirSync(path.dirname(trackedFile), { recursive: true });
  fs.writeFileSync(trackedFile, "long path fixture\n", "utf8");
  execFileSync("git", ["-c", "core.longpaths=true", "add", "--", deepRelativePath], { cwd: repository });
  execFileSync("git", ["-c", "core.longpaths=true", "commit", "-m", "deep tracked path"], {
    cwd: repository,
    stdio: "ignore",
    windowsHide: true,
  });

  const result = await createSourcePreparationService().prepare({
    cloneParent: path.join(root, "cache"),
    target: { repositoryId: "long-path-source", branch: "main" },
    repository: { id: "long-path-source", https: repository },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.existsSync(path.join(result.path, deepRelativePath)), true);
});

test("a valid stable checkout is reused only after Git, origin, and branch validation", async (t) => {
  const root = temporaryRoot(t);
  const harness = fakeGitExecutor();
  const service = createSourcePreparationService({ gitExecutor: harness.executor });
  const input = request(path.join(root, "clones"));
  const descriptor = service.describe(input);
  harness.register(descriptor.targetPath, { origin: REMOTE_HTTPS, branch: "release/8678" });

  const result = await service.prepare(input);
  assert.equal(result.ok, true);
  assert.equal(result.status, "reused");
  assert.equal(result.reused, true);
  assert.equal(result.cloned, false);
  assert.equal(result.source, "cache");
  assert.equal(result.path, descriptor.targetPath);
  assert.equal(harness.cloneCalls, 0);
  assert.equal(harness.calls.filter((args) => args[2] === "rev-parse").length, 1);
  assert.equal(harness.calls.filter((args) => args[2] === "remote").length, 1);
  assert.equal(harness.calls.filter((args) => args[2] === "symbolic-ref").length, 1);
});

test("an occupied stable path is rejected when it is not Git or has the wrong origin or branch", async (t) => {
  const root = temporaryRoot(t);
  const cases = [
    { name: "not Git", expectedReason: "not_git" },
    { name: "wrong origin", expectedReason: "origin_mismatch", checkout: { origin: "git@example.test:other/repo.git", branch: "release/8678" } },
    { name: "wrong branch", expectedReason: "branch_mismatch", checkout: { origin: REMOTE_HTTPS, branch: "release/8155" } },
  ];

  for (const [index, item] of cases.entries()) {
    const harness = fakeGitExecutor();
    const service = createSourcePreparationService({ gitExecutor: harness.executor });
    const input = request(path.join(root, `clones-${index}`));
    const descriptor = service.describe(input);
    fs.mkdirSync(descriptor.targetPath, { recursive: true });
    if (item.checkout) harness.register(descriptor.targetPath, item.checkout);

    const result = await service.prepare(input);
    assert.equal(result.ok, false, item.name);
    assert.equal(result.status, "rejected", item.name);
    assert.equal(result.code, "SOURCE_PREPARATION_EXISTING_INVALID", item.name);
    assert.equal(result.reason, item.expectedReason, item.name);
    assert.equal(harness.cloneCalls, 0, `${item.name}: an invalid occupied cache must never be overwritten`);
  }
});

test("known checkout candidates seed the stable cache when valid and are ignored when stale", async (t) => {
  const root = temporaryRoot(t);
  const candidate = path.join(root, "known", "app-market");
  const validHarness = fakeGitExecutor();
  validHarness.register(candidate, { origin: REMOTE_HTTPS, branch: "release/8678" });
  const validService = createSourcePreparationService({ gitExecutor: validHarness.executor });

  const reused = await validService.prepare(request(path.join(root, "valid-cache"), "release/8678", [
    { path: candidate, repositoryId: "appMarket", branch: "release/8678" },
  ]));
  assert.equal(reused.ok, true);
  assert.equal(reused.status, "cloned");
  assert.equal(reused.source, "known-checkout");
  assert.equal(reused.candidatePath, path.resolve(candidate));
  assert.equal(reused.path, reused.targetPath, "known checkout must seed, not replace, the stable SourceCache path");
  assert.equal(validHarness.cloneCalls, 1);

  const staleHarness = fakeGitExecutor();
  staleHarness.register(candidate, { origin: REMOTE_HTTPS, branch: "release/8155" });
  const staleService = createSourcePreparationService({ gitExecutor: staleHarness.executor });
  const cloned = await staleService.prepare(request(path.join(root, "stale-cache"), "release/8678", [candidate]));
  assert.equal(cloned.ok, true);
  assert.equal(cloned.status, "cloned");
  assert.equal(cloned.source, "remote");
  assert.equal(cloned.candidateRejections[0].reason, "branch_mismatch");
  assert.equal(staleHarness.cloneCalls, 1);
  assert.equal(cloned.path, cloned.targetPath);
});

test("concurrent requests for one target share a single clone and later calls reuse the cache", async (t) => {
  const root = temporaryRoot(t);
  const cloneGate = deferred();
  const cloneStarted = deferred();
  const harness = fakeGitExecutor({
    beforeClone: async () => {
      cloneStarted.resolve();
      await cloneGate.promise;
    },
  });
  const service = createSourcePreparationService({ gitExecutor: harness.executor });
  const input = request(path.join(root, "clones"));
  const firstProgress = [];
  const secondProgress = [];

  const first = service.prepare({ ...input, onProgress: (progress) => firstProgress.push(progress) });
  const second = service.prepare({ ...input, onProgress: (progress) => secondProgress.push(progress) });
  await cloneStarted.promise;
  assert.equal(service.inFlightCount(), 1);
  assert.equal(harness.cloneCalls, 1);
  cloneGate.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "cloned");
  assert.equal(secondResult.status, "cloned");
  assert.equal(firstResult.path, secondResult.path);
  assert.equal(harness.cloneCalls, 1);
  assert.equal(firstProgress.some((progress) => progress.percent === 42), true);
  assert.equal(secondProgress.some((progress) => progress.percent === 42), true,
    "every coalesced caller must receive progress from the shared clone");
  assert.equal(service.inFlightCount(), 0);

  const reused = await service.prepare(input);
  assert.equal(reused.status, "reused");
  assert.equal(reused.source, "cache");
  assert.equal(harness.cloneCalls, 1);
});

test("a clone executor success is still rejected when the resulting checkout fails validation", async (t) => {
  const root = temporaryRoot(t);
  const harness = fakeGitExecutor({
    mutateClone: (clone) => { clone.branch = "unexpected"; },
  });
  const service = createSourcePreparationService({ gitExecutor: harness.executor });
  const result = await service.prepare(request(path.join(root, "clones")));

  assert.equal(result.ok, false);
  assert.equal(result.code, "SOURCE_PREPARATION_CLONE_INVALID");
  assert.equal(result.reason, "branch_mismatch");
  assert.equal(harness.cloneCalls, 1);
});

test("separate service instances serialize through a filesystem lock and never clone into the stable path", async (t) => {
  const root = temporaryRoot(t);
  const cloneGate = deferred();
  const cloneStarted = deferred();
  const harness = fakeGitExecutor({
    beforeClone: async () => {
      cloneStarted.resolve();
      await cloneGate.promise;
    },
  });
  const options = {
    gitExecutor: harness.executor,
    lockPollMs: 5,
    lockWaitMs: 2000,
    lockStaleMs: 1000,
  };
  const firstService = createSourcePreparationService(options);
  const secondService = createSourcePreparationService(options);
  const input = request(path.join(root, "clones"));
  const descriptor = firstService.describe(input);
  const secondProgress = [];

  const first = firstService.prepare(input);
  await cloneStarted.promise;
  const second = secondService.prepare({ ...input, onProgress: (progress) => secondProgress.push(progress) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.cloneCalls, 1, "a second Gateway must wait instead of starting another clone");
  cloneGate.resolve();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, "cloned");
  assert.equal(secondResult.status, "reused");
  assert.equal(secondResult.contended, true);
  assert.equal(harness.cloneCalls, 1);
  assert.equal(secondProgress.some((progress) => progress.phase.includes("其它 Gateway")), true);
  const cloneCall = harness.calls.find((args) => args[0] === "clone");
  assert.notEqual(path.resolve(cloneCall.at(-1)), path.resolve(descriptor.targetPath));
  assert.match(path.basename(cloneCall.at(-1)), /\.preparing-/);
  assert.equal(fs.existsSync(descriptor.targetPath), true);
});

test("failed clones remove their private temporary directory and a retry can publish the cache", async (t) => {
  const root = temporaryRoot(t);
  const harness = fakeGitExecutor({ failClone: ({ cloneCalls }) => cloneCalls === 1 });
  const service = createSourcePreparationService({ gitExecutor: harness.executor });
  const input = request(path.join(root, "clones"));
  const descriptor = service.describe(input);

  const failed = await service.prepare(input);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "SOURCE_PREPARATION_CLONE_FAILED");
  assert.equal(fs.existsSync(descriptor.targetPath), false, "a failed clone must never occupy the stable cache path");
  const parentEntries = fs.readdirSync(path.dirname(descriptor.targetPath));
  assert.equal(parentEntries.some((name) => name.includes(".preparing-") || name.endsWith(".prepare.lock")), false);

  const retried = await service.prepare(input);
  assert.equal(retried.ok, true);
  assert.equal(retried.status, "cloned");
  assert.equal(fs.existsSync(descriptor.targetPath), true);
  assert.equal(harness.cloneCalls, 2);
});

test("a crashed owner lock and stale private clone directory are reclaimed without touching the stable path", async (t) => {
  const root = temporaryRoot(t);
  const harness = fakeGitExecutor();
  const service = createSourcePreparationService({
    gitExecutor: harness.executor,
    lockPollMs: 5,
    lockWaitMs: 1000,
    lockStaleMs: 100,
    ownerHost: "test-host",
    processAlive: () => false,
  });
  const input = request(path.join(root, "clones"));
  const descriptor = service.describe(input);
  const lockPath = `${descriptor.targetPath}.prepare.lock`;
  const staleTemporaryPath = `${descriptor.targetPath}.preparing-dead-owner`;
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ host: "test-host", pid: 999999, ownerId: "dead" }));
  fs.mkdirSync(staleTemporaryPath, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  fs.utimesSync(staleTemporaryPath, old, old);

  const result = await service.prepare(input);
  assert.equal(result.ok, true);
  assert.equal(result.status, "cloned");
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(staleTemporaryPath), false);
  assert.equal(fs.existsSync(descriptor.targetPath), true);
});

test("independent Node processes share the same cache without concurrently cloning the final path", async (t) => {
  const root = temporaryRoot(t);
  const repository = path.join(root, "remote-repository");
  fs.mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore", windowsHide: true });
  execFileSync("git", ["config", "user.name", "Source Preparation Worker"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "source-preparation-worker@example.test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "README.md"), "cross process source cache\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repository, stdio: "ignore", windowsHide: true });
  const input = {
    cloneParent: path.join(root, "clones"),
    target: { repositoryId: "cross-process-repository", branch: "main" },
    repository: { id: "cross-process-repository", https: repository },
  };

  const [first, second] = await Promise.all([runPreparationWorker(input), runPreparationWorker(input)]);
  assert.equal(first.ok, true, first.error);
  assert.equal(second.ok, true, second.error);
  assert.deepEqual([first.status, second.status].sort(), ["cloned", "reused"]);
  assert.equal(path.resolve(first.path), path.resolve(second.path));
  assert.equal(fs.existsSync(path.join(first.path, "README.md")), true);
  const parentEntries = fs.readdirSync(path.dirname(first.path));
  assert.equal(parentEntries.some((name) => name.includes(".preparing-") || name.endsWith(".prepare.lock")), false);
});
