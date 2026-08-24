import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ENDPOINTS, endpointCatalogForTools } from "./catalog.js";
import {
  AppMarketError,
  publicError,
  sha256,
} from "./security.js";
import { runWithRequestContext } from "./request-context.js";
import {
  assertAtLeastOneIdentifier,
  collectionPayload,
  combinePayloads,
  compareExpected,
  extractCollection,
  extractTotal,
  filterItems,
  mergeVoiceRecords,
  normalizeVoiceKey,
  objectPayload,
  validateRequiredFields,
  voiceKeysForRecord,
} from "./response.js";

export const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

export const TOOL_NAMES = Object.freeze([
  "appmarket_admin_capabilities",
  "appmarket_admin_auth_check",
  "appmarket_admin_list_routes",
  "appmarket_admin_list_metadata",
  "appmarket_admin_list_countries",
  "appmarket_admin_list_car_models",
  "appmarket_admin_get_car_model_country_map",
  "appmarket_admin_list_departments",
  "appmarket_admin_list_apps",
  "appmarket_admin_list_app_options",
  "appmarket_admin_list_banners",
  "appmarket_admin_list_webapp_configs",
  "appmarket_admin_list_channels",
  "appmarket_admin_query_dashboard",
  "appmarket_admin_get_voice_open_keys",
  "appmarket_admin_verify_banner",
  "appmarket_admin_verify_voice_key",
  "appmarket_admin_verify_distribution",
  "appmarket_admin_verify_model_region",
  "appmarket_admin_self_check",
]);

const paginationInput = {
  pageNum: z.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.number().int().min(1).max(100).optional().default(20),
};

const identityInput = {
  appId: z.string().trim().min(1).max(128).optional(),
  appName: z.string().trim().min(1).max(256).optional(),
  packageName: z.string().trim().min(1).max(256).optional(),
};

const dashboardEndpointIds = Object.freeze({
  userActivitySummary: "dashboard.user_activity.summary",
  userActivityDailyTrend: "dashboard.user_activity.daily_trend",
  userActivityMonthlyTrend: "dashboard.user_activity.monthly_trend",
  userActivityRankDistribution:
    "dashboard.user_activity.rank_distribution",
  dailyDownloadTrend: "dashboard.app_usage.daily_download_trend",
  downloadSourceDistribution:
    "dashboard.app_usage.download_source_distribution",
  appDownloadStats: "dashboard.app_usage.app_download_stats",
  downloadByVehicleModel:
    "dashboard.app_usage.download_by_vehicle_model",
  downloadByCountry: "dashboard.app_usage.download_by_country",
  appUpdateStats: "dashboard.app_usage.app_update_stats",
  appUninstallStats: "dashboard.app_usage.app_uninstall_stats",
  appOpenStats: "dashboard.app_usage.app_open_stats",
  webAppDurationStats: "dashboard.app_usage.web_app_duration_stats",
});

const metadataKinds = Object.freeze({
  languages: "language.list",
  androidVersions: "application.android_versions",
  appTypes: "application.type_list",
  appTypeDictionary: "dictionary.list",
});

const optionKinds = Object.freeze({
  app: "application.name_list",
  web: "application.web_name_list",
  plugin: "application.plugin_list",
  carModel: "application.car_name_list",
});

const expectedAdapters = Object.freeze({
  "country.list": "rows",
  "carousel.list": "data.records",
  "application.list": "data.rows",
  "webapp_config.list": "data.records",
  "application.channel_list": "rows",
});

const requiredFields = Object.freeze({
  "country.list": [
    "id",
    "internationalCode",
    "chineseName",
    "region",
    "state",
  ],
  "carousel.list": ["id", "appId", "imgUrl", "state", "sort"],
  "application.list": ["id", "appName", "state"],
  "webapp_config.list": ["id", "appId", "appName"],
  "application.channel_list": ["id", "channel", "appPkg", "state"],
});

function textSummary(payload) {
  if (payload.status === "error") {
    return JSON.stringify(payload);
  }
  const items = Array.isArray(payload.data?.items)
    ? payload.data.items.length
    : undefined;
  return JSON.stringify({
    status: payload.status,
    ...(items !== undefined ? { itemCount: items } : {}),
    endpointIds: payload.meta?.endpointIds || [],
    evidenceSha256: payload.meta?.evidenceSha256 || null,
  });
}

function toToolResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: textSummary(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

function safeHandler(handler) {
  return async (args, extra) =>
    runWithRequestContext(extra, async () => {
      const fallbackRequestId = randomUUID();
      try {
        return toToolResult(await handler(args || {}));
      } catch (error) {
        return toToolResult(publicError(error, fallbackRequestId), true);
      }
    });
}

function registerReadOnlyTool(
  server,
  name,
  title,
  description,
  inputSchema,
  handler
) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    safeHandler(handler)
  );
}

function queryFromPagination(args) {
  return { pageNum: args.pageNum, pageSize: args.pageSize };
}

async function listEndpoint(
  client,
  endpointId,
  {
    query = {},
    pathValues = {},
    filters = {},
    includeConfigJson = false,
    warnings = [],
  } = {}
) {
  const result = await client.request(endpointId, { query, pathValues });
  return collectionPayload(result, {
    query,
    filters,
    includeConfigJson,
    expectedAdapter: expectedAdapters[endpointId],
    warnings,
  });
}

async function fetchAllPages(
  client,
  endpointId,
  options = {}
) {
  const {
    baseQuery = {},
    pathValues = {},
    pageSize = 100,
    maxPages = 20,
    filters = {},
    includeConfigJson = false,
  } = options;
  const recordBudget = options._recordBudget ?? pageSize * maxPages;
  const adaptiveDepth = options._adaptiveDepth ?? 0;
  const retryWithPageSize = (nextPageSize) => {
    if (
      nextPageSize < 1 ||
      nextPageSize >= pageSize ||
      adaptiveDepth >= 8
    ) {
      return null;
    }
    return fetchAllPages(client, endpointId, {
      ...options,
      pageSize: nextPageSize,
      maxPages: Math.ceil(recordBudget / nextPageSize),
      _recordBudget: recordBudget,
      _adaptiveDepth: adaptiveDepth + 1,
    });
  };
  const payloads = [];
  const allItems = [];
  let total = null;
  let truncated = false;
  let inferredWithoutTotal = false;
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const query = { ...baseQuery, pageNum, pageSize };
    let result;
    try {
      result = await client.request(endpointId, { query, pathValues });
    } catch (error) {
      if (error?.code === "RESPONSE_TOO_LARGE" && pageSize > 1) {
        const retry = retryWithPageSize(Math.floor(pageSize / 2));
        if (retry) return retry;
      }
      throw error;
    }
    const raw = extractCollection(result.data);
    total = extractTotal(result.data, total);
    const payload = collectionPayload(result, {
      query,
      includeConfigJson,
      expectedAdapter: expectedAdapters[endpointId],
    });
    payloads.push(payload);
    allItems.push(...payload.data.items);
    if (Number.isFinite(total) && allItems.length >= total) {
      break;
    }
    if (
      Number.isFinite(total) &&
      raw.items.length > 0 &&
      raw.items.length < pageSize &&
      allItems.length < total
    ) {
      const retry = retryWithPageSize(raw.items.length);
      if (retry) return retry;
    }
    if (raw.items.length < pageSize) {
      inferredWithoutTotal = !Number.isFinite(total);
      if (Number.isFinite(total) && allItems.length < total) {
        truncated = true;
      }
      break;
    }
    if (pageNum === maxPages) truncated = true;
  }
  const filtered = filterItems(allItems, filters);
  const warnings = [];
  if (truncated) {
    warnings.push(`达到分页读取上限，结果可能未覆盖全部记录`);
  }
  if (inferredWithoutTotal) {
    warnings.push("后台未返回 total，无法严格证明分页完整性");
  }
  const payload = combinePayloads(payloads, { items: filtered }, warnings);
  payload.meta.page = {
    number: 1,
    size: pageSize,
    returned: filtered.length,
    total: total ?? filtered.length,
    complete: !truncated && !inferredWithoutTotal,
    pagesFetched: payloads.length,
  };
  return payload;
}

function mergeVerificationMeta(payload, data, status) {
  const effectiveStatus =
    payload.status === "partial" ? "partial" : status;
  return {
    status: effectiveStatus,
    data,
    meta: {
      ...payload.meta,
      validation: {
        ...payload.meta.validation,
        businessExpectation:
          status === "pass" ? "pass" : status === "fail" ? "fail" : "warning",
      },
      evidenceSha256: sha256(data),
    },
  };
}

function identityFilters(args, source = "application") {
  return {
    [source === "application" ? "catalogAppId" : "appId"]: args.appId,
    appName: args.appName,
    packageName: args.packageName,
  };
}

