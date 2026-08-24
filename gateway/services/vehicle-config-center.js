import { normalizeHttpOrigin, normalizeM2MToken } from "./m2m-auth.js";

/**
 * Resolve only the routing decision for portable vehicle-source configuration.
 * The actual trust boundary is still enforced by prepareNodeCenterRequest.
 */
export function resolveVehicleConfigCenter(config = {}, {
  role = String(process.env.ROLE || config.role || "standalone").trim().toLowerCase(),
  syncMode = "disabled",
  selfOrigins = [],
} = {}) {
  if (String(syncMode || "disabled").trim().toLowerCase() === "peer") {
    return Object.freeze({ mode: "local", reason: "peer-sync" });
  }

  const explicit = config.vehicleConfigCenter || {};
  if (explicit.enabled === true) {
    const base = normalizeHttpOrigin(explicit.host);
    if (!base) {
      return Object.freeze({
        mode: "blocked",
        code: "VEHICLE_CONFIG_CENTER_HOST_REQUIRED",
        error: "已启用车型配置中心，但中心地址不是完整的 http(s) origin",
      });
    }
    const normalizedSelfOrigins = (Array.isArray(selfOrigins) ? selfOrigins : [selfOrigins])
      .map(normalizeHttpOrigin)
      .filter(Boolean);
    if (normalizedSelfOrigins.includes(base)) {
      return Object.freeze({
        mode: "blocked",
        code: "VEHICLE_CONFIG_CENTER_SELF_REFERENCE",
        error: "车型配置中心不能指向当前 Gateway 自身",
      });
    }
    const token = normalizeM2MToken(explicit.token);
    if (!token) {
      return Object.freeze({
        mode: "blocked",
        code: "VEHICLE_CONFIG_CENTER_TOKEN_REQUIRED",
        error: "已启用车型配置中心，但未配置独立的 Gateway 间连接口令",
      });
    }
    return Object.freeze({ mode: "center", source: "vehicle-config", base, token });
  }

  // Compatibility for existing node/AI-center deployments. New vehicle-source
  // deployments use vehicleConfigCenter and no longer have to enable AI proxying.
  const legacyEnabled = role === "node" || config.claudeProxyClient?.enabled === true;
  const legacyBase = normalizeHttpOrigin(config.claudeProxyClient?.host);
  if (legacyEnabled && legacyBase) {
    return Object.freeze({ mode: "center", source: "legacy-ai", base: legacyBase });
  }
  return Object.freeze({ mode: "local", reason: "not-configured" });
}
