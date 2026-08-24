import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReportPdfGate,
  buildReportRendererGate,
  renderShortReport,
} from "../services/devbench/workflow-v2/report-renderer.js";
import { loadTrustedRepairReportFacts } from "../services/devbench/workflow-v2/trusted-report-facts.js";
import { canonicalSha256 } from "../services/devbench/workflow-v2/envelope-store.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-v2-report-renderer-"));
const storyDir = path.join(tempRoot, "story");
const reportsDir = path.join(storyDir, "reports");
fs.mkdirSync(reportsDir, { recursive: true });

const STORY_ID = "story-report-gate-001";
const CONTEXT_ID = "ctx-report-gate-001";
const CONTEXT_REVISION = 2;
const HTML_REF = "storydev:/reports/acceptance-report.html";
const HTML_ABS = path.join(reportsDir, "acceptance-report.html");

const storageApi = {
  getTab: () => ({ id: STORY_ID }),
  updateTab: () => {},
  getConversation: () => ({ nodes: [] }),
  tabProjectPaths: () => [],
  getStoryStoragePaths: () => ({ storyDirectory: storyDir, reportsDirectory: reportsDir, docSlug: "story-report-gate-001" }),
  validateStoryStorageTarget: () => true,
};

function dispatchFixture() {
  return {
    stageId: "REPORT_EXPERT",
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    context: {
      story: { storyId: STORY_ID },
      output: { outputPath: HTML_REF },
      data: {
        reportFacts: {
          cause: "空指针未拦截",
          measure: "增加判空并补充回归测试",
          assetManifest: [],
        },
      },
    },
  };
}

function resultFixture({ htmlRef = HTML_REF } = {}) {
  return { status: "COMPLETED", htmlRef };
}

function gateOpts(result = resultFixture()) {
  return {
    tab: storageApi.getTab(),
    dispatch: dispatchFixture(),
    result,
    storageApi,
  };
}

function writeHtml(content) {
  fs.writeFileSync(HTML_ABS, content, "utf8");
}

function writePdf(name, content) {
  fs.writeFileSync(path.join(reportsDir, name), content, "utf8");
}

function repairResult({ cause = "空指针未拦截", measure = "增加判空并补充回归测试" } = {}) {
  return {
    schemaVersion: "repair-result-v2",
    contextId: CONTEXT_ID,
    contextRevision: CONTEXT_REVISION,
    idempotencyKey: "ctx-idempotency-report-gate-001",
    status: "COMPLETED",
    outcome: "FIXED",
    rootCause: "播放器回调未判空",
    changes: [{ rootId: "root-app", path: "src/player.js", summary: "增加空值保护", receiptIds: ["receipt-edit-001"] }],
    localChecks: [{ name: "unit", status: "PASS", receiptIds: ["receipt-test-001"] }],
    risks: [],
    remaining: [],
    userFriendlyCause: cause,
    userFriendlyMeasure: measure,
    changeSummary: "增加播放器回调保护",
    evidenceRead: [],
    evidenceUnread: [],
    nextStage: "LOCAL_GATE",
    summary: "修复完成",
  };
}

function repairRecord({ storyId = STORY_ID, revision = 1, result = repairResult() } = {}) {
  return {
    storyId,
    recordId: "stage-result",
    contextId: null,
    revision,
    payloadSchemaId: "https://example.local/schemas/stage-result-record-v1.json",
    payload: {
      schemaVersion: "stage-result-record-v1",
      storyId,
      recordRevision: revision,
      stageId: "REPAIR",
      resultSchemaId: "https://example.local/schemas/repair-result-v2.json",
      contextId: CONTEXT_ID,
      contextRevision: CONTEXT_REVISION,
      contextIdempotencyKey: "ctx-idempotency-report-gate-001",
      resultSha256: canonicalSha256(result),
      result,
    },
  };
}

function tabWithCommittedRepair(record) {
  const payload = record.payload;
  const result = payload.result;
  const commitSha = "a".repeat(40);
  const binding = {
    schemaVersion: "workflow-v2-git-settlement-v1",
    storyId: STORY_ID,
    stageId: "REPAIR",
    contextId: payload.contextId,
    contextRevision: payload.contextRevision,
    contextIdempotencyKey: payload.contextIdempotencyKey,
    resultSha256: payload.resultSha256,
    rootId: "root-app",
    repositoryId: "repo-app",
    expectedHead: "b".repeat(40),
    expectedBranch: "story/report-test",
    targetFlavor: "demo",
    changeSummary: result.changeSummary,
    declaredChanges: result.changes.map((entry) => entry.path).sort(),
    requiredCheckReceiptIds: result.localChecks.flatMap((entry) => entry.receiptIds).sort(),
    editStateSha256: "c".repeat(64),
    editStateVersionSha256: "d".repeat(64),
    editReceiptIds: result.changes.flatMap((entry) => entry.receiptIds).sort(),
  };
  const bindingSha256 = canonicalSha256(binding);
  return {
    id: STORY_ID,
    workflow: { fixShortReport: "原因：旧文本。措施：旧措施。" },
    worktree: {
      entries: [{
        repositoryId: "repo-app",
        branch: binding.expectedBranch,
        revision: commitSha,
        head: commitSha,
      }],
    },
    workflowV2Compatibility: {
      gitSettlement: {
        ...binding,
        bindingSha256,
        operationId: `workflow-v2-repair-commit:${bindingSha256}`,
        status: "COMMITTED",
        commitSha,
      },
    },
  };
}

