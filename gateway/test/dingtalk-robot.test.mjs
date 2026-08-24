import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildDingtalkRobotSendUrl, explainDingtalkRobotError } from "../services/dingtalk-robot.js";

test("buildDingtalkRobotSendUrl：重新生成 timestamp/sign 并移除 URL 中旧签名", () => {
  const secret = "SEC-test-secret";
  const timestamp = 1780000000000;
  const url = buildDingtalkRobotSendUrl(
    "https://oapi.dingtalk.com/robot/send?access_token=token&timestamp=old&sign=old",
    secret,
    () => timestamp,
  );
  const parsed = new URL(url);
  const expected = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  assert.equal(parsed.searchParams.get("access_token"), "token");
  assert.equal(parsed.searchParams.get("timestamp"), String(timestamp));
  assert.equal(parsed.searchParams.get("sign"), expected);
});

test("buildDingtalkRobotSendUrl：未配置 secret 时不追加机器人加签参数", () => {
  assert.equal(
    buildDingtalkRobotSendUrl("https://oapi.dingtalk.com/robot/send?access_token=token", ""),
    "https://oapi.dingtalk.com/robot/send?access_token=token",
  );
});

test("explainDingtalkRobotError：签名不匹配时说明是钉钉机器人加签，不是 APK 签名", () => {
  const msg = explainDingtalkRobotError("机器人发送签名不匹配");
  assert.match(msg, /钉钉机器人加签不匹配/);
  assert.match(msg, /不是 APK\/avatr8678 证书签名问题/);
});
