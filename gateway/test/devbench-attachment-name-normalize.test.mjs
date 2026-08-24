import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAttachmentDisplayName } from "../services/devbench/index.js";

test("纯 ASCII 串原样返回", () => {
  assert.equal(normalizeAttachmentDisplayName("release-notes.txt"), "release-notes.txt");
  assert.equal(normalizeAttachmentDisplayName(""), "");
  assert.equal(normalizeAttachmentDisplayName(null), "");
});

test("正确 UTF-8 中文不被二次解码", () => {
  const ok = "应用市场首页截图.png";
  assert.equal(normalizeAttachmentDisplayName(ok), ok);
});

test("UTF-8 字节被误作 latin1 → 自动还原", () => {
  const mojibake = Buffer.from("应用市场首页截图.png", "utf8").toString("latin1");
  const fixed = normalizeAttachmentDisplayName(mojibake);
  assert.equal(fixed, "应用市场首页截图.png");
});

test("HTML 实体被解码", () => {
  const html = "&#x5E94;&#x7528;&#x5E02;&#x573A;&#x9996;&#x9875;.png";
  assert.equal(normalizeAttachmentDisplayName(html), "应用市场首页.png");
});

test("连续 U+FFFD 被压缩成单个", () => {
  // 用显式转义，避免编辑器/IO 链条上的 U+FFFD 替换字符再次被改写。
  const broken = "���应用市场.png";
  const out = normalizeAttachmentDisplayName(broken);
  assert.equal(out.includes("��"), false, "不应出现连续 U+FFFD");
  assert.equal(out, "�应用市场.png");
});

test("URL-percent-encoded 串自动解码（无 CJK + 高密度 %XX）", () => {
  // 模拟 TB v2 API 直接返回的形如 "8.10.6%20%E5%BA%94%E7%94%A8%E5%B8%82%E5%9C%BA%E7%..."
  // 这里手动构造出"v8.10.6 应用市场首页.png"的 URL-encoded 形态。
  // ASCII 段里的空格字符也走 percent-encoding（部分 TB 字段就是这种全编码形态）。
  const original = "v8.10.6 应用市场首页.png";
  const encoded = Array.from(Buffer.from(original, "utf8")).map((b) =>
    `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
  // 形状与用户上报的 "8.10.6%20%E5%BA%94%E7%94%A8%E5%B8%82%E5%9C%BA%E7%..." 一致
  assert.match(encoded, /%76%38%2E%31%30%2E%36%20%E5%BA%94/); // "v8.10.6 应用" 段（含 %20）
  assert.equal(normalizeAttachmentDisplayName(encoded), original);
});

test("URL-percent-encoded 串未达密度阈值时不被乱改", () => {
  // 仅含一个 %20 的合法文件名（"release notes.txt" 里偶然出现的 URL 片段）
  // 不应触发解码分支，保持原样
  const benign = "100% complete.png";
  assert.equal(normalizeAttachmentDisplayName(benign), "100% complete.png");
});

test("URL-percent-encoded 但 decode 失败时不破坏原串", () => {
  // 形如 "%FF%FE%E0" 这种不合法的 UTF-8 字节，decodeURIComponent 会抛 URIError；
  // 此时不应破坏原串，保留可读部分。
  const raw = "broken %FF%FE%E0 fragment";
  const out = normalizeAttachmentDisplayName(raw);
  // 原串里没有 CJK、没有非 ASCII 字节，URL 解码不该生效；
  // 且不会触发 latin1 → utf8 分支；结果应与原串一致。
  assert.equal(out, raw);
});
