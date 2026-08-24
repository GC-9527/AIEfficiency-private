const CLAUDE_STREAM_ENGINES = new Set([
  "claude",
  "claude-volcengine",
  "claude-minimax",
  "claude-atlas",
]);

const CODEX_APP_SERVER_ENGINES = new Set([
  "codex",
  "codex-minimax",
  "codex-atlas",
]);

/**
 * Delivery capability is determined by the integration surface, never by a
 * model name. A provider may expose the same model through Claude Code, Codex
 * CLI, or a one-shot OpenAI-compatible API; only the first two can accept input
 * in an active turn.
 */
export function storyEngineDeliveryCapability(engine) {
  const id = String(engine || "").trim().toLowerCase();
  if (CLAUDE_STREAM_ENGINES.has(id)) {
    return { engine: id, realtimeAppend: true, protocol: "claude-stream-json" };
  }
  if (CODEX_APP_SERVER_ENGINES.has(id)) {
    return { engine: id, realtimeAppend: true, protocol: "codex-app-server-turn-steer" };
  }
  return { engine: id, realtimeAppend: false, protocol: "persistent-fifo-queue" };
}

export function persistedQueuedTabIds(tabs = []) {
  return (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => tab?.id && Array.isArray(tab.queue) && tab.queue.length > 0)
    .map((tab) => tab.id);
}

