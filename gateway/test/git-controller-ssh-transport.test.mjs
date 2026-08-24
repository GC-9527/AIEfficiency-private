import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-controller-ssh-"));
process.env.GATEWAY_DB_PATH = path.join(root, "gateway.db");

const {
  RepositoryRegistry,
  canonicalRemoteIdentity,
  fingerprintRemote,
  resolveExecutable,
  runGitFile,
} = await import("../services/devbench/git-controller/index.js");
const persistence = await import("../db/sqlite.js");

after(() => {
  persistence.default.close();
  const resolved = path.resolve(root);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function git(args, cwd = root) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  }).trim();
}

function protectedFiles(label) {
  const directory = path.join(root, label);
  fs.mkdirSync(directory, { recursive: true });
  const privateKeyPath = path.join(directory, "id_controller");
  const knownHostsPath = path.join(directory, "known_hosts");
  fs.writeFileSync(privateKeyPath, "test-key-material\n", { mode: 0o600 });
  fs.writeFileSync(knownHostsPath, "example.test ssh-ed25519 AAAATEST\n", { mode: 0o600 });
  return { directory, privateKeyPath, knownHostsPath };
}

function fakeSsh(label, markerPath) {
  const directory = path.join(root, label);
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === "win32") {
    const sshBinaryPath = path.join(directory, "ssh-marker.cmd");
    fs.writeFileSync(
      sshBinaryPath,
      `@echo off\r\n>>"${markerPath}" echo invoked %*\r\nexit /b 71\r\n`,
    );
    return sshBinaryPath;
  }
  const sshBinaryPath = path.join(directory, "ssh-marker");
  fs.writeFileSync(
    sshBinaryPath,
    `#!/bin/sh\nprintf 'invoked %s\\n' "$*" >> '${markerPath}'\nexit 71\n`,
    { mode: 0o700 },
  );
  fs.chmodSync(sshBinaryPath, 0o700);
  return sshBinaryPath;
}

test("SSH canonical identity binds username, normalized host, port and path", () => {
  const scp = "git@codeup.aliyun.com:xunihezi/AIEfficiency.git";
  const url = "ssh://git@CODEUP.ALIYUN.COM:22/xunihezi/AIEfficiency.git";
  assert.equal(
    canonicalRemoteIdentity(scp),
    "ssh://git@codeup.aliyun.com:22/xunihezi/AIEfficiency",
  );
  assert.equal(canonicalRemoteIdentity(scp), canonicalRemoteIdentity(url));
  assert.equal(fingerprintRemote(scp), fingerprintRemote(url));
  assert.notEqual(
    fingerprintRemote(scp),
    fingerprintRemote("ssh://build@codeup.aliyun.com:22/xunihezi/AIEfficiency.git"),
  );
  assert.notEqual(
    fingerprintRemote(scp),
    fingerprintRemote("ssh://git@codeup.aliyun.com:2222/xunihezi/AIEfficiency.git"),
  );
  assert.throws(
    () => canonicalRemoteIdentity("ssh://git:password@codeup.aliyun.com/xunihezi/AIEfficiency.git"),
    { code: "GIT_CONTROLLER_EMBEDDED_CREDENTIAL_REJECTED" },
  );
  assert.throws(
    () => canonicalRemoteIdentity("ssh://git%0A@codeup.aliyun.com/xunihezi/AIEfficiency.git"),
    { code: "GIT_CONTROLLER_REMOTE_INVALID" },
  );
});

