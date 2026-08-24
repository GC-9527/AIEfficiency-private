import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_PROMPT_V2_ROLLOUT,
  normalizePromptV2Rollout,
} from "./devbench/workflow-v2/prompt-v2-rollout.js";
import {
  DEFAULT_PROMPT_COMPATIBILITY_ROLLOUT,
  normalizePromptCompatibilityRollout,
} from "./devbench/workflow-v2/prompt-compatibility-overlay.js";
import {
  DEFAULT_FEISHU_PRIORITY_MAPPING,
  DEFAULT_SYNC_ROUTING,
  LEGACY_TEAMBITION_DEFAULTS,
} from "../../features/FeiShuProjects/src/sync-policy-engine.js";
import {
  DEFAULT_API_MAX_TOOL_ITERATIONS,
  normalizeApiMaxToolIterations,
} from "./agent-progress.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 配置文件路径（测试可用 GATEWAY_CONFIG_PATH 覆盖，实现实例隔离）
const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH || join(__dirname, "..", "config.json");
const DEFAULT_FEISHU_SYNC_TB_PROJECT_ID = LEGACY_TEAMBITION_DEFAULTS.projectId;
const DEFAULT_FEISHU_SYNC_TB_TASKLIST_ID = LEGACY_TEAMBITION_DEFAULTS.tasklistId;
const DEFAULT_FEISHU_SYNC_TB_TASKLIST_NAME = LEGACY_TEAMBITION_DEFAULTS.tasklistName;
const DEFAULT_FEISHU_SYNC_TB_PROJECT_PATH_NAME = LEGACY_TEAMBITION_DEFAULTS.projectPathName;
const DEFAULT_FEISHU_SYNC_TB_SPRINT_ID = LEGACY_TEAMBITION_DEFAULTS.sprintId;
const DEFAULT_FEISHU_SYNC_TB_SPRINT_NAME = LEGACY_TEAMBITION_DEFAULTS.sprintName;
const DEFAULT_FEISHU_SYNC_TB_SPRINT_URL = LEGACY_TEAMBITION_DEFAULTS.sprintUrl;
const DEFAULT_FEISHU_SYNC_TB_EXECUTOR_ID = LEGACY_TEAMBITION_DEFAULTS.defaultExecutorId;
const DEFAULT_FEISHU_SYNC_TB_EXECUTOR_NAME = LEGACY_TEAMBITION_DEFAULTS.defaultExecutorName;

function boundedPositive(value, fallback, min, max) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(max, Math.max(min, Math.round(resolved)));
}

function normalizeApiAgentSupervision(value = {}, fallback = {}) {
  const merged = { ...fallback, ...(value || {}) };
  const warning = boundedPositive(merged.meaningfulProgressWarningMinutes, 10, 1, 10080);
  const cancel = boundedPositive(merged.meaningfulProgressCancelMinutes, 60, warning + 1, 43200);
  return {
    ...merged,
    activeTurnMaxMinutes: boundedPositive(merged.activeTurnMaxMinutes, 480, 5, 10080),
    meaningfulProgressWarningMinutes: warning,
    meaningfulProgressCancelMinutes: Math.max(warning + 1, cancel),
    terminationVerifySeconds: boundedPositive(merged.terminationVerifySeconds, 15, 1, 120),
  };
}

export const DEFAULT_WORKFLOW_V2_FEATURE_FLAGS = Object.freeze({
  promptCompatibilityOverlay: true,
});

// Atlas Coding Plan 官网「支持的模型与积分倍率」目录（2026-08-20）。
// 启动时会与旧配置中的条目做并集，既补齐官方清单，也保留用户曾使用的自定义/历史模型 ID。
export const ATLAS_CODING_PLAN_MODELS = Object.freeze([
  "deepseek-ai/deepseek-v4-flash-0731",
  "qwen/qwen3.8-max",
  "bytedance/doubao-seed-2.1-turbo-260628",
  "bytedance/doubao-seed-2.1-pro-260628",
  "zai-org/glm-5.2",
  "moonshotai/kimi-k2.7-code",
  "minimaxai/minimax-m3",
  "deepseek-ai/deepseek-v4-pro",
  "deepseek-ai/deepseek-v4-flash",
  "moonshotai/kimi-k2.6",
  "qwen/qwen3.6-plus",
  "zai-org/glm-5.1",
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m2.5",
  "zai-org/glm-5",
  "moonshotai/kimi-k2.5",
  "deepseek-ai/deepseek-v3.2",
]);

export const WORKFLOW_RUNTIME_MODE = "prompt-only";
export const PROMPT_ONLY_PRODUCTION_CONFIG_VERSION = 1;

const RETIRED_FULL_V2_FEATURE_FLAGS = Object.freeze([
  "promptV2",
  "structuredResultsV2",
  "stageToolFiltering",
  "evidenceReceiptsRequired",
  "tbSyncSaga",
  "shortReportDeterministic",
  "strictMarkersV2",
]);

export const DEFAULT_WORKFLOW_V2_PROMPT_COMPATIBILITY_ROLLOUT = Object.freeze({
  valid: true,
  percentage: DEFAULT_PROMPT_COMPATIBILITY_ROLLOUT.percentage,
  salt: DEFAULT_PROMPT_COMPATIBILITY_ROLLOUT.salt,
  storyIds: Object.freeze([]),
  providers: Object.freeze([]),
  stages: Object.freeze([]),
});

