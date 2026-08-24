import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  runTbSyncSaga,
  tbSyncAttachmentKey,
  tbSyncCommentKey,
  tbSyncStatusKey,
} from "../services/devbench/workflow-v2/tb-sync-saga.js";

const STORY = "story-saga-001";
const REVISION = "r3";
const ATTACHMENT_SHA256 = "a".repeat(64);
const REMOTE_ATTACHMENT = { fileName: "report.pdf", sha256: ATTACHMENT_SHA256 };

function harness({
  comments = [],
  attachments = [],
  currentStatus = "待处理",
  failFindComments = false,
  failPost = false,
  postThenMissing = false,
  failFindAttachments = false,
  failUpload = false,
  uploadThenMissing = false,
  failCurrentStatus = false,
  failFlow = false,
  flowThenMissing = false,
} = {}) {
  const state = {
    comments: [...comments],
    attachments: [...attachments],
    current: currentStatus,
    calls: { postComment: 0, upload: 0, flow: 0, findComments: 0, findAttachments: 0, currentStatus: 0 },
  };
  const api = {
    postComment: async (text) => {
      state.calls.postComment += 1;
      if (failPost) throw new Error("post timeout");
      if (!postThenMissing) state.comments.push({ content: text });
    },
    findComments: async () => {
      state.calls.findComments += 1;
      if (failFindComments) throw new Error("comment lookup timeout");
      return state.comments;
    },
    uploadAttachment: async () => {
      state.calls.upload += 1;
      if (failUpload) return { ok: false, error: "upload ambiguous" };
      if (!uploadThenMissing) state.attachments.push({ ...REMOTE_ATTACHMENT });
      return { ok: true };
    },
    findAttachments: async () => {
      state.calls.findAttachments += 1;
      if (failFindAttachments) throw new Error("attachment lookup timeout");
      return state.attachments;
    },
    currentStatus: async () => {
      state.calls.currentStatus += 1;
      if (failCurrentStatus) throw new Error("status lookup timeout");
      return state.current;
    },
    flowStatus: async (target) => {
      state.calls.flow += 1;
      if (failFlow) throw new Error("flow timeout");
      if (!flowThenMissing) state.current = target;
      return { ok: true };
    },
  };
  return { api, state };
}

const BASE_OPTS = {
  storyId: STORY,
  tbTaskId: "tb-001",
  reportRevision: REVISION,
  shortReport: "原因：空指针未拦截\n措施：增加判空",
  attachment: { absPath: "C:/x/report.pdf", fileName: "report.pdf", sha256: ATTACHMENT_SHA256 },
  fromStatus: "待处理",
  allowedFromStatuses: ["待处理", "待确认", "修复中"],
  targetStatus: "可提测",
};

