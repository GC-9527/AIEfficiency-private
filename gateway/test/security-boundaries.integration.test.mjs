import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { totp } from "../services/totp.js";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const roots = [];
const children = new Set();

after(() => {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startIsolatedGateway({
  nodeEnv,
  extraEnv = {},
  config = {},
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "security-boundaries-"));
  roots.push(root);
  const port = await reservePort();
  const cfgPath = path.join(root, "gateway.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    role: "standalone",
    servers: { discovery: false, peers: [], distribute: false },
    executor: { enabled: true, allowedRoots: [] },
    ...config,
  }, null, 2), "utf8");
  const child = bootGateway({
    port,
    role: "standalone",
    gwCfg: cfgPath,
    market: path.join(root, "market.json"),
    storeDir: path.join(root, "store"),
    dbPath: path.join(root, "gateway.db"),
    totpDir: path.join(root, "totp"),
    extraEnv: {
      NODE_ENV: nodeEnv,
      ...extraEnv,
    },
  });
  children.add(child);
  await waitHealth(port, child, 30000);
  return {
    root,
    port,
    cfgPath,
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    async stop() {
      children.delete(child);
      try { child.kill(); } catch {}
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        setTimeout(resolve, 3000).unref();
      });
    },
  };
}

const protectedHttpRequests = [
  ["tasks", (base) => fetch(`${base}/api/tasks`)],
  ["chat", (base) => fetch(`${base}/api/chat/sessions`)],
  ["workflows", (base) => fetch(`${base}/api/workflows`)],
  ["schedule", (base) => fetch(`${base}/api/schedule`)],
  ["distributed", (base) => fetch(`${base}/api/distributed/remotes`)],
  ["DevBench", (base) => fetch(`${base}/api/devbench/tabs`)],
  ["performance", (base) => fetch(`${base}/api/performance/resource-run/status`)],
  ["artifacts", (base) => fetch(`${base}/api/devbench/tabs/missing/artifacts/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "missing.apk" }),
  })],
  ["peer shared bundle", (base) => fetch(`${base}/api/discovery/shared-bundle`)],
  ["peer admin replication", (base) => fetch(`${base}/api/admin/users-since?since=0`)],
  ["peer audit replication", (base) => fetch(`${base}/api/devbench/audit-since?since=0`)],
  ["peer userdata replication", (base) => fetch(`${base}/api/devbench/userdata-since?since=0`)],
  ["peer feedback replication", (base) => fetch(`${base}/api/feedback/since?since=0`)],
  ["peer Feishu replication", (base) => fetch(`${base}/api/feishu-project-sync/records-since?since=0`)],
];

async function assertProtectedHttpRejected(baseUrl) {
  for (const [name, request] of protectedHttpRequests) {
    const response = await request(baseUrl);
    assert.equal(response.status, 401, `${name} 未认证请求必须失败关闭`);
  }
}

function waitForWsClose(url, expectedCode) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`等待 WebSocket ${expectedCode} 关闭超时`));
    }, 5000);
    socket.once("error", () => {});
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      try {
        assert.equal(code, expectedCode);
        assert.match(String(reason), /authentication required/i);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function waitForWsConnected(url, protocols = ["aiefficiency.v1"]) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("等待 WebSocket connected 消息超时"));
    }, 5000);
    socket.once("error", reject);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      try {
        assert.equal(socket.protocol, "aiefficiency.v1");
        const message = JSON.parse(String(raw));
        assert.equal(message.type, "connected");
        socket.close();
        resolve();
      } catch (error) {
        socket.terminate();
        reject(error);
      }
    });
  });
}

async function issueIsolatedSuperToken(baseUrl) {
  const setupResponse = await fetch(`${baseUrl}/api/admin/auth/totp/setup`);
  assert.equal(setupResponse.status, 200);
  const setup = await setupResponse.json();
  const secret = setup.data?.secret || setup.secret;
  assert.ok(secret, "隔离 TOTP 初始化必须返回密钥");
  const loginResponse = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: totp(secret) }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  assert.ok(login.ok && login.token, "隔离超管登录必须成功");
  return login.token;
}

async function readConfig(baseUrl) {
  const response = await fetch(`${baseUrl}/api/config`);
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

async function writeConfig(baseUrl, body, token = "") {
  return fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

for (const nodeEnv of ["", "production"]) {
  test(`NODE_ENV=${nodeEnv || "<empty>"} 时控制面与普通 WebSocket 均默认失败关闭`, async () => {
    const gateway = await startIsolatedGateway({ nodeEnv });
    try {
      await assertProtectedHttpRejected(gateway.baseUrl);
      await waitForWsClose(`ws://127.0.0.1:${gateway.port}/ws`, 1008);
    } finally {
      await gateway.stop();
    }
  }, { timeout: 50000 });
}

