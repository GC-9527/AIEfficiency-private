import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-apply-config-"));
const PORT = 39815;
const base = `http://localhost:${PORT}`;
let srv;

before(async () => {
  srv = bootGateway({
    port: PORT,
    role: "standalone",
    gwCfg: path.join(tmp, "gateway.json"),
    market: path.join(tmp, "market.json"),
    storeDir: path.join(tmp, "store"),
    dbPath: path.join(tmp, "data.db"),
  });
  await waitHealth(PORT, srv);
}, { timeout: 40000 });

after(() => { try { srv.kill(); } catch {} });

const json = (method, url, body) => fetch(base + url, {
  method,
  headers: { "Content-Type": "application/json" },
  body: body == null ? undefined : JSON.stringify(body),
}).then((r) => r.json());

function initRepo(repo, marker) {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "config", "user.name", "Config Apply Test"], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "config", "user.email", "config-apply@example.test"], { stdio: "ignore", windowsHide: true });
  fs.writeFileSync(path.join(repo, `${marker}.txt`), `${marker}\n`);
  execFileSync("git", ["-C", repo, "add", `${marker}.txt`], { stdio: "ignore", windowsHide: true });
  execFileSync("git", ["-C", repo, "commit", "-m", `初始化 ${marker}`], { stdio: "ignore", windowsHide: true });
}

test("复制配置应用到另一个故事点时同步本地工程数量并保留目标 TB 单", async () => {
  const main47 = path.join(tmp, "CARB-12947-main");
  const web47 = path.join(tmp, "CARB-12947-web");
  const extra47 = path.join(tmp, "CARB-12947-extra");
  const main49 = path.join(tmp, "CARB-12949-main");
  initRepo(main47, "main47");
  initRepo(web47, "web47");
  initRepo(extra47, "extra47");
  initRepo(main49, "main49");

  assert.equal((await json("POST", "/api/devbench/projects", { id: "p47", name: "CARB-12947 工程", path: main47, webAppPath: web47 })).ok, true);
  assert.equal((await json("POST", "/api/devbench/projects", { id: "p49", name: "CARB-12949 原工程", path: main49 })).ok, true);

  const source = await json("POST", "/api/devbench/tabs", { title: "#CARB-12947# 来源", projectDefId: "appMarket" });
  const target = await json("POST", "/api/devbench/tabs", { title: "#CARB-12949# 目标", projectDefId: "webApp" });
  assert.equal(source.ok, true, source.error);
  assert.equal(target.ok, true, target.error);

  await json("PUT", `/api/devbench/tabs/${source.data.id}/mode`, { mode: "local" });
  const expertMode = await json("POST", `/api/devbench/tabs/${source.data.id}/workflow/report-mode`, { mode: "expert" });
  assert.equal(expertMode.ok, true, expertMode.error);
  assert.equal(expertMode.data.reportMode, "expert");
  const sourcePrimary = await json("POST", `/api/devbench/tabs/${source.data.id}/primary`, { projectId: "p47" });
  assert.equal(sourcePrimary.ok, true, sourcePrimary.error);
  const sourceExtra = await json("POST", `/api/devbench/tabs/${source.data.id}/extra`, { path: extra47, name: "关联工程" });
  assert.equal(sourceExtra.ok, true, sourceExtra.error);
  await json("PUT", `/api/devbench/tabs/${target.data.id}/mode`, { mode: "local" });
  const targetPrimary = await json("POST", `/api/devbench/tabs/${target.data.id}/primary`, { projectId: "p49" });
  assert.equal(targetPrimary.ok, true, targetPrimary.error);
  await json("POST", `/api/devbench/tabs/${target.data.id}/ticket`, { url: "https://tb.example.com/CARB-12949" });

  const snap = await fetch(base + `/api/devbench/tabs/${source.data.id}/config-snapshot`).then((r) => r.json());
  assert.equal(snap.ok, true, snap.error);
  assert.equal(snap.data.projectDefId, "appMarket");
  assert.equal(snap.data.refs.length, 3);
  assert.equal("reportMode" in snap.data, false, "报告模式属于目标 TB 单，不能进入工程配置快照");

  const applied = await json("POST", `/api/devbench/tabs/${target.data.id}/apply-config`, { snapshot: snap.data });
  assert.equal(applied.ok, true, applied.error);
  assert.ok(applied.data.applied.includes("本地工程×3"), applied.data.applied.join(","));
  assert.equal(applied.data.tab.projectDefId, "appMarket");
  assert.equal(applied.data.tab.primaryProjectId, "p47");
  assert.equal(applied.data.tab.extraProjects.length, 1);
  assert.equal(applied.data.tab.ticketUrl, "https://tb.example.com/CARB-12949");
  assert.equal(applied.data.tab.reportMode, "short", "应用专家单的工程配置后，目标 TB 单仍保持默认简短模式");

  const tabs = await fetch(base + "/api/devbench/tabs").then((r) => r.json());
  const updated = tabs.data.find((t) => t.id === target.data.id);
  assert.equal(updated.refs.length, 3);
  assert.equal(updated.reportMode, "short");
  assert.deepEqual(updated.refs.map((r) => r.role).sort(), ["extra", "primary", "webapp"]);
});
