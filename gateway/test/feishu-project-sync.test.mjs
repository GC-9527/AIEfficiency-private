import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fpsync-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({}));

let svc, db, cfg;

before(async () => {
  cfg = await import("../services/config.js");
  db = await import("../db/sqlite.js");
  svc = await import("../services/feishu-project-sync.js");
  cfg.updateConfig({
    feishuProjectSync: {
      enabled: true,
      feishu: { spaceKey: "intelligentspace", workItemTypeKey: "bug" },
      teambition: {
        projectId: "tb-project",
        tasklistId: "tb-list",
        stageId: "tb-stage",
        sprintId: "tb-sprint",
        sprintName: "Default Sprint",
        taskflowstatusId: "tb-default-status",
        defaultExecutorId: "tb-default-user",
        tagIds: ["tb-avatr-tag"],
      },
      mappings: {
        people: {
          uk1: "tb-dev",
          "reporter@example.com": "tb-qa",
        },
        priority: { P0: 1 },
        status: { Open: "tb-open-status" },
        fields: {
          component: { customFieldId: "cf-component" },
        },
      },
      sync: { includeComments: true, includeAttachments: true, requiredAssigneeKeywords: [], readScope: { enabled: false, filters: [] } },
    },
  });
});

function sampleWorkItem(id, title = "Crash on launch") {
  return {
    work_item_id: id,
    space_key: "intelligentspace",
    work_item_type_key: "bug",
    updated_at: "2026-07-03T01:00:00.000Z",
    fields: [
      { field_key: "title", field_name: "Title", value: title },
      { field_key: "description", field_name: "Description", value: "Steps to reproduce" },
      { field_key: "status", field_name: "Status", value: "Open" },
      { field_key: "priority", field_name: "Priority", value: "P0" },
      { field_key: "component", field_name: "Component", value: "Media" },
      { field_key: "assignee", field_name: "Assignee", value: [{ user_key: "uk1", name: "Dev" }] },
      { field_key: "reporter", field_name: "Reporter", value: { email: "reporter@example.com", name: "QA" } },
    ],
    comments: [
      { comment_id: "fc1", author: { name: "QA" }, content: "see logs", created_at: "2026-07-03T00:00:00.000Z" },
    ],
    attachments: [
      { file_id: "fa1", file_name: "log.txt", url: "https://files.example/log.txt", size: 123 },
    ],
  };
}

const NSCP_17320_DEFECT_DESCRIPTION = String.raw`[台架编号/车辆Vin号]：192.168.137.177:7777_A-SH-5CD320L8GC
 [前提条件]：
 [操作步骤]：检测到dropbox异常文件: C:\Users\wei.wang13\PycharmProjects\mtbf_mt8678\result\20260701_215453\dropbox\system_app_native_crash@1782926881783.txt
 test_U盘内容播放中插拔U盘[287-500]
 ====== TEST ======
 1. 进入U盘音乐  [passed]
 2. 拔出U盘  [passed]
 3. 插入U盘  [passed]

 [实际结果]：【NATIVE CRASH】binder  >>> com.minical.car.media <<< : signal 6 (SIGABRT), code -1 (SI_QUEUE) Abort-Message: 'JNI FatalError called: java.lang.Error thrown during binder transaction: java.lang.OutOfMemoryError: Failed to allocate a 64 byte allocation with 4032 free bytes and 4032B until OOM, target footprint 268435456, growth limit 268435456; giving up on allocation because <1% of heap free after GC.'
 [期待结果]：无异常
 [复归条件]：
 [发生时间]：2026-07-02 01:27:59.934737
 [发生频率]：
 [PRD参照]:
 [版本号]:以下(选填)版本号根据Bug模块，填写相关版本号，不相关可删除
 1.MCU版本: T10PB8A20260626205234
 2.MPU版本: SWA.14.10_userdebug_20260629_020000
 3.IVI版本(鸿蒙）:
 4.语音版本(选填)：
 5.地图版本(选填)：
 6.APK版本(选填)：
 7.仪表屏版本(选填)：
 8.其他信息(选填)：`;

function jsonResponse(body, status = 200, headers = {}) {
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("Feishu web login status polling does not navigate active QR login pages", async () => {
  const { shouldNavigateForFeishuStatus } = await import("../../features/FeiShuProjects/src/feishu-web-session.js");
  assert.equal(shouldNavigateForFeishuStatus("about:blank"), true);
  assert.equal(shouldNavigateForFeishuStatus("https://example.com/login"), true);
  assert.equal(shouldNavigateForFeishuStatus("https://accounts.feishu.cn/accounts/page/login?redirect_uri=https%3A%2F%2Fproject.feishu.cn"), false);
  assert.equal(shouldNavigateForFeishuStatus("https://passport.feishu.cn/suite/passport/oauth"), false);
  assert.equal(shouldNavigateForFeishuStatus("https://project.feishu.cn/intelligentspace/bug/homepage"), false);
});

test("default Feishu sync attachment mode uploads files to Teambition", () => {
  assert.equal(svc.getFeishuProjectSyncConfig().sync.attachmentMode, "upload");
});

test("default Feishu problem owner filter includes Feng Guoliang", () => {
  const expected = ["阳荣峰", "徐博超", "彭俊维", "冯国梁"];
  assert.deepEqual(svc.DEFAULT_FEISHU_OWNER_ROLE_FILTER_VALUES, expected);
  assert.deepEqual(svc.DEFAULT_FEISHU_PROJECT_SYNC_CONFIG.sync.requiredAssigneeKeywords, expected);
  assert.deepEqual(svc.DEFAULT_FEISHU_PROJECT_SYNC_CONFIG.sync.readScope.filters[0].values, expected);
});

test("Teambition large attachment PUT streams the request body with a fixed content length", async () => {
  const { createServer } = await import("node:http");
  const { Readable } = await import("node:stream");
  const { putTeambitionUploadStream } = await import("../services/teambition.js");
  let receivedBytes = 0;
  let receivedLength = 0;
  const server = createServer((req, res) => {
    receivedLength = Number(req.headers["content-length"] || 0);
    req.on("data", (chunk) => { receivedBytes += chunk.length; });
    req.on("end", () => {
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const chunks = [Buffer.alloc(128 * 1024, 1), Buffer.alloc(256 * 1024, 2)];
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const address = server.address();
    const result = await putTeambitionUploadStream(
      `http://127.0.0.1:${address.port}/upload`,
      { "Content-Length": String(size), "Content-Type": "application/octet-stream" },
      Readable.from(chunks),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(receivedLength, size);
    assert.equal(receivedBytes, size);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Teambition streaming PUT rejects when the response socket closes before completion", async () => {
  const { createServer } = await import("node:http");
  const { Readable } = await import("node:stream");
  const { putTeambitionUploadStream } = await import("../services/teambition.js");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Length": "32", "Content-Type": "text/plain" });
      res.flushHeaders();
      res.write("partial");
      setTimeout(() => res.destroy(), 10);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const upload = putTeambitionUploadStream(
      `http://127.0.0.1:${address.port}/upload`,
      { "Content-Length": "3", "Content-Type": "application/octet-stream" },
      Readable.from([Buffer.from("abc")]),
    );
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("stream rejection test timed out")), 1500));
    await assert.rejects(Promise.race([upload, timeout]), /aborted|closed|socket hang up/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("default attachment upload does not include Feishu source metadata comment", async () => {
  const origFetch = globalThis.fetch;
  const current = cfg.getConfig();
  const activityBodies = [];
  let requestedUploadSize = 0;
  let ossUploadSize = 0;
  let ossBodyWasStream = false;
  cfg.updateConfig({
    teambition: {
      ...(current.teambition || {}),
      appId: "tb-upload-app",
      appSecret: "tb-upload-secret",
      orgId: "tb-upload-org",
      userCookie: "TEAMBITION_SESSIONID=upload-direct",
    },
    feishuProjectSync: {
      ...(current.feishuProjectSync || {}),
      sync: {
        ...(current.feishuProjectSync?.sync || {}),
        includeComments: false,
        includeAttachments: true,
        attachmentMode: "upload",
        ensureStartDate: false,
        verifyWrittenTargetFields: false,
      },
    },
  });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (u.host === "open.teambition.com" && u.pathname === "/api/appToken") {
      return jsonResponse({ appToken: "tb-upload-token", expire: 1 });
    }
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/task/create") {
      return jsonResponse({ result: { id: "tb-upload-direct", uniqueId: 15889 } });
    }
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/task/tb-upload-direct/customfield/update") {
      return jsonResponse({ result: { updated: "2026-07-20T12:00:00.000Z" } });
    }
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/task/tb-upload-direct/tag") {
      return jsonResponse({ result: { tagIds: body?.tagIds || [] } });
    }
    if (u.host === "files.example" && u.pathname === "/log.txt") {
      const bytes = Buffer.from("uploaded-log");
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => String(name).toLowerCase() === "content-type" ? "text/plain" : null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    if (u.host === "www.teambition.com" && u.pathname === "/api/awos/upload-token") {
      requestedUploadSize = Number(body?.fileSize || 0);
      return jsonResponse({
        sdk: {
          endpoint: "oss.example.com",
          region: "test-region",
          credentials: { accessKeyId: "ak", secretAccessKey: "sk", sessionToken: "st" },
        },
        upload: {
          Bucket: "tb-bucket",
          Key: "task/upload/log.txt",
          ContentDisposition: "attachment; filename=\"log.txt\"",
          ContentType: "text/plain",
        },
        token: "tb-upload-file-token",
      });
    }
    if (u.host === "tb-bucket.oss.example.com" && method === "PUT") {
      ossUploadSize = Number(init.headers?.["Content-Length"] || 0);
      ossBodyWasStream = typeof init.body?.pipe === "function";
      init.body?.destroy?.();
      return jsonResponse({}, 200);
    }
    if (u.host === "open.teambition.com" && u.pathname === "/api/v3/task/tb-upload-direct/comment") {
      activityBodies.push(body);
      return jsonResponse({ result: { id: "tb-upload-activity" } });
    }
    throw new Error(`unexpected fetch ${method} ${u.host}${u.pathname}`);
  };
  try {
    const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("attachment-upload-direct"));
    assert.equal(result.ok, true);
    assert.equal(result.action, "create");
    assert.equal(activityBodies.length, 1);
    assert.equal(activityBodies[0].content, "");
    assert.deepEqual(activityBodies[0].fileTokens, ["tb-upload-file-token"]);
    assert.equal(requestedUploadSize, 12);
    assert.equal(ossUploadSize, 12);
    assert.equal(ossBodyWasStream, true);
    assert.doesNotMatch(JSON.stringify(activityBodies[0]), /Feishu attachment uploaded|Source attachment ID|Source comment ID|Work item URL|Size:/);
  } finally {
    globalThis.fetch = origFetch;
    cfg.updateConfig({
      teambition: current.teambition || {},
      feishuProjectSync: current.feishuProjectSync || {},
    });
  }
});

test("attachment downloader retries Feishu HTTP 500 with a refreshed signed URL and streams to disk", async () => {
  const origFetch = globalThis.fetch;
  const downloadRoot = path.join(tmp, "attachment-download-http-500");
  const calls = [];
  let refreshCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ host: parsed.host, dflag: parsed.searchParams.get("dflag"), headers: init.headers || {} });
    if (parsed.host === "project.feishu.cn" && parsed.pathname.endsWith("/stale")) {
      return new Response(JSON.stringify({ code: 1000051686, message: "file internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    if (parsed.host === "project.feishu.cn" && parsed.pathname.endsWith("/fresh")) {
      assert.equal(init.headers["X-Meego-File-Sign"], "fresh-sign");
      const body = Buffer.from("streamed-after-refresh");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": String(body.length) },
      });
    }
    throw new Error(`unexpected attachment fetch ${parsed.host}${parsed.pathname}`);
  };
  try {
    const result = await svc.downloadFeishuAttachmentToTempFile({
      id: "retry-http-500",
      fileName: "retry.txt",
      mimeType: "text/plain",
      url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/stale",
      sourceUrl: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/source-file",
      downloadHeaders: { "X-Meego-File-Sign": "stale-sign" },
      isMultipart: true,
    }, {
      sourceWorkItemId: "attachment-retry-http-500",
      sourceProjectKey: "intelligentspace",
    }, {
      attempts: 2,
      retryBaseDelayMs: 0,
      downloadRoot,
      refreshDownload: async (attachment, sourceItem) => {
        assert.equal(sourceItem.sourceWorkItemId, "attachment-retry-http-500");
        refreshCalls += 1;
        return {
          ...attachment,
          url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/fresh",
          downloadHeaders: { "X-Meego-File-Sign": "fresh-sign" },
        };
      },
    });

    assert.equal(refreshCalls, 1);
    assert.equal(result.attempts, 2);
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "streamed-after-refresh");
    assert.equal(fs.existsSync(`${result.filePath}.part`), false);
    assert.deepEqual(calls.map((call) => call.dflag), ["t", "t"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("attachment downloader retries a terminated stream and removes the partial file", async () => {
  const origFetch = globalThis.fetch;
  const downloadRoot = path.join(tmp, "attachment-download-terminated");
  let fetchCalls = 0;
  let refreshCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/octet-stream", "content-length": "20" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(Buffer.from("partial")));
            controller.error(new TypeError("terminated"));
          },
        }),
      };
    }
    const body = Buffer.from("complete-after-retry");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream", "content-length": String(body.length) },
    });
  };
  try {
    const result = await svc.downloadFeishuAttachmentToTempFile({
      id: "retry-terminated",
      fileName: "terminated.bin",
      mimeType: "application/octet-stream",
      url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/first",
      sourceUrl: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/source-file",
      downloadHeaders: { "X-Meego-File-Sign": "first-sign" },
    }, {
      sourceWorkItemId: "attachment-retry-terminated",
      sourceProjectKey: "intelligentspace",
    }, {
      attempts: 2,
      retryBaseDelayMs: 0,
      downloadRoot,
      refreshDownload: async (attachment) => {
        refreshCalls += 1;
        return { ...attachment, url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/second" };
      },
    });

    assert.equal(fetchCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(result.attempts, 2);
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "complete-after-retry");
    assert.equal(fs.existsSync(`${result.filePath}.part`), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("attachment downloader assembles Feishu multipart downloads by replacing part_number", async () => {
  const origFetch = globalThis.fetch;
  const downloadRoot = path.join(tmp, "attachment-download-multipart");
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const partIndex = Number(parsed.pathname.split("/").at(-1));
    requests.push({ partIndex, dflag: parsed.searchParams.get("dflag"), sign: init.headers?.["X-Meego-File-Sign"] });
    const body = Buffer.from(partIndex === 0 ? "abcd" : "efgh");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/zip", "content-length": String(body.length) },
    });
  };
  try {
    const result = await svc.downloadFeishuAttachmentToTempFile({
      id: "multipart-download",
      fileName: "multipart.zip",
      mimeType: "application/zip",
      url: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/mcp/signed/:part_number",
      sourceUrl: "https://project.feishu.cn/goapi/v5/platform/file/stream/download/source-file",
      downloadHeaders: { "X-Meego-File-Sign": "multipart-sign" },
      isMultipart: true,
      multipart: {
        part_count: 2,
        part_size: 4,
        need: [
          { part_index: 0, start_byte: 0, end_byte: 3 },
          { part_index: 1, start_byte: 4, end_byte: 7 },
        ],
      },
    }, {
      sourceWorkItemId: "attachment-multipart",
      sourceProjectKey: "intelligentspace",
    }, {
      attempts: 1,
      downloadRoot,
    });

    assert.equal(result.attempts, 1);
    assert.equal(result.bytes, 8);
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "abcdefgh");
    assert.deepEqual(requests.map((request) => request.partIndex), [0, 1]);
    assert.ok(requests.every((request) => request.dflag === "t"));
    assert.ok(requests.every((request) => request.sign === "multipart-sign"));
    assert.equal(fs.existsSync(`${result.filePath}.part`), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("sync uploads inline attachments from empty Feishu comments", async () => {
  const raw = sampleWorkItem("empty-comment-inline-attachment", "Inline attachment only");
  raw.comments = [
    {
      comment_id: "fc-empty",
      author: { name: "QA" },
      content: "",
      created_at: "2026-07-03T00:00:00.000Z",
      files: [
        { file_id: "fa-inline", file_name: "inline.log", url: "https://files.example/inline.log", size: 321 },
      ],
    },
  ];
  raw.attachments = [];

  const item = svc.normalizeFeishuWorkItem(raw);
  assert.equal(item.comments[0].content || "", "");
  assert.equal(item.attachments.length, 1);
  assert.equal(item.attachments[0].id, "fa-inline");
  assert.equal(item.attachments[0].sourceCommentId, "fc-empty");

  const calls = [];
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: true,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      createTask: async (payload) => {
        calls.push({ type: "create", payload });
        return { id: "tb-inline-attachment", uniqueId: 15901 };
      },
      syncAttachment: async (taskId, attachment) => {
        calls.push({ type: "attachment", taskId, attachment });
        return { fileId: "tb-file-inline" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.type), ["create", "attachment"]);
  assert.equal(calls[1].taskId, "tb-inline-attachment");
  assert.equal(calls[1].attachment.id, "fa-inline");
  assert.equal(calls[1].attachment.sourceCommentId, "fc-empty");
});

test("sync uploads files from the Feishu work-item attachment field", async () => {
  const raw = sampleWorkItem("work-item-field-attachments", "Field attachment ticket");
  raw.attachments = [];
  raw.fields.push({
    field_key: "field_2cb6f7",
    field_name: "附件",
    value: [
      {
        uid: "field-attachment-1",
        fileToken: "field-token-1",
        name: "screen.png",
        size: "420354",
        type: "image/png",
        url: "https://project.feishu.cn/intelligentspace/file/field-attachment-1",
      },
      {
        uid: "field-attachment-2",
        fileToken: "field-token-2",
        name: "vehicle.log",
        size: "2048",
        type: "text/plain",
        isMultipart: true,
        url: "https://project.feishu.cn/intelligentspace/file/field-attachment-2",
      },
    ],
  });

  const item = svc.normalizeFeishuWorkItem(raw);
  assert.deepEqual(item.attachments.map((attachment) => attachment.id), ["field-attachment-1", "field-attachment-2"]);
  assert.deepEqual(item.attachments.map((attachment) => attachment.fileName), ["screen.png", "vehicle.log"]);
  assert.deepEqual(item.attachments.map((attachment) => attachment.fileSize), [420354, 2048]);
  assert.equal(item.attachments[1].isMultipart, true);

  const calls = [];
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: true,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      createTask: async () => {
        calls.push({ type: "create" });
        return { id: "tb-field-attachments", uniqueId: 15902 };
      },
      syncAttachment: async (taskId, attachment) => {
        calls.push({ type: "attachment", taskId, attachment });
        return { fileId: `tb-${attachment.id}` };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.type), ["create", "attachment", "attachment"]);
  assert.deepEqual(calls.slice(1).map((call) => call.attachment.id), ["field-attachment-1", "field-attachment-2"]);
  assert.ok(calls.slice(1).every((call) => call.taskId === "tb-field-attachments"));
});

test("Feishu source view URL drives source scope and search options", async () => {
  const sourceViewUrl = "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?scope=workspaces&node=28602134";
  const parsed = svc.parseFeishuProjectUrl(sourceViewUrl);
  assert.equal(parsed.sourceProjectKey, "intelligentspace");
  assert.equal(parsed.sourceWorkItemTypeKey, "bug");
  assert.equal(parsed.viewId, "2OuLlBcDg");
  assert.equal(parsed.scope, "workspaces");
  assert.equal(parsed.node, "28602134");

  const cfgPatch = {
    feishu: {
      sourceView: { url: sourceViewUrl },
    },
    sync: {
      readScope: { enabled: false, filters: [] },
      sort: [{ fieldKey: "updated_at", fieldName: "更新时间", direction: "desc" }],
    },
    pocWorkItemIds: [],
  };
  const sourceView = svc.getFeishuSourceView(cfgPatch);
  assert.equal(sourceView.viewId, "2OuLlBcDg");
  assert.equal(sourceView.sourceProjectKey, "intelligentspace");
  assert.equal(sourceView.sourceWorkItemTypeKey, "bug");

  const fetchCalls = [];
  await svc.runFeishuProjectSync({
    config: cfgPatch,
    limit: 5,
    client: {
      fetchWorkItems: async (options) => {
        fetchCalls.push(options);
        return [];
      },
    },
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].extraBody.view_id, "2OuLlBcDg");
  assert.equal(fetchCalls[0].extraBody.view_scope, "workspaces");
  assert.equal(fetchCalls[0].extraBody.node, "28602134");
  assert.equal(fetchCalls[0].orderBy[0].field_key, "updated_at");
  assert.equal(fetchCalls[0].orderBy[0].direction, "desc");
});

test("normalize and build Teambition payload from Feishu fields", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("7019893398"));
  assert.equal(item.sourceWorkItemId, "7019893398");
  assert.equal(item.sourceWorkItemUrl, "https://project.feishu.cn/intelligentspace/bug/detail/7019893398");
  assert.equal(item.title, "Crash on launch");
  assert.equal(item.assignees[0].userKey, "uk1");

  const { payload } = svc.buildTeambitionTaskPayload(item);
  assert.equal(payload.projectId, "tb-project");
  assert.equal(payload.content, "【缺陷转载-8678】【阿维塔】7019893398Crash on launch");
  assert.equal(payload.stageId, "tb-stage");
  assert.equal(payload.tasklistId, "tb-list");
  assert.equal(payload.sprintId, "tb-sprint");
  assert.equal(payload.executorId, "tb-default-user");
  assert.deepEqual(payload.involveMembers.sort(), ["tb-dev", "tb-qa"]);
  assert.equal(payload.taskflowstatusId, "tb-open-status");
  assert.equal(payload.priority, 2);
  assert.deepEqual(payload.tagIds, ["tb-avatr-tag"]);
  assert.equal(payload.customfields[0].customfieldId, "cf-component");
  assert.equal(payload.note, "\u7f3a\u9677\u63cf\u8ff0:\nSteps to reproduce");
});

test("MCP current_status_operator is normalized as Feishu assignee", () => {
  const raw = sampleWorkItem("mcp-current-owner", "MCP current owner");
  raw.fields = raw.fields.filter((field) => field.field_key !== "assignee");
  raw.fields.push({
    field_key: "current_status_operator",
    field_name: "当前负责人",
    value: [{ user_key: "uk1", name: "Dev" }],
  });

  const item = svc.normalizeFeishuWorkItem(raw);
  const { payload } = svc.buildTeambitionTaskPayload(item);

  assert.equal(item.assignees.length, 1);
  assert.equal(item.assignees[0].userKey, "uk1");
  assert.ok(payload.involveMembers.includes("tb-dev"));
});

test("native Teambition priority is only sent when it is an integer", () => {
  const raw = sampleWorkItem("priority-unmapped");
  raw.fields = raw.fields.map((field) => (
    field.field_key === "priority" ? { ...field, value: "P9" } : field
  ));
  const item = svc.normalizeFeishuWorkItem(raw);

  const { payload } = svc.buildTeambitionTaskPayload(item, {
    mappings: { priority: { P9: "P9" } },
  });

  assert.equal(item.priority, "P9");
  assert.equal(payload.priority, undefined);
});

test("native Teambition priority coerces numeric mappings to integers", () => {
  const raw = sampleWorkItem("priority-numeric-string");
  raw.fields = raw.fields.map((field) => (
    field.field_key === "priority" ? { ...field, value: "P9" } : field
  ));
  const item = svc.normalizeFeishuWorkItem(raw);
  const { payload } = svc.buildTeambitionTaskPayload(item, {
    mappings: { priority: { P9: "2" } },
  });

  assert.equal(payload.priority, 2);
});

test("Teambition fixed category custom fields use configured defaults", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("fixed-category-fields"));
  const { payload, display } = svc.buildTeambitionTaskPayload(item, {
    teambition: {
      applicationCategoryCustomFieldId: "cf-app-category",
      defectCategoryCustomFieldId: "cf-defect-category",
    },
  });
  const byField = Object.fromEntries((payload.customfields || []).map((field) => [field.customfieldId, field.value]));
  assert.equal(display.applicationCategory, "App Market");
  assert.equal(display.defectCategory, "\u529f\u80fd\u4f7f\u7528BUG");
  assert.equal(byField["cf-app-category"], "App Market");
  assert.equal(byField["cf-defect-category"], "\u529f\u80fd\u4f7f\u7528BUG");
});

