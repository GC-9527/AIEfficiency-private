import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import test from "node:test";
import {
  recordWorkerDeploymentAttestation,
  verifyWorkerDeploymentAttestation,
  workerDeploymentAttestationSigningBytes,
  workerIsolationGrantFingerprint,
} from "../services/worker-isolation-attestation.js";

process.env.NODE_ENV = "test";

const NOW = Date.parse("2026-07-30T01:00:00.000Z");
const GATEWAY = "sid:S-1-5-21-1000";
const WORKER = "sid:S-1-5-21-1001";
const SHA = "a".repeat(64);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-attestation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyRoot = path.join(root, "key-root", "managed");
  const attestationRoot = path.join(root, "attestation-root", "managed");
  fs.mkdirSync(keyRoot, { recursive: true });
  fs.mkdirSync(attestationRoot, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trustAnchorPath = path.join(keyRoot, "worker-launcher-public.pem");
  fs.writeFileSync(
    trustAnchorPath,
    publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o600 },
  );
  const attestationPath = path.join(
    attestationRoot,
    "worker-deployment-attestations.json",
  );
  const roots = {};
  for (const name of ["story", "base", "other-story", "mirror", "secrets"]) {
    roots[name] = path.join(root, name);
    fs.mkdirSync(roots[name]);
  }
  const deniedRoots = [
    roots.base,
    roots["other-story"],
    roots.mirror,
    roots.secrets,
  ];
  const grant = {
    version: 2,
    storyId: "story-1",
    repositoryMode: "INDEPENDENT_REPOSITORY",
    topologyCwd: roots.story,
    allowedRoots: [roots.story],
    writeDeniedRoots: [roots.base, roots["other-story"]],
    inaccessibleRoots: [roots.mirror, roots.secrets],
    inaccessibleEntries: [roots.mirror, roots.secrets].map((rootPath) => ({
      root: rootPath,
      path: rootPath,
      type: "directory",
    })),
    boundarySentinels: deniedRoots.map((deniedRoot, index) => ({
      deniedRoot,
      sentinelPath: path.join(root, `sentinel-${index}`),
    })),
    workerIdentity: WORKER,
    aclFingerprints: [SHA],
    topologyGeneration: 1,
  };
  const launcher = {
    identity: WORKER,
    gatewayIdentity: GATEWAY,
    configSha256: SHA,
    launcherSha256: "b".repeat(64),
    brokerSha256: "c".repeat(64),
    workerPolicyDigest: "d".repeat(64),
  };
  const probeResult = {
    ok: true,
    storyId: "story-1",
    actualIdentity: WORKER,
    launchNonce: randomUUID(),
  };
  const keyId = `ed25519:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url")}`;
  const signer = (document) => ({
    keyId,
    signature: sign(
      null,
      workerDeploymentAttestationSigningBytes({ ...document, keyId }),
      privateKey,
    ).toString("base64url"),
  });
  return {
    root,
    keyRoot,
    attestationRoot,
    trustAnchorPath,
    attestationPath,
    privateKey,
    publicKey,
    keyId,
    grant,
    launcher,
    probeResult,
    signer,
  };
}

test("grant v2 指纹绑定 writeDenied 与 inaccessible 权限语义", (t) => {
  const tree = fixture(t);
  const inaccessibleRoot = tree.grant.inaccessibleRoots[0];
  const downgraded = {
    ...tree.grant,
    writeDeniedRoots: [...tree.grant.writeDeniedRoots, inaccessibleRoot],
    inaccessibleRoots: tree.grant.inaccessibleRoots.slice(1),
    inaccessibleEntries: tree.grant.inaccessibleEntries.filter(
      (entry) => entry.root !== inaccessibleRoot,
    ),
  };
  assert.notEqual(
    workerIsolationGrantFingerprint(tree.grant),
    workerIsolationGrantFingerprint(downgraded),
  );
  const descendantBound = {
    ...tree.grant,
    inaccessibleEntries: [
      ...tree.grant.inaccessibleEntries,
      {
        root: tree.grant.inaccessibleRoots[0],
        path: path.join(tree.grant.inaccessibleRoots[0], "objects", "secret"),
        type: "file",
      },
    ].sort((left, right) => (
      left.root.localeCompare(right.root) || left.path.localeCompare(right.path)
    )),
  };
  assert.notEqual(
    workerIsolationGrantFingerprint(tree.grant),
    workerIsolationGrantFingerprint(descendantBound),
  );
});