test("Git invokes only the fixed descriptor SSH binary with fail-closed options", async () => {
  const markerPath = path.join(root, "ssh-invoked.marker");
  const sshBinaryPath = fakeSsh("fake-ssh", markerPath);
  const files = protectedFiles("fake-ssh-files");
  const hooksPath = path.join(root, "disabled-hooks");
  fs.mkdirSync(hooksPath);
  const fallbackKnownHosts = path.join(root, "fallback-known-hosts");
  fs.writeFileSync(fallbackKnownHosts, "");
  let failure;
  try {
    await runGitFile({
      gitBinary: resolveExecutable("git"),
      disabledHooksPath: hooksPath,
      knownHostsPath: fallbackKnownHosts,
      args: [
        "ls-remote",
        "--heads",
        "ssh://git@example.test:22/x/repository",
        "refs/heads/main",
      ],
      commandId: "test.ssh-marker",
      env: {
        GIT_ALLOW_PROTOCOL: "ssh",
        GIT_PROTOCOL_FROM_USER: "0",
      },
      sshTransport: {
        sshBinaryPath,
        privateKeyPath: files.privateKeyPath,
        knownHostsPath: files.knownHostsPath,
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "GIT_CONTROLLER_COMMAND_FAILED");
  assert.equal(fs.existsSync(markerPath), true);
  const invocation = fs.readFileSync(markerPath, "utf8");
  for (const option of [
    "BatchMode=yes",
    "StrictHostKeyChecking=yes",
    "IdentitiesOnly=yes",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "ForwardAgent=no",
    "ProxyCommand=none",
  ]) {
    assert.match(invocation, new RegExp(option));
  }
  const exposed = JSON.stringify({
    message: failure.message,
    details: failure.details,
  });
  assert.equal(exposed.includes(files.privateKeyPath), false);
  assert.equal(exposed.includes(files.knownHostsPath), false);
  assert.equal(exposed.includes(sshBinaryPath), false);
});

test("credentialRef attestation drift and missing known_hosts fail before SSH execution", async () => {
  const fixtureRoot = path.join(root, "descriptor-drift");
  const base = path.join(fixtureRoot, "base");
  const dataRoot = path.join(fixtureRoot, "data");
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(dataRoot);
  git(["init"], base);
  git(["config", "user.name", "Controller Test"], base);
  git(["config", "user.email", "controller@example.test"], base);
  fs.writeFileSync(path.join(base, "README.md"), "initial\n");
  git(["add", "README.md"], base);
  git(["commit", "-m", "initial"], base);
  const remote = "git@codeup.aliyun.com:xunihezi/AIEfficiency.git";
  git(["remote", "add", "origin", remote], base);
  const markerPath = path.join(root, "drift-ssh-invoked.marker");
  const sshBinaryPath = fakeSsh("drift-fake-ssh", markerPath);
  const files = protectedFiles("drift-files");
  let drifted = false;
  const registry = await RepositoryRegistry.create({
    dataRoot,
    definitions: [{
      logicalDefinitionId: "codeup",
      basePath: base,
      remoteId: "origin",
      expectedRemoteUrls: [remote],
      allowedBranches: ["main"],
      credentialRef: "codeup-readonly",
    }],
    credentialDescriptors: {
      "codeup-readonly": {
        sshBinaryPath,
        privateKeyPath: files.privateKeyPath,
        knownHostsPath: files.knownHostsPath,
      },
    },
    credentialDescriptorAttestor() {
      if (drifted) {
        const error = new Error("descriptor drift");
        error.code = "GIT_CONTROLLER_SSH_DESCRIPTOR_DRIFT";
        throw error;
      }
    },
  });
  const entry = registry.list()[0];
  assert.equal(entry.credentialRef, "codeup-readonly");
  assert.equal(entry.credentialStatus, "READY");
  assert.equal(JSON.stringify(entry).includes(files.privateKeyPath), false);
  drifted = true;
  assert.throws(
    () => registry.transportFor(entry, { remoteUrl: remote }),
    { code: "GIT_CONTROLLER_SSH_DESCRIPTOR_DRIFT" },
  );
  assert.equal(fs.existsSync(markerPath), false);

  const missingDataRoot = path.join(fixtureRoot, "missing-data");
  fs.mkdirSync(missingDataRoot);
  await assert.rejects(
    RepositoryRegistry.create({
      dataRoot: missingDataRoot,
      definitions: [{
        logicalDefinitionId: "codeup-missing-known-hosts",
        basePath: base,
        remoteId: "origin",
        expectedRemoteUrls: [remote],
        allowedBranches: ["main"],
        credentialRef: "missing-known-hosts",
      }],
      credentialDescriptors: {
        "missing-known-hosts": {
          sshBinaryPath,
          privateKeyPath: files.privateKeyPath,
          knownHostsPath: path.join(files.directory, "absent-known-hosts"),
        },
      },
    }),
    { code: "GIT_CONTROLLER_SSH_DESCRIPTOR_DRIFT" },
  );
});
