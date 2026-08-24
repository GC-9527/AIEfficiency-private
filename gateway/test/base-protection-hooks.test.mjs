import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";

import {
  configureBaseProtectionCapabilities,
  diagnoseBaseProtectionHooks,
  guardBaseProtectionHook,
  installBaseProtectionHooks as installBaseProtectionHooksRaw,
  issueBaseProtectionCapability,
  listBaseProtectionHooks,
  previewUninstallBaseProtectionHooks,
  uninstallBaseProtectionHooks,
  validateBaseProtectionCapability,
  __test,
} from "../services/devbench/base-protection-hooks.js";
import {
  invokeStandaloneController,
} from "../services/devbench/base-protection-runtime/core.mjs";

const cleanupRoots = [];
let pinnedTestRuntime = null;

function tempRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  cleanupRoots.push(root);
  return root;
}

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env || {}) },
  }).trim();
}

function makeGitRepo(name = "repo") {
  const parent = tempRoot("base-protection");
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore", windowsHide: true });
  git(repo, ["config", "user.email", "base-protection@example.test"]);
  git(repo, ["config", "user.name", "Base Protection Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "init\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "--quiet", "-m", "init"]);
  return repo;
}

function makeValidatorModule(parent) {
  const file = path.join(parent, "capability validator.mjs");
  fs.writeFileSync(file, `
export function validateCapability(context) {
  return {
    ok: context.capability === "signed-test-capability",
    reason: context.capability === "signed-test-capability" ? "TEST_CAPABILITY_VALID" : "TEST_CAPABILITY_REJECTED",
  };
}
`, "utf8");
  return file;
}

