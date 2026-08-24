import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEnv, createBackup, readManifest, restoreBackup } from "../services/ai-backup.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("backup env check returns a completed state", () => {
  const env = checkEnv();
  assert.equal(env.platform, process.platform);
  assert.ok(env.checkedAt);
  assert.ok(Array.isArray(env.tools));
  assert.ok(env.tools.length >= 3);
  const node = env.tools.find((tool) => tool.name === "Node.js");
  assert.ok(node?.found, "Node.js should be detected in the running test process");
  assert.ok(node.version || node.path);
});

test("backup restore writes selected project item into target workspace", async () => {
  const { buffer } = await createBackup({ items: ["project-claude-md"], includeSecrets: false });
  const { manifest } = await readManifest(buffer);
  assert.ok(manifest.items.some((item) => item.id === "project-claude-md"));

  const target = mkdtempSync(join(tmpdir(), "ai-backup-restore-"));
  try {
    const report = await restoreBackup({
      zipBuffer: buffer,
      targetWorkspaceRoot: target,
      items: ["project-claude-md"],
      overwrite: false,
    });
    const restored = join(target, "CLAUDE.md");
    assert.ok(existsSync(restored));
    assert.ok(report.written.includes(restored));
    assert.equal(readFileSync(restored, "utf8"), readFileSync(join(repoRoot, "CLAUDE.md"), "utf8"));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("backup env route is mounted in server role", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ai-backup-route-"));
  const port = 34179 + Math.floor(Math.random() * 5000);
  const child = spawn(process.execPath, ["server.js"], {
    cwd: join(repoRoot, "gateway"),
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      ROLE: "server",
      PORT: String(port),
      GATEWAY_CONFIG_PATH: join(tmp, "config.json"),
      GATEWAY_DB_PATH: join(tmp, "data.db"),
      DEVBENCH_CONFIG_PATH: join(tmp, "market.json"),
      DEVBENCH_STORE_DIR: join(tmp, "store"),
      ADMIN_TOTP_DIR: join(tmp, "totp"),
      CLOUD_URL: "http://127.0.0.1:1",
    },
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data.toString(); });

  async function stopChild() {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    if (!child.killed) child.kill();
    await exited;
  }

  try {
    const deadline = Date.now() + 20000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) { healthy = true; break; }
      } catch { /* retry */ }
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 300));
    }
    assert.ok(healthy, `gateway did not become healthy\n${stderr.slice(-1000)}`);

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/env-check`);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const json = JSON.parse(text);
    assert.equal(json.success, true);
    assert.ok(Array.isArray(json.data?.tools));
  } finally {
    await stopChild();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