test("旧 v1 grant 与旧字段不能生成 deployment attestation 指纹", (t) => {
  const tree = fixture(t);
  const legacy = {
    ...tree.grant,
    version: 1,
    forbiddenRoots: tree.grant.writeDeniedRoots,
    mirrorRoots: [tree.grant.inaccessibleRoots[0]],
    secretRoots: [tree.grant.inaccessibleRoots[1]],
  };
  delete legacy.writeDeniedRoots;
  delete legacy.inaccessibleRoots;
  assert.throws(
    () => workerIsolationGrantFingerprint(legacy),
    (error) => error.code === "WORKER_DEPLOYMENT_ATTESTATION_GRANT_INVALID",
  );
  assert.throws(
    () => record(tree, { grant: legacy }),
    (error) => error.code === "WORKER_DEPLOYMENT_ATTESTATION_GRANT_INVALID",
  );
});

test("签名有效但携带旧 probeScopeDigest 的文档仍按 DRIFT 失败关闭", (t) => {
  const tree = fixture(t);
  record(tree);
  const document = JSON.parse(fs.readFileSync(tree.attestationPath, "utf8"));
  document.entries[0].probeScopeDigest = "f".repeat(64);
  document.signature = sign(
    null,
    workerDeploymentAttestationSigningBytes(document),
    tree.privateKey,
  ).toString("base64url");
  fs.writeFileSync(tree.attestationPath, `${JSON.stringify(document, null, 2)}\n`);
  const result = verifyAttestation(tree);
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_DEPLOYMENT_ATTESTATION_DRIFT");
});

test("旧 v1 deployment attestation 即使重新签名也不能恢复 READY", (t) => {
  const tree = fixture(t);
  record(tree);
  const document = JSON.parse(fs.readFileSync(tree.attestationPath, "utf8"));
  document.schema = "devbench.worker-deployment-attestations.v1";
  document.version = 1;
  document.signature = sign(
    null,
    workerDeploymentAttestationSigningBytes(document),
    tree.privateKey,
  ).toString("base64url");
  fs.writeFileSync(tree.attestationPath, `${JSON.stringify(document)}\n`);
  const result = verifyAttestation(tree);
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_DEPLOYMENT_ATTESTATION_INVALID");
});

function record(tree, overrides = {}) {
  return recordWorkerDeploymentAttestation({
    storyId: "story-1",
    launcher: tree.launcher,
    grant: tree.grant,
    probeResult: {
      ...tree.probeResult,
      launchNonce: randomUUID(),
    },
    signer: tree.signer,
    now: NOW,
    platform: "win32",
    gatewayIdentity: GATEWAY,
    attestationPath: tree.attestationPath,
    trustAnchorPath: tree.trustAnchorPath,
    aclVerifier: () => true,
    ...overrides,
  });
}

function verifyAttestation(tree, overrides = {}) {
  return verifyWorkerDeploymentAttestation({
    storyId: "story-1",
    launcher: tree.launcher,
    grant: tree.grant,
    now: NOW + 1,
    platform: "win32",
    gatewayIdentity: GATEWAY,
    attestationPath: tree.attestationPath,
    trustAnchorPath: tree.trustAnchorPath,
    aclVerifier: () => true,
    ...overrides,
  });
}

function normalized(value) {
  return path.resolve(value).toLowerCase();
}