function makeCommandValidator(parent) {
  const file = path.join(parent, "capability-command-validator.mjs");
  fs.writeFileSync(file, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const context = JSON.parse(input);
process.stdout.write(JSON.stringify({
  ok: context.capability === "command-test-capability",
  reason: context.capability === "command-test-capability"
    ? "COMMAND_CAPABILITY_VALID"
    : "COMMAND_CAPABILITY_REJECTED",
}));
`, "utf8");
  return file;
}

function secureTestFile(filePath) {
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", [], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    execFileSync("icacls.exe", [
      filePath,
      "/inheritance:r",
      "/grant:r",
      `${identity}:(F)`,
      "*S-1-5-18:(F)",
    ], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    fs.chmodSync(filePath, 0o700);
  }
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

function testRuntimeExecutablePaths() {
  if (pinnedTestRuntime) return pinnedTestRuntime;
  let nodeBinary = process.execPath;
  if (process.platform === "win32") {
    const localAppData = path.resolve(String(process.env.LOCALAPPDATA || ""));
    const runtimeRoot = path.join(
      localAppData,
      "DevBench Hooks Tests",
      `固定 Runtime ${process.pid}-${Date.now()}`,
    );
    fs.mkdirSync(runtimeRoot, { recursive: true });
    cleanupRoots.push(runtimeRoot);
    nodeBinary = path.join(runtimeRoot, "node 固定.exe");
    fs.copyFileSync(process.execPath, nodeBinary);
  }
  pinnedTestRuntime = Object.freeze({
    nodeBinary,
    gitBinary: resolveTestExecutable("git"),
  });
  return pinnedTestRuntime;
}

function installBaseProtectionHooks(repo, options = {}) {
  return installBaseProtectionHooksRaw(repo, {
    ...options,
    runtimeExecutablePaths: testRuntimeExecutablePaths(),
  });
}

function installWithValidator(repo) {
  const validator = makeValidatorModule(path.dirname(repo));
  return installBaseProtectionHooks(repo, {
    capabilityValidatorDescriptor: {
      type: "module",
      modulePath: validator,
      exportName: "validateCapability",
    },
  });
}

const controllerIdle = Object.freeze({
  activeLeaseCheck: () => false,
});

function managedPaths(repo) {
  const commonDir = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const root = path.join(commonDir, __test.MANAGED_DIRNAME);
  return {
    root,
    hooks: path.join(root, "hooks"),
    previous: path.join(root, "previous-hooks"),
    runtime: path.join(root, "runtime"),
    manifest: path.join(root, "manifest.json"),
    state: path.join(root, "state.json"),
  };
}

function invokeDiagnoseLauncher(paths, env) {
  if (process.platform === "win32") {
    return spawnSync(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      ["/d", "/c", "diagnose-devbench-base-protection.bat"],
      {
        cwd: paths.root,
        encoding: "utf8",
        windowsHide: true,
        env,
      },
    );
  }
  return spawnSync(
    "/bin/sh",
    [path.join(paths.root, "diagnose-devbench-base-protection.sh")],
    {
      cwd: paths.root,
      encoding: "utf8",
      env,
    },
  );
}

function weakenDirectoryPermissions(directory) {
  if (process.platform === "win32") {
    execFileSync(path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "icacls.exe",
    ), [
      directory,
      "/grant",
      "*S-1-5-32-545:(OI)(CI)(M)",
    ], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    fs.chmodSync(directory, 0o777);
  }
}

function removeAll() {
  configureBaseProtectionCapabilities();
  for (const root of cleanupRoots.splice(0).reverse()) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

process.on("exit", removeAll);

test("安装解析自定义 hooksPath，并生成六个 dispatcher、manifest/state 与跨平台脚本", () => {
  const repo = makeGitRepo("中文 仓库");
  const originalHooksDir = path.join(repo, "自定义 hooks");
  fs.mkdirSync(originalHooksDir, { recursive: true });
  git(repo, ["config", "--local", "core.hooksPath", "自定义 hooks"]);

  const originalBytes = Buffer.from("#!/bin/sh\nprintf 'original-hook-ran' > original-hook-result.txt\n", "utf8");
  const originalHook = path.join(originalHooksDir, "pre-commit");
  fs.writeFileSync(originalHook, originalBytes);
  fs.chmodSync(originalHook, 0o751);
  const originalMode = fs.statSync(originalHook).mode & 0o777;

  const result = installWithValidator(repo);
  assert.equal(result.status, "ACTIVE");
  assert.deepEqual(result.installed, [...__test.HOOK_NAMES]);
  assert.ok(result.backedUp.includes("pre-commit"));

  const paths = managedPaths(repo);
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  assert.equal(state.status, "ACTIVE");
  assert.equal(manifest.repository.fingerprint.length, 64);
  assert.equal(manifest.hooksPathBefore.local.value, "自定义 hooks");
  assert.equal(path.resolve(manifest.hooksPathBefore.effectiveDirectory), path.resolve(originalHooksDir));
  assert.equal(manifest.hooks["pre-commit"].previous.bytesBase64, originalBytes.toString("base64"));
  assert.equal(manifest.hooks["pre-commit"].previous.mode, originalMode);
  assert.equal(manifest.hooks["pre-commit"].previous.sha256, __test.sha256(originalBytes));
  assert.equal(manifest.capability.tokenEnvironment, "DEVBENCH_BASE_PROTECTION_CAPABILITY");
  assert.equal(
    manifest.capability.controllerMutationEnvironment,
    "DEVBENCH_BASE_PROTECTION_CONTROLLER_MUTATION",
  );
  assert.equal(manifest.capability.validator.type, "module");
  assert.equal(
    manifest.capability.validator.moduleSha256,
    __test.sha256(fs.readFileSync(manifest.capability.validator.modulePath)),
  );
  assert.equal(manifest.capability.validator.exportName, "validateCapability");
  assert.equal(manifest.capability.failClosed, true);
  assert.equal(manifest.runtimeExecutables.schemaVersion, 1);
  assert.equal(
    path.resolve(manifest.runtimeExecutables.node.path),
    path.resolve(testRuntimeExecutablePaths().nodeBinary),
  );
  assert.equal(
    path.resolve(manifest.runtimeExecutables.git.path),
    path.resolve(testRuntimeExecutablePaths().gitBinary),
  );
  for (const name of ["node", "git"]) {
    assert.match(manifest.runtimeExecutables[name].sha256, /^[0-9a-f]{64}$/);
    assert.ok(manifest.runtimeExecutables[name].parents.length >= 1);
    for (const parent of manifest.runtimeExecutables[name].parents) {
      assert.ok(path.isAbsolute(parent.path));
      assert.match(parent.attestationSha256, /^[0-9a-f]{64}$/);
      assert.ok(parent.security.owner || Number.isInteger(parent.security.uid));
    }
  }
  for (const runtimeName of ["core", "manage"]) {
    const record = manifest.runtime[runtimeName];
    const target = path.join(paths.root, ...record.path.split("/"));
    assert.equal(__test.sha256(fs.readFileSync(target)), record.sha256);
  }

  for (const hookName of __test.HOOK_NAMES) {
    const dispatcher = path.join(paths.hooks, hookName);
    assert.ok(fs.existsSync(dispatcher), `${hookName} dispatcher 应存在`);
    assert.equal(
      __test.sha256(fs.readFileSync(dispatcher)),
      manifest.hooks[hookName].dispatcherSha256,
      `${hookName} dispatcher Hash 应匹配 manifest`,
    );
  }
  for (const file of [
    "remove-devbench-base-protection.bat",
    "remove-devbench-base-protection.sh",
    "diagnose-devbench-base-protection.bat",
    "diagnose-devbench-base-protection.sh",
  ]) {
    assert.ok(fs.existsSync(path.join(paths.root, file)), `${file} 应在安装时生成`);
  }
  assert.match(
    fs.readFileSync(path.join(paths.root, "remove-devbench-base-protection.bat"), "utf8"),
    /runtime\\manage\.mjs" hooks-uninstall/,
  );
  assert.match(
    fs.readFileSync(path.join(paths.root, "remove-devbench-base-protection.sh"), "utf8"),
    /runtime\/manage\.mjs" hooks-uninstall/,
  );
  const removeSh = fs.readFileSync(
    path.join(paths.root, "remove-devbench-base-protection.sh"),
    "utf8",
  );
  assert.match(removeSh, /^#!\/bin\/sh\r?\n/);
  assert.doesNotMatch(removeSh, /\/usr\/bin\/env|\bdirname\b/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(paths.hooks, "pre-commit"), "utf8"),
    /command -v node|(?:^|\s)node\s+"/m,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(paths.root, "remove-devbench-base-protection.bat"), "utf8"),
    /where node|(?:^|\s)node\s+"/m,
  );
  assert.equal(
    path.resolve(git(repo, ["config", "--local", "--get", "core.hooksPath"])),
    path.resolve(paths.hooks),
  );
});

test("dispatcher/BAT/SH 固定 Node/Git/SystemRoot 工具，恶意或空 PATH 均不参与解析", () => {
  const repo = makeGitRepo("固定 runtime 中文 空格");
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const fakePath = tempRoot("base-protection-fake-path");
  const marker = path.join(fakePath, "path-marker.txt");
  if (process.platform === "win32") {
    const markerValue = marker.replaceAll("%", "%%");
    for (const command of ["node", "git"]) {
      fs.writeFileSync(
        path.join(fakePath, `${command}.cmd`),
        `@echo off\r\necho ${command}>>"${markerValue}"\r\nexit /b 97\r\n`,
      );
    }
    fs.writeFileSync(path.join(fakePath, "powershell.exe"), "not-an-executable", "utf8");
  } else {
    const markerValue = marker.replaceAll("'", "'\\''");
    for (const command of ["node", "git", "ps", "sh", "dirname"]) {
      const target = path.join(fakePath, command);
      fs.writeFileSync(
        target,
        `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${markerValue}'\nexit 97\n`,
      );
      fs.chmodSync(target, 0o755);
    }
  }
  const baseEnv = {
    SystemRoot: process.env.SystemRoot || "",
    WINDIR: process.env.WINDIR || "",
    COMSPEC: process.env.COMSPEC || "",
    TEMP: process.env.TEMP || "",
    TMP: process.env.TMP || "",
    TMPDIR: process.env.TMPDIR || "",
    LOCALAPPDATA: process.env.LOCALAPPDATA || "",
  };
  const hostile = invokeDiagnoseLauncher(paths, { ...baseEnv, PATH: fakePath });
  assert.equal(hostile.status, 0, `${hostile.stdout}\n${hostile.stderr}`);
  assert.match(hostile.stdout, /"status":\s*"ACTIVE"/);
  assert.equal(fs.existsSync(marker), false);

  const noPath = invokeDiagnoseLauncher(paths, { ...baseEnv, PATH: "" });
  assert.equal(noPath.status, 0, `${noPath.stdout}\n${noPath.stderr}`);
  assert.match(noPath.stdout, /"status":\s*"ACTIVE"/);
  if (process.platform !== "win32") {
    const launcher = path.join(paths.root, "diagnose-devbench-base-protection.sh");
    const directHostile = spawnSync(launcher, [], {
      cwd: paths.root,
      encoding: "utf8",
      env: { ...baseEnv, PATH: fakePath },
    });
    assert.equal(
      directHostile.status,
      0,
      `${directHostile.stdout}\n${directHostile.stderr}`,
    );
    assert.match(directHostile.stdout, /"status":\s*"ACTIVE"/);
    assert.equal(fs.existsSync(marker), false);
    const directNoPath = spawnSync(launcher, [], {
      cwd: paths.root,
      encoding: "utf8",
      env: { ...baseEnv, PATH: "" },
    });
    assert.equal(
      directNoPath.status,
      0,
      `${directNoPath.stdout}\n${directNoPath.stderr}`,
    );
    assert.match(directNoPath.stdout, /"status":\s*"ACTIVE"/);
  }
});

