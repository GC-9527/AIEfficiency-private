import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TB_AUTO_SYNC_AT_KEY,
  TB_AUTO_SYNC_INTERVAL_MS,
  reserveTbAutoSync,
  tbSyncCountSummary,
} from "./tbAutoSync.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("TB 自动同步：请求前占位会拦截 StrictMode 的第二次并发触发", () => {
  const storage = memoryStorage();
  const first = reserveTbAutoSync(storage, 1000);
  const second = reserveTbAutoSync(storage, 1001);

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(storage.getItem(TB_AUTO_SYNC_AT_KEY), "1000");
});

test("TB 自动同步：失败回滚后可以立即重试", () => {
  const storage = memoryStorage();
  const first = reserveTbAutoSync(storage, 1000);

  assert.equal(first.rollback(), true);
  assert.equal(storage.getItem(TB_AUTO_SYNC_AT_KEY), null);
  assert.equal(reserveTbAutoSync(storage, 1001).acquired, true);
});

test("TB 自动同步：失败回滚不会覆盖后续成功同步时间", () => {
  const storage = memoryStorage();
  const first = reserveTbAutoSync(storage, 1000);
  storage.setItem(TB_AUTO_SYNC_AT_KEY, "2000");

  assert.equal(first.rollback(), false);
  assert.equal(storage.getItem(TB_AUTO_SYNC_AT_KEY), "2000");
});

test("TB 自动同步：成功后继续遵守两分钟节流", () => {
  const storage = memoryStorage();
  const reservation = reserveTbAutoSync(storage, 1000);
  assert.equal(reservation.acquired, true);
  assert.equal(reservation.commit(5000), true);
  assert.equal(storage.getItem(TB_AUTO_SYNC_AT_KEY), "5000");
  assert.equal(reserveTbAutoSync(storage, 5000 + TB_AUTO_SYNC_INTERVAL_MS - 1).acquired, false);
  assert.equal(reserveTbAutoSync(storage, 5000 + TB_AUTO_SYNC_INTERVAL_MS).acquired, true);
});

test("TB 同步提示：有新增显示新增数，无新增时展示实际刷新数", () => {
  assert.equal(tbSyncCountSummary({ added: 2, updated: 0, fetched: 2 }), "新增 2，更新 0");
  assert.equal(tbSyncCountSummary({ added: 0, updated: 30, fetched: 31 }), "已刷新 30 条，无新增");
});