test("公钥与 attestation 每次读取都验证从卷根到叶子的完整父链", (t) => {
  const tree = fixture(t);
  record(tree);
  const observed = [];
  const result = verifyAttestation(tree, {
    aclVerifier(target, context) {
      observed.push({ target: normalized(target), context });
      return true;
    },
  });
  assert.equal(result.ok, true);
  for (const expected of [
    path.parse(tree.root).root,
    tree.root,
    tree.keyRoot,
    tree.trustAnchorPath,
    tree.attestationRoot,
    tree.attestationPath,
  ]) {
    assert.equal(
      observed.some((item) => item.target === normalized(expected)),
      true,
      `missing protected segment: ${expected}`,
    );
  }
  assert.equal(
    observed.some((item) => (
      item.target === normalized(tree.trustAnchorPath)
      && item.context.leaf === true
      && item.context.directory === false
    )),
    true,
  );
  assert.equal(
    observed.some((item) => (
      item.target === normalized(tree.attestationRoot)
      && item.context.directory === true
    )),
    true,
  );
});

test("Windows 父链校验使用固定 PowerShell、重解析点与 owner/mutation ACL 策略", (t) => {
  const tree = fixture(t);
  const calls = [];
  record(tree, {
    aclVerifier: undefined,
    execFile(command, args, options) {
      calls.push({ command, args, options });
      return "";
    },
  });
  assert.equal(calls.length > 0, true);
  for (const call of calls) {
    assert.equal(path.win32.basename(call.command).toLowerCase(), "powershell.exe");
    assert.match(call.args.at(-1), /ReparsePoint/);
    assert.match(call.args.at(-1), /Microsoft\.PowerShell\.Management\\Get-Item/);
    assert.match(call.args.at(-1), /Microsoft\.PowerShell\.Security\\Get-Acl/);
    assert.match(call.args.at(-1), /WriteAttributes/);
    assert.match(call.args.at(-1), /ChangePermissions/);
    assert.match(call.args.at(-1), /TakeOwnership/);
    assert.deepEqual(
      Object.keys(call.options.env).sort(),
      ["ComSpec", "PATH", "SystemRoot", "WINDIR"].sort(),
    );
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.stdio, "ignore");
  }
});