function normalizeWorkflowV2PromptRollout(current = {}, incoming = {}, incomingSpecified = false) {
  const currentValue = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  if (incomingSpecified && (!incoming || typeof incoming !== "object" || Array.isArray(incoming))) {
    const disabled = normalizePromptV2Rollout(incoming);
    return {
      valid: disabled.valid,
      percentage: disabled.percentage,
      salt: disabled.salt,
      storyIds: disabled.storyIds,
      providers: disabled.providers,
    };
  }
  const incomingValue = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
  const merged = { ...currentValue, ...incomingValue };
  // `valid` is an internal fail-closed marker. A later explicit, well-formed
  // update may repair an invalid runtime value without asking clients to know
  // about that marker; a marker loaded from disk is preserved.
  if (incomingSpecified && !Object.prototype.hasOwnProperty.call(incomingValue, "valid")) delete merged.valid;
  const normalized = normalizePromptV2Rollout(merged);
  return {
    valid: normalized.valid,
    percentage: normalized.percentage,
    salt: normalized.salt,
    storyIds: normalized.storyIds,
    providers: normalized.providers,
  };
}

function normalizeWorkflowV2PromptCompatibilityRollout(current = {}, incoming = {}, incomingSpecified = false) {
  const currentValue = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  if (incomingSpecified && (!incoming || typeof incoming !== "object" || Array.isArray(incoming))) {
    return normalizePromptCompatibilityRollout(incoming);
  }
  const incomingValue = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
  const merged = { ...currentValue, ...incomingValue };
  if (incomingSpecified && !Object.hasOwn(incomingValue, "valid")) delete merged.valid;
  return normalizePromptCompatibilityRollout(merged);
}

function mergeWorkflowV2Config(current = {}, incoming = {}, { migrateStored = false } = {}) {
  const currentConfig = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const incomingConfig = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
  const currentFlags = currentConfig.featureFlags && typeof currentConfig.featureFlags === "object" && !Array.isArray(currentConfig.featureFlags)
    ? currentConfig.featureFlags
    : {};
  const incomingFlags = incomingConfig.featureFlags && typeof incomingConfig.featureFlags === "object" && !Array.isArray(incomingConfig.featureFlags)
    ? incomingConfig.featureFlags
    : {};
  // v1 前的 Prompt-only 配置默认关闭且 scope 为空，导致生产始终回退 legacy 大 Prompt。
  // 只在启动读取旧磁盘配置时迁移一次；运行中的显式关闭仍作为应急回退保留。
  const fullV2TestOnly = process.env.NODE_ENV === "test" && process.env.AIEFF_TEST_FULL_WORKFLOW_V2 === "1";
  const migrateLegacyPromptDefaults = migrateStored
    && !fullV2TestOnly
    && Number(incomingConfig.productionPromptVersion || 0) < PROMPT_ONLY_PRODUCTION_CONFIG_VERSION;
  const promptCompatibilityOverlay = migrateLegacyPromptDefaults
    ? true
    : (Object.hasOwn(incomingFlags, "promptCompatibilityOverlay")
      ? incomingFlags.promptCompatibilityOverlay === true
      : currentFlags.promptCompatibilityOverlay === true);
  const promptOnly = {
    mode: WORKFLOW_RUNTIME_MODE,
    productionPromptVersion: PROMPT_ONLY_PRODUCTION_CONFIG_VERSION,
    featureFlags: { promptCompatibilityOverlay },
    promptCompatibilityRollout: migrateLegacyPromptDefaults
      ? normalizePromptCompatibilityRollout(DEFAULT_WORKFLOW_V2_PROMPT_COMPATIBILITY_ROLLOUT)
      : normalizeWorkflowV2PromptCompatibilityRollout(
        currentConfig.promptCompatibilityRollout,
        incomingConfig.promptCompatibilityRollout,
        Object.hasOwn(incomingConfig, "promptCompatibilityRollout"),
      ),
  };
  // Full V2 已退出产品运行时。只给显式测试进程保留旧协议回归入口，避免生产配置、
  // execution profile、receipt 或 Controller 字段重新接回普通故事发送链。
  if (!fullV2TestOnly) {
    return promptOnly;
  }
  const fullFeatureFlags = { ...DEFAULT_WORKFLOW_V2_FEATURE_FLAGS };
  for (const key of RETIRED_FULL_V2_FEATURE_FLAGS) {
    fullFeatureFlags[key] = Object.hasOwn(incomingFlags, key)
      ? incomingFlags[key] === true
      : currentFlags[key] === true;
  }
  return {
    ...currentConfig,
    ...incomingConfig,
    mode: "full-v2-test-only",
    featureFlags: { ...fullFeatureFlags, promptCompatibilityOverlay },
    promptV2Rollout: normalizeWorkflowV2PromptRollout(
      currentConfig.promptV2Rollout,
      incomingConfig.promptV2Rollout,
      Object.hasOwn(incomingConfig, "promptV2Rollout"),
    ),
    promptCompatibilityRollout: promptOnly.promptCompatibilityRollout,
  };
}