test("NSCP-18816 real create and update persist all six required TB fields", async () => {
  const raw = sampleWorkItem("nscp-18816-real-field-write", "NSCP-18816 audio issue");
  raw.fields.push(
    { field_key: "field_5a215d", field_name: "严重度", value: { value: "severity-b", label: "B" }, display_value: "B" },
    { field_key: "field_5d5056", field_name: "软件版本", value: [{ id: 7035506916, name: "15EU/16EU CC分支20260715" }], display_value: "15EU/16EU CC分支20260715" },
    { field_key: "field_be6bf1", field_name: "发生概率", value: { value: "always", label: "必现" }, display_value: "必现" },
  );
  const calls = [];
  const written = { tagIds: [], customfields: [] };
  const loader = {
    enforceWrittenFieldVerification: true,
    listProjectTags: async () => [
      { id: "tag-avatr", name: "【阿维塔】" },
      { id: "tag-app-market", name: "应用市场" },
    ],
    listTaskCustomFieldDefs: async () => [
      { id: "cf-app-category", name: "应用分类", choices: ["App Market"], choiceEntries: [{ id: "choice-app-market", name: "App Market" }] },
      { id: "cf-defect-category", name: "缺陷分类", choices: ["功能使用BUG"], choiceEntries: [{ id: "choice-functional-bug", name: "功能使用BUG" }] },
      { id: "cf-severity", name: "严重程度", choices: ["严重"], choiceEntries: [{ id: "choice-severe", name: "严重" }] },
      { id: "cf-version", name: "版本号", choices: [], choiceEntries: [] },
      { id: "cf-reproduction", name: "复现概率", choices: [], choiceEntries: [] },
    ],
    createTask: async (payload) => {
      calls.push({ type: "create", payload });
      return { id: "tb-nscp-18816", uniqueId: 18816 };
    },
    updateTask: async (taskId, payload) => {
      calls.push({ type: "update", taskId, payload });
      return { id: taskId, uniqueId: 18816 };
    },
    updateCustomFields: async (taskId, customfields, _cfg, writeOptions) => {
      calls.push({ type: "customfields", taskId, customfields, writeOptions });
      const byId = new Map(written.customfields.map((field) => [field.customfieldId, field]));
      for (const field of customfields) byId.set(field.customfieldId, field);
      written.customfields = [...byId.values()];
      return customfields.map((field) => ({ customfieldId: field.customfieldId, updated: true }));
    },
    updateTags: async (taskId, tagIds) => {
      calls.push({ type: "tags", taskId, tagIds });
      written.tagIds = [...tagIds];
      return { tagIds };
    },
    getTaskDetail: async () => ({
      _tagIds: written.tagIds,
      customfields: written.customfields,
    }),
    checkTaskExists: async (taskId) => ({
      exists: true,
      task: {
        _id: taskId,
        _projectId: "tb-project",
        _tasklistId: "tb-list",
        _sprintId: "tb-sprint",
        _executorId: "tb-default-user",
        _tagIds: [],
        customfields: [],
      },
    }),
  };
  const config = {
    teambition: {
      tagIds: [],
      tagNames: ["阿维塔"],
      applicationCategoryCustomFieldId: "",
      defectCategoryCustomFieldId: "",
      writeCustomFieldsAfterCreate: false,
    },
    mappings: {
      keywordRules: [{
        id: "app-market-tag",
        keywords: ["audio"],
        target: { tagNames: ["应用市场"] },
      }],
    },
    sync: {
      includeComments: false,
      includeAttachments: false,
      ensureStartDate: false,
      readScope: { enabled: false, filters: [] },
    },
  };

  const created = await svc.syncFeishuProjectWorkItem(raw, { config, loader, checkRemoteExisting: false });
  assert.equal(created.ok, true);
  assert.equal(created.action, "create");
  assert.deepEqual(calls.find((call) => call.type === "create").payload.tagIds.sort(), ["tag-app-market", "tag-avatr"]);
  const createdFields = Object.fromEntries(calls.find((call) => call.type === "customfields").customfields.map((field) => [field.customfieldId, field.value]));
  assert.deepEqual(createdFields["cf-app-category"], { id: "choice-app-market", title: "App Market" });
  assert.deepEqual(createdFields["cf-defect-category"], { id: "choice-functional-bug", title: "功能使用BUG" });
  assert.deepEqual(createdFields["cf-severity"], { id: "choice-severe", title: "严重" });
  assert.equal(createdFields["cf-version"], "15EU/16EU CC分支20260715");
  assert.equal(createdFields["cf-reproduction"], "必现");
  assert.equal(created.supplementalFieldWrites.customfields.count >= 5, true);
  assert.equal(calls.find((call) => call.type === "customfields").writeOptions.operatorId, "tb-default-user");
  assert.equal(created.supplementalFieldWrites.tags.count, 2);
  assert.equal(created.postWriteFieldVerification.mismatch, false);

  const updated = await svc.syncFeishuProjectWorkItem({
    ...raw,
    updated_at: "2026-07-20T13:00:00.000Z",
    fields: raw.fields.map((field) => field.field_key === "title" ? { ...field, value: "NSCP-18816 updated audio issue" } : field),
  }, { config, loader, checkRemoteExisting: false });
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "update");
  assert.deepEqual(calls.find((call) => call.type === "update").payload.tagIds.sort(), ["tag-app-market", "tag-avatr"]);
  assert.equal(calls.filter((call) => call.type === "customfields").length, 2);
  assert.equal(calls.filter((call) => call.type === "tags").length, 2);
  assert.equal(updated.supplementalFieldWrites.customfields.count >= 4, true);
  assert.equal(updated.postWriteFieldVerification.mismatch, false);
});

test("NSCP-18816 marks sync failed when TB accepts writes but readback is missing", async () => {
  const loader = {
    enforceWrittenFieldVerification: true,
    listProjectTags: async () => [{ id: "tag-avatr", name: "【阿维塔】" }],
    listTaskCustomFieldDefs: async () => [
      { id: "cf-app-category", name: "应用分类", choiceEntries: [{ id: "choice-app-market", name: "App Market" }] },
      { id: "cf-defect-category", name: "缺陷分类", choiceEntries: [{ id: "choice-functional-bug", name: "功能使用BUG" }] },
      { id: "cf-severity", name: "严重程度", choiceEntries: [] },
      { id: "cf-version", name: "版本号", choiceEntries: [] },
      { id: "cf-reproduction", name: "复现概率", choiceEntries: [] },
    ],
    createTask: async () => ({ id: "tb-nscp-18816-missing", uniqueId: 18817 }),
    updateTags: async () => ({ updated: true }),
    updateCustomFields: async () => [{ updated: true }],
    getTaskDetail: async () => ({ _tagIds: [], customfields: [] }),
  };
  const result = await svc.syncFeishuProjectWorkItem(
    sampleWorkItem("nscp-18816-missing-readback", "NSCP-18816 missing field readback"),
    {
      loader,
      checkRemoteExisting: false,
      postWriteVerifyAttempts: 1,
      postWriteVerifyDelayMs: 0,
      config: {
        teambition: { tagIds: [], tagNames: ["阿维塔"], applicationCategoryCustomFieldId: "", defectCategoryCustomFieldId: "" },
        sync: { includeComments: false, includeAttachments: false, ensureStartDate: false, readScope: { enabled: false, filters: [] } },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.includes("写后回读不一致"), true);
  assert.equal(result.failures[0].stage, "target-field-verify");
  assert.equal(result.failures[0].verification.mismatch, true);
});

test("Spotify function module writes S application category custom field", () => {
  const raw = sampleWorkItem("spotify-app-category", "Spotify category");
  raw.fields.push({ field_key: "field_95a8a4", field_name: "Function Module", value: { label: "Spotify" } });
  const item = svc.normalizeFeishuWorkItem(raw);
  const { payload, display } = svc.buildTeambitionTaskPayload(item, {
    teambition: {
      applicationCategoryCustomFieldId: "cf-app-category",
    },
  });
  const byField = Object.fromEntries((payload.customfields || []).map((field) => [field.customfieldId, field.value]));

  assert.equal(display.applicationCategory, "S");
  assert.equal(byField["cf-app-category"], "S");
});

test("default TB target tasklist and executor use Avatr App Market and Xu Bochao", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("default-tb-target", "NSCP-17542"));
  const { payload } = svc.buildTeambitionTaskPayload(item, {
    teambition: {
      projectId: "65a5f274950780b816cf905e",
      tasklistId: "",
      defaultExecutorId: "",
    },
  });

  assert.equal(payload.projectId, "65a5f274950780b816cf905e");
  assert.equal(payload.tasklistId, "69ddf5744b9a04cb08c4c2fa");
  assert.equal(payload.executorId, "61d3a0b5bd146ff52e3718bc");
  assert.ok(payload.involveMembers.includes("tb-dev"));
});

test("TB task title uses repost marker, Feishu ticket number, and problem summary", () => {
  const raw = sampleWorkItem("7038132837", "NSCP-17571");
  raw.fields.push({
    field_key: "field_80c785",
    field_name: "问题概要",
    value: "【Ecall】【5/5】E15-EU取消外置ecall短接后，电话音量没有恢复，音乐也没有恢复播放",
  });
  raw.fields.push({ field_key: "auto_number", field_name: "自增数字", value: 16045 });
  const item = svc.normalizeFeishuWorkItem(raw);
  assert.equal(svc.getSourceWorkItemNo(item), "NSCP-17571");
  assert.equal(svc.getSourceProblemSummary(item), "【Ecall】【5/5】E15-EU取消外置ecall短接后，电话音量没有恢复，音乐也没有恢复播放");

  const { payload } = svc.buildTeambitionTaskPayload(item);
  assert.equal(payload.content, "【缺陷转载-8678】【阿维塔】NSCP-17571【Ecall】【5/5】E15-EU取消外置ecall短接后，电话音量没有恢复，音乐也没有恢复播放");
});

test("Feishu defect description is the first section in Teambition note", () => {
  const raw = sampleWorkItem("defect-desc-1", "NSCP-20002");
  raw.fields = raw.fields.filter((field) => field.field_key !== "description");
  raw.fields.push({
    field_key: "field_ee70e6",
    field_name: "\u7f3a\u9677\u63cf\u8ff0",
    value: "[\u64cd\u4f5c\u6b65\u9aa4]\uff1a1. \u64ad\u653e\u5728\u7ebf\u97f3\u4e50\n[\u5b9e\u9645\u7ed3\u679c]\uff1a\u7535\u8bdd\u97f3\u91cf\u6ca1\u6709\u6062\u590d",
  });

  const item = svc.normalizeFeishuWorkItem(raw);
  const { payload } = svc.buildTeambitionTaskPayload(item);

  assert.equal(item.description, "[\u64cd\u4f5c\u6b65\u9aa4]\uff1a1. \u64ad\u653e\u5728\u7ebf\u97f3\u4e50\n[\u5b9e\u9645\u7ed3\u679c]\uff1a\u7535\u8bdd\u97f3\u91cf\u6ca1\u6709\u6062\u590d");
  assert.equal(payload.note, "\u7f3a\u9677\u63cf\u8ff0:\n[\u64cd\u4f5c\u6b65\u9aa4]\uff1a1. \u64ad\u653e\u5728\u7ebf\u97f3\u4e50\n[\u5b9e\u9645\u7ed3\u679c]\uff1a\u7535\u8bdd\u97f3\u91cf\u6ca1\u6709\u6062\u590d");
});

test("dry-run note summary prefers Feishu defect description rich text over generic description", async () => {
  const raw = sampleWorkItem("nscp-17320-note-readable", "NSCP-17320 note readable");
  raw.fields.push({
    field_key: "field_ee70e6",
    field_name: "\u7f3a\u9677\u63cf\u8ff0",
    value: {
      content: NSCP_17320_DEFECT_DESCRIPTION.split("\n").map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    },
  });

  const item = svc.normalizeFeishuWorkItem(raw);
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: { sync: { includeComments: false, includeAttachments: false, readScope: { enabled: false, filters: [] } } },
  });

  assert.equal(item.description, NSCP_17320_DEFECT_DESCRIPTION);
  assert.doesNotMatch(item.description, /^Steps to reproduce$/);
  assert.ok(result.payload.note.startsWith(`\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`));
  assert.match(result.payload.note, /com\.minical\.car\.media/);
  assert.match(result.payload.note, /SWA\.14\.10_userdebug_20260629_020000/);
  assert.doesNotMatch(result.payload.note, /Source ID|Source URL|Feishu comments|Feishu attachments|Raw Feishu JSON fallback/);
});

test("Feishu web detail parser keeps demand_fetch defect description field", async () => {
  const { normalizeFeishuWebDetailWorkItem } = await import("../../features/FeiShuProjects/src/feishu-web-session.js");
  const raw = {
    code: 0,
    data: {
      work_item_id: 7035552490,
      project_simple_name: "intelligentspace",
      work_item_api_name: "bug",
      value: [
        { uuid: "title", uiType: "text", uiValue: { text: { value: "NSCP-17320" } } },
        { uuid: "auto_number", uiType: "text", uiValue: { text: { value: "NSCP-17320" } } },
        {
          uuid: "field_ee70e6",
          uiType: "richText",
          uiValue: {
            richText: {
              content: NSCP_17320_DEFECT_DESCRIPTION.split("\n").map((text) => ({
                type: "paragraph",
                content: [{ type: "text", text }],
              })),
            },
          },
        },
      ],
    },
  };

  const webItem = normalizeFeishuWebDetailWorkItem(raw, {
    workItemId: "7035552490",
    spaceKey: "intelligentspace",
    workItemTypeKey: "bug",
  });
  const defectField = webItem.fields.find((field) => field.field_key === "field_ee70e6");
  const item = svc.normalizeFeishuWorkItem(webItem, {
    sync: { readScope: { enabled: false, filters: [] } },
  });

  assert.equal(webItem.work_item_id, "7035552490");
  assert.ok(defectField);
  assert.equal(item.description, NSCP_17320_DEFECT_DESCRIPTION);
  assert.equal(svc.getSourceProblemNo(item), "NSCP-17320");
});

test("dry-run note diff uses Teambition rich note as deleted previous value", async () => {
  const raw = sampleWorkItem("nscp-17320-rich-note-diff", "NSCP-17320 rich note diff");
  raw.fields = raw.fields.filter((field) => field.field_key !== "description");
  raw.fields.push({
    field_key: "field_ee70e6",
    field_name: "\u7f3a\u9677\u63cf\u8ff0",
    value: {
      content: NSCP_17320_DEFECT_DESCRIPTION.split("\n").map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
    },
  });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-rich-note-diff",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-rich-note-diff",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-rich-note",
    targetUniqueId: "CARB-17320",
    syncStatus: "success",
  });
  const oldTbNote = "原 TB 备注\n第二行说明";
  const calls = [];

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: { _id: taskId, taskId },
      }),
      getTaskNote: async (taskId) => {
        calls.push(["getTaskNote", taskId]);
        return {
          ok: true,
          renderMode: "rtf",
          markdown: oldTbNote,
          html: "<p>原 TB 备注</p><p>第二行说明</p>",
          images: [],
          links: [],
        };
      },
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.action, "update");
  assert.deepEqual(calls, [["getTaskNote", "tb-nscp-17320-rich-note"]]);
  const noteMismatch = result.targetFieldVerification.mismatches.find((item) => item.field === "note");
  assert.ok(noteMismatch);
  assert.equal(noteMismatch.actual, oldTbNote);
  assert.ok(noteMismatch.expected.startsWith(`\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`));
  assert.equal(result.targetFieldVerification.task.note, oldTbNote);
});

test("dry-run recovered remote TB task verifies note as deleted previous value", async () => {
  const raw = sampleWorkItem("nscp-17320-remote-note-diff", "NSCP-17320 remote note diff");
  raw.fields = raw.fields.filter((field) => field.field_key !== "description");
  raw.fields.push({
    field_key: "field_ee70e6",
    field_name: "\u7f3a\u9677\u63cf\u8ff0",
    value: NSCP_17320_DEFECT_DESCRIPTION,
  });
  const targetTaskId = "tb-nscp-17320-remote-note";
  const oldTbNote = "Source: Feishu Project\nSource ID: intelligentspace/bug/nscp-17320-remote-note-diff\n旧 TB 备注正文";
  const calls = [];

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: true,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      findTaskBySourceId: async (sourceId) => {
        calls.push(["findTaskBySourceId", sourceId]);
        return { _id: targetTaskId, uniqueId: "13107", content: "Remote recovered NSCP-17320" };
      },
      checkTaskExists: async (taskId) => {
        calls.push(["checkTaskExists", taskId]);
        return {
          exists: true,
          source: "test",
          task: {
            _id: taskId,
            taskId,
            uniqueId: "13107",
          },
        };
      },
      getTaskNote: async (taskId) => {
        calls.push(["getTaskNote", taskId]);
        return { ok: true, renderMode: "markdown", markdown: oldTbNote, html: "" };
      },
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.action, "update");
  assert.equal(result.existing.targetTaskId, targetTaskId);
  assert.equal(result.remoteExisting.targetTaskId, targetTaskId);
  assert.ok(calls.some(([type]) => type === "getTaskNote"));
  const noteMismatch = result.targetFieldVerification.mismatches.find((item) => item.field === "note");
  assert.ok(noteMismatch);
  assert.equal(noteMismatch.actual, oldTbNote);
  assert.ok(noteMismatch.expected.startsWith(`\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`));
  assert.equal(result.targetFieldVerification.task.note, oldTbNote);
});

test("dry-run exposes empty Teambition note read as note mismatch", async () => {
  const raw = sampleWorkItem("nscp-empty-tb-note", "NSCP empty TB note");
  raw.fields = raw.fields.filter((field) => field.field_key !== "description");
  raw.fields.push({
    field_key: "field_ee70e6",
    field_name: "\u7f3a\u9677\u63cf\u8ff0",
    value: "Feishu note should be written",
  });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-empty-tb-note",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-empty-tb-note",
    targetSystem: "teambition",
    targetTaskId: "tb-empty-note",
    targetUniqueId: "CARB-17321",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: { _id: taskId, taskId, content: raw.title },
      }),
      getTaskNote: async () => ({ ok: true, renderMode: "markdown", markdown: "", html: "", images: [], links: [] }),
    },
  });

  assert.equal(result.targetFieldVerification.noteRead.attempted, true);
  assert.equal(result.targetFieldVerification.noteRead.ok, true);
  assert.equal(result.targetFieldVerification.noteRead.empty, true);
  assert.equal(result.targetFieldVerification.noteRead.markdownLength, 0);
  const noteMismatch = result.targetFieldVerification.mismatches.find((item) => item.field === "note");
  assert.ok(noteMismatch);
  assert.equal(noteMismatch.actual, "");
  assert.match(noteMismatch.expected, /Feishu note should be written/);
});

test("dry-run exposes Teambition note read failure", async () => {
  const raw = sampleWorkItem("nscp-tb-note-read-failed", "NSCP TB note read failed");
  raw.fields = raw.fields.filter((field) => field.field_key !== "description");
  raw.fields.push({
    field_key: "field_ee70e6",
    field_name: "\u7f3a\u9677\u63cf\u8ff0",
    value: "Feishu note should be compared",
  });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-tb-note-read-failed",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-tb-note-read-failed",
    targetSystem: "teambition",
    targetTaskId: "tb-note-read-failed",
    targetUniqueId: "CARB-17322",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: { _id: taskId, taskId, content: raw.title },
      }),
      getTaskNote: async () => { throw new Error("TB note endpoint unavailable"); },
    },
  });

  assert.equal(result.targetFieldVerification.noteRead.attempted, true);
  assert.equal(result.targetFieldVerification.noteRead.ok, false);
  assert.equal(result.targetFieldVerification.noteRead.reason, "read-failed");
  assert.match(result.targetFieldVerification.noteRead.error, /TB note endpoint unavailable/);
});

test("legacy repost title template is upgraded to Avatr repost prefix", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("legacy-title", "Legacy template"));
  const { payload, display } = svc.buildTeambitionTaskPayload(item, {
    teambition: {
      titleTemplate: "【转载】【{sourceWorkItemNo}】{title}",
    },
  });
  assert.equal(payload.content, "【缺陷转载-8678】【阿维塔】legacy-titleLegacy template");
});

test("keyword rules override Teambition routing and custom fields", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("kw-1", "Login crash after upgrade"));
  const { payload, customfields } = svc.buildTeambitionTaskPayload(item, {
    mappings: {
      keywordRules: [
        {
          id: "login-crash",
          name: "Login crash route",
          keywords: ["login", "crash"],
          match: "all",
          scope: "all",
          target: {
            projectId: "tb-keyword-project",
            tasklistId: "tb-keyword-list",
            stageId: "tb-keyword-stage",
            sprintId: "tb-keyword-sprint",
            sprintName: "Keyword Sprint",
            taskflowstatusId: "tb-keyword-status",
            executorId: "tb-keyword-owner",
            involveMembers: ["tb-keyword-reviewer"],
            priority: 0,
            tagIds: ["tb-keyword-tag"],
            customFields: {
              "cf-component": "Auth",
              "cf-keyword-hit": "login-crash",
            },
          },
        },
      ],
    },
  });
  assert.equal(payload.projectId, "tb-keyword-project");
  assert.equal(payload.tasklistId, "tb-keyword-list");
  assert.equal(payload.stageId, "tb-keyword-stage");
  assert.equal(payload.sprintId, "tb-keyword-sprint");
  assert.equal(payload.taskflowstatusId, "tb-keyword-status");
  assert.equal(payload.executorId, "tb-keyword-owner");
  assert.equal(payload.priority, 0);
  assert.ok(payload.involveMembers.includes("tb-dev"));
  assert.ok(payload.involveMembers.includes("tb-keyword-reviewer"));
  assert.deepEqual(payload.tagIds.sort(), ["tb-avatr-tag", "tb-keyword-tag"]);
  const byField = Object.fromEntries(customfields.map((f) => [f.customfieldId, f.value]));
  assert.equal(byField["cf-component"], "Auth");
  assert.equal(byField["cf-keyword-hit"], "login-crash");
  assert.equal(payload.note, "\u7f3a\u9677\u63cf\u8ff0:\nSteps to reproduce");
});

test("required assignee keyword mapping is always added as TB participant", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("required-participant-1"));
  const { payload } = svc.buildTeambitionTaskPayload(item, {
    mappings: {
      people: {
        "\u5f90\u535a\u8d85": "tb-xu-bochao",
      },
    },
    sync: {
      requiredAssigneeKeywords: ["\u5f90\u535a\u8d85"],
    },
  });

  assert.ok(payload.involveMembers.includes("tb-xu-bochao"));
});

test("explicit required TB participants survive keyword replaceInvolveMembers", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("required-participant-2", "Login crash after upgrade"));
  const { payload } = svc.buildTeambitionTaskPayload(item, {
    teambition: {
      requiredInvolveMembers: ["tb-xu-bochao"],
    },
    mappings: {
      keywordRules: [
        {
          id: "replace-members",
          keywords: ["login", "crash"],
          match: "all",
          target: {
            replaceInvolveMembers: true,
            involveMembers: ["tb-keyword-reviewer"],
          },
        },
      ],
    },
  });

  assert.deepEqual(payload.involveMembers.sort(), ["tb-keyword-reviewer", "tb-xu-bochao"]);
});

test("keyword rules can match Spotify only from Feishu function module field", () => {
  const raw = sampleWorkItem("spotify-1", "NSCP-20001");
  raw.fields.push({ field_key: "field_95a8a4", field_name: "功能模块", value: { label: "Spotify" } });
  raw.fields.push({ field_key: "field_80c785", field_name: "问题概要", value: "Spotify audio does not resume" });
  const item = svc.normalizeFeishuWorkItem(raw);

  const { payload } = svc.buildTeambitionTaskPayload(item, {
    mappings: {
      keywordRules: [
        {
          id: "module-spotify",
          name: "Spotify route",
          scope: "fields",
          fieldKeys: ["field_95a8a4"],
          keywords: ["Spotify"],
          target: {
            tasklistId: "tb-spotify-list",
            stageId: "tb-spotify-stage",
            executorId: "tb-luo-mengwei",
          },
        },
      ],
    },
  });

  assert.equal(payload.tasklistId, "tb-spotify-list");
  assert.equal(payload.stageId, "tb-spotify-stage");
  assert.equal(payload.executorId, "tb-luo-mengwei");
});

test("keyword rules do not match Spotify outside configured Feishu function module field", () => {
  const item = svc.normalizeFeishuWorkItem(sampleWorkItem("spotify-title-1", "Spotify appears in title only"));
  const { payload } = svc.buildTeambitionTaskPayload(item, {
    mappings: {
      keywordRules: [
        {
          id: "module-spotify",
          scope: "fields",
          fieldKeys: ["field_95a8a4"],
          keywords: ["Spotify"],
          target: { tasklistId: "tb-spotify-list", executorId: "tb-luo-mengwei" },
        },
      ],
    },
  });

  assert.equal(payload.tasklistId, "tb-list");
  assert.equal(payload.executorId, "tb-default-user");
});

test("built-in Spotify function module routes dry-run to AVATR S app tasklist and sprint", async () => {
  const raw = sampleWorkItem("nscp-17320-spotify-route", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "功能模块", value: { label: "sPoTiFy" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-spotify-route",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-spotify-route",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-spotify-route",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "cf-app-category",
        defectCategoryCustomFieldId: "cf-defect-category",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          _projectId: "65a5f274950780b816cf905e",
          _tasklistId: "69ddf5744b9a04cb08c4c2fa",
          _sprintId: "6a03e6784fa4b959a31309f7",
        },
      }),
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.action, "update");
  assert.equal(result.payload.projectId, "65a5f274950780b816cf905e");
  assert.equal(result.payload.projectIdDisplay, "平台组件 / 阿维塔_8678平台_S应用");
  assert.equal(result.payload.tasklistId, "695a01be8cebcce71bb08e59");
  assert.equal(result.payload.tasklistIdDisplay, "阿维塔_8678平台_S应用");
  assert.equal(result.payload.sprintId, "6a03e6784fa4b959a31309f7");
  assert.equal(result.payload.sprintIdDisplay, "Ava_应用市场_8678_待规划");
  assert.equal(result.payload.applicationCategory, "S");
  assert.equal(result.payload.applicationCategoryCustomFieldId, "cf-app-category");
  assert.equal(result.payload.defectCategory, "\u529f\u80fd\u4f7f\u7528BUG");
  assert.equal(result.payload.defectCategoryCustomFieldId, "cf-defect-category");
  const byField = Object.fromEntries((result.payload.customfields || []).map((field) => [field.customfieldId, field.value]));
  assert.equal(byField["cf-app-category"], "S");
  assert.equal(byField["cf-defect-category"], "\u529f\u80fd\u4f7f\u7528BUG");
  const mismatchFields = result.targetFieldVerification.mismatches.map((item) => item.field).sort();
  assert.deepEqual(mismatchFields, ["tasklistId"]);
});

test("NSCP-16324 dry-run preserves existing TB sprint and defect category as unchanged", async () => {
  const raw = sampleWorkItem("nscp-16324-preserve-user-fields", "NSCP-16324");
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-16324" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "功能模块", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-16324-preserve-user-fields",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-16324-preserve-user-fields",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-16324-preserve-user-fields",
    targetUniqueId: "CARB-16324",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        sprintId: "tb-planned-sprint",
        sprintName: "同步默认迭代",
        defectCategoryCustomFieldId: "cf-defect-category",
        defectCategoryValue: "功能使用BUG",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "16324",
          _projectId: svc.DEFAULT_TB_TARGET_PROJECT_ID,
          _tasklistId: svc.DEFAULT_TB_TARGET_TASKLIST_ID,
          _sprintId: "tb-user-sprint",
          sprint: { _id: "tb-user-sprint", name: "用户后设迭代" },
          customfields: [
            {
              _customfieldId: "cf-defect-category",
              value: { label: "用户后设缺陷分类", value: "defect-user-selected" },
            },
          ],
        },
      }),
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.payload.sprintId, "tb-user-sprint");
  assert.equal(result.payload.sprintIdDisplay, "用户后设迭代");
  assert.equal(result.payload.defectCategory, "用户后设缺陷分类");
  const defectField = result.payload.customfields.find((field) => field.customfieldId === "cf-defect-category");
  assert.equal(defectField.value, "用户后设缺陷分类");
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.sprintId.targetCurrent.display, "用户后设迭代");
  assert.equal(comparisons.sprintId.targetNext.display, "用户后设迭代");
  assert.equal(comparisons.sprintId.action, "same");
  assert.equal(comparisons.defectCategory.targetCurrent.display, "用户后设缺陷分类");
  assert.equal(comparisons.defectCategory.targetNext.display, "用户后设缺陷分类");
  assert.equal(comparisons.defectCategory.action, "same");
  assert.equal(result.targetFieldVerification.mismatches.some((item) => item.field === "sprintId"), false);
  assert.equal(result.targetFieldVerification.mismatches.some((item) => item.field === "defectCategory"), false);
});

