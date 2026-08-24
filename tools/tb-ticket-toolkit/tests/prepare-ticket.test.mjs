import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { prepareTicket } from "../packages/tb-application/src/prepare-ticket.js";
import { createTempGitRepo, fakeProvider, removeTree, richSnapshot } from "./helpers.mjs";

const cleanup = [];
afterEach(() => {
  for (const target of cleanup.splice(0)) removeTree(target);
});

function repo() {
  const root = createTempGitRepo();
  cleanup.push(root);
  return root;
}

test("0 个附件直接 READY，并保存受控 context/manifest", async () => {
  const root = repo();
  const provider = fakeProvider(richSnapshot());
  const result = await prepareTicket({ provider, repoPath: root, taskRef: "CARB-15125" });

  assert.equal(result.state, "READY");
  assert.deepEqual(result.downloads, []);
  assert.deepEqual(provider.calls.openAttachment, []);
  assert.equal(fs.existsSync(path.join(root, result.contextFile)), true);
  assert.equal(fs.existsSync(path.join(root, result.manifestFile)), true);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "");

  const repeated = await prepareTicket({ provider: fakeProvider(richSnapshot()), repoPath: root, taskRef: "CARB-15125" });
  assert.equal(repeated.state, "READY");
  assert.equal(repeated.selectionRestored, true);
});

test("1 和 3 个附件自动下载，使用原子文件、大小和 SHA-256 receipt", async () => {
  for (const count of [1, 3]) {
    const root = repo();
    const snapshot = richSnapshot({ attachmentCount: count });
    const provider = fakeProvider(snapshot, Object.fromEntries(snapshot.attachments.items.map((item) => [item.attachmentId, Buffer.from("data")])));
    const result = await prepareTicket({ provider, repoPath: root, taskRef: "CARB-15125" });

    assert.equal(result.state, "READY");
    assert.equal(result.downloads.length, count);
    assert.equal(provider.calls.openAttachment.length, count);
    assert.equal(result.downloads.every((item) => item.size === 4 && /^[a-f0-9]{64}$/.test(item.sha256)), true);
    assert.equal(fs.readdirSync(path.join(root, "temp", "CARB-15125")).some((name) => name.endsWith(".part")), false);
  }
});

test("4 个附件未选择时 NEEDS_ATTACHMENT_SELECTION，零下载且只产生忽略的本地准备文件", async () => {
  const root = repo();
  const provider = fakeProvider(richSnapshot({ attachmentCount: 4 }));
  const result = await prepareTicket({ provider, repoPath: root, taskRef: "CARB-15125" });

  assert.equal(result.state, "NEEDS_ATTACHMENT_SELECTION");
  assert.equal(result.choices.length, 4);
  assert.deepEqual(result.downloads, []);
  assert.deepEqual(provider.calls.openAttachment, []);
  assert.equal("apply" in provider, false, "M2 provider 不应暴露远端写入口");
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "");
});

test("选择 1/3 后只下载对应 ID，再次无选择调用恢复 receipt 且不重复下载", async () => {
  const root = repo();
  const snapshot = richSnapshot({ attachmentCount: 4 });
  const firstProvider = fakeProvider(snapshot, {
    "attachment-1": Buffer.from("one!"),
    "attachment-3": Buffer.from("tri!"),
  });
  const first = await prepareTicket({
    provider: firstProvider,
    repoPath: root,
    taskRef: "CARB-15125",
    selection: { mode: "selected", attachmentIds: ["attachment-1", "attachment-3"] },
  });
  assert.deepEqual(firstProvider.calls.openAttachment, ["attachment-1", "attachment-3"]);

  const secondProvider = fakeProvider(snapshot);
  const second = await prepareTicket({ provider: secondProvider, repoPath: root, taskRef: "CARB-15125" });
  assert.equal(second.state, "READY");
  assert.equal(second.selectionRestored, true);
  assert.deepEqual(second.downloads.map((item) => item.attachmentId), ["attachment-1", "attachment-3"]);
  assert.deepEqual(secondProvider.calls.openAttachment, [], "有效 receipt 必须幂等复用");
});

