const DEPLOYMENT_ROLES = Object.freeze(["standalone", "server", "node"]);

function normalizeDeploymentRole(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return DEPLOYMENT_ROLES.includes(normalized) ? normalized : "";
}

function resolveConnectionDeploymentRole(connectionConfig = {}) {
  const explicit = normalizeDeploymentRole(connectionConfig.deploymentRole);
  if (explicit) return { role: explicit, legacy: false };

  // 兼容旧版首次选择页：server 实际表示“全功能并共享本机 AI”，client 表示纯客户端。
  if (connectionConfig.role === "server") return { role: "standalone", legacy: true };
  if (connectionConfig.role === "client") return { role: "node", legacy: true };
  return { role: "", legacy: false };
}

function applyDeploymentRoleToGatewayConfig(currentConfig = {}, deploymentRole, options = {}) {
  const role = normalizeDeploymentRole(deploymentRole);
  if (!role) throw new Error(`不支持的部署角色: ${deploymentRole}`);

  const config = {
    ...currentConfig,
    role,
    claudeProxy: { ...(currentConfig.claudeProxy || {}) },
    claudeProxyClient: { ...(currentConfig.claudeProxyClient || {}) },
  };

  if (role === "node") {
    config.claudeProxy.enabled = false;
    config.claudeProxyClient.enabled = true;
  } else if (role === "server") {
    config.claudeProxy.enabled = true;
    config.claudeProxyClient.enabled = false;
  } else {
    config.claudeProxy.enabled = options.enableStandaloneProxy === true;
    config.claudeProxyClient.enabled = false;
  }

  return config;
}

function applyClientToStandaloneConfig(currentConfig = {}) {
  const currentRole = normalizeDeploymentRole(currentConfig.role);
  if (currentRole !== "node") {
    throw new Error("仅允许从“仅客户端”切换到“全功能”");
  }
  return applyDeploymentRoleToGatewayConfig(currentConfig, "standalone");
}

module.exports = {
  DEPLOYMENT_ROLES,
  normalizeDeploymentRole,
  resolveConnectionDeploymentRole,
  applyDeploymentRoleToGatewayConfig,
  applyClientToStandaloneConfig,
};