test("NSCP-16324 update payload does not overwrite existing TB sprint and defect category", async () => {
  const raw = sampleWorkItem("nscp-16324-preserve-update-payload", "NSCP-16324");
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-16324" });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-16324-preserve-update-payload",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-16324-preserve-update-payload",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-16324-preserve-update-payload",
    targetUniqueId: "CARB-16324",
    syncStatus: "success",
  });
  let updatePayload = null;

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    checkRemoteExisting: false,
    config: {
      teambition: {
        sprintId: "tb-planned-sprint",
        defectCategoryCustomFieldId: "cf-defect-category",
        defectCategoryValue: "功能使用BUG",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        ensureStartDate: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "16324",
          _projectId: svc.DEFAULT_TB_TARGET_PROJECT_ID,
          _tasklistId: svc.DEFAULT_TB_TARGET_TASKLIST_ID,
          _sprintId: "tb-user-sprint",
          sprint: { _id: "tb-user-sprint", name: "用户后设迭代" },
          customfields: [
            {
              _customfieldId: "cf-defect-category",
              value: { label: "用户后设缺陷分类", value: "defect-user-selected" },
            },
          ],
        },
      }),
      updateTask: async (taskId, payload) => {
        updatePayload = payload;
        return { _id: taskId, uniqueId: "16324", updatedAt: "2026-07-18T12:00:00.000Z" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(updatePayload.sprintId, undefined);
  assert.equal((updatePayload.customfields || []).some((field) => field.customfieldId === "cf-defect-category"), false);
  assert.equal(result.payload.sprintId, "tb-user-sprint");
  assert.equal(result.payload.defectCategory, "用户后设缺陷分类");
});

test("dry-run exposes current TB category custom fields from detail aliases", async () => {
  const raw = sampleWorkItem("nscp-17320-defect-category-current", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "功能模块", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-defect-category-current",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-defect-category-current",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-defect-category-current",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "cf-app-category",
        defectCategoryCustomFieldId: "cf-defect-category",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          _projectId: svc.DEFAULT_TB_TARGET_PROJECT_ID,
          _tasklistId: svc.DEFAULT_TB_TARGET_TASKLIST_ID,
          _sprintId: svc.DEFAULT_TB_TARGET_SPRINT_ID,
          customFieldValues: [
            {
              _customfieldId: "cf-app-category",
              value: { label: "S", value: "S" },
            },
            {
              _customfieldId: "cf-defect-category",
              value: { label: "交互体验类（一般）", value: "defect-interaction-normal" },
            },
          ],
        },
      }),
    },
  });

  assert.equal(result.payload.applicationCategory, "S");
  assert.equal(result.payload.applicationCategoryCustomFieldId, "cf-app-category");
  assert.equal(result.payload.defectCategory, "交互体验类（一般）");
  assert.equal(result.payload.defectCategoryCustomFieldId, "cf-defect-category");
  const currentApplicationCategory = result.targetFieldVerification.task.customfields.find((field) => field._customfieldId === "cf-app-category");
  assert.equal(currentApplicationCategory.value.label, "S");
  const currentDefectCategory = result.targetFieldVerification.task.customfields.find((field) => field._customfieldId === "cf-defect-category");
  assert.equal(currentDefectCategory.value.label, "交互体验类（一般）");
  const customfieldsMismatch = (result.targetFieldVerification.mismatches || []).find((item) => item.field === "customfields");
  assert.ok(customfieldsMismatch);
  assert.match(customfieldsMismatch.actual, /交互体验类（一般）/);
  assert.match(customfieldsMismatch.expected, /交互体验类（一般）/);
  assert.doesNotMatch(customfieldsMismatch.expected, /功能使用BUG/);
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.applicationCategory.targetCurrent.display, "S");
  assert.equal(comparisons.applicationCategory.targetNext.display, "S");
  assert.equal(comparisons.applicationCategory.action, "same");
  assert.equal(comparisons.defectCategory.targetCurrent.display, "交互体验类（一般）");
  assert.equal(comparisons.defectCategory.targetNext.display, "交互体验类（一般）");
  assert.equal(comparisons.defectCategory.action, "same");
});

test("dry-run matches current TB application category by custom field name when id is unconfigured", async () => {
  const raw = sampleWorkItem("nscp-17320-app-category-current-by-name", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "\u7cfb\u7edf\u5355\u53f7", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "\u529f\u80fd\u6a21\u5757", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-app-category-current-by-name",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-app-category-current-by-name",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-app-category-current-by-name",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          customfields: [
            {
              customfield: { name: "\u5e94\u7528\u5206\u7c7b" },
              value: { label: "S", value: "S" },
            },
          ],
        },
      }),
    },
  });

  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(result.payload.applicationCategory, "S");
  assert.equal(comparisons.applicationCategory.targetCurrent.display, "S");
  assert.equal(comparisons.applicationCategory.targetNext.display, "S");
  assert.equal(comparisons.applicationCategory.action, "same");
});

test("dry-run resolves unconfigured category field id from project defs to show current TB value", async () => {
  // 真实场景：配置里应用分类字段 ID 为空，且 TB 单 customfields 条目只带 _customfieldId、不带字段名。
  // 走 loader.listTaskCustomFieldDefs 按字段名解析出 ID 后，应能读到当前 TB 应用分类 = S，动作判为“不变”。
  const raw = sampleWorkItem("nscp-17320-app-category-resolve-id", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "功能模块", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-app-category-resolve-id",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-app-category-resolve-id",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-app-category-resolve-id",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  let defsCalls = 0;
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "",
        defectCategoryCustomFieldId: "",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      listTaskCustomFieldDefs: async () => {
        defsCalls += 1;
        return [
          { id: "cf-app-category", name: "应用分类", choices: ["S", "App Market"] },
          { id: "cf-defect-category", name: "缺陷分类", choices: [] },
        ];
      },
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          // 条目只有 _customfieldId，没有字段名（贴近真实 TB Cookie 详情）
          customfields: [
            { _customfieldId: "cf-app-category", value: { label: "S", value: "S" } },
          ],
        },
      }),
    },
  });

  assert.equal(defsCalls >= 1, true);
  assert.equal(result.payload.applicationCategory, "S");
  assert.equal(result.payload.applicationCategoryCustomFieldId, "cf-app-category");
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.applicationCategory.targetCurrent.display, "S");
  assert.equal(comparisons.applicationCategory.targetNext.display, "S");
  assert.equal(comparisons.applicationCategory.action, "same");
});

test("dry-run resolves unconfigured defect category from scenario custom field id", async () => {
  const raw = sampleWorkItem("nscp-17320-defect-category-scenario-id", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "\u7cfb\u7edf\u5355\u53f7", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "\u529f\u80fd\u6a21\u5757", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-defect-category-scenario-id",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-defect-category-scenario-id",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-defect-category-scenario-id",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  let defsCalls = 0;
  const currentDefectCategory = "\u4ea4\u4e92\u4f53\u9a8c\u7c7b\uff08\u4e00\u822c\uff09";
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "",
        defectCategoryCustomFieldId: "",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      listTaskCustomFieldDefs: async () => {
        defsCalls += 1;
        return [
          { id: "cf-app-category", name: "\u5e94\u7528\u5206\u7c7b", choices: ["S", "App Market"] },
          { id: "cf-defect-category", name: "\u7f3a\u9677\u5206\u7c7b", choices: [] },
        ];
      },
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          scenarioFieldValues: [
            {
              scenarioField: { customField: { _id: "cf-app-category" } },
              value: { label: "S", value: "S" },
            },
            {
              scenarioField: { customField: { _id: "cf-defect-category" } },
              value: { label: currentDefectCategory, value: "defect-interaction-normal" },
            },
          ],
        },
      }),
    },
  });

  assert.equal(defsCalls >= 1, true);
  assert.equal(result.payload.defectCategory, currentDefectCategory);
  assert.equal(result.payload.defectCategoryCustomFieldId, "cf-defect-category");
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.applicationCategory.targetCurrent.display, "S");
  assert.equal(comparisons.applicationCategory.targetNext.display, "S");
  assert.equal(comparisons.applicationCategory.action, "same");
  assert.equal(comparisons.defectCategory.targetCurrent.display, currentDefectCategory);
  assert.equal(comparisons.defectCategory.targetNext.display, currentDefectCategory);
  assert.equal(comparisons.defectCategory.action, "same");
});

test("dry-run resolves current TB defect category from scenario field _customfieldId alias", async () => {
  const raw = sampleWorkItem("nscp-17320-defect-category-scenario-underscore-id", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "\u7cfb\u7edf\u5355\u53f7", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "\u529f\u80fd\u6a21\u5757", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-defect-category-scenario-underscore-id",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-defect-category-scenario-underscore-id",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-defect-category-scenario-underscore-id",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const currentDefectCategory = "\u4ea4\u4e92\u4f53\u9a8c\u7c7b\uff08\u4e00\u822c\uff09";
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "",
        defectCategoryCustomFieldId: "",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      listTaskCustomFieldDefs: async () => [
        { id: "cf-app-category", name: "\u5e94\u7528\u5206\u7c7b", choices: ["S", "App Market"] },
        { id: "cf-defect-category", name: "\u7f3a\u9677\u5206\u7c7b", choices: [] },
      ],
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          scenarioFieldValues: [
            {
              scenarioField: { _customfieldId: "cf-app-category" },
              value: { label: "S", value: "S" },
            },
            {
              scenarioField: { _customfieldId: "cf-defect-category" },
              value: { label: currentDefectCategory, value: "defect-interaction-normal" },
            },
          ],
        },
      }),
    },
  });

  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(result.payload.defectCategoryCustomFieldId, "cf-defect-category");
  assert.equal(comparisons.applicationCategory.targetCurrent.display, "S");
  assert.equal(comparisons.applicationCategory.action, "same");
  assert.equal(comparisons.defectCategory.targetCurrent.display, currentDefectCategory);
  assert.equal(comparisons.defectCategory.targetNext.display, currentDefectCategory);
  assert.equal(comparisons.defectCategory.action, "same");
});

test("dry-run matches current TB application category by cfId alias", async () => {
  const raw = sampleWorkItem("nscp-17320-app-category-current-cfid", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "\u7cfb\u7edf\u5355\u53f7", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "\u529f\u80fd\u6a21\u5757", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-app-category-current-cfid",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-app-category-current-cfid",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-app-category-current-cfid",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "cf-app-category",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          customfields: [
            {
              cfId: "cf-app-category",
              type: "dropDown",
              value: [{ id: "option-s", title: "S" }],
            },
          ],
        },
      }),
    },
  });

  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(result.payload.applicationCategory, "S");
  assert.equal(comparisons.applicationCategory.targetCurrent.display, "S");
  assert.equal(comparisons.applicationCategory.targetNext.display, "S");
  assert.equal(comparisons.applicationCategory.action, "same");
});

test("dry-run exposes current TB comments and marks existing comments without reposting", async () => {
  const raw = sampleWorkItem("nscp-17320-comments-readable", "NSCP-17320 comments");
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-comments-readable",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-comments-readable",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-comments-readable",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: true,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: { _id: taskId, uniqueId: "13036", content: raw.title },
      }),
      getTaskComments: async () => ([
        {
          id: "tb-comment-fc1",
          creator: { name: "TB QA" },
          createdAt: "2026-07-03T00:01:00.000Z",
          content: "Feishu comment from QA\nSource comment ID: fc1\n\nsee logs",
        },
      ]),
    },
  });

  assert.equal(result.childPlan.needsSync, false);
  assert.equal(result.childPlan.targetCommentRead.ok, true);
  assert.equal(result.childPlan.targetComments[0].id, "tb-comment-fc1");
  assert.match(result.childPlan.targetComments[0].content, /Source comment ID: fc1/);
  assert.equal(result.childPlan.comments[0].id, "fc1");
  assert.equal(result.childPlan.comments[0].status, "target-existing");
  assert.equal(result.childPlan.comments[0].targetCommentId, "tb-comment-fc1");
});

test("sync skips posting comments already present on TB target by Source comment ID", async () => {
  const raw = sampleWorkItem("nscp-17320-comment-dedupe", "NSCP-17320 comment dedupe");
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-comment-dedupe",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-comment-dedupe",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-comment-dedupe",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });
  let postCount = 0;

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: true,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: { _id: taskId, uniqueId: "13036", content: raw.title },
      }),
      updateTask: async (taskId) => ({ id: taskId, uniqueId: "13036" }),
      getTaskComments: async () => ([
        {
          id: "tb-comment-existing-fc1",
          createdAt: "2026-07-03T00:01:00.000Z",
          content: "Feishu comment from QA\nSource comment ID: fc1\n\nsee logs",
        },
      ]),
      postComment: async () => {
        postCount += 1;
        throw new Error("postComment should not be called for existing target comment");
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(postCount, 0);
  const comment = db.getFeishuProjectCommentSync({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-comment-dedupe",
    sourceCommentId: "fc1",
  });
  assert.equal(comment.syncStatus, "success");
  assert.equal(comment.targetTaskId, "tb-nscp-17320-comment-dedupe");
  assert.equal(comment.targetCommentId, "tb-comment-existing-fc1");
});

test("dry-run treats readable-equivalent Spotify tasklist as unchanged", async () => {
  const raw = sampleWorkItem("nscp-17320-spotify-same-tasklist", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "功能模块", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-spotify-same-tasklist",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-spotify-same-tasklist",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-spotify-same-tasklist",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          _projectId: "65a5f274950780b816cf905e",
          _tasklistId: "695a01be8cebcce71bb08e59",
          _sprintId: "6a03e6784fa4b959a31309f7",
        },
      }),
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.payload.tasklistId, "695a01be8cebcce71bb08e59");
  assert.equal(result.payload.tasklistIdDisplay, "阿维塔_8678平台_S应用");
  assert.equal(result.targetFieldVerification.task.tasklistId, "695a01be8cebcce71bb08e59");
  assert.equal((result.targetFieldVerification.mismatches || []).find((item) => item.field === "tasklistId"), undefined);
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.tasklistId.targetCurrent.raw, "695a01be8cebcce71bb08e59");
  assert.equal(comparisons.tasklistId.action, "same");
});

test("dry-run treats readable-equivalent participant as unchanged", async () => {
  const raw = sampleWorkItem("nscp-17320-readable-same-participant", "NSCP-17320");
  raw.fields = raw.fields.filter((field) => !["assignee", "reporter"].includes(field.field_key));
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-17320" });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-readable-same-participant",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-readable-same-participant",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-readable-same-participant",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        requiredInvolveMembers: [svc.DEFAULT_TB_EXECUTOR_ID],
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          _projectId: svc.DEFAULT_TB_TARGET_PROJECT_ID,
          _tasklistId: svc.DEFAULT_TB_TARGET_TASKLIST_ID,
          _sprintId: svc.DEFAULT_TB_TARGET_SPRINT_ID,
          _executorId: svc.DEFAULT_TB_EXECUTOR_ID,
          priority: 1,
          _involveMembers: ["徐博超"],
        },
      }),
    },
  });

  assert.equal(result.dryRun, true);
  assert.ok(result.payload.involveMembers.includes(svc.DEFAULT_TB_EXECUTOR_ID));
  assert.deepEqual(result.targetFieldVerification.task.involveMembers, ["徐博超"]);
  assert.equal(result.targetFieldVerification.mismatches.find((item) => item.field === "involveMembers"), undefined);
});

test("Teambition schedule spans three days from Feishu created time", () => {
  const raw = sampleWorkItem("due-1", "Expected fix date");
  raw.created_at = "2026-06-21T10:30:00.000Z";
  raw.fields.push({
    field_key: "field_8ec9f4",
    field_name: "期望修复日期(计算)",
    value: { timestamp: 1782316800000, iso_time: "2026-06-25T00:00:00+08:00" },
  });
  const item = svc.normalizeFeishuWorkItem(raw);
  const { payload } = svc.buildTeambitionTaskPayload(item);

  assert.equal(item.dueDate, "2026-06-24T16:00:00.000Z");
  assert.equal(payload.startDate, "2026-06-21T10:30:00.000Z");
  assert.equal(payload.dueDate, "2026-06-24T10:30:00.000Z");
});

test("transformer maps custom fields and keeps fallback summaries", () => {
  const raw = {
    ...sampleWorkItem("m2-1", "Mapping coverage"),
    source_url: "https://project.feishu.cn/intelligentspace/bug/detail/m2-1?tabKey=comment",
    fields: [
      { field_key: "title", field_name: "Title", value: "Mapping coverage" },
      { field_key: "status", field_name: "Status", value: "Open" },
      { field_key: "priority", field_name: "Priority", value: "P0" },
      { field_key: "severity", field_name: "Severity", value: "S1" },
      { field_key: "custom_flag", field_name: "Custom Flag", value: "Needs triage" },
      { field_key: "escape_hatch", field_name: "Escape Hatch", value: { nested: true } },
      { field_key: "assignee", field_name: "Assignee", value: { email: "dev2@example.com", name: "Dev Two" } },
    ],
    comments: { items: [{ comment_id: "c-wrap", author: { name: "QA" }, text: "wrapped comment" }] },
    attachments: { list: [{ file_id: "a-wrap", name: "trace.zip", downloadUrl: "https://files.example/trace.zip" }] },
    childWorkItems: [{ work_item_id: "child-1", title: "Child task", status: "Open" }],
    related_items: [{ work_item_id: "rel-1", title: "Related bug", relation_type: "blocks" }],
  };
  const config = {
    teambition: {
      sourceUrlCustomFieldId: "cf-source-url",
      severityCustomFieldId: "cf-severity",
      commentsSummaryCustomFieldId: "cf-comments",
      attachmentsSummaryCustomFieldId: "cf-attachments",
      childItemsSummaryCustomFieldId: "cf-children",
      relatedItemsSummaryCustomFieldId: "cf-related",
    },
    mappings: {
      people: { "dev2@example.com": { tbUserId: "tb-dev-2" } },
      severity: { S1: "High" },
      customFields: {
        custom_flag: "cf-custom-flag",
      },
    },
    sync: { includeRawJsonInNote: "fallback", rawJsonMaxLength: 2000 },
  };

  const item = svc.normalizeFeishuWorkItem(raw, config);
  assert.equal(item.severity, "S1");
  assert.equal(item.comments[0].id, "c-wrap");
  assert.equal(item.attachments[0].id, "a-wrap");
  assert.equal(item.childItems[0].id, "child-1");
  assert.equal(item.relatedItems[0].id, "rel-1");

  const { payload, customfields } = svc.buildTeambitionTaskPayload(item, config);
  assert.equal(payload.executorId, "tb-default-user");
  const byField = Object.fromEntries(customfields.map((f) => [f.customfieldId, f.value]));
  assert.equal(byField["cf-source-url"], raw.source_url);
  assert.equal(byField["cf-severity"], "High");
  assert.equal(byField["cf-custom-flag"], "Needs triage");
  assert.match(byField["cf-comments"], /wrapped comment/);
  assert.match(byField["cf-attachments"], /trace\.zip/);
  assert.match(byField["cf-children"], /child-1/);
  assert.match(byField["cf-related"], /rel-1/);
  assert.equal(payload.note, undefined);
});

test("transformer unwraps Feishu value objects for M2 mappings", () => {
  const raw = {
    work_item_id: "m2-2",
    space_key: "intelligentspace",
    work_item_type_key: "bug",
    work_item_url: "https://project.feishu.cn/intelligentspace/bug/detail/m2-2",
    status: { id: "st-open-id", name: "Open display" },
    reporter: { user: { email: "wrapped-reporter@example.com", display_name: "Wrapped QA" } },
    fields: [
      { field_key: "title", field_name: "Title", value: "Wrapped payload" },
      { field_key: "priority", field_name: "Priority", value: { key: "p9-key", label: "P9" } },
      { field_key: "severity", field_name: "Severity", value: { option_id: "sev-high-id", label: "High" } },
      { field_key: "assignee", field_name: "Assignee", value: { value: { user_key: "uk-wrap", display_name: "Wrapped Dev" } } },
      { field_key: "custom_enum", field_name: "Custom Enum", value: { option_id: "opt-a", label: "Choice A" } },
    ],
    comment_records: [
      {
        uuid: "comment-wrap",
        created_by: { user: { email: "wrapped-reporter@example.com", display_name: "Wrapped QA" } },
        rich_text: { text: "rich comment body" },
      },
    ],
    files: {
      items: [
        { file_token: "ft-wrap", filename: "dump.log", fileUrl: "https://files.example/dump.log" },
      ],
    },
    children: {
      items: [
        { workItemId: "child-wrap", workItemName: "Wrapped child", workflowStatus: { name: "Doing" } },
      ],
    },
    relations: {
      records: [
        {
          relation_type: "blocks",
          target_work_item: {
            work_item_id: "rel-wrap",
            work_item_name: "Wrapped related",
            workflow_status: { name: "Open" },
          },
        },
      ],
    },
  };
  const config = {
    teambition: {
      sourceUrlCustomFieldId: "cf-source-url-wrap",
      commentsSummaryCustomFieldId: "cf-comments-wrap",
      attachmentsSummaryCustomFieldId: "cf-attachments-wrap",
      childItemsSummaryCustomFieldId: "cf-children-wrap",
      relatedItemsSummaryCustomFieldId: "cf-related-wrap",
    },
    mappings: {
      people: {
        "uk-wrap": "tb-wrap-dev",
        "wrapped-reporter@example.com": "tb-wrap-qa",
      },
      status: { "st-open-id": "tb-status-open-id" },
      priority: { "p9-key": 2 },
      severity: { "sev-high-id": "Critical" },
      customFields: {
        custom_enum: { customFieldId: "cf-custom-enum", values: { "opt-a": "tb-choice-a" } },
      },
    },
  };

  const item = svc.normalizeFeishuWorkItem(raw, config);
  assert.equal(item.assignees[0].userKey, "uk-wrap");
  assert.equal(item.reporter.email, "wrapped-reporter@example.com");
  assert.equal(item.comments[0].content, "rich comment body");
  assert.equal(item.attachments[0].id, "ft-wrap");
  assert.equal(item.childItems[0].id, "child-wrap");
  assert.equal(item.relatedItems[0].id, "rel-wrap");

  const { payload, customfields } = svc.buildTeambitionTaskPayload(item, config);
  const byField = Object.fromEntries(customfields.map((f) => [f.customfieldId, f.value]));
  assert.equal(payload.executorId, "tb-default-user");
  assert.deepEqual(payload.involveMembers.sort(), ["tb-wrap-dev", "tb-wrap-qa"]);
  assert.equal(payload.taskflowstatusId, "tb-status-open-id");
  assert.equal(payload.priority, 2);
  assert.equal(byField["cf-custom-enum"], "tb-choice-a");
  assert.equal(byField["cf-source-url-wrap"], raw.work_item_url);
  assert.match(byField["cf-comments-wrap"], /rich comment body/);
  assert.match(byField["cf-attachments-wrap"], /dump\.log/);
  assert.match(byField["cf-children-wrap"], /child-wrap/);
  assert.match(byField["cf-related-wrap"], /rel-wrap/);
});

test("dry-run returns action and payload without writing sync state", async () => {
  const raw = sampleWorkItem("dry-1");
  const result = await svc.syncFeishuProjectWorkItem(raw, { dryRun: true, checkRemoteExisting: false, now: "2026-07-04T12:34:56.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.payload.projectId, "tb-project");
  assert.equal(result.payload.startDate, "2026-07-04T12:34:56.000Z");
  assert.equal(db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "dry-1",
  }), null);
});

test("dry-run treats deleted existing Teambition mapping as create without writing sync state", async () => {
  const raw = sampleWorkItem("dry-deleted-existing", "Deleted existing task");
  const key = {
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "dry-deleted-existing",
  };
  db.upsertFeishuProjectSyncState({
    ...key,
    targetTaskId: "tb-deleted-dry",
    targetUniqueId: "2201",
    sourceUpdatedAt: "2026-07-03T01:00:00.000Z",
    targetUpdatedAt: "2026-07-03T02:00:00.000Z",
    lastSyncedAt: "2026-07-03T03:00:00.000Z",
    sourcePayloadHash: "old-payload",
    commentsHash: "old-comments",
    attachmentsHash: "old-attachments",
    syncStatus: "success",
    lastError: "",
  });

  const calls = [];
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    loader: {
      checkTaskExists: async (taskId) => {
        calls.push(taskId);
        return { exists: false, source: "test", reason: "deleted" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.existing, null);
  assert.equal(result.targetVerification.exists, false);
  assert.equal(result.targetVerification.reason, "deleted");
  assert.deepEqual(calls, ["tb-deleted-dry"]);
  const stored = db.getFeishuProjectSyncState(key);
  assert.equal(stored.targetTaskId, "tb-deleted-dry");
  assert.equal(stored.syncStatus, "success");
});

test("dry-run ignores deleted remote duplicate candidates before reporting create", async () => {
  const calls = [];
  const raw = sampleWorkItem("dry-remote-deleted-candidate", "Deleted remote duplicate");
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    loader: {
      findTaskByContent: async (content) => {
        calls.push({ type: "find-title", content });
        return { _id: "tb-remote-deleted", uniqueId: 2202, content };
      },
      checkTaskExists: async (taskId) => {
        calls.push({ type: "check", taskId });
        return { exists: false, source: "test", reason: "deleted" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.remoteExisting.ignored, true);
  assert.equal(result.remoteExisting.targetVerification.exists, false);
  assert.deepEqual(calls.map((call) => call.type), ["find-title", "check"]);
});

test("dry-run reuses remotely existing Teambition task before reporting create", async () => {
  const calls = [];
  const tbTaskId = "6a4919d885fd6d2f0e3147dd";
  const raw = sampleWorkItem("dry-remote-existing", "Remote existing task");
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    loader: {
      findTaskByContent: async (content) => {
        calls.push({ type: "find", content });
        return { _id: tbTaskId, uniqueId: 2101, content };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(result.existing.targetTaskId, tbTaskId);
  assert.equal(result.existing.remoteRecovered, true);
  assert.equal(result.remoteExisting.targetTaskId, tbTaskId);
  assert.deepEqual(calls.map((call) => call.type), ["find"]);
  assert.equal(db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "dry-remote-existing",
  }), null);
});

test("existing synced task updates when remote Teambition target fields drift from payload", async () => {
  const raw = sampleWorkItem("target-field-drift", "Target field drift");
  raw.created_at = "2026-07-01T01:00:00.000Z";
  raw.fields.push({ field_key: "field_8ec9f4", field_name: "期望修复日期(计算)", value: "2026-07-05T01:00:00.000Z" });
  const config = {
    teambition: {
      projectId: "tb-current-project",
      tasklistId: "tb-current-list",
      sprintId: "tb-current-sprint",
      defaultExecutorId: "tb-current-owner",
    },
    mappings: {
      priority: { P0: 1 },
    },
    sync: {
      includeComments: false,
      includeAttachments: false,
      readScope: { enabled: false, filters: [] },
    },
  };
  const targetTaskId = "tb-target-field-drift";
  const calls = [];

  const first = await svc.syncFeishuProjectWorkItem(raw, {
    config,
    checkRemoteExisting: false,
    loader: {
      createTask: async (payload) => {
        calls.push({ type: "create", payload });
        return { _id: targetTaskId, uniqueId: 13209 };
      },
    },
  });
  assert.equal(first.action, "create");

  const second = await svc.syncFeishuProjectWorkItem(raw, {
    config,
    checkRemoteExisting: false,
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          _projectId: "tb-current-project",
          _tasklistId: "tb-old-list",
          _sprintId: "tb-old-sprint",
          _executorId: "tb-old-owner",
          startDate: "2026-06-20T01:00:00.000Z",
          dueDate: "2026-06-25T01:00:00.000Z",
          priority: 1,
        },
      }),
      listTasklists: async (projectId) => [
        { id: "tb-old-list", name: "Legacy Tasklist", projectId },
      ],
      updateTask: async (taskId, payload) => {
        calls.push({ type: "update", taskId, payload });
        return { _id: taskId, uniqueId: 13209, updatedAt: "2026-07-08T01:00:00.000Z" };
      },
    },
  });

  assert.equal(second.action, "update");
  assert.equal(second.targetFieldVerification.mismatch, true);
  assert.deepEqual(
    second.targetFieldVerification.mismatches.map((item) => item.field).sort(),
    ["priority", "tasklistId"],
  );
  const tasklistMismatch = second.targetFieldVerification.mismatches.find((item) => item.field === "tasklistId");
  assert.equal(tasklistMismatch.actual, "tb-old-list");
  assert.equal(tasklistMismatch.actualDisplay, "Legacy Tasklist");
  assert.equal(second.targetFieldVerification.mismatches.find((item) => item.field === "startDate"), undefined);
  assert.equal(second.targetFieldVerification.mismatches.find((item) => item.field === "dueDate"), undefined);
  const priorityMismatch = second.targetFieldVerification.mismatches.find((item) => item.field === "priority");
  assert.equal(priorityMismatch.actual, "1");
  assert.equal(priorityMismatch.expected, "2");
  assert.equal(second.targetFieldVerification.task.startDate, "2026-06-20T01:00:00.000Z");
  assert.equal(second.targetFieldVerification.task.dueDate, "2026-06-25T01:00:00.000Z");
  assert.equal(second.targetFieldVerification.task.priority, "1");
  const update = calls.find((call) => call.type === "update");
  assert.equal(update.taskId, targetTaskId);
  assert.equal(update.payload.tasklistId, "tb-current-list");
  assert.equal(update.payload.sprintId, undefined);
  assert.equal(second.payload.sprintId, "tb-old-sprint");
  assert.equal(update.payload.executorId, "tb-old-owner");
  assert.equal(update.payload.startDate, "2026-06-20T01:00:00.000Z");
  assert.equal(update.payload.dueDate, "2026-06-25T01:00:00.000Z");
});

