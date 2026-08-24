import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-report-"));
process.env.GATEWAY_DB_PATH = path.join(tmp, "data.db");
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gateway.json");
process.env.DEVBENCH_CONFIG_PATH = path.join(tmp, "market.json");
process.env.DEVBENCH_LOCAL_PROJECTS_PATH = path.join(tmp, "local-projects.json");
process.env.DEVBENCH_STORE_DIR = path.join(tmp, "store");
process.env.AIEFFICIENCY_CLONE_PARENT = path.join(tmp, "clone-parent");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ servers: { nodeId: "code-review-report-test" } }));

const store = await import("../services/devbench/store.js");
const {
  buildCodeReviewReportHtml,
  codeReviewVerdict,
  generateCodeReviewArtifacts,
  parseCodeReviewCompletion,
  parseCodeReviewFindings,
  validateCodeReviewReport,
} = await import("../services/devbench/code-review-report.js");
const { configureNetworkIsolation } = await import("../services/devbench/report-pdf.js");

function completedReview(extra = "") {
  return `任务状态：已完成

当前问题
评审 commit abcdef123456 的真实 diff，并复核对应分支最新 tip 是否已经修复问题。

Findings
### 高严重度：跨 Flavor 空指针会阻断启动
- 当前状态：**仍存在**
- 文件与行号：app/src/main/java/demo/Startup.kt:42
- 证据：提交删除了公共判空，avatr 与 geely 共用该路径。
- 触发条件：服务返回空列表后进入启动页。
- 影响：两个 Flavor 都可能崩溃，必须修复后再合入。

### 中严重度：错误信息缺少上下文
- **当前状态：** 已在对应分支最新代码修复
- 修复证据：最新 tip def456 恢复了请求 id 与状态码。

已读取材料
- git show、git diff、Startup.kt、对应分支最新 tip 和单元测试输出均已实际读取。

未读取材料
- 本轮没有提供图片、视频、音频或设备日志，因此没有可读取的外部多媒体材料。

执行动作
- 只读检查提交差异、依赖调用方与其它 Flavor；运行编译和相关单元测试，未修改代码。

产出与改动
- 产出本评审结论；源码和配置均未修改，后续视觉产物由系统从同一正文生成。

影响与风险
- 高严重度问题仍会影响共享启动链路；未执行真机回归，设备行为仍有残余风险。

验证结果
- PASS：编译通过，15/15 单元测试通过。
- BLOCKED：没有目标设备，真机启动与跨 Flavor 安装未运行。

测试建议
- 修复后补充空列表单测，并在 avatr、geely 两个 release Flavor 做冷启动回归。
${extra}
<!-- CODE_REVIEW_DONE -->`;
}

test("完成标记与原始报告结构共同控制交付门禁", () => {
  const parsed = parseCodeReviewCompletion(completedReview());
  assert.equal(parsed.marker, true);
  assert.equal(parsed.completed, true);
  assert.deepEqual(parsed.missing, []);
  assert.doesNotMatch(parsed.cleaned, /CODE_REVIEW_DONE/);

  const noMarker = parseCodeReviewCompletion(completedReview().replace(/<!-- CODE_REVIEW_DONE -->/, ""));
  assert.equal(noMarker.marker, false);
  assert.equal(noMarker.completed, false);
  const markerOnlyMentionedInside = parseCodeReviewCompletion(
    completedReview().replace(
      /<!-- CODE_REVIEW_DONE -->$/,
      "\n正文中提到 <!-- CODE_REVIEW_DONE -->，但末尾还有未完成说明。",
    ),
  );
  assert.equal(markerOnlyMentionedInside.marker, false);
  assert.equal(markerOnlyMentionedInside.completed, false);

  const incomplete = validateCodeReviewReport("任务状态：已完成\n\n当前问题\n内容");
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.missing.includes("Findings"));

  const shell = completedReview()
    .replace(/评审 commit[\s\S]*?(?=\n\nFindings)/, "<待补充>")
    .replace(/### 高严重度[\s\S]*?(?=\n\n已读取材料)/, "<待补充>");
  const shellValidation = validateCodeReviewReport(shell);
  assert.equal(shellValidation.ok, false);
  assert.ok(shellValidation.missing.some((item) => item.startsWith("当前问题")));
  assert.ok(shellValidation.missing.some((item) => item.startsWith("Findings")));
});

