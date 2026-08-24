import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SECRET_SENTINEL = "SECRET_SENTINEL";
const EXPECTED_TOOL_NAMES = [
  "appmarket_admin_capabilities",
  "appmarket_admin_auth_check",
  "appmarket_admin_list_routes",
  "appmarket_admin_list_metadata",
  "appmarket_admin_list_countries",
  "appmarket_admin_list_car_models",
  "appmarket_admin_get_car_model_country_map",
  "appmarket_admin_list_departments",
  "appmarket_admin_list_apps",
  "appmarket_admin_list_app_options",
  "appmarket_admin_list_banners",
  "appmarket_admin_list_webapp_configs",
  "appmarket_admin_list_channels",
  "appmarket_admin_query_dashboard",
  "appmarket_admin_get_voice_open_keys",
  "appmarket_admin_verify_banner",
  "appmarket_admin_verify_voice_key",
  "appmarket_admin_verify_distribution",
  "appmarket_admin_verify_model_region",
  "appmarket_admin_self_check",
];

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(TEST_DIR, "..");
const SERVER_ENTRY = resolve(SERVER_DIR, "src", "index.js");

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startMockAdminServer() {
  const observed = {
    loginCalls: 0,
    protectedCalls: [],
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (
        request.method === "POST" &&
        url.pathname === "/admin-api/login"
      ) {
        observed.loginCalls += 1;
        const body = await readJson(request);
        assert.equal(body.username, "readonly-integration");
        assert.equal(body.password === SECRET_SENTINEL, true);
        json(response, 200, {
          code: 200,
          token: SECRET_SENTINEL,
        });
        return;
      }

      const authorization = request.headers.authorization || "";
      assert.equal(authorization === `Bearer ${SECRET_SENTINEL}`, true);
      observed.protectedCalls.push({
        method: request.method,
        pathname: url.pathname,
        search: url.search,
      });

      if (
        request.method === "GET" &&
        url.pathname === "/admin-api/getInfo"
      ) {
        json(response, 200, {
          code: 200,
          user: { userName: "readonly-integration" },
          roles: ["readonly"],
          permissions: ["system:country:list"],
        });
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/admin-api/system/country/list"
      ) {
        assert.equal(url.searchParams.get("pageNum"), "1");
        assert.equal(url.searchParams.get("pageSize"), "20");
        json(response, 200, {
          code: 200,
          rows: [
            {
              id: "country-cn",
              internationalCode: "CN",
              chineseName: "中国",
              region: "Asia",
              state: 1,
            },
          ],
          total: 1,
        });
        return;
      }

      json(response, 404, { code: 404, message: "mock route not found" });
    } catch (error) {
      json(response, 500, {
        code: 500,
        message: error instanceof Error ? error.message : "mock failure",
      });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    observed,
  };
}

function assertNoSecret(value, label) {
  assert.equal(
    JSON.stringify(value).includes(SECRET_SENTINEL),
    false,
    `${label} must not expose authentication material`
  );
}

test("stdio MCP exposes 20 read-only tools and keeps auth material private", async () => {
  const mock = await startMockAdminServer();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: SERVER_DIR,
    stderr: "pipe",
    env: {
      APPMARKET_ADMIN_BASE_URL: mock.origin,
      APPMARKET_ADMIN_ALLOWED_ORIGINS: mock.origin,
      APPMARKET_ADMIN_ENVIRONMENT: "integration-test",
      APPMARKET_ADMIN_USERNAME: "readonly-integration",
      APPMARKET_ADMIN_PASSWORD: SECRET_SENTINEL,
      APPMARKET_ADMIN_TOKEN: "",
      APPMARKET_ADMIN_LOGIN_CURL_FILE: "",
    },
  });
  const client = new Client(
    {
      name: "appmarket-admin-readonly-integration-test",
      version: "1.0.0",
    },
    { capabilities: {} }
  );
  const stdoutMessages = [];
  let rawStderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    rawStderr += chunk;
  });

  try {
    await client.connect(transport);
    const clientMessageHandler = transport.onmessage;
    assert.equal(typeof clientMessageHandler, "function");
    transport.onmessage = (message) => {
      stdoutMessages.push(message);
      clientMessageHandler(message);
    };

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 20);
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      EXPECTED_TOOL_NAMES
    );
    for (const tool of listed.tools) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }

    const capabilities = await client.callTool({
      name: "appmarket_admin_capabilities",
      arguments: {},
    });
    assert.equal(capabilities.isError, undefined);
    assert.equal(capabilities.structuredContent?.status, "ok");
    assert.equal(
      capabilities.structuredContent?.data?.service,
      "appmarket-admin-readonly"
    );
    assert.equal(capabilities.structuredContent?.data?.transport, "stdio");
    assert.equal(capabilities.structuredContent?.data?.authConfigured, true);
    assert.equal(
      capabilities.structuredContent?.data?.credentialMode,
      "environment"
    );
    assert.deepEqual(
      capabilities.structuredContent?.data?.tools,
      EXPECTED_TOOL_NAMES
    );
    assert.deepEqual(capabilities.structuredContent?.data?.safety, {
      arbitraryHttp: false,
      writeEndpoints: false,
      credentialsAsToolArguments: false,
      exactOriginAllowlist: true,
    });
    assertNoSecret(capabilities, "capabilities result");

    const authCheck = await client.callTool({
      name: "appmarket_admin_auth_check",
      arguments: {},
    });
    assert.equal(authCheck.isError, undefined);
    assert.equal(authCheck.structuredContent?.status, "ok");
    assert.deepEqual(authCheck.structuredContent?.data, {
      authenticated: true,
      credentialMode: "environment",
      roleCount: 1,
      permissionCount: 1,
    });
    assertNoSecret(authCheck, "auth_check result");

    const countries = await client.callTool({
      name: "appmarket_admin_list_countries",
      arguments: {
        source: "system",
        pageNum: 1,
        pageSize: 20,
      },
    });
    assert.equal(countries.isError, undefined);
    assert.equal(countries.structuredContent?.status, "ok");
    assert.deepEqual(countries.structuredContent?.data?.items, [
      {
        id: "country-cn",
        internationalCode: "CN",
        chineseName: "中国",
        region: "Asia",
        state: 1,
      },
    ]);
    assert.equal(
      countries.structuredContent?.meta?.endpointIds?.[0],
      "country.list"
    );
    assert.equal(
      countries.structuredContent?.meta?.validation?.schema,
      "pass"
    );
    assertNoSecret(countries, "country list result");

    assert.equal(mock.observed.loginCalls, 1);
    assert.deepEqual(
      mock.observed.protectedCalls.map((call) => call.pathname),
      ["/admin-api/getInfo", "/admin-api/system/country/list"]
    );
    assertNoSecret(stdoutMessages, "stdio protocol messages");
    assert.equal(rawStderr.includes(SECRET_SENTINEL), false);
  } finally {
    await client.close().catch(() => {});
    mock.server.close();
    await once(mock.server, "close");
  }
});