test("dry-run returns existing TB values for readable update field actions", async () => {
  const raw = sampleWorkItem("nscp-17320-readable", "NSCP-17320 readable diff");
  raw.created_at = "2026-07-01T01:00:00.000Z";
  raw.fields.push({ field_key: "field_8ec9f4", field_name: "期望修复日期(计算)", value: "2026-07-05T01:00:00.000Z" });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-readable",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-readable",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320",
    targetUniqueId: "CARB-13036",
    sourceUpdatedAt: "2026-07-03T01:00:00.000Z",
    targetUpdatedAt: "2026-07-04T01:00:00.000Z",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        projectId: "tb-current-project",
        tasklistId: "tb-current-list",
        sprintId: "tb-current-sprint",
        defaultExecutorId: "tb-current-owner",
      },
      mappings: {
        priority: { P0: 10 },
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          _projectId: "tb-current-project",
          _tasklistId: "tb-current-list",
          _sprintId: "tb-current-sprint",
          _executorId: "tb-current-owner",
          startDate: "2026-06-20T01:00:00.000Z",
          dueDate: "2026-06-25T01:00:00.000Z",
          priority: 2,
          _scenariofieldconfigId: "65a5f2755a1f7b88c7a28a47",
          scenariofieldconfig: { _id: "65a5f2755a1f7b88c7a28a47", name: "缺陷" },
        },
      }),
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.action, "update");
  const mismatches = result.targetFieldVerification.mismatches || [];
  assert.deepEqual(mismatches.map((item) => item.field).sort(), []);
  assert.equal(mismatches.find((item) => item.field === "priority"), undefined);
  assert.equal(mismatches.find((item) => item.field === "startDate"), undefined);
  assert.equal(mismatches.find((item) => item.field === "dueDate"), undefined);
  assert.equal(result.targetFieldVerification.task.startDate, "2026-06-20T01:00:00.000Z");
  assert.equal(result.targetFieldVerification.task.dueDate, "2026-06-25T01:00:00.000Z");
  assert.equal(result.targetFieldVerification.task.priority, "2");
  assert.equal(result.targetFieldVerification.task.priorityDisplay, "\u975e\u5e38\u7d27\u6025");
  assert.equal(result.payload.priority, 2);
  assert.equal(result.payload.priorityDisplay, "\u975e\u5e38\u7d27\u6025");
  assert.equal(result.payload.startDate, "2026-06-20T01:00:00.000Z");
  assert.equal(result.payload.dueDate, "2026-06-25T01:00:00.000Z");
  assert.equal(result.targetFieldVerification.task.scenariofieldconfigId, "65a5f2755a1f7b88c7a28a47");
  assert.equal(result.targetFieldVerification.task.scenariofieldconfigIdDisplay, "缺陷");
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.startDate.action, "same");
  assert.equal(comparisons.startDate.targetCurrent.raw, "2026-06-20T01:00:00.000Z");
  assert.equal(comparisons.startDate.targetNext.raw, "2026-06-20T01:00:00.000Z");
  assert.equal(comparisons.dueDate.action, "same");
  assert.equal(comparisons.dueDate.targetCurrent.raw, "2026-06-25T01:00:00.000Z");
  assert.equal(comparisons.dueDate.targetNext.raw, "2026-06-25T01:00:00.000Z");
});

test("dry-run preserves executor already assigned on existing Teambition task", async () => {
  const raw = sampleWorkItem("nscp-17320-existing-executor", "NSCP-17320 existing executor");
  raw.created_at = "2026-07-01T01:00:00.000Z";
  raw.fields.push({ field_key: "field_8ec9f4", field_name: "期望修复日期(计算)", value: "2026-07-05T01:00:00.000Z" });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-existing-executor",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-existing-executor",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-existing-executor",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        projectId: "tb-current-project",
        tasklistId: "tb-current-list",
        sprintId: "tb-current-sprint",
        defaultExecutorId: "tb-default-owner",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      listMembers: async () => [{ id: "tb-manager-owner", name: "管理者指定执行者" }],
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          _projectId: "tb-current-project",
          _tasklistId: "tb-current-list",
          _sprintId: "tb-current-sprint",
          _executorId: "tb-manager-owner",
          executor: { _id: "tb-manager-owner", name: "管理者指定执行者" },
          startDate: "2026-06-20T01:00:00.000Z",
          dueDate: "2026-06-25T01:00:00.000Z",
          priority: 1,
        },
      }),
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.action, "update");
  assert.equal(result.payload.executorId, "tb-manager-owner");
  assert.equal(result.payload.executorIdDisplay, "管理者指定执行者");
  assert.equal(result.payload.startDate, "2026-06-20T01:00:00.000Z");
  assert.equal(result.payload.dueDate, "2026-06-25T01:00:00.000Z");
  assert.equal(result.targetFieldVerification.task.executorId, "tb-manager-owner");
  const mismatches = result.targetFieldVerification.mismatches || [];
  assert.equal(mismatches.find((item) => item.field === "executorId"), undefined);
  assert.equal(mismatches.find((item) => item.field === "startDate"), undefined);
  assert.equal(mismatches.find((item) => item.field === "dueDate"), undefined);
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.executorId.targetCurrent.raw, "tb-manager-owner");
  assert.equal(comparisons.executorId.targetCurrent.display, "管理者指定执行者");
  assert.equal(comparisons.executorId.targetNext.raw, "tb-manager-owner");
  assert.equal(comparisons.executorId.targetNext.display, "管理者指定执行者");
  assert.equal(comparisons.executorId.action, "same");
  assert.equal(comparisons.startDate.action, "same");
  assert.equal(comparisons.dueDate.action, "same");
});

test("dry-run uses sheet target override to show old TB note without mutating sync state", async () => {
  const raw = sampleWorkItem("nscp-17320-sheet-target", "NSCP-17320 sheet target note diff");
  raw.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_ee70e6", field_name: "缺陷描述", value: "new Feishu defect note" });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    sheetTargetByProblemNo: {
      "NSCP-17320": {
        targetTaskId: "tb-sheet-13036",
        targetUniqueId: "13036",
        targetDisplayId: "CARB-13036",
        sheetTargetRow: {
          "系统单号": "NSCP-17320",
          "钉钉单号": "CARB-13036",
          "问题": "old sheet problem title",
          "状态": "处理中",
        },
        sheetTargetColumns: ["系统单号", "钉钉单号", "问题", "状态"],
      },
    },
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: { _id: taskId, uniqueId: "13036", note: "old TB note from CARB-13036" },
      }),
    },
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.action, "update");
  assert.equal(result.existing.targetTaskId, "tb-sheet-13036");
  assert.equal(result.existing.targetUniqueId, "13036");
  assert.deepEqual(result.existing.sheetTargetColumns, ["系统单号", "钉钉单号", "问题", "状态"]);
  assert.deepEqual(result.existing.sheetTargetRow, {
    "系统单号": "NSCP-17320",
    "钉钉单号": "CARB-13036",
    "问题": "old sheet problem title",
    "状态": "处理中",
  });
  assert.equal(db.getFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-sheet-target",
  }), null);
  assert.equal(result.targetFieldVerification.task.uniqueId, "13036");
  assert.equal(result.targetFieldVerification.notePrevious, "old TB note from CARB-13036");
  assert.equal(result.payload.notePrevious, "old TB note from CARB-13036");
});

test("dry-run resolves TB detail page ids to readable tasklist and executor names", async () => {
  const raw = sampleWorkItem("nscp-17320-detail-page-readable", "NSCP-17320 readable detail page ids");
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-detail-page-readable",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-detail-page-readable",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-detail-page",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const currentTasklistId = "695a01be8cebcce71bb08e59";
  const currentExecutorId = "61c56c94bcd255272d62d053";
  const targetTasklistId = "69ddf5744b9a04cb08c4c2fa";
  const currentTasklistName = "\u963f\u7ef4\u5854_8678\u5e73\u53f0_S\u5e94\u7528";
  const targetTasklistName = "\u963f\u7ef4\u5854_8678\u5e73\u53f0_\u5e94\u7528\u5e02\u573a";
  const currentExecutorName = "\u7f57\u5b5f\u4f1f";

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        projectId: "65a5f274950780b816cf905e",
        tasklistId: targetTasklistId,
        sprintId: "tb-current-sprint",
        defaultExecutorId: "tb-current-owner",
      },
      mappings: {
        priority: { P0: 1 },
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          _projectId: "65a5f274950780b816cf905e",
          _tasklistId: currentTasklistId,
          _executorId: currentExecutorId,
          _sprintId: "tb-current-sprint",
          priority: 2,
        },
      }),
      getTasklist: async (tasklistId, projectId) => {
        const names = new Map([
          [currentTasklistId, currentTasklistName],
          [targetTasklistId, targetTasklistName],
        ]);
        return {
          id: tasklistId,
          tasklistId,
          title: names.get(tasklistId) || tasklistId,
          name: names.get(tasklistId) || tasklistId,
          projectId,
        };
      },
      listMembers: async () => [
        { id: currentExecutorId, uid: currentExecutorId, name: currentExecutorName },
      ],
    },
  });

  assert.equal(result.action, "update");
  const fields = result.targetFieldVerification.mismatches.map((item) => item.field);
  assert.ok(fields.includes("tasklistId"));
  assert.equal(fields.includes("executorId"), false);
  const tasklistMismatch = result.targetFieldVerification.mismatches.find((item) => item.field === "tasklistId");
  assert.equal(tasklistMismatch.actualDisplay, currentTasklistName);
  assert.equal(tasklistMismatch.expectedDisplay, targetTasklistName);
  assert.equal(result.targetFieldVerification.task.tasklistIdDisplay, currentTasklistName);
  assert.equal(result.targetFieldVerification.task.executorIdDisplay, currentExecutorName);
  assert.equal(result.payload.tasklistIdDisplay, targetTasklistName);
  assert.equal(result.payload.executorId, currentExecutorId);
  assert.equal(result.payload.executorIdDisplay, currentExecutorName);
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.executorId.action, "same");
  assert.equal(comparisons.executorId.targetCurrent.display, currentExecutorName);
  assert.equal(comparisons.executorId.targetNext.display, currentExecutorName);
});

test("dry-run field verification fetches full target detail before classifying readable field actions", async () => {
  const raw = sampleWorkItem("nscp-17320-detail-readable", "NSCP-17320 detail readable diff");
  raw.created_at = "2026-07-01T01:00:00.000Z";
  raw.fields.push({ field_key: "field_8ec9f4", field_name: "期望修复日期(计算)", value: "2026-07-05T01:00:00.000Z" });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-detail-readable",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-detail-readable",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-detail",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });
  const calls = [];

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        projectId: "tb-current-project",
        tasklistId: "tb-current-list",
        sprintId: "tb-current-sprint",
        defaultExecutorId: "tb-current-owner",
      },
      mappings: {
        priority: { P0: 1 },
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => {
        calls.push(["checkTaskExists", taskId]);
        return {
          exists: true,
          source: "existence",
          task: {
            taskId,
            uniqueId: "13036",
          },
        };
      },
      getTaskDetail: async (taskId) => {
        calls.push(["getTaskDetail", taskId]);
        return {
          taskId,
          uniqueId: "13036",
          _projectId: "tb-current-project",
          _tasklistId: "tb-current-list",
          _sprintId: "tb-current-sprint",
          _executorId: "tb-current-owner",
          startTime: "2026-06-20T01:00:00.000Z",
          dueTime: "2026-06-25T01:00:00.000Z",
          _priority: 1,
        };
      },
    },
  });

  assert.deepEqual(calls.map(([type]) => type), ["checkTaskExists", "getTaskDetail", "getTaskDetail"]);
  assert.equal(result.action, "update");
  assert.deepEqual(
    result.targetFieldVerification.mismatches.map((item) => item.field).sort(),
    ["priority"],
  );
  const priorityMismatch = result.targetFieldVerification.mismatches.find((item) => item.field === "priority");
  assert.equal(priorityMismatch.actual, "1");
  assert.equal(priorityMismatch.expected, "2");
  assert.equal(priorityMismatch.actualDisplay, "\u7d27\u6025");
  assert.equal(priorityMismatch.expectedDisplay, "\u975e\u5e38\u7d27\u6025");
  assert.equal(result.targetFieldVerification.task.startDate, "2026-06-20T01:00:00.000Z");
  assert.equal(result.targetFieldVerification.task.dueDate, "2026-06-25T01:00:00.000Z");
  assert.equal(result.targetFieldVerification.task.priority, "1");
  assert.equal(result.targetFieldVerification.task.priorityDisplay, "\u7d27\u6025");
  assert.equal(result.payload.priorityDisplay, "\u975e\u5e38\u7d27\u6025");
  assert.equal(result.payload.startDate, "2026-06-20T01:00:00.000Z");
  assert.equal(result.payload.dueDate, "2026-06-25T01:00:00.000Z");
  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(comparisons.startDate.action, "same");
  assert.equal(comparisons.dueDate.action, "same");
});

test("dry-run prefers remotely existing Teambition task matched by Source ID", async () => {
  const calls = [];
  const tbTaskId = "tb-source-id-found";
  const raw = sampleWorkItem("dry-remote-source-id", "Renamed local title");
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    loader: {
      findTaskBySourceId: async (sourceId) => {
        calls.push({ type: "find-source", sourceId });
        return { _id: tbTaskId, uniqueId: 2103, content: "Old remote title" };
      },
      findTaskByContent: async () => {
        calls.push({ type: "find-title" });
        throw new Error("title lookup should not run after Source ID match");
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(result.existing.targetTaskId, tbTaskId);
  assert.equal(result.existing.remoteRecoveredBy, "feishu-source-id");
  assert.deepEqual(calls, [{ type: "find-source", sourceId: "intelligentspace/bug/dry-remote-source-id" }]);
});

test("dry-run prefers remotely existing Teambition task matched by Feishu system number", async () => {
  const calls = [];
  const tbTaskId = "tb-system-no-found";
  const raw = sampleWorkItem("dry-remote-system-no", "远端已有缺陷");
  raw.work_item_no = "NSCP-17601";
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    loader: {
      findTasksByTextToken: async (token) => {
        calls.push({ type: "find-token", token });
        return [{ _id: tbTaskId, uniqueId: 2104, content: "【缺陷转载-8678】【阿维塔】NSCP-17601远端已有缺陷" }];
      },
      findTaskBySourceId: async () => {
        calls.push({ type: "find-source" });
        throw new Error("source lookup should not run after system number match");
      },
      findTaskByContent: async () => {
        calls.push({ type: "find-title" });
        throw new Error("title lookup should not run after system number match");
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(result.existing.targetTaskId, tbTaskId);
  assert.equal(result.existing.remoteRecoveredBy, "feishu-system-no");
  assert.deepEqual(calls, [{ type: "find-token", token: "NSCP-17601" }]);
});

test("duplicate detection lists all Teambition tasks matched by Feishu Source ID", async () => {
  const calls = [];
  const result = await svc.detectFeishuProjectDuplicateTasks({
    workItems: [sampleWorkItem("duplicate-source-id", "Duplicate source item")],
    loader: {
      findTasksBySourceId: async (sourceId, cfgForFind) => {
        calls.push({ sourceId, projectId: cfgForFind.teambition.projectId });
        return [
          { id: "tb-dup-new", uniqueId: 3102, title: "New duplicate", updatedAt: "2026-07-04T02:00:00.000Z" },
          { _id: "tb-dup-old", uniqueId: 3101, content: "Old duplicate", updated: "2026-07-03T02:00:00.000Z" },
        ];
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.hasDuplicates, true);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].sourceId, "intelligentspace/bug/duplicate-source-id");
  assert.deepEqual(result.duplicates[0].tasks.map((task) => task.id), ["tb-dup-new", "tb-dup-old"]);
  assert.deepEqual(calls, [{ sourceId: "intelligentspace/bug/duplicate-source-id", projectId: "" }]);
});

test("duplicate detection matches Teambition tasks by Feishu work item number", async () => {
  const calls = [];
  const raw = sampleWorkItem("nscp-15889-internal", "问题描述摘要");
  raw.fields.push({ field_key: "problem_no", field_name: "问题编号", value: "NSCP-15889" });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-15889-internal",
    targetTaskId: "tb-local-created",
    targetUniqueId: "3201",
    syncStatus: "success",
  });

  const result = await svc.detectFeishuProjectDuplicateTasks({
    workItems: [raw],
    loader: {
      findTasksBySourceId: async (sourceId, cfgForFind) => {
        calls.push({ type: "source", sourceId, projectId: cfgForFind.teambition.projectId });
        return [];
      },
      findTasksByTextToken: async (token, cfgForFind) => {
        calls.push({ type: "token", token, projectId: cfgForFind.teambition.projectId });
        if (token !== "NSCP-15889") return [];
        return [
          { id: "tb-remote-nscp", uniqueId: 3202, title: "【阿维塔】【转载】【NSCP-15889】问题复现" },
        ];
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.hasDuplicates, true);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].sourceWorkItemNo, "NSCP-15889");
  assert.equal(result.duplicates[0].duplicateKey, "nscp15889");
  assert.deepEqual(result.duplicates[0].tasks.map((task) => task.id), ["tb-remote-nscp", "tb-local-created"]);
  assert.ok(calls.some((call) => call.type === "token" && call.token === "NSCP-15889" && call.projectId === ""));
});

test("duplicate detection finds duplicates among locally synced Teambition tasks by Feishu work item number", async () => {
  const rawA = { ...sampleWorkItem("local-nscp-a", "NSCP-15900"), work_item_no: "NSCP-15900" };
  const rawB = { ...sampleWorkItem("local-nscp-b", "NSCP-15900"), work_item_no: "NSCP-15900" };
  db.insertFeishuProjectRawPayload({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "local-nscp-a",
    payloadHash: "local-nscp-a-hash",
    payloadJson: rawA,
  });
  db.insertFeishuProjectRawPayload({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "local-nscp-b",
    payloadHash: "local-nscp-b-hash",
    payloadJson: rawB,
  });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "local-nscp-a",
    targetTaskId: "tb-local-nscp-a",
    syncStatus: "success",
  });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "local-nscp-b",
    targetTaskId: "tb-local-nscp-b",
    syncStatus: "success",
  });

  const result = await svc.detectFeishuProjectDuplicateTasks({
    workItems: [rawA],
    loader: {
      findTasksBySourceId: async () => [],
      findTasksByTextToken: async () => [],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.hasDuplicates, true);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].sourceWorkItemNo, "NSCP-15900");
  assert.deepEqual(result.duplicates[0].tasks.map((task) => task.id).sort(), ["tb-local-nscp-a", "tb-local-nscp-b"]);
});

test("sync records expose Feishu problem number for mapping table", () => {
  const raw = sampleWorkItem("records-problem-no", "记录表摘要");
  raw.fields.push({ field_key: "problem_no", field_name: "问题编号", value: "NSCP-16001" });
  db.insertFeishuProjectRawPayload({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "records-problem-no",
    payloadHash: "records-problem-no-hash",
    payloadJson: raw,
  });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "records-problem-no",
    targetTaskId: "tb-records-problem-no",
    syncStatus: "success",
  });

  const records = svc.listFeishuProjectSyncRecords({
    projectKey: "intelligentspace",
    typeKey: "bug",
    limit: 1000,
  });
  const record = records.find((row) => row.sourceWorkItemId === "records-problem-no");
  assert.equal(record?.sourceProblemNo, "NSCP-16001");
  assert.equal(record?.problemNo, "NSCP-16001");
  assert.equal(record?.sourceWorkItemNo, "NSCP-16001");

  const sinceRecords = svc.listFeishuProjectSyncRecordsSince(0, {
    projectKey: "intelligentspace",
    typeKey: "bug",
    limit: 1000,
  });
  const sinceRecord = sinceRecords.find((row) => row.sourceWorkItemId === "records-problem-no");
  assert.equal(sinceRecord?.sourceProblemNo, "NSCP-16001");
  assert.equal(sinceRecord?.sourceWorkItemNo, "NSCP-16001");
});

test("LAN merge for mapping table prefers Feishu/TB update time and keeps remote watermarks", () => {
  const key = {
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "lan-merge-clock",
  };
  const local = db.upsertFeishuProjectSyncState({
    ...key,
    targetTaskId: "tb-local",
    targetUniqueId: "CARB-4101",
    sourceUpdatedAt: "2026-07-03T01:00:00.000Z",
    targetUpdatedAt: "2026-07-04T01:00:00.000Z",
    syncStatus: "success",
  });

  db.mergeFeishuProjectSyncState({
    ...key,
    targetTaskId: "tb-stale-but-recently-replicated",
    targetUniqueId: "CARB-4100",
    sourceUpdatedAt: "2026-07-03T01:00:00.000Z",
    targetUpdatedAt: "2026-07-03T23:59:59.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    replicatedAt: local.replicatedAt + 100000,
    syncStatus: "success",
  });
  assert.equal(db.getFeishuProjectSyncState(key).targetTaskId, "tb-local");

  const remoteReplicatedAt = Math.max(1, local.replicatedAt - 1);
  db.mergeFeishuProjectSyncState({
    ...key,
    targetTaskId: "tb-remote-newer",
    targetUniqueId: "CARB-4102",
    sourceProblemNo: "NSCP-4102",
    sourceWorkItemNo: "NSCP-4102",
    sourceUpdatedAt: "2026-07-05T01:00:00.000Z",
    targetUpdatedAt: "2026-07-05T02:00:00.000Z",
    updatedAt: "2026-07-05T02:00:01.000Z",
    replicatedAt: remoteReplicatedAt,
    syncStatus: "success",
  });
  const merged = db.getFeishuProjectSyncState(key);
  assert.equal(merged.targetTaskId, "tb-remote-newer");
  assert.equal(merged.targetUpdatedAt, "2026-07-05T02:00:00.000Z");
  assert.equal(merged.sourceProblemNo, "NSCP-4102");
  assert.equal(merged.sourceWorkItemNo, "NSCP-4102");
  assert.equal(merged.replicatedAt, remoteReplicatedAt);

  db.mergeFeishuProjectSyncState({ ...merged });
  assert.equal(db.getFeishuProjectSyncState(key).replicatedAt, remoteReplicatedAt, "重复合并不应 bump replicatedAt");
});

test("records-since exposes mapping rows by replicated watermark", () => {
  const state = db.upsertFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "lan-records-since",
    sourceProblemNo: "NSCP-4103",
    sourceWorkItemNo: "NSCP-4103",
    targetTaskId: "tb-records-since",
    sourceUpdatedAt: "2026-07-03T01:00:00.000Z",
    targetUpdatedAt: "2026-07-03T02:00:00.000Z",
    syncStatus: "success",
  });
  const rows = db.listFeishuProjectSyncStatesSince(state.replicatedAt);
  const row = rows.find((item) => item.sourceWorkItemId === "lan-records-since");
  assert.ok(row);
  assert.equal(row.sourceProblemNo, "NSCP-4103");
  assert.equal(row.sourceWorkItemNo, "NSCP-4103");
  assert.ok(!db.listFeishuProjectSyncStatesSince(state.replicatedAt + 1).some((row) => row.sourceWorkItemId === "lan-records-since"));
});

test("duplicate merge repoints sync state and optionally deletes non-target tasks", async () => {
  const calls = [];
  db.upsertFeishuProjectCommentSync({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "duplicate-merge",
    sourceCommentId: "old-comment",
    targetTaskId: "tb-merge-old",
    targetCommentId: "tb-comment-old",
    sourcePayloadHash: "comment-hash",
    syncStatus: "success",
  });
  const result = await svc.mergeFeishuProjectDuplicateTasks({
    sourceId: "intelligentspace/bug/duplicate-merge",
    targetTaskId: "tb-merge-target",
    targetUniqueId: "CARB-3102",
    duplicateTaskIds: ["tb-merge-target", "tb-merge-old"],
    deleteDuplicateTasks: true,
    loader: {
      postComment: async (taskId, content) => {
        calls.push({ type: "comment", taskId, content });
        return { id: "comment-1" };
      },
      deleteTask: async (taskId) => {
        calls.push({ type: "delete", taskId });
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.type), ["comment", "delete"]);
  assert.equal(calls[0].taskId, "tb-merge-target");
  assert.match(calls[0].content, /Source ID: intelligentspace\/bug\/duplicate-merge/);
  assert.equal(calls[1].taskId, "tb-merge-old");
  const state = db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "duplicate-merge",
  });
  assert.equal(state.targetTaskId, "tb-merge-target");
  assert.equal(state.targetUniqueId, "CARB-3102");
  const comment = db.getFeishuProjectCommentSync({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "duplicate-merge",
    sourceCommentId: "old-comment",
  });
  assert.equal(comment.targetTaskId, "tb-merge-target");
  assert.equal(comment.targetCommentId, "");
  assert.equal(comment.syncStatus, "pending");
});