// 运行时配置（内存中，即时生效）
let runtimeConfig = {
  dingtalkAppKey: "",
  dingtalkAppSecret: "",
  dingtalkRobotWebhook: "",
  dingtalkRobotToken: "",
  dingtalkRobotSecret: "",
  defaultEngine: "claude",
  storyPointAiInferenceEnabled: false,
  // 轻量 Prompt-only：生产默认使用精简阶段 Prompt，保留 legacy 状态机/TB Saga/普通 worktree。
  workflowV2: {
    mode: WORKFLOW_RUNTIME_MODE,
    productionPromptVersion: PROMPT_ONLY_PRODUCTION_CONFIG_VERSION,
    featureFlags: { ...DEFAULT_WORKFLOW_V2_FEATURE_FLAGS },
    promptCompatibilityRollout: {
      ...DEFAULT_WORKFLOW_V2_PROMPT_COMPATIBILITY_ROLLOUT,
      storyIds: [],
      providers: [],
      stages: [],
    },
  },
  // 部署角色：standalone(单机全功能,默认) | server(中心:Claude能力+编排) | node(客户端节点:本地执行+开发工具)
  // 也可用环境变量 ROLE 覆盖（部署时更灵活）。改后需重启网关生效。
  role: "standalone",
  geminiEnabled: false,
  codexEnabled: false,
  hermesEnabled: false,
  autoFallback: true,
  // 中心 AI 文本代理（局域网共享中心机的 AI 后端给远端做非 agentic 文本任务）
  // backend: "cli"=本机订阅 Claude CLI；"codex"=本机订阅 Codex CLI；
  //          "api"=Anthropic API Key；"api-engine"=复用 apiEngines 中的 OpenAI 兼容 API Key 配置
  claudeProxy: {
    enabled: false, token: "", maxConcurrent: 3,
    backend: "cli",
    apiEngineId: "openai",
    anthropicApiKey: "", anthropicModel: "claude-sonnet-4-6",
    anthropicBaseUrl: "https://api.anthropic.com", anthropicMaxTokens: 4096,
    dailyTokenBudget: 0, // 每日 token 额度(0=不限)；剩余=额度-今日已用，用尽则算力不足不可连
  },
  claudeProxyClient: { enabled: false, host: "", token: "" },        // 远端机：指向中心机地址，文本任务转发过去
  // 车型源码配置可独立使用另一台 Gateway 作为事实源，不要求启用远端 AI。
  vehicleConfigCenter: { enabled: false, host: "", token: "" },
  // 远端执行器（阶段1）：本机作为「远端」被中心大脑驱动，在本机工程内执行工具
  executor: { enabled: false, token: "", allowedRoots: [] },
  // 分布式执行模式：中心 AI 负责推理，客户端本地执行器负责读写文件/命令并回灌结果。
  distributedExecution: {
    enabled: true,
    protocol: "v2", // v2 = client-driven Agent V2; legacy = server calls /api/executor/run-tool
    maxRounds: 12,
    commandPolicy: "trusted",
    requireRelativePaths: true,
    requireV2Signature: false,
    audit: true,
  },
  // 中心已知的远端执行器列表（本机作为「中心」调度用）：[{ name, host, token }]
  remoteExecutors: [],
  // 局域网服务发现（多服务端 + 客户端选服务端 + 算力感知）
  servers: {
    nodeId: "",            // 本机稳定 id（自动生成）
    nodeOwnerName: "",     // 节点名称只读前缀（当前登录钉钉/管理员用户名）
    nodeName: "",          // 节点名称后缀（空则用主机名）
    discovery: true,       // 同子网 UDP 广播自动发现
    discoveryPort: 48900,  // 发现广播端口
    discoverySeeds: [],    // 部署预置的跨子网签名发现引导节点；不授予敏感 M2M 访问
    peers: [],             // 手动添加的服务端地址（跨子网用）["http://ip:port"]
    selectedHost: "",      // 客户端选定的服务端（= claudeProxyClient.host 来源）
    advertiseIp: "",       // 对外 IP（多网卡时用户选定；空=自动取第一个非内网 IPv4）
  },
  // 车型等团队配置的局域网增量同步。与 AI 的 server/node 角色相互独立。
  lanSync: {
    syncMode: "disabled",   // 第一次管理员车型发布后自动建组，其它局域网节点自动加入
    allowInsecureTransport: false, // 旧配置兼容字段；v2 始终使用应用层 AEAD
    teamConfigSpace: "",    // 空值统一为 team/vehicle-source，不按 profile 隔离
    groupId: "",            // 第一次管理员车型发布时生成；隔离同一局域网中的不同同步组
    legacyCompatibility: false,
    maxPayloadBytes: 262144,
    maxOpsPerChangeSet: 100,
    mtls: {
      enabled: false,
      required: true,
      caPath: "",
      certPath: "",
      keyPath: "",
      serverName: "",
    },
    diagnosticLog: {
      enabled: true,
      directory: "",
      maxBytes: 2097152,
      maxFiles: 5,
      retentionDays: 7,
    },
    compaction: {
      enabled: true,
      retentionDays: 30,
    },
  },
  // 管理后台 RBAC：超管登录用 TOTP 动态验证码（密钥存 gateway/.secrets/admin-totp.json，不进 git）；
  // 管理员名单存 DB(admin_users)，由超管从组织成员(TB)里设置。
  // dingRedirectUri：可选的钉钉「扫码登录」回调地址（须与钉钉后台白名单一致；仅用钉钉扫码时需要）
  adminAuth: { dingRedirectUri: "" },
  // AI 模型服务（OpenAI 兼容格式）。内置服务见 BUILTIN_API_ENGINE_IDS；用户可追加任意自定义服务。
  apiEngines: {
    qwen: {
      enabled: false,
      name: "通义千问",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "",
      model: "qwen-plus",
      availableModels: ["qwen-max-latest","qwen-plus-latest","qwq-plus","qwen-max","qwen-plus","qwen-turbo"],
      docsUrl: "https://help.aliyun.com/zh/model-studio/developer-reference/compatibility-of-openai-with-dashscope",
    },
    kimi: {
      enabled: false,
      name: "Kimi (月之暗面)",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "",
      model: "moonshot-v1-8k",
      availableModels: ["kimi-latest","moonshot-v1-128k","moonshot-v1-32k","moonshot-v1-8k"],
      docsUrl: "https://platform.moonshot.cn/docs/api/chat",
    },
    deepseek: {
      enabled: false,
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "",
      model: "deepseek-v4-pro",
      availableModels: ["deepseek-v4-pro","deepseek-v4-flash","deepseek-reasoner","deepseek-chat"],
      thinkingEnabled: true,
      reasoningEffort: "high",
      docsUrl: "https://api-docs.deepseek.com/",
    },
    openai: {
      enabled: false,
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o",
      availableModels: ["gpt-4o","gpt-4o-mini","o3-mini","o1","o1-mini","gpt-4-turbo","gpt-4","gpt-3.5-turbo"],
      docsUrl: "https://platform.openai.com/docs/api-reference",
    },
    // Atlas Cloud Coding Plan：故事点直接走 OpenAI 兼容协议；Claude Code 的
    // Anthropic 地址及四类客户端全局配置由 atlas-client-config 单独适配。
    atlas: {
      enabled: false,
      name: "Atlas Coding Plan",
      baseUrl: "https://api.atlascloud.ai/v1",
      apiKey: "",
      model: "zai-org/glm-5.1",
      availableModels: [...ATLAS_CODING_PLAN_MODELS],
      thinkingEnabled: false,
      docsUrl: "https://www.atlascloud.ai/docs/zh/coding-plan/api",
    },
    // 智谱 BigModel：OpenAI Chat Completions 兼容。通用开放平台用 paas/v4；
    // GLM Coding Plan 套餐 Key 需改用 coding/paas/v4（见 availableEndpoints）。
    bigmodel: {
      enabled: false,
      name: "智谱 BigModel",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "",
      model: "glm-5.2",
      availableModels: ["glm-5.2", "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-flash", "glm-4-plus"],
      availableEndpoints: [
        { label: "开放平台（通用）", url: "https://open.bigmodel.cn/api/paas/v4" },
        { label: "Coding Plan", url: "https://open.bigmodel.cn/api/coding/paas/v4" },
      ],
      thinkingEnabled: false,
      docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
    },
    // 火山方舟：Agent Plan / Coding Plan 均走 OpenAI 兼容；套餐 Key 必须用对应专用端点，
    // 勿用通用 /api/v3（否则不扣套餐、可能按量计费）。OpenCode 同协议可复用本配置。
    volcengine: {
      enabled: false,
      name: "火山方舟",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      apiKey: "",
      model: "ark-code-latest",
      availableModels: [
        "ark-code-latest",
        "glm-5.2[1m]",
        "deepseek-v4-pro[1m]",
        "deepseek-v4-flash[1m]",
        "glm-5.2",
        "deepseek-v4-pro",
        "deepseek-v4-flash",
        "doubao-seed-2.0-code",
        "doubao-seed-code",
        "glm-4.7",
        "kimi-k2.6",
        "kimi-k2.5",
        "deepseek-v3.2",
      ],
      availableEndpoints: [
        { label: "Agent Plan", url: "https://ark.cn-beijing.volces.com/api/plan/v3" },
        { label: "Coding Plan", url: "https://ark.cn-beijing.volces.com/api/coding/v3" },
      ],
      // Claude Code 扩展上下文：1M 模型自动加 [1m] + CLAUDE_CODE_AUTO_COMPACT_WINDOW
      claudeExtendedContext: true,
      thinkingEnabled: false,
      docsUrl: "https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2373741?lang=zh",
    },
    // MiniMax：Anthropic 兼容协议，可直接接入 Claude Code（终端 claude / 故事点 claude-minimax）。
    // 凭证用 ANTHROPIC_API_KEY（与方舟的 ANTHROPIC_AUTH_TOKEN 区分）；MiniMax-M3 支持 1M 上下文。
    minimax: {
      enabled: false,
      name: "MiniMax",
      baseUrl: "https://api.minimaxi.com/v1",
      apiKey: "",
      model: "MiniMax-M3",
      availableModels: [
        "MiniMax-M3",
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
        "MiniMax-M2.5",
        "MiniMax-M2.5-highspeed",
        "MiniMax-M2.1",
        "MiniMax-M2.1-highspeed",
        "MiniMax-M2",
      ],
      thinkingEnabled: false,
      docsUrl: "https://platform.minimaxi.com/docs/guides/quickstart-preparation",
    },
  },
  // API Agent 本地工具安全策略。文件工具始终限制在故事点工作区；Shell 按权限级别授权。
  apiAgent: {
    workspaceIsolation: true,
    commandPolicy: "workspace", // read_only | workspace | trusted
    commandTimeoutSeconds: 120,
    processMaxMinutes: 120,
    // 只限制一次可恢复执行片段；故事点本身可跨月/跨年保存并从检查点续跑。
    activeTurnMaxMinutes: 480,
    meaningfulProgressWarningMinutes: 10,
    meaningfulProgressCancelMinutes: 60,
    terminationVerifySeconds: 15,
  },
  // Codeup Merge Request / PR 配置。中心版 organizationId 与开发者个人 token 可在本机设置页配置；环境变量优先。
  // 仓库 ID 会根据当前 Git remote 自动发现，评审人 ID 会根据 reviewerName 自动查询，均可按需显式覆盖。
  // CODEUP_ORGANIZATION_ID / CODEUP_ACCESS_TOKEN / CODEUP_REPOSITORY_ID / CODEUP_REPOSITORY_PATH / CODEUP_REVIEWER_USER_IDS。
  codeup: {
    apiBaseUrl: "https://openapi-rdc.aliyuncs.com",
    edition: "central",
    changesUrl: "https://codeup.aliyun.com/xunihezi/AppMarket/changes",
    organizationId: "",
    accessToken: "",
    repositoryId: "",
    repositoryPath: "",
    reviewerUserIds: [],
    reviewerName: "阳荣峰",
  },
  cloudDomain: "",
  enableDecomposition: true,
  decompositionEngine: "gemini",
  summaryEngine: "gemini",
  maxSubtasks: 5,
  // 全局人设（平台自动适配）
  persona: `你是 AAOS（Android Automotive OS）三方应用集成 AI 助手。
你的工作环境是 ${process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux"} + ADB，主要职责是帮助工程师完成车机应用的集成、适配、调试和问题分析工作。
回复时使用中文，技术术语保持原文。输出应结构化、简洁、可操作。`,
  // 上下文管理
  contextMaxHistory: 30,
  contextEnableSummary: true,
  // 日志保留：task_logs 超过该天数自动清理(0=不按时间清)；另有 20 万条总量兜底。启动时清一次 + 每 12h 清
  logRetentionDays: 14,
  // CLI 引擎工作目录（留空则使用用户主目录）
  workDir: "",
  // CLI 引擎最大并发进程数（API 引擎不受限）
  maxCliConcurrency: 2,
  // API 引擎单次可恢复执行片段的工具调用最大迭代次数（防止失控循环）。
  apiMaxToolIterations: DEFAULT_API_MAX_TOOL_ITERATIONS,
  // 监察审查
  enableInspection: true,
  inspectionEngine: "gemini",
  maxInspectionRetries: 1,
  // 工作报告
  reportOutputDir: "",    // 报告输出目录（留空则使用 ~/ai-reports）
  teambition: {
    appId: "",
    appSecret: "",
    orgId: "",
    operatorId: "",
    // 操作的 TB 项目列表 [{id,name}]；为空时回退旧"平台组件"项目（向后兼容）。多项目时 devbench 按项目隔离。
    projects: [],
  },
  // TB 任务监控
  tbTaskWatcher: {
    enabled: false,
    executorId: "",
    projectIds: [],
    autoComment: true,
    localDir: "",
  },
  // 飞书集成
  feishu: {
    appId: "",
    appSecret: "",
    enabled: false,
  },
  // Feishu Project work item -> Teambition task sync.
  feishuProjectSync: {
    enabled: false,
    routing: JSON.parse(JSON.stringify(DEFAULT_SYNC_ROUTING)),
    feishu: {
      baseUrl: "https://project.feishu.cn",
      pluginId: "",
      pluginSecret: "",
      userKey: "",
      spaceKey: "intelligentspace",
      workItemTypeKey: "bug",
      sourceUrlTemplate: "{baseUrl}/{spaceKey}/{workItemTypeKey}/detail/{workItemId}",
      tokenPath: "/open_api/authen/plugin_token",
      searchPathTemplate: "/open_api/{spaceKey}/work_item/{workItemTypeKey}/search",
      detailPathTemplate: "/open_api/{spaceKey}/work_item/{workItemTypeKey}/{workItemId}",
      fieldMetadataPathTemplate: "",
      fieldsPathTemplate: "",
      commentsPathTemplate: "",
      attachmentsPathTemplate: "",
      tokenHeaderName: "Authorization",
      tokenHeaderPrefix: "Bearer ",
      userKeyHeaderName: "X-USER-KEY",
      requestTimeoutMs: 30000,
      pageSize: 50,
      maxPages: 1000,
      retry: {
        attempts: 4,
        baseDelayMs: 400,
        maxDelayMs: 5000,
        statusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
        apiCodes: [429, 500, 502, 503, 504],
      },
      rateLimit: { requestsPerSecond: 3, minIntervalMs: 0 },
    },
    teambition: {
      projectId: DEFAULT_FEISHU_SYNC_TB_PROJECT_ID,
      tasklistId: DEFAULT_FEISHU_SYNC_TB_TASKLIST_ID,
      tasklistName: DEFAULT_FEISHU_SYNC_TB_TASKLIST_NAME,
      stageId: "",
      sprintId: DEFAULT_FEISHU_SYNC_TB_SPRINT_ID,
      sprintName: DEFAULT_FEISHU_SYNC_TB_SPRINT_NAME,
      sprintUrl: DEFAULT_FEISHU_SYNC_TB_SPRINT_URL,
      taskflowstatusId: "",
      scenariofieldconfigId: "",
      defaultExecutorId: DEFAULT_FEISHU_SYNC_TB_EXECUTOR_ID,
      defaultExecutorName: DEFAULT_FEISHU_SYNC_TB_EXECUTOR_NAME,
      projectPathName: DEFAULT_FEISHU_SYNC_TB_PROJECT_PATH_NAME,
      requiredInvolveMembers: [],
      createTaskPath: "/api/v3/task/create",
      updateTaskPath: "/api/v3/task/update",
      customFieldsPathTemplate: "/api/v3/task/{taskId}/customfields",
      commentPathTemplate: "/api/v3/task/{taskId}/comment",
      writeCustomFieldsAfterCreate: false,
    },
    mappings: { people: {}, priority: { ...DEFAULT_FEISHU_PRIORITY_MAPPING }, status: {}, severity: {}, fields: {} },
    sync: { batchSize: 50, includeComments: true, includeAttachments: true, attachmentMode: "comment_link", failOnCommentError: true, failOnAttachmentError: true, stopOnFirstError: true, requiredAssigneeKeywords: ["徐博超"], webhookSecret: "" },
    pocWorkItemIds: [],
  },
};

