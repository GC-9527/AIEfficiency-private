import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { devbenchApi } from "./api.js";
import {
  buildRemoteRewriteConfirmation,
  remoteRewriteImpactView,
} from "./repositoryProtectionModel.mjs";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function createLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function rewritePreview(overrides = {}) {
  const previousSha = "a".repeat(40);
  const candidateSha = "b".repeat(64);
  return {
    relationship: "REMOTE_REWIND",
    branch: "main",
    previewId: "preview-rewrite-1",
    previewVersion: 7,
    lastAcceptedSha: previousSha,
    candidateSha,
    rewriteImpact: {
      version: 1,
      previousSha,
      candidateSha,
      droppedCommitCount: 2,
      droppedCommits: [
        `${"c".repeat(40)} first dropped commit`,
        `${"d".repeat(64)} second dropped commit`,
      ],
      droppedCommitsTruncated: false,
      affectedStories: [
        { storyId: "CARB-12345", baseRevision: "e".repeat(64) },
      ],
      affectedStoriesTruncated: false,
      publishedCommitStatus: "PRESENT",
      publishedCommits: ["f".repeat(40)],
      publishedCommitsTruncated: false,
      publicationEvidenceId: "release-ledger:test",
      publicationEvidenceDigest: "2".repeat(64),
      approvalAllowed: true,
      digest: "1".repeat(64),
      ...(overrides.rewriteImpact || {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "rewriteImpact"),
    ),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
});

test("remote rewrite impact keeps full SHA values, returned lists and truncation in confirmation", () => {
  const preview = rewritePreview({
    rewriteImpact: {
      droppedCommitCount: 3,
      droppedCommitsTruncated: true,
      affectedStoriesTruncated: true,
      publishedCommitsTruncated: true,
      approvalAllowed: false,
    },
  });
  const impact = remoteRewriteImpactView(preview);
  const confirmation = buildRemoteRewriteConfirmation(preview);

  assert.equal(impact.approvalAllowed, false);
  assert.equal(impact.previousSha, "a".repeat(40));
  assert.equal(impact.candidateSha, "b".repeat(64));
  assert.equal(impact.droppedCommitCount, 3);
  assert.deepEqual(impact.droppedCommits, preview.rewriteImpact.droppedCommits);
  assert.deepEqual(impact.affectedStories, preview.rewriteImpact.affectedStories);
  assert.deepEqual(impact.publishedCommits, preview.rewriteImpact.publishedCommits);

  for (const exactValue of [
    preview.rewriteImpact.previousSha,
    preview.rewriteImpact.candidateSha,
    ...preview.rewriteImpact.droppedCommits,
    preview.rewriteImpact.affectedStories[0].storyId,
    preview.rewriteImpact.affectedStories[0].baseRevision,
    preview.rewriteImpact.publishedCommitStatus,
    ...preview.rewriteImpact.publishedCommits,
    preview.rewriteImpact.publicationEvidenceId,
    preview.rewriteImpact.publicationEvidenceDigest,
    preview.rewriteImpact.digest,
  ]) {
    assert.ok(confirmation.includes(exactValue), exactValue);
  }
  assert.match(confirmation, /丢失提交总数：3/);
  assert.match(confirmation, /丢失提交返回列表：2 项；已截断/);
  assert.match(confirmation, /受影响故事返回列表：1 项；已截断/);
  assert.match(confirmation, /发布提交返回列表：1 项；已截断/);
  assert.match(confirmation, /精确正命中，不代表当前已发布提交全集/);
});

test("published commit status UNKNOWN explicitly blocks remote rewrite approval", () => {
  const impact = remoteRewriteImpactView(rewritePreview({
    rewriteImpact: {
      publishedCommitStatus: "UNKNOWN",
      publishedCommits: [],
      approvalAllowed: true,
    },
  }));

  assert.equal(impact.approvalAllowed, false);
  assert.ok(
    impact.approvalBlockers.some((message) => message.includes("UNKNOWN")),
    impact.approvalBlockers,
  );
});

test("known publication status without authoritative evidence identity is rejected", () => {
  const impact = remoteRewriteImpactView(rewritePreview({
    rewriteImpact: {
      publicationEvidenceId: "",
      publicationEvidenceDigest: "",
    },
  }));

  assert.equal(impact.approvalAllowed, false);
  assert.ok(
    impact.contractErrors.some((message) => message.includes("权威发布证据")),
    impact.contractErrors,
  );
});

test("complete rewrite impact with a positive Controller decision remains approvable", () => {
  const impact = remoteRewriteImpactView(rewritePreview());

  assert.equal(impact.approvalAllowed, true);
  assert.deepEqual(impact.approvalBlockers, []);
});

test("missing or inconsistent rewrite impact fails closed", () => {
  const missing = remoteRewriteImpactView({
    relationship: "DIVERGED_FROM_ACCEPTED",
    lastAcceptedSha: "a".repeat(40),
    candidateSha: "b".repeat(40),
  });
  assert.equal(missing.approvalAllowed, false);
  assert.ok(missing.contractErrors.length > 0);

  const mismatched = remoteRewriteImpactView(rewritePreview({
    rewriteImpact: { candidateSha: "9".repeat(64) },
  }));
  assert.equal(mismatched.approvalAllowed, false);
  assert.ok(mismatched.contractErrors.some((message) => message.includes("不一致")));
});

test("remote rewrite execute API forwards the approved impact digest unchanged", async () => {
  globalThis.window = { location: new URL("https://panel.example/devbench") };
  globalThis.localStorage = createLocalStorage();
  let request = null;
  globalThis.fetch = async (input, init = {}) => {
    request = { input: String(input), init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { accepted: true } }),
    };
  };

  const preview = rewritePreview();
  const response = await devbenchApi.executeRemoteRefresh(
    "repository-main",
    preview,
    "rewrite-execute-1",
    {
      approvalId: "approval-rewrite-1",
      approvedAt: 1000,
      expiresAt: 2000,
      relationship: preview.relationship,
      previewId: preview.previewId,
      previewVersion: preview.previewVersion,
      previousSha: preview.rewriteImpact.previousSha,
      candidateSha: preview.rewriteImpact.candidateSha,
      impactDigest: preview.rewriteImpact.digest,
    },
  );

  assert.equal(response.ok, true);
  assert.match(request.input, /\/api\/devbench\/repositories\/repository-main\/remote-refresh\/execute$/);
  const body = JSON.parse(request.init.body);
  assert.equal(body.adminApprovedImpactDigest, preview.rewriteImpact.digest);
  assert.equal(body.adminApprovedPreviousSha, preview.rewriteImpact.previousSha);
  assert.equal(body.adminApprovedCandidateSha, preview.rewriteImpact.candidateSha);
  assert.equal(body.idempotencyKey, "rewrite-execute-1");
  assert.equal(new Headers(request.init.headers).get("Idempotency-Key"), "rewrite-execute-1");
});
