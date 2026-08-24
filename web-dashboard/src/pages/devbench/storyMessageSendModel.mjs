const text = (value) => String(value ?? "").trim();
const list = (value) => (Array.isArray(value) ? value : []);

function serverUserMessageId(result) {
  const nested = result?.data && typeof result.data === "object" ? result.data : {};
  const deeper = nested?.data && typeof nested.data === "object" ? nested.data : {};
  return text(result?.userMessageId || nested.userMessageId || deeper.userMessageId);
}

function serverAiPrompt(result) {
  const nested = result?.data && typeof result.data === "object" ? result.data : {};
  const deeper = nested?.data && typeof nested.data === "object" ? nested.data : {};
  return String(result?.aiPrompt || nested.aiPrompt || deeper.aiPrompt || "");
}

export function createOptimisticStoryMessage({
  clientMessageId,
  content,
  messageInput = null,
  timestamp = Date.now(),
} = {}) {
  const id = text(clientMessageId);
  const input = messageInput?.input && typeof messageInput.input === "object"
    ? messageInput.input
    : null;
  return {
    id,
    clientMessageId: id,
    role: "user",
    content: String(content ?? ""),
    displayContent: String(messageInput?.displayContent ?? input?.text ?? content ?? ""),
    input,
    delivery: "pending",
    localOnly: true,
    pending: true,
    ts: timestamp,
  };
}

export function settleOptimisticStoryMessage(messages, clientMessageId, result = {}) {
  const expectedId = text(clientMessageId);
  const ok = result?.ok === true;
  const persistedId = ok ? serverUserMessageId(result) : "";
  const delivery = result?.queued ? "queued" : result?.injected ? "injected" : "sent";
  return list(messages).map((message) => {
    if (text(message?.clientMessageId || message?.id) !== expectedId) return message;
    if (!ok) {
      return {
        ...message,
        delivery: "failed",
        localOnly: true,
        pending: false,
        sendError: text(result?.error) || "发送失败",
      };
    }
    return {
      ...message,
      ...(persistedId ? { id: persistedId } : {}),
      clientMessageId: expectedId,
      delivery,
      localOnly: !persistedId,
      pending: false,
      sendError: "",
      ...(serverAiPrompt(result) ? { aiPrompt: serverAiPrompt(result) } : {}),
    };
  });
}

export function isRetryableFailedStoryMessage(message, messageId = "") {
  if (!message || message.role !== "user") return false;
  if (text(message.id) !== text(messageId)) return false;
  return message.localOnly === true && message.delivery === "failed";
}
