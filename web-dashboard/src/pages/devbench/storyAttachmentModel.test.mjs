import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  attachmentUploadRelativePath,
  buildStoryAttachmentPrompt,
  clipboardAttachmentFiles,
  formatAttachmentSize,
  normalizeStoryAttachment,
  setTbAttachmentDownloadPending,
  tbAttachmentDownloadKey,
} from "./storyAttachmentModel.mjs";

const storyTabSource = readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
const tbAttachmentsSource = storyTabSource.slice(
  storyTabSource.indexOf("function TbAttachments"),
  storyTabSource.indexOf("function fmtTs"),
);

class FakeFile {
  constructor(parts, name, options = {}) {
    this.parts = parts;
    this.name = name;
    this.type = options.type || "";
    this.lastModified = options.lastModified || 0;
    this.size = parts.reduce((sum, part) => sum + (part?.size || 0), 0);
  }
}

test("剪贴板优先保留资源管理器提供的原始文件名", () => {
  const original = { name: "问题截图 01.png", size: 12, type: "image/png", lastModified: 7 };
  const duplicateItem = { kind: "file", type: "image/png", getAsFile: () => original };
  const files = clipboardAttachmentFiles({ files: [original], items: [duplicateItem] }, { now: 100, FileCtor: FakeFile });

  assert.equal(files.length, 1);
  assert.equal(files[0], original);
  assert.equal(files[0].name, "问题截图 01.png");
});

test("同名同大小但来源不同的剪贴板文件不会被错误去重", () => {
  const first = { name: "同名.log", size: 10, type: "text/plain", lastModified: 1 };
  const second = { name: "同名.log", size: 10, type: "text/plain", lastModified: 1 };
  const files = clipboardAttachmentFiles({ files: [first, second], items: [] }, { FileCtor: FakeFile });

  assert.deepEqual(files, [first, second]);
});

test("剪贴板只有匿名 Blob 时才生成可读兜底名称", () => {
  const anonymous = { name: "", size: 9, type: "image/jpeg", lastModified: 0 };
  const files = clipboardAttachmentFiles({
    files: [],
    items: [{ kind: "file", type: "image/jpeg", getAsFile: () => anonymous }],
  }, { now: 1700000000000, FileCtor: FakeFile });

  assert.equal(files[0].name, "paste_1700000000000_1.jpg");
  assert.equal(files[0].type, "image/jpeg");
});

test("每批聊天附件使用隔离上传路径并保留来源层级", () => {
  assert.equal(
    attachmentUploadRelativePath("1700-abc", "日志包/sub/trace.log"),
    "chat-attachments/1700-abc/日志包/sub/trace.log",
  );
  assert.equal(
    attachmentUploadRelativePath("1700-abc", "../截图.png"),
    "chat-attachments/1700-abc/截图.png",
  );
});

test("附件元数据兼容旧消息并生成本轮 AI 读取提示", () => {
  const old = normalizeStoryAttachment({ name: "截图.png", relPath: "storydev:/archives/截图.png", isImg: true });
  assert.equal(old.kind, "file");
  assert.equal(old.originalName, "截图.png");

  const prompt = buildStoryAttachmentPrompt("请分析", [old, {
    name: "logs",
    relPath: "storydev:/archives/logs",
    kind: "folder",
    fileCount: 3,
  }]);
  assert.match(prompt, /本轮用户附件/);
  assert.match(prompt, /storydev:\/archives\/截图\.png/);
  assert.match(prompt, /文件夹，含 3 个文件/);
  assert.match(prompt, /请分析$/);
});

test("附件大小使用紧凑单位", () => {
  assert.equal(formatAttachmentSize(0), "0 B");
  assert.equal(formatAttachmentSize(1536), "1.5 KB");
  assert.equal(formatAttachmentSize(2 * 1024 * 1024), "2.0 MB");
  assert.equal(formatAttachmentSize(undefined), "");
});

test("TB 附件下载状态按附件隔离，后启动的下载不会覆盖先启动项", () => {
  const firstKey = tbAttachmentDownloadKey({ id: "attachment-a", name: "a.zip" }, 0);
  const secondKey = tbAttachmentDownloadKey({ id: "attachment-b", name: "b.zip" }, 1);

  let pending = setTbAttachmentDownloadPending({}, firstKey, true);
  pending = setTbAttachmentDownloadPending(pending, secondKey, true);
  assert.deepEqual(pending, { "attachment-a": true, "attachment-b": true });

  pending = setTbAttachmentDownloadPending(pending, secondKey, false);
  assert.deepEqual(pending, { "attachment-a": true });
});

test("TB 附件悬浮面板在单项下载期间呈现可访问的进度条", () => {
  assert.match(tbAttachmentsSource, /role="progressbar"/);
  assert.match(tbAttachmentsSource, /aria-label=\{`正在下载/);
  assert.doesNotMatch(tbAttachmentsSource, /const \[busy, setBusy\] = useState\(""\)/);
});

test("TB 单附件列表显示格式化上传时间并为缺失时间提供明确回退", () => {
  assert.match(tbAttachmentsSource, /formatChineseDateTime\(a\.createdAt\)/);
  assert.match(tbAttachmentsSource, /上传时间：\{uploadedAt \|\| "未知"\}/);
});
