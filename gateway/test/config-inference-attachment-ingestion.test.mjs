import assert from "node:assert/strict";
import test from "node:test";
import { ingestConfigInferenceAttachments } from "../services/devbench/machine-learn/attachment-ingestion.js";

test("文本附件生成带 hash 和 untrusted 标记的结构化证据", async () => {
  const result = await ingestConfigInferenceAttachments([
    { id: "log-1", name: "crash.log", size: 20, url: "https://example/log" },
  ], {
    readBuffer: async () => ({
      buffer: Buffer.from("FATAL EXCEPTION\ncom.example.app.MainActivity", "utf8"),
      contentType: "text/plain",
    }),
  });
  assert.equal(result.sourceCoverage.complete, true);
  assert.equal(result.sourceCoverage.parsedCount, 1);
  assert.equal(result.evidence[0].status, "parsed");
  assert.equal(result.evidence[0].untrusted, true);
  assert.match(result.evidence[0].text, /MainActivity/);
  assert.match(result.evidence[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result.evidence[0], "url"), false);
});

test("图片没有 OCR provider 时明确标记不完整，不能伪装成已读取", async () => {
  const result = await ingestConfigInferenceAttachments([
    { name: "screen.png", url: "https://example/image" },
  ], {
    readBuffer: async () => ({ buffer: Buffer.from([1, 2, 3]), contentType: "image/png" }),
  });
  assert.equal(result.sourceCoverage.complete, false);
  assert.equal(result.evidence[0].status, "needs_vision");
  assert.match(result.evidence[0].error, /OCR/);
});

test("大小、下载失败、压缩包和无 URL 均保留可审计状态", async () => {
  const result = await ingestConfigInferenceAttachments([
    { name: "huge.log", size: 30, url: "https://example/huge" },
    { name: "failed.txt", size: 1, url: "https://example/fail" },
    { name: "trace.zip", size: 2, url: "https://example/zip" },
    { name: "missing.log" },
  ], {
    maxBytesPerAttachment: 20,
    readBuffer: async (url) => {
      if (url.endsWith("/fail")) throw new Error("network down");
      return { buffer: Buffer.from("zip"), contentType: "application/zip" };
    },
  });
  assert.deepEqual(
    result.evidence.map((row) => row.status),
    ["skipped", "failed", "needs_archive_review", "unavailable"],
  );
  assert.equal(result.sourceCoverage.complete, false);
  assert.equal(result.sourceCoverage.incompleteCount, 4);
});

test("不信任读取器返回长度且不把含 token/本机路径的底层错误回传 UI", async () => {
  const oversized = await ingestConfigInferenceAttachments([
    { id: "a1", name: "small.log", size: 1, url: "https://example.test/a" },
  ], {
    maxBytesPerAttachment: 16,
    maxTotalBytes: 16,
    readBuffer: async () => Buffer.alloc(2048, "x"),
  });
  assert.equal(oversized.evidence[0].status, "skipped");
  assert.equal(oversized.sourceCoverage.totalBytes, 0);

  const failed = await ingestConfigInferenceAttachments([
    { id: "a2", name: "failed.log", url: "https://example.test/b" },
  ], {
    readBuffer: async () => {
      throw new Error("access_token=secret at C:\\Users\\admin\\private");
    },
  });
  assert.equal(failed.evidence[0].error, "附件读取失败");
  assert.doesNotMatch(failed.evidence[0].error, /secret|Users/);
});

test("内联 OCR/摘要直接进入证据且不会调用下载器", async () => {
  let downloads = 0;
  const result = await ingestConfigInferenceAttachments([
    { name: "screen.png", ocrText: "车型 8678 应用市场" },
  ], {
    readBuffer: async () => {
      downloads++;
      return { buffer: Buffer.alloc(0) };
    },
  });
  assert.equal(downloads, 0);
  assert.equal(result.evidence[0].parser, "inline");
  assert.match(result.evidence[0].text, /8678/);
});