test("development 仅显式开放对应入口，例外不会扩散到 workflows/schedule", async () => {
  const gateway = await startIsolatedGateway({
    nodeEnv: "development",
    extraEnv: {
      AIEFFICIENCY_ALLOW_UNAUTHENTICATED_TASK_API: "1",
      AIEFFICIENCY_ALLOW_UNAUTHENTICATED_CHAT_API: "1",
      AIEFFICIENCY_ALLOW_UNAUTHENTICATED_DISTRIBUTED: "1",
      AIEFFICIENCY_ALLOW_UNAUTHENTICATED_PERFORMANCE: "1",
      DEVBENCH_ALLOW_UNAUTHENTICATED_CONTROLLER: "1",
      AIEFFICIENCY_ALLOW_UNAUTHENTICATED_WS: "1",
    },
  });
  try {
    for (const [name, request] of protectedHttpRequests) {
      const response = await request(gateway.baseUrl);
      if (
        name === "workflows"
        || name === "schedule"
        || name.startsWith("peer ")
      ) {
        assert.equal(response.status, 401, `${name} 不得继承其它 development 例外`);
      } else {
        assert.notEqual(response.status, 401, `${name} 的显式 development 例外应生效`);
      }
    }
    await waitForWsConnected(`ws://127.0.0.1:${gateway.port}/ws`);
  } finally {
    await gateway.stop();
  }
}, { timeout: 50000 });

test("NODE_ENV=test 的测试例外只存在于隔离子进程", async () => {
  const gateway = await startIsolatedGateway({ nodeEnv: "test" });
  try {
    for (const [name, request] of protectedHttpRequests) {
      const response = await request(gateway.baseUrl);
      assert.notEqual(response.status, 401, `${name} 测试例外应在隔离 test 子进程中生效`);
    }
    await waitForWsConnected(`ws://127.0.0.1:${gateway.port}/ws`);
  } finally {
    await gateway.stop();
  }
}, { timeout: 50000 });

test("workDir/apiAgent/apiEngines/remoteExecutors 只有管理员可修改", async () => {
  const gateway = await startIsolatedGateway({ nodeEnv: "production" });
  try {
    const current = await readConfig(gateway.baseUrl);
    const mutations = [
      ["workDir", { workDir: path.join(gateway.root, "new-work-dir") }],
      ["apiAgent", {
        apiAgent: {
          ...(current.apiAgent || {}),
          commandPolicy: current.apiAgent?.commandPolicy === "read_only" ? "workspace" : "read_only",
        },
      }],
      ["apiEngines", {
        apiEngines: {
          ...(current.apiEngines || {}),
          deepseek: {
            ...(current.apiEngines?.deepseek || {}),
            model: `${current.apiEngines?.deepseek?.model || "deepseek-chat"}-security-test`,
          },
        },
      }],
      ["remoteExecutors", {
        remoteExecutors: [{
          name: "isolated-security-test",
          host: "http://127.0.0.1:9",
          token: "temporary-test-token",
        }],
      }],
    ];

    for (const [field, mutation] of mutations) {
      const response = await writeConfig(gateway.baseUrl, mutation);
      assert.equal(response.status, 403, `${field} 未认证修改必须拒绝`);
      const after = await readConfig(gateway.baseUrl);
      assert.deepEqual(after[field], current[field], `${field} 被拒绝后不得落盘`);
    }

    const token = await issueIsolatedSuperToken(gateway.baseUrl);
    for (const [field, mutation] of mutations) {
      const response = await writeConfig(gateway.baseUrl, mutation, token);
      assert.equal(response.status, 200, `${field} 管理员修改应成功`);
    }
  } finally {
    await gateway.stop();
  }
}, { timeout: 60000 });

test("生产普通 WebSocket 只接受子协议中的合法管理员 token", async () => {
  const gateway = await startIsolatedGateway({ nodeEnv: "production" });
  try {
    const token = await issueIsolatedSuperToken(gateway.baseUrl);
    const url = `ws://127.0.0.1:${gateway.port}/ws`;
    await waitForWsConnected(
      url,
      ["aiefficiency.v1", `aiefficiency.auth.${token}`],
    );
    await waitForWsClose(`${url}?access_token=${encodeURIComponent(token)}`, 1008);
  } finally {
    await gateway.stop();
  }
}, { timeout: 50000 });

test("TOTP reset 在服务端主动关闭已撤销的管理员 WebSocket", async () => {
  const gateway = await startIsolatedGateway({ nodeEnv: "production" });
  let socket;
  try {
    const token = await issueIsolatedSuperToken(gateway.baseUrl);
    socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, [
      "aiefficiency.v1",
      `aiefficiency.auth.${token}`,
    ]);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待管理员 WebSocket 连接超时")), 5000);
      socket.once("error", reject);
      socket.once("message", (raw) => {
        try {
          const message = JSON.parse(String(raw));
          assert.equal(message.type, "connected");
          clearTimeout(timer);
          resolve();
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待撤权 WebSocket 关闭超时")), 5000);
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        try {
          assert.equal(code, 1008);
          assert.match(String(reason), /revoked/i);
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const reset = await fetch(`${gateway.baseUrl}/api/admin/auth/totp/reset`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(reset.status, 200);
    await closed;
  } finally {
    try { socket?.terminate(); } catch {}
    await gateway.stop();
  }
}, { timeout: 50000 });