test("安装拒绝父目录可被非特权主体写入的固定 Node", () => {
  const repo = makeGitRepo("unsafe runtime parent");
  const unsafeRoot = tempRoot("base-protection-unsafe-runtime");
  const unsafeNode = path.join(
    unsafeRoot,
    process.platform === "win32" ? "node.exe" : "node",
  );
  fs.copyFileSync(process.execPath, unsafeNode);
  weakenDirectoryPermissions(unsafeRoot);
  const result = installBaseProtectionHooksRaw(repo, {
    runtimeExecutablePaths: {
      nodeBinary: unsafeNode,
      gitBinary: testRuntimeExecutablePaths().gitBinary,
    },
  });
  assert.equal(result.status, "DEGRADED");
  assert.match(
    result.errorCode,
    /BASE_PROTECTION_(?:RUNTIME_PARENT|NODE)_PERMISSIONS_WEAK/,
  );
});

test("固定 Node 父目录 ACL/mode 漂移后 diagnose 与 guard 均失败关闭", async () => {
  const repo = makeGitRepo("runtime parent drift");
  let runtimeRoot;
  if (process.platform === "win32") {
    runtimeRoot = path.join(
      path.resolve(String(process.env.LOCALAPPDATA || "")),
      "DevBench Hooks Tests",
      `漂移 Runtime ${process.pid}-${Date.now()}`,
    );
  } else {
    runtimeRoot = tempRoot("base-protection-runtime-drift");
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  if (process.platform === "win32") cleanupRoots.push(runtimeRoot);
  const nodeBinary = path.join(
    runtimeRoot,
    process.platform === "win32" ? "node 固定.exe" : "node-fixed",
  );
  fs.copyFileSync(process.execPath, nodeBinary);
  if (process.platform !== "win32") fs.chmodSync(runtimeRoot, 0o700);
  const validator = makeValidatorModule(path.dirname(repo));
  const installed = installBaseProtectionHooksRaw(repo, {
    runtimeExecutablePaths: {
      nodeBinary,
      gitBinary: testRuntimeExecutablePaths().gitBinary,
    },
    capabilityValidatorDescriptor: {
      type: "module",
      modulePath: validator,
    },
  });
  assert.equal(installed.status, "ACTIVE");

  weakenDirectoryPermissions(runtimeRoot);
  const diagnosis = diagnoseBaseProtectionHooks(repo);
  assert.equal(diagnosis.status, "DRIFTED");
  assert.ok(diagnosis.issues.some((issue) => /PARENT|PERMISSIONS/.test(issue)));
  const guard = await guardBaseProtectionHook(repo, {
    hook: "pre-commit",
    repositoryPath: repo,
    capability: "signed-test-capability",
  });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /PARENT|PERMISSIONS/);
});

test("dispatcher 先验证能力，再组合执行安装前的用户 hook", () => {
  const repo = makeGitRepo("组合 hook");
  const hooksDir = path.join(repo, ".custom-hooks");
  const previousHookMarker = path.join(repo, "previous-hook-ran.txt");
  const shellMarker = previousHookMarker.replaceAll("\\", "/").replaceAll("'", "'\\''");
  fs.mkdirSync(hooksDir);
  git(repo, ["config", "--local", "core.hooksPath", ".custom-hooks"]);
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    `#!/bin/sh\nprintf 'combined' > '${shellMarker}'\n`,
    "utf8",
  );
  fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755);
  assert.equal(installWithValidator(repo).status, "ACTIVE");

  fs.writeFileSync(path.join(repo, "change.txt"), "change\n");
  git(repo, ["add", "change.txt"]);
  assert.throws(
    () => git(repo, ["commit", "--quiet", "-m", "blocked-without-capability"]),
    /devbench|hook|failed|denied/i,
  );
  assert.equal(fs.existsSync(previousHookMarker), false);

  git(repo, ["commit", "--quiet", "-m", "allowed-with-capability"], {
    env: { DEVBENCH_BASE_PROTECTION_CAPABILITY: "signed-test-capability" },
  });
  assert.equal(fs.readFileSync(previousHookMarker, "utf8"), "combined");
});

test("Controller capability mutation skips a hostile previous reference-transaction hook", () => {
  const repo = makeGitRepo("controller skips previous reference hook");
  const hooksDir = path.join(repo, ".custom-hooks");
  const previousHookMarker = path.join(repo, "hostile-reference-hook-ran.txt");
  const shellMarker = previousHookMarker.replaceAll("\\", "/").replaceAll("'", "'\\''");
  fs.mkdirSync(hooksDir);
  git(repo, ["config", "--local", "core.hooksPath", ".custom-hooks"]);
  fs.writeFileSync(
    path.join(hooksDir, "reference-transaction"),
    `#!/bin/sh\nprintf 'hostile-previous-hook-ran\\n' >> '${shellMarker}'\n`,
    "utf8",
  );
  fs.chmodSync(path.join(hooksDir, "reference-transaction"), 0o755);
  assert.equal(installWithValidator(repo).status, "ACTIVE");

  const head = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/heads/user-authorized", head], {
    env: { DEVBENCH_BASE_PROTECTION_CAPABILITY: "signed-test-capability" },
  });
  assert.equal(fs.existsSync(previousHookMarker), true);
  fs.rmSync(previousHookMarker);

  git(repo, ["update-ref", "refs/heads/controller-authorized", head], {
    env: {
      DEVBENCH_BASE_PROTECTION_CAPABILITY: "signed-test-capability",
      DEVBENCH_BASE_PROTECTION_CONTROLLER_MUTATION: "1",
    },
  });
  assert.equal(
    fs.existsSync(previousHookMarker),
    false,
    "Controller-authorized Git must never execute the backed-up user hook",
  );
  assert.equal(git(repo, ["rev-parse", "refs/heads/controller-authorized"]), head);
});

