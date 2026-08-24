export function createControllerOperationKey(prefix = "git-controller") {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function bindPullLatestPreviewKeys(
  rows,
  keyFactory = () => createControllerOperationKey(),
) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (!row?.ok || row?.preview?.eligible === false) return row;
    const existing = String(row.idempotencyKey || "").trim();
    return {
      ...row,
      idempotencyKey: existing || String(keyFactory(row) || "").trim(),
    };
  });
}

export function mergePullLatestExecution(row, response) {
  return {
    ...row,
    executed: true,
    ok: response?.ok !== false,
    result: response?.data || response,
    resultCode: response?.code || "",
    error: response?.error || "",
  };
}

export function normalizeControllerIdempotencyKey(value) {
  return String(value || "").trim();
}

export function missingControllerIdempotencyKeyResult() {
  return {
    ok: false,
    code: "GIT_CONTROLLER_IDEMPOTENCY_KEY_REQUIRED",
    error: "执行请求缺少与预览绑定的幂等键，请重新预览后再试",
  };
}
