import assert from "node:assert/strict";
import test from "node:test";

import { createProjectConfigCache } from "./projectConfigCache.mjs";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

test("应用工程配置缓存把空布局也视为可立即展示的有效快照", () => {
  const storage = memoryStorage();
  const first = createProjectConfigCache({ storage, storageKey: "test" });
  first.write("tb-a", { rows: [], applications: [], applicationOptions: ["应用市场"] });

  const reopened = createProjectConfigCache({ storage, storageKey: "test" }).read("tb-a");
  assert.deepEqual(reopened.rows, []);
  assert.deepEqual(reopened.applications, []);
  assert.deepEqual(reopened.applicationOptions, ["应用市场"]);
  assert.ok(reopened.ts > 0);
});

test("应用工程配置缓存按 TB 项目隔离候选与布局", () => {
  const storage = memoryStorage();
  const cache = createProjectConfigCache({ storage, storageKey: "test" });
  cache.write("tb-a", { rows: [{ id: "a" }], applications: [{ id: "app-a" }] });
  cache.write("tb-b", { rows: [{ id: "b" }], applications: [{ id: "app-b" }] });

  assert.equal(cache.read("tb-a").rows[0].id, "a");
  assert.equal(cache.read("tb-b").applications[0].id, "app-b");
  assert.equal(cache.read("tb-missing"), null);
});

test("损坏的持久缓存不会阻断接口回退", () => {
  const storage = memoryStorage({ test: "{invalid" });
  const cache = createProjectConfigCache({ storage, storageKey: "test" });

  assert.equal(cache.read("tb-a"), null);
  assert.deepEqual(cache.write("tb-a", { rows: [], applications: [] }).rows, []);
});

test("候选项先返回时不会把未知布局伪造成空快照", () => {
  const cache = createProjectConfigCache({ storage: memoryStorage(), storageKey: "test" });

  assert.equal(cache.write("tb-a", { applicationOptions: ["应用市场"] }), null);
  assert.equal(cache.read("tb-a"), null);

  cache.write("tb-a", { rows: [{ id: "row-a" }], applications: [{ id: "app-a" }] });
  cache.write("tb-a", { applicationOptions: ["应用市场"] });
  assert.deepEqual(cache.read("tb-a").applicationOptions, ["应用市场"]);
});
