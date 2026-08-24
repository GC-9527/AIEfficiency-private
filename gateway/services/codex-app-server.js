import { EventEmitter } from "node:events";
import { createUtf8StreamDecoder } from "./utf8-stream-decoder.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function protocolError(error, method = "") {
  const message = error?.message || String(error || "Codex app-server 请求失败");
  const wrapped = new Error(method ? `${method}: ${message}` : message);
  wrapped.code = error?.code;
  wrapped.data = error?.data;
  return wrapped;
}

/**
 * Write one JSONL protocol message and resolve only after Node reports that the
 * bytes were flushed (or failed). A false return from stream.write() is merely
 * backpressure, not a rejected write.
 */
export function writeJsonLine(stream, payload) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || stream.writableEnded || stream.writable === false) {
      reject(new Error("Codex app-server stdin 已关闭"));
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.off?.("error", onError);
      if (error) reject(error);
      else resolve(true);
    };
    const onError = (error) => finish(error || new Error("Codex app-server stdin 写入失败"));
    stream.once?.("error", onError);
    try {
      // Do not inspect the boolean return value: false means accepted with
      // backpressure. The callback is the authoritative delivery result.
      stream.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => finish(error));
    } catch (error) {
      finish(error);
    }
  });
}

function defaultServerRequestResult(method) {
  if (method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "applyPatchApproval"
    || method === "execCommandApproval") {
    return { decision: "decline" };
  }
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null };
  if (method === "item/permissions/requestApproval") return { permissions: {} };
  return null;
}

/**
 * Minimal version-matched JSONL client for `codex app-server --stdio`.
 * It deliberately exposes notifications unchanged so agent-runner remains the
 * single place that maps engine events to the dashboard's chat_stream model.
 */
export class CodexAppServerClient extends EventEmitter {
  constructor(proc, { requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    super();
    this.proc = proc;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stdoutDecoder = createUtf8StreamDecoder();
    this.stderrDecoder = createUtf8StreamDecoder();
    this.closed = false;

    proc.stdout?.on("data", (chunk) => this.#handleStdout(chunk));
    proc.stderr?.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : this.stderrDecoder.write(chunk);
      if (text) this.emit("stderr", text);
    });
    proc.once?.("error", (error) => this.#close(error));
    proc.once?.("close", (code, signal) => {
      const stdoutTail = this.stdoutDecoder.end();
      if (stdoutTail) this.#handleStdoutText(stdoutTail);
      const stderrTail = this.stderrDecoder.end();
      if (stderrTail) this.emit("stderr", stderrTail);
      this.#close(new Error(`Codex app-server 已退出（code=${code ?? "null"}, signal=${signal || "none"}）`));
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "aiefficiency_story_web",
        title: "AIEfficiency Story Point Web",
        version: "1.0.0",
      },
      // runtimeWorkspaceRoots is experimental in current Codex schemas; opt in
      // explicitly so associated projects remain available on every OS.
      capabilities: { experimentalApi: true },
    });
    await this.notify("initialized");
    return result;
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error("Codex app-server 连接已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: 等待 Codex app-server 响应超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      writeJsonLine(this.proc.stdin, { method, id, params }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(protocolError(error, method));
      });
    });
  }

  notify(method, params) {
    if (this.closed) return Promise.reject(new Error("Codex app-server 连接已关闭"));
    return writeJsonLine(this.proc.stdin, params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    return writeJsonLine(this.proc.stdin, { id, result });
  }

  respondError(id, message, code = -32601) {
    return writeJsonLine(this.proc.stdin, { id, error: { code, message } });
  }

  async startThread({
    cwd,
    model = "",
    modelProvider = "",
    effort = "",
    readOnly = false,
    workspaceRoots = [],
  } = {}) {
    const params = {
      cwd,
      approvalPolicy: "never",
      sandbox: readOnly ? "read-only" : "danger-full-access",
      ephemeral: true,
      runtimeWorkspaceRoots: [...new Set([cwd, ...workspaceRoots].filter(Boolean))],
    };
    if (model) params.model = model;
    if (modelProvider) params.modelProvider = modelProvider;
    let response;
    try {
      response = await this.request("thread/start", params);
    } catch (error) {
      // Older Codex app-server releases can support turn/steer while predating
      // runtimeWorkspaceRoots. Retry once without only that optional field;
      // cwd/sandbox/approval semantics remain unchanged and no turn has started.
      if (!params.runtimeWorkspaceRoots?.length
        || !/runtimeWorkspaceRoots|runtime_workspace_roots|experimental.{0,40}(?:field|api)/i.test(error?.message || "")) {
        throw error;
      }
      const compatibleParams = { ...params };
      delete compatibleParams.runtimeWorkspaceRoots;
      response = await this.request("thread/start", compatibleParams);
      this.workspaceRootsDowngraded = true;
    }
    const threadId = String(response?.thread?.id || "").trim();
    if (!threadId) throw new Error("thread/start 未返回 thread.id");
    this.threadId = threadId;
    this.defaultEffort = effort || "";
    return response;
  }

  async startTurn(text, { imagePaths = [], clientUserMessageId = "" } = {}) {
    if (!this.threadId) throw new Error("Codex app-server thread 尚未创建");
    const input = [{ type: "text", text: String(text || "") }];
    for (const imagePath of imagePaths) {
      if (imagePath) input.push({ type: "localImage", path: imagePath });
    }
    const params = { threadId: this.threadId, input };
    if (this.defaultEffort) params.effort = this.defaultEffort;
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    const response = await this.request("turn/start", params);
    const turnId = String(response?.turn?.id || "").trim();
    if (!turnId) throw new Error("turn/start 未返回 turn.id");
    this.turnId = turnId;
    return response;
  }

  async steer(text, { clientUserMessageId = "" } = {}) {
    if (!this.threadId || !this.turnId || this.activeTurnId !== this.turnId) {
      throw new Error("Codex 当前没有可追加的活动 turn");
    }
    const params = {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: [{ type: "text", text: String(text || "") }],
    };
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    const response = await this.request("turn/steer", params);
    if (String(response?.turnId || "") !== this.turnId) {
      throw new Error("turn/steer 返回了不匹配的 turnId");
    }
    return response;
  }

  interrupt() {
    if (!this.threadId || !this.turnId || this.closed) return Promise.resolve({});
    return this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.turnId,
    }, { timeoutMs: 5_000 });
  }

  #handleStdout(chunk) {
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    if (text) this.#handleStdoutText(text);
  }

  #handleStdoutText(text) {
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.emit("protocolError", new Error(`Codex app-server 返回了无效 JSONL: ${trimmed.slice(0, 300)}`));
        continue;
      }
      this.emit("activity", message);
      if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(protocolError(message.error, pending.method));
        else pending.resolve(message.result);
        continue;
      }
      if (message.method && Object.hasOwn(message, "id")) {
        const fallback = defaultServerRequestResult(message.method);
        this.emit("serverRequest", message);
        const response = fallback == null
          ? this.respondError(message.id, `AIEfficiency 不支持服务端请求 ${message.method}`)
          : this.respond(message.id, fallback);
        response.catch((error) => this.emit("protocolError", error));
        continue;
      }
      if (message.method) {
        if (message.method === "turn/started" && message.params?.turn?.id) {
          this.activeTurnId = String(message.params.turn.id);
          this.turnId = this.activeTurnId;
        } else if (message.method === "turn/completed") {
          const completedTurnId = String(message.params?.turn?.id || "");
          if (!completedTurnId || completedTurnId === this.activeTurnId) this.activeTurnId = "";
        }
        this.emit("notification", message.method, message.params || {});
      }
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
}
