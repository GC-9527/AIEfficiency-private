import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aieff-acceptance-cli-"));

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test("route --dry-run is deterministic, database-free, and never executes manifest commands", () => {
  const databasePath = path.join(tempRoot, "must-not-exist.db");
  const sentinelPath = path.join(tempRoot, "command-executed.txt");
  const manifestPath = path.join(tempRoot, "route.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    direct_project_task: true,
    project_paths: ["gateway/services/acceptance"],
    target_repositories: ["AIEfficiency"],
    change_type: "TEST_OR_HARNESS",
    command: `write forbidden sentinel ${sentinelPath}`,
  }));

  const result = spawnSync(process.execPath, [
    path.join(gatewayRoot, "tools", "accept.mjs"),
    "route",
    "--task",
    "PROJECT-CLI-DRY-RUN",
    "--manifest",
    manifestPath,
    "--dry-run",
  ], {
    cwd: gatewayRoot,
    encoding: "utf8",
    env: { ...process.env, GATEWAY_DB_PATH: databasePath },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.route.task_origin, "DIRECT_ENGINEERING");
  assert.equal(output.route.scope_kind, "PROJECT_ENGINEERING");
  assert.equal(output.context, null);
  assert.equal(fs.existsSync(databasePath), false, "dry-run must not initialize SQLite");
  assert.equal(fs.existsSync(sentinelPath), false, "manifest command text is data, never executable input");
});

test("dry-run rejects stateful commands before database initialization", () => {
  const databasePath = path.join(tempRoot, "stateful-dry-run-must-not-exist.db");
  const result = spawnSync(process.execPath, [
    path.join(gatewayRoot, "tools", "accept.mjs"),
    "project",
    "--task",
    "PROJECT-NO-DRY-RUN",
    "--dry-run",
  ], {
    cwd: gatewayRoot,
    encoding: "utf8",
    env: { ...process.env, GATEWAY_DB_PATH: databasePath },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dry-run is supported only by the route command/);
  assert.equal(fs.existsSync(databasePath), false, "rejected dry-run must not initialize SQLite");
});