async function voiceOpenKeyPayload(client, args) {
  assertAtLeastOneIdentifier(args, ["appId", "appName", "packageName"]);
  // WebApp records may contain large configJson payloads. Ten records keeps
  // observed staging pages below the response cap while still allowing the
  // default 20 pages to cover the current catalog.
  const appPageSize = 20;
  const webAppPageSize = 10;
  const maxPages = args.maxPages || 20;
  const [apps, webapps] = await Promise.all([
    fetchAllPages(client, "application.list", {
      pageSize: appPageSize,
      maxPages,
      filters: identityFilters(args, "application"),
    }),
    fetchAllPages(client, "webapp_config.list", {
      pageSize: webAppPageSize,
      maxPages,
      filters: {
        appId: args.appId,
        appName: args.appName,
      },
    }),
  ]);
  const appRecords = apps.data.items;
  const webRecords = webapps.data.items;
  const merged = mergeVoiceRecords(appRecords, webRecords);
  const matches = filterItems(
    merged,
    identityFilters(args, "application")
  ).map((record) => ({
    appId: record.appId ?? record.id ?? null,
    appName: record.appName ?? null,
    packageName: record.packageName ?? null,
    appKey: record.appKey ?? "",
    normalizedVoiceKeys: voiceKeysForRecord(record),
    state: record.state ?? record.status ?? null,
    isWeb: record.isWeb ?? null,
  }));
  const payload = combinePayloads(
    [apps, webapps],
    { items: matches }
  );
  return payload;
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { startDate: dateString(start), endDate: dateString(end) };
}

function parseCalendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return dateString(parsed) === value ? timestamp : null;
}

function validateDashboardDateRange(startDate, endDate) {
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  if (start === null || end === null) {
    throw new AppMarketError(
      "INVALID_ARGUMENT",
      "统计日期必须是真实的 YYYY-MM-DD 日历日期"
    );
  }
  if (start > end) {
    throw new AppMarketError(
      "INVALID_ARGUMENT",
      "统计开始日期不能晚于结束日期"
    );
  }
  const inclusiveDays = (end - start) / (24 * 60 * 60 * 1000) + 1;
  if (inclusiveDays > 366) {
    throw new AppMarketError(
      "INVALID_ARGUMENT",
      "单次统计查询最多允许 366 天"
    );
  }
}

function selfCheckCases(scope, discoveredCarModelId) {
  const core = [
    { name: "auth", endpointId: "session.info" },
    {
      name: "countries",
      endpointId: "country.list",
      query: { pageNum: 1, pageSize: 3 },
    },
    {
      name: "car-models",
      endpointId: "car_model.list",
      query: { pageNum: 1, pageSize: 3 },
    },
    {
      name: "banners",
      endpointId: "carousel.list",
      query: { pageNum: 1, pageSize: 3 },
    },
    {
      name: "apps",
      endpointId: "application.list",
      query: { pageNum: 1, pageSize: 3 },
    },
    {
      name: "webapp-configs",
      endpointId: "webapp_config.list",
      query: { pageNum: 1, pageSize: 3 },
    },
    {
      name: "channels",
      endpointId: "application.channel_list",
      query: { pageNum: 1, pageSize: 3 },
    },
  ];
  if (scope !== "catalog") return scope === "auth" ? core.slice(0, 1) : core;

  const cases = [];
  for (const endpoint of endpointCatalogForTools()) {
    if (endpoint.id === "dictionary.by_type") {
      for (const dictType of endpoint.allowedPathValues.dictType) {
        cases.push({
          name: `${endpoint.id}:${dictType}`,
          endpointId: endpoint.id,
          pathValues: { dictType },
        });
      }
      continue;
    }
    if (endpoint.id === "dashboard.user_activity.rank_distribution") {
      for (const dimension of endpoint.allowedBodyValues.dimension) {
        cases.push({
          name: `${endpoint.id}:${dimension}`,
          endpointId: endpoint.id,
          body: { ...defaultDateRange(), dimension },
        });
      }
      continue;
    }
    if (endpoint.id.startsWith("dashboard.")) {
      cases.push({
        name: endpoint.id,
        endpointId: endpoint.id,
        body: defaultDateRange(),
      });
      continue;
    }
    if (endpoint.id === "car_model.country_map") {
      if (discoveredCarModelId) {
        cases.push({
          name: endpoint.id,
          endpointId: endpoint.id,
          query: {
            carModelId: discoveredCarModelId,
            pageNum: 1,
            pageSize: 3,
          },
        });
      } else {
        cases.push({
          name: endpoint.id,
          endpointId: endpoint.id,
          skipReason: "车型列表未提供可用 carModelId",
        });
      }
      continue;
    }
    const query = {};
    if (endpoint.allowedQueryKeys?.includes("pageNum")) query.pageNum = 1;
    if (endpoint.allowedQueryKeys?.includes("pageSize")) query.pageSize = 3;
    if (endpoint.id === "dictionary.list") query.dictType = "app_type_list";
    cases.push({ name: endpoint.id, endpointId: endpoint.id, query });
  }
  return cases;
}

