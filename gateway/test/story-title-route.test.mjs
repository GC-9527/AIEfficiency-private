import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const routes = fs.readFileSync(new URL("../routes/devbench.js", import.meta.url), "utf8");

test("故事点重命名保存完整标题，不做静默截断", () => {
  const start = routes.indexOf('router.put("/tabs/:id"');
  const end = routes.indexOf('router.put("/tabs/:id/hidden"', start);
  const renameRoute = routes.slice(start, end);

  assert.ok(start >= 0 && end > start, "应能定位故事点重命名路由");
  assert.match(renameRoute, /updates\.title = t;/);
  assert.doesNotMatch(renameRoute, /updates\.title = t\.slice\(/);
});