test("评审执行已完成不等于代码通过，高严重度未解决会阻断合入", () => {
  const findings = parseCodeReviewFindings(completedReview());
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((finding) => finding.status), [
    "仍存在",
    "已在对应分支最新代码修复",
  ]);
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.active]), [
    ["high", true],
    ["medium", false],
  ]);
  const verdict = codeReviewVerdict(findings);
  assert.equal(verdict.key, "changes_requested");
  assert.equal(verdict.label, "阻断合入");
  assert.equal(codeReviewVerdict([{
    severity: "high",
    active: true,
    status: "无法验证最新分支",
  }]).key, "inconclusive");

  const aliasReport = completedReview().replace(
    /### 高严重度：跨 Flavor 空指针会阻断启动/,
    "严重问题：RCE 可执行任意代码",
  );
  assert.equal(parseCodeReviewFindings(aliasReport)[0].severity, "high");
  assert.equal(codeReviewVerdict(parseCodeReviewFindings(aliasReport)).key, "changes_requested");
  assert.equal(codeReviewVerdict([]).key, "inconclusive");

  const misleadingNoHigh = completedReview().replace(
    /### 高严重度[\s\S]*?(?=\n\n已读取材料)/,
    "无高风险问题，但存在中风险的数据一致性缺陷，当前状态：仍存在。",
  );
  const misleadingValidation = validateCodeReviewReport(misleadingNoHigh);
  assert.equal(misleadingValidation.ok, false);
  assert.ok(misleadingValidation.missing.some((item) => item.startsWith("Findings")));
});

