import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import {
  createSignedWorkerLeaseRelease,
  createSignedWorkerLaunchEnvelope,
  launcherEnvelopeSigningBytes,
} from "../services/worker-isolation.js";
import {
  consumeWorkerLaunchNonce,
  garbageCollectWorkerLaunchNonces,
  issueWorkerLaunchNonce,
  verifyWorkerLaunchConsumptionReceipt as verifyControllerReceipt,
} from "../services/worker-launch-consume-helper.mjs";
import {
  awaitWorkerLeaseRelease,
  verifySignedWorkerLaunchEnvelope,
  verifyWorkerLaunchConsumptionReceipt as verifyBrokerReceipt,
} from "../services/isolated-worker-broker.mjs";

process.env.NODE_ENV = "test";
const LAUNCHER_INSTANCE_EVIDENCE = Buffer.alloc(32, 0x5a).toString("base64url");
const OTHER_LAUNCHER_INSTANCE_EVIDENCE = Buffer.alloc(32, 0x6b).toString("base64url");

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/worker-launch-nonce-consume-child.mjs",
);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-launch-nonce-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = path.join(root, "private.pem");
  const publicKeyPath = path.join(root, "public.pem");
  fs.writeFileSync(
    privateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  const options = {
    root,
    testPrivateKey: privateKey,
    testPublicKey: publicKey,
    aclVerifier: () => true,
    launcherInstanceEvidence: LAUNCHER_INSTANCE_EVIDENCE,
  };
  return {
    root,
    privateKey,
    publicKey,
    privateKeyPath,
    publicKeyPath,
    options,
  };
}

function envelopeFor(privateKey, {
  taskId = "task-1",
  workerIdentity = "uid:1001",
  now = Date.now(),
  ttlMs = 30_000,
  releaseChallenge = "",
} = {}) {
  return createSignedWorkerLaunchEnvelope({
    taskId,
    operation: "cli",
    ...(releaseChallenge ? { releaseChallenge } : {}),
    command: "codex",
    args: ["exec", "-"],
    cwd: process.cwd(),
    expectedIdentity: workerIdentity,
    identityScope: "per-story",
    gatewayIdentity: "uid:1000",
    grant: {
      version: 2,
      storyId: "CARB-1",
      workerIdentity,
    },
    readOnly: false,
  }, {
    now,
    ttlMs,
    payloadExpiresAt: new Date(now + ttlMs).toISOString(),
    testSigningPrivateKey: privateKey,
  });
}

