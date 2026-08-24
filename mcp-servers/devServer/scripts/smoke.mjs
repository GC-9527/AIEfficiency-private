import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(SCRIPT_DIR, "..");
const SERVER_ENTRY = resolve(SERVER_DIR, "src", "index.js");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: SERVER_DIR,
    stderr: "pipe",
    env: {
      APPMARKET_ADMIN_USERNAME: "",
      APPMARKET_ADMIN_PASSWORD: "",
      APPMARKET_ADMIN_TOKEN: "",
      APPMARKET_ADMIN_LOGIN_CURL_FILE: "",
    },
  });
  const client = new Client(
    {
      name: "appmarket-admin-readonly-smoke",
      version: "1.0.0",
    },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "appmarket_admin_capabilities",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.status, "ok");
    assert.equal(
      result.structuredContent?.data?.service,
      "appmarket-admin-readonly"
    );
    assert.equal(result.structuredContent?.data?.transport, "stdio");
    assert.equal(result.structuredContent?.data?.authConfigured, false);
    assert.equal(result.structuredContent?.data?.tools?.length, 20);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        service: result.structuredContent.data.service,
        environment: result.structuredContent.data.environment,
        toolCount: result.structuredContent.data.tools.length,
      })}\n`
    );
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`
  );
  process.exitCode = 1;
});
