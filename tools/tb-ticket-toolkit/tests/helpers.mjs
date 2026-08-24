import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTempGitRepo(prefix = "tb-toolkit-m2-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Fixture User"]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["-C", root, "add", "--", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
  return root;
}

export function removeTree(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

export function richSnapshot({ attachmentCount = 0, remarkImageCount = 0 } = {}) {
  const comments = Array.from({ length: 35 }, (_, index) => ({
    _id: `comment-${index + 1}`,
    content: { text: `评论-${index + 1}` },
    creator: { _id: `commenter-${index + 1}`, name: `评论人-${index + 1}` },
    created: `2026-08-${String((index % 20) + 1).padStart(2, "0")}T01:02:03.000Z`,
  }));
  const items = Array.from({ length: attachmentCount }, (_, index) => ({
    attachmentId: `attachment-${index + 1}`,
    source: index % 2 ? "comment" : "task",
    sourceRef: index % 2 ? `comment-${index + 1}` : null,
    originalName: index < 2 ? "same.log" : `evidence-${index + 1}.bin`,
    size: 4,
    mimeType: "application/octet-stream",
    uploader: `上传人-${index + 1}`,
    createdAt: "2026-08-21T04:05:06.000Z",
  }));
  return {
    resolved: {
      taskId: "0123456789abcdef01234567",
      taskNo: "CARB-15125",
      title: "M2 脱敏工单",
    },
    detail: {
      _id: "0123456789abcdef01234567",
      uniqueId: 15125,
      content: "M2 脱敏工单",
      note: { markdown: "完整描述", html: "<p>完整描述</p>" },
      project: { _id: "project-m2", name: "脱敏项目" },
      tasklist: { _id: "tasklist-m2", title: "脱敏任务列表" },
      sprint: { _id: "sprint-m2", name: "脱敏迭代" },
      taskflowstatus: { _id: "status-m2", name: "AI甄别" },
      priority: "P0",
      tags: [{ _id: "tag-m2", name: "缺陷" }],
      creator: { _id: "creator-m2", name: "创建人" },
      executor: { _id: "executor-m2", name: "负责人" },
      involveMembers: [{ _id: "participant-m2", name: "参与人" }],
      created: "2026-08-20T01:02:03.000Z",
      updated: "2026-08-21T04:05:06.000Z",
      dueDate: "2026-08-31T00:00:00.000Z",
      customfields: [{ name: "缺陷分类", value: "功能使用BUG" }],
      secretEnvelope: { Authorization: "Bearer fixture-secret" },
    },
    comments: {
      available: true,
      complete: true,
      source: "fixture",
      items: comments,
      error: "",
    },
    note: {
      ok: true,
      renderMode: "rtf",
      markdown: "补充说明",
      html: "<p>补充说明</p>",
      images: Array.from({ length: remarkImageCount }, (_, index) => ({
        attachmentId: `remark-image-${index + 1}`,
        name: index === 0 ? "remark.png" : `remark-${index + 1}.png`,
        width: 10,
        height: 10,
      })),
      links: ["https://example.invalid/reference"],
    },
    attachments: {
      available: true,
      complete: true,
      source: "fixture",
      items,
      error: "",
    },
    aiefficiencyContext: { storyId: "story-m2", localOnly: true },
  };
}

export function fakeProvider(snapshot, contents = {}) {
  const calls = { readTicket: 0, openAttachment: [] };
  return {
    calls,
    async readTicket() {
      calls.readTicket += 1;
      return structuredClone(snapshot);
    },
    async openAttachment(attachmentId) {
      calls.openAttachment.push(attachmentId);
      if (contents[attachmentId] instanceof Error) throw contents[attachmentId];
      const value = contents[attachmentId] ?? Buffer.from(`data:${attachmentId}`);
      return { body: Buffer.isBuffer(value) ? value : Buffer.from(value) };
    },
  };
}
