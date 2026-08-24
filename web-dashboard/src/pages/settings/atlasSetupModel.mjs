export const ATLAS_CLIENT_TARGETS = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex", tone: "emerald" }),
  Object.freeze({ id: "claude", label: "Claude Code", tone: "sky" }),
  Object.freeze({ id: "opencode", label: "OpenCode", tone: "amber" }),
  Object.freeze({ id: "hermes", label: "Hermes", tone: "violet" }),
]);

export function atlasClientLabel(tool) {
  return ATLAS_CLIENT_TARGETS.find((item) => item.id === String(tool || "").toLowerCase())?.label || String(tool || "AI 工具");
}

export function atlasApplyConfirmation(tool, model) {
  const label = atlasClientLabel(tool);
  const selectedModel = String(model || "").trim() || "当前模型";
  return `将修改 ${label} 的本机全局配置，并把 Atlas ${selectedModel} 设为默认模型。现有文件会先自动备份，是否继续？`;
}

export function atlasApplyPresentation(tool, payload = {}) {
  const label = atlasClientLabel(tool);
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const ok = payload?.success === true || data?.ok === true;
  if (!ok) {
    return {
      ok: false,
      text: String(payload?.error || data?.error || `设置到 ${label} 失败`),
      installGuide: data?.installGuide || null,
      paths: [],
      backups: [],
    };
  }
  const paths = Array.isArray(data?.paths) ? data.paths.filter(Boolean) : [];
  const backupPaths = Array.isArray(data?.backups) ? data.backups.filter(Boolean) : [];
  const suffix = backupPaths.length ? ` · 已备份 ${backupPaths.length} 个原配置文件` : " · 原路径无旧配置，无需备份";
  return {
    ok: true,
    text: `${data?.hint || `已设置到 ${label}`}${suffix}`,
    installGuide: null,
    paths,
    backups: backupPaths,
  };
}

export function atlasActionDisabled({ isAdmin, loading, apiKey, baseUrl, model } = {}) {
  return !isAdmin || !!loading || !String(apiKey || "").trim() || !String(baseUrl || "").trim() || !String(model || "").trim();
}

export function atlasTogglePlan({ checked, isAdmin } = {}) {
  return {
    locallyExpanded: Boolean(checked),
    shouldPersist: Boolean(isAdmin),
    shouldRequestAdminLogin: !isAdmin,
  };
}

export function atlasDetailsVisible({ enabled, locallyExpanded } = {}) {
  return Boolean(enabled || locallyExpanded);
}
