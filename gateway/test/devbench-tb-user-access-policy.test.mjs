import assert from "node:assert/strict";
import test from "node:test";

import {
  currentDevbenchActor,
  currentTbProjectActor,
  currentTbUserActor,
  principalRequiresTbTicketAccessCheck,
} from "../services/devbench-tb-user-access-policy.js";

test("普通 TB 登录态可作为 DevBench 的低权限已认证身份", () => {
  const actor = currentDevbenchActor(null, {
    teambition: {
      operatorId: "tb-user",
      userCookie: "cookie",
      userName: "普通用户",
    },
  });
  assert.equal(actor?.role, "tb-user");
  assert.equal(actor?.authMethod, "teambition_cookie");
  assert.equal(principalRequiresTbTicketAccessCheck(actor), true);
});

test("已有管理员或 M2M 主体优先，不会被 TB 登录态降级或提权", () => {
  const principal = { role: "admin", subject: { issuer: "dingtalk", id: "admin-user" } };
  assert.equal(currentDevbenchActor(principal, {
    teambition: { operatorId: "tb-user", userCookie: "cookie" },
  }), principal);
  assert.equal(principalRequiresTbTicketAccessCheck(principal), false);
});

test("普通 TB 用户身份同时绑定已验证 Cookie 与 operatorId", () => {
  assert.equal(currentTbUserActor({ teambition: { operatorId: "tb-user" } }), null);
  assert.equal(currentTbUserActor({ teambition: { userCookie: "cookie" } }), null);

  assert.deepEqual(currentTbUserActor({
    teambition: {
      operatorId: "tb-user",
      userCookie: "cookie",
      userName: "普通用户",
    },
  }), {
    role: "tb-user",
    name: "普通用户",
    userId: "tb-user",
    subject: { issuer: "teambition", id: "tb-user" },
    authMethod: "teambition_cookie",
  });
});

test("当前 TB 项目始终按 TB 登录账号隔离，不被同时存在的管理员会话改键", () => {
  const admin = {
    role: "super",
    subject: { issuer: "local", id: "local-super" },
  };
  assert.deepEqual(currentTbProjectActor(admin, {
    teambition: {
      operatorId: "tb-current-user",
      userCookie: "cookie",
    },
  })?.subject, { issuer: "teambition", id: "tb-current-user" });
  assert.equal(currentTbProjectActor(admin, { teambition: {} }), admin);
});
