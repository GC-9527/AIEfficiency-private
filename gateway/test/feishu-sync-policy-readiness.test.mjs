import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

test("persisted duplicate policy IDs remain visible through no-argument readiness and GET /config", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-policy-readiness-"));
  const previousConfigPath = process.env.GATEWAY_CONFIG_PATH;
  const previousDbPath = process.env.GATEWAY_DB_PATH;
  process.env.GATEWAY_CONFIG_PATH = path.join(tempRoot, "gateway-config.json");
  process.env.GATEWAY_DB_PATH = path.join(tempRoot, "gateway.db");
  fs.writeFileSync(process.env.GATEWAY_CONFIG_PATH, JSON.stringify({
    feishuProjectSync: {
      routing: {
        targets: [
          { id: "duplicate-target", name: "重复目标 A", system: "teambition", config: {} },
          { id: "duplicate-target", name: "重复目标 B", system: "teambition", config: {} },
        ],
      },
    },
  }), "utf8");

  t.after(() => {
    if (previousConfigPath === undefined) delete process.env.GATEWAY_CONFIG_PATH;
    else process.env.GATEWAY_CONFIG_PATH = previousConfigPath;
    if (previousDbPath === undefined) delete process.env.GATEWAY_DB_PATH;
    else process.env.GATEWAY_DB_PATH = previousDbPath;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      if (!["EBUSY", "EPERM"].includes(error?.code)) throw error;
    }
  });

  const service = await import("../../features/FeiShuProjects/src/gateway-sync-service.js");
  const direct = service.getFeishuProjectSyncReadiness();
  assert.equal(direct.policyValidation.valid, false);
  assert.ok(direct.policyValidation.errors.some((entry) => entry.message.includes("ID 重复")));

  const { createFeishuProjectSyncRouter } = await import("../../features/FeiShuProjects/src/gateway-route.js");
  const router = createFeishuProjectSyncRouter({
    Router: express.Router,
    verifyToken: () => null,
    listFeishuProjectSyncErrors: () => [],
    readFilterPreset: () => null,
  });
  const app = express();
  app.use("/api/feishu-project-sync", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/feishu-project-sync/config`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.readiness.policyValidation.valid, false);
  assert.ok(payload.data.readiness.policyValidation.errors.some((entry) => entry.message.includes("ID 重复")));
});
