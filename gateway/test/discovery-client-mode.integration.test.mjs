import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "discclient-"));
const PORT = 39721;
const cfgPath = path.join(tmp, "gw.json");

fs.writeFileSync(cfgPath, JSON.stringify({
  role: "standalone",
  claudeProxy: { enabled: false, maxConcurrent: 3 },
  claudeProxyClient: { enabled: true, host: "http://127.0.0.1:3001" },
  servers: { nodeName: "client-a", discovery: false, peers: [] },
}));

const disc = (p) => fetch(`http://localhost:${PORT}/api/discovery${p}`).then((r) => r.json());

let srv;
before(async () => {
  srv = bootGateway({ port: PORT, role: "standalone", gwCfg: cfgPath, market: path.join(tmp, "m.json"), storeDir: path.join(tmp, "s") });
  await waitHealth(PORT, srv);
}, { timeout: 40000 });
after(() => { try { srv.kill(); } catch {} });

test("claudeProxyClient.enabled makes a standalone gateway advertise as client, not AI server", async () => {
  const info = await disc("/info");
  assert.equal(info.ok, true);
  assert.equal(info.data.role, "standalone");
  assert.equal(info.data.isServer, false);
  assert.equal(info.data.claudeEnabled, false);

  const servers = await disc("/servers");
  assert.equal(servers.ok, true);
  assert.equal(servers.data.some((s) => s.id === info.data.id), false);
});