async function trustedFacts(records, tab = null) {
  const latest = [...records]
    .filter((entry) => entry?.payload?.stageId === "REPAIR")
    .sort((left, right) => Number(right?.payload?.recordRevision || 0) - Number(left?.payload?.recordRevision || 0))[0];
  const selectedTab = tab || (latest
    ? tabWithCommittedRepair(latest)
    : { id: STORY_ID, workflow: { fixShortReport: "原因：旧文本。措施：旧措施。" } });
  return loadTrustedRepairReportFacts({ tab: selectedTab, readEnvelopes: async () => records });
}

describe("M7 程序化简短报告渲染（SHORT）", () => {
  it("只从当前故事最新的 receipt-gated REPAIR record 生成严格单行文案", async () => {
    const facts = await trustedFacts([
      repairRecord({ revision: 1, result: repairResult({ cause: "旧原因", measure: "旧措施" }) }),
      repairRecord({ revision: 9, result: repairResult({ cause: "空指针未拦截", measure: "增加判空" }) }),
    ]);
    const rendered = renderShortReport({ reportFacts: facts });
    assert.equal(rendered.ok, true);
    assert.equal(rendered.text, "原因：空指针未拦截。措施：增加判空。");
    assert.equal(Array.from(rendered.text).length <= 100, true);
    assert.equal(facts.recordRevision, 9);
  });

  it("普通 JSON、legacy fixShortReport、空或泛化事实均不能进入 v2 路径（RPT-001）", async () => {
    assert.equal(renderShortReport({ reportFacts: { cause: "空指针未拦截", measure: "增加判空" } }).ok, false);
    await assert.rejects(
      () => trustedFacts([], { id: STORY_ID, workflow: { fixShortReport: "原因：旧原因。措施：旧措施。" } }),
      { code: "WORKFLOW_V2_REPORT_FACTS_SOURCE_MISSING" },
    );
    await assert.rejects(
      () => trustedFacts([repairRecord({ result: repairResult({ cause: "原因", measure: "见上" }) })]),
      { code: "WORKFLOW_V2_REPORT_FACTS_INCOMPLETE" },
    );
  });

  it("超长可信原因/措施仍被稳定裁剪为 100 Unicode 字符内的唯一格式", async () => {
    const facts = await trustedFacts([repairRecord({ result: repairResult({ cause: "原".repeat(300), measure: "措".repeat(300) }) })]);
    const rendered = renderShortReport({ reportFacts: facts });
    assert.equal(rendered.ok, true);
    assert.equal(Array.from(rendered.text).length, 100);
    assert.match(rendered.text, /^原因：[^\r\n]+。措施：[^\r\n]+。$/u);
  });

  it("故事错绑、未接受 REPAIR record 或 result 篡改均拒绝", async () => {
    await assert.rejects(() => trustedFacts([repairRecord({ storyId: "other-story" })]), {
      code: "WORKFLOW_V2_REPORT_FACTS_RECORD_INVALID",
    });
    const incomplete = repairResult();
    incomplete.localChecks[0].status = "FAIL";
    await assert.rejects(() => trustedFacts([repairRecord({ result: incomplete })]), {
      code: "WORKFLOW_V2_REPORT_FACTS_REPAIR_NOT_ACCEPTED",
    });
    const tampered = repairRecord();
    tampered.payload.result.userFriendlyCause = "被篡改";
    await assert.rejects(() => trustedFacts([tampered]), {
      code: "WORKFLOW_V2_REPORT_FACTS_RECORD_INVALID",
    });
  });

  it("没有权威 Git 结算或结算 HEAD 漂移时拒绝生成报告事实", async () => {
    const record = repairRecord();
    await assert.rejects(
      () => trustedFacts([record], { id: STORY_ID, worktree: { entries: [] } }),
      { code: "WORKFLOW_V2_REPORT_FACTS_GIT_SETTLEMENT_MISSING" },
    );
    const stale = tabWithCommittedRepair(record);
    stale.worktree.entries[0].head = "c".repeat(40);
    stale.worktree.entries[0].revision = "c".repeat(40);
    await assert.rejects(() => trustedFacts([record], stale), {
      code: "WORKFLOW_V2_REPORT_FACTS_GIT_SETTLEMENT_STALE",
    });
  });
});

