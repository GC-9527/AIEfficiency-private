import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  classifyStoryMessageUrl,
  extractBareStoryArtifactRefs,
  extractStoryArtifactRefs,
  hasStoryExternalBridge,
  isSafeResolvedStoryMessageUrl,
  isStoryArtifactRef,
  planStoryMessageRender,
  resolveStoryMessageUrl,
  storyMessageArtifactRef,
  storyMessageFileName,
} from "./storyMessageModel.mjs";

const storyTabSource = fs.readFileSync(new URL("./StoryTab.jsx", import.meta.url), "utf8");
const attachmentListSource = fs.readFileSync(new URL("./StoryAttachmentList.jsx", import.meta.url), "utf8");
const artifactUrlsSource = fs.readFileSync(new URL("./useStoryArtifactUrls.js", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("./api.js", import.meta.url), "utf8");

const artifactUrl = (tabId, ref) => (
  `http://127.0.0.1:3001/api/devbench/tabs/${encodeURIComponent(tabId)}/artifact?ref=${encodeURIComponent(ref)}`
);

test("超大回答首屏只生成有界预览，显式展开后也使用纯文本而不是 Markdown", () => {
  const rawJsonl = `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n${"x".repeat(1_100_000)}`;
  const deferred = planStoryMessageRender(rawJsonl);
  assert.equal(deferred.mode, "preview");
  assert.equal(deferred.oversized, true);
  assert.ok(deferred.content.length <= 4_100);
  assert.equal(deferred.totalChars, rawJsonl.length);

  const expanded = planStoryMessageRender(rawJsonl, { expanded: true });
  assert.equal(expanded.mode, "plain");
  assert.equal(expanded.content, rawJsonl);

  const normal = planStoryMessageRender("## 正常 Markdown");
  assert.equal(normal.mode, "markdown");
  assert.equal(normal.oversized, false);
});

test("只放行规范 http/https 直达链接；mailto 一律拒绝（禁止唤起系统邮箱）", () => {
  assert.equal(resolveStoryMessageUrl("https://example.com/review?id=1"), "https://example.com/review?id=1");
  assert.equal(resolveStoryMessageUrl("http://example.com"), "http://example.com/");
  // mailto 不再作为直达链接：内部工具禁止点击唤起本机邮箱客户端（“一直打开邮箱”）
  assert.equal(resolveStoryMessageUrl("mailto:reviewer@example.com"), "");
  assert.equal(isSafeResolvedStoryMessageUrl("mailto:reviewer@example.com"), false);
  for (const unsafe of [
    "https:\\..\\..\\secret.txt",
    "https:C:\\secret.txt",
    "http:\\D:\\secret.txt",
    "http:javascript:alert(1)",
    "javascript:alert(1)",
    "data:text/html,pwned",
    "file:///D:/secret.txt",
    "D:\\workspace\\secret.txt",
    "/local/absolute/path",
    "mailto:C:\\secret.txt",
    "#section",
  ]) {
    assert.equal(resolveStoryMessageUrl(unsafe), "", unsafe);
    assert.equal(isSafeResolvedStoryMessageUrl(unsafe), false, unsafe);
  }
});

test("storydev 引用只能转为受控 Gateway artifact URL", () => {
  const ref = "storydev:/reports/代码评审_abc_完整报告.pdf";
  const resolved = resolveStoryMessageUrl(ref, { tabId: "tab 1", artifactUrl });
  assert.match(resolved, /^http:\/\/127\.0\.0\.1:3001\/api\/devbench\/tabs\/tab%201\/artifact\?/);
  assert.equal(new URL(resolved).searchParams.get("ref"), ref);
  assert.equal(
    new URL(resolveStoryMessageUrl("STORYDEV:/reports/result.pdf", { tabId: "tab", artifactUrl })).searchParams.get("ref"),
    "storydev:/reports/result.pdf",
  );

  assert.equal(resolveStoryMessageUrl("storydev://evil.example/report.pdf", { tabId: "tab", artifactUrl }), "");
  assert.equal(resolveStoryMessageUrl("storydev:/reports/../secret.txt", { tabId: "tab", artifactUrl }), "");
  assert.equal(resolveStoryMessageUrl("storydev:/reports\\secret.txt", { tabId: "tab", artifactUrl }), "");
  assert.equal(resolveStoryMessageUrl(ref, {
    tabId: "tab",
    artifactUrl: () => "javascript:alert(1)",
  }), "");
});

test("识别图片、视频、音频、PDF、文本和普通文件", () => {
  assert.equal(classifyStoryMessageUrl("storydev:/reports/share.PNG"), "image");
  assert.equal(classifyStoryMessageUrl("storydev:/evidence/demo.webm"), "video");
  assert.equal(classifyStoryMessageUrl("storydev:/evidence/meeting.m4a"), "audio");
  assert.equal(classifyStoryMessageUrl(artifactUrl("tab", "storydev:/reports/review.pdf")), "pdf");
  assert.equal(classifyStoryMessageUrl("storydev:/reports/result.log"), "text");
  assert.equal(classifyStoryMessageUrl("https://example.com/result.json?download=1"), "text");
  assert.equal(classifyStoryMessageUrl("https://example.com/reviews/123"), "link");
  assert.equal(storyMessageFileName("storydev:/reports/%E6%8A%A5%E5%91%8A.pdf"), "报告.pdf");
  assert.equal(storyMessageArtifactRef(artifactUrl("tab", "storydev:/reports/review.pdf")), "storydev:/reports/review.pdf");
});

test("解析后的链接仍执行安全校验", () => {
  assert.equal(isStoryArtifactRef("storydev:/reports/result.png"), true);
  assert.equal(isSafeResolvedStoryMessageUrl("https://example.com/result"), true);
  assert.equal(isSafeResolvedStoryMessageUrl("/api/devbench/tabs/a/artifact?ref=x"), true);
  assert.equal(isSafeResolvedStoryMessageUrl("javascript:alert(1)"), false);
});

test("提取 AI 正文中的裸 storydev 产物引用且不重复 Markdown 富媒体", () => {
  const content = [
    "[已链接截图](storydev:/reports/linked.png)",
    "可下载：storydev:/reports/result.pdf。",
    "重复：storydev:/reports/result.pdf",
    "代码：`storydev:/reports/code.txt`",
    "非法：storydev:/reports/../secret.txt",
  ].join("\n");
  assert.deepEqual(extractBareStoryArtifactRefs(content), ["storydev:/reports/result.pdf"]);
  assert.deepEqual(extractStoryArtifactRefs(content), [
    "storydev:/reports/linked.png",
    "storydev:/reports/result.pdf",
    "storydev:/reports/code.txt",
  ]);
});

test("聊天与附件的浏览器产物链接必须先签发票据且不得保留原始 URL 旁路", () => {
  assert.match(storyTabSource, /useStoryArtifactUrls/);
  assert.match(attachmentListSource, /useStoryArtifactUrls/);
  assert.doesNotMatch(storyTabSource, /\bstoryArtifactUrl\b/);
  assert.doesNotMatch(attachmentListSource, /\bstoryArtifactUrl\b/);
  assert.match(
    attachmentListSource,
    /const href = isArtifact\s*\? \(localBlobPreview \|\| artifactHref\)\s*: \(attachment\.preview \|\| artifactHref\)/,
  );
  assert.match(artifactUrlsSource, /issueStoryArtifactTickets/);
  assert.match(artifactUrlsSource, /if \(access\.signature !== signature\) return ""/);
  assert.match(apiSource, /query\.set\("ticket", String\(ticket\)\)/);
  assert.match(apiSource, /\/artifact-tickets/);
});

test("只有 Desktop preload 外部打开桥接存在时才拦截原生链接", () => {
  assert.equal(hasStoryExternalBridge({ navigator: { userAgent: "Chrome" } }), false);
  assert.equal(
    hasStoryExternalBridge({ navigator: { userAgent: "Electron/37 ServiceControl" } }),
    false,
    "Service Control 依赖自身 windowOpenHandler，不能因 Electron UA 误拦截",
  );
  assert.equal(hasStoryExternalBridge({
    electronAPI: { cardev: { openExternal() {} } },
    navigator: { userAgent: "Electron/37 Desktop" },
  }), true);
});

test("只有携带甄别初步报告的 AI 回答气泡展示本地查看入口", () => {
  assert.match(storyTabSource, /const triageAnalysisReport = String\(msg\.triageAnalysisReport \|\| ""\)\.trim\(\)/);
  assert.match(storyTabSource, /data-testid="devbench-view-triage-analysis-report"/);
  assert.match(storyTabSource, /data-testid="devbench-triage-analysis-report"/);
  assert.match(storyTabSource, /className="relative z-40 mt-2 border-t border-cyan-500\/20 pt-2"/);
  assert.match(storyTabSource, /aria-expanded=\{analysisReportOpen\}/);
  assert.match(storyTabSource, /查看分析报告/);
  assert.match(storyTabSource, /<StoryMessageMarkdown[\s\S]*?\{triageAnalysisReport\}[\s\S]*?<\/StoryMessageMarkdown>/);
  assert.doesNotMatch(storyTabSource, /onGenerateTriageAnalysisReport|generateTriageAnalysisReport/);
});
