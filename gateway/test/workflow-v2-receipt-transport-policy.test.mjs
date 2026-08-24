import test from "node:test";
import assert from "node:assert/strict";

import {
  assertWorkflowV2ReceiptTransport,
  isWorkflowV2ReceiptRequiredStage,
} from "../services/devbench/workflow-v2/receipt-transport-policy.js";

test("structured REPAIR/VERIFY 只允许本地 API receipt transport", () => {
  for (const stageId of ["REPAIR", "VERIFY_EXECUTE"]) {
    assert.equal(isWorkflowV2ReceiptRequiredStage(stageId), true);
    assert.equal(assertWorkflowV2ReceiptTransport({ stageId, transport: "api" }), true);
    assert.throws(
      () => assertWorkflowV2ReceiptTransport({ stageId, transport: "cli" }),
      (error) => error.code === "WORKFLOW_V2_STRUCTURED_RECEIPT_CLI_UNSUPPORTED",
    );
    assert.throws(
      () => assertWorkflowV2ReceiptTransport({ stageId, transport: "api", remoteTarget: true }),
      (error) => error.code === "WORKFLOW_V2_STRUCTURED_RECEIPT_REMOTE_UNSUPPORTED",
    );
  }
});

test("TRIAGE 等只读 structured 阶段不受 receipt transport 限制", () => {
  for (const stageId of ["TRIAGE", "DIAGNOSE_PLAN", "INDEPENDENT_REVIEW", "REPORT_SHORT"]) {
    assert.equal(assertWorkflowV2ReceiptTransport({ stageId, transport: "cli" }), true);
    assert.equal(assertWorkflowV2ReceiptTransport({ stageId, transport: "remote", remoteTarget: true }), true);
  }
  assert.equal(assertWorkflowV2ReceiptTransport({
    stageId: "VERIFY_EXECUTE",
    promptMode: "compatibility",
    transport: "cli",
  }), true);
});

test("compatibility 正向 receipt 阶段在缺少本地 API RPC 时也于派发前失败关闭", () => {
  for (const transport of ["cli", "remote"]) {
    assert.throws(
      () => assertWorkflowV2ReceiptTransport({
        stageId: "REPAIR",
        promptMode: "compatibility",
        transport,
        remoteTarget: transport === "remote",
        receiptRequired: true,
      }),
      (error) => [
        "WORKFLOW_V2_STRUCTURED_RECEIPT_CLI_UNSUPPORTED",
        "WORKFLOW_V2_STRUCTURED_RECEIPT_REMOTE_UNSUPPORTED",
      ].includes(error.code),
    );
  }
});