/** 内置 OpenAI 兼容 API 引擎（不可删除；升级时会合并默认字段） */
export const BUILTIN_API_ENGINE_IDS = new Set(["qwen", "kimi", "deepseek", "openai", "atlas", "bigmodel", "volcengine", "minimax"]);
/** 不可用作自定义 API 引擎 ID 的保留名（与 CLI 引擎冲突） */
export const RESERVED_ENGINE_IDS = new Set([
  "claude",
  "claude-volcengine",
  "claude-minimax",
  "claude-atlas",
  "gemini",
  "codex",
  "codex-minimax",
  "codex-atlas",
  "hermes",
  "hermes-atlas",
  ...BUILTIN_API_ENGINE_IDS,
]);

export function isBuiltinApiEngineId(id) {
  return BUILTIN_API_ENGINE_IDS.has(String(id || "").trim());
}

export function isValidCustomApiEngineId(id) {
  const key = String(id || "").trim();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(key)) return false;
  if (RESERVED_ENGINE_IDS.has(key)) return false;
  return true;
}

function normalizeApiEngines(engines) {
  const normalized = {};
  for (const [id, value] of Object.entries(engines || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (value._delete === true) continue;
    const engine = { ...value };
    delete engine._delete;
    for (const field of ["baseUrl", "apiKey", "model", "name", "docsUrl"]) {
      if (typeof engine[field] === "string") engine[field] = engine[field].trim();
    }
    if (Array.isArray(engine.availableModels)) {
      engine.availableModels = engine.availableModels.map((m) => String(m || "").trim()).filter(Boolean);
    }
    engine.builtin = isBuiltinApiEngineId(id);
    if (!engine.builtin) engine.custom = true;
    normalized[id] = engine;
  }
  return normalized;
}

/**
 * 合并 apiEngines 更新：支持新增自定义引擎、字段覆盖、以及 { _delete:true } / null 删除自定义引擎。
 * @returns {{ engines: object, error?: string }}
 */
export function mergeApiEnginesUpdate(currentEngines = {}, incomingEngines = {}, { isMaskedKey = () => false } = {}) {
  const next = { ...(currentEngines || {}) };
  for (const [id, engine] of Object.entries(incomingEngines || {})) {
    if (engine == null || engine._delete === true) {
      if (isBuiltinApiEngineId(id)) continue;
      delete next[id];
      continue;
    }
    if (typeof engine !== "object" || Array.isArray(engine)) continue;
    if (!next[id] && !isBuiltinApiEngineId(id) && !isValidCustomApiEngineId(id)) {
      return {
        engines: next,
        error: `无效的自定义引擎 ID「${id}」：须为小写字母开头、2-32 位 [a-z0-9_-]，且不能与内置引擎冲突`,
      };
    }
    if (isMaskedKey(engine?.apiKey)) {
      next[id] = { ...(currentEngines?.[id] || {}), ...engine, apiKey: currentEngines?.[id]?.apiKey || "" };
    } else {
      next[id] = { ...(currentEngines?.[id] || {}), ...engine };
    }
    delete next[id]._delete;
    if (isBuiltinApiEngineId(id)) {
      next[id].builtin = true;
      delete next[id].custom;
    } else {
      next[id].custom = true;
      next[id].builtin = false;
    }
  }
  return { engines: normalizeApiEngines(next) };
}

// 部署角色是 AI 连接模式的最高优先级：
// - node 是纯客户端，必须关闭本机 AI 代理并启用远端客户端；
// - server 不应再作为其它服务端的客户端；
// - standalone 保留“本机 AI / 借用其它服务端”的用户选择，但两者不能同时开启。
export function normalizeAiConnectionMode(config = {}) {
  const role = String(config.role || "standalone").toLowerCase();
  if (role === "node") {
    return {
      ...config,
      claudeProxy: { ...(config.claudeProxy || {}), enabled: false },
      claudeProxyClient: { ...(config.claudeProxyClient || {}), enabled: true },
    };
  }
  if (role === "server") {
    return {
      ...config,
      claudeProxyClient: { ...(config.claudeProxyClient || {}), enabled: false },
    };
  }
  if (config.claudeProxy?.enabled !== true || config.claudeProxyClient?.enabled !== true) return config;
  return {
    ...config,
    claudeProxyClient: { ...(config.claudeProxyClient || {}), enabled: false },
  };
}

function setMissing(obj, key, value) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = value;
}

