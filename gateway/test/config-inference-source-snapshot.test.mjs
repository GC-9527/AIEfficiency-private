import assert from "node:assert/strict";
import test from "node:test";

import {
  createInferenceSourceSnapshot,
  evaluateSourceCoverage,
  sanitizeSharedTrainingText,
  scanSharedSnapshotViolations,
} from "../services/devbench/machine-learn/source-snapshot.js";

test("required source 不完整时返回 NEED_MORE_INFO，optional 只降低完整度", () => {
  const absent = evaluateSourceCoverage({});
  assert.equal(absent.status, "NEED_MORE_INFO");
  assert.deepEqual(absent.missingRequired, ["detail"]);

  const blocked = evaluateSourceCoverage({
    detail: { available: true, complete: false, error: "partial" },
    comments: { available: false },
  });
  assert.equal(blocked.status, "NEED_MORE_INFO");
  assert.deepEqual(blocked.missingRequired, ["detail"]);

  const ready = evaluateSourceCoverage({
    detail: { available: true, complete: true },
    comments: { available: false },
  });
  assert.equal(ready.status, "READY");
  assert.ok(ready.completeness < 1);
});

test("共享文本脱敏 secret、PII、本机路径和设备序列号", () => {
  const sanitized = sanitizeSharedTrainingText(
    "api_key=secret123 user=a@example.com phone=13800138000 "
    + "path=D:\\workspace\\demo serialno=ABC123456 Bearer abcdefghijk",
  );
  assert.doesNotMatch(sanitized, /secret123|a@example\.com|13800138000|D:\\workspace|ABC123456|abcdefghijk/);
  assert.match(sanitized, /REDACTED_SECRET/);
  assert.match(sanitized, /REDACTED_MACHINE_PATH/);
  const json = sanitizeSharedTrainingText(
    '{"password":"top-secret","client_secret":"client-value","path":"/root/private"}',
  );
  assert.doesNotMatch(json, /top-secret|client-value|\/root\/private/);
});

test("不可变快照按 inferenceAt 截断未来评论和附件且不保存正文或 URL", () => {
  const snapshot = createInferenceSourceSnapshot({
    id: "TB-1",
    projectId: "P1",
    createdAt: "2026-01-01T00:00:00.000Z",
    title: "AppMarket P162",
    description: "日志 D:\\users\\admin\\secret.log",
    comments: [
      { id: "C1", createdAt: "2026-01-02T00:00:00.000Z", text: "创建时证据" },
      { id: "C2", createdAt: "2026-01-10T00:00:00.000Z", text: "修复后写明仓库" },
    ],
    attachments: [
      {
        id: "A1",
        createdAt: "2026-01-02T00:00:00.000Z",
        name: "log.txt",
        status: "parsed",
        text: "applicationId=com.example",
        contentHash: "abc",
        downloadUrl: "https://secret.invalid/token",
      },
      {
        id: "A2",
        createdAt: "2026-01-10T00:00:00.000Z",
        name: "solution.log",
        text: "future",
      },
    ],
    sourceCoverage: {
      detail: {
        available: true,
        complete: true,
        capturedAt: "2026-01-02T00:00:00.000Z",
      },
      comments: { available: true, complete: true },
      attachments: { available: true, complete: true },
    },
  }, {
    inferenceAt: "2026-01-05T00:00:00.000Z",
  });

  assert.equal(snapshot.ticket.comments.length, 1);
  assert.equal(snapshot.ticket.attachments.length, 1);
  assert.equal(snapshot.ticket.attachments[0].textSummary, "applicationId=com.example");
  assert.equal(snapshot.ticket.attachments[0].downloadUrl, undefined);
  assert.equal(snapshot.ticket.attachments[0].text, undefined);
  assert.deepEqual(snapshot.excludedFutureEvidence, { comments: 1, attachments: 1 });
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.ticket));
  assert.equal(scanSharedSnapshotViolations(snapshot).portable, true);
});

test("相同输入产生稳定 snapshotId，内容变化产生新 ID", () => {
  const ticket = {
    id: "TB-2",
    title: "stable",
    sourceCoverage: {
      detail: {
        available: true,
        complete: true,
        capturedAt: "2026-01-04T00:00:00.000Z",
      },
    },
  };
  const options = { inferenceAt: "2026-01-05T00:00:00.000Z" };
  const first = createInferenceSourceSnapshot(ticket, options);
  const second = createInferenceSourceSnapshot(ticket, options);
  const changed = createInferenceSourceSnapshot({ ...ticket, title: "changed" }, options);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.notEqual(first.snapshotId, changed.snapshotId);
});

