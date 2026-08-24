const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function toTimeMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 0 && value < 1000000000000 ? value * 1000 : value;
  }

  const text = String(value).trim();
  if (!text) return null;

  const parsedNumber = Number(text);
  if (Number.isFinite(parsedNumber)) {
    return parsedNumber > 0 && parsedNumber < 1000000000000 ? parsedNumber * 1000 : parsedNumber;
  }

  const localMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/
  );
  if (localMatch) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0"] = localMatch;
    const t = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Number(ms.padEnd(3, "0"))
    ).getTime();
    return Number.isFinite(t) ? t : null;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatClockTime(value) {
  const t = toTimeMs(value);
  if (t == null) return "";
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatChineseDateTime(value) {
  const t = toTimeMs(value);
  if (t == null) return "";
  const d = new Date(t);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${formatClockTime(t)}`;
}

export function formatHistoryAwareTime(value, now = Date.now()) {
  const t = toTimeMs(value);
  const nowMs = toTimeMs(now);
  if (t == null || nowMs == null) return "";
  return nowMs - t > DAY_MS ? formatChineseDateTime(t) : formatClockTime(t);
}
