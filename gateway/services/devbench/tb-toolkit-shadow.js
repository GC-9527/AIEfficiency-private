const BOOTSTRAP_URL = new URL("../../../tools/tb-ticket-toolkit/packages/tb-application/src/bootstrap.js", import.meta.url);
const ADAPTER_URL = new URL("../../../tools/tb-ticket-toolkit/adapters/aiefficiency/src/index.js", import.meta.url);

function enabledMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  return ["shadow", "canonical"].includes(mode) ? mode : "off";
}

function taskRefFromTab(tab = {}) {
  const taskId = String(tab.taskId || "").trim();
  const taskNo = String(tab.taskNo || tab.ticketNo || tab.carbId || "").trim();
  if (taskId) return { taskId, ...(taskNo ? { taskNo } : {}) };
  return taskNo || String(tab.ticketUrl || "").trim();
}

export function resolveTbToolkitMode({ config = {}, env = process.env } = {}) {
  // Gateway cutover remains deliberately unavailable until the real M6 canary.
  // The adapter supports canonical mode for isolated tests, but production
  // configuration can currently enable only read-only shadow comparison.
  return enabledMode(env.AIEFF_TB_TOOLKIT_MODE || config.tbTicketToolkit?.mode) === "shadow" ? "shadow" : "off";
}

export async function runTbToolkitContextShadow({
  mode = "off",
  tab,
  legacySnapshot,
  repoPath,
  teambitionConfig = {},
  bootstrap,
  createAdapter,
} = {}) {
  const selectedMode = enabledMode(mode);
  if (selectedMode !== "shadow") return { enabled: false, mode: selectedMode };
  const taskRef = taskRefFromTab(tab);
  if (!taskRef || !repoPath) return { enabled: true, mode: selectedMode, ok: false, code: "SHADOW_INPUT_INCOMPLETE" };

  const loadBootstrap = bootstrap || (await import(BOOTSTRAP_URL.href)).bootstrapToolkit;
  const loadAdapter = createAdapter || (await import(ADAPTER_URL.href)).createAiefficiencyAdapter;
  const runtime = await loadBootstrap({
    repoPath,
    profile: "read",
    env: {
      ...process.env,
      TB_TOOLKIT_PROFILE: "read",
      TB_TOOLKIT_REPO: repoPath,
      TB_MCP_APP_ID: teambitionConfig.appId || "",
      TB_MCP_APP_SECRET: teambitionConfig.appSecret || "",
      TB_MCP_ORG_ID: teambitionConfig.orgId || "",
      TB_MCP_OPERATOR_ID: teambitionConfig.operatorId || "",
      TB_WEB_COOKIE: teambitionConfig.userCookie || "",
      TB_TOOLKIT_WRITE_ENABLED: "false",
      TB_TOOLKIT_WRITE_ALLOWLIST: "",
    },
  });
  try {
    const adapter = loadAdapter({
      application: runtime.application,
      mode: "shadow",
      legacyReader: async () => legacySnapshot,
    });
    const result = await adapter.read(taskRef);
    return { enabled: true, mode: selectedMode, ...(result.shadow || { ok: false, code: "SHADOW_RESULT_MISSING" }) };
  } finally {
    await runtime.close();
  }
}
