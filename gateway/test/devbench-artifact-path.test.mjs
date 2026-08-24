import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import express from "express";
import {
  resolveInstallPackageReference,
  revealFileInManager,
} from "../services/devbench/artifact-path.js";
import { createDevbenchArtifactsRouter } from "../routes/devbench-artifacts.js";

function withArtifactRoots(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-artifact-"));
  const storyDirectory = path.join(root, "StoryDev", "CARB-13906");
  const projectRoot = path.join(root, "worktree");
  fs.mkdirSync(storyDirectory, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  try {
    run({ root, storyDirectory, projectRoot });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("relative tempFiles package path resolves against StoryDev first", () => {
  withArtifactRoots(({ storyDirectory, projectRoot }) => {
    const file = path.join(storyDirectory, "tempFiles", "verification-apks", "carb13906-device-signed.apk");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "apk");

    const result = resolveInstallPackageReference(
      ".\\tempFiles\\verification-apks\\carb13906-device-signed.apk",
      { storyDirectory, projectRoots: [projectRoot] },
    );

    assert.equal(result.ok, true);
    assert.equal(result.file, file);
    assert.equal(result.source, "storydev");
  });
});

test("storydev and project build paths resolve inside their owning roots", () => {
  withArtifactRoots(({ storyDirectory, projectRoot }) => {
    const storyApk = path.join(storyDirectory, "reports", "acceptance.apks");
    const projectApk = path.join(projectRoot, "app", "build", "outputs", "apk", "release", "app-release.apk");
    fs.mkdirSync(path.dirname(storyApk), { recursive: true });
    fs.mkdirSync(path.dirname(projectApk), { recursive: true });
    fs.writeFileSync(storyApk, "apks");
    fs.writeFileSync(projectApk, "apk");

    const storyResult = resolveInstallPackageReference("storydev:/reports/acceptance.apks", {
      storyDirectory,
      projectRoots: [projectRoot],
    });
    const projectResult = resolveInstallPackageReference("app/build/outputs/apk/release/app-release.apk", {
      storyDirectory,
      projectRoots: [projectRoot],
    });

    assert.equal(storyResult.file, storyApk);
    assert.equal(projectResult.file, projectApk);
    assert.equal(projectResult.source, "project");
  });
});

test("resolver rejects traversal, unsupported files, outside paths and missing packages", () => {
  withArtifactRoots(({ root, storyDirectory, projectRoot }) => {
    const outside = path.join(root, "outside.apk");
    fs.writeFileSync(outside, "apk");
    const options = { storyDirectory, projectRoots: [projectRoot] };

    assert.equal(resolveInstallPackageReference("..\\outside.apk", options).code, "ARTIFACT_PATH_OUTSIDE");
    assert.equal(resolveInstallPackageReference("tempFiles\\report.txt", options).code, "ARTIFACT_TYPE_UNSUPPORTED");
    assert.equal(resolveInstallPackageReference(outside, options).code, "ARTIFACT_PATH_OUTSIDE");
    assert.equal(resolveInstallPackageReference("tempFiles\\missing.apk", options).code, "ARTIFACT_NOT_FOUND");
  });
});

test("Windows reveal selects the package in Explorer without shell interpolation", async () => {
  const target = path.resolve("build", "outputs", "app release.apk");
  let invocation;
  const result = await revealFileInManager(target, {
    platform: "win32",
    spawnImpl: (opener, args, options) => {
      invocation = { opener, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(invocation.opener, "explorer.exe");
  assert.deepEqual(invocation.args, [`/select,${target.replace(/\//g, "\\")}`]);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.stdio, "ignore");
  assert.equal(invocation.options.shell, undefined);
});

test("artifact route reveals only a package owned by the requested story", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-artifact-route-"));
  const storyDirectory = path.join(root, "StoryDev", "CARB-13906");
  const projectRoot = path.join(root, "worktree");
  const file = path.join(storyDirectory, "tempFiles", "verification-apks", "device-signed.apk");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(file, "apk");

  let revealed = "";
  const router = createDevbenchArtifactsRouter({
    store: {
      getTab: (id) => (id === "tab-1" ? { id } : null),
      getStoryStoragePaths: () => ({ storyDirectory }),
      tabProjectPaths: () => [{ path: projectRoot }],
      validateStoryStorageTarget: (_tab, target, options) => {
        assert.equal(target, file);
        assert.deepEqual(options, { mustExist: true, expectedType: "file" });
      },
    },
    revealFile: async (target) => {
      revealed = target;
      return { ok: true };
    },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/tabs/tab-1/artifacts/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: ".\\tempFiles\\verification-apks\\device-signed.apk" }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data.name, "device-signed.apk");
    assert.equal(revealed, file);

    const rejected = await fetch(`http://127.0.0.1:${address.port}/tabs/tab-1/artifacts/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "..\\outside.apk" }),
    });
    assert.equal(rejected.status, 403);

    const remoteRejected = await fetch(`http://127.0.0.1:${address.port}/tabs/tab-1/artifacts/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.10.10.8" },
      body: JSON.stringify({ path: ".\\tempFiles\\verification-apks\\device-signed.apk" }),
    });
    assert.equal(remoteRejected.status, 403);
    assert.equal((await remoteRejected.json()).code, "ARTIFACT_REVEAL_LOCAL_ONLY");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("story attachment route reveals current-story files and folders but rejects traversal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-story-reveal-"));
  const storyDirectory = path.join(root, "StoryDev", "CARB-attachment");
  const attachmentDirectory = path.join(storyDirectory, "archives");
  const folder = path.join(attachmentDirectory, "logs");
  const file = path.join(folder, "trace.log");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, "trace");
  const revealed = [];
  const validate = (_tab, target, options = {}) => {
    const relative = path.relative(storyDirectory, path.resolve(target));
    assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`), false);
    if (options.mustExist) assert.equal(fs.existsSync(target), true);
    return target;
  };
  const router = createDevbenchArtifactsRouter({
    store: {
      getTab: (id) => (id === "tab-1" ? { id } : null),
      getStoryStoragePaths: () => ({ storyDirectory, attachmentDirectory }),
      tabProjectPaths: () => [],
      validateStoryStorageTarget: validate,
    },
    revealFile: async (target) => { revealed.push(target); return { ok: true }; },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}/tabs/tab-1/artifacts/reveal`;
    for (const [ref, expectedKind, expectedTarget] of [
      ["storydev:/archives/logs/trace.log", "file", file],
      ["storydev:/archives/logs", "folder", folder],
    ]) {
      const response = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.data.kind, expectedKind);
      assert.equal(revealed.at(-1), expectedTarget);
    }
    const rejected = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "storydev:/archives/../secret.txt" }),
    });
    assert.equal(rejected.status, 400);

    const remoteRejected = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.10.10.8" },
      body: JSON.stringify({ ref: "storydev:/archives/logs/trace.log" }),
    });
    assert.equal(remoteRejected.status, 403);
    assert.equal((await remoteRejected.json()).code, "ARTIFACT_REVEAL_LOCAL_ONLY");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clipboard import copies regular files into the story and preserves the display filename", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-clipboard-import-"));
  const storyDirectory = path.join(root, "StoryDev", "CARB-clipboard");
  const attachmentDirectory = path.join(storyDirectory, "archives");
  const sourceDirectory = path.join(root, "source");
  const sourceFile = path.join(sourceDirectory, "问题截图 01.png");
  const duplicateSourceFile = path.join(root, "source-duplicate", "问题截图 01.png");
  const sourceFolder = path.join(sourceDirectory, "folder");
  fs.mkdirSync(attachmentDirectory, { recursive: true });
  fs.mkdirSync(sourceFolder, { recursive: true });
  fs.mkdirSync(path.dirname(duplicateSourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, "png-data");
  fs.writeFileSync(duplicateSourceFile, "png-data-2");
  const validate = (_tab, target, options = {}) => {
    const resolved = path.resolve(target);
    const relative = path.relative(storyDirectory, resolved);
    assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`), false);
    if (options.createDirectory) fs.mkdirSync(resolved);
    if (options.mustExist) assert.equal(fs.existsSync(resolved), true);
    return resolved;
  };
  const router = createDevbenchArtifactsRouter({
    store: {
      getTab: (id) => (id === "tab-1" ? { id } : null),
      getStoryStoragePaths: () => ({ storyDirectory, attachmentDirectory }),
      tabProjectPaths: () => [],
      validateStoryStorageTarget: validate,
    },
    readClipboardPaths: () => [sourceFile, duplicateSourceFile, sourceFolder],
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/tabs/tab-1/attachments/import-clipboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.data.map((item) => item.name), ["问题截图 01.png", "问题截图 01.png"]);
    assert.deepEqual(body.data.map((item) => item.storageName), ["问题截图 01.png", "问题截图 01 (2).png"]);
    assert.match(body.data[0].relPath, /^storydev:\/archives\/chat-attachments\/.+\/问题截图 01\.png$/);
    const copied = path.join(storyDirectory, body.data[0].relPath.slice("storydev:/".length));
    assert.equal(fs.readFileSync(copied, "utf8"), "png-data");
    const copiedDuplicate = path.join(storyDirectory, body.data[1].relPath.slice("storydev:/".length));
    assert.equal(fs.readFileSync(copiedDuplicate, "utf8"), "png-data-2");
    assert.deepEqual(body.skipped, [{ name: "folder", reason: "文件夹请使用拖拽上传" }]);

    const remoteRejected = await fetch(`http://127.0.0.1:${server.address().port}/tabs/tab-1/attachments/import-clipboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.10.10.8" },
      body: "{}",
    });
    assert.equal(remoteRejected.status, 403);
    assert.equal((await remoteRejected.json()).code, "CLIPBOARD_LOCAL_ONLY");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