test("任一公钥父目录允许非管理身份修改都会失败关闭", (t) => {
  const tree = fixture(t);
  record(tree);
  const rejectedParent = path.dirname(tree.keyRoot);
  const result = verifyAttestation(tree, {
    aclVerifier(target) {
      return normalized(target) !== normalized(rejectedParent);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_DEPLOYMENT_ATTESTATION_ACL_UNSAFE");
});

test("公钥或 attestation 被创建硬链接后均不能继续使用", (t) => {
  const keyTree = fixture(t);
  record(keyTree);
  fs.linkSync(keyTree.trustAnchorPath, path.join(keyTree.keyRoot, "public-hardlink.pem"));
  const keyResult = verifyAttestation(keyTree);
  assert.equal(keyResult.ok, false);
  assert.equal(keyResult.code, "WORKER_DEPLOYMENT_ATTESTATION_HARDLINK");

  const documentTree = fixture(t);
  record(documentTree);
  fs.linkSync(
    documentTree.attestationPath,
    path.join(documentTree.attestationRoot, "attestation-hardlink.json"),
  );
  const documentResult = verifyAttestation(documentTree);
  assert.equal(documentResult.ok, false);
  assert.equal(documentResult.code, "WORKER_DEPLOYMENT_ATTESTATION_HARDLINK");
});

test("公钥父链中的 junction/reparse point 不能被 ACL 测试替身绕过", (t) => {
  const tree = fixture(t);
  record(tree);
  const linkedRoot = path.join(tree.root, "linked-key-root");
  fs.symlinkSync(path.dirname(tree.keyRoot), linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const linkedKey = path.join(linkedRoot, path.basename(tree.keyRoot), path.basename(tree.trustAnchorPath));
  const result = verifyAttestation(tree, {
    trustAnchorPath: linkedKey,
  });
  assert.equal(result.ok, false);
  assert.equal(
    [
      "WORKER_DEPLOYMENT_ATTESTATION_PATH_LINK",
      "WORKER_DEPLOYMENT_ATTESTATION_PATH_INVALID",
    ].includes(result.code),
    true,
  );
});

test("attestation 在 open 后被路径替换时，FD 与末次 lstat 身份绑定会拒绝", (t) => {
  const tree = fixture(t);
  record(tree);
  let swapped = false;
  const backup = `${tree.attestationPath}.opened`;
  const result = verifyAttestation(tree, {
    testHooks: {
      afterProtectedOpen({ target, purpose }) {
        if (
          !swapped
          && purpose === "attestation-document"
          && normalized(target) === normalized(tree.attestationPath)
        ) {
          swapped = true;
          fs.renameSync(tree.attestationPath, backup);
          fs.copyFileSync(backup, tree.attestationPath);
        }
      },
    },
  });
  assert.equal(swapped, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED");
});

test("公钥在 FD 读取后被同内容新 inode 替换也会拒绝", (t) => {
  const tree = fixture(t);
  record(tree);
  let swapped = false;
  const backup = `${tree.trustAnchorPath}.opened`;
  const result = verifyAttestation(tree, {
    testHooks: {
      afterProtectedRead({ target, purpose }) {
        if (
          !swapped
          && purpose === "trust-anchor"
          && normalized(target) === normalized(tree.trustAnchorPath)
        ) {
          swapped = true;
          fs.renameSync(tree.trustAnchorPath, backup);
          fs.copyFileSync(backup, tree.trustAnchorPath);
        }
      },
    },
  });
  assert.equal(swapped, true);
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKER_DEPLOYMENT_ATTESTATION_PATH_CHANGED");
});

test("原子替换在 rename 前重新验证父链，漂移时保留旧文档", (t) => {
  const tree = fixture(t);
  record(tree);
  const before = fs.readFileSync(tree.attestationPath);
  let unsafe = false;
  assert.throws(
    () => record(tree, {
      aclVerifier() {
        return !unsafe;
      },
      testHooks: {
        beforeAttestationRename() {
          unsafe = true;
        },
      },
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_ATTESTATION_ACL_UNSAFE",
  );
  assert.deepEqual(fs.readFileSync(tree.attestationPath), before);
  assert.equal(
    fs.readdirSync(tree.attestationRoot).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("原子替换后执行目录 fsync 并再次验证父链 ACL", (t) => {
  const tree = fixture(t);
  let successfulFsyncCalls = 0;
  record(tree, {
    testHooks: {
      directoryFsync({ directory }) {
        assert.equal(normalized(directory), normalized(tree.attestationRoot));
        successfulFsyncCalls += 1;
      },
    },
  });
  assert.equal(successfulFsyncCalls, 1);
  let unsafe = false;
  let directoryFsyncCalls = 0;
  assert.throws(
    () => record(tree, {
      aclVerifier() {
        return !unsafe;
      },
      testHooks: {
        afterAttestationRename() {
          unsafe = true;
        },
        directoryFsync({ directory }) {
          assert.equal(normalized(directory), normalized(tree.attestationRoot));
          directoryFsyncCalls += 1;
        },
      },
    }),
    (error) => error.code === "WORKER_DEPLOYMENT_ATTESTATION_ACL_UNSAFE",
  );
  assert.equal(directoryFsyncCalls, 0);
  assert.equal(JSON.parse(fs.readFileSync(tree.attestationPath, "utf8")).generation, 2);
});

test("生产环境拒绝 ACL、系统工具、信任锚和测试钩子注入", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    for (const override of [
      { aclVerifier: () => true },
      { execFile: () => undefined },
      { testTrustAnchor: "not-a-key" },
      { trustAnchorPath: path.join(os.tmpdir(), "replacement-public.pem") },
      { testHooks: {} },
      { platform: process.platform === "win32" ? "linux" : "win32" },
    ]) {
      const result = verifyWorkerDeploymentAttestation({
        storyId: "story-1",
        ...override,
      });
      assert.equal(result.ok, false);
      assert.equal(
        [
          "WORKER_DEPLOYMENT_ATTESTATION_ACL_OVERRIDE_FORBIDDEN",
          "WORKER_DEPLOYMENT_ATTESTATION_PATH_OVERRIDE_FORBIDDEN",
        ].includes(result.code),
        true,
      );
    }
  } finally {
    process.env.NODE_ENV = previous;
  }
});
