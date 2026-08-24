import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const settingsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "Settings.jsx",
);

test("局域网车型同步设置页不再要求建组、加入码或逐台确认", () => {
  const source = fs.readFileSync(settingsPath, "utf8");
  assert.match(source, /无需开关、建组、加入码或逐台确认/);
  assert.match(source, /管理员第一次在“车型源码配置”里明确发布变更时/);
  assert.match(source, /90 秒低频兜底/);
  assert.doesNotMatch(source, /data-testid="lan-sync-create-group"/);
  assert.doesNotMatch(source, /data-testid="lan-sync-join-group"/);
  assert.doesNotMatch(source, /\/api\/lan-sync\/invitations/);
});