describe("M7 专家报告渲染门禁（RPT-002）", () => {
  it("HTML 缺失/空文件 → FAIL，不推进", () => {
    try { fs.unlinkSync(HTML_ABS); } catch {}
    const gate = buildReportRendererGate(gateOpts());
    assert.equal(gate.status, "FAIL");
    assert.equal(gate.storyId, STORY_ID);
    assert.equal(gate.contextId, CONTEXT_ID);
    assert.equal(gate.contextRevision, CONTEXT_REVISION);
    assert.equal(gate.htmlRef, HTML_REF);
    assert.ok(Object.isFrozen(gate));
  });

  it("正常自包含 HTML → PASS", () => {
    writeHtml("<html><body><h1>验收报告</h1><img src=\"assets/shot.png\"></body></html>");
    const gate = buildReportRendererGate(gateOpts());
    assert.equal(gate.status, "PASS");
  });

  it("外部链接 → FAIL", () => {
    writeHtml('<a href="https://example.com/x">link</a>');
    const gate = buildReportRendererGate(gateOpts());
    assert.equal(gate.status, "FAIL");
  });

  it("绝对本地路径/协议外链 → FAIL", () => {
    writeHtml('<img src="C:\\Users\\x\\shot.png">');
    assert.equal(buildReportRendererGate(gateOpts()).status, "FAIL");
    writeHtml('<img src="file:///C:/x.png">');
    assert.equal(buildReportRendererGate(gateOpts()).status, "FAIL");
  });

  it("assetManifest 标记存在但资产缺失 → FAIL", () => {
    const dispatch = dispatchFixture();
    dispatch.context.data.reportFacts.assetManifest = [
      { assetId: "shot-1", exists: true, localPath: "assets/shot.png" },
    ];
    writeHtml('<img src="assets/shot.png">');
    const gate = buildReportRendererGate({
      tab: storageApi.getTab(),
      dispatch,
      result: resultFixture(),
      storageApi,
    });
    assert.equal(gate.status, "FAIL");
    fs.mkdirSync(path.join(reportsDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(reportsDir, "assets", "shot.png"), "png-bytes", "utf8");
    const after = buildReportRendererGate({
      tab: storageApi.getTab(),
      dispatch,
      result: resultFixture(),
      storageApi,
    });
    assert.equal(after.status, "PASS");
  });

  it("门禁绑定真实 resultSha256，无法伪造", () => {
    writeHtml("<html>ok</html>");
    const gate = buildReportRendererGate(gateOpts());
    assert.equal(gate.status, "PASS");
    assert.equal(gate.resultSha256, canonicalSha256(resultFixture()));
    assert.ok(/^[a-f0-9]{64}$/.test(gate.resultSha256));
  });
});

describe("M7 专家报告 PDF 门禁（RPT-003）", () => {
  it("无 PDF → FAIL", () => {
    const gate = buildReportPdfGate(gateOpts());
    assert.equal(gate.status, "FAIL");
  });

  it("空文件/非 PDF 头 → FAIL", () => {
    writePdf("empty.pdf", "");
    assert.equal(buildReportPdfGate(gateOpts()).status, "FAIL");
    writePdf("empty.pdf", "not a pdf at all");
    assert.equal(buildReportPdfGate(gateOpts()).status, "FAIL");
  });

  it("合法 PDF（%PDF 头 + 结构 + EOF）→ PASS，检查任一候选命名", () => {
    const body = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 1 >>\nendobj\n%%EOF";
    writePdf("acceptance-report.pdf", body);
    assert.equal(buildReportPdfGate(gateOpts()).status, "PASS");
    fs.unlinkSync(path.join(reportsDir, "acceptance-report.pdf"));
    writePdf("验收报告_story-report-gate-001.pdf", body);
    assert.equal(buildReportPdfGate(gateOpts()).status, "PASS");
  });

  it("缺 EOF 标记 → FAIL", () => {
    for (const name of ["acceptance-report.pdf", "验收报告_story-report-gate-001.pdf"]) {
      try { fs.unlinkSync(path.join(reportsDir, name)); } catch {}
    }
    writePdf("acceptance-report.pdf", "%PDF-1.7\n<< /Type /Pages /Count 1 >>\nno-eof");
    assert.equal(buildReportPdfGate(gateOpts()).status, "FAIL");
  });
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