test("Markdown 列表项中的当前状态可通过门禁并渲染为状态标签", () => {
  const parsed = parseCodeReviewCompletion(completedReview());
  assert.equal(parsed.completed, true);
  assert.equal(parsed.missing.includes("Findings（每条必须包含当前状态）"), false);

  const html = buildCodeReviewReportHtml({}, parsed.cleaned);
  assert.equal((html.match(/class="finding-status /g) || []).length, 2);
  assert.match(html, /class="finding-status is-active"/);
  assert.match(html, /class="finding-status is-resolved"/);
  assert.doesNotMatch(html, /状态未单独标注/);
});

test("完整报告转义不可信 HTML，且只保留安全 HTTP 链接", () => {
  const tab = {
    title: "评审 <script>alert(1)</script>",
    reviewContext: {
      kind: "git_commit",
      revision: "abcdef1234567890",
      shortRevision: "abcdef123456",
      repositoryName: "Demo",
      subject: "安全输出",
      inference: { branch: "feature/review", vehicle: "demo", flavor: "demo" },
    },
  };
  const report = completedReview(`
- [安全链接](https://example.com/review?a=1&b=2)
- ![外部证据](http://127.0.0.1:9/internal.png)
- [危险链接](javascript:alert(1))
- <script>window.pwned = true</script>`);
  const html = buildCodeReviewReportHtml(tab, report, new Date("2026-07-29T01:02:03.000Z"));
  assert.doesNotMatch(html, /<script>window\.pwned/);
  assert.match(html, /&lt;script&gt;window\.pwned/);
  assert.match(html, /href="https:\/\/example\.com\/review\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<img[^>]+127\.0\.0\.1/i);
  assert.match(html, /外部图片未自动加载/);
});

test("摘要图采用 AI 回答式紧凑长图，PDF 打印时只保留详细报告", () => {
  const tab = {
    title: "共享启动逻辑代码评审",
    reviewContext: {
      kind: "git_commit",
      revision: "abcdef1234567890",
      shortRevision: "abcdef123456",
      repositoryName: "Demo",
      subject: "检查多个 Flavor 的启动路径与回归风险",
      inference: { branch: "feature/review", vehicle: "demo", flavor: "demo" },
    },
  };
  const html = buildCodeReviewReportHtml(tab, completedReview(), new Date("2026-07-29T01:02:03.000Z"));
  assert.match(html, /data-review-summary/);
  assert.match(html, /<h1 class="summary-commit-title">Git Commit <code>abcdef123456<\/code> · 检查多个 Flavor 的启动路径与回归风险<\/h1>/);
  assert.ok(html.indexOf("summary-commit-title") < html.indexOf("summary-lead"));
  assert.match(html, /\.summary-commit-title\{[^}]*font-size:19px/);
  assert.match(html, /\.summary-commit-title code\{font-size:16px/);
  assert.match(html, /评审结论：/);
  assert.match(html, /发现 1 个高风险、1 个中风险/);
  assert.match(html, /文件与行号：app\/src\/main\/java\/demo\/Startup\.kt:42/);
  assert.match(html, /触发条件：服务返回空列表后进入启动页/);
  assert.match(html, /\.share-card\{width:1440px;height:auto/);
  assert.match(html, /font-size:17px/);
  assert.match(html, /@media print\{[^}]*body[^}]*\}\.share-card\{display:none!important\}/);
  assert.doesNotMatch(html, /height:1500px|font-size:58px|font-size:50px|risk-grid|Principal Engineering Review/);
});

test("摘要图最多展开三条 finding，其余内容引导查看详细 PDF", () => {
  const additional = [
    ["低严重度：日志缺少请求标识", "仍存在"],
    ["低严重度：回退提示不够明确", "仍存在"],
    ["低严重度：测试命名不一致", "已修复"],
  ].map(([title, status], index) => `
### ${title}
当前状态：${status}
- 证据：fixture-${index}
- 影响：仅影响定位效率。`).join("\n");
  const report = completedReview().replace("\n\n已读取材料", `${additional}\n\n已读取材料`);
  const html = buildCodeReviewReportHtml({}, report);
  assert.equal((html.match(/class="summary-finding /g) || []).length, 3);
  assert.match(html, /另有 2 条 finding 未在摘要图展开/);
  assert.match(html, /已读取材料/);
  assert.match(html, /未读取材料/);
});

test("PDF/PNG 隔离渲染只加载本地或内嵌资源", async () => {
  let handler = null;
  let interception = false;
  await configureNetworkIsolation({
    async setRequestInterception(value) { interception = value; },
    on(event, callback) { if (event === "request") handler = callback; },
  }, true);
  assert.equal(interception, true);
  assert.equal(typeof handler, "function");

  const decisions = [];
  const request = (url) => ({
    url: () => url,
    continue: () => decisions.push([url, "continue"]),
    abort: (reason) => decisions.push([url, `abort:${reason}`]),
  });
  handler(request("file:///D:/report.html"));
  handler(request("data:image/png;base64,AA=="));
  handler(request("http://127.0.0.1:3001/private"));
  handler(request("https://example.com/tracker.png"));
  assert.deepEqual(decisions, [
    ["file:///D:/report.html", "continue"],
    ["data:image/png;base64,AA==", "continue"],
    ["http://127.0.0.1:3001/private", "abort:blockedbyclient"],
    ["https://example.com/tracker.png", "abort:blockedbyclient"],
  ]);
});

test("从同一份正文保留原始 TXT，并生成 HTML/PDF/PNG 与清单引用", async () => {
  let tab = store.createTab({ title: "#REVIEW# 代码评审" });
  tab = store.updateTab(tab.id, {
    workMode: "code_review",
    reviewContext: {
      kind: "git_commit",
      revision: "abcdef1234567890",
      shortRevision: "abcdef123456",
      repositoryId: "demo",
      repositoryName: "Demo",
      subject: "修复共享启动逻辑",
      inference: { branch: "feature/review", vehicle: "demo", flavor: "demo" },
    },
  });
  const renderOptions = [];
  const writeRendered = async (_htmlPath, outputPath, options) => {
    renderOptions.push(options);
    fs.writeFileSync(outputPath, Buffer.from("rendered-artifact"));
  };
  const result = await generateCodeReviewArtifacts(tab, completedReview(), {
    generatedAt: new Date("2026-07-29T01:02:03.000Z"),
    renderPdf: writeRendered,
    renderPng: writeRendered,
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(Object.keys(result.artifacts).sort(), ["html", "image", "manifest", "original", "pdf"]);
  for (const item of Object.values(result.artifacts)) {
    assert.match(item.rel, /^storydev:\/reports\//);
    assert.equal(fs.existsSync(item.absPath), true);
  }
  assert.equal(
    fs.readFileSync(result.artifacts.original.absPath, "utf8"),
    parseCodeReviewCompletion(completedReview()).cleaned,
  );
  assert.equal(renderOptions.length, 2);
  assert.equal(renderOptions.every((options) => options?.blockNetwork === true), true);
  assert.deepEqual(renderOptions[1], {
    selector: "[data-review-share-card]",
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    blockNetwork: true,
  });
  const manifest = JSON.parse(fs.readFileSync(result.artifacts.manifest.absPath, "utf8"));
  assert.equal(manifest.reviewExecutionStatus, "completed");
  assert.equal(manifest.verdict.key, "changes_requested");
  assert.equal(manifest.artifacts.image.mimeType, "image/png");
});
