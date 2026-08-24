import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devbench-version-msg-"));
const PORT = 39826;
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

after(() => {
  try { srv.kill(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const json = (method, url, body) => fetch(base + url, {
  method,
  headers: { "Content-Type": "application/json" },
  body: body == null ? undefined : JSON.stringify(body),
}).then((r) => r.json());

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(repo, file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "-m", message]);
}

test("版本按钮更新未 push 提交 message 中的目标 flavor 版本段", async () => {
  const repo = path.join(tmp, "repo");
  const remote = path.join(tmp, "remote.git");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init"]);
  git(repo, ["checkout", "-b", "main"]);
  git(repo, ["config", "user.name", "Devbench Test"]);
  git(repo, ["config", "user.email", "devbench@example.com"]);
  fs.writeFileSync(path.join(repo, "flavorConfig.json"), JSON.stringify({
    baicn5: { versionName: "1.0.60", versionCode: 10060 },
  }, null, 2));
  git(repo, ["add", "flavorConfig.json"]);
  git(repo, ["commit", "-m", "init"]);
  git(tmp, ["init", "--bare", remote]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);

  commit(repo, "pushed.txt", "pushed\n", "#CARB-11934# #1.0.60# #baicn5# 已推送提交 #不应修改#");
  git(repo, ["push"]);
  commit(repo, "target.txt", "target\n", "#CARB-11934# #1.0.60# #baicn5# 【通用】license管控替换CAI新接口方案，支持云侧配置弹窗文案 #补交故事点存档与临时产物忽略规则#");
  commit(repo, "other.txt", "other\n", "#CARB-99999# #1.0.60# #baicn5# 其它故事点 #不应修改#");

  const project = await json("POST", "/api/devbench/projects", { id: "version-msg-repo", name: "版本提交信息工程", path: repo });
  assert.equal(project.ok, true, project.error);
  const tab = await json("POST", "/api/devbench/tabs", { title: "#CARB-11934# license story" });
  assert.equal(tab.ok, true, tab.error);
  assert.equal((await json("POST", `/api/devbench/tabs/${tab.data.id}/primary`, { projectId: "version-msg-repo" })).ok, true);
  const ownedFlavors = await json("GET", `/api/devbench/tabs/${tab.data.id}/flavors`);
  assert.equal(ownedFlavors.ok, true, ownedFlavors.error);
  const ownedRepo = ownedFlavors.data.find((entry) => entry.role === "primary")?.path;
  assert.ok(ownedRepo, JSON.stringify(ownedFlavors));
  const invalidFlavor = await json("POST", `/api/devbench/tabs/${tab.data.id}/flavor`, {
    path: ownedRepo,
    flavor: "hacker-flavor",
  });
  assert.equal(invalidFlavor.ok, false);
  assert.equal(invalidFlavor.code, "WORKFLOW_V2_BUILD_FLAVOR_NOT_ALLOWED", JSON.stringify(invalidFlavor));
  const flavorBeforeValidSave = await json("GET", `/api/devbench/tabs/${tab.data.id}/flavors`);
  assert.equal(flavorBeforeValidSave.ok, true);
  assert.equal(flavorBeforeValidSave.data[0].selected, null);
  assert.equal((await json("POST", `/api/devbench/tabs/${tab.data.id}/flavor`, { path: ownedRepo, flavor: "baicn5" })).ok, true);

  const bumped = await json("POST", `/api/devbench/tabs/${tab.data.id}/flavor-version/bump`, { path: ownedRepo, op: "bump10" });
  assert.equal(bumped.ok, true, bumped.error);
  assert.equal(bumped.data.versionName, "1.0.70");
  assert.equal(bumped.data.versionCode, 10070);
  assert.equal(bumped.data.commitMessages.ok, true, bumped.data.commitMessages.error);
  assert.equal(bumped.data.commitMessages.scanned, 2);
  assert.equal(bumped.data.commitMessages.rewritten, 1);

  const localSubjects = git(ownedRepo, ["log", "--format=%s", "--reverse", "origin/main..HEAD"]).split(/\r?\n/);
  assert.deepEqual(localSubjects, [
    "#CARB-11934# #1.0.70# #baicn5# 【通用】license管控替换CAI新接口方案，支持云侧配置弹窗文案 #补交故事点存档与临时产物忽略规则#",
    "#CARB-99999# #1.0.60# #baicn5# 其它故事点 #不应修改#",
  ]);
  assert.equal(git(ownedRepo, ["log", "-1", "--format=%s", "origin/main"]), "#CARB-11934# #1.0.60# #baicn5# 已推送提交 #不应修改#");

  const saved = JSON.parse(fs.readFileSync(path.join(ownedRepo, "flavorConfig.json"), "utf8"));
  assert.equal(saved.baicn5.versionName, "1.0.70");
  assert.equal(saved.baicn5.versionCode, 10070);
});
