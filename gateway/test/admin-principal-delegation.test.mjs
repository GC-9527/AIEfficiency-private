import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeForwardedPrincipal,
  encodeForwardedPrincipal,
  forwardedRequestBinding,
} from "../services/m2m-auth.js";

test("local super 是本机 break-glass 身份，禁止跨节点委托", () => {
  assert.equal(encodeForwardedPrincipal({
    role: "super",
    name: "本机超级管理员",
    subject: { issuer: "local", id: "totp-super" },
    userId: "totp-super",
  }, forwardedRequestBinding({ method: "PUT", originalUrl: "/api/devbench/project-defs", body: {} })), "");
});

test("跨节点管理员委托绑定稳定组织主体、授权版本和一次 HTTP 请求", () => {
  const request = { method: "PUT", originalUrl: "/api/devbench/project-defs", body: { name: "repo" } };
  const encoded = encodeForwardedPrincipal({
    role: "admin",
    name: "钉钉管理员",
    subject: { issuer: "dingtalk", id: "ding-admin" },
    userId: "ding-admin",
    dingUserid: "ding-admin",
    authzRevision: 123,
  }, forwardedRequestBinding(request));
  assert.ok(encoded);

  const delegated = decodeForwardedPrincipal(encoded);
  assert.deepEqual(delegated.subject, { issuer: "dingtalk", id: "ding-admin" });
  assert.equal(delegated.userId, "ding-admin");
  assert.equal(delegated.role, "admin");
  assert.equal(delegated.authzRevision, 123);
  assert.equal(delegated.method, "PUT");
  assert.equal(delegated.path, "/api/devbench/project-defs");
  assert.equal(delegated.delegatedFromRole, "admin");
  assert.equal(delegated.forwardedByM2M, true);
});

test("Teambition 普通管理员可委托但仍不能提升为超级管理员", () => {
  const request = { method: "POST", originalUrl: "/api/tb-tasks/sync", body: {} };
  const encoded = encodeForwardedPrincipal({
    role: "admin",
    name: "TB 管理员",
    subject: { issuer: "teambition", id: "57ad8e2fa45d0cba20025b7a" },
    userId: "57ad8e2fa45d0cba20025b7a",
    authzRevision: 456,
  }, forwardedRequestBinding(request));
  assert.ok(encoded);
  const delegated = decodeForwardedPrincipal(encoded);
  assert.deepEqual(delegated.subject, { issuer: "teambition", id: "57ad8e2fa45d0cba20025b7a" });
  assert.equal(delegated.role, "admin");
});

test("解码器拒绝由节点直接声明 super 的旧格式或伪造载荷", () => {
  const forged = Buffer.from(JSON.stringify({
    role: "super",
    name: "forged",
    userId: "attacker",
    subject: { issuer: "peer", id: "attacker" },
  }), "utf8").toString("base64url");

  assert.equal(decodeForwardedPrincipal(forged), null);
});

test("没有稳定主体的角色快照不能被转发", () => {
  assert.equal(encodeForwardedPrincipal(
    { role: "admin", name: "snapshot-only" },
    forwardedRequestBinding({ method: "GET", originalUrl: "/api/devbench/project-defs" }),
  ), "");
});
