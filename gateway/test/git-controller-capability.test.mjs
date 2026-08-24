import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CAPABILITY_ROOT_ENV,
  createGitControllerCapabilityService,
  validateCapability,
} from "../services/devbench/git-controller-capability.js";
import { installBaseProtectionHooks } from "../services/devbench/base-protection-hooks.js";

const execFileAsync = promisify(execFile);
const testFile = fileURLToPath(import.meta.url);

if (process.argv[2] === "--validate-child") {
  const root = Buffer.from(process.argv[3], "base64url").toString("utf8");
  const context = JSON.parse(Buffer.from(process.argv[4], "base64url").toString("utf8"));
  process.env[CAPABILITY_ROOT_ENV] = root;
  const result = await validateCapability(context);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-controller-capability-"));
const capabilityRoot = path.join(root, "controller-data", "capabilities");
const fingerprint = "a".repeat(64);
const expectedHead = "1".repeat(40);
const candidateSha = "2".repeat(40);
const secureRuntimeRoot = process.platform === "win32"
  ? path.join(
      path.resolve(String(process.env.LOCALAPPDATA || "")),
      "DevBench Hooks Tests",
      `Capability Fixed Runtime ${process.pid}-${Date.now()}`,
    )
  : "";
const secureNodeBinary = process.platform === "win32"
  ? path.join(secureRuntimeRoot, "node-fixed.exe")
  : process.execPath;
if (process.platform === "win32") {
  fs.mkdirSync(secureRuntimeRoot, { recursive: true });
  fs.copyFileSync(process.execPath, secureNodeBinary);
}

function resolveTestExecutable(name) {
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE").split(";")
    : [""];
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.resolve(
        directory,
        process.platform === "win32" ? `${name}${extension.toLowerCase()}` : name,
      );
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
        return fs.realpathSync(candidate);
      }
    }
  }
  throw new Error(`test executable unavailable: ${name}`);
}

const runtimeExecutablePaths = Object.freeze({
  nodeBinary: secureNodeBinary,
  gitBinary: resolveTestExecutable("git"),
});

const service = createGitControllerCapabilityService({
  dataRoot: capabilityRoot,
  maxTtlMs: 30_000,
});

after(() => {
  const resolved = path.resolve(root);
  if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  if (secureRuntimeRoot) {
    try { fs.rmSync(secureRuntimeRoot, { recursive: true, force: true }); } catch {}
  }
});

function issue(overrides = {}) {
  return service.issue({
    operationId: `operation-${Date.now()}-${Math.random()}`,
    repositoryId: "repository-main",
    repositoryFingerprint: fingerprint,
    commandId: "base.merge-fast-forward",
    branch: "main",
    expectedHead,
    candidateSha,
    fencingToken: 108,
    ttlMs: 20_000,
    hookPhaseSequence: ["prepared", "committed", "aborted"],
    ...overrides,
  });
}

function referenceContext(token, phase, overrides = {}) {
  const defaultHead = phase === "committed" ? candidateSha : expectedHead;
  return {
    capability: token,
    repositoryFingerprint: fingerprint,
    branch: "main",
    head: defaultHead,
    hook: "reference-transaction",
    args: [phase],
    ...overrides,
  };
}

async function validateInChild(context) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    testFile,
    "--validate-child",
    Buffer.from(capabilityRoot, "utf8").toString("base64url"),
    Buffer.from(JSON.stringify(context), "utf8").toString("base64url"),
  ], {
    cwd: path.dirname(testFile),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, "");
  return JSON.parse(stdout.trim());
}

function git(repository, args, env = {}) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      ...env,
    },
  }).trim();
}

test("HMAC token rejects tampering without exposing token or secret", async () => {
  const token = await issue();
  const replacement = token.endsWith("A") ? "B" : "A";
  const tampered = `${token.slice(0, -1)}${replacement}`;
  const result = await service.validateCapability(referenceContext(tampered, "prepared"));
  assert.deepEqual(result, { ok: false, reason: "CAPABILITY_INVALID" });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.statSync(path.join(capabilityRoot, "capability.key")).size, 32);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(capabilityRoot, "capability.key")).mode & 0o077, 0);
  }
});

test("expired capability fails closed", async () => {
  const token = await issue({ ttlMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 70));
  const result = await service.validateCapability(referenceContext(token, "prepared"));
  assert.deepEqual(result, { ok: false, reason: "CAPABILITY_EXPIRED" });
});

test("repository fingerprint, branch and HEAD are exact bindings", async () => {
  const wrongRepositoryToken = await issue();
  assert.equal(
    (await service.validateCapability(referenceContext(wrongRepositoryToken, "prepared", {
      repositoryFingerprint: "b".repeat(64),
    }))).reason,
    "CAPABILITY_REPOSITORY_MISMATCH",
  );

  const wrongBranchToken = await issue();
  assert.equal(
    (await service.validateCapability(referenceContext(wrongBranchToken, "prepared", {
      branch: "release",
    }))).reason,
    "CAPABILITY_BRANCH_MISMATCH",
  );

  const wrongHeadToken = await issue();
  assert.equal(
    (await service.validateCapability(referenceContext(wrongHeadToken, "prepared", {
      head: "3".repeat(40),
    }))).reason,
    "CAPABILITY_HEAD_MISMATCH",
  );

  const wrongHookToken = await issue();
  assert.equal(
    (await service.validateCapability(referenceContext(wrongHookToken, "prepared", {
      hook: "pre-commit",
      args: [],
    }))).reason,
    "CAPABILITY_HOOK_MISMATCH",
  );

  const wrongPhaseToken = await issue();
  assert.equal(
    (await service.validateCapability(referenceContext(wrongPhaseToken, "unexpected"))).reason,
    "CAPABILITY_HOOK_MISMATCH",
  );
});

