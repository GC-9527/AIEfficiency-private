import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createTbTicketMcpServer } from "../mcp/tb-ticket-mcp/src/server.js";
import { READ_PROFILE_TOOL_NAMES, WRITE_PROFILE_TOOL_NAMES } from "../mcp/tb-ticket-mcp/src/contracts.js";

async function connected(t, profile) {
  const calls = [];
  const application = {
    async prepare(input) { calls.push(["prepare", input]); return { state: "READY", task: { taskNo: "CARB-1" }, downloads: [] }; },
    async workflowGet(input) { calls.push(["workflow", input]); return { currentStatus: { displayName: "AI甄别" } }; },
    async updatePlan(input) { calls.push(["plan", input]); return { planId: "plan-1" }; },
    async updateApply(input) { calls.push(["apply", input]); return { operationId: "operation-1", state: "COMPLETED" }; },
    operationGet(input) { calls.push(["operation", input]); return { operationId: input, state: "COMPLETED" }; },
  };
  const server = createTbTicketMcpServer({ application, profile });
  const client = new Client({ name: "tb-toolkit-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

test("read profile 只暴露统一 MCP 的四个业务工具，不暴露官方子工具或补充 Provider", async (t) => {
  const { client } = await connected(t, "read");
  const listed = await client.listTools();
  const names = listed.tools.map((item) => item.name);
  assert.deepEqual(names, READ_PROFILE_TOOL_NAMES);
  assert.equal(names.some((name) => /queryTaskV3|listFilesV3|cookie|supplement/i.test(name)), false);
  const apply = await client.callTool({
    name: "tb_update_apply",
    arguments: { planId: "plan", fingerprint: "a".repeat(64), idempotencyKey: "idempotency", apply: true },
  });
  assert.equal(apply.isError, true);
  assert.match(apply.content[0].text, /WRITE_DISABLED/);
});

test("write profile 仍是同一个 MCP，仅增加受保护的 apply 业务工具", async (t) => {
  const { client, calls } = await connected(t, "write");
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((item) => item.name), WRITE_PROFILE_TOOL_NAMES);
  assert.equal(listed.tools.length, 5);
  const response = await client.callTool({
    name: "tb_update_apply",
    arguments: { planId: "plan", fingerprint: "a".repeat(64), idempotencyKey: "idempotency", apply: true },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [["apply", { planId: "plan", fingerprint: "a".repeat(64), idempotencyKey: "idempotency", apply: true }]]);
});

test("MCP 严格拒绝未知字段并对错误输出脱敏", async (t) => {
  const { client, calls } = await connected(t, "read");
  const response = await client.callTool({ name: "tb_workflow_get", arguments: { taskRef: "CARB-1", Authorization: "Bearer secret" } });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /INVALID_ARGUMENT/);
  assert.doesNotMatch(response.content[0].text, /Bearer secret/);
  assert.deepEqual(calls, []);

  const wrongType = await client.callTool({
    name: "tb_update_plan",
    arguments: {
      phase: "TRIAGE", taskRef: "CARB-1", targetStatus: { displayName: "AI甄别" }, contextDigest: "a".repeat(64),
      reason: 7, measure: "增加验证测试", evidenceRefs: [{ kind: "source", result: "OBSERVED", summary: "fixture" }], source: { commit: "fixture" },
    },
  });
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.content[0].text, /INVALID_ARGUMENT/);
  assert.deepEqual(calls, []);
});