describe("M9 TB 同步 Saga（IDEM-002/SAGA-001）", () => {
  it("全部步骤成功并记录 ledger", async () => {
    const { api, state } = harness();
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, true);
    assert.equal(result.pending.length, 0);
    assert.equal(result.steps.comment.status, "done");
    assert.equal(result.steps.attachment.status, "done");
    assert.equal(result.steps.status.status, "done");
    assert.equal(state.calls.postComment, 1);
    assert.equal(state.calls.upload, 1);
    assert.equal(state.calls.flow, 1);
    assert.ok(result.ledger.comment.key.startsWith("comment:"));
    assert.ok(result.ledger.attachment.key.startsWith("attachment:"));
    assert.ok(result.ledger.status.key.startsWith("status:"));
  });

  it("相同 ledger 重放不产生任何重复写（IDEM-002）", async () => {
    const { api, state } = harness();
    const first = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(first.ok, true);
    const second = await runTbSyncSaga({ ...BASE_OPTS, api, ledger: first.ledger });
    assert.equal(second.ok, true);
    assert.equal(second.steps.comment.status, "replayed");
    assert.equal(second.steps.attachment.status, "replayed");
    assert.equal(second.steps.status.status, "replayed");
    assert.equal(state.calls.postComment, 1, "评论不得重复写");
    assert.equal(state.calls.upload, 1, "附件不得重复上传");
    assert.equal(state.calls.flow, 1, "状态不得重复流转");
  });

  it("评论写入失败 → pending_ambiguous，附件可补偿但状态被阻断", async () => {
    const { api, state } = harness({ failPost: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.ok(result.pending.includes("comment"));
    assert.equal(state.calls.postComment, 1, "失败后不得重试写");
    assert.equal(result.steps.attachment.status, "done");
    assert.equal(result.steps.status.status, "blocked");
    assert.equal(state.calls.flow, 0, "评论未确认时不得流转状态");
  });

  it("评论查重异常 → fail-closed，零评论写入且零状态流转", async () => {
    const { api, state } = harness({ failFindComments: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.comment.status, "pending_ambiguous");
    assert.equal(state.calls.postComment, 0, "查重失败后不得盲写评论");
    assert.equal(result.steps.status.status, "blocked");
    assert.equal(state.calls.flow, 0, "评论查重失败时不得流转状态");
  });

  it("附件查重异常 → fail-closed，零附件上传且零状态流转", async () => {
    const { api, state } = harness({ failFindAttachments: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.attachment.status, "pending_ambiguous");
    assert.equal(state.calls.upload, 0, "查重失败后不得盲传附件");
    assert.equal(result.steps.status.status, "blocked");
    assert.equal(state.calls.flow, 0, "附件查重失败时不得流转状态");
  });

  it("附件上传返回成功但远端未回读到同名同哈希 → pending 且不记 ledger", async () => {
    const { api, state } = harness({ uploadThenMissing: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.attachment.status, "pending_ambiguous");
    assert.equal(result.ledger.attachment, null);
    assert.equal(state.calls.upload, 1);
    assert.equal(state.calls.findAttachments, 2, "上传后必须再次远端回读");
    assert.equal(result.steps.status.status, "blocked");
    assert.equal(state.calls.flow, 0);
  });

  it("附件上传返回失败也要回读，未确认时保持 pending", async () => {
    const { api, state } = harness({ failUpload: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.attachment.status, "pending_ambiguous");
    assert.equal(state.calls.findAttachments, 2);
    assert.equal(result.ledger.attachment, null);
    assert.equal(state.calls.flow, 0);
  });

  it("附件远端仅同名或仅同哈希都不算查重命中", async () => {
    for (const existing of [
      { fileName: "report.pdf", sha256: "b".repeat(64) },
      { fileName: "other.pdf", sha256: ATTACHMENT_SHA256 },
    ]) {
      const { api, state } = harness({ attachments: [existing] });
      const result = await runTbSyncSaga({ ...BASE_OPTS, api });
      assert.equal(result.ok, true);
      assert.equal(result.steps.attachment.status, "done");
      assert.equal(state.calls.upload, 1, "必须以 filename + sha256 的精确对查重");
    }
  });

  it("附件缺少内容哈希 → blocked，零上传且零状态流转", async () => {
    const { api, state } = harness();
    const result = await runTbSyncSaga({
      ...BASE_OPTS,
      attachment: { ...BASE_OPTS.attachment, sha256: "" },
      api,
    });
    assert.equal(result.ok, false);
    assert.equal(result.steps.attachment.status, "blocked");
    assert.equal(state.calls.upload, 0);
    assert.equal(result.steps.status.status, "blocked");
    assert.equal(state.calls.flow, 0);
  });

  it("写入后回读未确认（模糊超时）→ pending，重试先远端查重不重复写", async () => {
    const { api, state } = harness({ postThenMissing: true });
    const first = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(first.ok, false);
    assert.ok(first.pending.includes("comment"));
    assert.equal(state.calls.postComment, 1);
    // 远端后来出现了该评论（人工或延迟可见）
    state.comments.push({ content: BASE_OPTS.shortReport });
    const second = await runTbSyncSaga({ ...BASE_OPTS, api, ledger: first.ledger });
    assert.equal(second.ok, true);
    assert.equal(second.steps.comment.status, "deduped_remote");
    assert.equal(state.calls.postComment, 1, "远端查重命中后不得再写");
  });

  it("评论/附件远端已存在 → deduped_remote，零写入", async () => {
    const { api, state } = harness({
      comments: [{ content: BASE_OPTS.shortReport }],
      attachments: [{ fileName: "report.pdf", sha256: ATTACHMENT_SHA256 }],
      currentStatus: "可提测",
    });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, true);
    assert.equal(result.steps.comment.status, "deduped_remote");
    assert.equal(result.steps.attachment.status, "deduped_remote");
    assert.equal(result.steps.status.status, "deduped_remote");
    assert.equal(state.calls.postComment, 0);
    assert.equal(state.calls.upload, 0);
    assert.equal(state.calls.flow, 0);
  });

  it("状态流转后回读未确认 → pending，本地不得推进", async () => {
    const { api, state } = harness({ flowThenMissing: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.ok(result.pending.includes("status"));
    assert.equal(state.calls.flow, 1);
    assert.equal(state.calls.currentStatus, 2, "状态写入后必须再次回读");
  });

  it("状态初始查重返回空值 → fail-closed，不执行流转", async () => {
    const { api, state } = harness({ currentStatus: null });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.status.status, "pending_ambiguous");
    assert.equal(state.calls.flow, 0);
  });

  it("状态初始查重异常 → fail-closed，不执行流转", async () => {
    const { api, state } = harness({ failCurrentStatus: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.status.status, "pending_ambiguous");
    assert.equal(state.calls.flow, 0);
  });

  it("状态写入异常 → pending 且不记 status ledger", async () => {
    const { api, state } = harness({ failFlow: true });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.status.status, "pending_ambiguous");
    assert.equal(state.calls.flow, 1);
    assert.equal(result.ledger.status, null);
  });

  it("当前状态不在允许集合 → blocked 且零流转", async () => {
    const { api, state } = harness({ currentStatus: "已关闭" });
    const result = await runTbSyncSaga({ ...BASE_OPTS, api });
    assert.equal(result.ok, false);
    assert.equal(result.steps.status.status, "blocked");
    assert.match(result.steps.status.reason, /当前状态不允许流转/);
    assert.equal(state.calls.flow, 0);
    assert.equal(result.ledger.status, null);
  });

  it("当前状态规范化后在允许集合，状态写后规范化为目标才记 done", async () => {
    const { api, state } = harness({ currentStatus: "处理中" });
    api.flowStatus = async () => {
      state.calls.flow += 1;
      state.current = "待测试";
      return { ok: true };
    };
    const canonicalizeStatus = (status) => ({ 处理中: "修复中", 待测试: "可提测" })[status] || null;
    const result = await runTbSyncSaga({ ...BASE_OPTS, canonicalizeStatus, api });
    assert.equal(result.ok, true);
    assert.equal(result.steps.status.status, "done");
    assert.equal(result.steps.status.canonicalFrom, "修复中");
    assert.equal(result.steps.status.canonicalTo, "可提测");
    assert.equal(state.calls.flow, 1);
    assert.equal(state.calls.currentStatus, 2);
  });

  it("当前状态规范化后已是目标 → deduped_remote 且零流转", async () => {
    const { api, state } = harness({ currentStatus: "待测试" });
    const result = await runTbSyncSaga({
      ...BASE_OPTS,
      canonicalizeStatus: (status) => status === "待测试" ? "可提测" : null,
      api,
    });
    assert.equal(result.ok, true);
    assert.equal(result.steps.status.status, "deduped_remote");
    assert.equal(state.calls.flow, 0);
  });

  it("幂等键确定性：相同输入产出相同键", () => {
    const content = "原因：x\n措施：y";
    const key1 = tbSyncCommentKey({ storyId: STORY, reportRevision: REVISION, content });
    const key2 = tbSyncCommentKey({ storyId: STORY, reportRevision: REVISION, content });
    assert.equal(key1, key2);
    assert.notEqual(key1, tbSyncCommentKey({ storyId: STORY, reportRevision: "r4", content }));
    assert.match(key1, /^comment:story-saga-001:r3:[a-f0-9]{64}$/);
    assert.match(tbSyncAttachmentKey({ storyId: STORY, reportRevision: REVISION, fileSha256: "a".repeat(64), fileName: "p.pdf" }), /^attachment:/);
    assert.match(tbSyncStatusKey({ storyId: STORY, fromStatus: "待处理", targetStatus: "可提测", reportRevision: REVISION }), /^status:story-saga-001:待处理->可提测:r3$/);
    const statusSetKey = tbSyncStatusKey({
      storyId: STORY,
      allowedFromStatuses: ["修复中", "待处理", "待确认", "待处理"],
      targetStatus: "可提测",
      reportRevision: REVISION,
    });
    assert.equal(statusSetKey, tbSyncStatusKey({
      storyId: STORY,
      allowedFromStatuses: ["待确认", "待处理", "修复中"],
      targetStatus: "可提测",
      reportRevision: REVISION,
    }), "允许状态集合的顺序和重复项不得改变 operation identity");
    assert.notEqual(statusSetKey, tbSyncStatusKey({
      storyId: STORY,
      allowedFromStatuses: ["待处理", "待确认"],
      targetStatus: "可提测",
      reportRevision: REVISION,
    }), "允许状态集合变化必须改变 operation identity");
  });

  it("缺 reportRevision 拒绝执行", async () => {
    const { api } = harness();
    await assert.rejects(
      () => runTbSyncSaga({ ...BASE_OPTS, reportRevision: "", api }),
      /reportRevision/,
    );
  });
});
