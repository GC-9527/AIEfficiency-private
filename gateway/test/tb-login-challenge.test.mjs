import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetTbLoginChallengesForTests,
  beginTbLoginChallenge,
  cancelTbLoginChallenge,
  completeTbLoginChallenge,
  consumeTbLoginChallenge,
  isActiveTbLoginChallenge,
} from "../services/tb-login-challenge.js";
import { tbTasksWriteRequiresAdmin } from "../services/tb-user-access-policy.js";

test("三种身份边界：普通 TB 登录公开，管理员业务写入保持受保护", () => {
  assert.equal(tbTasksWriteRequiresAdmin("POST", "/login"), false);
  assert.equal(tbTasksWriteRequiresAdmin("POST", "/login/cancel"), false);
  assert.equal(tbTasksWriteRequiresAdmin("GET", "/cookie-check"), false);
  assert.equal(tbTasksWriteRequiresAdmin("POST", "/cookie-verify-save"), true);
  assert.equal(tbTasksWriteRequiresAdmin("POST", "/sync"), true);
});

test("TB 登录 challenge 绑定单次扫码身份且只能消费一次", () => {
  __resetTbLoginChallengesForTests();
  const token = beginTbLoginChallenge({ now: 1000 });
  assert.equal(isActiveTbLoginChallenge(token, { now: 1001 }), true);
  assert.equal(consumeTbLoginChallenge(token, { now: 1002 }).code, "TB_LOGIN_CHALLENGE_PENDING");
  assert.equal(completeTbLoginChallenge(token, { userId: "tb-user", name: "普通用户" }, { now: 1003 }), true);
  const consumed = consumeTbLoginChallenge(token, { now: 1004 });
  assert.deepEqual(consumed, { ok: true, userInfo: { userId: "tb-user", name: "普通用户" } });
  assert.equal(consumeTbLoginChallenge(token, { now: 1005 }).code, "TB_LOGIN_CHALLENGE_INVALID");
});

test("只有当前页面持有的 challenge 可以取消活动登录", () => {
  __resetTbLoginChallengesForTests();
  const oldToken = beginTbLoginChallenge({ now: 2000 });
  const activeToken = beginTbLoginChallenge({ now: 2001 });
  assert.equal(cancelTbLoginChallenge(oldToken, { now: 2002 }), false);
  assert.equal(cancelTbLoginChallenge(activeToken, { now: 2003 }), true);
  assert.equal(isActiveTbLoginChallenge(activeToken, { now: 2004 }), false);
});
