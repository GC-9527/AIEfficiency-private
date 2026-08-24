/**
 * devbench 纯判断逻辑（无 React/DOM 依赖）—— 供组件与单元测试共用。
 * 环境诊断结论、标题识别文案、工具安装方式、API 查询串拼接。
 */

// 缺失的"必需"工具名列表
export function envMissingRequired(envData) {
  if (!envData || !Array.isArray(envData.results)) return [];
  return envData.results.filter((t) => t.required && !t.installed).map((t) => t.name);
}

// 是否可正常编译（所有必需工具已装）
export function envOkToCompile(envData) {
  if (!envData || !Array.isArray(envData.results)) return false;
  return envData.results.filter((t) => t.required).every((t) => t.installed);
}

// 某工具的处理方式：none(已装) / install(可一键装) / manual(手动下载)
export function toolAction(tool, hasWinget) {
  if (!tool || tool.installed) return "none";
  return hasWinget ? "install" : "manual";
}

/** AI 模型诊断摘要文案 */
export function aiModelDiagHeadline(summary) {
  if (!summary || typeof summary !== "object") return "";
  if (summary.allLatest) return "全部已装 CLI 均为最新版本";
  if (summary.anyOutdated) return `${summary.outdated} 个 CLI 可升级到最新版`;
  if (summary.missing === summary.total) return "尚未检测到已安装的 AI CLI";
  if (summary.installed > 0) return `已检测 ${summary.installed} 个 CLI，可查看可见模型`;
  return "已完成 AI 模型诊断";
}

/** CLI 状态 → 展示标签 */
export function aiCliStatusLabel(status) {
  switch (String(status || "")) {
    case "up_to_date": return { text: "已是最新", tone: "ok" };
    case "outdated": return { text: "可升级", tone: "warn" };
    case "not_installed": return { text: "未安装", tone: "muted" };
    case "unknown": return { text: "版本未知", tone: "muted" };
    default: return { text: "未检测", tone: "muted" };
  }
}

/** 是否可一键安装/升级到 npm latest */
export function aiCliNeedsUpgrade(engine) {
  if (engine?.autoUpgradeable === false) return false;
  const status = String(engine?.status || "");
  return status === "outdated" || status === "not_installed";
}

/** 需要升级或安装的引擎列表 */
export function aiCliUpgradeableEngines(engines = []) {
  if (!Array.isArray(engines)) return [];
  return engines.filter(aiCliNeedsUpgrade);
}

/** 单引擎升级按钮文案 */
export function aiCliUpgradeButtonLabel(engine, { busy = false } = {}) {
  if (busy) return "升级中…";
  if (String(engine?.status || "") === "not_installed") return "一键安装最新版";
  return "一键升级到最新";
}

// 标题识别结果 → 文案；无识别返回空串
export function recoText(reco) {
  if (!reco) return "";
  const parts = [reco.app && `应用 ${reco.app}`, reco.vehicle && `车型 ${reco.vehicle}`].filter(Boolean);
  return parts.length ? `（识别：${parts.join("、")}）` : "";
}

// 拼接可选 projectId/refresh 查询串
export function apiQuery({ projectId, refresh } = {}) {
  const qs = [];
  if (refresh) qs.push("refresh=1");
  if (projectId) qs.push(`projectId=${encodeURIComponent(projectId)}`);
  return qs.length ? `?${qs.join("&")}` : "";
}

// node 是纯客户端部署角色，必须使用 AI 服务器；standalone 才允许在本机 AI 与远端 AI 之间选择。
export function isRemoteAiMode(config) {
  const role = String(config?.role || "standalone").toLowerCase();
  if (role === "node") return true;
  if (role === "server") return false;
  return config?.claudeProxy?.enabled !== true && config?.claudeProxyClient?.enabled === true;
}

// 仅在明确选择“借用其它服务端”且没有可用算力时提示。
export function shouldWarnNoAiServer(config, servers = []) {
  if (!isRemoteAiMode(config)) return false;
  return !servers.some((server) => server?.isServer && server?.claudeEnabled && !server?.full);
}
