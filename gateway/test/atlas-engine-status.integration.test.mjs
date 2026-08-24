import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-engine-status-"));
const configPath = path.join(tmp, "gateway.json");
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
fs.writeFileSync(configPath, JSON.stringify({
  role: "standalone",
  apiEngines: {
    atlas: {
      name: "Atlas Coding Plan",
      enabled: true,
      apiKey: "atlas-engine-status-test-key",
      baseUrl: "https://api.atlascloud.ai/v1",
      model: "zai-org/glm-5.1",
    },
  },
}));

let gateway;
before(async () => {
  gateway = bootGateway({
    port,
    gwCfg: configPath,
    market: path.join(tmp, "market.json"),
    storeDir: path.join(tmp, "store"),
    dbPath: path.join(tmp, "data.db"),
    extraEnv: { AIEFF_HERMES_EXECUTABLE: "aieff-hermes-definitely-not-installed" },
  });
  await waitHealth(port, gateway);
}, { timeout: 40000 });

after(() => {
  try { gateway?.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("Hermes Atlas 仅在真实客户端可用或待登录时才标记为已安装", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/config/check-engine/hermes-atlas`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.provider, "atlas");
  assert.equal(body.data.available, false);
  assert.equal(body.data.status, "not_installed");
});