test("target verification resets sync mapping when Teambition task is deleted", async () => {
  const sourceKey = {
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "deleted-target-reset",
  };
  db.upsertFeishuProjectSyncState({
    ...sourceKey,
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/deleted-target-reset",
    targetTaskId: "tb-deleted-target",
    targetUniqueId: "TB-901",
    targetUpdatedAt: "2026-07-06T05:00:00.000Z",
    sourcePayloadHash: "payload-before-delete",
    commentsHash: "comments-before-delete",
    attachmentsHash: "attachments-before-delete",
    syncStatus: "success",
    lastSyncedAt: "2026-07-06T05:01:00.000Z",
  });
  db.upsertFeishuProjectCommentSync({
    ...sourceKey,
    sourceCommentId: "comment-before-delete",
    targetTaskId: "tb-deleted-target",
    targetCommentId: "tb-comment-before-delete",
    sourcePayloadHash: "comment-hash",
    syncStatus: "success",
    syncedAt: "2026-07-06T05:02:00.000Z",
  });
  db.upsertFeishuProjectAttachmentSync({
    ...sourceKey,
    sourceAttachmentId: "attachment-before-delete",
    targetTaskId: "tb-deleted-target",
    targetFileId: "tb-file-before-delete",
    sourcePayloadHash: "attachment-hash",
    syncStatus: "success",
    syncedAt: "2026-07-06T05:03:00.000Z",
  });

  const result = await svc.verifyFeishuProjectSyncTargets({
    ...sourceKey,
    limit: 20,
    loader: {
      checkTaskExists: async (taskId) => ({ exists: taskId !== "tb-deleted-target", source: "test" }),
    },
  });

  assert.equal(result.checked, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.resetCount, 1);
  const state = db.getFeishuProjectSyncState(sourceKey);
  assert.equal(state.targetTaskId, "");
  assert.equal(state.targetUniqueId, "");
  assert.equal(state.lastSyncedAt, "");
  assert.equal(state.sourcePayloadHash, "");
  assert.equal(state.syncStatus, "pending");
  const comment = db.getFeishuProjectCommentSync({ ...sourceKey, sourceCommentId: "comment-before-delete" });
  assert.equal(comment.targetTaskId, "");
  assert.equal(comment.targetCommentId, "");
  assert.equal(comment.syncStatus, "pending");
  const attachment = db.getFeishuProjectAttachmentSync({ ...sourceKey, sourceAttachmentId: "attachment-before-delete" });
  assert.equal(attachment.targetTaskId, "");
  assert.equal(attachment.targetFileId, "");
  assert.equal(attachment.syncStatus, "pending");
});

test("Feishu sheet update plan appends only missing system numbers", async () => {
  const sheet = await import("../../features/FeiShuProjects/src/feishu-sheet-sync.js");
  const createdRaw = sampleWorkItem("sheet-create-1", "新增问题");
  createdRaw.work_item_no = "NSCP-17576";
  createdRaw.created_at = "2026-07-03T08:00:00.000Z";
  createdRaw.fields.push(
    { field_key: "tester", field_name: "测试机构", value: "座舱测试" },
    { field_key: "field_95a8a4", field_name: "功能模块", value: { label: "应用市场" } },
    { field_key: "testType", field_name: "测试类型", value: "功能测试" },
    { field_key: "severity", field_name: "问题等级", value: "C" },
    { field_key: "role_bd6222", field_name: "问题责任人（角色）", value: [{ name: "阳荣峰" }] },
    { field_key: "must_fix", field_name: "必解标签", value: "必解" },
    { field_key: "field_3ec280", field_name: "责任部门", value: { label: "生态" } },
    { field_key: "field_52333f", field_name: "根本原因", value: "资源文件被混淆导致无法引用" },
    { field_key: "field_98c2a6", field_name: "解决方案", value: "添加混淆规则" },
  );
  const updatedRaw = sampleWorkItem("sheet-update-1", "重复问题");
  updatedRaw.work_item_no = "NSCP-17577";
  updatedRaw.created_at = "2026-07-03T08:00:00.000Z";
  updatedRaw.fields.push(
    { field_key: "reporter", field_name: "提单人", value: { name: "徐博超" } },
  );

  const plan = sheet.buildFeishuSheetUpdatePlan({
    ok: true,
    results: [
      {
        ok: true,
        action: "create",
        item: svc.normalizeFeishuWorkItem(createdRaw),
        payload: { content: "【阿维塔】【转载】【NSCP-17576】新增问题" },
        targetUniqueId: 13104,
      },
      {
        ok: true,
        action: "update",
        item: svc.normalizeFeishuWorkItem(updatedRaw),
        payload: { content: "【阿维塔】【转载】【NSCP-17577】更新问题" },
        targetUniqueId: 13105,
      },
    ],
  }, {
    existingRows: [
      {
        序号: "1",
        系统单号: "NSCP-17577",
        问题地址: "https://project.feishu.cn/intelligentspace/bug/detail/sheet-update-1",
        提单时间: "7月3日",
        提单人: "王伟",
        问题名称: "旧问题",
      },
    ],
  });

  assert.deepEqual(plan.columns, [
    "序号",
    "系统单号",
    "钉钉单号",
    "问题地址",
    "应用",
    "测试类型",
    "问题等级",
    "提单时间",
    "问题",
    "开发",
    "状态",
    "必解标签",
    "处理方",
    "结论",
    "可走单时间",
    "发版时间",
    "同步人",
  ]);
  assert.equal(plan.updateCount, 1);
  assert.deepEqual(plan.items.map((item) => item.action), ["新增"]);
  assert.equal(plan.items[0].newRow["序号"], "2");
  assert.equal(plan.items[0].newRow["系统单号"], "NSCP-17576");
  assert.equal(plan.items[0].newRow["钉钉单号"], "CARB-13104");
  assert.equal(plan.items[0].newRow["问题地址"], "https://project.feishu.cn/intelligentspace/bug/detail/sheet-create-1");
  assert.equal(plan.items[0].newRow["应用"], "应用市场");
  assert.equal(plan.items[0].newRow["测试类型"], "功能测试");
  assert.equal(plan.items[0].newRow["问题等级"], "C");
  assert.equal(plan.items[0].newRow["提单时间"], "7月3日");
  assert.equal(plan.items[0].newRow["问题"], "【缺陷转载-8678】【阿维塔】NSCP-17576新增问题");
  assert.equal(plan.items[0].newRow["开发"], "阳荣峰");
  assert.equal(plan.items[0].newRow["状态"], "Open");
  assert.equal(plan.items[0].newRow["必解标签"], "必解");
  assert.equal(plan.items[0].newRow["处理方"], "生态");
  assert.equal(plan.items[0].newRow["结论"], "原因：资源文件被混淆导致无法引用\n解决方案：添加混淆规则");
  assert.equal(plan.items[0].previewRows.find((row) => row.kind === "header").cells.length, plan.columns.length);
  assert.equal(plan.items[0].previewRows.find((row) => row.kind === "new").cells.length, plan.columns.length);
  assert.equal(plan.skipped.some((item) => item.reason === "sheet row already exists" && item.sourceNo === "NSCP-17577"), true);
});

test("Feishu created time maps to Teambition start date", async () => {
  const raw = {
    ...sampleWorkItem("start-from-feishu"),
    created_at: "2026-06-16T21:16:55+08:00",
  };
  const result = await svc.syncFeishuProjectWorkItem(raw, { dryRun: true, checkRemoteExisting: false, now: "2026-07-04T12:34:56.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.item.createdAt, "2026-06-16T13:16:55.000Z");
  assert.equal(result.payload.startDate, "2026-07-04T12:34:56.000Z");
  assert.equal(result.payload.dueDate, "2026-07-07T12:34:56.000Z");
});

test("create payload sets default dueDate from startDate when Feishu due date is before creation time", async () => {
  const raw = sampleWorkItem("dry-overdue");
  raw.fields.push({ field_key: "field_8ec9f4", field_name: "期望修复日期(计算)", value: "2026-07-01T00:00:00.000Z" });
  const result = await svc.syncFeishuProjectWorkItem(raw, { dryRun: true, checkRemoteExisting: false, now: "2026-07-04T12:34:56.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.payload.startDate, "2026-07-04T12:34:56.000Z");
  assert.equal(result.payload.dueDate, "2026-07-07T12:34:56.000Z");
});

test("sync only processes configured Feishu project bug scope", async () => {
  const calls = [];
  const raw = { ...sampleWorkItem("scope-1"), space_key: "other-space", work_item_type_key: "bug" };
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    loader: {
      createTask: async (payload) => {
        calls.push(payload);
        return { id: "tb-scope-task" };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, "skip");
  assert.equal(result.skipped, true);
  assert.match(result.reason, /out-of-scope Feishu project/);
  assert.equal(calls.length, 0);
  assert.equal(db.getFeishuProjectSyncState({
    sourceProjectKey: "other-space",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "scope-1",
  }), null);
});

test("sync skips work items whose assignees do not match required keywords", async () => {
  const calls = [];
  const raw = sampleWorkItem("assignee-skip");
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    config: { sync: { requiredAssigneeKeywords: ["徐博超"] } },
    loader: {
      createTask: async (payload) => {
        calls.push(payload);
        return { id: "tb-assignee-skip" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "skip");
  assert.equal(result.skipped, true);
  assert.match(result.reason, /assignee gate/);
  assert.equal(calls.length, 0);
  assert.equal(db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "assignee-skip",
  }), null);
});

test("sync allows work items whose assignee name or account matches required keywords", async () => {
  const calls = [];
  const raw = sampleWorkItem("assignee-match");
  raw.fields = raw.fields.map((field) => field.field_key === "assignee"
    ? { field_key: "field_current_owner", field_name: "当前负责人", value: [{ user_key: "xubochao-徐博超", name: "徐博超" }] }
    : field);
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    config: { sync: { requiredAssigneeKeywords: ["徐博超"], includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async (payload) => {
        calls.push(payload);
        return { id: "tb-assignee-match" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.targetTaskId, "tb-assignee-match");
  assert.equal(calls.length, 1);
});

test("sync read scope allows work items whose problem owner role matches configured options", async () => {
  const calls = [];
  const raw = sampleWorkItem("owner-role-match");
  raw.fields.push({ field_key: "role_bd6222", field_name: "问题责任人（角色）", value: [{ user_key: "yrf", name: "阳荣峰" }] });
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: {
          enabled: true,
          match: "all",
          filters: [{
            enabled: true,
            kind: "role",
            fieldKey: "role_bd6222",
            fieldName: "问题责任人（角色）",
            operator: "containsAny",
            values: ["阳荣峰", "徐博超", "彭俊维"],
          }],
        },
      },
    },
    loader: {
      createTask: async (payload) => {
        calls.push(payload);
        return { id: "tb-owner-role-match" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.targetTaskId, "tb-owner-role-match");
  assert.equal(calls.length, 1);
});

test("NSCP-17420 read scope accepts a configured owner from any equivalent multi-owner role field", async () => {
  const raw = sampleWorkItem("nscp-17420-multi-owner", "NSCP-17420");
  raw.fields.push({
    field_key: "__role_mql_role_bd6222",
    field_name: "__问题责任人（角色）",
    value: [{ user_key: "liu-li", name: "刘力" }],
  });
  raw.fields.push({
    field_key: "__role_brief_role_bd6222",
    field_name: "__问题责任人（角色）",
    value: [
      { user_key: "liu-li", name: "刘力" },
      { user_key: "yang-rongfeng", name: "阳荣峰" },
      { user_key: "liu-jiao", name: "刘姣" },
      { user_key: "li-shengjie", name: "李胜杰" },
    ],
  });
  raw.fields.push({
    field_key: "field_related_bug_status",
    field_name: "关联重复BUG ID的当前状态(实时更新)",
    value: [{ key: "testing", label: "TESTING" }],
  });
  raw.fields.push({
    field_key: "work_item_status",
    field_name: "状态",
    value: [{ key: "open", label: "OPEN" }],
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: {
          enabled: true,
          match: "all",
          filters: [
            {
              enabled: true,
              kind: "role",
              fieldKey: "role_bd6222",
              fieldName: "问题责任人（角色）",
              operator: "containsAny",
              values: ["阳荣峰", "徐博超", "彭俊维", "冯国梁"],
            },
            {
              enabled: true,
              kind: "field",
              fieldKey: "work_item_status",
              fieldName: "状态",
              operator: "notContainsAny",
              values: ["CLOSED", "TESTING"],
            },
          ],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.scopeStatus, undefined);
});

test("sync read scope skips work items whose problem owner role is outside configured options", async () => {
  const calls = [];
  const raw = sampleWorkItem("owner-role-skip");
  raw.fields.push({ field_key: "role_bd6222", field_name: "问题责任人（角色）", value: [{ user_key: "other", name: "其他人" }] });
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: {
          enabled: true,
          match: "all",
          filters: [{
            enabled: true,
            kind: "role",
            fieldKey: "role_bd6222",
            fieldName: "问题责任人（角色）",
            operator: "containsAny",
            values: ["阳荣峰", "徐博超", "彭俊维"],
          }],
        },
      },
    },
    loader: {
      createTask: async (payload) => {
        calls.push(payload);
        return { id: "tb-owner-role-skip" };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "skip");
  assert.equal(result.skipped, true);
  assert.match(result.reason, /read scope filter gate/);
  assert.equal(calls.length, 0);
});

test("sync marks existing mapping as transferred when current read scope no longer matches", async () => {
  const config = {
    sync: {
      includeComments: false,
      includeAttachments: false,
      readScope: {
        enabled: true,
        filters: [{
          enabled: true,
          fieldKey: "role_owner",
          fieldName: "Problem Owner",
          operator: "containsAny",
          values: ["Owner A"],
        }],
      },
    },
  };
  const previous = sampleWorkItem("owner-role-transfer", "NSCP-18001");
  previous.fields.push({ field_key: "role_owner", field_name: "Problem Owner", value: [{ user_key: "owner-a", name: "Owner A" }] });
  db.insertFeishuProjectRawPayload({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "owner-role-transfer",
    payloadHash: "owner-role-transfer-previous",
    payloadJson: previous,
  });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "owner-role-transfer",
    sourceProblemNo: "NSCP-18001",
    sourceWorkItemNo: "NSCP-18001",
    targetTaskId: "tb-owner-role-transfer",
    syncStatus: "success",
    lastSyncedAt: "2026-07-03T00:00:00.000Z",
  });

  const current = sampleWorkItem("owner-role-transfer", "NSCP-18001");
  current.updated_at = "2026-07-08T00:00:00.000Z";
  current.fields.push({ field_key: "role_owner", field_name: "Problem Owner", value: [{ user_key: "owner-b", name: "Owner B" }] });
  const result = await svc.syncFeishuProjectWorkItem(current, {
    config,
    loader: {
      createTask: async () => {
        throw new Error("should not create transferred item");
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "skip");
  assert.equal(result.scopeStatus.state, "transferred");
  assert.equal(result.scopeStatus.transitioned, true);
  assert.deepEqual(result.bookmarks, ["已流转"]);
  assert.match(result.scopeStatus.message, /已流转/);

  const state = db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "owner-role-transfer",
  });
  assert.equal(state.targetTaskId, "tb-owner-role-transfer");
  assert.equal(state.syncStatus, "success");

  const records = svc.listFeishuProjectSyncRecords({
    projectKey: "intelligentspace",
    typeKey: "bug",
    limit: 1000,
    config,
  });
  const record = records.find((row) => row.sourceWorkItemId === "owner-role-transfer");
  assert.equal(record?.scopeStatus?.state, "transferred");
  assert.deepEqual(record?.bookmarks, ["已流转"]);
});

test("sync keeps first-time out-of-scope items separate from transferred mappings", async () => {
  const raw = sampleWorkItem("owner-role-initial-out", "NSCP-18002");
  raw.fields.push({ field_key: "role_owner", field_name: "Problem Owner", value: [{ user_key: "owner-b", name: "Owner B" }] });
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    config: {
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: {
          enabled: true,
          filters: [{
            enabled: true,
            fieldKey: "role_owner",
            fieldName: "Problem Owner",
            operator: "containsAny",
            values: ["Owner A"],
          }],
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "skip");
  assert.equal(result.scopeStatus.state, "initial-out-of-scope");
  assert.equal(result.scopeStatus.transitioned, false);
  assert.deepEqual(result.bookmarks, []);
  assert.equal(db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "owner-role-initial-out",
  }), null);
});

test("source refresh removes stale unsynced records and hides stale synced mappings only for a complete snapshot", async () => {
  const projectKey = "refresh-snapshot-project";
  const typeKey = "bug";
  const pendingId = "refresh-stale-pending";
  const syncedId = "refresh-stale-synced";
  const currentId = "refresh-current";
  const config = {
    feishu: {
      spaceKey: projectKey,
      workItemTypeKey: typeKey,
      sourceViews: [{
        id: "refresh-snapshot-source",
        url: `https://project.feishu.cn/${projectKey}/workObjectView/${typeKey}/refresh-snapshot-view`,
        enabled: true,
        isDefault: true,
      }],
    },
    sync: { includeComments: false, includeAttachments: false, readScope: { enabled: false, filters: [] } },
  };
  db.upsertFeishuProjectSyncSourceRecord({
    sourceProjectKey: projectKey,
    sourceWorkItemTypeKey: typeKey,
    sourceWorkItemId: pendingId,
    sourceProblemNo: "NSCP-19001",
    sourceUpdatedAt: "2026-07-15T00:00:00.000Z",
  });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: projectKey,
    sourceWorkItemTypeKey: typeKey,
    sourceWorkItemId: syncedId,
    sourceProblemNo: "NSCP-19002",
    targetTaskId: "tb-refresh-stale-synced",
    targetUniqueId: "19002",
    sourceUpdatedAt: "2026-07-15T01:00:00.000Z",
    lastSyncedAt: "2026-07-15T02:00:00.000Z",
    syncStatus: "success",
  });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: "refresh-unrelated-project",
    sourceWorkItemTypeKey: "bug_double_eight",
    sourceWorkItemId: "refresh-unrelated-synced",
    sourceProblemNo: "NSCP-19099",
    targetTaskId: "tb-refresh-unrelated-synced",
    lastSyncedAt: "2026-07-15T02:00:00.000Z",
    syncStatus: "success",
  });
  const current = sampleWorkItem(currentId, "NSCP-19003");
  current.space_key = projectKey;
  current.work_item_type_key = typeKey;

  const result = await svc.refreshFeishuProjectSyncSourceRecords({
    config,
    workItems: [current],
    reconcileSnapshot: true,
    snapshotComplete: true,
    limit: 200,
  });

  assert.equal(result.snapshotReconciled, true);
  assert.equal(result.removedUnsynced, 1);
  assert.equal(result.hiddenSynced, 1);
  assert.equal(db.getFeishuProjectSyncState({ sourceProjectKey: projectKey, sourceWorkItemTypeKey: typeKey, sourceWorkItemId: pendingId }), null);
  assert.equal(db.getFeishuProjectSyncState({ sourceProjectKey: projectKey, sourceWorkItemTypeKey: typeKey, sourceWorkItemId: syncedId })?.sourceInScope, false);
  assert.equal(db.getFeishuProjectSyncState({ sourceProjectKey: projectKey, sourceWorkItemTypeKey: typeKey, sourceWorkItemId: currentId })?.sourceInScope, true);
  const unrelated = db.getFeishuProjectSyncState({
    sourceProjectKey: "refresh-unrelated-project",
    sourceWorkItemTypeKey: "bug_double_eight",
    sourceWorkItemId: "refresh-unrelated-synced",
  });
  assert.equal(unrelated?.targetTaskId, "tb-refresh-unrelated-synced");
  assert.notEqual(unrelated?.sourceInScope, false);
  const records = svc.listFeishuProjectSyncRecords({ projectKey, typeKey, limit: 10, config });
  const hidden = records.find((row) => row.sourceWorkItemId === syncedId);
  assert.equal(hidden?.targetTaskId, "tb-refresh-stale-synced");
  assert.equal(hidden?.hidden, true);
  assert.equal(hidden?.scopeStatus?.state, "transferred");
});

test("source refresh does not clean absent records when the captured snapshot may be truncated", async () => {
  const projectKey = "refresh-partial-project";
  const typeKey = "bug";
  const pendingId = "refresh-partial-pending";
  db.upsertFeishuProjectSyncSourceRecord({
    sourceProjectKey: projectKey,
    sourceWorkItemTypeKey: typeKey,
    sourceWorkItemId: pendingId,
    sourceProblemNo: "NSCP-19101",
  });
  const current = sampleWorkItem("refresh-partial-current", "NSCP-19102");
  current.space_key = projectKey;
  current.work_item_type_key = typeKey;
  const result = await svc.refreshFeishuProjectSyncSourceRecords({
    config: { feishu: { spaceKey: projectKey, workItemTypeKey: typeKey }, sync: { readScope: { enabled: false, filters: [] } } },
    workItems: [current],
    reconcileSnapshot: true,
    snapshotComplete: false,
    limit: 200,
  });
  assert.equal(result.snapshotReconciled, false);
  assert.equal(result.removedUnsynced, 0);
  assert.ok(db.getFeishuProjectSyncState({ sourceProjectKey: projectKey, sourceWorkItemTypeKey: typeKey, sourceWorkItemId: pendingId }));
});

test("source refresh does not delete or hide returned out-of-scope records from a partial targeted snapshot", async () => {
  const projectKey = "refresh-targeted-partial-project";
  const typeKey = "bug";
  const pendingId = "refresh-targeted-partial-pending";
  const syncedId = "refresh-targeted-partial-synced";
  const config = {
    feishu: { spaceKey: projectKey, workItemTypeKey: typeKey },
    sync: {
      includeComments: false,
      includeAttachments: false,
      readScope: {
        enabled: true,
        filters: [{
          enabled: true,
          fieldKey: "role_owner",
          fieldName: "Problem Owner",
          operator: "containsAny",
          values: ["Owner A"],
        }],
      },
    },
  };
  db.upsertFeishuProjectSyncSourceRecord({
    sourceProjectKey: projectKey,
    sourceWorkItemTypeKey: typeKey,
    sourceWorkItemId: pendingId,
    sourceProblemNo: "NSCP-19201",
  });
  db.upsertFeishuProjectSyncState({
    sourceProjectKey: projectKey,
    sourceWorkItemTypeKey: typeKey,
    sourceWorkItemId: syncedId,
    sourceProblemNo: "NSCP-19202",
    targetTaskId: "tb-refresh-targeted-partial",
    lastSyncedAt: "2026-07-15T02:00:00.000Z",
    syncStatus: "success",
  });
  const pending = sampleWorkItem(pendingId, "NSCP-19201");
  pending.space_key = projectKey;
  pending.work_item_type_key = typeKey;
  const synced = sampleWorkItem(syncedId, "NSCP-19202");
  synced.space_key = projectKey;
  synced.work_item_type_key = typeKey;

  const result = await svc.refreshFeishuProjectSyncSourceRecords({
    config,
    workItems: [pending, synced],
    reconcileSnapshot: true,
    snapshotComplete: false,
    limit: 200,
  });

  assert.equal(result.snapshotReconciled, false);
  assert.equal(result.removedUnsynced, 0);
  assert.equal(result.hiddenSynced, 0);
  assert.ok(db.getFeishuProjectSyncState({ sourceProjectKey: projectKey, sourceWorkItemTypeKey: typeKey, sourceWorkItemId: pendingId }));
  assert.equal(db.getFeishuProjectSyncState({ sourceProjectKey: projectKey, sourceWorkItemTypeKey: typeKey, sourceWorkItemId: syncedId })?.sourceInScope, true);
});

test("run supports explicit PoC work item ids for dry-run", async () => {
  const seen = [];
  const result = await svc.runFeishuProjectSync({
    dryRun: true,
    checkRemoteExisting: false,
    workItemIds: ["poc-1", "poc-2", "poc-1"],
    client: {
      fetchWorkItemsByIds: async (ids) => {
        seen.push(...ids);
        return ids.map((id) => sampleWorkItem(id, `Title ${id}`));
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.deepEqual(seen, ["poc-1", "poc-2"]);
  assert.deepEqual(result.results.map((r) => r.item.sourceWorkItemId), ["poc-1", "poc-2"]);
  assert.equal(db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "poc-1",
  }), null);
});

test("run supports explicit Feishu problem numbers for dry-run", async () => {
  const queries = [];
  const failIfCalled = [];
  const nscp1 = sampleWorkItem("problem-no-id-1", "Title one");
  nscp1.work_item_no = "NSCP-50101";
  const nscp2 = sampleWorkItem("problem-no-id-2", "Title two");
  nscp2.work_item_no = "NSCP-50102";
  const result = await svc.runFeishuProjectSync({
    dryRun: true,
    checkRemoteExisting: false,
    workItemNos: ["nscp-50101", "NSCP-50102", "NSCP-50101"],
    client: {
      fetchWorkItemsByIds: async (ids) => {
        failIfCalled.push(ids);
        return [];
      },
      fetchWorkItems: async (options = {}) => {
        queries.push(options.query);
        if (options.query === "NSCP-50101") return [nscp1];
        if (options.query === "NSCP-50102") return [nscp2];
        return [];
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(result.requested, 2);
  assert.deepEqual(queries, ["NSCP-50101", "NSCP-50102"]);
  assert.deepEqual(failIfCalled, []);
  assert.deepEqual(result.selection.workItemNos, ["NSCP-50101", "NSCP-50102"]);
  assert.deepEqual(result.results.map((r) => r.item.sourceWorkItemId), ["problem-no-id-1", "problem-no-id-2"]);
  assert.deepEqual(result.results.map((r) => svc.getSourceProblemNo(r.item)), ["NSCP-50101", "NSCP-50102"]);
});

test("run treats problem-shaped workItemIds as Feishu problem numbers", async () => {
  const queries = [];
  const item = sampleWorkItem("legacy-problem-no-id", "Legacy problem no");
  item.work_item_no = "NSCP-50103";
  const result = await svc.runFeishuProjectSync({
    dryRun: true,
    checkRemoteExisting: false,
    workItemIds: ["NSCP-50103"],
    client: {
      fetchWorkItemsByIds: async () => {
        throw new Error("problem numbers should not be fetched as internal ids");
      },
      fetchWorkItems: async (options = {}) => {
        queries.push(options.query);
        return [item];
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.deepEqual(queries, ["NSCP-50103"]);
  assert.deepEqual(result.selection.workItemNos, ["NSCP-50103"]);
  assert.deepEqual(result.selection.workItemIds || [], []);
  assert.equal(result.results[0].item.sourceWorkItemId, "legacy-problem-no-id");
});

test("run stops on first real sync failure by default", async () => {
  const calls = [];
  const events = [];
  const result = await svc.runFeishuProjectSync({
    workItems: [sampleWorkItem("fail-fast-1"), sampleWorkItem("fail-fast-2")],
    config: { sync: { includeComments: false, includeAttachments: false } },
    onProgress: (event) => events.push(event),
    loader: {
      createTask: async () => {
        calls.push("create");
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.total, 1);
  assert.equal(result.requested, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.stoppedOnFirstError, true);
  assert.equal(calls.length, 1);
  assert.ok(events.some((event) => event.phase === "stopped"));
});

test("run can continue after failures when stopOnFirstError is false", async () => {
  const calls = [];
  const result = await svc.runFeishuProjectSync({
    stopOnFirstError: false,
    workItems: [sampleWorkItem("continue-fail-1"), sampleWorkItem("continue-fail-2")],
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async () => {
        calls.push("create");
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.total, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.stoppedOnFirstError, false);
  assert.equal(calls.length, 2);
});

test("Feishu extractor caches token, paginates search, hydrates related data, and retries rate limits", async () => {
  const calls = [];
  let retriedItem2 = false;
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path: pathname, method: init.method, body, headers: init.headers || {} });

    if (pathname === "/token") return jsonResponse({ data: { token: "tok", expire: 3600 } });
    if (pathname === "/fields") {
      return jsonResponse({
        data: {
          items: [
            { field_key: "component", field_name: "Component", field_type: "select" },
          ],
        },
      });
    }
    if (pathname === "/search") {
      if (body.page_token === "p2") {
        return jsonResponse({ data: { items: [{ work_item_id: "item-2" }], has_more: false } });
      }
      return jsonResponse({ data: { items: [{ work_item_id: "item-1" }], next_page_token: "p2", has_more: true } });
    }
    if (pathname === "/detail/item-1") {
      const item = sampleWorkItem("item-1", "First");
      delete item.comments;
      delete item.attachments;
      return jsonResponse({ data: { work_item: item } });
    }
    if (pathname === "/detail/item-2") {
      if (!retriedItem2) {
        retriedItem2 = true;
        return jsonResponse({ code: 429, message: "rate limited" }, 429, { "retry-after": "0" });
      }
      const item = sampleWorkItem("item-2", "Second");
      delete item.comments;
      delete item.attachments;
      return jsonResponse({ data: { work_item: item } });
    }
    if (pathname === "/comments/item-1") return jsonResponse({ data: { comments: [{ comment_id: "c1", content: "comment 1" }] } });
    if (pathname === "/comments/item-2") return jsonResponse({ data: { comments: [{ comment_id: "c2", content: "comment 2" }] } });
    if (pathname === "/attachments/item-1") return jsonResponse({ data: { attachments: [{ file_id: "a1", name: "a1.txt" }] } });
    if (pathname === "/attachments/item-2") return jsonResponse({ data: { attachments: [{ file_id: "a2", name: "a2.txt" }] } });
    return jsonResponse({ message: `unexpected ${pathname}` }, 404);
  };

  const extractor = new svc.FeishuProjectClient({
    feishu: {
      baseUrl: "https://feishu.test",
      pluginId: "plugin-id",
      pluginSecret: "plugin-secret",
      userKey: "user-key",
      tokenPath: "/token",
      searchPathTemplate: "/search",
      detailPathTemplate: "/detail/{workItemId}",
      fieldMetadataPathTemplate: "/fields",
      commentsPathTemplate: "/comments/{workItemId}",
      attachmentsPathTemplate: "/attachments/{workItemId}",
      pageSize: 1,
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, statusCodes: [429], apiCodes: [429] },
      rateLimit: { requestsPerSecond: 0, minIntervalMs: 0 },
    },
    sync: { batchSize: 1 },
  }, { fetchImpl });

  const items = await extractor.fetchWorkItems({ limit: 2, pageSize: 1 });
  assert.equal(items.length, 2);
  assert.equal(items[0].work_item_id, "item-1");
  assert.equal(items[1].work_item_id, "item-2");
  assert.equal(items[0]._fieldMetadata.fields[0].key, "component");
  assert.equal(items[0].comments[0].comment_id, "c1");
  assert.equal(items[0].attachments[0].file_id, "a1");
  assert.equal(calls.filter((c) => c.path === "/token").length, 1);
  assert.equal(calls.filter((c) => c.path === "/search").length, 2);
  assert.equal(calls.filter((c) => c.path === "/detail/item-2").length, 2);
  assert.equal(calls.find((c) => c.path === "/search").headers.Authorization, "Bearer tok");
});

test("MCP default MQL requests Feishu defect description for bug work items", async () => {
  const { captureFeishuProjectMcpItems } = await import("../../features/FeiShuProjects/src/feishu-mcp-client.js");
  const origFetch = globalThis.fetch;
  const toolCalls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const req = init.body ? JSON.parse(init.body) : {};
    if (req.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-03-26" } });
    }
    if (req.method === "notifications/initialized") {
      return jsonResponse({}, 202);
    }
    if (req.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [{
            name: "search_by_mql",
            inputSchema: { type: "object", properties: { mql: { type: "string" } } },
          }],
        },
      });
    }
    if (req.method === "tools/call") {
      toolCalls.push(req.params);
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: JSON.stringify({ data: { rows: [] } }) }] },
      });
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: {} });
  };

  try {
    const result = await captureFeishuProjectMcpItems({
      feishu: {
        spaceKey: "intelligentspace",
        workItemTypeKey: "bug",
        mcp: {
          enabled: true,
          serverUrl: "https://mcp.test",
          token: "mcp-token",
          transport: "http-header",
        },
      },
      sync: { batchSize: 1, readScope: { enabled: false, filters: [] } },
    }, { limit: 1 });

    assert.equal(result.ok, true);
    assert.equal(toolCalls.length, 1);
    assert.match(toolCalls[0].arguments.mql, /`field_ee70e6`/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("MCP capture merges NSCP attachments with related vehicle defect attachments", async () => {
  const { captureFeishuProjectMcpItems } = await import("../../features/FeiShuProjects/src/feishu-mcp-client.js");
  const origFetch = globalThis.fetch;
  const toolCalls = [];
  const mainId = "8050554127";
  const vehicleId = "8050831493";
  globalThis.fetch = async (_url, init = {}) => {
    const req = init.body ? JSON.parse(init.body) : {};
    if (req.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-03-26" } });
    }
    if (req.method === "notifications/initialized") return jsonResponse({}, 202);
    if (req.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            { name: "search_by_mql", inputSchema: { type: "object", properties: { mql: { type: "string" }, project_key: { type: "string" } } } },
            { name: "get_workitem_brief", inputSchema: { type: "object", properties: { url: { type: "string" }, project_key: { type: "string" }, work_item_id: { type: "string" }, fields: { type: "array" }, page_size: { type: "number" }, page_token: { type: "string" } } } },
            { name: "get_download_url", inputSchema: { type: "object", properties: { project_key: { type: "string" }, work_item_id: { type: "string" }, file_url: { type: "string" } } } },
          ],
        },
      });
    }
    if (req.method === "tools/call") {
      toolCalls.push(req.params);
      const name = req.params?.name;
      const args = req.params?.arguments || {};
      if (name === "search_by_mql") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                data: {
                  rows: [{
                    moql_field_list: [
                      { key: "work_item_id", name: "work_item_id", value: { string_value: mainId } },
                      { key: "name", name: "name", value: { string_value: "NSCP-18448" } },
                      { key: "auto_number", name: "auto_number", value: { long_value: 18448 } },
                      { key: "field_0a156d", name: "关联整车缺陷(整车)", value: { key_label_value: { id: vehicleId, name: "E15-EU-18110" } } },
                    ],
                  }],
                },
              }),
            }],
          },
        });
      }
      if (name === "get_workitem_brief") {
        const isVehicle = String(args.work_item_id) === vehicleId;
        return jsonResponse({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                work_item_attribute: {
                  work_item_id: isVehicle ? vehicleId : mainId,
                  work_item_name: isVehicle ? "E15-EU-18110" : "NSCP-18448",
                  owned_project: isVehicle
                    ? { key: "vehicle-project-id", simple_name: "function-avatr", name: "Vehicle Project" }
                    : { key: "main-project-id", simple_name: "intelligentspace", name: "Main Project" },
                  work_item_type: isVehicle
                    ? { key: "vehicle-defect-type", name: "Vehicle Defect" }
                    : { key: "bug", name: "Bug" },
                },
                work_item_fields: isVehicle
                  ? [{
                    key: "field_6d3e2d",
                    name: "附件",
                    value: [{ uid: "vehicle-attachment", name: "vehicle.zip", url: "https://project.feishu.cn/intelligentspace/file/vehicle-attachment" }],
                  }]
                  : [
                    { key: "field_0a156d", name: "关联整车缺陷(整车)", value: { id: vehicleId, name: "E15-EU-18110" } },
                    { key: "field_2cb6f7", name: "附件", value: [{ uid: "nscp-attachment", name: "nscp.log", url: "https://project.feishu.cn/intelligentspace/file/nscp-attachment" }] },
                  ],
                pagination: { has_more: false },
              }),
            }],
          },
        });
      }
      if (name === "get_download_url") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({
                download_url: `https://project.feishu.cn/goapi/v5/platform/file/stream/download/${args.work_item_id}/0`,
                sign: `sign-${args.work_item_id}`,
                is_multipart: false,
              }),
            }],
          },
        });
      }
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: {} });
  };

  try {
    const captured = await captureFeishuProjectMcpItems({
      feishu: {
        spaceKey: "intelligentspace",
        workItemTypeKey: "bug",
        sourceView: { url: "https://project.feishu.cn/intelligentspace/workObjectView/bug/view-id" },
        mcp: { enabled: true, serverUrl: "https://mcp.test", token: "mcp-token", transport: "http-header" },
      },
      sync: { batchSize: 1, includeAttachments: true, readScope: { enabled: false, filters: [] } },
    }, { workItemIds: ["NSCP-18448"], fieldKeys: ["field_0a156d", "field_2cb6f7"], limit: 1 });

    assert.equal(captured.ok, true);
    assert.equal(captured.warning || "", "");
    const item = svc.normalizeFeishuWorkItem(captured.items[0]);
    assert.deepEqual(item.attachments.map((attachment) => attachment.fileName), ["nscp.log", "vehicle.zip"]);
    assert.deepEqual(item.attachments.map((attachment) => attachment.sourceWorkItemId), [mainId, vehicleId]);
    assert.deepEqual(item.attachments.map((attachment) => attachment.sourceProjectKey), ["intelligentspace", "function-avatr"]);
    const downloadCalls = toolCalls.filter((call) => call.name === "get_download_url");
    assert.deepEqual(downloadCalls.map((call) => String(call.arguments.work_item_id)), [mainId, vehicleId]);
    assert.deepEqual(downloadCalls.map((call) => String(call.arguments.project_key)), ["intelligentspace", "function-avatr"]);

    const uploads = [];
    const syncResult = await svc.syncFeishuProjectWorkItem(captured.items[0], {
      checkRemoteExisting: false,
      config: { sync: { includeComments: false, includeAttachments: true, readScope: { enabled: false, filters: [] } } },
      loader: {
        createTask: async () => ({ id: "tb-nscp-18448", uniqueId: 18448 }),
        syncAttachment: async (taskId, attachment) => {
          uploads.push({ taskId, fileName: attachment.fileName, sourceWorkItemId: attachment.sourceWorkItemId });
          return { fileId: `tb-${attachment.id}` };
        },
      },
    });
    assert.equal(syncResult.ok, true);
    assert.deepEqual(uploads.map((row) => row.fileName), ["nscp.log", "vehicle.zip"]);
    assert.ok(uploads.every((row) => row.taskId === "tb-nscp-18448"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("sync is idempotent and updates when source hash changes", async () => {
  const calls = [];
  const loader = {
    createTask: async (payload) => {
      calls.push({ type: "create", payload });
      return { id: "tb-task-1", uniqueId: 1001 };
    },
    updateTask: async (taskId, payload) => {
      calls.push({ type: "update", taskId, payload });
      return { id: taskId, uniqueId: 1001 };
    },
    postComment: async (taskId, content) => {
      calls.push({ type: "comment", taskId, content });
      return { id: "tb-comment-1" };
    },
    syncAttachment: async (taskId, attachment) => {
      calls.push({ type: "attachment", taskId, attachment });
      return { fileId: "tb-file-1" };
    },
  };

  const raw = sampleWorkItem("sync-1");
  const created = await svc.syncFeishuProjectWorkItem(raw, { loader });
  assert.equal(created.ok, true);
  assert.equal(created.action, "create");
  assert.equal(created.targetTaskId, "tb-task-1");
  assert.deepEqual(calls.map((c) => c.type), ["create", "comment", "attachment"]);

  const skipped = await svc.syncFeishuProjectWorkItem(raw, { loader });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.action, "skip");
  assert.deepEqual(calls.map((c) => c.type), ["create", "comment", "attachment"]);

  const updated = await svc.syncFeishuProjectWorkItem(sampleWorkItem("sync-1", "Crash after update"), { loader });
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "update");
  const updateCall = calls.find((c) => c.type === "update");
  assert.equal(updateCall?.taskId, "tb-task-1");

  const state = db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "sync-1",
  });
  assert.equal(state.syncStatus, "success");
  assert.equal(state.targetTaskId, "tb-task-1");
});

