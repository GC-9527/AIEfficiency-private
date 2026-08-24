/**
 * llm-router 路由测试 —— 验证按 config 选引擎、各引擎错误码映射正确
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { callConfiguredLlm } from "../llm/llm-router.js";

function mkConfig(over = {}) {
  return {
    defaultEngine: "claude",
    apiEngines: {
      qwen: { enabled: false, baseUrl: "https://q.example", apiKey: "", model: "q1" },
      kimi: { enabled: false, baseUrl: "https://k.example", apiKey: "", model: "k1" },
    },
    anthropic: {},
    ...over,
  };
}

const FAKE_PROMPT = { system: "你是测试", messages: [{ role: "user", content: "ping" }] };

// ---------- 选引擎逻辑 ----------

test("router: enabled 的 apiEngine 优先（OpenAI 兼容路径）", async () => {
  let calledUrl = null, calledHeaders = null;
  const fakeFetch = async (url, opt) => {
    calledUrl = url;
    calledHeaders = opt.headers;
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const cfg = mkConfig({
    defaultEngine: "qwen",
    apiEngines: { qwen: { enabled: true, baseUrl: "https://qwen.local/v1", apiKey: "k_q", model: "qwen-turbo" } },
  });
  const r = await callConfiguredLlm({
    ...FAKE_PROMPT,
    _deps: { getConfig: () => cfg, fetch: fakeFetch },
  });
  assert.equal(calledUrl, "https://qwen.local/v1/chat/completions");
  assert.equal(calledHeaders.authorization, "Bearer k_q");
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.usage.input_tokens, 10);
  assert.equal(r.usage.output_tokens, 5);
});

test("router: defaultEngine='anthropic' 走 anthropic-client", async () => {
  let captured = null;
  const fakeAnthropic = async (opts) => {
    captured = opts;
    return { text: "anthropic-ok", usage: { input_tokens: 1 } };
  };
  const cfg = mkConfig({ defaultEngine: "anthropic", anthropic: { apiKey: "ak_inline" } });
  const r = await callConfiguredLlm({
    ...FAKE_PROMPT,
    _deps: { getConfig: () => cfg, callAnthropic: fakeAnthropic },
  });
  assert.equal(r.text, "anthropic-ok");
  assert.equal(captured.api_key, "ak_inline");
});

test("router: defaultEngine='claude' 走 CLI（mock spawn）", async () => {
  const proc = mockChildProc(0, '{"category":"代码问题"}', "");
  const fakeSpawn = (cmd, args, options) => {
    assert.equal(cmd, "claude");
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("--output-format"));
    assert.equal(options.windowsHide, true);
    return proc;
  };
  const cfg = mkConfig({ defaultEngine: "claude" });
  const r = await callConfiguredLlm({
    ...FAKE_PROMPT,
    _deps: { getConfig: () => cfg, spawn: fakeSpawn },
  });
  assert.equal(r.text, '{"category":"代码问题"}');
  assert.equal(r.raw.engine, "claude");
});

test("router: defaultEngine='hermes' 通过 oneshot 临时提示文件调用本地智能体", async () => {
  const proc = mockChildProc(0, "hermes-ok", "");
  let promptFile = "";
  const fakeSpawn = (cmd, args, options) => {
    assert.match(cmd, /hermes(?:\.exe)?$/i);
    assert.ok(args.includes("--oneshot"));
    const pointer = args[args.indexOf("--oneshot") + 1];
    assert.match(pointer, /Read the complete UTF-8 file/);
    const encodedPath = pointer.match(/at ("(?:\\.|[^"\\])+") before/)?.[1];
    assert.ok(encodedPath);
    promptFile = JSON.parse(encodedPath);
    assert.match(readFileSync(promptFile, "utf8"), /\[SYSTEM INSTRUCTIONS\][\s\S]*你是测试[\s\S]*\[USER INPUT\][\s\S]*ping/);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    return proc;
  };
  const cfg = mkConfig({ defaultEngine: "hermes", hermesEnabled: true });
  const r = await callConfiguredLlm({
    ...FAKE_PROMPT,
    _deps: { getConfig: () => cfg, spawn: fakeSpawn },
  });
  assert.equal(r.text, "hermes-ok");
  assert.equal(r.raw.engine, "hermes");
  assert.equal(existsSync(promptFile), false);
});

test("router: BUG_AGENT_ENGINE env 覆盖 config", async () => {
  const orig = process.env.BUG_AGENT_ENGINE;
  process.env.BUG_AGENT_ENGINE = "gemini";
  try {
    const proc = mockChildProc(0, "ok-gemini", "");
    const fakeSpawn = (cmd) => { assert.equal(cmd, "gemini"); return proc; };
    const r = await callConfiguredLlm({
      ...FAKE_PROMPT,
      _deps: { getConfig: () => mkConfig({ defaultEngine: "claude" }), spawn: fakeSpawn },
    });
    assert.equal(r.text, "ok-gemini");
  } finally {
    if (orig === undefined) delete process.env.BUG_AGENT_ENGINE;
    else process.env.BUG_AGENT_ENGINE = orig;
  }
});

test("router: 未知 engine 抛 UNKNOWN_ENGINE", async () => {
  const cfg = mkConfig({ defaultEngine: "totally-unknown" });
  await assert.rejects(
    callConfiguredLlm({ ...FAKE_PROMPT, _deps: { getConfig: () => cfg } }),
    (e) => e.code === "UNKNOWN_ENGINE"
  );
});

test("router: apiEngine 未启用时不走 API 路径", async () => {
  // qwen 在 config 但 enabled=false → 应该 fallback 到 CLI
  const proc = mockChildProc(0, "fallback-cli", "");
  const fakeSpawn = (cmd) => { assert.equal(cmd, "claude"); return proc; };
  const cfg = mkConfig({
    defaultEngine: "claude",
    apiEngines: { qwen: { enabled: false, baseUrl: "x", apiKey: "x", model: "x" } },
  });
  const r = await callConfiguredLlm({
    ...FAKE_PROMPT,
    _deps: { getConfig: () => cfg, spawn: fakeSpawn },
  });
  assert.equal(r.text, "fallback-cli");
});

// ---------- 错误码映射 ----------

test("router: API 429 → RATE_LIMIT", async () => {
  const fakeFetch = async () => new Response("rate", { status: 429 });
  const cfg = mkConfig({
    defaultEngine: "qwen",
    apiEngines: { qwen: { enabled: true, baseUrl: "https://q", apiKey: "k", model: "m" } },
  });
  await assert.rejects(
    callConfiguredLlm({ ...FAKE_PROMPT, _deps: { getConfig: () => cfg, fetch: fakeFetch } }),
    (e) => e.code === "RATE_LIMIT"
  );
});

test("router: API 503 → UPSTREAM_5XX", async () => {
  const fakeFetch = async () => new Response("oops", { status: 503 });
  const cfg = mkConfig({
    defaultEngine: "qwen",
    apiEngines: { qwen: { enabled: true, baseUrl: "https://q", apiKey: "k", model: "m" } },
  });
  await assert.rejects(
    callConfiguredLlm({ ...FAKE_PROMPT, _deps: { getConfig: () => cfg, fetch: fakeFetch } }),
    (e) => e.code === "UPSTREAM_5XX"
  );
});

test("router: API fetch reject → NETWORK", async () => {
  const fakeFetch = async () => { throw new Error("ECONNRESET"); };
  const cfg = mkConfig({
    defaultEngine: "qwen",
    apiEngines: { qwen: { enabled: true, baseUrl: "https://q", apiKey: "k", model: "m" } },
  });
  await assert.rejects(
    callConfiguredLlm({ ...FAKE_PROMPT, _deps: { getConfig: () => cfg, fetch: fakeFetch } }),
    (e) => e.code === "NETWORK"
  );
});

test("router: CLI exit 非零 → CLI_NONZERO", async () => {
  const proc = mockChildProc(1, "", "boom");
  const fakeSpawn = () => proc;
  const cfg = mkConfig({ defaultEngine: "claude" });
  await assert.rejects(
    callConfiguredLlm({ ...FAKE_PROMPT, _deps: { getConfig: () => cfg, spawn: fakeSpawn } }),
    (e) => e.code === "CLI_NONZERO" && e.exit_code === 1
  );
});

test("router: CLI ENOENT → CLI_NOT_FOUND", async () => {
  const fakeSpawn = () => {
    const p = mockChildProc(0, "", "", { delayError: true, errCode: "ENOENT" });
    return p;
  };
  const cfg = mkConfig({ defaultEngine: "claude" });
  await assert.rejects(
    callConfiguredLlm({ ...FAKE_PROMPT, _deps: { getConfig: () => cfg, spawn: fakeSpawn } }),
    (e) => e.code === "CLI_NOT_FOUND"
  );
});

// ---------- helpers ----------

function mockChildProc(exitCode, stdout, stderr, opt = {}) {
  const handlers = { close: [], error: [], data_out: [], data_err: [] };
  const stdin = { write: () => true, end: () => {}, on: () => {} };
  const proc = {
    stdout: { on: (e, cb) => { if (e === "data") handlers.data_out.push(cb); } },
    stderr: { on: (e, cb) => { if (e === "data") handlers.data_err.push(cb); } },
    stdin,
    kill: () => {},
    on: (e, cb) => { handlers[e] = handlers[e] || []; handlers[e].push(cb); },
  };
  setTimeout(() => {
    if (opt.delayError) {
      const err = new Error("ENOENT"); err.code = opt.errCode || "ENOENT";
      handlers.error.forEach((cb) => cb(err));
      return;
    }
    if (stdout) handlers.data_out.forEach((cb) => cb(Buffer.from(stdout)));
    if (stderr) handlers.data_err.forEach((cb) => cb(Buffer.from(stderr)));
    handlers.close.forEach((cb) => cb(exitCode));
  }, 5);
  return proc;
}