test("reference transaction accepts prepared then committed exactly once", async () => {
  const token = await issue();
  const prepared = await validateInChild(referenceContext(token, "prepared"));
  assert.deepEqual(prepared, {
    ok: true,
    reason: "CAPABILITY_PREPARED",
    terminal: false,
  });
  const committed = await validateInChild(referenceContext(token, "committed"));
  assert.deepEqual(committed, {
    ok: true,
    reason: "CAPABILITY_CONSUMED",
    terminal: true,
  });
  const replay = await validateInChild(referenceContext(token, "committed"));
  assert.deepEqual(replay, { ok: false, reason: "CAPABILITY_REPLAYED" });
});

test("reference terminal phase without prepared and duplicate prepared are rejected", async () => {
  const noPrepare = await issue();
  assert.equal(
    (await service.validateCapability(referenceContext(noPrepare, "committed"))).reason,
    "CAPABILITY_PHASE_INVALID",
  );

  const duplicate = await issue();
  assert.equal((await service.validateCapability(referenceContext(duplicate, "prepared"))).ok, true);
  assert.equal(
    (await service.validateCapability(referenceContext(duplicate, "prepared"))).reason,
    "CAPABILITY_REPLAYED",
  );
  assert.equal(
    (await service.validateCapability(referenceContext(duplicate, "aborted"))).ok,
    true,
  );
});

test("non-reference hook is bounded to one final consumption", async () => {
  const token = await issue({
    commandId: "base.commit",
    hookPhaseSequence: ["pre-commit"],
  });
  const context = {
    capability: token,
    repositoryFingerprint: fingerprint,
    branch: "main",
    head: expectedHead,
    hook: "pre-commit",
    args: [],
  };
  assert.deepEqual(await service.validateCapability(context), {
    ok: true,
    reason: "CAPABILITY_CONSUMED",
    terminal: true,
  });
  assert.deepEqual(await service.validateCapability(context), {
    ok: false,
    reason: "CAPABILITY_REPLAYED",
  });
});

test("real concurrent Node processes allow only one nonce consumer", async () => {
  const token = await issue({
    commandId: "base.commit",
    hookPhaseSequence: ["pre-commit"],
  });
  const context = {
    capability: token,
    repositoryFingerprint: fingerprint,
    branch: "main",
    head: expectedHead,
    hook: "pre-commit",
    args: [],
  };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => validateInChild(context)),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) => result.reason === "CAPABILITY_REPLAYED").length,
    9,
  );
});

test("managed reference-transaction hook consumes one token across real Git hook processes", async () => {
  const repository = path.join(root, "real-hook-repository");
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Capability Test"]);
  git(repository, ["config", "user.email", "capability@example.test"]);
  git(repository, ["checkout", "-b", "protected"]);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "first\n");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "-m", "first"]);
  const first = git(repository, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repository, "tracked.txt"), "second\n");
  git(repository, ["commit", "-am", "second"]);
  const second = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["branch", "-f", "protected-base", first]);
  git(repository, ["checkout", "protected-base"]);

  const installation = installBaseProtectionHooks(repository, {
    capabilityValidatorDescriptor: service.validatorDescriptor,
    runtimeExecutablePaths,
  });
  assert.equal(installation.status, "ACTIVE");
  const manifest = JSON.parse(fs.readFileSync(installation.manifestPath, "utf8"));
  const token = await issue({
    commandId: "base.update-ref",
    branch: "protected-base",
    expectedHead: first,
    candidateSha: second,
    repositoryFingerprint: manifest.repository.fingerprint,
  });
  git(repository, ["update-ref", "refs/heads/protected-base", second, first], {
    ...service.environment,
    DEVBENCH_BASE_PROTECTION_CAPABILITY: token,
  });
  assert.equal(git(repository, ["rev-parse", "HEAD"]), second);
  assert.deepEqual(await service.validateCapability({
    capability: token,
    repositoryFingerprint: manifest.repository.fingerprint,
    branch: "protected-base",
    head: second,
    hook: "reference-transaction",
    args: ["committed"],
  }), {
    ok: false,
    reason: "CAPABILITY_REPLAYED",
  });
});

test("missing root and drifted state fail closed", async () => {
  const previous = process.env[CAPABILITY_ROOT_ENV];
  delete process.env[CAPABILITY_ROOT_ENV];
  assert.deepEqual(await validateCapability({}), {
    ok: false,
    reason: "CAPABILITY_ROOT_UNAVAILABLE",
  });
  if (previous == null) delete process.env[CAPABILITY_ROOT_ENV];
  else process.env[CAPABILITY_ROOT_ENV] = previous;

  const token = await issue();
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const stateFiles = fs.readdirSync(path.join(capabilityRoot, "nonce-state"), {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const matching = stateFiles.find((entry) => {
    const candidate = path.join(entry.parentPath || entry.path, entry.name);
    return JSON.parse(fs.readFileSync(candidate, "utf8")).tokenDigest === tokenDigest;
  });
  assert.ok(matching);
  const statePath = path.join(matching.parentPath || matching.path, matching.name);
  fs.appendFileSync(statePath, "drift");
  const result = await service.validateCapability(referenceContext(token, "prepared"));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CAPABILITY_STATE_DRIFT");
});