test("缺少 availableAt/capturedAt 的历史正文不回填 ticket.createdAt 伪装时间合法", () => {
  const snapshot = createInferenceSourceSnapshot({
    id: "TB-MISSING-TIME",
    createdAt: "2020-01-01T00:00:00.000Z",
    comments: ["后来才抓到但无时间的评论"],
    attachments: [{ id: "A1", name: "late.log", text: "无时间正文" }],
    sourceCoverage: {
      detail: {
        available: true,
        complete: true,
        capturedAt: "2026-01-04T00:00:00.000Z",
      },
      comments: { available: true, complete: true },
      attachments: { available: true, complete: true },
    },
  }, {
    inferenceAt: "2026-01-05T00:00:00.000Z",
  });
  assert.deepEqual(snapshot.ticket.comments, []);
  assert.deepEqual(snapshot.ticket.attachments, []);
  assert.deepEqual(snapshot.excludedMissingTimeEvidence, { comments: 1, attachments: 1 });
  assert.equal(snapshot.sourceCoverage.comments.complete, false);
  assert.equal(snapshot.sourceCoverage.attachments.complete, false);
});

test("detail、note、tags 缺少可信时点或晚于 inferenceAt 时 fail closed 并移除正文", () => {
  const snapshot = createInferenceSourceSnapshot({
    id: "TB-SOURCE-TIME-GATE",
    title: "未来详情标题",
    description: "兼容字段中混入后来取得的 note",
    note: "后来取得的备注",
    tags: ["后来标签"],
    sourceCoverage: {
      detail: {
        available: true,
        complete: true,
        capturedAt: "2026-01-06T00:00:00.000Z",
      },
      note: {
        available: true,
        complete: true,
      },
      tags: {
        available: true,
        complete: true,
        capturedAt: "2026-01-07T00:00:00.000Z",
      },
    },
  }, {
    inferenceAt: "2026-01-05T00:00:00.000Z",
    requiredSources: ["detail"],
  });

  assert.equal(snapshot.sourceGate.passed, false);
  assert.ok(snapshot.sourceGate.missingRequired.includes("detail"));
  assert.equal(snapshot.sourceCoverage.note.complete, false);
  assert.equal(snapshot.sourceCoverage.tags.complete, false);
  assert.equal(snapshot.ticket.title, "");
  assert.equal(snapshot.ticket.description, "");
  assert.equal(snapshot.ticket.note, "");
  assert.deepEqual(snapshot.ticket.tags, []);
  assert.equal(snapshot.excludedFutureEvidence.detail, 1);
  assert.equal(snapshot.excludedFutureEvidence.tags, 1);
  assert.equal(snapshot.excludedMissingTimeEvidence.note, 1);
});

test("共享快照扫描能发现未脱敏的路径、secret 和附件正文", () => {
  const result = scanSharedSnapshotViolations({
    password: "topsecret",
    nested: { client_secret: "client-value", path: "/root/private" },
    attachments: [{ url: "https://example.test/private" }],
    local: "\\\\server\\share\\release",
    normalizedWindows: "D:/workspace/private/release",
  });
  assert.equal(result.portable, false);
  assert.ok(result.findings.includes("secret_assignment"));
  assert.ok(result.findings.includes("windows_path"));
  assert.ok(result.findings.includes("attachment_body"));
});

test("共享文本识别带空格的引号 secret 和常见 POSIX 机器路径，并保留 vault 引用", () => {
  const source = [
    'password = "top secret value"',
    "client_secret='client secret value'",
    "normalizedWindows=D:/workspace/private/release",
    "paths=/opt/company/app /workspace/project/repo /srv/runtime/data /tmp/local-output",
    "password=vault://team/story-ai/password",
    "vault://team/story-ai/api-key",
  ].join(" ");
  const sanitized = sanitizeSharedTrainingText(source);

  assert.doesNotMatch(sanitized, /top secret value|client secret value/);
  assert.doesNotMatch(sanitized, /D:\/workspace\/private/);
  assert.doesNotMatch(sanitized, /\/opt\/company|\/workspace\/project|\/srv\/runtime|\/tmp\/local-output/);
  assert.equal(sanitized.match(/\[REDACTED_SECRET\]/g)?.length, 2);
  assert.equal(sanitized.match(/\[REDACTED_MACHINE_PATH\]/g)?.length, 5);
  assert.match(sanitized, /password=vault:\/\/team\/story-ai\/password/);
  assert.match(sanitized, /vault:\/\/team\/story-ai\/api-key/);
  assert.equal(scanSharedSnapshotViolations(sanitized).portable, true);
  assert.equal(
    sanitizeSharedTrainingText("vault://team/story-ai/password"),
    "vault://team/story-ai/password",
  );
});

test("共享快照扫描与脱敏同源识别引号 secret、POSIX 路径，并豁免 vault 引用", () => {
  const unsafe = scanSharedSnapshotViolations({
    quoted: 'password: "top secret value"',
    singleQuoted: "client_secret='client secret value'",
    paths: ["/opt/company/app", "/workspace/project/repo", "/srv/runtime/data", "/tmp/local-output"],
    vaultText: "password=vault://team/story-ai/password",
    vaultField: "vault://team/story-ai/client-secret",
  });
  assert.equal(unsafe.portable, false);
  assert.ok(unsafe.findings.includes("secret_assignment"));
  assert.ok(unsafe.findings.includes("posix_machine_path"));

  const vaultOnly = scanSharedSnapshotViolations({
    password: "vault://team/story-ai/password",
    text: "password=vault://team/story-ai/password",
  });
  assert.deepEqual(vaultOnly, { portable: true, findings: [] });
});
