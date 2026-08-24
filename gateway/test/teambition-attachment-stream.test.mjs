// downloadAttachmentWithProgress 单测
// 参考 teambition-attachment-buffer.test.mjs 的 withServer 模式。
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadAttachmentWithProgress } from "../services/teambition.js";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("downloadAttachmentWithProgress: 完整下载并触发至少一次进度回调", async () => {
  const TOTAL = 1024 * 1024; // 1 MB
  await withServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(TOTAL),
    });
    // 一次性写完，避免 setImmediate 与客户端 reader.read() 之间的 race
    const buf = Buffer.alloc(TOTAL, 0x42);
    res.end(buf);
  }, async (baseUrl) => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-stream-"));
    const destPath = join(tmp, "file.bin");
    const events = [];
    const r = await downloadAttachmentWithProgress(`${baseUrl}/file.bin`, destPath, {
      onProgress: (e) => events.push({ received: e.received, total: e.total }),
    });
    assert.equal(r.received, TOTAL, "最终 received 等于文件大小");
    assert.equal(r.total, TOTAL, "content-length 解析为 total");
    assert.ok(events.length >= 1, `应至少触发一次 onProgress（实际 ${events.length} 次）`);
    // 末次回调的 received 应等于最终 received（throttle 会在循环结束后再 emit 一次最终值）
    const last = events[events.length - 1];
    assert.equal(last.received, r.received, `末次回调 received=${last.received} 应等于 r.received=${r.received}`);
    assert.equal(last.total, TOTAL, "末次回调的 total 等于文件大小");
    const onDisk = readFileSync(destPath);
    assert.equal(onDisk.length, TOTAL, "磁盘文件大小等于 TOTAL");
  });
});

test("downloadAttachmentWithProgress: signal.abort 抛 ABORTED 且保留部分文件", async () => {
  const TOTAL = 4 * 1024 * 1024; // 4 MB，慢速分块
  await withServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(TOTAL),
    });
    let sent = 0;
    const tick = () => {
      if (sent >= TOTAL || res.destroyed) { if (!res.destroyed) res.end(); return; }
      const chunk = Buffer.alloc(64 * 1024, 0x33);
      sent += chunk.length;
      res.write(chunk);
      setTimeout(tick, 5);
    };
    setTimeout(tick, 5);
  }, async (baseUrl) => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-stream-abort-"));
    const destPath = join(tmp, "partial.bin");
    const controller = new AbortController();
    const events = [];
    const p = downloadAttachmentWithProgress(`${baseUrl}/file.bin`, destPath, {
      signal: controller.signal,
      onProgress: (e) => events.push(e.received),
    });
    // 等收一些字节再 abort（首个 onProgress 触发后）
    setTimeout(() => controller.abort("用户"), 100);
    await assert.rejects(p, (err) => {
      assert.equal(err.code, "ABORTED", `err.code === "ABORTED" (got ${err.code})`);
      assert.ok(typeof err.received === "number" && err.received > 0, "err.received 应大于 0");
      return true;
    });
    assert.ok(events.length >= 1, "abort 前应至少触发一次 onProgress");
    // 保留部分文件
    const stat = statSync(destPath);
    assert.ok(stat.size > 0, `磁盘应保留部分文件（实际 ${stat.size} 字节）`);
  });
});

test("downloadAttachmentWithProgress: 无 content-length 时 total === 0", async () => {
  // chunked transfer encoding（无 content-length）
  const TOTAL = 256 * 1024;
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" }); // 无 content-length
    let sent = 0;
    const tick = () => {
      if (sent >= TOTAL) { res.end(); return; }
      const chunk = Buffer.alloc(64 * 1024, 0x11);
      sent += chunk.length;
      res.write(chunk);
      setImmediate(tick);
    };
    setImmediate(tick);
  }, async (baseUrl) => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-stream-nolen-"));
    const destPath = join(tmp, "x.bin");
    const events = [];
    const r = await downloadAttachmentWithProgress(`${baseUrl}/x`, destPath, {
      onProgress: (e) => events.push({ received: e.received, total: e.total }),
    });
    assert.equal(r.total, 0, "无 content-length 时 total === 0（前端按 indeterminate 处理）");
    assert.equal(r.received, TOTAL);
    assert.ok(events.length >= 1);
    for (const ev of events) assert.equal(ev.total, 0);
  });
});

test("downloadAttachmentWithProgress: HTTP 非 2xx 抛错不写文件（或写部分文件被破坏）", async () => {
  await withServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }, async (baseUrl) => {
    const tmp = mkdtempSync(join(tmpdir(), "tb-stream-404-"));
    const destPath = join(tmp, "x.bin");
    await assert.rejects(
      downloadAttachmentWithProgress(`${baseUrl}/x`, destPath, {}),
      (err) => /下载失败/.test(String(err.message)),
    );
  });
});