test("selective preserve strategy does not re-update when an unmanaged source field changes", async () => {
  const calls = [];
  let createdPayload = null;
  const config = {
    sync: { includeComments: false, includeAttachments: false },
    routing: {
      strategies: [{
        id: "preserve-source-copy",
        name: "保留人工标题与描述",
        fields: {
          title: { enabled: false, mode: "preserve" },
          description: { enabled: false, mode: "preserve" },
        },
      }],
      rules: [{
        id: "preserve-project-copy",
        name: "保留人工维护字段",
        priority: 900,
        conditions: [{ field: "source.projectKey", operator: "equals", values: ["intelligentspace"] }],
        targetId: "legacy-default",
        strategyId: "preserve-source-copy",
      }],
    },
  };
  const loader = {
    createTask: async (payload) => {
      createdPayload = structuredClone(payload);
      calls.push({ type: "create", payload });
      return { id: "tb-policy-preserve-1", uniqueId: 19001 };
    },
    updateTask: async (taskId, payload) => {
      calls.push({ type: "update", taskId, payload });
      return { id: taskId, uniqueId: 19001 };
    },
    getTaskDetail: async () => ({
      ...structuredClone(createdPayload || {}),
      id: "tb-policy-preserve-1",
      uniqueId: 19001,
      content: "Manually maintained TB title",
      note: "Manually maintained TB description",
    }),
  };

  const created = await svc.syncFeishuProjectWorkItem(sampleWorkItem("policy-preserve-1", "Original source title"), { loader, config });
  assert.equal(created.ok, true);
  assert.equal(created.action, "create");
  assert.equal(calls[0].payload.content.includes("Original source title"), true);
  assert.equal(calls[0].payload.note, undefined);

  const unchangedManagedPayload = await svc.syncFeishuProjectWorkItem(sampleWorkItem("policy-preserve-1", "Changed source title"), { loader, config });
  assert.equal(unchangedManagedPayload.ok, true);
  assert.equal(unchangedManagedPayload.action, "skip");
  assert.deepEqual(calls.map((call) => call.type), ["create"]);
});

test("tag merge strategy keeps target tags that were added manually", async () => {
  const calls = [];
  let targetTask = null;
  const config = {
    teambition: { tagIds: ["tag-managed"] },
    sync: { includeComments: false, includeAttachments: false },
    routing: {
      strategies: [{
        id: "merge-target-tags",
        name: "合并目标标签",
        fields: { tags: { enabled: true, mode: "merge" } },
      }],
      rules: [{
        id: "merge-target-tags-rule",
        priority: 850,
        conditions: [{ field: "source.projectKey", operator: "equals", values: ["intelligentspace"] }],
        targetId: "legacy-default",
        strategyId: "merge-target-tags",
      }],
    },
  };
  const loader = {
    createTask: async (payload) => {
      targetTask = { ...structuredClone(payload), id: "tb-policy-tag-merge-1", uniqueId: 19002 };
      calls.push({ type: "create", payload });
      return { id: targetTask.id, uniqueId: targetTask.uniqueId };
    },
    updateTask: async (taskId, payload) => {
      targetTask = { ...targetTask, ...structuredClone(payload), id: taskId };
      calls.push({ type: "update", taskId, payload });
      return { id: taskId, uniqueId: 19002 };
    },
    updateTags: async (taskId, tagIds) => {
      targetTask = { ...targetTask, tagIds: [...tagIds] };
      calls.push({ type: "tags", taskId, tagIds: [...tagIds] });
      return { id: taskId };
    },
    getTaskDetail: async () => structuredClone(targetTask),
  };

  const created = await svc.syncFeishuProjectWorkItem(sampleWorkItem("policy-tag-merge-1", "Tag merge source"), { loader, config });
  assert.equal(created.ok, true);
  assert.deepEqual(calls.find((call) => call.type === "tags")?.tagIds, ["tag-managed"]);

  delete targetTask.tagIds;
  targetTask._tagIds = ["tag-managed", "tag-manual"];
  const updated = await svc.syncFeishuProjectWorkItem(sampleWorkItem("policy-tag-merge-1", "Tag merge source updated"), { loader, config });
  assert.equal(updated.ok, true);
  assert.equal(updated.action, "update");
  assert.deepEqual(calls.filter((call) => call.type === "tags").at(-1).tagIds, ["tag-managed", "tag-manual"]);

  delete targetTask.tagIds;
  delete targetTask._tagIds;
  targetTask.tag_ids = ["tag-managed", "tag-manual", "tag-snake-case"];
  const updatedFromSnakeCaseAlias = await svc.syncFeishuProjectWorkItem(sampleWorkItem("policy-tag-merge-1", "Tag merge source updated again"), { loader, config });
  assert.equal(updatedFromSnakeCaseAlias.ok, true);
  assert.equal(updatedFromSnakeCaseAlias.action, "update");
  assert.deepEqual(calls.filter((call) => call.type === "tags").at(-1).tagIds, ["tag-managed", "tag-manual", "tag-snake-case"]);
});

test("sync accepts nested Teambition task object from create loader result", async () => {
  const calls = [];
  const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("sync-nested-result"), {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async (payload) => {
        calls.push({ type: "create", payload });
        return { result: { task: { _id: "tb-nested-task", uniqueId: 2001 } } };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.targetTaskId, "tb-nested-task");
  assert.equal(calls.length, 1);
});

test("sync accepts Teambition task object from successfulList create result", async () => {
  const calls = [];
  const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("sync-success-list-result"), {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async (payload) => {
        calls.push({ type: "create", payload });
        return { result: { successfulList: [{ id: "tb-success-list-task", uniqueId: 2004 }] } };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.targetTaskId, "tb-success-list-task");
  assert.equal(calls.length, 1);
});

test("sync accepts Teambition task id from taskIds create result", async () => {
  const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("sync-task-ids-result"), {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async () => ({ result: { taskIds: ["tb-taskids-task"], uniqueId: 2005 } }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.targetTaskId, "tb-taskids-task");
});

test("sync state stores Teambition task updatedAt from loader result", async () => {
  const tbUpdatedAt = "2026-07-06T09:30:00.000Z";
  const raw = sampleWorkItem("sync-target-updated-at");
  raw.work_item_no = "NSCP-7704";
  const result = await svc.syncFeishuProjectWorkItem(raw, {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async () => ({ id: "tb-target-updated-at", uniqueId: "CARB-7704", updatedAt: tbUpdatedAt }),
      updateTask: async () => ({ ok: true }),
      getTaskDetail: async () => ({ startDate: "2026-07-03T00:00:00.000Z", dueDate: "" }),
    },
  });
  assert.equal(result.ok, true);
  const state = db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "sync-target-updated-at",
  });
  assert.equal(state.targetUpdatedAt, tbUpdatedAt);
  assert.equal(state.sourceProblemNo, "NSCP-7704");
  assert.equal(state.sourceWorkItemNo, "NSCP-7704");
});

test("sync reports Teambition failedList detail when create returns no task id", async () => {
  const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("sync-create-failed-list"), {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async () => ({ result: { failedList: [{ message: "scenario field invalid" }] } }),
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /scenario field invalid/);
});

test("sync recovers created Teambition task by title when create result has no id", async () => {
  const calls = [];
  const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("sync-recover-create", "Recover by title"), {
    checkRemoteExisting: false,
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async (payload) => {
        calls.push({ type: "create", payload });
        return { ok: true };
      },
      findTaskByContent: async (content) => {
        calls.push({ type: "find", content });
        return { taskId: "tb-recovered-task", uniqueId: 2002, content };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "create");
  assert.equal(result.targetTaskId, "tb-recovered-task");
  assert.deepEqual(calls.map((call) => call.type), ["create", "find"]);
});

test("sync updates remotely existing Teambition task instead of creating duplicate", async () => {
  const calls = [];
  const tbTaskId = "6a4919d885fd6d2f0e3147dd";
  const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("sync-remote-existing", "Remote existing before create"), {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      findTaskByContent: async (content) => {
        calls.push({ type: "find", content });
        return { _id: tbTaskId, uniqueId: 2102, content };
      },
      updateTask: async (taskId, payload) => {
        calls.push({ type: "update", taskId, payload });
        return { id: taskId, uniqueId: 2102 };
      },
      createTask: async () => {
        calls.push({ type: "create" });
        throw new Error("create should not be called when remote task already exists");
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "update");
  assert.equal(result.targetTaskId, tbTaskId);
  assert.deepEqual(calls.map((call) => call.type), ["find", "update"]);
  assert.equal(calls.find((call) => call.type === "update")?.taskId, tbTaskId);
  const state = db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "sync-remote-existing",
  });
  assert.equal(state.syncStatus, "success");
  assert.equal(state.targetTaskId, tbTaskId);
});

test("sync retries missing-id create failure by recovering existing TB task before creating again", async () => {
  const id = "sync-recover-before-create";
  const first = await svc.syncFeishuProjectWorkItem(sampleWorkItem(id, "Recover failed create"), {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async () => ({ ok: true }),
    },
  });
  assert.equal(first.ok, false);
  assert.equal(first.error, "Teambition task id missing from loader result");

  const calls = [];
  const second = await svc.syncFeishuProjectWorkItem(sampleWorkItem(id, "Recover failed create"), {
    config: { sync: { includeComments: false, includeAttachments: false } },
    loader: {
      createTask: async () => {
        calls.push({ type: "create" });
        throw new Error("create should not be called after missing-id recovery");
      },
      findTaskByContent: async (content) => {
        calls.push({ type: "find", content });
        return { _id: "tb-recovered-before-create", uniqueId: 2003, content };
      },
    },
  });

  assert.equal(second.ok, true);
  assert.equal(second.action, "create");
  assert.equal(second.targetTaskId, "tb-recovered-before-create");
  assert.deepEqual(calls.map((call) => call.type), ["find"]);
});