function setBlank(obj, key, value) {
  if (obj[key] === undefined || obj[key] === null || obj[key] === "") obj[key] = value;
}

function normalizeFeishuProjectSyncDefaults(config = {}) {
  const sync = config.feishuProjectSync;
  if (!sync || typeof sync !== "object" || Array.isArray(sync)) return config;
  const teambition = sync.teambition && typeof sync.teambition === "object" && !Array.isArray(sync.teambition)
    ? { ...sync.teambition }
    : {};
  setMissing(teambition, "projectId", DEFAULT_FEISHU_SYNC_TB_PROJECT_ID);
  if (teambition.projectId === DEFAULT_FEISHU_SYNC_TB_PROJECT_ID) {
    setBlank(teambition, "tasklistId", DEFAULT_FEISHU_SYNC_TB_TASKLIST_ID);
    setBlank(teambition, "tasklistName", DEFAULT_FEISHU_SYNC_TB_TASKLIST_NAME);
  }
  setMissing(teambition, "sprintId", DEFAULT_FEISHU_SYNC_TB_SPRINT_ID);
  setMissing(teambition, "sprintName", DEFAULT_FEISHU_SYNC_TB_SPRINT_NAME);
  setMissing(teambition, "sprintUrl", DEFAULT_FEISHU_SYNC_TB_SPRINT_URL);
  setBlank(teambition, "defaultExecutorId", DEFAULT_FEISHU_SYNC_TB_EXECUTOR_ID);
  if (teambition.defaultExecutorId === DEFAULT_FEISHU_SYNC_TB_EXECUTOR_ID) setBlank(teambition, "defaultExecutorName", DEFAULT_FEISHU_SYNC_TB_EXECUTOR_NAME);
  const projectPathName = String(teambition.projectPathName || "").replace(/\s+/g, "");
  if (!projectPathName || projectPathName === "平台组件/阿维塔8678平台S应用".replace(/\s+/g, "") || teambition.tasklistId === DEFAULT_FEISHU_SYNC_TB_TASKLIST_ID) {
    teambition.projectPathName = DEFAULT_FEISHU_SYNC_TB_PROJECT_PATH_NAME;
  }
  return {
    ...config,
    feishuProjectSync: {
      ...sync,
      teambition,
    },
  };
}

