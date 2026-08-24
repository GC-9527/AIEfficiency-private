/** 测试共享助手：启动隔离的网关子进程 + 等待就绪 + 取数。非测试文件（不含 test()）。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function bootGateway({
  port,
  role = "standalone",
  gwCfg,
  market,
  storeDir,
  dbPath,
  totpDir,
  extraEnv = {},
  allowDiscovery = false,
}) {
  // 测试 Gateway 默认不得加入真实局域网 gossip。仅复制集成测试可显式开启，
  // 否则运行超过一个 reconcile 周期后，测试夹具会与开发环境双向同步。
  const config = fs.existsSync(gwCfg)
    ? JSON.parse(fs.readFileSync(gwCfg, "utf8") || "{}")
    : {};
  const discoveryOptIn = allowDiscovery || config.servers?.discovery === true;
  if (!discoveryOptIn) {
    config.servers = { ...(config.servers || {}), discovery: false, peers: [] };
    fs.writeFileSync(gwCfg, JSON.stringify(config, null, 2), "utf8");
  }
  const isolationDir = storeDir || path.dirname(gwCfg);
  fs.mkdirSync(isolationDir, { recursive: true });
  const child = spawn(process.execPath, ["server.js"], {
    cwd: GW_DIR, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      DEVBENCH_GIT_CONTROLLER_ADAPTER: "in-process-test",
      PORT: String(port),
      ROLE: role,
      GATEWAY_CONFIG_PATH: gwCfg, DEVBENCH_CONFIG_PATH: market, DEVBENCH_STORE_DIR: storeDir,
      DEVBENCH_LOCAL_PROJECTS_PATH: path.join(isolationDir, "devbench-projects.json"),
      AIEFFICIENCY_CLONE_PARENT: path.join(isolationDir, "clone-parent"),
      DEVBENCH_SYNC_SCOPE: `test:${path.basename(path.dirname(gwCfg))}`,
      // 生产默认 60 秒增量同步；集成测试缩短周期以在合理时间内验证最终一致性。
      DEVBENCH_PEER_METADATA_INTERVAL_MS: "8000",
      DEVBENCH_PEER_EVENT_RECONCILE_DEBOUNCE_MS: "2000",
      GATEWAY_DB_PATH: dbPath || path.join(isolationDir, "gateway-test.db"),
      ADMIN_TOTP_DIR: totpDir || path.join(isolationDir, "totp"),
      CLOUD_URL: "http://127.0.0.1:1", // 让 shared-config 同步快速失败，不影响测试
      ...extraEnv,
    },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  child.on("error", () => {});
  child._stderr = () => stderr;
  return child;
}

export async function waitHealth(port, child, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`端口 ${port} 网关未就绪。stderr:\n${(child._stderr?.() || "").slice(-800)}`);
}

export const apiGet = (port, p) => fetch(`http://localhost:${port}/api/devbench${p}`).then((r) => r.json());
