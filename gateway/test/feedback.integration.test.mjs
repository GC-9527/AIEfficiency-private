/**
 * 问题反馈 + 帮助中心文档 集成测试（隔离 config/db/totp）：
 *   - 任何人可提交反馈；全员可在列表看到
 *   - 评论；GET 详情；since 增量
 *   - 改状态：无管理员 token → 403；TOTP 登录拿 super token → 放行且状态变更
 *   - /api/help/docs 列出 docs/devbench 下 markdown
 * 用隔离 ADMIN_TOTP_DIR，不触碰真实密钥。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { totp } from "../services/totp.js";
import { bootGateway, waitHealth } from "./_helpers.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fb-"));
const PORT = 39701;
const base = `http://localhost:${PORT}`;
const cfgPath = path.join(tmp, "gw.json");
fs.writeFileSync(cfgPath, JSON.stringify({ role: "standalone" }));
const J = (p, opts) => fetch(base + p, opts).then((r) => r.json());

let srv, token, fbId;
before(async () => {
  srv = bootGateway({ port: PORT, role: "standalone", gwCfg: cfgPath, market: path.join(tmp, "m.json"), storeDir: path.join(tmp, "s"), dbPath: path.join(tmp, "data.db"), totpDir: path.join(tmp, "secrets") });
  await waitHealth(PORT, srv);
  const setup = await J("/api/admin/auth/totp/setup");
  const secret = setup.data?.secret || setup.secret;
  const login = await J("/api/admin/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: totp(secret) }) });
  token = login.token;
}, { timeout: 40000 });
after(() => { try { srv.kill(); } catch {} });

test("任何人可提交反馈（含附件 base64）", async () => {
  const r = await J("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "登录页崩溃", body: "点登录就白屏", priority: "high", reporterName: "张三", reporterId: "zhangsan", page: "/settings",
      attachments: [{ name: "screenshot.png", dataBase64: Buffer.from("fakepng").toString("base64"), kind: "image" }] }) });
  assert.equal(r.ok, true);
  fbId = r.data.id;
  assert.equal(r.data.status, "open");
  assert.equal(r.data.attachments.length, 1);
});

test("全员可在列表看到 + 按提交人筛选", async () => {
  const all = await J("/api/feedback");
  assert.ok(all.data.some((f) => f.id === fbId));
  const byZhang = await J("/api/feedback?reporter=zhangsan");
  assert.ok(byZhang.data.every((f) => f.reporter_id === "zhangsan"));
  const byOther = await J("/api/feedback?reporter=lisi");
  assert.ok(!byOther.data.some((f) => f.id === fbId), "别人筛选看不到张三的");
});

test("评论 + 详情 + since 增量", async () => {
  await J(`/api/feedback/${fbId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "补充：必现", author: "张三" }) });
  const d = await J(`/api/feedback/${fbId}`);
  assert.ok(d.data.comments.some((c) => c.text.includes("必现")));
  const since = await J("/api/feedback/since?since=0");
  assert.ok(since.data.some((f) => f.id === fbId));
});

test("改状态：无管理员 token → 403", async () => {
  const r = await fetch(base + `/api/feedback/${fbId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
  assert.equal(r.status, 403);
  const d = await J(`/api/feedback/${fbId}`);
  assert.equal(d.data.status, "open", "未授权不应改动");
});

test("管理员改状态 → 放行且变更 + 留痕", async () => {
  const r = await J(`/api/feedback/${fbId}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "in_progress", assignee: "管理员A" }) });
  assert.equal(r.ok, true);
  assert.equal(r.data.status, "in_progress");
  assert.equal(r.data.assignee, "管理员A");
  assert.ok(r.data.comments.some((c) => c.text.includes("状态变更")), "应有状态变更留痕");
});

test("dev-config 管理员才能写", async () => {
  const no = await fetch(base + "/api/feedback/dev-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projects: { default: { gitRemote: "x" } } }) });
  assert.equal(no.status, 403);
  const yes = await J("/api/feedback/dev-config", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ projects: { default: { gitRemote: "git@x", branch: "main", localPath: "" } } }) });
  assert.equal(yes.ok, true);
  const get = await J("/api/feedback/dev-config");
  assert.equal(get.data.projects.default.branch, "main");
});

test("帮助中心文档 API 列出 docs/devbench 的 markdown", async () => {
  const r = await J("/api/help/docs");
  assert.equal(r.ok, true);
  assert.ok(r.data.length > 0, "应能列出文档");
  const one = r.data[0];
  const doc = await J(`/api/help/docs/${one.slug}`);
  assert.equal(doc.ok, true);
  assert.ok(doc.data.content.length > 0);
});
