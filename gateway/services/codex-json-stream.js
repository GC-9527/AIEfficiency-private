function asString(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function joinStrings(parts) {
  return parts.map(asString).filter(Boolean).join("");
}

function textFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return asString(part.text)
        || asString(part.content)
        || asString(part.value)
        || asString(part.output_text)
        || textFromContent(part.parts);
    }).filter(Boolean).join("");
  }
  if (typeof content === "object") {
    return asString(content.text)
      || asString(content.content)
      || asString(content.value)
      || asString(content.output_text)
      || textFromContent(content.parts);
  }
  return "";
}

function reasoningText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(reasoningText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return asString(value.text)
      || asString(value.summary_text)
      || asString(value.content)
      || reasoningText(value.summary)
      || reasoningText(value.parts);
  }
  return "";
}

function commandLabel(item = {}) {
  const cmd = item.command || item.cmd || item.argv || item.args;
  if (Array.isArray(cmd)) return cmd.map(String).join(" ");
  if (cmd) return String(cmd);
  return asString(item.name) || asString(item.tool) || asString(item.title) || "";
}

function commandOutputText(event = {}, item = {}) {
  const parts = [];
  const seen = new Set();
  const add = (value, prefix = "") => {
    const text = typeof value === "string" ? value : textFromContent(value);
    const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
    if (!normalized || seen.has(`${prefix}${normalized}`)) return;
    seen.add(`${prefix}${normalized}`);
    parts.push(prefix ? `${prefix}${normalized}` : normalized);
  };
  add(item.output);
  add(item.stdout);
  add(item.stderr, "[stderr]\n");
  add(item.result);
  add(item.output_text);
  add(item.content);
  add(event.output);
  add(event.stdout);
  add(event.stderr, "[stderr]\n");
  return parts.join("\n");
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    inputTokens: raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens ?? 0,
    outputTokens: raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens ?? 0,
    cacheReadTokens: raw.cache_read_input_tokens ?? raw.cacheReadTokens ?? 0,
    cacheCreationTokens: raw.cache_creation_input_tokens ?? raw.cacheCreationTokens ?? 0,
    costUsd: raw.total_cost_usd ?? raw.costUsd ?? null,
  };
}

export function normalizeCodexJsonEvent(event) {
  const out = {
    text: [],
    thinking: [],
    tools: [],
    toolOutputs: [],
    finalText: "",
    sessionId: "",
    usage: null,
    turnCompleted: false,
  };
  if (!event || typeof event !== "object") return out;

  const type = String(event.type || event.event || event.kind || "");
  const lower = type.toLowerCase();
  out.turnCompleted = lower === "turn.completed" || lower === "turn_completed";
  const item = event.item || event.message || event.data || event.response || {};
  const itemType = String(item.type || item.kind || "").toLowerCase();
  const commandLike = itemType.includes("tool")
    || itemType.includes("command")
    || itemType.includes("exec")
    || lower.includes("tool")
    || lower.includes("exec")
    || lower.includes("command");

  out.sessionId = asString(event.session_id)
    || asString(event.sessionId)
    || asString(event.thread_id)
    || asString(event.threadId)
    || asString(item.session_id)
    || asString(item.sessionId)
    || asString(item.thread_id)
    || asString(item.threadId);
  out.usage = normalizeUsage(event.usage || item.usage || event.response?.usage);

  const delta = asString(event.delta)
    || asString(event.text_delta)
    || asString(event.output_text_delta)
    || asString(event.message_delta)
    || asString(item.delta);

  if (lower.includes("reasoning")) {
    const t = delta || reasoningText(event.summary) || reasoningText(item.summary) || reasoningText(event.text) || reasoningText(item.text);
    if (t) out.thinking.push(t);
  } else if (lower.includes("delta") && delta) {
    out.text.push(delta);
  }

  const directText = asString(event.text) || asString(event.output_text) || textFromContent(event.content);
  if (!lower.includes("delta") && !lower.includes("reasoning") && directText) {
    if (lower.includes("agent_message") || lower.includes("assistant") || lower.includes("message")) out.finalText = directText;
  }

  if (item && typeof item === "object") {
    if (itemType.includes("reasoning")) {
      const t = reasoningText(item.summary) || reasoningText(item.text) || reasoningText(item.content);
      if (t) out.thinking.push(t);
    } else if (
      itemType.includes("agent_message")
      || itemType.includes("assistant_message")
      || (itemType === "message" && (!item.role || item.role === "assistant"))
    ) {
      const t = asString(item.text) || asString(item.output_text) || textFromContent(item.content);
      if (t) out.finalText = t;
    }

    if (commandLike) {
      const label = commandLabel(item) || commandLabel(event);
      if (label) out.tools.push(label);
      const toolOutput = commandOutputText(event, item);
      if (toolOutput) out.toolOutputs.push(toolOutput);
    }
  }

  const finalText = asString(event.result)
    || asString(event.output)
    || asString(event.last_message)
    || asString(event.final_message)
    || textFromContent(event.output_message);
  if (finalText && !commandLike && (lower.includes("complete") || lower.includes("done") || lower.includes("result"))) {
    out.finalText = finalText;
  }

  out.text = out.text.filter(Boolean);
  out.thinking = [...new Set(out.thinking.filter(Boolean))];
  out.tools = [...new Set(out.tools.filter(Boolean))];
  out.toolOutputs = out.toolOutputs.filter(Boolean);
  return out;
}
