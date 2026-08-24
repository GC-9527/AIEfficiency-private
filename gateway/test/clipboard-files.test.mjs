import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { readClipboardFilePaths } from "../services/clipboard-files.js";
import { createClipboardRouter } from "../routes/clipboard.js";

test("Windows 文件剪贴板保留系统返回的原始文件名与路径", () => {
  let invocation;
  const paths = readClipboardFilePaths({
    platform: "win32",
    execFileSyncImpl: (command, args, options) => {
      invocation = { command, args, options };
      return "D:\\资料\\问题截图 01.png\r\nD:\\资料\\验收报告.pdf\r\n";
    },
  });

  assert.deepEqual(paths, ["D:\\资料\\问题截图 01.png", "D:\\资料\\验收报告.pdf"]);
  assert.equal(invocation.command, "powershell");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(invocation.options.shell, undefined);
});

test("非 Windows 或剪贴板读取失败时安全返回空列表", () => {
  assert.deepEqual(readClipboardFilePaths({ platform: "linux" }), []);
  assert.deepEqual(readClipboardFilePaths({
    platform: "win32",
    execFileSyncImpl: () => { throw new Error("clipboard busy"); },
  }), []);
});

test("剪贴板文件路径接口仅允许 Gateway 本机页面读取", async () => {
  let readCount = 0;
  const app = express();
  app.use(createClipboardRouter({
    readClipboardPaths: () => {
      readCount += 1;
      return ["D:\\资料\\问题截图.png"];
    },
  }));
  const server = http.createServer(app);

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/files`;
    const local = await fetch(url);
    assert.equal(local.status, 200);
    assert.deepEqual((await local.json()).data, ["D:\\资料\\问题截图.png"]);
    assert.equal(readCount, 1);

    const remote = await fetch(url, { headers: { "X-Forwarded-For": "10.10.10.8" } });
    assert.equal(remote.status, 403);
    assert.equal((await remote.json()).code, "CLIPBOARD_LOCAL_ONLY");
    assert.equal(readCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
