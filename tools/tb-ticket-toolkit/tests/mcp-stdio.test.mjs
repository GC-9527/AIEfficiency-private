import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("真实 stdio 启动唯一 tb-ticket-mcp 且 stdout 保持 MCP 协议流", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp/tb-ticket-mcp/src/index.js")],
    cwd: root,
    env: {
      ...process.env,
      TB_TOOLKIT_PROFILE: "read",
      TB_TOOLKIT_REPO: root,
      TB_MCP_APP_ID: "fixture-app",
      TB_MCP_APP_SECRET: "fixture-secret",
      TB_MCP_ORG_ID: "fixture-org",
      TB_WEB_COOKIE: "",
      TB_TOOLKIT_WRITE_ENABLED: "false",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-smoke", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((item) => item.name), [
      "tb_ticket_prepare", "tb_workflow_get", "tb_update_plan", "tb_operation_get",
    ]);
  } finally {
    await client.close();
  }
});

