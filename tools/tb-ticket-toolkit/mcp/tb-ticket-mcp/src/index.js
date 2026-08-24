#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { bootstrapToolkit } from "../../../packages/tb-application/src/bootstrap.js";
import { createTbTicketMcpServer } from "./server.js";

let runtime = null;
try {
  const profile = process.env.TB_TOOLKIT_PROFILE === "write" ? "write" : "read";
  runtime = await bootstrapToolkit({ profile });
  const server = createTbTicketMcpServer({ application: runtime.application, profile });
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  process.stderr.write(`tb-ticket-mcp failed: ${String(error?.message || error)}\n`);
  if (runtime) await runtime.close().catch(() => {});
  process.exitCode = 1;
}
