import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createToolkitApplication } from "../packages/tb-application/src/update-service.js";
import { createTbTicketMcpServer } from "../mcp/tb-ticket-mcp/src/server.js";
import { createTempGitRepo, removeTree, richSnapshot } from "./helpers.mjs";

function decode(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text);
  return JSON.parse(response.content[0].text);
}

test("单一 MCP 离线 canary 完成 TRIAGE 与 RESOLUTION 且不双写", async (t) => {
  const repoPath = createTempGitRepo("tb-toolkit-m6-");
  t.after(() => removeTree(repoPath));
  const snapshot = richSnapshot();
  snapshot.detail.taskflowstatus = { _id: "triage", name: "AI甄别", _taskflowId: "flow" };
  snapshot.detail.updated = "2026-08-23T00:00:00.000Z";
  const writes = [];
  const statuses = [
    { statusId: "triage", displayName: "AI甄别", taskflowId: "flow" },
    { statusId: "done", displayName: "已完成", taskflowId: "flow" },
  ];
  const provider = {
    async readTicket() { return structuredClone(snapshot); },
    async openAttachment() { throw new Error("no attachment"); },
    async getWorkflow() {
      return {
        task: structuredClone(snapshot.resolved), projectId: "project", taskflowId: "flow", workflowVersion: snapshot.detail.updated,
        currentStatus: { statusId: snapshot.detail.taskflowstatus._id, displayName: snapshot.detail.taskflowstatus.name },
        triageStatus: statuses[0], statuses: structuredClone(statuses), transitions: [], complete: true,
      };
    },
    async listComments() { return structuredClone(snapshot.comments.items); },
    async writeComment(_taskId, content) {
      writes.push(["comment", content]);
      snapshot.comments.items.push({ _id: `canary-${writes.length}`, content: { text: content } });
    },
    async updateStatus(_taskId, target) {
      writes.push(["status", target.statusId]);
      snapshot.detail.taskflowstatus = { _id: target.statusId, name: target.displayName, _taskflowId: "flow" };
    },
  };
  const application = createToolkitApplication({
    provider, repoPath, profile: "write", writeEnabled: true, allowedTaskRefs: ["CARB-15125"],
  });
  const server = createTbTicketMcpServer({ application, profile: "write" });
  const client = new Client({ name: "offline-canary", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "tb_ticket_prepare", "tb_workflow_get", "tb_update_plan", "tb_update_apply", "tb_operation_get",
  ]);

  const firstPrepare = decode(await client.callTool({
    name: "tb_ticket_prepare", arguments: { taskRef: "CARB-15125", repoRoot: repoPath },
  }));
  const triagePlan = decode(await client.callTool({
    name: "tb_update_plan",
    arguments: {
      phase: "TRIAGE", taskRef: "CARB-15125", targetStatus: { statusId: "triage" }, contextDigest: firstPrepare.contextDigest,
      reason: "写入链路需要先建立可恢复的工单处理记录", measure: "接入统一计划并通过离线 canary 验证评论回读",
      evidenceRefs: [{ kind: "source", result: "OBSERVED", summary: "离线 canary 准备完成" }], source: { commit: "canary-triage" },
    },
  }));
  const triage = decode(await client.callTool({
    name: "tb_update_apply",
    arguments: { planId: triagePlan.planId, fingerprint: triagePlan.fingerprint, idempotencyKey: triagePlan.idempotencyKey, apply: true },
  }));
  assert.equal(triage.state, "COMPLETED");

  const secondPrepare = decode(await client.callTool({
    name: "tb_ticket_prepare", arguments: { taskRef: "CARB-15125", repoRoot: repoPath },
  }));
  const resolutionPlan = decode(await client.callTool({
    name: "tb_update_plan",
    arguments: {
      phase: "RESOLUTION", taskRef: "CARB-15125", targetStatus: { statusId: "done" }, contextDigest: secondPrepare.contextDigest,
      reason: "统一 MCP 的计划、锁和回读链路已完成离线验证", measure: "保留单一入口并通过端到端测试验证评论后状态顺序",
      evidenceRefs: [{ kind: "integration_test", result: "PASS", summary: "离线端到端 canary 通过" }], source: { commit: "canary-resolution" },
    },
  }));
  const resolution = decode(await client.callTool({
    name: "tb_update_apply",
    arguments: { planId: resolutionPlan.planId, fingerprint: resolutionPlan.fingerprint, idempotencyKey: resolutionPlan.idempotencyKey, apply: true },
  }));
  assert.equal(resolution.state, "COMPLETED");
  assert.deepEqual(writes.map(([kind]) => kind), ["comment", "comment", "status"]);
  assert.notEqual(writes[0][1], writes[1][1]);
  assert.equal(snapshot.detail.taskflowstatus._id, "done");
});

