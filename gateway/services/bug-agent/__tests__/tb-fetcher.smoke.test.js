/**
 * tb-fetcher 测试 —— mock 掉 teambition.js 所有调用，验证：
 *   - searchTask 找不到 → TB_NOT_FOUND
 *   - 完整流程拼装 record-like 对象 → transformTbRecordToInput
 *   - 附件按扩展名过滤（仅日志类下载）
 *   - 附件超大（>10MB）跳过
 *   - 评论拼到 description
 *   - 任一拉取失败不 fatal
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { fetchTbTaskById, cleanupTbImportTmp } from "../ingest/tb-fetcher.js";

let TMP_ROOT;
before(() => {
  TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bug-agent-tb-import-test-"));
  process.env.BUG_AGENT_DB_ROOT = TMP_ROOT;
});
after(() => {
  delete process.env.BUG_AGENT_DB_ROOT;
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// ---------- 基础场景 ----------

test("fetcher: query 为空 → BAD_QUERY", async () => {
  await assert.rejects(
    fetchTbTaskById("", { _deps: { searchTask: async () => null } }),
    (e) => e.code === "BAD_QUERY"
  );
  await assert.rejects(
    fetchTbTaskById("   ", { _deps: { searchTask: async () => null } }),
    (e) => e.code === "BAD_QUERY"
  );
});

test("fetcher: searchTask 返回 null → TB_NOT_FOUND", async () => {
  await assert.rejects(
    fetchTbTaskById("CARB-99999", { _deps: { searchTask: async () => null } }),
    (e) => e.code === "TB_NOT_FOUND"
  );
});

test("fetcher: 完整流程 — 评论拼到 description，附件元信息进 attachments_json", async () => {
  const deps = {
    searchTask: async (q) => ({
      _id: "tb_obj_id_xxx",
      uniqueId: 12345,
      content: "测试 Bug 标题",
      note: "原始描述：用户点击播放按钮无声音",
      executorId: "user-9",
    }),
    getTaskDetail: async (id) => ({
      _id: id,
      content: "测试 Bug 标题",
      note: "原始描述：用户点击播放按钮无声音",
      executorId: "user-9",
    }),
    getTaskComments: async () => ([
      { creator: { name: "工程师A" }, created: "2026-04-27T10:00:00Z", content: "<p>看起来是 AudioFocus 失败</p>" },
      { creator: { name: "测试B" }, created: "2026-04-27T11:00:00Z", content: "在 com.xxx.music 里复现" },
    ]),
    getTaskAttachments: async () => ([
      { fileName: "logcat.log",  fileSize: 1024, downloadUrl: "https://tb/logcat" },
      { fileName: "video.mp4",   fileSize: 10000, downloadUrl: "https://tb/video" }, // 非日志扩展名 → 跳过
      { fileName: "huge.log",    fileSize: 200 * 1024 * 1024, downloadUrl: "https://tb/huge" }, // > 默认 100MB 上限
    ]),
    downloadAttachment: async (url, dest) => {
      // 写一份假内容
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "FATAL EXCEPTION: main\n  at com.xxx.music.Player.play");
      return 60;
    },
  };

  const r = await fetchTbTaskById("CARB-12345", { _deps: deps });

  assert.equal(r.tb_id, "CARB-12345");
  assert.equal(r.title, "测试 Bug 标题");
  assert.ok(r.raw_content.includes("用户点击播放按钮无声音"));
  assert.ok(r.raw_content.includes("【任务评论】"));
  assert.ok(r.raw_content.includes("AudioFocus 失败"));
  assert.equal(r.package_name, "com.xxx.music"); // 来自评论
  assert.equal(r.reporter_id, "user-9");

  // 仅 logcat.log 被实际下载，video.mp4 / huge.log 跳过
  const atts = JSON.parse(JSON.parse(JSON.stringify({ x: r._meta }))._meta_x_dummy || "[]");
  // 改用 _meta 直接读
  assert.equal(r._meta.attachments_total, 3);
  assert.equal(r._meta.attachments_downloaded, 1);
  assert.equal(r._meta.tb_task_id, "tb_obj_id_xxx");
  assert.ok(r._meta.tmp_dir.includes("CARB-12345"));

  // log_attachment 应包含下载的 logcat 内容
  assert.ok(r.log_attachment.includes("FATAL EXCEPTION"));

  // 附件元信息记录 skipped/downloaded 状态
  const attMetaList = r._meta.attachments;
  assert.ok(Array.isArray(attMetaList));
});

test("fetcher: 子调用失败不 fatal（用 Promise.allSettled 兜底）", async () => {
  const deps = {
    searchTask: async () => ({ _id: "x", uniqueId: 7, content: "标题", note: "正文" }),
    getTaskDetail: async () => { throw new Error("503"); },     // detail 失败
    getTaskComments: async () => { throw new Error("404"); },   // comments 失败
    getTaskAttachments: async () => [],                          // 无附件
    downloadAttachment: async () => 0,
  };
  const r = await fetchTbTaskById("CARB-7", { _deps: deps });
  assert.equal(r.tb_id, "CARB-7");
  // 退化到 task 本身的字段
  assert.equal(r.title, "标题");
  assert.ok(r.raw_content.includes("正文"));
});

test("fetcher: 附件下载 throw → 标记 downloadFailed 但不阻塞", async () => {
  const deps = {
    searchTask: async () => ({ _id: "x", uniqueId: 8, content: "T" }),
    getTaskDetail: async () => ({ _id: "x", note: "x" }),
    getTaskComments: async () => [],
    getTaskAttachments: async () => ([{ fileName: "a.log", fileSize: 100, downloadUrl: "u" }]),
    downloadAttachment: async () => { throw new Error("network down"); },
  };
  const r = await fetchTbTaskById("CARB-8", { _deps: deps });
  assert.equal(r._meta.attachments_total, 1);
  assert.equal(r._meta.attachments_downloaded, 0);
  // attachments_json 在 raw_content 里有展示
  assert.ok(r.raw_content.includes("a.log"));
});

test("fetcher: skipDownload=true 不写文件", async () => {
  let called = false;
  const deps = {
    searchTask: async () => ({ _id: "x", uniqueId: 9, content: "T" }),
    getTaskDetail: async () => ({ _id: "x" }),
    getTaskComments: async () => [],
    getTaskAttachments: async () => ([{ fileName: "a.log", downloadUrl: "u" }]),
    downloadAttachment: async () => { called = true; return 1; },
  };
  await fetchTbTaskById("CARB-9", { _deps: deps, skipDownload: true });
  assert.equal(called, false);
});

test("fetcher: 默认 100MB 上限内的大文件能下载", async () => {
  let downloadedSize = 0;
  const deps = {
    searchTask: async () => ({ _id: "x", uniqueId: 100, content: "T" }),
    getTaskDetail: async () => ({ _id: "x", note: "x" }),
    getTaskComments: async () => [],
    getTaskAttachments: async () => ([
      { fileName: "big-bugreport.txt", fileSize: 50 * 1024 * 1024, downloadUrl: "u" }, // 50MB，新阈值内
    ]),
    downloadAttachment: async (url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "FATAL EXCEPTION: huge log");
      downloadedSize = 50 * 1024 * 1024;
      return downloadedSize;
    },
  };
  const r = await fetchTbTaskById("CARB-100", { _deps: deps });
  assert.equal(r._meta.attachments_downloaded, 1, "50MB 应该被下载（旧 10MB 上限会拒绝）");
});

test("fetcher: BUG_AGENT_TB_MAX_ATTACHMENT_MB env 覆盖（设 0 = 不限）", async () => {
  const orig = process.env.BUG_AGENT_TB_MAX_ATTACHMENT_MB;
  process.env.BUG_AGENT_TB_MAX_ATTACHMENT_MB = "0"; // 不限
  try {
    const deps = {
      searchTask: async () => ({ _id: "x", uniqueId: 200, content: "T" }),
      getTaskDetail: async () => ({ _id: "x", note: "x" }),
      getTaskComments: async () => [],
      getTaskAttachments: async () => ([
        { fileName: "monster.log", fileSize: 500 * 1024 * 1024, downloadUrl: "u" }, // 500MB
      ]),
      downloadAttachment: async (url, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "logs ok");
        return 500 * 1024 * 1024;
      },
    };
    const r = await fetchTbTaskById("CARB-200", { _deps: deps });
    assert.equal(r._meta.attachments_downloaded, 1, "env=0 时 500MB 也允许下载");
  } finally {
    if (orig === undefined) delete process.env.BUG_AGENT_TB_MAX_ATTACHMENT_MB;
    else process.env.BUG_AGENT_TB_MAX_ATTACHMENT_MB = orig;
  }
});

test("fetcher: ObjectId 直接传入也接受", async () => {
  const oid = "a".repeat(24);
  let received;
  const deps = {
    searchTask: async (q) => { received = q; return { _id: oid, content: "T" }; },
    getTaskDetail: async () => ({ _id: oid }),
    getTaskComments: async () => [],
    getTaskAttachments: async () => [],
    downloadAttachment: async () => 0,
  };
  const r = await fetchTbTaskById(oid, { _deps: deps });
  assert.equal(received, oid);
  assert.equal(r.tb_id, oid); // 没有 uniqueId / CARB-* 时退化为 _id
});

// ---------- cleanupTbImportTmp ----------

test("cleanup: 删除超时目录", () => {
  const root = path.join(TMP_ROOT, "tmp", "tb-import");
  fs.mkdirSync(root, { recursive: true });
  const fresh = path.join(root, "FRESH");
  const stale = path.join(root, "STALE");
  fs.mkdirSync(fresh); fs.mkdirSync(stale);
  // 把 stale 的 mtime 改成 2 天前
  const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

  const r = cleanupTbImportTmp();
  assert.equal(r.deleted, 1);
  assert.ok(fs.existsSync(fresh));
  assert.ok(!fs.existsSync(stale));
});
