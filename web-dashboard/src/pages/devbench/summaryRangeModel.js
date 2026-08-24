function localIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 自定义总结默认覆盖“当前本地日期往前 7 天”到“当前本地日期”。
 * 使用日历日期而不是 toISOString，避免 UTC 时区在午夜附近偏一天。
 */
export function defaultCustomSummaryRange(now = new Date()) {
  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(current.getTime())) return { since: "", until: "" };
  const since = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7);
  return {
    since: localIsoDate(since),
    until: localIsoDate(current),
  };
}

export function summaryRequestErrorMessage(value) {
  const message = String(value || "").trim() || "生成失败";
  if (!/period\s*不正确/i.test(message)) return message;
  return `${message}；当前 Gateway 进程仍是旧版本，请重启 Gateway 后再生成自定义总结`;
}

