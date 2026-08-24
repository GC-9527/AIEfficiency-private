import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { after, before, test } from "node:test";

import { bootGateway, waitHealth } from "./_helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-tb-user-"));
const port = 38100 + Math.floor(Math.random() * 500);
const configPath = path.join(root, "gateway.json");
const base = `http://127.0.0.1:${port}/api/devbench`;
let gateway;

fs.writeFileSync(configPath, JSON.stringify({
  role: "standalone",
  teambition: {
    operatorId: "tb-normal-user",
    userName: "普通 TB 用户",
    userCookie: "fake-verified-cookie",
    projects: [],
  },
}, null, 2), "utf8");

before(async () => {
  gateway = bootGateway({
    port,
    gwCfg: configPath,
    market: path.join(root, "market.json"),
    storeDir: path.join(root, "store"),
    dbPath: path.join(root, "gateway.db"),
    totpDir: path.join(root, "totp"),
    extraEnv: { NODE_ENV: "production" },
  });
  await waitHealth(port, gateway);
}, { timeout: 30000 });

after(async () => {
  if (gateway && gateway.exitCode === null) {
    try {
      gateway.kill();
      await Promise.race([
        once(gateway, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("普通 TB 登录态可读取并清空本人项目选择，不需要管理员 Bearer", async () => {
  const projectsResponse = await fetch(`${base}/tb-projects`);
  const projectsBody = await projectsResponse.json();
  assert.equal(projectsResponse.status, 200);
  assert.equal(projectsBody.ok, true);
  assert.equal(projectsBody.meta.vehicleSourceRecommendationStatus, "available");
  assert.deepEqual(projectsBody.meta.vehicleSourceProjectIds, []);
  assert.equal(projectsBody.meta.recommendedVehicleSourceProjectId, "");

  const readResponse = await fetch(`${base}/tb-projects/selection`);
  const readBody = await readResponse.json();
  assert.equal(readResponse.status, 200);
  assert.equal(readBody.ok, true);
  assert.equal(readBody.meta.userKey, "tb:tb-normal-user");

  const writeResponse = await fetch(`${base}/tb-projects/selection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects: [] }),
  });
  const writeBody = await writeResponse.json();
  assert.equal(writeResponse.status, 200);
  assert.equal(writeBody.ok, true);
  assert.equal(writeBody.meta.userKey, "tb:tb-normal-user");
  assert.deepEqual(writeBody.data, []);
});

test("普通 TB 登录态可作为已认证身份进入故事点工作台", async () => {
  const response = await fetch(`${base}/tabs`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.data));
});

test("普通 TB 登录态不会获得管理员车型配置能力", async () => {
  const response = await fetch(`${base}/config-conflicts`);
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.ok, false);
});
