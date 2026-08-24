import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const FORWARDED_ENV = [
  "APPMARKET_ADMIN_TOKEN",
  "APPMARKET_ADMIN_USERNAME",
  "APPMARKET_ADMIN_PASSWORD",
  "APPMARKET_ADMIN_LOGIN_CURL_FILE",
  "APPMARKET_ADMIN_BASE_URL",
  "APPMARKET_ADMIN_ALLOWED_ORIGINS",
  "APPMARKET_ADMIN_ENVIRONMENT",
  "APPMARKET_ADMIN_TIMEOUT_MS",
  "APPMARKET_ADMIN_MAX_RESPONSE_BYTES",
  "APPMARKET_ADMIN_TOKEN_TTL_MS",
];

const env = getDefaultEnvironment();
for (const name of FORWARDED_ENV) {
  if (process.env[name]) env[name] = process.env[name];
}

const scope = process.env.APPMARKET_ADMIN_SELF_TEST_SCOPE || "core";
if (!["auth", "core", "catalog"].includes(scope)) {
  process.stderr.write(
    "APPMARKET_ADMIN_SELF_TEST_SCOPE 只允许 auth、core 或 catalog\n"
  );
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stderr: "pipe",
});
const client = new Client({
  name: "appmarket-admin-live-self-test",
  version: "1.0.0",
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
  if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
});

try {
  await client.connect(transport);
  const capabilities = await client.callTool({
    name: "appmarket_admin_capabilities",
    arguments: {},
  });
  const selfCheck = await client.callTool({
    name: "appmarket_admin_self_check",
    arguments: { scope, concurrency: 3 },
  });
  const capabilityData = capabilities.structuredContent;
  const result = selfCheck.structuredContent;
  const output = {
    service: capabilityData?.data?.service || "unknown",
    toolCount: capabilityData?.data?.tools?.length ?? null,
    endpointCount: capabilityData?.data?.endpointCount ?? null,
    scope,
    status: result?.status || "error",
    passed: result?.data?.passed ?? 0,
    partial: result?.data?.partial ?? 0,
    failed: result?.data?.failed ?? 1,
    total: result?.data?.total ?? 0,
    evidenceSha256: result?.meta?.evidenceSha256 || null,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (selfCheck.isError || output.status === "fail") process.exitCode = 1;
} catch {
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      code: "MCP_SELF_TEST_FAILED",
      serverStderrPresent: Boolean(stderr),
    })}\n`
  );
  process.exitCode = 1;
} finally {
  await transport.close();
}
