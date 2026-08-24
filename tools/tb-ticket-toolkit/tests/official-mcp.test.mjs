import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  OFFICIAL_MCP_PACKAGE,
  OFFICIAL_MCP_VERSION,
  OFFICIAL_READ_TOOL_NAMES,
  connectOfficialTeambitionMcp,
  createOfficialTeambitionGateway,
  inspectOfficialMcpRuntime,
} from "../packages/tb-official-mcp/src/index.js";

const TASK_ID = "0123456789abcdef01234567";

function toolResponse(data) {
  return { content: [{ type: "text", text: `API Response (Status: 200):\n${JSON.stringify({ data })}` }] };
}

test("官方 Teambition MCP 发布包固定并在 read profile 加载全部已覆盖读工具", async (t) => {
  const inspected = inspectOfficialMcpRuntime();
  assert.equal(inspected.ok, true, inspected.problems.join("; "));
  assert.equal(inspected.registration.packageName, OFFICIAL_MCP_PACKAGE);
  assert.equal(inspected.registration.packageVersion, OFFICIAL_MCP_VERSION);
  assert.deepEqual(inspected.registration.tools, OFFICIAL_READ_TOOL_NAMES);
  assert.equal(inspected.registration.toolTimeoutMs, 180_000);

  const session = await connectOfficialTeambitionMcp({
    env: {
      ...process.env,
      TB_MCP_APP_ID: "fixture-app-id",
      TB_MCP_APP_SECRET: "fixture-app-secret",
      TB_MCP_ORG_ID: "fixture-org-id",
    },
  });
  t.after(() => session.close());
  const listed = await session.listTools();
  assert.deepEqual(listed.tools.map((item) => item.name).sort(), [...OFFICIAL_READ_TOOL_NAMES].sort());
});

test("薄客户端通过官方 MCP 读取任务、评论和附件元数据，仅字节流保留为审计缺口", async () => {
  const calls = [];
  const gateway = createOfficialTeambitionGateway({
    async callTool(request) {
      calls.push(request);
      if (request.name === "queryTaskV3") {
        return toolResponse([{
          _id: TASK_ID,
          uniqueId: 15125,
          content: "official fixture",
          project: { _id: "project", name: "Official" },
        }]);
      }
      if (request.name === "listTaskActivitiesV3") return toolResponse([{ _id: "comment-1", content: { text: "官方评论" } }]);
      if (request.name === "listFilesV3") {
        return toolResponse([{ _id: "file-1", fileName: "evidence.log", downloadUrl: "https://files.example.invalid/a?signature=secret" }]);
      }
      throw new Error(`unexpected tool: ${request.name}`);
    },
  });
  const snapshot = await gateway.readTicket("CARB-15125");

  assert.deepEqual(calls.map((item) => item.name), ["queryTaskV3", "listTaskActivitiesV3", "listFilesV3"]);
  assert.equal(snapshot.resolved.taskId, TASK_ID);
  assert.equal(snapshot.comments.complete, true);
  assert.equal(snapshot.attachments.complete, true);
  assert.equal(snapshot.attachments.items[0].attachmentId, "file-1");
  assert.doesNotMatch(JSON.stringify(snapshot), /signature=secret|files\.example\.invalid/i);
  await assert.rejects(() => gateway.openAttachment("file-1"), (error) => error.code === "OFFICIAL_MCP_CAPABILITY_GAP");
});

test("官方 MCP 经真实 stdio 工具调用访问本机 mock OpenAPI", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    let data = [];
    if (request.url.startsWith("/v3/task/query")) {
      data = [{ _id: TASK_ID, uniqueId: 15125, content: "official stdio fixture", project: { _id: "project" } }];
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ errorCode: "", data }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const session = await connectOfficialTeambitionMcp({
      basePath: `http://127.0.0.1:${address.port}`,
      tools: ["queryTaskV3", "listTaskActivitiesV3", "listFilesV3"],
      env: {
        ...process.env,
        TB_MCP_APP_ID: "fixture-app-id",
        TB_MCP_APP_SECRET: "fixture-app-secret",
        TB_MCP_ORG_ID: "fixture-org-id",
      },
    });
    try {
      const gateway = createOfficialTeambitionGateway(session);
      const snapshot = await gateway.readTicket("CARB-15125");
      assert.equal(snapshot.resolved.title, "official stdio fixture");
      assert.equal(snapshot.comments.complete, true);
      assert.equal(snapshot.attachments.complete, true);
      assert.equal(requests.length, 3);
      assert.equal(requests.some((url) => url.startsWith("/v3/task/query?")), true);
      assert.equal(requests.some((url) => url.startsWith(`/v3/task/${TASK_ID}/activity/list?`)), true);
      assert.equal(requests.some((url) => url.startsWith("/v3/work/list?")), true);
    } finally {
      await session.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("官方 MCP 错误会脱敏并以稳定错误码关闭", async () => {
  const gateway = createOfficialTeambitionGateway({
    async callTool() {
      return {
        isError: true,
        content: [{ type: "text", text: "Authorization: Bearer secret at https://download.invalid/a?signature=secret" }],
      };
    },
  });
  await assert.rejects(
    () => gateway.readTicket("CARB-15125"),
    (error) => error.code === "OFFICIAL_MCP_TOOL_FAILED" && !/secret|download\.invalid/i.test(error.message),
  );
});

