import { AsyncLocalStorage } from "node:async_hooks";

import { AppMarketError } from "./security.js";

export const DEFAULT_OPERATION_TIMEOUT_MS = 150_000;

const requestContext = new AsyncLocalStorage();

export function requestAbortError(signal) {
  if (signal?.reason instanceof AppMarketError) return signal.reason;
  return new AppMarketError("REQUEST_CANCELLED", "MCP 请求已取消");
}

export function currentRequestSignal() {
  return requestContext.getStore()?.signal;
}

export function throwIfRequestAborted() {
  const signal = currentRequestSignal();
  if (signal?.aborted) throw requestAbortError(signal);
}

export async function runWithRequestContext(
  extra,
  callback,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
) {
  const controller = new AbortController();
  const callerSignal = extra?.signal;
  const abortFromCaller = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        new AppMarketError("REQUEST_CANCELLED", "MCP 请求已取消")
      );
    }
  };
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        new AppMarketError(
          "OPERATION_TIMEOUT",
          "MCP 只读操作超过整体执行期限",
          { retryable: true }
        )
      );
    }
  }, operationTimeoutMs);

  try {
    if (controller.signal.aborted) {
      throw requestAbortError(controller.signal);
    }
    return await requestContext.run(
      { signal: controller.signal },
      callback
    );
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
