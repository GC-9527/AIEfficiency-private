import { createHash, createHmac, timingSafeEqual } from "crypto";

export const AGENT_PROTOCOL_VERSION = "2.0";
export const AGENT_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export const AGENT_EVENT_TYPES = [
  "session_created",
  "turn_started",
  "thinking_delta",
  "text_delta",
  "tool_call",
  "tool_call_cancelled",
  "context_compacted",
  "usage",
  "final",
  "error",
];

export const TERMINAL_EVENT_TYPES = new Set(["final", "error"]);

const TOOL_ALIASES = {
  bash: "run_command",
  shell: "run_command",
  command: "run_command",
  run_bash: "run_command",
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  list: "list_dir",
  ls: "list_dir",
  finish: "final",
  finish_task: "final",
  done: "final",
};

const CONTROL_KEYS = new Set([
  "id",
  "callId",
  "call_id",
  "tool",
  "action",
  "name",
  "function",
  "tool_calls",
  "args",
  "arguments",
  "input",
  "parameters",
  "thought",
  "summary",
  "message",
  "final",
]);

export function normalizeToolName(name) {
  const raw = String(name || "").trim();
  return TOOL_ALIASES[raw] || raw;
}

export function toolDefinitionsToManifest(definitions = []) {
  return (Array.isArray(definitions) ? definitions : [])
    .map((tool) => tool?.function || tool)
    .filter((tool) => tool?.name)
    .map((tool) => ({
      name: String(tool.name),
      description: String(tool.description || ""),
      parameters: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} },
    }));
}

export function normalizeToolManifest(manifest = []) {
  const tools = Array.isArray(manifest) ? manifest : [];
  const out = [];
  const seen = new Set();
  for (const item of tools) {
    const fn = item?.function || item;
    const name = normalizeToolName(fn?.name);
    if (!name || seen.has(name) || name === "final") continue;
    seen.add(name);
    out.push({
      name,
      description: String(fn.description || ""),
      parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return out;
}

export function makeEvent(type, data = {}, id = 0) {
  if (!AGENT_EVENT_TYPES.includes(type)) throw new Error(`Unsupported Agent V2 event type: ${type}`);
  return { id, type, ts: Date.now(), data };
}

export function canonicalJson(value) {
  if (value == null) return "";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item) || "null").join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item) || "null"}`).join(",")}}`;
}

export function agentRequestSignature({ method = "GET", path = "/", timestamp = Date.now(), body = null, secret = "" } = {}) {
  const bodyHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const payload = [String(method || "GET").toUpperCase(), String(path || "/"), String(timestamp), bodyHash].join("\n");
  return createHmac("sha256", String(secret || "")).update(payload).digest("hex");
}

export function verifyAgentRequestSignature({ method = "GET", path = "/", timestamp, body = null, secret = "", signature = "", now = Date.now() } = {}) {
  const ts = Number(timestamp);
  if (!secret) return { ok: false, error: "missing signature secret" };
  if (!Number.isFinite(ts)) return { ok: false, error: "missing signature timestamp" };
  if (Math.abs(now - ts) > AGENT_SIGNATURE_WINDOW_MS) return { ok: false, error: "signature timestamp expired" };
  const expected = agentRequestSignature({ method, path, timestamp: ts, body, secret });
  const actual = String(signature || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(actual)) return { ok: false, error: "invalid signature format" };
  const ok = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
  return ok ? { ok: true } : { ok: false, error: "invalid signature" };
}

function firstJsonObject(text) {
  const source = String(text || "");
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const start = source.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const ch = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

function parseArgs(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeRawCall(raw, manifestNames) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.function && typeof raw.function === "object") {
    return normalizeRawCall({
      id: raw.id,
      name: raw.function.name,
      arguments: raw.function.arguments,
      thought: raw.thought,
    }, manifestNames);
  }
  const rawName = raw.tool || raw.action || raw.name;
  const name = normalizeToolName(rawName);
  if (!name) return null;
  if (name === "final") {
    return {
      type: "final",
      summary: String(raw.summary || raw.message || raw.final || raw.thought || "").trim(),
    };
  }
  if (manifestNames.size && !manifestNames.has(name) && name !== "run_bash") {
    return { type: "error", error: `Tool is not declared in manifest: ${name}` };
  }
  const fromBag = parseArgs(raw.args ?? raw.arguments ?? raw.input ?? raw.parameters);
  const args = { ...fromBag };
  for (const [key, value] of Object.entries(raw)) {
    if (!CONTROL_KEYS.has(key) && args[key] == null) args[key] = value;
  }
  return {
    type: "tool_call",
    id: String(raw.callId || raw.call_id || raw.id || ""),
    name,
    arguments: args,
    thought: String(raw.thought || "").slice(0, 500),
  };
}

export function parseAgentResponse(text, manifest = []) {
  const json = firstJsonObject(text);
  if (!json) return { type: "error", error: "Model did not return a JSON action", raw: String(text || "").slice(0, 1000) };
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (error) {
    return { type: "error", error: `Invalid JSON action: ${error.message}`, raw: json.slice(0, 1000) };
  }
  const manifestNames = new Set(normalizeToolManifest(manifest).map((tool) => tool.name));
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length) return normalizeRawCall(obj.tool_calls[0], manifestNames);
  if (obj.final != null && !obj.tool && !obj.action && !obj.name) {
    return { type: "final", summary: String(obj.final || obj.summary || obj.message || "").trim() };
  }
  return normalizeRawCall(obj, manifestNames) || { type: "error", error: "JSON action did not contain a supported tool call", raw: json.slice(0, 1000) };
}

export function normalizeToolResult(input = {}) {
  const result = input && typeof input === "object" ? input : { result: String(input ?? "") };
  const callId = String(result.callId || result.call_id || "");
  const status = String(result.status || (result.ok === false ? "failed" : "completed"));
  const ok = result.ok !== false && !["failed", "error", "timeout", "cancelled"].includes(status);
  return {
    callId,
    status: ok ? "completed" : status,
    ok,
    exitCode: result.exitCode ?? result.exit_code ?? null,
    stdout: result.stdout == null ? "" : String(result.stdout),
    stderr: result.stderr == null ? "" : String(result.stderr),
    result: result.result == null ? "" : String(result.result),
    truncated: !!result.truncated,
    nextCursor: result.nextCursor || result.next_cursor || null,
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
  };
}
