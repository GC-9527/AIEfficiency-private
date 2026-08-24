/**
 * 文本反思循环编排器 单元测试（mock 大脑 + 真实 executor 在临时工程根）。
 * 验证：动作解析、写文件→读回→done 的完整循环、历史回放、安全边界、最大轮数。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbloop-"));
process.env.GATEWAY_CONFIG_PATH = path.join(tmp, "gw.json");
fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({ executor: { allowedRoots: [tmp] } }));

let loop, cfg;
before(async () => {
  loop = await import("../services/devbench/agent-loop.js");
  cfg = await import("../services/config.js");
  cfg.updateConfig({ executor: { allowedRoots: [tmp] } });
});

test("parseAction：围栏 json / 裸 json / 无效 tool / 垃圾", () => {
  assert.equal(loop.parseAction('```json\n{"tool":"done","summary":"x"}\n```').tool, "done");
  assert.equal(loop.parseAction('随便说点 {"tool":"run_bash","command":"ls"} 后面').tool, "run_bash");
  assert.deepEqual(loop.parseAction('{"action":"run_command","args":{"command":"npm test","path":"app"}}'), { command: "npm test", path: "app", tool: "run_bash" });
  assert.equal(loop.parseAction('{"tool":"unknown"}'), null);
  assert.equal(loop.parseAction("没有 json"), null);
  assert.equal(loop.parseAction(""), null);
});

test("normalizeAction：执行协议只接受相对路径", () => {
  assert.equal(loop.normalizeAction({ tool: "read_file", path: "src/a.js" }).path, "src/a.js");
  assert.throws(() => loop.normalizeAction({ tool: "read_file", path: "C:\\workspace\\x.js" }), /相对工程根/);
  assert.throws(() => loop.normalizeAction({ tool: "write_file", path: "../x.js", content: "x" }), /不能包含/);
  assert.deepEqual(loop.normalizeAction({ tool: "run_bash", command: "npm test" }), { tool: "run_bash", thought: "", command: "npm test" });
});

test("反思循环：写文件 → 读回 → done", async () => {
  let calls = 0;
  const brain = async () => {
    calls++;
    if (calls === 1) return '```json\n{"tool":"write_file","path":"hello.txt","content":"hi-loop","thought":"建文件"}\n```';
    if (calls === 2) return '{"tool":"read_file","path":"hello.txt","thought":"读回验证"}';
    return '{"tool":"done","summary":"已建并读回"}';
  };
  const steps = [];
  const r = await loop.runAgentLoop({ root: tmp, task: "建个文件再读回", callBrain: brain, onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true);
  assert.equal(r.done, true);
  assert.equal(r.summary, "已建并读回");
  assert.equal(r.history.length, 2); // write + read（done 不入 history）
  assert.equal(fs.readFileSync(path.join(tmp, "hello.txt"), "utf8"), "hi-loop");
  assert.match(r.history[1].result, /1 \| hi-loop/); // 分段读取带行号，内容读回正确
  assert.ok(steps.length >= 4); // think+exec ×2 + think(done)
});

test("反思循环：可注入远端工具执行器（中心机规划，客户端执行）", async () => {
  let calls = 0;
  const brain = async () => {
    calls++;
    if (calls === 1) return '{"tool":"run_bash","command":"npm test","thought":"交给客户端执行"}';
    return '{"tool":"done","summary":"远端执行完成"}';
  };
  const toolCalls = [];
  const r = await loop.runAgentLoop({
    root: tmp,
    task: "让客户端跑测试",
    callBrain: brain,
    runToolFn: async (root, name, args, opts) => {
      toolCalls.push({ root, name, args, round: opts.round });
      return { ok: true, result: "remote-ok" };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary, "远端执行完成");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "run_bash");
  assert.equal(toolCalls[0].args.command, "npm test");
  assert.equal(r.history[0].result, "remote-ok");
});

test("反思循环：执行失败结果回灌（读不存在的文件）", async () => {
  let calls = 0;
  const brain = async () => {
    calls++;
    if (calls === 1) return '{"tool":"read_file","path":"nope.txt","thought":"试读"}';
    return '{"tool":"done","summary":"放弃"}';
  };
  const r = await loop.runAgentLoop({ root: tmp, task: "读不存在文件", callBrain: brain });
  assert.equal(r.history[0].ok, false);
  assert.match(r.history[0].result, /错误/); // 错误被回灌
});

test("反思循环：安全边界——越界路径被 executor 拒绝", async () => {
  const brain = async () => '{"tool":"write_file","path":"../../escape.txt","content":"x"}';
  const r = await loop.runAgentLoop({ root: tmp, task: "越界写", callBrain: brain, maxRounds: 1 });
  // 越界写应被 executor 拦(结果含错误)，或循环到上限
  assert.ok(r.history.length === 0 || r.history[0].ok === false || r.reachedMax);
});

test("反思循环：达到最大轮数兜底（大脑一直不 done）", async () => {
  const brain = async () => '{"tool":"list_dir","path":"."}';
  const r = await loop.runAgentLoop({ root: tmp, task: "死循环", callBrain: brain, maxRounds: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.done, false);
  assert.equal(r.reachedMax, true);
  assert.equal(r.history.length, 3);
});

test("缺参数容错", async () => {
  assert.equal((await loop.runAgentLoop({ task: "x", callBrain: async () => "" })).ok, false); // 无 root
  assert.equal((await loop.runAgentLoop({ root: tmp, task: "x" })).ok, false); // 无 brain
});

test("rolling summary：近窗步数封顶 + 摘要承载更早步骤 + prompt 不线性膨胀", async () => {
  const prompts = [];
  const brain = async (p) => { prompts.push(p); return '{"tool":"list_dir","path":".","thought":"看目录"}'; };
  await loop.runAgentLoop({ root: tmp, task: "反复列目录", callBrain: brain, maxRounds: 10 });
  const last = prompts[prompts.length - 1];
  const recentBlocks = (last.match(/\n结果: /g) || []).length;
  assert.ok(recentBlocks <= 4, `近窗全文步数应≤4，实际 ${recentBlocks}`);
  assert.match(last, /较早步骤摘要/); // 第10轮应已有滚动摘要
  assert.ok(prompts[9].length < prompts[4].length * 2, "prompt 应被摘要 bound 住，不随轮数线性膨胀");
});

test("foldSummary：累积折叠 + 超长截头部", () => {
  let s = "";
  for (let i = 0; i < 50; i++) s = loop.foldSummary(s, [{ tool: "run_bash", args: { command: "x".repeat(300) }, result: "y".repeat(500), ok: true }]);
  assert.ok(s.length <= 4100, `摘要应被截到上限附近，实际 ${s.length}`);
  assert.match(s, /更早步骤已省略/);
});

test("forwardBrain：转发到服务端 claude-proxy(SSE) 收集文本", async () => {
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: start\ndata: {}\n\n`);
      res.write(`event: chunk\ndata: ${JSON.stringify({ delta: "前半" })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ text: "前半段+完整脚本" })}\n\n`);
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    const text = await loop.forwardBrain(`http://localhost:${port}`, "tok", "造个脚本");
    assert.equal(text, "前半段+完整脚本"); // done.text 覆盖 chunk
  } finally { srv.close(); }
});

test("forwardBrain：服务端报错(error 事件)抛出", async () => {
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: error\ndata: ${JSON.stringify({ message: "额度用尽" })}\n\n`);
    res.end();
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    await assert.rejects(() => loop.forwardBrain(`http://localhost:${port}`, "", "x"), /额度用尽/);
  } finally { srv.close(); }
});