// 启动时从文件加载
if (existsSync(CONFIG_PATH)) {
  try {
    const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // 嵌套配置按子项合并，确保升级后新增的 DeepSeek 思考模式/Agent 权限字段
    // 会出现在旧配置中，同时保留用户自定义的 API 引擎。
    const defaultApiEngines = runtimeConfig.apiEngines;
    const storedApiEngines = stored.apiEngines || {};
    const mergedApiEngines = {};
    for (const id of new Set([...Object.keys(defaultApiEngines), ...Object.keys(storedApiEngines)])) {
      mergedApiEngines[id] = { ...(defaultApiEngines[id] || {}), ...(storedApiEngines[id] || {}) };
      if (id === "atlas") {
        const defaults = Array.isArray(defaultApiEngines.atlas?.availableModels)
          ? defaultApiEngines.atlas.availableModels
          : [];
        const storedModels = Array.isArray(storedApiEngines.atlas?.availableModels)
          ? storedApiEngines.atlas.availableModels
          : [];
        mergedApiEngines[id].availableModels = [...new Set([...defaults, ...storedModels])];
      }
    }
    const mergedConfig = {
      ...runtimeConfig,
      ...stored,
      apiEngines: normalizeApiEngines(mergedApiEngines),
      apiAgent: normalizeApiAgentSupervision(stored.apiAgent, runtimeConfig.apiAgent),
      codeup: { ...runtimeConfig.codeup, ...(stored.codeup || {}) },
      distributedExecution: { ...runtimeConfig.distributedExecution, ...(stored.distributedExecution || {}) },
      workflowV2: mergeWorkflowV2Config(runtimeConfig.workflowV2, stored.workflowV2, { migrateStored: true }),
      lanSync: {
        ...runtimeConfig.lanSync,
        ...(stored.lanSync || {}),
        mtls: { ...runtimeConfig.lanSync.mtls, ...(stored.lanSync?.mtls || {}) },
        diagnosticLog: { ...runtimeConfig.lanSync.diagnosticLog, ...(stored.lanSync?.diagnosticLog || {}) },
        compaction: { ...runtimeConfig.lanSync.compaction, ...(stored.lanSync?.compaction || {}) },
      },
      // 历史 0（不限）和旧默认 15 都迁移为有限但足够宽的单片段上限。
      apiMaxToolIterations: normalizeApiMaxToolIterations(stored.apiMaxToolIterations),
    };
    runtimeConfig = normalizeFeishuProjectSyncDefaults(normalizeAiConnectionMode(mergedConfig));
    const aiModeRepaired = mergedConfig.claudeProxy?.enabled !== runtimeConfig.claudeProxy?.enabled
      || mergedConfig.claudeProxyClient?.enabled !== runtimeConfig.claudeProxyClient?.enabled;
    const workflowV2Repaired = Object.hasOwn(stored, "workflowV2")
      && (process.env.NODE_ENV !== "test" || process.env.AIEFF_TEST_FULL_WORKFLOW_V2 !== "1")
      && JSON.stringify(stored.workflowV2) !== JSON.stringify(runtimeConfig.workflowV2);
    // 将旧版遗留、角色冲突或已退役 Full V2 字段原子写回，避免后续重启继续携带失效配置。
    if (aiModeRepaired || workflowV2Repaired) {
      const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.migration.tmp`;
      try {
        writeFileSync(temporaryPath, JSON.stringify(runtimeConfig, null, 2), "utf-8");
        renameSync(temporaryPath, CONFIG_PATH);
      } finally {
        try {
          if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
        } catch {}
      }
      if (aiModeRepaired) console.log(`[config] 已按部署角色修复 AI 运行模式：role=${runtimeConfig.role}`);
      if (workflowV2Repaired) console.log("[config] 已将历史工作流配置迁移为生产 Prompt-only");
    }
  } catch {}
}

/**
 * 从云端拉取公用配置（TB appId/appSecret/orgId 等），合并到本地配置
 * 只覆盖本地未配置的字段，个人字段（operatorId/userCookie/executorId）不动
 */
export async function syncSharedConfig(cloudUrl) {
  if (!cloudUrl) return;
  try {
    const resp = await fetch(`${cloudUrl.replace(/\/+$/, "")}/api/shared-config`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (!data.success || !data.data) return;

    const shared = data.data;
    const tb = runtimeConfig.teambition || {};
    const sharedTb = shared.teambition || {};

    // 合并公用字段（本地已配置则不覆盖，除非本地为空）
    const updates = {};
    let changed = false;
    if (sharedTb.appId && !tb.appId) { tb.appId = sharedTb.appId; changed = true; }
    if (sharedTb.appSecret && !tb.appSecret) { tb.appSecret = sharedTb.appSecret; changed = true; }
    if (sharedTb.orgId && !tb.orgId) { tb.orgId = sharedTb.orgId; changed = true; }

    if (changed) {
      updates.teambition = tb;
      updateConfig(updates);
      console.log("[config] 已从云端同步公用配置");
    }
  } catch (err) {
    console.log("[config] 云端配置同步失败（不影响使用）:", err.message);
  }
}

/**
 * 获取当前配置（返回副本）
 */
export function getConfig() {
  const workflowV2 = {
    ...(runtimeConfig.workflowV2 || {}),
    featureFlags: { ...(runtimeConfig.workflowV2?.featureFlags || {}) },
    promptCompatibilityRollout: {
      ...(runtimeConfig.workflowV2?.promptCompatibilityRollout || {}),
      storyIds: [...(runtimeConfig.workflowV2?.promptCompatibilityRollout?.storyIds || [])],
      providers: [...(runtimeConfig.workflowV2?.promptCompatibilityRollout?.providers || [])],
      stages: [...(runtimeConfig.workflowV2?.promptCompatibilityRollout?.stages || [])],
    },
  };
  if (runtimeConfig.workflowV2?.promptV2Rollout) {
    workflowV2.promptV2Rollout = {
      ...runtimeConfig.workflowV2.promptV2Rollout,
      storyIds: [...(runtimeConfig.workflowV2.promptV2Rollout.storyIds || [])],
      providers: [...(runtimeConfig.workflowV2.promptV2Rollout.providers || [])],
    };
  }
  return {
    ...runtimeConfig,
    workflowV2,
  };
}

/**
 * 更新配置，即时生效 + 持久化到文件
 */
export function updateConfig(updates) {
  const nextConfig = normalizeFeishuProjectSyncDefaults(normalizeAiConnectionMode({ ...runtimeConfig, ...updates }));
  nextConfig.apiEngines = normalizeApiEngines(nextConfig.apiEngines);
  nextConfig.apiAgent = normalizeApiAgentSupervision(updates?.apiAgent, runtimeConfig.apiAgent);
  nextConfig.apiMaxToolIterations = normalizeApiMaxToolIterations(nextConfig.apiMaxToolIterations);
  nextConfig.codeup = { ...nextConfig.codeup, ...((updates && updates.codeup) || {}) };
  nextConfig.distributedExecution = {
    enabled: true,
    protocol: "v2",
    maxRounds: 12,
    commandPolicy: "trusted",
    requireRelativePaths: true,
    requireV2Signature: false,
    audit: true,
    ...(nextConfig.distributedExecution || {}),
  };
  nextConfig.workflowV2 = mergeWorkflowV2Config(runtimeConfig.workflowV2, updates?.workflowV2);
  nextConfig.lanSync = {
    syncMode: "disabled",
    allowInsecureTransport: false,
    teamConfigSpace: "",
    groupId: "",
    legacyCompatibility: false,
    maxPayloadBytes: 262144,
    maxOpsPerChangeSet: 100,
    ...(runtimeConfig.lanSync || {}),
    ...((updates && updates.lanSync) || {}),
    mtls: {
      ...(runtimeConfig.lanSync?.mtls || {}),
      ...(updates?.lanSync?.mtls || {}),
    },
    diagnosticLog: {
      ...(runtimeConfig.lanSync?.diagnosticLog || {}),
      ...(updates?.lanSync?.diagnosticLog || {}),
    },
    compaction: {
      ...(runtimeConfig.lanSync?.compaction || {}),
      ...(updates?.lanSync?.compaction || {}),
    },
  };

  // Persist before publishing the new in-memory value. A failed write must be
  // observable by API callers; otherwise credentials work until restart while
  // the UI incorrectly reports that they were saved.
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(nextConfig, null, 2), "utf-8");
    renameSync(temporaryPath, CONFIG_PATH);
  } catch (err) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {}
    const failure = new Error(`配置持久化失败: ${err.message}`);
    failure.code = err.code || "CONFIG_PERSIST_FAILED";
    failure.cause = err;
    throw failure;
  }

  runtimeConfig = nextConfig;
  return getConfig();
}

/**
 * 获取某个配置值
 */
export function getConfigValue(key) {
  if (key === "workflowV2") {
    return getConfig().workflowV2;
  }
  return runtimeConfig[key];
}