test("M3 default loader creates task, updates custom fields, comments, and attachment link fallback", async () => {
  const origFetch = globalThis.fetch;
  const calls = [];
  const current = cfg.getConfig();
  cfg.updateConfig({
    teambition: {
      ...(current.teambition || {}),
      appId: "tb-app",
      appSecret: "tb-secret",
      orgId: "tb-org",
      operatorId: "tb-operator",
    },
    feishuProjectSync: {
      ...(current.feishuProjectSync || {}),
      teambition: {
        ...(current.feishuProjectSync?.teambition || {}),
        writeCustomFieldsAfterCreate: true,
        commentPathTemplate: "/api/v3/task/{taskId}/comment",
      },
      sync: {
        ...(current.feishuProjectSync?.sync || {}),
        includeComments: true,
        includeAttachments: true,
        attachmentMode: "comment_link",
        failOnCommentError: true,
        failOnAttachmentError: true,
        verifyWrittenTargetFields: false,
      },
    },
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, method: init.method, body, headers: init.headers || {} });
    if (u.pathname === "/api/appToken") return jsonResponse({ appToken: "tb-token", expire: 3600 });
    if (u.pathname === "/api/v3/task/create") return jsonResponse({ result: { id: "tb-m3-task", uniqueId: 3003 } });
    if (u.pathname === "/api/v3/task/tb-m3-task/tag") return jsonResponse({ result: { tagIds: body?.tagIds || [] } });
    if (u.pathname === "/api/v3/task/tb-m3-task/customfield/update") return jsonResponse({ result: { id: "customfield-ok" } });
    if (u.pathname === "/api/v3/task/tb-m3-task/comment") {
      const n = calls.filter((c) => c.path === "/api/v3/task/tb-m3-task/comment").length;
      return jsonResponse({ result: { id: `tb-comment-${n}` } });
    }
    return jsonResponse({ code: 404, message: `unexpected ${u.pathname}` }, 404);
  };

  try {
    const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("m3-default-loader"));
    assert.equal(result.ok, true);
    assert.equal(result.action, "create");
    assert.equal(result.targetTaskId, "tb-m3-task");

    const createCall = calls.find((c) => c.path === "/api/v3/task/create");
    assert.equal(createCall.body.projectId, "tb-project");
    assert.equal(createCall.body.executorId, "tb-default-user");
    assert.deepEqual(createCall.body.involveMembers.sort(), ["tb-dev", "tb-qa"]);
    assert.equal(createCall.body.tasklistId, "tb-list");
    assert.equal(createCall.body.stageId, "tb-stage");
    assert.equal(createCall.body.taskflowstatusId, "tb-open-status");

    const customFieldsCall = calls.find((c) => c.path === "/api/v3/task/tb-m3-task/customfield/update" && c.body.customfieldId === "cf-component");
    assert.deepEqual(customFieldsCall.body.value, [{ title: "Media" }]);
    assert.equal(customFieldsCall.headers["X-Operator-Id"], "tb-default-user");
    const createdComponent = createCall.body.customfields.find((field) => field.cfId === "cf-component");
    assert.deepEqual(createdComponent.value, [{ title: "Media" }]);

    const commentCalls = calls.filter((c) => c.path === "/api/v3/task/tb-m3-task/comment");
    assert.equal(commentCalls.length, 2);
    assert.match(commentCalls[0].body.content, /Feishu comment from QA/);
    assert.match(commentCalls[1].body.content, /Feishu attachment/);
    assert.match(commentCalls[1].body.content, /https:\/\/files\.example\/log\.txt/);
    assert.equal(commentCalls[1].headers.Authorization, "Bearer tb-token");
    assert.equal(commentCalls[1].headers["X-Tenant-Id"], "tb-org");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("M3 loader propagates comment errors to main sync state", async () => {
  const current = cfg.getConfig();
  cfg.updateConfig({
    feishuProjectSync: {
      ...(current.feishuProjectSync || {}),
      sync: {
        ...(current.feishuProjectSync?.sync || {}),
        includeComments: true,
        includeAttachments: false,
        failOnCommentError: true,
      },
    },
  });
  const loader = {
    createTask: async () => ({ id: "tb-m3-failed-task", uniqueId: 3004 }),
    postComment: async () => {
      throw new Error("comment API down");
    },
  };

  const result = await svc.syncFeishuProjectWorkItem(sampleWorkItem("m3-comment-fail"), { loader });
  assert.equal(result.ok, false);
  assert.equal(result.targetTaskId, "tb-m3-failed-task");
  assert.match(result.error, /comment API down/);
  assert.deepEqual(result.failures.map((f) => f.stage), ["comment"]);

  const state = db.getFeishuProjectSyncState({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "m3-comment-fail",
  });
  assert.equal(state.syncStatus, "failed");
  assert.equal(state.targetTaskId, "tb-m3-failed-task");
  assert.match(state.lastError, /comment API down/);
});

test("M4 persists raw payloads and retries nonfatal comment errors without duplicating task", async () => {
  const current = cfg.getConfig();
  cfg.updateConfig({
    feishuProjectSync: {
      ...(current.feishuProjectSync || {}),
      sync: {
        ...(current.feishuProjectSync?.sync || {}),
        includeComments: true,
        includeAttachments: false,
        failOnCommentError: false,
      },
    },
  });

  const calls = [];
  let commentAttempts = 0;
  const loader = {
    createTask: async (payload) => {
      calls.push({ type: "create", payload });
      return { id: "tb-m4-comment-task", uniqueId: 4001 };
    },
    updateTask: async (taskId, payload) => {
      calls.push({ type: "update", taskId, payload });
      return { id: taskId, uniqueId: 4001 };
    },
    postComment: async (taskId, content) => {
      commentAttempts++;
      calls.push({ type: "comment", taskId, content, attempt: commentAttempts });
      if (commentAttempts === 1) throw new Error("temporary comment failure");
      return { id: "tb-m4-comment-1" };
    },
  };

  const raw = sampleWorkItem("m4-comment-retry");
  const first = await svc.syncFeishuProjectWorkItem(raw, { loader });
  assert.equal(first.ok, true);
  assert.equal(first.action, "create");
  assert.deepEqual(calls.map((c) => c.type), ["create", "comment"]);

  const failedComment = db.getFeishuProjectCommentSync({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "m4-comment-retry",
    sourceCommentId: "fc1",
  });
  assert.equal(failedComment.syncStatus, "failed");
  assert.equal(failedComment.retryCount, 1);
  assert.match(failedComment.lastError, /temporary comment failure/);

  const retryableBefore = db.listFeishuProjectRetryableSyncErrors({
    workItemId: "m4-comment-retry",
    stage: "comment",
  });
  assert.equal(retryableBefore.length, 1);
  assert.equal(retryableBefore[0].errorStatus, "open");
  assert.equal(retryableBefore[0].retryCount, 1);

  const second = await svc.syncFeishuProjectWorkItem(raw, { loader });
  assert.equal(second.ok, true);
  assert.equal(second.action, "sync-children");
  assert.deepEqual(calls.map((c) => c.type), ["create", "comment", "comment"]);

  const syncedComment = db.getFeishuProjectCommentSync({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "m4-comment-retry",
    sourceCommentId: "fc1",
  });
  assert.equal(syncedComment.syncStatus, "success");
  assert.equal(syncedComment.targetCommentId, "tb-m4-comment-1");
  assert.equal(syncedComment.retryCount, 0);

  const retryableAfter = db.listFeishuProjectRetryableSyncErrors({
    workItemId: "m4-comment-retry",
    stage: "comment",
  });
  assert.equal(retryableAfter.length, 0);
  const resolved = db.listFeishuProjectSyncErrors({
    workItemId: "m4-comment-retry",
    stage: "comment",
    status: "resolved",
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].retryable, false);

  const payloads = db.listFeishuProjectRawPayloads({
    workItemId: "m4-comment-retry",
  });
  assert.equal(payloads.length, 2);
  assert.match(payloads[0].payloadJson, /m4-comment-retry/);
});

test("M4 retries attachment sync once and dedupes successful attachments on rerun", async () => {
  const current = cfg.getConfig();
  cfg.updateConfig({
    feishuProjectSync: {
      ...(current.feishuProjectSync || {}),
      sync: {
        ...(current.feishuProjectSync?.sync || {}),
        includeComments: false,
        includeAttachments: true,
        failOnAttachmentError: false,
      },
    },
  });

  const calls = [];
  let attachmentAttempts = 0;
  const loader = {
    createTask: async () => {
      calls.push({ type: "create" });
      return { id: "tb-m4-attachment-task", uniqueId: 4002 };
    },
    updateTask: async (taskId) => {
      calls.push({ type: "update", taskId });
      return { id: taskId, uniqueId: 4002 };
    },
    syncAttachment: async (taskId, attachment) => {
      attachmentAttempts++;
      calls.push({ type: "attachment", taskId, attachment, attempt: attachmentAttempts });
      if (attachmentAttempts === 1) throw new Error("temporary attachment failure");
      return { fileId: "tb-m4-file-1" };
    },
  };

  const raw = sampleWorkItem("m4-attachment-retry");
  const first = await svc.syncFeishuProjectWorkItem(raw, { loader });
  assert.equal(first.ok, true);
  assert.equal(first.action, "create");

  const second = await svc.syncFeishuProjectWorkItem(raw, { loader });
  assert.equal(second.ok, true);
  assert.equal(second.action, "sync-children");

  const third = await svc.syncFeishuProjectWorkItem(raw, { loader });
  assert.equal(third.ok, true);
  assert.equal(third.action, "skip");
  assert.deepEqual(calls.map((c) => c.type), ["create", "attachment", "attachment"]);

  const syncedAttachment = db.getFeishuProjectAttachmentSync({
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "m4-attachment-retry",
    sourceAttachmentId: "fa1",
  });
  assert.equal(syncedAttachment.syncStatus, "success");
  assert.equal(syncedAttachment.targetFileId, "tb-m4-file-1");
  assert.equal(syncedAttachment.retryCount, 0);

  const attachments = db.listFeishuProjectAttachmentSync({
    workItemId: "m4-attachment-retry",
    status: "success",
  });
  assert.equal(attachments.length, 1);
});

test("M5 API routes expose reconcile/backfill and guard write endpoints", async () => {
  const { createFeishuProjectSyncRouter } = await import("../../features/FeiShuProjects/src/gateway-route.js");
  const calls = [];
  const router = createFeishuProjectSyncRouter({
    Router: express.Router,
    verifyToken: (token) => (token === "admin-token" ? { role: "admin", name: "Admin" } : null),
    listFeishuProjectSyncErrors: () => [],
    listFeishuProjectRawPayloads: () => [],
    listFeishuProjectCommentSync: () => [],
    listFeishuProjectAttachmentSync: () => [],
    listFeishuProjectRetryableErrors: () => [],
    readFilterPreset: () => ({
      updatedAt: "2026-07-18T00:00:00.000Z",
      readScope: { enabled: true, match: "all", filters: [] },
      requiredAssigneeKeywords: [],
    }),
    saveFilterPreset: (payload) => {
      calls.push({ type: "filter-preset", payload });
      return { ...payload, updatedAt: "2026-07-18T00:01:00.000Z" };
    },
    runSync: async (options) => {
      calls.push({ type: "run", options });
      const eventCount = Number(options.limit) === 150 ? 150 : 0;
      for (let i = 0; i < eventCount; i += 1) {
        options.onProgress?.({
          phase: "progress",
          message: `event ${i + 1}`,
          index: i + 1,
          total: eventCount,
        });
      }
      const results = (options.workItems || []).map((workItem) => {
        const emptyOldNote = workItem.work_item_id === "m5-empty-note-preview";
        const oldNote = emptyOldNote ? "" : "原 TB 备注\n第二行说明";
        const problemText = [
          workItem.sourceProblemNo,
          workItem.sourceWorkItemNo,
          workItem.problemNo,
          workItem.workItemNo,
          workItem.work_item_no,
          workItem.title,
          workItem.work_item_name,
          ...(workItem.fields || []).flatMap((field) => [field?.value, field?.display_value, field?.text]),
        ].map((value) => String(value || "")).join(" ");
        const problemNo = problemText.match(/[A-Z][A-Z0-9]+-\d+/i)?.[0]?.toUpperCase() || "";
        const sheetOverride = problemNo ? options.sheetTargetByProblemNo?.[problemNo] : null;
        return {
          ok: true,
          dryRun: !!options.dryRun,
          action: "update",
          item: workItem,
          payload: {
            note: `\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`,
            tasklistId: "695a01be8cebcce71bb08e59",
            tasklistIdDisplay: "\u963f\u7ef4\u5854_8678\u5e73\u53f0_S\u5e94\u7528",
            applicationCategory: "S",
            applicationCategoryCustomFieldId: "cf-app-category",
            defectCategory: "\u529f\u80fd\u4f7f\u7528BUG",
            defectCategoryCustomFieldId: "cf-defect-category",
          },
          targetFieldVerification: {
            checked: true,
            mismatch: true,
            targetTaskId: "tb-nscp-17320-preview",
            mismatches: [{
              field: "note",
              actual: oldNote,
              actualDisplay: emptyOldNote ? "空" : undefined,
              expected: `\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`,
            }],
            task: { note: oldNote, uniqueId: "13036" },
            noteRead: { attempted: true, ok: true, empty: emptyOldNote, markdownLength: oldNote.length },
          },
          existing: sheetOverride ? {
            targetTaskId: sheetOverride.targetTaskId,
            targetUniqueId: sheetOverride.targetUniqueId,
            syncStatus: "sheet-target",
            sheetTargetOverride: true,
            sheetTargetDisplayId: sheetOverride.targetDisplayId,
            sheetTargetRow: sheetOverride.sheetTargetRow,
            sheetTargetColumns: sheetOverride.sheetTargetColumns,
          } : undefined,
        };
      });
      return { ok: true, dryRun: !!options.dryRun, total: results.length, results };
    },
    backfillSync: async (options) => {
      calls.push({ type: "backfill", options });
      return { ok: true, mode: "backfill", selected: { workItemIds: options.workItemIds || [] }, result: { ok: true } };
    },
    reconcileSync: (query) => ({ summary: { sourceRecordCount: 0 }, query }),
    detectDuplicates: async (options) => {
      calls.push({ type: "duplicates-check", options });
      return { ok: true, hasDuplicates: false, duplicates: [], inspected: options.workItems?.length || 0 };
    },
    mergeDuplicates: async (body) => {
      calls.push({ type: "duplicates-merge", body });
      return { ok: true, targetTaskId: body.targetTaskId };
    },
    previewSheetUpdates: async (syncResult, options) => {
      if (syncResult?.needLogin) {
        const err = new Error("Feishu sheet preview login required");
        err.needLogin = true;
        err.finalUrl = "https://accounts.feishu.cn/preview-login";
        err.targetUrl = "https://hcn8isyrecyp.feishu.cn/sheets/preview";
        err.profileDir = "gateway/.tmp/feishu-project-web-profile";
        throw err;
      }
      calls.push({ type: "sheet-preview", syncResult, options });
      return { ok: true, updateCount: 1, items: [{ action: "新增" }], warnings: [] };
    },
    applySheetUpdates: async (plan, options) => {
      calls.push({ type: "sheet-apply", plan, options });
      if (plan?.needLogin) {
        const err = new Error("Feishu sheet login required");
        err.needLogin = true;
        err.finalUrl = "https://accounts.feishu.cn/login";
        err.targetUrl = "https://hcn8isyrecyp.feishu.cn/sheets/test";
        err.profileDir = "gateway/.tmp/feishu-project-web-profile";
        throw err;
      }
      return { ok: true, applied: plan.items?.length || 0 };
    },
    resolveTbTask: async (query) => {
      calls.push({ type: "tb-resolve", query });
      const uniqueId = String(query || "").match(/\d+/)?.[0] || "";
      return {
        _id: `tb-${uniqueId}`,
        uniqueId: uniqueId ? Number(uniqueId) : "",
        content: `Task ${query}`,
        updatedAt: "2026-07-08T01:00:00.000Z",
      };
    },
    getMcpStatus: async () => ({ configured: true, connected: true, authorizationUrl: "https://accounts.feishu.cn/oauth/authorize?client_id=test", toolCount: 1, tools: [{ name: "list_work_items" }] }),
    openSystemUrl: async (url) => {
      calls.push({ type: "open-system-url", url });
      return { opened: true, url, opener: "test" };
    },
    getWebStatus: async (options) => {
      calls.push({ type: "web-status", options });
      return {
        valid: !options.passive || !!options.allowActivePageRead,
        homepageUrl: options.url || "https://project.feishu.cn/intelligentspace/bug/homepage",
        reason: options.passive && !options.allowActivePageRead ? "passive skip" : "",
        passive: !!options.passive,
        activePageRead: !!options.allowActivePageRead,
        skippedBrowserLaunch: !!options.passive && !options.allowActivePageRead,
      };
    },
    listTbProjects: async () => [{ id: "tb-route-project", name: "Route Test Project" }],
    listTbTasklists: async (projectId) => [
      { id: "tb-route-tasklist", name: "Route Tasklist", projectId },
    ],
    listTbSprints: async (projectId) => [
      { id: "tb-route-sprint", name: "Ava_应用市场_8678_待规划", projectId, status: "active", dueDate: "2026-07-10" },
    ],
    listTbMembers: async ({ q }) => [
      { uid: "tb-xu-bochao", name: `徐博超-${q || "all"}` },
    ],
    captureMcpItems: async (captureConfig, options) => {
      calls.push({ type: "mcp-capture", options, config: captureConfig });
      const requestedNos = [
        ...(Array.isArray(options.workItemNos) ? options.workItemNos : []),
        options.workItemNo,
      ].map((value) => String(value || "").trim()).filter(Boolean);
      const adaptiveWeakItem = requestedNos.includes("NSCP-17320")
        ? sampleWorkItem("mcp-route-weak", "NSCP-17320 MCP weak preview")
        : null;
      return {
        ok: true,
        source: "feishu-mcp",
        total: 1,
        items: [adaptiveWeakItem || sampleWorkItem("mcp-route", "MCP route preview")],
        tool: { name: "list_work_items" },
        effectiveTransport: "http-header",
      };
    },
    captureWebItems: async (options) => {
      calls.push({ type: "web-capture", options });
      const webItem = sampleWorkItem("7035552490", "NSCP-17320 web detail");
      webItem.fields.push({
        field_key: "field_ee70e6",
        field_name: "\u7f3a\u9677\u63cf\u8ff0",
        value: NSCP_17320_DEFECT_DESCRIPTION,
      });
      return {
        ok: true,
        total: 1,
        finalUrl: options.url || "https://project.feishu.cn/intelligentspace/bug/homepage",
        items: [webItem],
        source: { detailItems: 1, requestedDetailItems: options.workItemIds?.length || 0 },
      };
    },
    syncWorkItem: async (workItem, options) => {
      calls.push({ type: "web-sync-work-item", workItem, options });
      const item = svc.normalizeFeishuWorkItem(workItem, {
        sync: { readScope: { enabled: false, filters: [] } },
      });
      return {
        ok: true,
        dryRun: !!options.dryRun,
        action: "update",
        item,
        payload: {
          note: `\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`,
        },
        targetFieldVerification: {
          checked: true,
          mismatch: true,
          targetTaskId: "tb-nscp-17320-web",
          mismatches: [{
            field: "note",
            actual: "old TB note",
            expected: `\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`,
          }],
          task: { note: "old TB note", uniqueId: "13036" },
        },
      };
    },
    handleWebhook: async (body) => {
      calls.push({ type: "webhook", body });
      return { accepted: true, mode: "test" };
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/feishu-project-sync", router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/feishu-project-sync`;
  const adminHeaders = { "Content-Type": "application/json", Authorization: "Bearer admin-token" };
  const current = cfg.getConfig();
  cfg.updateConfig({
    feishuProjectSync: {
      ...(current.feishuProjectSync || {}),
      enabled: true,
      feishu: {
        ...(current.feishuProjectSync?.feishu || {}),
        pluginSecret: "route-plugin-secret",
        userKey: "route-user-key",
      },
      sync: { ...(current.feishuProjectSync?.sync || {}), webhookSecret: "hook-secret" },
    },
  });

  try {
    const status = await fetch(`${base}/status`).then((r) => r.json());
    assert.equal(status.success, true);

    const reconcile = await fetch(`${base}/reconcile?limit=3`).then((r) => r.json());
    assert.equal(reconcile.success, true);
    assert.equal(reconcile.data.query.limit, 3);

    const mcpStatus = await fetch(`${base}/mcp-status`).then((r) => r.json());
    assert.equal(mcpStatus.success, true);
    assert.equal(mcpStatus.data.connected, true);

    const deniedMcpOpen = await fetch(`${base}/mcp-open-authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(deniedMcpOpen.status, 403);

    const mcpOpen = await fetch(`${base}/mcp-open-authorization`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({}),
    }).then((r) => r.json());
    assert.equal(mcpOpen.success, true);
    assert.equal(mcpOpen.data.opened, true);
    assert.equal(calls.at(-1).type, "open-system-url");
    assert.match(calls.at(-1).url, /^https:\/\/accounts\.feishu\.cn\/oauth\/authorize/);

    const webStatusDefault = await fetch(`${base}/web-status`).then((r) => r.json());
    assert.equal(webStatusDefault.success, true);
    assert.equal(webStatusDefault.data.passive, true);
    assert.equal(webStatusDefault.data.skippedBrowserLaunch, true);
    assert.equal(calls.at(-1).type, "web-status");
    assert.equal(calls.at(-1).options.passive, true);
    assert.equal(calls.at(-1).options.allowActivePageRead, false);

    const webStatusActiveOnly = await fetch(`${base}/web-status?activeOnly=1`).then((r) => r.json());
    assert.equal(webStatusActiveOnly.success, true);
    assert.equal(webStatusActiveOnly.data.passive, true);
    assert.equal(webStatusActiveOnly.data.activePageRead, true);
    assert.equal(webStatusActiveOnly.data.skippedBrowserLaunch, false);
    assert.equal(calls.at(-1).type, "web-status");
    assert.equal(calls.at(-1).options.passive, true);
    assert.equal(calls.at(-1).options.allowActivePageRead, true);

    const webStatusActive = await fetch(`${base}/web-status?passive=0`).then((r) => r.json());
    assert.equal(webStatusActive.success, true);
    assert.equal(webStatusActive.data.passive, false);
    assert.equal(webStatusActive.data.valid, true);
    assert.equal(calls.at(-1).type, "web-status");
    assert.equal(calls.at(-1).options.passive, false);
    assert.equal(calls.at(-1).options.allowActivePageRead, false);

    const deniedProjects = await fetch(`${base}/tb-projects`);
    assert.equal(deniedProjects.status, 403);

    const tbProjects = await fetch(`${base}/tb-projects`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    assert.equal(tbProjects.success, true);
    assert.equal(tbProjects.data.projects[0].id, "tb-route-project");

    const deniedTasklists = await fetch(`${base}/tb-tasklists?projectId=tb-route-project`);
    assert.equal(deniedTasklists.status, 403);

    const tbTasklists = await fetch(`${base}/tb-tasklists?projectId=tb-route-project&projectName=${encodeURIComponent("Route Test Project")}`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    assert.equal(tbTasklists.success, true);
    assert.equal(tbTasklists.data.projectId, "tb-route-project");
    assert.equal(tbTasklists.data.tasklists[0].id, "tb-route-tasklist");
    assert.equal(tbTasklists.data.tasklists[0].pathName, "Route Test Project / Route Tasklist");

    const deniedTargetOptions = await fetch(`${base}/tb-target-options`);
    assert.equal(deniedTargetOptions.status, 403);

    const tbTargetOptions = await fetch(`${base}/tb-target-options`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    assert.equal(tbTargetOptions.success, true);
    assert.equal(tbTargetOptions.data.options[0].id, "tb-route-tasklist");
    assert.equal(tbTargetOptions.data.options[0].projectId, "tb-route-project");
    assert.equal(tbTargetOptions.data.options[0].pathName, "Route Test Project / Route Tasklist");

    const deniedSprints = await fetch(`${base}/tb-sprints?projectId=tb-route-project`);
    assert.equal(deniedSprints.status, 403);

    const tbSprints = await fetch(`${base}/tb-sprints?projectId=tb-route-project`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    assert.equal(tbSprints.success, true);
    assert.equal(tbSprints.data.projectId, "tb-route-project");
    assert.equal(tbSprints.data.sprints[0].id, "tb-route-sprint");
    assert.equal(tbSprints.data.sprints[0].name, "Ava_应用市场_8678_待规划");

    const deniedMembers = await fetch(`${base}/tb-members?q=${encodeURIComponent("徐博超")}`);
    assert.equal(deniedMembers.status, 403);

    const tbMembers = await fetch(`${base}/tb-members?q=${encodeURIComponent("徐博超")}`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    assert.equal(tbMembers.success, true);
    assert.equal(tbMembers.data.members[0].id, "tb-xu-bochao");
    assert.match(tbMembers.data.members[0].name, /徐博超/);

    const deniedDuplicateCheck = await fetch(`${base}/duplicates/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "mcp", limit: 1 }),
    });
    assert.equal(deniedDuplicateCheck.status, 403);

    const duplicateCheck = await fetch(`${base}/duplicates/check`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ source: "mcp", limit: 1 }),
    }).then((r) => r.json());
    assert.equal(duplicateCheck.success, true);
    assert.equal(duplicateCheck.data.hasDuplicates, false);
    assert.equal(duplicateCheck.data.captured.selected, 1);
    const duplicateCheckCall = calls.findLast((call) => call.type === "duplicates-check");
    assert.equal(duplicateCheckCall.options.workItems.length, 1);
    assert.equal(duplicateCheckCall.options.workItems[0].work_item_id, "mcp-route");

    const duplicateMerge = await fetch(`${base}/duplicates/merge`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        sourceId: "intelligentspace/bug/route-dup",
        targetTaskId: "tb-route-target",
        duplicateTaskIds: ["tb-route-target", "tb-route-old"],
      }),
    }).then((r) => r.json());
    assert.equal(duplicateMerge.success, true);
    assert.equal(duplicateMerge.data.targetTaskId, "tb-route-target");
    assert.equal(calls.at(-1).type, "duplicates-merge");

    const deniedSheetPreview = await fetch(`${base}/sheet/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncResult: { results: [] } }),
    });
    assert.equal(deniedSheetPreview.status, 403);

    const sheetPreview = await fetch(`${base}/sheet/preview`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ syncResult: { ok: true, results: [] }, readSheet: false }),
    }).then((r) => r.json());
    assert.equal(sheetPreview.success, true);
    assert.equal(sheetPreview.data.updateCount, 1);
    assert.equal(calls.at(-1).type, "sheet-preview");
    assert.equal(calls.at(-1).options.readSheet, false);

    const sheetPreviewNeedLoginResp = await fetch(`${base}/sheet/preview`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ syncResult: { ok: true, needLogin: true }, readSheet: true }),
    });
    assert.equal(sheetPreviewNeedLoginResp.status, 401);
    const sheetPreviewNeedLogin = await sheetPreviewNeedLoginResp.json();
    assert.equal(sheetPreviewNeedLogin.success, false);
    assert.equal(sheetPreviewNeedLogin.needLogin, true);
    assert.match(sheetPreviewNeedLogin.error, /Feishu sheet preview login required/);
    assert.equal(sheetPreviewNeedLogin.data.finalUrl, "https://accounts.feishu.cn/preview-login");
    assert.equal(sheetPreviewNeedLogin.data.targetUrl, "https://hcn8isyrecyp.feishu.cn/sheets/preview");
    assert.equal(sheetPreviewNeedLogin.data.profileDir, "gateway/.tmp/feishu-project-web-profile");

    const sheetApply = await fetch(`${base}/sheet/apply`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ plan: { items: [{ action: "新增" }] } }),
    }).then((r) => r.json());
    assert.equal(sheetApply.success, true);
    assert.equal(sheetApply.data.applied, 1);
    assert.equal(calls.at(-1).type, "sheet-apply");

    const sheetApplyNeedLoginResp = await fetch(`${base}/sheet/apply`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ plan: { needLogin: true, items: [{ action: "鏂板" }] } }),
    });
    assert.equal(sheetApplyNeedLoginResp.status, 401);
    const sheetApplyNeedLogin = await sheetApplyNeedLoginResp.json();
    assert.equal(sheetApplyNeedLogin.success, false);
    assert.equal(sheetApplyNeedLogin.needLogin, true);
    assert.match(sheetApplyNeedLogin.error, /Feishu sheet login required/);
    assert.equal(sheetApplyNeedLogin.data.finalUrl, "https://accounts.feishu.cn/login");
    assert.equal(sheetApplyNeedLogin.data.targetUrl, "https://hcn8isyrecyp.feishu.cn/sheets/test");
    assert.equal(sheetApplyNeedLogin.data.profileDir, "gateway/.tmp/feishu-project-web-profile");

    db.upsertFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-empty",
      sourceProblemNo: "NSCP-71001",
      sourceWorkItemNo: "NSCP-71001",
      syncStatus: "pending",
    });
    const sheetMappingFill = await fetch(`${base}/sheet/mapping/check`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        rows: [{ "系统单号": "NSCP-71001", "钉钉单号": "CARB-71001" }],
      }),
    }).then((r) => r.json());
    assert.equal(sheetMappingFill.success, true);
    assert.equal(sheetMappingFill.data.appliedCount, 1);
    assert.equal(sheetMappingFill.data.hasConflicts, false);
    const filledMapping = db.getFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-empty",
    });
    assert.equal(filledMapping.targetTaskId, "tb-71001");
    assert.equal(filledMapping.targetUniqueId, "71001");
    assert.equal(filledMapping.syncStatus, "pending");

    db.upsertFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-single-no",
      sourceProblemNo: "NSCP-71004",
      sourceWorkItemNo: "NSCP-71004",
      syncStatus: "pending",
    });
    db.upsertFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-single-other",
      sourceProblemNo: "NSCP-71005",
      sourceWorkItemNo: "NSCP-71005",
      syncStatus: "pending",
    });
    const singleNoSheetMapping = await fetch(`${base}/sheet/mapping/check`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        workItemNos: ["NSCP-71004"],
        rows: [
          { "系统单号": "NSCP-71004", "钉钉单号": "CARB-71004" },
          { "系统单号": "NSCP-71005", "钉钉单号": "CARB-71005" },
        ],
      }),
    }).then((r) => r.json());
    assert.equal(singleNoSheetMapping.success, true);
    assert.equal(singleNoSheetMapping.data.checked, 1);
    assert.equal(singleNoSheetMapping.data.updates[0].sourceWorkItemNo, "NSCP-71004");
    assert.equal(db.getFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-single-no",
    }).targetTaskId, "tb-71004");
    assert.equal(db.getFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-single-other",
    }).targetTaskId, "");

    db.upsertFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-conflict",
      sourceProblemNo: "NSCP-71002",
      sourceWorkItemNo: "NSCP-71002",
      targetTaskId: "tb-current-71002",
      targetUniqueId: "71002",
      syncStatus: "success",
    });
    const sheetMappingConflict = await fetch(`${base}/sheet/mapping/check`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        rows: [{ "系统单号": "NSCP-71002", "钉钉单号": "CARB-71003" }],
      }),
    }).then((r) => r.json());
    assert.equal(sheetMappingConflict.success, true);
    assert.equal(sheetMappingConflict.data.hasConflicts, true);
    assert.equal(sheetMappingConflict.data.conflicts[0].sourceWorkItemNo, "NSCP-71002");
    assert.equal(sheetMappingConflict.data.conflicts[0].currentTargetDisplayId, "CARB-71002");
    assert.equal(sheetMappingConflict.data.conflicts[0].sheetTargetDisplayId, "CARB-71003");

    const sheetMappingResolve = await fetch(`${base}/sheet/mapping/resolve`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        rows: [{ "系统单号": "NSCP-71002", "钉钉单号": "CARB-71003" }],
        selections: [{ sourceWorkItemNo: "NSCP-71002", choice: "sheet" }],
      }),
    }).then((r) => r.json());
    assert.equal(sheetMappingResolve.success, true);
    assert.equal(sheetMappingResolve.data.hasConflicts, false);
    assert.equal(sheetMappingResolve.data.appliedCount, 1);
    const resolvedMapping = db.getFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-sheet-conflict",
    });
    assert.equal(resolvedMapping.targetTaskId, "tb-71003");
    assert.equal(resolvedMapping.targetUniqueId, "71003");
    assert.equal(resolvedMapping.syncStatus, "pending");

    db.upsertFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-clear-all",
      sourceProblemNo: "NSCP-71999",
      sourceWorkItemNo: "NSCP-71999",
      targetTaskId: "tb-route-clear",
      targetUniqueId: "71999",
      syncStatus: "success",
    });
    db.upsertFeishuProjectCommentSync({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-clear-all",
      sourceCommentId: "route-clear-comment",
      targetTaskId: "tb-route-clear",
      targetCommentId: "tb-route-clear-comment",
      sourcePayloadHash: "comment-hash",
      syncStatus: "success",
    });
    db.upsertFeishuProjectAttachmentSync({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-clear-all",
      sourceAttachmentId: "route-clear-attachment",
      targetTaskId: "tb-route-clear",
      targetFileId: "tb-route-clear-file",
      sourcePayloadHash: "attachment-hash",
      syncStatus: "success",
    });
    db.upsertFeishuProjectSyncError({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "route-clear-all",
      targetTaskId: "tb-route-clear",
      stage: "run",
      errorMessage: "old clearable error",
      retryable: true,
    });
    const deniedClearRecords = await fetch(`${base}/records/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(deniedClearRecords.status, 403);

    const missingClearConfirm = await fetch(`${base}/records/clear`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(missingClearConfirm.status, 400);

    const clearRecords = await fetch(`${base}/records/clear`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ confirm: true }),
    }).then((r) => r.json());
    assert.equal(clearRecords.success, true);
    assert.ok(clearRecords.data.records >= 1);
    assert.ok(clearRecords.data.comments >= 1);
    assert.ok(clearRecords.data.attachments >= 1);
    assert.ok(clearRecords.data.errorsResolved >= 1);
    assert.equal(db.listFeishuProjectSyncStates({ limit: 1000 }).length, 0);
    assert.equal(db.listFeishuProjectCommentSync({ workItemId: "route-clear-all" }).length, 0);
    assert.equal(db.listFeishuProjectAttachmentSync({ workItemId: "route-clear-all" }).length, 0);
    assert.equal(db.listFeishuProjectRetryableSyncErrors({ workItemId: "route-clear-all", includeFuture: true }).length, 0);

    const deniedRefreshRecords = await fetch(`${base}/records/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "mcp", limit: 1 }),
    });
    assert.equal(deniedRefreshRecords.status, 403);

    const refreshCallCount = calls.length;
    const refreshRecords = await fetch(`${base}/records/refresh`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ source: "mcp", limit: 1 }),
    }).then((r) => r.json());
    assert.equal(refreshRecords.success, true);
    assert.equal(refreshRecords.data.source, "feishu-mcp");
    assert.equal(refreshRecords.data.refreshed, 1);
    assert.equal(refreshRecords.data.skippedCount, 0);
    assert.equal(calls.length, refreshCallCount + 1);
    assert.equal(calls.at(-1).type, "mcp-capture");
    const refreshedRecord = db.getFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "mcp-route",
    });
    assert.equal(refreshedRecord.syncStatus, "pending");
    assert.equal(refreshedRecord.targetTaskId, "");
    assert.equal(refreshedRecord.sourceWorkItemUrl, "https://project.feishu.cn/intelligentspace/bug/detail/mcp-route");

    const denied = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItems: [] }),
    });
    assert.equal(denied.status, 403);

    const publicConfig = await fetch(`${base}/config`).then((r) => r.json());
    assert.equal(publicConfig.success, true);
    assert.equal(publicConfig.data.config.feishu.pluginSecret, "***");
    assert.equal(publicConfig.data.config.feishu.spaceKey, "intelligentspace");
    assert.equal(publicConfig.data.config.feishu.workItemTypeKey, "bug");
    assert.equal(Array.isArray(publicConfig.data.config.mappings.keywordRules), true);
    assert.equal(publicConfig.data.filterPreset.updatedAt, "2026-07-18T00:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(publicConfig), /route-plugin-secret|route-user-key/);

    const configGet = await fetch(`${base}/config`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    assert.equal(configGet.success, true);
    assert.equal(configGet.data.config.feishu.pluginSecret, "***");
    assert.equal(configGet.data.config.feishu.userKey, "***");
    assert.equal(configGet.data.config.feishu.spaceKey, "intelligentspace");
    assert.equal(configGet.data.config.feishu.workItemTypeKey, "bug");
    assert.equal(Array.isArray(configGet.data.config.mappings.keywordRules), true);
    assert.doesNotMatch(JSON.stringify(configGet), /route-plugin-secret|route-user-key/);

    const deniedFilterPreset = await fetch(`${base}/filter-preset`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readScope: { filters: [{ fieldKey: "status", fieldName: "状态" }] } }),
    });
    assert.equal(deniedFilterPreset.status, 403);

    const savedFilterPreset = await fetch(`${base}/filter-preset`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ readScope: { filters: [{ fieldKey: "status", fieldName: "状态", values: ["处理中"] }] } }),
    }).then((r) => r.json());
    assert.equal(savedFilterPreset.success, true);
    assert.equal(savedFilterPreset.data.preset.updatedAt, "2026-07-18T00:01:00.000Z");
    assert.equal(calls.at(-1).type, "filter-preset");

    const configPut = await fetch(`${base}/config`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        config: {
          feishu: { pluginSecret: "***", userKey: "***" },
          mappings: {
            keywordRules: [
              {
                id: "m5-route",
                keywords: ["Crash"],
                target: { tasklistId: "tb-m5-keyword-list" },
              },
            ],
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(configPut.success, true);
    assert.equal(configPut.data.config.feishu.pluginSecret, "***");
    const storedConfig = cfg.getConfig().feishuProjectSync;
    assert.equal(storedConfig.feishu.pluginSecret, "route-plugin-secret");
    assert.equal(storedConfig.feishu.userKey, "route-user-key");
    assert.equal(storedConfig.mappings.keywordRules[0].id, "m5-route");

    const preview = await fetch(`${base}/mapping-preview`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        workItem: sampleWorkItem("m5-preview", "Crash preview"),
        config: {
          mappings: {
            keywordRules: [
              {
                id: "preview-route",
                keywords: ["Crash"],
                target: { tasklistId: "tb-preview-list" },
              },
            ],
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(preview.success, true);
    assert.equal(preview.data.results[0].payload.tasklistId, "tb-preview-list");

    const dryRun = await fetch(`${base}/dry-run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ workItems: [] }),
    }).then((r) => r.json());
    assert.equal(dryRun.success, true);
    assert.equal(calls.at(-1).options.dryRun, true);

    const asyncPreviewWorkItem = sampleWorkItem("m5-preview-display", "Preview display fields");
    asyncPreviewWorkItem.fields.push({ field_key: "auto_number", field_name: "系统单号", value: "NSCP-17320" });
    const asyncDryRun = await fetch(`${base}/dry-run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        async: true,
        workItems: [asyncPreviewWorkItem],
        sheetTargetByProblemNo: {
          "NSCP-17320": {
            targetTaskId: "tb-nscp-17320-preview",
            targetUniqueId: "13036",
            targetDisplayId: "CARB-13036",
            sheetTargetRow: {
              "系统单号": "NSCP-17320",
              "钉钉单号": "CARB-13036",
              "问题": "旧任务表格问题",
              "状态": "处理中",
            },
            sheetTargetColumns: ["系统单号", "钉钉单号", "问题", "状态"],
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(asyncDryRun.success, true);
    assert.ok(asyncDryRun.data.id);
    let asyncDryRunState = asyncDryRun.data;
    for (let i = 0; i < 20 && asyncDryRunState.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      asyncDryRunState = await fetch(`${base}/runs/${asyncDryRun.data.id}`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json()).then((body) => body.data);
    }
    assert.equal(asyncDryRunState.status, "success");
    assert.equal(asyncDryRunState.result, undefined);
    assert.equal(asyncDryRunState.resultSummary.ok, true);
    assert.equal(asyncDryRunState.resultSummary.dryRun, true);

    const asyncDryRunPreview = await fetch(`${base}/runs/${asyncDryRun.data.id}/result-preview`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    assert.equal(asyncDryRunPreview.success, true);
    assert.equal(asyncDryRunPreview.data.result.ok, true);
    assert.equal(asyncDryRunPreview.data.result.dryRun, true);
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].payload.tasklistId, "695a01be8cebcce71bb08e59");
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].payload.tasklistIdDisplay, "\u963f\u7ef4\u5854_8678\u5e73\u53f0_S\u5e94\u7528");
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].payload.applicationCategory, "S");
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].payload.applicationCategoryCustomFieldId, "cf-app-category");
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].payload.defectCategory, "\u529f\u80fd\u4f7f\u7528BUG");
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].payload.defectCategoryCustomFieldId, "cf-defect-category");
    assert.ok(asyncDryRunPreview.data.preview.resultsPreview[0].payload.note.startsWith(`\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`));
    assert.match(asyncDryRunPreview.data.preview.resultsPreview[0].payload.note, /com\.minical\.car\.media/);
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].targetTaskId, "tb-nscp-17320-preview");
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].targetUniqueId, "13036");
    assert.deepEqual(asyncDryRunPreview.data.preview.resultsPreview[0].existing.sheetTargetColumns, ["系统单号", "钉钉单号", "问题", "状态"]);
    assert.deepEqual(asyncDryRunPreview.data.preview.resultsPreview[0].existing.sheetTargetRow, {
      "系统单号": "NSCP-17320",
      "钉钉单号": "CARB-13036",
      "问题": "旧任务表格问题",
      "状态": "处理中",
    });
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].payload.notePrevious, "原 TB 备注\n第二行说明");
    assert.equal(asyncDryRunPreview.data.preview.resultsPreview[0].targetFieldVerification.mismatches[0].actual, "原 TB 备注\n第二行说明");
    assert.match(asyncDryRunPreview.data.previewText, /原 TB 备注/);
    assert.match(asyncDryRunPreview.data.previewText, /dryRun/);

    const asyncEmptyNoteDryRun = await fetch(`${base}/dry-run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ async: true, workItems: [sampleWorkItem("m5-empty-note-preview", "Preview empty old note")] }),
    }).then((r) => r.json());
    assert.equal(asyncEmptyNoteDryRun.success, true);
    let asyncEmptyNoteState = asyncEmptyNoteDryRun.data;
    for (let i = 0; i < 20 && asyncEmptyNoteState.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      asyncEmptyNoteState = await fetch(`${base}/runs/${asyncEmptyNoteDryRun.data.id}`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json()).then((body) => body.data);
    }
    assert.equal(asyncEmptyNoteState.status, "success");
    const asyncEmptyNotePreview = await fetch(`${base}/runs/${asyncEmptyNoteDryRun.data.id}/result-preview`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json());
    const emptyNoteRow = asyncEmptyNotePreview.data.preview.resultsPreview[0];
    assert.equal(emptyNoteRow.notePrevious, "空");
    assert.equal(emptyNoteRow.payload.notePrevious, "空");
    assert.equal(emptyNoteRow.targetFieldVerification.notePrevious, "空");
    assert.match(asyncEmptyNotePreview.data.previewText, /"notePrevious": "空"/);

    const sseAbort = new AbortController();
    const sseTimer = setTimeout(() => sseAbort.abort(), 2000);
    const sseResp = await fetch(`${base}/runs/${asyncDryRun.data.id}/events`, {
      headers: { Authorization: "Bearer admin-token" },
      signal: sseAbort.signal,
    });
    assert.equal(sseResp.status, 200);
    assert.match(sseResp.headers.get("content-type") || "", /text\/event-stream/);
    const reader = sseResp.body.getReader();
    const decoder = new TextDecoder();
    let sseText = "";
    for (let i = 0; i < 5 && !/"status":"success"/.test(sseText); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      sseText += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    clearTimeout(sseTimer);
    assert.match(sseText, /event: run/);
    assert.match(sseText, /"status":"success"/);
    assert.doesNotMatch(sseText, /"result":\{/);

    const asyncRun = await fetch(`${base}/run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ async: true, workItems: [] }),
    }).then((r) => r.json());
    assert.equal(asyncRun.success, true);
    assert.ok(asyncRun.data.id);
    let asyncRunState = asyncRun.data;
    for (let i = 0; i < 20 && asyncRunState.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      asyncRunState = await fetch(`${base}/runs/${asyncRun.data.id}`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json()).then((body) => body.data);
    }
    assert.equal(asyncRunState.status, "success");
    assert.equal(asyncRunState.result, undefined);
    assert.equal(asyncRunState.resultSummary.ok, true);
    assert.ok(asyncRunState.events.length >= 2);

    const sheetPreviewFromRun = await fetch(`${base}/sheet/preview`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ runId: asyncRun.data.id, readSheet: false }),
    }).then((r) => r.json());
    assert.equal(sheetPreviewFromRun.success, true);
    assert.equal(sheetPreviewFromRun.data.updateCount, 1);
    assert.equal(calls.at(-1).type, "sheet-preview");
    assert.equal(calls.at(-1).syncResult.ok, true);

    const noisyAsyncRun = await fetch(`${base}/run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ async: true, workItems: [], limit: 150 }),
    }).then((r) => r.json());
    assert.equal(noisyAsyncRun.success, true);
    let noisyRunState = noisyAsyncRun.data;
    for (let i = 0; i < 20 && noisyRunState.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      noisyRunState = await fetch(`${base}/runs/${noisyAsyncRun.data.id}`, { headers: { Authorization: "Bearer admin-token" } }).then((r) => r.json()).then((body) => body.data);
    }
    assert.equal(noisyRunState.status, "success");
    assert.equal(noisyRunState.events.length, 120);
    assert.equal(noisyRunState.events[0].seq, noisyRunState.events.at(-1).seq - 119);
    assert.ok(noisyRunState.events[0].seq > 1);

    const mcpDryRun = await fetch(`${base}/dry-run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ source: "mcp", limit: 1 }),
    }).then((r) => r.json());
    assert.equal(mcpDryRun.success, true);
    assert.equal(mcpDryRun.data.source, "feishu-mcp");
    assert.equal(mcpDryRun.data.results[0].dryRun, true);
    assert.equal(calls.at(-1).type, "mcp-capture");

    db.upsertFeishuProjectSyncState({
      sourceProjectKey: "intelligentspace",
      sourceWorkItemTypeKey: "bug",
      sourceWorkItemId: "7035552490",
      sourceProblemNo: "NSCP-17320",
      sourceWorkItemNo: "NSCP-17320",
      syncStatus: "pending",
    });
    const adaptiveDryRun = await fetch(`${base}/dry-run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        source: "mcp",
        problemNos: ["NSCP-17320"],
        limit: 1,
        config: {
          sync: {
            includeComments: false,
            includeAttachments: false,
            readScope: { enabled: false, filters: [] },
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(adaptiveDryRun.success, true);
    assert.equal(adaptiveDryRun.data.source, "feishu-web");
    assert.equal(adaptiveDryRun.data.sourceFallback.selectedSource, "web");
    assert.deepEqual(adaptiveDryRun.data.sourceAttempts.slice(0, 2).map((attempt) => attempt.source), ["mcp", "web"]);
    assert.equal(adaptiveDryRun.data.sourceAttempts[0].met, false);
    assert.match(adaptiveDryRun.data.sourceAttempts[0].issues.join("\n"), /缺少明确的缺陷描述字段证据/);
    assert.ok(adaptiveDryRun.data.results[0].payload.note.startsWith(`\u7f3a\u9677\u63cf\u8ff0:\n${NSCP_17320_DEFECT_DESCRIPTION}`));

    const webDryRun = await fetch(`${base}/dry-run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        source: "web",
        workItemIds: ["NSCP-17320"],
        limit: 1,
        config: {
          sync: {
            includeComments: false,
            includeAttachments: false,
            readScope: { enabled: false, filters: [] },
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(webDryRun.success, true);
    assert.equal(webDryRun.data.source, "feishu-web");
    assert.equal(webDryRun.data.results[0].dryRun, true);
    const webCaptureCall = calls.findLast((call) => call.type === "web-capture");
    assert.deepEqual(webCaptureCall.options.workItemIds, ["7035552490"]);
    assert.equal(webCaptureCall.options.spaceKey, "intelligentspace");
    assert.equal(webCaptureCall.options.workItemTypeKey, "bug");
    const webSyncCall = calls.findLast((call) => call.type === "web-sync-work-item");
    assert.equal(webSyncCall.workItem.work_item_id, "7035552490");
    assert.equal(webDryRun.data.results[0].targetFieldVerification.targetTaskId, "tb-nscp-17320-web");
    assert.equal(webDryRun.data.results[0].targetFieldVerification.task.uniqueId, "13036");
    assert.equal(webDryRun.data.results[0].targetFieldVerification.mismatches[0].actual, "old TB note");

    const sourceViewDryRun = await fetch(`${base}/dry-run`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        source: "mcp",
        limit: 1,
        sourceView: {
          url: "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?scope=workspaces&node=28602134",
        },
        sort: [{ fieldKey: "updated_at", fieldName: "更新时间", direction: "desc" }],
      }),
    }).then((r) => r.json());
    assert.equal(sourceViewDryRun.success, true);
    const sourceViewCaptureCall = calls.findLast((call) => call.type === "mcp-capture");
    assert.equal(sourceViewCaptureCall.config.feishu.sourceView.viewId, "2OuLlBcDg");
    assert.equal(sourceViewCaptureCall.config.feishu.sourceView.node, "28602134");
    assert.equal(sourceViewCaptureCall.config.sync.sort[0].fieldKey, "updated_at");

    const backfill = await fetch(`${base}/backfill`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ workItemIds: ["m5-1"] }),
    }).then((r) => r.json());
    assert.equal(backfill.success, true);
    assert.equal(calls.at(-1).type, "backfill");

    const badWebhook = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-feishu-project-sync-secret": "bad" },
      body: JSON.stringify({ work_item: sampleWorkItem("m5-webhook") }),
    });
    assert.equal(badWebhook.status, 401);

    const goodWebhook = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-feishu-project-sync-secret": "hook-secret" },
      body: JSON.stringify({ work_item: sampleWorkItem("m5-webhook") }),
    }).then((r) => r.json());
    assert.equal(goodWebhook.success, true);
    assert.equal(calls.at(-1).type, "webhook");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("M6 readiness and config mask keep Feishu Project secrets out of API responses", async () => {
  const current = cfg.getConfig();
  cfg.updateConfig({
    feishuProjectSync: {
      ...(current.feishuProjectSync || {}),
      enabled: true,
      feishu: {
        ...(current.feishuProjectSync?.feishu || {}),
        pluginId: "plugin-visible",
        pluginSecret: "plugin-secret-real",
        userKey: "user-key-real",
        spaceKey: "intelligentspace",
        workItemTypeKey: "bug",
        mcp: {
          ...(current.feishuProjectSync?.feishu?.mcp || {}),
          serverUrl: "https://project.feishu.cn/mcp_server/v1",
          headerName: "X-Mcp-Token",
          token: "mcp-token-real",
        },
      },
      teambition: {
        ...(current.feishuProjectSync?.teambition || {}),
        projectId: "tb-project",
      },
      sync: {
        ...(current.feishuProjectSync?.sync || {}),
        webhookSecret: "webhook-secret-real",
      },
    },
  });

  const ready = svc.getFeishuProjectSyncReadiness();
  assert.equal(ready.enabled, true);
  assert.equal(ready.feishuReady, true);
  assert.equal(ready.teambitionReady, true);
  assert.deepEqual(ready.missing, []);

  const missing = svc.getFeishuProjectSyncReadiness({
    feishu: { authMode: "plugin", pluginSecret: "", userKey: "" },
    teambition: { projectId: "", sprintId: "", sprintUrl: "" },
  });
  assert.equal(missing.feishuReady, false);
  assert.equal(missing.teambitionReady, false);
  assert.deepEqual(missing.missing.sort(), ["feishu.pluginSecret", "feishu.userKey", "teambition.projectId", "teambition.sprintId"].sort());

  const { default: configRouter } = await import("../routes/config.js");
  const { issueToken } = await import("../services/admin-auth.js");
  const token = issueToken({ role: "admin", name: "M6 Admin" });
  const app = express();
  app.use(express.json());
  app.use("/api/config", configRouter);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/config`;

  try {
    const getBody = await fetch(base).then((r) => r.json());
    assert.equal(getBody.success, true);
    assert.equal(getBody.data.feishuProjectSync.feishu.pluginId, "plugin-visible");
    assert.equal(getBody.data.feishuProjectSync.feishu.pluginSecret, "***");
    assert.equal(getBody.data.feishuProjectSync.feishu.userKey, "***");
    assert.equal(getBody.data.feishuProjectSync.feishu.mcp.token, "***");
    assert.equal(getBody.data.feishuProjectSync.sync.webhookSecret, "***");
    assert.doesNotMatch(JSON.stringify(getBody), /plugin-secret-real|user-key-real|mcp-token-real|webhook-secret-real/);

    const putBody = await fetch(base, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        feishuProjectSync: {
          feishu: {
            pluginId: "plugin-updated",
            pluginSecret: "***",
            userKey: "***",
            mcp: {
              token: "***",
            },
          },
          sync: {
            webhookSecret: "***",
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(putBody.success, true);
    assert.equal(putBody.data.feishuProjectSync.feishu.pluginSecret, "***");
    assert.equal(putBody.data.feishuProjectSync.feishu.userKey, "***");
    assert.equal(putBody.data.feishuProjectSync.feishu.mcp.token, "***");
    assert.equal(putBody.data.feishuProjectSync.sync.webhookSecret, "***");
    assert.doesNotMatch(JSON.stringify(putBody), /plugin-secret-real|user-key-real|mcp-token-real|webhook-secret-real/);

    const invalidSourceResponse = await fetch(base, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        feishuProjectSync: {
          feishu: {
            sourceViews: [{
              id: "invalid-global-source",
              url: "https://project.feishu.cn.evil.example/intelligentspace/workObjectView/bug/2OuLlBcDg",
              enabled: true,
              isDefault: true,
            }],
          },
        },
      }),
    });
    const invalidSourceBody = await invalidSourceResponse.json();
    assert.equal(invalidSourceResponse.status, 400);
    assert.equal(invalidSourceBody.success, false);
    assert.ok(invalidSourceBody.data.errors.some((error) => error.code === "invalid-url"));

    const stored = cfg.getConfig().feishuProjectSync;
    assert.equal(stored.feishu.pluginId, "plugin-updated");
    assert.equal(stored.feishu.pluginSecret, "plugin-secret-real");
    assert.equal(stored.feishu.userKey, "user-key-real");
    assert.equal(stored.feishu.mcp.token, "mcp-token-real");
    assert.equal(stored.sync.webhookSecret, "webhook-secret-real");
    assert.notEqual(stored.feishu.sourceViews?.[0]?.id, "invalid-global-source");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dry-run preserves enriched applicationCategory through summarization when custom field lookup by name succeeds", async () => {
  const raw = sampleWorkItem("nscp-17320-app-category-enriched", "NSCP-17320");
  raw.fields.push({ field_key: "auto_number", field_name: "\u7cfb\u7edf\u5355\u53f7", value: "NSCP-17320" });
  raw.fields.push({ field_key: "field_95a8a4", field_name: "\u529f\u80fd\u6a21\u5757", value: { label: "Spotify" } });
  db.upsertFeishuProjectSyncState({
    sourceSystem: "feishu_project",
    sourceProjectKey: "intelligentspace",
    sourceWorkItemTypeKey: "bug",
    sourceWorkItemId: "nscp-17320-app-category-enriched",
    sourceWorkItemUrl: "https://project.feishu.cn/intelligentspace/bug/detail/nscp-17320-app-category-enriched",
    targetSystem: "teambition",
    targetTaskId: "tb-nscp-17320-app-category-enriched",
    targetUniqueId: "CARB-13036",
    syncStatus: "success",
  });

  const result = await svc.syncFeishuProjectWorkItem(raw, {
    dryRun: true,
    checkRemoteExisting: false,
    config: {
      teambition: {
        applicationCategoryCustomFieldId: "",
      },
      sync: {
        includeComments: false,
        includeAttachments: false,
        readScope: { enabled: false, filters: [] },
      },
    },
    loader: {
      checkTaskExists: async (taskId) => ({
        exists: true,
        source: "test",
        task: {
          _id: taskId,
          uniqueId: "13036",
          customfields: [
            {
              _customfieldId: "cf-app-category",
              name: "\u5e94\u7528\u5206\u7c7b",
              value: "S",
            },
          ],
        },
      }),
    },
  });

  const comparisons = Object.fromEntries(result.comparisonSnapshot.fieldComparisons.map((field) => [field.fieldKey, field]));
  assert.equal(result.payload.applicationCategory, "S");
  assert.equal(comparisons.applicationCategory.targetCurrent.display, "S");
  assert.equal(comparisons.applicationCategory.targetNext.display, "S");
  assert.equal(comparisons.applicationCategory.action, "same");
  // Verify the summarized task preserved the enriched applicationCategory
  const summarizedTask = result.targetFieldVerification?.task;
  assert.ok(summarizedTask, "summarized task should exist");
  assert.equal(summarizedTask.applicationCategory, "S", "summarized task should preserve applicationCategory");
});
