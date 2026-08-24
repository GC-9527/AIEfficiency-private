import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  createSafeAttachmentReader,
  createSupplementedTeambitionProvider,
} from "../packages/tb-provider-teambition/src/index.js";
import { richSnapshot } from "./helpers.mjs";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

async function bodyBuffer(result) {
  const chunks = [];
  for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("补充 Provider 仅补官方读缺口，并从持久快照移除 Cookie 与签名 URL", async () => {
  const snapshot = richSnapshot();
  snapshot.comments = { available: false, complete: false, source: "official-mcp", items: [], error: "403" };
  snapshot.attachments = { available: false, complete: false, source: "official-mcp", items: [], error: "403" };
  snapshot.note = { ok: false, error: "official gap" };
  const official = {
    async readTicket() { return structuredClone(snapshot); },
    getAttachmentSource() { return null; },
    async getWorkflow() { return { currentStatus: {} }; },
    async listComments() { return []; },
    async writeComment() {},
    async updateStatus() {},
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Cookie, "cookie-secret");
    if (url.pathname.endsWith("/activities")) {
      return jsonResponse({ result: [{
        _id: "comment-1",
        action: "comment",
        content: { comment: "补充评论", files: [{ _id: "comment-file", name: "comment.log", url: "https://file.example/c?signature=secret" }] },
      }] });
    }
    if (url.pathname.endsWith("/note")) {
      return jsonResponse({ result: {
        renderMode: "rtf",
        url: "https://file.example/note?signature=secret",
        attachments: { "/images/remark.png": "https://file.example/image?signature=secret" },
      } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const attachmentReader = async ({ url }) => {
    if (url.includes("/note")) {
      return { body: [Buffer.from(JSON.stringify(["doc", {}, ["p", {}, "备注正文"], ["img", { name: "remark.png", src: "/images/remark.png" }]]))] };
    }
    return { body: [Buffer.from(url.includes("/image") ? "image-bytes" : "comment-bytes")] };
  };
  const provider = createSupplementedTeambitionProvider({
    official,
    cookie: "cookie-secret",
    fetchImpl,
    attachmentReader,
  });
  const result = await provider.readTicket("CARB-15125");

  assert.equal(result.comments.complete, true);
  assert.equal(result.comments.source, "official-mcp+cookie-gap-fallback");
  assert.equal(result.note.ok, true);
  assert.deepEqual(result.attachments.items.map((item) => item.attachmentId).sort(), ["comment-file", "remark-1"]);
  assert.equal(result.attachments.complete, true);
  assert.doesNotMatch(JSON.stringify(result), /cookie-secret|signature=secret|file\.example/i);
  assert.equal((await bodyBuffer(await provider.openAttachment("comment-file"))).toString(), "comment-bytes");
  assert.equal((await bodyBuffer(await provider.openAttachment("remark-1"))).toString(), "image-bytes");
  assert.equal((await provider.listComments("CARB-15125")).length, 1);
});

test("安全附件读取阻断私网 SSRF，并在测试隔离开关下验证真实字节上限", async () => {
  const reader = createSafeAttachmentReader();
  await assert.rejects(
    () => reader({ url: "https://127.0.0.1/private" }),
    (error) => error.code === "ATTACHMENT_SSRF_BLOCKED",
  );

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end("123456");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const localReader = createSafeAttachmentReader({ allowPrivateHostsForTests: true, maxBytes: 5 });
    const address = server.address();
    const response = await localReader({ url: `http://127.0.0.1:${address.port}/fixture` });
    await assert.rejects(() => bodyBuffer(response), (error) => error.code === "ATTACHMENT_TOO_LARGE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("签名 URL 过期后只刷新一次工单来源并重试同一附件", async () => {
  let reads = 0;
  let sourceUrl = "https://file.example/old";
  const snapshot = richSnapshot({ attachmentCount: 1 });
  const official = {
    async readTicket() { reads += 1; sourceUrl = reads > 1 ? "https://file.example/new" : sourceUrl; return structuredClone(snapshot); },
    getAttachmentSource() { return { url: sourceUrl, taskRef: "CARB-15125" }; },
    async getWorkflow() { return {}; }, async listComments() { return []; }, async writeComment() {}, async updateStatus() {},
  };
  const attempts = [];
  const provider = createSupplementedTeambitionProvider({
    official,
    attachmentReader: async ({ url }) => {
      attempts.push(url);
      if (url.endsWith("/old")) throw Object.assign(new Error("expired"), { code: "ATTACHMENT_URL_EXPIRED" });
      return { body: [Buffer.from("fresh")] };
    },
  });
  await provider.readTicket("CARB-15125");
  assert.equal((await bodyBuffer(await provider.openAttachment("attachment-1"))).toString(), "fresh");
  assert.deepEqual(attempts, ["https://file.example/old", "https://file.example/new"]);
  assert.equal(reads, 2);
});

test("Cookie activity 内容畸形时失败关闭，不把坏数据解释为空评论或空附件", async () => {
  const snapshot = richSnapshot();
  snapshot.comments = { available: false, complete: false, source: "official-mcp", items: [], error: "official unavailable" };
  snapshot.attachments = { available: false, complete: false, source: "official-mcp", items: [], error: "official unavailable" };
  const provider = createSupplementedTeambitionProvider({
    official: {
      async readTicket() { return structuredClone(snapshot); },
      getAttachmentSource() { return null; },
      async getWorkflow() { return {}; }, async writeComment() {}, async updateStatus() {},
    },
    cookie: "fixture-cookie",
    fetchImpl: async (url) => url.pathname.endsWith("/activities")
      ? jsonResponse({ result: [{ _id: "bad", action: "comment", content: "{" }] })
      : jsonResponse({ result: { markdown: "备注" } }),
    attachmentReader: async () => ({ body: [] }),
  });
  const result = await provider.readTicket("CARB-15125");
  assert.equal(result.comments.complete, false);
  assert.equal(result.attachments.complete, false);
  assert.match(`${result.comments.error} ${result.attachments.error}`, /invalid JSON/i);
});
