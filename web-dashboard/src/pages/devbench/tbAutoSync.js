export const TB_AUTO_SYNC_AT_KEY = "devbench_tb_autosync_at";
export const TB_AUTO_SYNC_INTERVAL_MS = 120000;

function noopReservation() {
  return { acquired: true, commit: () => false, rollback: () => false };
}

export function tbSyncCountSummary(result = {}) {
  const added = Math.max(0, Number(result?.added) || 0);
  const updated = Math.max(0, Number(result?.updated) || 0);
  if (added > 0) return `新增 ${added}，更新 ${updated}`;
  return `已刷新 ${updated} 条，无新增`;
}

/**
 * 在请求发出前占用自动同步时间窗，避免 StrictMode 重跑 effect 时并发同步同一批 TB 单。
 * 请求失败时仅由仍持有当前时间戳的调用方回滚，避免覆盖后续成功同步的时间。
 */
export function reserveTbAutoSync(storage, now = Date.now(), intervalMs = TB_AUTO_SYNC_INTERVAL_MS) {
  if (!storage?.getItem || !storage?.setItem) return noopReservation();

  const startedAt = Number(now);
  const cooldown = Math.max(0, Number(intervalMs) || 0);
  let previousRaw;
  try {
    previousRaw = storage.getItem(TB_AUTO_SYNC_AT_KEY);
    const previousAt = Number(previousRaw || 0);
    if (previousRaw !== null && Number.isFinite(previousAt) && startedAt - previousAt < cooldown) {
      return { acquired: false, commit: () => false, rollback: () => false };
    }
    storage.setItem(TB_AUTO_SYNC_AT_KEY, String(startedAt));
  } catch {
    return noopReservation();
  }

  const token = String(startedAt);
  return {
    acquired: true,
    commit(completedAt = Date.now()) {
      try {
        if (storage.getItem(TB_AUTO_SYNC_AT_KEY) !== token) return false;
        storage.setItem(TB_AUTO_SYNC_AT_KEY, String(Number(completedAt)));
        return true;
      } catch {
        return false;
      }
    },
    rollback() {
      try {
        if (storage.getItem(TB_AUTO_SYNC_AT_KEY) !== token) return false;
        if (previousRaw === null || previousRaw === undefined) storage.removeItem?.(TB_AUTO_SYNC_AT_KEY);
        else storage.setItem(TB_AUTO_SYNC_AT_KEY, previousRaw);
        return true;
      } catch {
        return false;
      }
    },
  };
}
