export const TB_LOGIN_ACTIVE_STATUSES = Object.freeze(["launching", "waiting", "verifying"]);
export const TB_LOGIN_TERMINAL_STATUSES = Object.freeze(["success", "failed", "timeout", "cancelled"]);

const HEALTH_FROM_CODE = Object.freeze({
  COOKIE_VALID: "valid",
  COOKIE_MISSING: "missing",
  COOKIE_EXPIRED: "expired",
  COOKIE_INVALID: "invalid",
  TB_UNAVAILABLE: "unavailable",
});

export function normalizeTbCookieHealth(value) {
  const input = value && typeof value === "object" ? value : {};
  const status = String(input.status || HEALTH_FROM_CODE[input.code] || (input.valid ? "valid" : "invalid"));
  return {
    valid: Boolean(input.valid),
    status,
    code: String(input.code || ""),
    reason: String(input.reason || (input.valid ? "Cookie 有效" : "暂时无法验证 Cookie")),
    checkedAt: input.checkedAt || null,
    hasCookie: input.hasCookie !== false && status !== "missing",
    user: input.user ? String(input.user) : "",
    id: input.id ? String(input.id) : "",
  };
}

export function normalizeTbLoginState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    status: String(input.status || "idle"),
    phase: String(input.phase || ""),
    mode: String(input.mode || ""),
    message: String(input.message || ""),
    user: input.user ? String(input.user) : "",
    userId: input.userId ? String(input.userId) : "",
    busy: Boolean(input.busy),
  };
}

export function isTbLoginActive(value) {
  return TB_LOGIN_ACTIVE_STATUSES.includes(String(value?.status || ""));
}

export function isTbLoginTerminal(value) {
  return TB_LOGIN_TERMINAL_STATUSES.includes(String(value?.status || ""));
}

export function tbCookiePresentation(health) {
  const value = normalizeTbCookieHealth(health);
  if (value.status === "valid") return { label: "已连接", tone: "success", hint: value.user ? `当前账号：${value.user}` : "登录信息可用" };
  if (value.status === "missing") return { label: "未连接", tone: "neutral", hint: "登录后将自动提取并安全保存 Cookie" };
  if (value.status === "expired") return { label: "已过期", tone: "danger", hint: "重新登录即可自动替换失效 Cookie" };
  if (value.status === "unavailable") return { label: "待重试", tone: "warning", hint: "本地 Cookie 未被清除，请检查网络后重试" };
  return { label: "需重新登录", tone: "danger", hint: value.reason || "当前登录信息不可用" };
}

export function formatTbCheckedAt(value, locale = "zh-CN") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