test("重复安装幂等，不重写 manifest 或重新备份 dispatcher", () => {
  const repo = makeGitRepo("幂等");
  const first = installWithValidator(repo);
  assert.equal(first.status, "ACTIVE");
  const paths = managedPaths(repo);
  const firstManifest = fs.readFileSync(paths.manifest);
  const firstBackup = fs.existsSync(path.join(paths.previous, "pre-commit"))
    ? fs.readFileSync(path.join(paths.previous, "pre-commit"))
    : null;

  const second = installWithValidator(repo);
  assert.equal(second.status, "ACTIVE");
  assert.equal(second.idempotent, true);
  assert.deepEqual(fs.readFileSync(paths.manifest), firstManifest);
  if (firstBackup) assert.deepEqual(fs.readFileSync(path.join(paths.previous, "pre-commit")), firstBackup);
});

test("安装进程在 hooksPath 切换后被杀可按原 manifest 恢复且不覆盖用户 hook 备份", () => {
  const repo = makeGitRepo("install hard kill recovery");
  const originalHook = git(
    repo,
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-commit"],
  );
  fs.mkdirSync(path.dirname(originalHook), { recursive: true });
  const originalBytes = Buffer.from("#!/bin/sh\necho original-install-recovery\n", "utf8");
  fs.writeFileSync(originalHook, originalBytes, { mode: 0o755 });
  const validator = makeValidatorModule(path.dirname(repo));
  const installOptions = {
    capabilityValidatorDescriptor: {
      type: "module",
      modulePath: validator,
      exportName: "validateCapability",
    },
  };
  const installed = installBaseProtectionHooks(repo, installOptions);
  assert.equal(installed.status, "ACTIVE");
  const paths = managedPaths(repo);
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  const backupPath = path.resolve(
    paths.root,
    manifest.hooks["pre-commit"].previous.backupPath,
  );
  const backupBefore = fs.readFileSync(backupPath);

  fs.writeFileSync(paths.state, `${JSON.stringify({
    ...state,
    status: "INSTALLING",
    operation: "switch-hooks-path",
  }, null, 2)}\n`, "utf8");

  const recovered = installBaseProtectionHooks(repo, installOptions);
  assert.equal(recovered.status, "ACTIVE");
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.idempotent, true);
  assert.deepEqual(fs.readFileSync(backupPath), backupBefore);
  assert.deepEqual(backupBefore, originalBytes);
  assert.equal(diagnoseBaseProtectionHooks(repo).status, "ACTIVE");

  const uninstalled = uninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(uninstalled.status, "UNINSTALLED");
  assert.deepEqual(fs.readFileSync(originalHook), originalBytes);
});

test("安全卸载恢复安装前 hooksPath 和原 hook 字节/模式，重复卸载返回 ALREADY_UNINSTALLED", () => {
  const repo = makeGitRepo("卸载 恢复");
  const originalHooksDir = path.join(repo, "original hooks");
  fs.mkdirSync(originalHooksDir);
  git(repo, ["config", "--local", "core.hooksPath", "original hooks"]);
  const originalHook = path.join(originalHooksDir, "pre-commit");
  const originalBytes = Buffer.from("#!/bin/sh\r\nprintf original\r\n", "utf8");
  fs.writeFileSync(originalHook, originalBytes);
  fs.chmodSync(originalHook, 0o751);
  const originalMode = fs.statSync(originalHook).mode & 0o777;

  assert.equal(installWithValidator(repo).status, "ACTIVE");
  assert.equal(previewUninstallBaseProtectionHooks(repo, controllerIdle).status, "READY");
  const result = uninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(result.status, "UNINSTALLED");
  assert.ok(result.removed.includes("pre-commit"));
  assert.ok(result.restored.includes("pre-commit"));
  assert.equal(git(repo, ["config", "--local", "--get", "core.hooksPath"]), "original hooks");
  assert.deepEqual(fs.readFileSync(originalHook), originalBytes);
  assert.equal(fs.statSync(originalHook).mode & 0o777, originalMode);
  assert.equal(
    path.resolve(git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])),
    path.resolve(originalHooksDir),
  );
  assert.equal(uninstallBaseProtectionHooks(repo).status, "ALREADY_UNINSTALLED");
});

