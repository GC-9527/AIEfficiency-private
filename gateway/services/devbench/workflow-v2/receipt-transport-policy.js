const RECEIPT_REQUIRED_STAGES = new Set(["REPAIR", "VERIFY_EXECUTE"]);

export class WorkflowV2ReceiptTransportError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2ReceiptTransportError";
    this.code = code;
    this.statusCode = 409;
    this.terminalFailure = true;
    this.details = details;
  }
}

export function isWorkflowV2ReceiptRequiredStage(stageId) {
  return RECEIPT_REQUIRED_STAGES.has(String(stageId || "").trim().toUpperCase());
}

/**
 * Receipt-required structured stages may only run through the local API Agent.
 * CLI output and remote/center transcripts are not system evidence and must not
 * be upgraded into receipts.
 */
export function assertWorkflowV2ReceiptTransport({
  stageId,
  promptMode = "structured",
  transport,
  remoteTarget = false,
  receiptRequired = false,
} = {}) {
  const normalizedStage = String(stageId || "").trim().toUpperCase();
  if ((promptMode !== "structured" && receiptRequired !== true)
    || !isWorkflowV2ReceiptRequiredStage(normalizedStage)) return true;
  const normalizedTransport = String(transport || "").trim().toLowerCase();
  if (remoteTarget || normalizedTransport === "remote" || normalizedTransport === "center") {
    throw new WorkflowV2ReceiptTransportError(
      `${normalizedStage} 需要本机 Gateway 可信 receipt，当前远端/中心 transport 不受支持`,
      "WORKFLOW_V2_STRUCTURED_RECEIPT_REMOTE_UNSUPPORTED",
      { stageId: normalizedStage, transport: normalizedTransport || "remote" },
    );
  }
  if (normalizedTransport !== "api") {
    throw new WorkflowV2ReceiptTransportError(
      `${normalizedStage} 需要本机 API 工具 RPC 产出可信 receipt，CLI 文本不能作为证据`,
      "WORKFLOW_V2_STRUCTURED_RECEIPT_CLI_UNSUPPORTED",
      { stageId: normalizedStage, transport: normalizedTransport || "cli" },
    );
  }
  return true;
}
