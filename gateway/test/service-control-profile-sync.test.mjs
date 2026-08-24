import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
const script = path.join(repositoryRoot, "service-control-electron", "scripts", "sync-dev-profile-data.cjs");

function createProfile(root, vehicleMap) {
  const dbDir = path.join(root, "gateway", "db");
  fs.mkdirSync(dbDir, { recursive: true });
  fs.symlinkSync(
    path.join(repositoryRoot, "gateway", "node_modules"),
    path.join(root, "gateway", "node_modules"),
    "junction",
  );
  const db = new Database(path.join(dbDir, "data.db"));
  db.exec(`
    CREATE TABLE devbench_userdata (
      user_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      node TEXT,
      PRIMARY KEY(user_key, kind)
    );
  `);
  db.prepare(`
    INSERT INTO devbench_userdata(user_key,kind,data,updated_at,node)
    VALUES('__devbench_shared__','shared',?,?,?)
  `).run(JSON.stringify({
    _sharedVersion: 1,
    sharedOps: [],
    sharedOpClocks: {},
    byProject: {
      "project-a": { vehicleMap },
    },
  }), 1, path.basename(root));
  db.close();
}

function readVehicleMap(root) {
  const db = new Database(path.join(root, "gateway", "db", "data.db"), { readonly: true });
  const row = db.prepare(`
    SELECT data FROM devbench_userdata
    WHERE user_key='__devbench_shared__' AND kind='shared'
  `).get();
  db.close();
  return JSON.parse(row.data).byProject["project-a"].vehicleMap;
}

function runSync(source, target, options) {
  const result = spawnSync(process.execPath, [script, source, target, JSON.stringify(options)], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(output.ok, true, JSON.stringify(output));
}

test("Service Control 默认合并 vehicleMap，只有显式 replaceVehicleMap 才删除目标独有车型", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-vehicle-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const targetMerge = path.join(root, "target-merge");
  const targetReplace = path.join(root, "target-replace");
  const sourceMap = { avatr8678: { apps: [{ appName: "A", repos: [] }] } };
  const targetMap = { geelye22: { apps: [{ appName: "G", repos: [] }] } };
  createProfile(source, sourceMap);
  createProfile(targetMerge, targetMap);
  createProfile(targetReplace, targetMap);

  runSync(source, targetMerge, { vehicleMap: true });
  assert.deepEqual(Object.keys(readVehicleMap(targetMerge)).sort(), ["avatr8678", "geelye22"]);

  runSync(source, targetReplace, { vehicleMap: true, replaceVehicleMap: true });
  assert.deepEqual(Object.keys(readVehicleMap(targetReplace)), ["avatr8678"]);
});
