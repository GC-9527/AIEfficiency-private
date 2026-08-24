import { getConfig } from "./config.js";

export function currentTbUserActor(config = getConfig()) {
  const tb = config?.teambition || {};
  const userId = String(tb.operatorId || "").trim();
  const cookie = String(tb.userCookie || "").trim();
  if (!userId || !cookie) return null;
  return {
    role: "tb-user",
    name: String(tb.userName || userId),
    userId,
    subject: { issuer: "teambition", id: userId },
    authMethod: "teambition_cookie",
  };
}

export function currentTbProjectActor(principal = null, config = getConfig()) {
  return currentTbUserActor(config) || principal || null;
}

/**
 * DevBench is an authenticated user surface, not an administrator-only one.
 * A verified Teambition login therefore supplies the low-privilege principal
 * when the browser does not also carry an administrator/M2M session.
 */
export function currentDevbenchActor(principal = null, config = getConfig()) {
  return principal || currentTbUserActor(config) || null;
}

export function principalRequiresTbTicketAccessCheck(principal = null) {
  return principal?.role === "tb-user"
    && principal?.subject?.issuer === "teambition"
    && !!String(principal?.subject?.id || principal?.userId || "").trim();
}