test("同名不同附件不覆盖；下载中断清理 .part 并返回 BLOCKED", async () => {
  const root = repo();
  const snapshot = richSnapshot({ attachmentCount: 3 });
  const provider = fakeProvider(snapshot, {
    "attachment-1": Buffer.from("same"),
    "attachment-2": Buffer.from("diff"),
    "attachment-3": new Error("network interrupted at https://download.invalid/a?signature=secret"),
  });
  const result = await prepareTicket({ provider, repoPath: root, taskRef: "CARB-15125" });
  const directory = path.join(root, "temp", "CARB-15125");

  assert.equal(result.state, "BLOCKED");
  assert.equal(result.error.code, "ATTACHMENT_DOWNLOAD_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /signature=secret|download\.invalid/i);
  assert.notEqual(result.downloads[0].localRelativePath, result.downloads[1].localRelativePath);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".part")), false);
});

test("单文件与总大小限制按实际字节失败关闭", async () => {
  const singleRoot = repo();
  const singleSnapshot = richSnapshot({ attachmentCount: 1 });
  singleSnapshot.attachments.items[0].size = null;
  const single = await prepareTicket({
    provider: fakeProvider(singleSnapshot, { "attachment-1": Buffer.alloc(6) }),
    repoPath: singleRoot,
    taskRef: "CARB-15125",
    limits: { maxSingleFileBytes: 5, maxTotalBytes: 20 },
  });
  assert.equal(single.state, "BLOCKED");
  assert.equal(single.error.code, "ATTACHMENT_TOO_LARGE");

  const totalRoot = repo();
  const totalSnapshot = richSnapshot({ attachmentCount: 3 });
  const total = await prepareTicket({
    provider: fakeProvider(totalSnapshot, {
      "attachment-1": Buffer.alloc(4),
      "attachment-2": Buffer.alloc(4),
      "attachment-3": Buffer.alloc(4),
    }),
    repoPath: totalRoot,
    taskRef: "CARB-15125",
    limits: { maxSingleFileBytes: 5, maxTotalBytes: 10 },
  });
  assert.equal(total.state, "BLOCKED");
  assert.equal(total.error.code, "ATTACHMENT_TOTAL_TOO_LARGE");
});

test("context、manifest、selection 和 receipt 文件均不包含秘密或签名 URL", async () => {
  const root = repo();
  const snapshot = richSnapshot({ attachmentCount: 1 });
  snapshot.attachments.items[0].downloadUrl = "https://download.invalid/a?signature=secret";
  snapshot.detail.Authorization = "Bearer secret";
  const result = await prepareTicket({
    provider: fakeProvider(snapshot, { "attachment-1": Buffer.from("data") }),
    repoPath: root,
    taskRef: "CARB-15125",
  });
  const directory = path.join(root, "temp", "CARB-15125");
  const json = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("\n");
  assert.equal(result.state, "READY");
  assert.doesNotMatch(json, /Bearer secret|signature=secret|download\.invalid|\"Authorization\"/i);
});

test("官方 MCP 未覆盖评论或附件读取时关闭，不把未知附件数当成 0", async () => {
  const root = repo();
  const snapshot = richSnapshot();
  snapshot.comments = {
    available: false,
    complete: false,
    source: "official-mcp-gap",
    items: [],
    error: "official MCP has no complete comment read tool",
  };
  snapshot.attachments = {
    available: false,
    complete: false,
    source: "official-mcp-gap",
    items: [],
    error: "official MCP has no complete attachment read tool",
  };
  snapshot.note = { ok: false, error: "official MCP has no complete rich-note read tool" };
  const provider = fakeProvider(snapshot);
  const result = await prepareTicket({ provider, repoPath: root, taskRef: "CARB-15125" });

  assert.equal(result.state, "BLOCKED");
  assert.equal(result.error.code, "CONTEXT_INCOMPLETE");
  assert.deepEqual(result.downloads, []);
  assert.deepEqual(provider.calls.openAttachment, []);
  assert.deepEqual(result.blockers.map((item) => item.field), ["comments", "attachments", "remarks"]);
  assert.equal(fs.existsSync(path.join(root, "temp", "CARB-15125", "ticket-context.json")), true);
  assert.equal(fs.existsSync(path.join(root, "temp", "CARB-15125", "attachment-manifest.json")), false);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "");
});