async function runSelfCheckCase(client, check) {
  if (check.skipReason) {
    return {
      name: check.name,
      endpointId: check.endpointId,
      status: "skipped",
      warning: check.skipReason,
    };
  }
  try {
    const result = await client.request(check.endpointId, {
      query: check.query || {},
      body: check.body || {},
      pathValues: check.pathValues || {},
    });
    const { items, adapter } = extractCollection(result.data);
    const contract = validateRequiredFields(
      items,
      requiredFields[check.endpointId] || []
    );
    const emptyCollection =
      (ENDPOINTS[check.endpointId].allowedQueryKeys || []).includes(
        "pageSize"
      ) && items.length === 0;
    const warnings = [];
    if (!contract.pass) {
      warnings.push(`缺少字段：${contract.missing.join(", ")}`);
    }
    const expectedAdapter = expectedAdapters[check.endpointId];
    if (expectedAdapter && adapter !== expectedAdapter) {
      warnings.push(
        `响应容器为 ${adapter}，与已观察契约 ${expectedAdapter} 不一致`
      );
    }
    if (emptyCollection) warnings.push("本次查询未返回记录");
    return {
      name: check.name,
      endpointId: check.endpointId,
      status: warnings.length ? "partial" : "pass",
      adapter,
      itemCount: items.length,
      requestId: result.requestId,
      fetchedAt: result.fetchedAt,
      evidenceSha256: sha256(result.data),
      warnings,
    };
  } catch (error) {
    const safe = publicError(error);
    return {
      name: check.name,
      endpointId: check.endpointId,
      status: error.code === "FORBIDDEN" ? "partial" : "fail",
      error: safe.error,
    };
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

function matchesChannelDistribution(item, packageNames, args) {
  if (!packageNames.has(String(item?.appPkg || item?.packageName || ""))) {
    return false;
  }
  if (
    args.expectedChannel &&
    String(item?.channel) !== String(args.expectedChannel)
  ) {
    return false;
  }
  return compareExpected(item, { state: args.expectedState }).every(
    (check) => check.pass
  );
}

export function registerAppMarketTools(server, client, config) {
  registerReadOnlyTool(
    server,
    "appmarket_admin_capabilities",
    "应用市场后台 MCP 能力目录",
    "无需登录即可列出已审查的只读后台数据集、精确接口白名单与目录摘要；不会暴露认证信息。",
    {},
    async () => {
      const endpoints = endpointCatalogForTools().map((endpoint) => ({
        id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        group: endpoint.group,
        source: endpoint.source,
        description: endpoint.description,
        allowedQueryKeys: endpoint.allowedQueryKeys || [],
        allowedBodyKeys: endpoint.allowedBodyKeys || [],
        allowedPathValues: endpoint.allowedPathValues || {},
        readOnlyPost: Boolean(endpoint.readOnlyPost),
      }));
      const data = {
        service: "appmarket-admin-readonly",
        version: "1.0.0",
        environment: config.environment,
        transport: "stdio",
        authConfigured: client.credentialMode() !== "not-configured",
        credentialMode: client.credentialMode(),
        tools: TOOL_NAMES,
        endpointCount: endpoints.length,
        endpoints,
        safety: {
          arbitraryHttp: false,
          writeEndpoints: false,
          credentialsAsToolArguments: false,
          exactOriginAllowlist: true,
        },
      };
      return {
        status: "ok",
        data,
        meta: {
          environment: config.environment,
          source: "local-endpoint-catalog",
          endpointIds: [],
          requestIds: [],
          fetchedAt: new Date().toISOString(),
          validation: { schema: "pass", warnings: [] },
          evidenceSha256: sha256(endpoints),
        },
      };
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_auth_check",
    "应用市场后台认证检查",
    "验证 MCP 是否能登录测试环境；仅返回认证和权限摘要，不返回账号、Cookie 或 Token。",
    {},
    async () => {
      const result = await client.request("session.info");
      const roles = result.data?.roles || result.data?.user?.roles || [];
      const permissions =
        result.data?.permissions || result.data?.user?.permissions || [];
      return objectPayload(result, {
        authenticated: true,
        credentialMode: client.credentialMode(),
        roleCount: Array.isArray(roles) ? roles.length : null,
        permissionCount: Array.isArray(permissions)
          ? permissions.length
          : null,
      });
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_routes",
    "应用市场后台菜单路由",
    "读取当前只读账号可访问的后台菜单路由，用于解释权限缺口；不会执行页面操作。",
    {},
    async () => listEndpoint(client, "session.routers")
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_metadata",
    "应用市场后台元数据",
    "读取语言、Android 版本、应用类型或受审查字典值。",
    {
      kind: z.enum([
        "dictionary",
        "languages",
        "androidVersions",
        "appTypes",
        "appTypeDictionary",
      ]),
      dictionaryType: z
        .enum([
          "app_tag",
          "app_type",
          "audit_state",
          "enabled_switch",
          "region_type",
          "vector_type",
        ])
        .optional(),
      enabled: z.union([z.string(), z.number()]).optional(),
      ...paginationInput,
    },
    async (args) => {
      if (args.kind === "dictionary") {
        if (!args.dictionaryType) {
          throw new AppMarketError(
            "INVALID_ARGUMENT",
            "kind=dictionary 时必须提供 dictionaryType"
          );
        }
        return listEndpoint(client, "dictionary.by_type", {
          pathValues: { dictType: args.dictionaryType },
        });
      }
      const endpointId = metadataKinds[args.kind];
      const query = {};
      if (ENDPOINTS[endpointId].allowedQueryKeys.includes("pageNum")) {
        Object.assign(query, queryFromPagination(args));
      }
      if (endpointId === "dictionary.list") {
        query.dictType = "app_type_list";
      }
      if (
        args.enabled !== undefined &&
        ENDPOINTS[endpointId].allowedQueryKeys.includes("enabled")
      ) {
        query.enabled = args.enabled;
      }
      return listEndpoint(client, endpointId, { query });
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_countries",
    "应用市场国家码列表",
    "查询系统国家码或应用信息页国家码，支持本地按代码、区域、名称或状态过滤。",
    {
      source: z.enum(["system", "appinfo"]).optional().default("system"),
      state: z.union([z.string(), z.number()]).optional(),
      country: z.string().trim().min(1).max(128).optional(),
      ...paginationInput,
    },
    async (args) => {
      const endpointId =
        args.source === "appinfo" ? "application.country_list" : "country.list";
      const query = queryFromPagination(args);
      if (args.state !== undefined && endpointId === "country.list") {
        query.state = args.state;
      }
      return listEndpoint(client, endpointId, {
        query,
        filters: { country: args.country, state: args.state },
      });
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_car_models",
    "应用市场车型列表",
    "查询后台车型目录，并按车型标识、名称或部门做本地筛选。",
    {
      carModelId: z.string().trim().min(1).max(128).optional(),
      keyword: z.string().trim().min(1).max(256).optional(),
      deptId: z.string().trim().min(1).max(128).optional(),
      ...paginationInput,
    },
    async (args) =>
      listEndpoint(client, "car_model.list", {
        query: queryFromPagination(args),
        filters: {
          catalogCarModelId: args.carModelId,
          keyword: args.keyword,
          deptId: args.deptId,
        },
      })
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_get_car_model_country_map",
    "车型国家码映射",
    "按必填 carModelId 查询车型与国家/区域映射。",
    {
      carModelId: z.string().trim().min(1).max(128),
      country: z.string().trim().min(1).max(128).optional(),
      ...paginationInput,
    },
    async (args) =>
      listEndpoint(client, "car_model.country_map", {
        query: {
          carModelId: args.carModelId,
          ...queryFromPagination(args),
        },
        filters: { country: args.country },
      })
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_departments",
    "应用市场部门列表",
    "读取应用或车型配置页面使用的部门列表。",
    {
      source: z.enum(["application", "carModel"]).optional().default("application"),
      keyword: z.string().trim().min(1).max(256).optional(),
    },
    async (args) =>
      listEndpoint(
        client,
        args.source === "carModel"
          ? "car_model.departments"
          : "application.departments",
        { filters: { keyword: args.keyword } }
      )
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_apps",
    "应用市场应用记录",
    "查询完整或精简应用记录，返回 appName、appKey、包名、状态及车型/国家/部门分发字段。",
    {
      source: z.enum(["full", "simple"]).optional().default("full"),
      ...identityInput,
      appKey: z.string().trim().min(1).max(256).optional(),
      deptId: z.string().trim().min(1).max(128).optional(),
      carModelId: z.string().trim().min(1).max(128).optional(),
      country: z.string().trim().min(1).max(128).optional(),
      state: z.union([z.string(), z.number()]).optional(),
      ...paginationInput,
    },
    async (args) =>
      listEndpoint(
        client,
        args.source === "simple"
          ? "application.list_simple"
          : "application.list",
        {
          query: queryFromPagination(args),
          filters: {
            ...identityFilters(args, "application"),
            appKey: args.appKey,
            deptId: args.deptId,
            carModelId: args.carModelId,
            country: args.country,
            state: args.state,
          },
        }
      )
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_app_options",
    "应用市场配置候选项",
    "读取应用、WebApp、插件或车型名称候选列表。",
    {
      kind: z.enum(["app", "web", "plugin", "carModel"]),
      keyword: z.string().trim().min(1).max(256).optional(),
    },
    async (args) =>
      listEndpoint(client, optionKinds[args.kind], {
        filters: { keyword: args.keyword },
      })
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_banners",
    "应用市场 Banner 列表",
    "查询 Banner/轮播配置，包含图片、应用、状态、排序以及部门/车型/国家分发。",
    {
      appId: z.string().trim().min(1).max(128).optional(),
      appName: z.string().trim().min(1).max(256).optional(),
      deptId: z.string().trim().min(1).max(128).optional(),
      carModelId: z.string().trim().min(1).max(128).optional(),
      country: z.string().trim().min(1).max(128).optional(),
      state: z.union([z.string(), z.number()]).optional(),
      ...paginationInput,
    },
    async (args) => {
      const query = queryFromPagination(args);
      if (args.appName) query.appName = args.appName;
      return listEndpoint(client, "carousel.list", {
        query,
        filters: {
          appId: args.appId,
          appName: args.appName,
          deptId: args.deptId,
          carModelId: args.carModelId,
          country: args.country,
          state: args.state,
        },
      });
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_webapp_configs",
    "应用市场 WebApp 配置",
    "查询 WebApp 运行配置；configJson 默认不返回，显式请求时会解析、脱敏和限长。",
    {
      appId: z.string().trim().min(1).max(128).optional(),
      appName: z.string().trim().min(1).max(256).optional(),
      deptId: z.string().trim().min(1).max(128).optional(),
      carModelId: z.string().trim().min(1).max(128).optional(),
      state: z.union([z.string(), z.number()]).optional(),
      includeConfigJson: z.boolean().optional().default(false),
      ...paginationInput,
    },
    async (args) =>
      listEndpoint(client, "webapp_config.list", {
        query: queryFromPagination(args),
        filters: {
          appId: args.appId,
          appName: args.appName,
          deptId: args.deptId,
          carModelId: args.carModelId,
          state: args.state,
        },
        includeConfigJson: args.includeConfigJson,
      })
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_list_channels",
    "应用市场渠道分发",
    "查询应用包名与渠道分发状态。",
    {
      channel: z.string().trim().min(1).max(128).optional(),
      packageName: z.string().trim().min(1).max(256).optional(),
      state: z.union([z.string(), z.number()]).optional(),
      ...paginationInput,
    },
    async (args) =>
      listEndpoint(client, "application.channel_list", {
        query: queryFromPagination(args),
        filters: {
          channel: args.channel,
          packageName: args.packageName,
          state: args.state,
        },
      })
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_query_dashboard",
    "应用市场只读统计查询",
    "按日期查询已观察到的用户活跃或应用使用统计 POST 接口；这些 POST 仅执行查询。",
    {
      metric: z.enum(Object.keys(dashboardEndpointIds)),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dimension: z
        .enum(["vehicle_model", "country", "version"])
        .optional(),
    },
    async (args) => {
      validateDashboardDateRange(args.startDate, args.endDate);
      const endpointId = dashboardEndpointIds[args.metric];
      const body = {
        startDate: args.startDate,
        endDate: args.endDate,
      };
      if (endpointId === "dashboard.user_activity.rank_distribution") {
        if (!args.dimension) {
          throw new AppMarketError(
            "INVALID_ARGUMENT",
            "排名分布查询必须提供 dimension"
          );
        }
        body.dimension = args.dimension;
      } else if (args.dimension) {
        throw new AppMarketError(
          "INVALID_ARGUMENT",
          "仅排名分布查询允许 dimension"
        );
      }
      const result = await client.request(endpointId, { body });
      return objectPayload(result);
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_get_voice_open_keys",
    "应用语音打开 Key",
    "联查应用目录与 WebApp 配置，按客户端规则拆分并归一化逗号分隔 appKey；至少提供一个应用标识。",
    {
      ...identityInput,
      maxPages: z.number().int().min(1).max(50).optional().default(20),
    },
    async (args) => voiceOpenKeyPayload(client, args)
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_verify_banner",
    "验证应用市场 Banner",
    "定位 Banner 后，将后台实际状态、图片、排序及分发字段与期望值逐项比较。",
    {
      appId: z.string().trim().min(1).max(128).optional(),
      appName: z.string().trim().min(1).max(256).optional(),
      expectedState: z.union([z.string(), z.number()]).optional(),
      expectedSort: z.union([z.string(), z.number()]).optional(),
      expectedImgUrl: z.string().url().optional(),
      expectedDeptId: z.string().trim().min(1).max(128).optional(),
      expectedCarModelId: z.string().trim().min(1).max(128).optional(),
      expectedCountry: z.string().trim().min(1).max(128).optional(),
      maxPages: z.number().int().min(1).max(50).optional().default(20),
    },
    async (args) => {
      assertAtLeastOneIdentifier(args, ["appId", "appName"]);
      const payload = await fetchAllPages(client, "carousel.list", {
        baseQuery: args.appName ? { appName: args.appName } : {},
        maxPages: args.maxPages,
        filters: { appId: args.appId, appName: args.appName },
      });
      const expected = {
        state: args.expectedState,
        sort: args.expectedSort,
        imgUrl: args.expectedImgUrl,
        deptId: args.expectedDeptId,
        carModelIds: args.expectedCarModelId,
        countryList: args.expectedCountry,
      };
      const matches = payload.data.items.map((record) => {
        const checks = compareExpected(record, expected);
        return {
          record,
          checks,
          pass: checks.every((check) => check.pass),
        };
      });
      const pass =
        matches.length > 0 &&
        (matches.some((item) => item.pass) ||
          Object.values(expected).every((value) => value === undefined));
      return mergeVerificationMeta(
        payload,
        { matches, pass },
        pass ? "pass" : "fail"
      );
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_verify_voice_key",
    "验证应用语音打开 Key",
    "按客户端 VoiceAppConfigIndex 的规则验证期望语音 key 是否命中后台应用配置。",
    {
      ...identityInput,
      expectedKey: z.string().trim().min(1).max(256),
      maxPages: z.number().int().min(1).max(50).optional().default(20),
    },
    async (args) => {
      const payload = await voiceOpenKeyPayload(client, args);
      const normalizedExpected = normalizeVoiceKey(args.expectedKey);
      const matches = payload.data.items.map((record) => ({
        ...record,
        expectedKey: args.expectedKey,
        normalizedExpected,
        pass: record.normalizedVoiceKeys.includes(normalizedExpected),
      }));
      const pass = matches.some((item) => item.pass);
      return mergeVerificationMeta(
        payload,
        { matches, pass },
        pass ? "pass" : "fail"
      );
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_verify_distribution",
    "验证应用分发配置",
    "联查应用记录和渠道记录，核对部门、车型、国家、渠道与状态。",
    {
      ...identityInput,
      expectedDeptId: z.string().trim().min(1).max(128).optional(),
      expectedCarModelId: z.string().trim().min(1).max(128).optional(),
      expectedCountry: z.string().trim().min(1).max(128).optional(),
      expectedChannel: z.string().trim().min(1).max(128).optional(),
      expectedState: z.union([z.string(), z.number()]).optional(),
      maxPages: z.number().int().min(1).max(50).optional().default(20),
    },
    async (args) => {
      assertAtLeastOneIdentifier(args, ["appId", "appName", "packageName"]);
      const apps = await fetchAllPages(client, "application.list", {
        maxPages: args.maxPages,
        filters: identityFilters(args, "application"),
      });
      const packageNames = new Set(
        apps.data.items
          .map((item) => item.packageName)
          .filter(Boolean)
          .map(String)
      );
      if (args.packageName) packageNames.add(args.packageName);
      const channels = await fetchAllPages(client, "application.channel_list", {
        maxPages: args.maxPages,
      });
      const channelMatches = channels.data.items.filter(
        (item) => matchesChannelDistribution(item, packageNames, args)
      );
      const appExpected = {
        deptId: args.expectedDeptId,
        carModelIds: args.expectedCarModelId,
        countryList: args.expectedCountry,
        state: args.expectedState,
      };
      const appChecks = apps.data.items.map((record) => {
        const checks = compareExpected(record, appExpected);
        return { record, checks, pass: checks.every((item) => item.pass) };
      });
      const appPass =
        appChecks.length > 0 && appChecks.some((item) => item.pass);
      const channelPass =
        !args.expectedChannel || channelMatches.length > 0;
      const pass = appPass && channelPass;
      const payload = combinePayloads([apps, channels], {
        appChecks,
        channelMatches,
        pass,
      });
      return mergeVerificationMeta(
        payload,
        payload.data,
        pass ? "pass" : "fail"
      );
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_verify_model_region",
    "验证车型区域映射",
    "查询车型国家映射，并将原始区域/国家标识与期望国家值比较。",
    {
      carModelId: z.string().trim().min(1).max(128),
      rawRegion: z.string().trim().min(1).max(128).optional(),
      expectedCountry: z.string().trim().min(1).max(128).optional(),
      maxPages: z.number().int().min(1).max(50).optional().default(20),
    },
    async (args) => {
      const payload = await fetchAllPages(client, "car_model.country_map", {
        baseQuery: { carModelId: args.carModelId },
        maxPages: args.maxPages,
        filters: { country: args.rawRegion },
      });
      const matches = payload.data.items.map((record) => {
        const checks = compareExpected(record, {
          region: args.rawRegion,
          internationalCode: args.expectedCountry,
        });
        return { record, checks, pass: checks.every((item) => item.pass) };
      });
      const pass =
        matches.length > 0 &&
        matches.some((item) => item.pass) &&
        Boolean(args.rawRegion || args.expectedCountry);
      return mergeVerificationMeta(
        payload,
        { matches, pass },
        pass ? "pass" : matches.length ? "partial" : "fail"
      );
    }
  );

  registerReadOnlyTool(
    server,
    "appmarket_admin_self_check",
    "应用市场后台 MCP 自检",
    "验证认证、主数据响应契约，或对全部已审查接口做最小只读查询；不保存响应正文。",
    {
      scope: z.enum(["auth", "core", "catalog"]).optional().default("core"),
      concurrency: z.number().int().min(1).max(6).optional().default(3),
    },
    async (args) => {
      let discoveredCarModelId = "";
      if (args.scope === "catalog") {
        try {
          const preliminary = await client.request("car_model.list", {
            query: { pageNum: 1, pageSize: 1 },
          });
          const first = extractCollection(preliminary.data).items[0];
          discoveredCarModelId = String(
            first?.carModelId ?? first?.id ?? ""
          );
        } catch {
          // The dependent mapping check will be marked skipped or fail later.
        }
      }
      const checks = selfCheckCases(args.scope, discoveredCarModelId);
      const results = await mapLimit(
        checks,
        args.concurrency,
        (check) => runSelfCheckCase(client, check)
      );
      const failures = results.filter((item) => item.status === "fail");
      const partials = results.filter((item) =>
        ["partial", "skipped"].includes(item.status)
      );
      const status = failures.length
        ? "fail"
        : partials.length
          ? "partial"
          : "pass";
      const data = {
        scope: args.scope,
        status,
        passed: results.filter((item) => item.status === "pass").length,
        partial: partials.length,
        failed: failures.length,
        total: results.length,
        results,
      };
      return {
        status,
        data,
        meta: {
          environment: config.environment,
          source: "appmarket-admin-api",
          endpointIds: [...new Set(results.map((item) => item.endpointId))],
          requestIds: results.map((item) => item.requestId).filter(Boolean),
          fetchedAt: new Date().toISOString(),
          validation: {
            schema:
              status === "pass"
                ? "pass"
                : status === "partial"
                  ? "warning"
                  : "fail",
            warnings: partials.map((item) => item.name),
          },
          evidenceSha256: sha256(data),
        },
      };
    }
  );
}

export const __test = {
  dashboardEndpointIds,
  defaultDateRange,
  fetchAllPages,
  mapLimit,
  matchesChannelDistribution,
  mergeVerificationMeta,
  runSelfCheckCase,
  selfCheckCases,
  validateDashboardDateRange,
  voiceOpenKeyPayload,
};