test("dispatcher 漂移时 uninstall-preview 返回 DRIFTED，卸载不删不覆盖", () => {
  const repo = makeGitRepo("dispatcher drift");
  assert.equal(installBaseProtectionHooks(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const dispatcher = path.join(paths.hooks, "pre-commit");
  fs.appendFileSync(dispatcher, "\n# local drift\n");
  const before = fs.readFileSync(dispatcher);
  const activeHooksPath = git(repo, ["config", "--local", "--get", "core.hooksPath"]);

  const preview = previewUninstallBaseProtectionHooks(repo);
  assert.equal(preview.status, "DRIFTED");
  assert.ok(preview.issues.includes("DISPATCHER_HASH_DRIFT:pre-commit"));
  const result = uninstallBaseProtectionHooks(repo);
  assert.equal(result.status, "DRIFTED");
  assert.deepEqual(fs.readFileSync(dispatcher), before);
  assert.equal(git(repo, ["config", "--local", "--get", "core.hooksPath"]), activeHooksPath);
});

test("原 hook 备份漂移时拒绝卸载，active lease 与 legacy worktree 回调也会阻断", () => {
  const repo = makeGitRepo("backup drift");
  const hooksDir = path.join(repo, ".hooks");
  fs.mkdirSync(hooksDir);
  git(repo, ["config", "--local", "core.hooksPath", ".hooks"]);
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755);
  assert.equal(installBaseProtectionHooks(repo).status, "ACTIVE");
  const paths = managedPaths(repo);

  fs.appendFileSync(path.join(paths.previous, "pre-commit"), "# drift\n");
  const drift = previewUninstallBaseProtectionHooks(repo);
  assert.equal(drift.status, "DRIFTED");
  assert.ok(drift.issues.includes("BACKUP_HASH_DRIFT:pre-commit"));

  const cleanRepo = makeGitRepo("callback blocks");
  assert.equal(installBaseProtectionHooks(cleanRepo).status, "ACTIVE");
  const lease = previewUninstallBaseProtectionHooks(cleanRepo, {
    activeLeaseCheck: () => true,
    legacyLinkedWorktreeCheck: () => false,
  });
  assert.equal(lease.status, "DRIFTED");
  assert.ok(lease.issues.includes("ACTIVE_REPOSITORY_LEASE"));
  const legacy = previewUninstallBaseProtectionHooks(cleanRepo, {
    activeLeaseCheck: () => false,
    legacyLinkedWorktreeCheck: () => true,
  });
  assert.equal(legacy.status, "DRIFTED");
  assert.ok(legacy.issues.includes("ACTIVE_LEGACY_LINKED_WORKTREE"));
});

test("standalone diagnose 使用统一 runtime，默认 Controller 不可达时 guard 失败关闭", async () => {
  const repo = makeGitRepo("runtime diagnose");
  assert.equal(installBaseProtectionHooks(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const diagnose = spawnSync(
    process.execPath,
    [path.join(paths.runtime, "manage.mjs"), "hooks-diagnose"],
    { cwd: repo, encoding: "utf8", windowsHide: true },
  );
  assert.equal(diagnose.status, 0, diagnose.stderr);
  assert.equal(JSON.parse(diagnose.stdout).status, "ACTIVE");

  const denied = await guardBaseProtectionHook(repo, {
    hook: "pre-commit",
    capability: "untrusted",
    repositoryPath: repo,
  });
  assert.deepEqual(denied, { ok: false, reason: "CONTROLLER_UNAVAILABLE" });
});

test("command validator descriptor 可持久化，验证器不可达时 guard 失败关闭", async () => {
  const repo = makeGitRepo("command validator");
  const validator = makeCommandValidator(path.dirname(repo));
  assert.equal(installBaseProtectionHooks(repo, {
    capabilityValidatorDescriptor: {
      type: "command",
      executable: process.execPath,
      args: [validator],
      timeoutMs: 2_000,
    },
  }).status, "ACTIVE");

  const manifest = JSON.parse(fs.readFileSync(managedPaths(repo).manifest, "utf8"));
  assert.deepEqual(manifest.capability.validator, {
    type: "command",
    executable: path.resolve(process.execPath),
    executableSha256: __test.sha256(fs.readFileSync(process.execPath)),
    args: [validator],
    argFiles: [{
      path: validator,
      sha256: __test.sha256(fs.readFileSync(validator)),
    }],
    timeoutMs: 2_000,
  });
  assert.deepEqual(
    await guardBaseProtectionHook(repo, {
      hook: "pre-commit",
      capability: "command-test-capability",
      repositoryPath: repo,
    }),
    { ok: true, reason: "COMMAND_CAPABILITY_VALID" },
  );

  fs.rmSync(validator);
  assert.deepEqual(
    await guardBaseProtectionHook(repo, {
      hook: "pre-commit",
      capability: "command-test-capability",
      repositoryPath: repo,
    }),
    { ok: false, reason: "CAPABILITY_VALIDATOR_UNSAFE" },
  );
});

test("capability issuer/validator 支持依赖注入且验证异常失败关闭", async () => {
  configureBaseProtectionCapabilities({
    issuer: async (context) => `issued:${context.operationId}`,
    validator: async (context) => ({ ok: context.capability === "issued:op-1", reason: "INJECTED" }),
  });
  assert.equal(await issueBaseProtectionCapability({ operationId: "op-1" }), "issued:op-1");
  assert.deepEqual(
    await validateBaseProtectionCapability({ capability: "issued:op-1" }),
    { ok: true, reason: "INJECTED" },
  );
  configureBaseProtectionCapabilities({
    validator: async () => { throw new Error("controller down"); },
  });
  assert.deepEqual(
    await validateBaseProtectionCapability({ capability: "anything" }),
    { ok: false, reason: "CONTROLLER_UNAVAILABLE" },
  );
  configureBaseProtectionCapabilities();
});

test("legacy marker alone never classifies or deletes a user hook", () => {
  const repo = makeGitRepo("strict legacy identity");
  const hooksDir = path.join(repo, ".user-hooks");
  fs.mkdirSync(hooksDir);
  git(repo, ["config", "--local", "core.hooksPath", ".user-hooks"]);
  const hookPath = path.join(hooksDir, "pre-commit");
  const bytes = Buffer.from(
    "#!/bin/sh\n# devbench-base-protection\n# This is a user-owned hook mentioning DevBench.\nexit 0\n",
  );
  fs.writeFileSync(hookPath, bytes);
  fs.chmodSync(hookPath, 0o755);

  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const manifest = JSON.parse(fs.readFileSync(managedPaths(repo).manifest, "utf8"));
  assert.equal(manifest.hooks["pre-commit"].previous.legacyManaged, false);
  assert.equal(manifest.hooks["pre-commit"].previous.existed, true);
  assert.equal(uninstallBaseProtectionHooks(repo, controllerIdle).status, "UNINSTALLED");
  assert.deepEqual(fs.readFileSync(hookPath), bytes);
});

test("only the byte-exact legacy dispatcher is migrated and its backup is restored", () => {
  const repo = makeGitRepo("exact legacy migration");
  const hooksDir = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "pre-commit");
  const backupPath = `${hookPath}.pre-devbench.bak`;
  const legacy = `#!/bin/sh
# devbench-base-protection
# Blocks commits on base repo non-story branches. Allows story/* (worktree) and system ops.
if [ "$DEVBENCH_SYSTEM_GIT_OP" = "1" ]; then
  exit 0
fi
branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
case "$branch" in
  story/*) exit 0 ;;
  *)
    echo "devbench: base repo commits on branch '$branch' are blocked. Commit in the story worktree instead." >&2
    exit 1
    ;;
esac
`;
  const userBytes = Buffer.from("#!/bin/sh\nprintf legacy-user-backup\n");
  fs.writeFileSync(hookPath, legacy);
  fs.writeFileSync(backupPath, userBytes);
  fs.chmodSync(hookPath, 0o755);
  fs.chmodSync(backupPath, 0o751);

  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const manifest = JSON.parse(fs.readFileSync(managedPaths(repo).manifest, "utf8"));
  assert.equal(manifest.hooks["pre-commit"].previous.legacyManaged, true);
  assert.deepEqual(fs.readFileSync(hookPath), userBytes);
  assert.equal(fs.existsSync(backupPath), false);
  assert.equal(uninstallBaseProtectionHooks(repo, controllerIdle).status, "UNINSTALLED");
  assert.deepEqual(fs.readFileSync(hookPath), userBytes);
});

test("unknown edits to the original hook block uninstall and are never overwritten", () => {
  const repo = makeGitRepo("original target drift");
  const hooksDir = path.join(repo, ".user-hooks");
  fs.mkdirSync(hooksDir);
  git(repo, ["config", "--local", "core.hooksPath", ".user-hooks"]);
  const hookPath = path.join(hooksDir, "pre-commit");
  fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(hookPath, 0o755);
  assert.equal(installWithValidator(repo).status, "ACTIVE");

  fs.writeFileSync(hookPath, "#!/bin/sh\nprintf operator-change\n");
  const drifted = fs.readFileSync(hookPath);
  const preview = previewUninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(preview.status, "DRIFTED");
  assert.ok(preview.issues.includes("ORIGINAL_TARGET_DRIFT:pre-commit"));
  const result = uninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(result.status, "DRIFTED");
  assert.deepEqual(fs.readFileSync(hookPath), drifted);
  assert.equal(
    path.resolve(git(repo, ["config", "--local", "--get", "core.hooksPath"])),
    path.resolve(managedPaths(repo).hooks),
  );
});

test("unknown mode changes to the original hook also block restoration", () => {
  const repo = makeGitRepo("original mode drift");
  const hooksDir = path.join(repo, ".user-hooks");
  fs.mkdirSync(hooksDir);
  git(repo, ["config", "--local", "core.hooksPath", ".user-hooks"]);
  const hookPath = path.join(hooksDir, "pre-commit");
  fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(hookPath, 0o751);
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const installedMode = fs.statSync(hookPath).mode & 0o777;
  const changedMode = (installedMode & 0o222) !== 0 ? 0o444 : 0o666;
  fs.chmodSync(hookPath, changedMode);
  const actualChangedMode = fs.statSync(hookPath).mode & 0o777;
  assert.notEqual(actualChangedMode, installedMode);

  const preview = previewUninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(preview.status, "DRIFTED");
  assert.ok(preview.issues.includes("ORIGINAL_TARGET_MODE_DRIFT:pre-commit"));
  assert.equal(uninstallBaseProtectionHooks(repo, controllerIdle).status, "DRIFTED");
  assert.equal(fs.statSync(hookPath).mode & 0o777, actualChangedMode);
});

test("runtime core/manage hashes are enforced by diagnose and hook guard", async () => {
  for (const runtimeName of ["core", "manage"]) {
    const repo = makeGitRepo(`runtime hash ${runtimeName}`);
    assert.equal(installWithValidator(repo).status, "ACTIVE");
    const paths = managedPaths(repo);
    fs.appendFileSync(path.join(paths.runtime, `${runtimeName}.mjs`), "\n// drift\n");

    const diagnosis = diagnoseBaseProtectionHooks(repo);
    assert.equal(diagnosis.status, "DRIFTED");
    assert.ok(diagnosis.issues.includes(`RUNTIME_${runtimeName.toUpperCase()}_HASH_DRIFT`));
    const guard = await guardBaseProtectionHook(repo, {
      hook: "pre-commit",
      capability: "signed-test-capability",
      repositoryPath: repo,
    });
    assert.equal(guard.ok, false);
    assert.equal(guard.reason, `RUNTIME_${runtimeName.toUpperCase()}_HASH_DRIFT`);
  }
});

test("hard-linked managed files are rejected even when their hash still matches", () => {
  const repo = makeGitRepo("hardlink escape");
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const dispatcher = path.join(paths.hooks, "pre-commit");
  const outside = path.join(path.dirname(repo), "outside-hook");
  fs.copyFileSync(dispatcher, outside);
  fs.rmSync(dispatcher);
  fs.linkSync(outside, dispatcher);

  const diagnosis = diagnoseBaseProtectionHooks(repo);
  assert.equal(diagnosis.status, "DRIFTED");
  assert.ok(diagnosis.issues.includes("DISPATCHER_UNSAFE:pre-commit"));
  const result = uninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(result.status, "DRIFTED");
  assert.equal(fs.existsSync(dispatcher), true);
  assert.equal(fs.existsSync(outside), true);
});

test("symbolic-link or junction escape in managed runtime is rejected without deletion", () => {
  const repo = makeGitRepo("junction escape");
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const outsideRuntime = path.join(path.dirname(repo), "outside-runtime");
  fs.renameSync(paths.runtime, outsideRuntime);
  fs.symlinkSync(
    outsideRuntime,
    paths.runtime,
    process.platform === "win32" ? "junction" : "dir",
  );

  const diagnosis = diagnoseBaseProtectionHooks(repo);
  assert.equal(diagnosis.status, "DRIFTED");
  assert.ok(diagnosis.issues.some((issue) => (
    issue.startsWith("RUNTIME_CORE_")
    || issue.startsWith("RUNTIME_MANAGE_")
  )));
  const result = uninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(result.status, "DRIFTED");
  assert.equal(fs.existsSync(path.join(outsideRuntime, "core.mjs")), true);
  assert.equal(fs.lstatSync(paths.runtime).isSymbolicLink(), true);
});

test("uninstall journal resumes an interrupted atomic restoration with the same operation", () => {
  const repo = makeGitRepo("uninstall recovery");
  const hooksDir = path.join(repo, ".user-hooks");
  fs.mkdirSync(hooksDir);
  git(repo, ["config", "--local", "core.hooksPath", ".user-hooks"]);
  const hookPath = path.join(hooksDir, "pre-commit");
  const bytes = Buffer.from("#!/bin/sh\nprintf restored\n");
  fs.writeFileSync(hookPath, bytes);
  fs.chmodSync(hookPath, 0o751);
  assert.equal(installWithValidator(repo).status, "ACTIVE");

  const interrupted = uninstallBaseProtectionHooks(repo, {
    ...controllerIdle,
    phaseHook({ phase }) {
      if (phase === "ORIGINAL_HOOKS_RESTORED") throw new Error("simulated crash");
    },
  });
  assert.equal(interrupted.status, "RECOVERY_REQUIRED");
  assert.match(interrupted.operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(fs.readFileSync(hookPath), bytes);
  assert.equal(JSON.parse(fs.readFileSync(managedPaths(repo).state, "utf8")).status, "UNINSTALLING");

  const recovered = uninstallBaseProtectionHooks(repo, controllerIdle);
  assert.equal(recovered.status, "UNINSTALLED");
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.operationId, interrupted.operationId);
  assert.deepEqual(fs.readFileSync(hookPath), bytes);
  const journal = JSON.parse(
    fs.readFileSync(path.join(managedPaths(repo).runtime, "uninstall-journal.json"), "utf8"),
  );
  assert.equal(journal.status, "COMPLETED");
  assert.equal(journal.phase, "COMPLETED");
});

test("dead management locks are archived after PID proof while live locks fail closed", () => {
  const staleRepo = makeGitRepo("stale manage lock");
  assert.equal(installWithValidator(staleRepo).status, "ACTIVE");
  const stalePaths = managedPaths(staleRepo);
  const lockPath = path.join(stalePaths.runtime, "manage.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    lockId: "stale-lock",
    pid: 2_147_483_646,
    operation: "uninstall",
    startedAt: new Date(0).toISOString(),
    host: os.hostname(),
  })}\n`);
  const recovered = uninstallBaseProtectionHooks(staleRepo, controllerIdle);
  assert.equal(recovered.status, "UNINSTALLED");
  assert.equal(fs.existsSync(lockPath), false);
  assert.ok(
    fs.readdirSync(path.join(stalePaths.root, "logs"))
      .some((name) => name.startsWith("stale-manage-lock-")),
  );

  const liveRepo = makeGitRepo("live manage lock");
  assert.equal(installWithValidator(liveRepo).status, "ACTIVE");
  const livePaths = managedPaths(liveRepo);
  const liveLock = path.join(livePaths.runtime, "manage.lock");
  fs.writeFileSync(liveLock, `${JSON.stringify({
    lockId: "live-lock",
    pid: process.pid,
    operation: "uninstall",
    startedAt: new Date().toISOString(),
    host: os.hostname(),
  })}\n`);
  const blocked = uninstallBaseProtectionHooks(liveRepo, controllerIdle);
  assert.equal(blocked.status, "DRIFTED");
  assert.ok(blocked.issues.includes("BASE_PROTECTION_LOCKED"));
  assert.equal(fs.existsSync(path.join(livePaths.hooks, "pre-commit")), true);
  assert.equal(fs.existsSync(liveLock), true);
  assert.equal(JSON.parse(fs.readFileSync(livePaths.state, "utf8")).status, "ACTIVE");
});

test("stale lock recovery refuses to unlock while a real Git process references the repository", async () => {
  const repo = makeGitRepo("git process blocks stale lock");
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const lockPath = path.join(paths.runtime, "manage.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    lockId: "stale-with-git",
    pid: 2_147_483_646,
    operation: "uninstall",
    startedAt: new Date(0).toISOString(),
    host: os.hostname(),
  })}\n`);
  const gitProcess = spawn(
    "git",
    ["-C", repo, "cat-file", "--batch"],
    {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  await new Promise((resolve, reject) => {
    gitProcess.once("spawn", resolve);
    gitProcess.once("error", reject);
  });
  try {
    const blocked = uninstallBaseProtectionHooks(repo, controllerIdle);
    assert.equal(blocked.status, "DRIFTED");
    assert.ok(blocked.issues.includes("BASE_PROTECTION_GIT_PROCESS_ACTIVE"));
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(JSON.parse(fs.readFileSync(paths.state, "utf8")).status, "ACTIVE");
  } finally {
    gitProcess.stdin.end();
    if (gitProcess.exitCode == null) gitProcess.kill();
  }
});

test("UNINSTALLED diagnosis detects hooksPath reactivation and managed residual files", () => {
  const repo = makeGitRepo("uninstalled residual");
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const dispatcherBytes = fs.readFileSync(path.join(paths.hooks, "pre-commit"));
  assert.equal(uninstallBaseProtectionHooks(repo, controllerIdle).status, "UNINSTALLED");

  fs.mkdirSync(paths.hooks, { recursive: true });
  fs.writeFileSync(path.join(paths.hooks, "pre-commit"), dispatcherBytes);
  git(repo, ["config", "--local", "core.hooksPath", paths.hooks]);
  const diagnosis = diagnoseBaseProtectionHooks(repo);
  assert.equal(diagnosis.status, "DRIFTED");
  assert.ok(diagnosis.issues.includes("UNINSTALLED_HOOKS_PATH_REACTIVATED"));
  assert.ok(diagnosis.issues.includes("UNINSTALLED_EFFECTIVE_HOOKS_REACTIVATED"));
  assert.ok(diagnosis.issues.some((issue) => (
    issue === "UNINSTALLED_DISPATCHER_REACTIVATED:pre-commit"
    || issue.startsWith("UNINSTALLED_MANAGED_HOOKS_RESIDUAL:")
  )));
});

test("lease and legacy worktree probes fail closed when authority is unavailable", () => {
  const repo = makeGitRepo("failed safety probes");
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const noController = previewUninstallBaseProtectionHooks(repo);
  assert.equal(noController.status, "DRIFTED");
  assert.ok(noController.issues.some((issue) => issue.startsWith("ACTIVE_LEASE_CHECK_FAILED:")));

  const legacyFailure = previewUninstallBaseProtectionHooks(repo, {
    activeLeaseCheck: () => false,
    legacyLinkedWorktreeCheck: () => {
      throw new Error("git worktree list unavailable");
    },
  });
  assert.equal(legacyFailure.status, "DRIFTED");
  assert.ok(legacyFailure.issues.some((issue) => issue.startsWith("LEGACY_WORKTREE_CHECK_FAILED:")));
});

test("standalone uninstall invokes only the pinned Controller helper and fails closed on drift", () => {
  const repo = makeGitRepo("standalone helper");
  const helper = path.join(path.dirname(repo), "fake-controller-helper.mjs");
  fs.writeFileSync(helper, `
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
const expected = [
  "standalone-hooks-uninstall",
  "--repository-id", "repo-test",
  "--installation-id",
];
const expectedIdempotencyKey = createHash("sha256").update([
  "devbench-hooks-standalone",
  "uninstall",
  args[4],
  args[6],
].join(String.fromCharCode(0))).digest("hex");
if (args[0] !== expected[0] || args[1] !== expected[1] || args[2] !== expected[2]
    || args[3] !== expected[3] || !args[4]
    || args[5] !== "--manifest-sha256" || !/^[0-9a-f]{64}$/.test(args[6])
    || args[7] !== "--idempotency-key" || args[8] !== expectedIdempotencyKey) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "BAD_ARGS" } }));
  process.exit(2);
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: { status: "UNINSTALLED" } }));
}
`);
  secureTestFile(helper);
  const result = installBaseProtectionHooks(repo, {
    repositoryId: "repo-test",
    managementClientDescriptor: {
      type: "command",
      executable: testRuntimeExecutablePaths().nodeBinary,
      helperPath: helper,
      fixedArgs: [],
    },
  });
  assert.equal(result.status, "ACTIVE", result.error);
  const managedRoot = managedPaths(repo).root;
  assert.equal(
    invokeStandaloneController(managedRoot, "uninstall", { launcher: "sh" }).status,
    "UNINSTALLED",
  );

  fs.appendFileSync(helper, "\n// drift\n");
  const drift = invokeStandaloneController(managedRoot, "uninstall");
  assert.equal(drift.status, "CONTROLLER_UNAVAILABLE");
  assert.ok(drift.issues.includes("BASE_PROTECTION_MANAGEMENT_CLIENT_DRIFT"));
});

test("management helper with broad write permissions is rejected during install", () => {
  const repo = makeGitRepo("weak helper permissions");
  const helper = path.join(path.dirname(repo), "weak-helper.mjs");
  fs.writeFileSync(helper, "process.stdout.write('{}');\n");
  if (process.platform === "win32") {
    execFileSync("icacls.exe", [
      helper,
      "/grant",
      "*S-1-5-11:(M)",
    ], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    fs.chmodSync(helper, 0o777);
  }
  const result = installBaseProtectionHooks(repo, {
    repositoryId: "repo-weak-helper",
    managementClientDescriptor: {
      type: "command",
      executable: process.execPath,
      helperPath: helper,
      fixedArgs: [],
    },
  });
  assert.equal(result.status, "DEGRADED");
  assert.equal(
    result.errorCode,
    "BASE_PROTECTION_MANAGEMENT_CLIENT_PERMISSIONS_WEAK",
  );
});

test("ACTIVE idempotent install atomically repairs one missing local activation audit", () => {
  const repo = makeGitRepo("active audit recovery");
  const installed = installWithValidator(repo);
  assert.equal(installed.status, "ACTIVE");
  const paths = managedPaths(repo);
  const auditPath = path.join(paths.root, "logs", "audit.jsonl");
  fs.writeFileSync(auditPath, "", "utf8");

  const recovered = installWithValidator(repo);
  assert.equal(recovered.status, "ACTIVE");
  assert.equal(recovered.idempotent, true);
  const firstEvents = fs.readFileSync(auditPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    firstEvents.filter((event) => event.event === "HOOKS_INSTALL_RECOVERED").length,
    1,
  );
  assert.equal(firstEvents[0].recoveredFromActiveState, true);

  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const secondEvents = fs.readFileSync(auditPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    secondEvents.filter((event) => event.event === "HOOKS_INSTALL_RECOVERED").length,
    1,
  );
});

test("DEGRADED installation with managed hooksPath does not replace the original hook backup", () => {
  const repo = makeGitRepo("degraded managed hooks path");
  const originalHooksDir = path.join(repo, "original hooks");
  fs.mkdirSync(originalHooksDir);
  git(repo, ["config", "--local", "core.hooksPath", "original hooks"]);
  const originalHook = path.join(originalHooksDir, "pre-commit");
  const originalBytes = Buffer.from("#!/bin/sh\nprintf original-degraded\n", "utf8");
  fs.writeFileSync(originalHook, originalBytes, { mode: 0o755 });
  assert.equal(installWithValidator(repo).status, "ACTIVE");

  const paths = managedPaths(repo);
  const manifestBefore = fs.readFileSync(paths.manifest);
  const manifest = JSON.parse(manifestBefore.toString("utf8"));
  const backupPath = path.resolve(
    paths.root,
    manifest.hooks["pre-commit"].previous.backupPath,
  );
  const backupBefore = fs.readFileSync(backupPath);
  const dispatcherBefore = fs.readFileSync(path.join(paths.hooks, "pre-commit"));
  const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
  const stateBefore = fs.readFileSync(paths.state);
  fs.writeFileSync(paths.state, `${JSON.stringify({
    ...state,
    status: "DEGRADED",
    operation: "install",
    error: "simulated interrupted failure",
  }, null, 2)}\n`, "utf8");

  const blocked = installWithValidator(repo);
  assert.equal(blocked.status, "DRIFTED");
  assert.ok(
    blocked.issues.includes("INSTALLATION_STATE_NOT_RECOVERABLE:DEGRADED"),
  );
  assert.deepEqual(fs.readFileSync(paths.manifest), manifestBefore);
  assert.deepEqual(fs.readFileSync(backupPath), backupBefore);
  assert.deepEqual(backupBefore, originalBytes);
  assert.deepEqual(
    fs.readFileSync(path.join(paths.hooks, "pre-commit")),
    dispatcherBefore,
  );

  fs.rmSync(paths.state);
  const missingState = installWithValidator(repo);
  assert.equal(missingState.status, "DRIFTED");
  assert.ok(missingState.issues.includes("INSTALLATION_STATE_MISSING"));
  assert.deepEqual(fs.readFileSync(backupPath), backupBefore);

  fs.writeFileSync(paths.state, `${JSON.stringify({
    ...state,
    status: "FUTURE_UNKNOWN_STATE",
  }, null, 2)}\n`, "utf8");
  const unknownState = installWithValidator(repo);
  assert.equal(unknownState.status, "DRIFTED");
  assert.ok(
    unknownState.issues.includes(
      "INSTALLATION_STATE_NOT_RECOVERABLE:FUTURE_UNKNOWN_STATE",
    ),
  );
  assert.deepEqual(fs.readFileSync(backupPath), backupBefore);

  fs.writeFileSync(paths.state, stateBefore);
  fs.rmSync(paths.manifest);
  const missingManifest = installWithValidator(repo);
  assert.equal(missingManifest.status, "DRIFTED");
  assert.ok(missingManifest.issues.includes("INSTALLATION_MANIFEST_MISSING"));
  assert.deepEqual(fs.readFileSync(backupPath), backupBefore);
});

test("standalone launcher never falls back to local uninstall when Controller is unavailable", () => {
  const repo = makeGitRepo("standalone fail close");
  assert.equal(installWithValidator(repo).status, "ACTIVE");
  const paths = managedPaths(repo);
  const result = spawnSync(
    process.execPath,
    [path.join(paths.runtime, "manage.mjs"), "hooks-uninstall", "--launcher=sh"],
    { cwd: repo, encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "CONTROLLER_UNAVAILABLE");
  assert.equal(JSON.parse(fs.readFileSync(paths.state, "utf8")).status, "ACTIVE");
  assert.equal(fs.existsSync(path.join(paths.hooks, "pre-commit")), true);
});

test("non-git 路径显式 DEGRADED，不创建伪 .git/hooks", () => {
  const directory = tempRoot("base-protection-non-git");
  const result = installBaseProtectionHooks(directory);
  assert.equal(result.status, "DEGRADED");
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped, [...__test.HOOK_NAMES]);
  assert.equal(fs.existsSync(path.join(directory, ".git", "hooks")), false);
  assert.equal(listBaseProtectionHooks(directory).status, "NOT_INSTALLED");
  assert.equal(diagnoseBaseProtectionHooks(directory).status, "DRIFTED");
});
