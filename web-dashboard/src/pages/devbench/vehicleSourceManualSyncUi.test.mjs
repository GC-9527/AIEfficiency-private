import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("车型源码配置提供无需二次确认的立即同步按钮", () => {
  const modal = readSource("./VehicleSourceModal.jsx");
  const api = readSource("./api.js");

  assert.match(api, /syncVehicleSourceConfig:\s*\(projectId\)\s*=>\s*call\("POST",\s*"\/vehicle-map\/sync"/);
  assert.match(modal, /data-testid="vehicle-source-sync-now"/);
  assert.match(modal, /devbenchApi\.syncVehicleSourceConfig\(projectId\)/);
  assert.doesNotMatch(modal, /confirm\([^)]*立即同步/);
});

test("主动同步期间保留未发布车型编辑并刷新冲突状态", () => {
  const modal = readSource("./VehicleSourceModal.jsx");

  assert.match(modal, /dirtyFlavorsRef\.current\.size[\s\S]*setRemoteNotice/);
  assert.match(modal, /syncVehicleSourceConfig\(projectId\)[\s\S]*reloadConflicts\(\)/);
});

test("主动同步后端复用管理员读取权限且不创建整包覆盖入口", () => {
  const route = readSource("../../../../gateway/routes/devbench.js");

  assert.match(route, /router\.post\("\/vehicle-map\/sync"[\s\S]*requireVehiclePermission\(req, res, "read"\)/);
  assert.doesNotMatch(route, /router\.post\("\/vehicle-map\/sync"[\s\S]{0,800}(replace|overwrite|applySharedBundle)/i);
});