function resignEnvelopeWithTaskId(encoded, taskId, privateKey) {
  const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8"));
  envelope.payload = Buffer.from(JSON.stringify({ ...payload, taskId }), "utf8").toString("base64url");
  envelope.signature = sign(
    null,
    launcherEnvelopeSigningBytes(envelope),
    privateKey,
  ).toString("base64url");
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function runConsumer(jobPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, jobPath], {
      windowsHide: true,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`nonce child exit=${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("同进程重复消费失败，receipt 同时通过 Controller 与 broker 的完整绑定验证", (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey);
  const challenge = randomBytes(32);
  issueWorkerLaunchNonce(envelope, tree.options);
  const receipt = consumeWorkerLaunchNonce(envelope, challenge, tree.options);

  assert.equal(
    verifyControllerReceipt(receipt, {
      encodedEnvelope: envelope,
      challenge,
      launcherInstanceEvidence: LAUNCHER_INSTANCE_EVIDENCE,
      testPublicKey: tree.publicKey,
    }).taskId,
    "task-1",
  );
  assert.equal(
    verifyBrokerReceipt(receipt, {
      encodedEnvelope: envelope,
      challenge,
      launcherInstanceEvidence: LAUNCHER_INSTANCE_EVIDENCE,
      testTrustAnchor: tree.publicKey,
    }).storyId,
    "CARB-1",
  );
  assert.throws(
    () => consumeWorkerLaunchNonce(envelope, randomBytes(32), tree.options),
    (error) => error.code === "WORKER_LAUNCH_NONCE_REPLAYED",
  );
});

test("launcher A 的 release 不能放行 broker B，且失败不会消费 nonce", async (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, {
    taskId: "task-instance-binding",
    releaseChallenge: "77777777-7777-4777-8777-777777777777",
  });
  issueWorkerLaunchNonce(envelope, tree.options);
  const verifiedLaunch = verifySignedWorkerLaunchEnvelope(envelope, {
    testTrustAnchor: tree.publicKey,
  });
  const releaseA = createSignedWorkerLeaseRelease(envelope, {
    leaseId: "lease:launcher-a",
    launcherPid: 4321,
    launcherProcessIdentity: "win:638920000000000001",
    launcherInstanceEvidence: LAUNCHER_INSTANCE_EVIDENCE,
    testSigningPrivateKey: tree.privateKey,
  });
  const brokerBStream = new PassThrough();
  const brokerB = awaitWorkerLeaseRelease(verifiedLaunch, {
    stream: brokerBStream,
    timeoutMs: 1000,
    launcherInstanceEvidence: OTHER_LAUNCHER_INSTANCE_EVIDENCE,
    testTrustAnchor: tree.publicKey,
  });
  brokerBStream.end(`RELEASE:${releaseA}\nprompt`);
  await assert.rejects(
    brokerB,
    (error) => error.code === "WORKER_LEASE_RELEASE_INSTANCE_MISMATCH",
  );

  const challenge = randomBytes(32);
  const receipt = consumeWorkerLaunchNonce(envelope, challenge, {
    ...tree.options,
    launcherInstanceEvidence: OTHER_LAUNCHER_INSTANCE_EVIDENCE,
  });
  assert.equal(
    verifyBrokerReceipt(receipt, {
      encodedEnvelope: envelope,
      challenge,
      launcherInstanceEvidence: OTHER_LAUNCHER_INSTANCE_EVIDENCE,
      testTrustAnchor: tree.publicKey,
    }).taskId,
    "task-instance-binding",
  );
});

test("两个独立进程并发消费同一 envelope 时只有一个成功", async (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-concurrent" });
  issueWorkerLaunchNonce(envelope, tree.options);
  const challenges = [randomBytes(32), randomBytes(32)];
  const jobs = challenges.map((challenge, index) => {
    const jobPath = path.join(tree.root, `job-${index}.json`);
    fs.writeFileSync(jobPath, JSON.stringify({
      root: tree.root,
      envelope,
      challenge: challenge.toString("base64url"),
      privateKeyPath: tree.privateKeyPath,
      publicKeyPath: tree.publicKeyPath,
      launcherInstanceEvidence: LAUNCHER_INSTANCE_EVIDENCE,
    }), { mode: 0o600 });
    return jobPath;
  });

  const results = await Promise.all(jobs.map(runConsumer));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.code),
    ["WORKER_LAUNCH_NONCE_REPLAYED"],
  );
  const winnerIndex = results.findIndex((result) => result.ok);
  assert.equal(
    verifyBrokerReceipt(results[winnerIndex].receipt, {
      encodedEnvelope: envelope,
      challenge: challenges[winnerIndex],
      launcherInstanceEvidence: LAUNCHER_INSTANCE_EVIDENCE,
      testTrustAnchor: tree.publicKey,
    }).taskId,
    "task-concurrent",
  );
});

test("原子消费后崩溃不会回滚，重启重试仍按 replay 失败", (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-crash" });
  issueWorkerLaunchNonce(envelope, tree.options);
  assert.throws(
    () => consumeWorkerLaunchNonce(envelope, randomBytes(32), {
      ...tree.options,
      testCrashAfterConsume: true,
    }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_TEST_CRASH",
  );
  assert.throws(
    () => consumeWorkerLaunchNonce(envelope, randomBytes(32), tree.options),
    (error) => error.code === "WORKER_LAUNCH_NONCE_REPLAYED",
  );
  const consumedFiles = fs.readdirSync(tree.root)
    .filter((name) => name.endsWith(".consumed.json"));
  assert.equal(consumedFiles.length, 1);
});

test("同 nonce 的 story/task/worker/payload 漂移在原子消费前失败关闭", (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-original" });
  issueWorkerLaunchNonce(envelope, tree.options);
  const drifted = resignEnvelopeWithTaskId(envelope, "task-drifted", tree.privateKey);
  assert.throws(
    () => consumeWorkerLaunchNonce(drifted, randomBytes(32), tree.options),
    (error) => error.code === "WORKER_LAUNCH_NONCE_STATE_DRIFT",
  );
  const challenge = randomBytes(32);
  const receipt = consumeWorkerLaunchNonce(envelope, challenge, tree.options);
  assert.equal(
    verifyControllerReceipt(receipt, {
      encodedEnvelope: envelope,
      challenge,
      launcherInstanceEvidence: LAUNCHER_INSTANCE_EVIDENCE,
      testPublicKey: tree.publicKey,
    }).payloadSha256,
    createHash("sha256")
      .update(Buffer.from(
        JSON.parse(Buffer.from(envelope, "base64url").toString("utf8")).payload,
        "base64url",
      ))
      .digest("hex"),
  );
});

test("GC 在 envelope 过期加最大时钟偏差前绝不回收 issued/consumed state", (t) => {
  const tree = fixture(t);
  const now = Date.now();
  const issuedEnvelope = envelopeFor(tree.privateKey, {
    taskId: "task-gc-issued",
    now,
    ttlMs: 10_000,
  });
  const consumedEnvelope = envelopeFor(tree.privateKey, {
    taskId: "task-gc-consumed",
    now,
    ttlMs: 10_000,
  });
  issueWorkerLaunchNonce(issuedEnvelope, { ...tree.options, now });
  issueWorkerLaunchNonce(consumedEnvelope, { ...tree.options, now });
  consumeWorkerLaunchNonce(consumedEnvelope, randomBytes(32), {
    ...tree.options,
    now: now + 100,
  });

  assert.deepEqual(
    garbageCollectWorkerLaunchNonces({
      ...tree.options,
      now: now + 14_999,
    }),
    { archived: 0, skipped: false },
  );
  assert.equal(
    fs.readdirSync(tree.root).filter((name) => (
      name.endsWith(".issued.json") || name.endsWith(".consumed.json")
    )).length,
    2,
  );
  assert.deepEqual(
    garbageCollectWorkerLaunchNonces({
      ...tree.options,
      now: now + 15_000,
    }),
    { archived: 2, skipped: false },
  );
  assert.equal(
    fs.readdirSync(tree.root).filter((name) => (
      name.endsWith(".issued.json")
      || name.endsWith(".consumed.json")
      || name.endsWith(".archiving.json")
    )).length,
    0,
  );
  assert.equal(
    fs.readdirSync(tree.root).filter((name) => name.startsWith("audit-")).length,
    1,
  );
});

test("未过期 state 达容量上限时拒绝新签发，过期 GC 后恢复容量", (t) => {
  const tree = fixture(t);
  const now = Date.now();
  const first = envelopeFor(tree.privateKey, {
    taskId: "task-capacity-1",
    now,
    ttlMs: 10_000,
  });
  const second = envelopeFor(tree.privateKey, {
    taskId: "task-capacity-2",
    now,
    ttlMs: 10_000,
  });
  const limits = { maxStateFiles: 1, maxAuditFiles: 2, maxAuditRecords: 1 };
  issueWorkerLaunchNonce(first, { ...tree.options, ...limits, now });
  assert.throws(
    () => issueWorkerLaunchNonce(second, { ...tree.options, ...limits, now }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_CAPACITY_EXCEEDED",
  );

  const later = now + 15_001;
  const replacement = envelopeFor(tree.privateKey, {
    taskId: "ta<REDACTED_API_KEY>",
    now: later,
    ttlMs: 10_000,
  });
  issueWorkerLaunchNonce(replacement, {
    ...tree.options,
    ...limits,
    now: later,
  });
  assert.equal(
    fs.readdirSync(tree.root).filter((name) => name.endsWith(".issued.json")).length,
    1,
  );
});

test("过期 consumed 审计按固定文件数轮转，ledger 与 audit 都保持有界", (t) => {
  const tree = fixture(t);
  const base = Date.now();
  const limits = { maxStateFiles: 4, maxAuditFiles: 2, maxAuditRecords: 1 };
  for (let index = 0; index < 3; index += 1) {
    const issuedAt = base + index * 20_000;
    const envelope = envelopeFor(tree.privateKey, {
      taskId: `task-audit-${index}`,
      now: issuedAt,
      ttlMs: 1_000,
    });
    issueWorkerLaunchNonce(envelope, {
      ...tree.options,
      ...limits,
      now: issuedAt,
    });
    consumeWorkerLaunchNonce(envelope, randomBytes(32), {
      ...tree.options,
      ...limits,
      now: issuedAt + 100,
    });
    garbageCollectWorkerLaunchNonces({
      ...tree.options,
      ...limits,
      now: issuedAt + 6_000,
    });
  }
  assert.equal(
    fs.readdirSync(tree.root).filter((name) => name.startsWith("audit-")).length,
    2,
  );
  assert.equal(
    fs.readdirSync(tree.root).filter((name) => (
      name.endsWith(".issued.json")
      || name.endsWith(".consumed.json")
      || name.endsWith(".archiving.json")
    )).length,
    0,
  );
});

test("nonce root 与固定密钥会验证完整父链 ACL，任一可变父目录都失败关闭", (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-parent-acl" });
  const deniedParent = path.resolve(path.dirname(tree.root)).toLowerCase();
  assert.throws(
    () => issueWorkerLaunchNonce(envelope, {
      ...tree.options,
      aclVerifier: (target) => path.resolve(target).toLowerCase() !== deniedParent,
    }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_ACL_UNSAFE",
  );

  const keyParent = path.resolve(tree.root).toLowerCase();
  assert.throws(
    () => issueWorkerLaunchNonce(envelope, {
      root: tree.root,
      testPrivateKeyPath: tree.privateKeyPath,
      testPublicKeyPath: tree.publicKeyPath,
      aclVerifier: (target, context) => !(
        context.parent === true
        && String(context.phase || "").startsWith("private-key:")
        && path.resolve(target).toLowerCase() === keyParent
      ),
    }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_ACL_UNSAFE",
  );
});

test("nonce root 任一父链分段为 symlink 或 Windows junction 时失败关闭", (t) => {
  const tree = fixture(t);
  const linkedRoot = `${tree.root}-link`;
  fs.symlinkSync(tree.root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  t.after(() => {
    try { fs.unlinkSync(linkedRoot); } catch {}
  });
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-linked-root" });
  assert.throws(
    () => issueWorkerLaunchNonce(envelope, {
      ...tree.options,
      root: linkedRoot,
    }),
    (error) => (
      error.code === "WORKER_LAUNCH_NONCE_PATH_LINK"
      || error.code === "WORKER_LAUNCH_NONCE_PATH_INVALID"
    ),
  );
});

test("固定密钥、state 与 audit 普通文件存在硬链接时全部失败关闭", (t) => {
  const tree = fixture(t);
  const privateAlias = path.join(tree.root, "private-alias.pem");
  fs.linkSync(tree.privateKeyPath, privateAlias);
  const keyEnvelope = envelopeFor(tree.privateKey, { taskId: "task-key-hardlink" });
  assert.throws(
    () => issueWorkerLaunchNonce(keyEnvelope, {
      root: tree.root,
      testPrivateKeyPath: tree.privateKeyPath,
      testPublicKeyPath: tree.publicKeyPath,
      aclVerifier: () => true,
    }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_PATH_HARDLINK",
  );
  fs.unlinkSync(privateAlias);

  const stateEnvelope = envelopeFor(tree.privateKey, { taskId: "task-state-hardlink" });
  issueWorkerLaunchNonce(stateEnvelope, tree.options);
  const statePath = path.join(
    tree.root,
    fs.readdirSync(tree.root).find((name) => name.endsWith(".issued.json")),
  );
  const stateAlias = path.join(tree.root, "state-alias.json");
  fs.linkSync(statePath, stateAlias);
  assert.throws(
    () => consumeWorkerLaunchNonce(stateEnvelope, randomBytes(32), tree.options),
    (error) => error.code === "WORKER_LAUNCH_NONCE_PATH_HARDLINK",
  );
  fs.unlinkSync(stateAlias);

  const now = Date.now();
  const auditEnvelope = envelopeFor(tree.privateKey, {
    taskId: "task-audit-hardlink",
    now,
    ttlMs: 1_000,
  });
  issueWorkerLaunchNonce(auditEnvelope, { ...tree.options, now });
  consumeWorkerLaunchNonce(auditEnvelope, randomBytes(32), {
    ...tree.options,
    now: now + 100,
  });
  garbageCollectWorkerLaunchNonces({
    ...tree.options,
    now: now + 6_000,
  });
  const auditPath = path.join(
    tree.root,
    fs.readdirSync(tree.root).find((name) => name.startsWith("audit-")),
  );
  const auditAlias = path.join(tree.root, "audit-alias.json");
  fs.linkSync(auditPath, auditAlias);
  assert.throws(
    () => garbageCollectWorkerLaunchNonces({
      ...tree.options,
      now: now + 7_000,
    }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_PATH_HARDLINK",
  );
});

test("state 在 FD 读取期间被原位修改时由 fstat 与末次 lstat 绑定检测", (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-fd-drift" });
  issueWorkerLaunchNonce(envelope, tree.options);
  let injected = false;
  assert.throws(
    () => consumeWorkerLaunchNonce(envelope, randomBytes(32), {
      ...tree.options,
      testHook: (event, context) => {
        if (
          !injected
          && event === "stable-read-after-fd-read"
          && context.phase === "consume-state-read"
        ) {
          injected = true;
          fs.appendFileSync(context.target, " ");
        }
      },
    }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
  );
  assert.equal(injected, true);
});

test("nonce mutation 在 root 后置 ACL 复核前发生权限漂移时失败关闭", (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-root-postcheck" });
  let rejectPostcheck = false;
  assert.throws(
    () => issueWorkerLaunchNonce(envelope, {
      ...tree.options,
      aclVerifier: (_target, context) => !(
        rejectPostcheck
        && context.phase === "nonce-issue-create:post"
      ),
      testHook: (event, context) => {
        if (
          event === "mutation-before-postcheck"
          && context.operation === "nonce-issue-create"
        ) {
          rejectPostcheck = true;
        }
      },
    }),
    (error) => error.code === "WORKER_LAUNCH_NONCE_ACL_UNSAFE",
  );
  assert.equal(rejectPostcheck, true);
});

test("nonce mutation 前置复核后 root 对象被替换时由父链身份绑定失败关闭", (t) => {
  const tree = fixture(t);
  const envelope = envelopeFor(tree.privateKey, { taskId: "task-root-identity" });
  const displaced = `${tree.root}-displaced`;
  let swapped = false;
  try {
    assert.throws(
      () => issueWorkerLaunchNonce(envelope, {
        ...tree.options,
        testHook: (event, context) => {
          if (
            !swapped
            && event === "mutation-after-precheck"
            && context.operation === "nonce-issue-create"
          ) {
            fs.renameSync(tree.root, displaced);
            fs.mkdirSync(tree.root);
            fs.chmodSync(tree.root, 0o700);
            swapped = true;
          }
        },
      }),
      (error) => error.code === "WORKER_LAUNCH_NONCE_PATH_IDENTITY_DRIFT",
    );
    assert.equal(swapped, true);
  } finally {
    if (swapped) {
      fs.rmSync(tree.root, { recursive: true, force: true });
      fs.renameSync(displaced, tree.root);
    }
  }
});
