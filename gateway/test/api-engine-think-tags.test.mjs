import { test } from "node:test";
import assert from "node:assert/strict";
import { readApiTextStream } from "../services/api-engine.js";

const encoder = new TextEncoder();
const TO = "<" + "think" + ">";
const TC = "<" + "/think" + ">";

function sse(events) {
  const body = new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return { ok: true, body };
}

test("inline think tags in content routed to thinking, stripped from text", async () => {
  const events = [
    { choices: [{ delta: { content: TO + "先分析一下" + TC + "最终答案" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  const chunks = [];
  const res = await readApiTextStream(sse(events), {
    onChunk: (c, dt) => chunks.push({ c, dt }),
  });
  const thinking = chunks.filter((x) => x.dt === "thinking").map((x) => x.c).join("");
  const text = chunks.filter((x) => x.dt === "text").map((x) => x.c).join("");
  assert.equal(thinking, "先分析一下");
  assert.equal(text, "最终答案");
  assert.equal(res.text, "最终答案");
  assert.ok(!res.text.includes(TO), "最终正文不应残留 think 开标签");
  assert.ok(!res.text.includes(TC), "最终正文不应残留 think 闭标签");
});

test("reasoning_content field present => content not tag-parsed (avoid misreading literal tags)", async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "正经思考" } }] },
    { choices: [{ delta: { content: "正文里提到 " + TO + " 字面量应保留" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  const chunks = [];
  await readApiTextStream(sse(events), {
    onChunk: (c, dt) => chunks.push({ c, dt }),
  });
  const text = chunks.filter((x) => x.dt === "text").map((x) => x.c).join("");
  assert.equal(text, "正文里提到 " + TO + " 字面量应保留");
});

test("think tags split across chunks still parsed", async () => {
  const events = [
    { choices: [{ delta: { content: "前文" + TO + "思考中" } }] },
    { choices: [{ delta: { content: "继续思考" + TC + "后文" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  const chunks = [];
  const res = await readApiTextStream(sse(events), {
    onChunk: (c, dt) => chunks.push({ c, dt }),
  });
  const thinking = chunks.filter((x) => x.dt === "thinking").map((x) => x.c).join("");
  const text = chunks.filter((x) => x.dt === "text").map((x) => x.c).join("");
  assert.equal(thinking, "思考中继续思考");
  assert.equal(text, "前文后文");
  assert.equal(res.text, "前文后文");
});
