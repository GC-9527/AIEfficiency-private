const DICT_TYPES = Object.freeze([
  "app_tag",
  "app_type",
  "audit_state",
  "enabled_switch",
  "region_type",
  "vector_type",
]);

function freezeValueMap(valueMap) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(valueMap).map(([key, values]) => [
        key,
        Object.freeze([...values]),
      ])
    )
  );
}

function freezeEndpoint(definition) {
  const endpoint = { ...definition };

  if (endpoint.allowedQueryKeys) {
    endpoint.allowedQueryKeys = Object.freeze([...endpoint.allowedQueryKeys]);
  }
  if (endpoint.allowedBodyKeys) {
    endpoint.allowedBodyKeys = Object.freeze([...endpoint.allowedBodyKeys]);
  }
  if (endpoint.allowedPathValues) {
    endpoint.allowedPathValues = freezeValueMap(endpoint.allowedPathValues);
  }
  if (endpoint.allowedBodyValues) {
    endpoint.allowedBodyValues = freezeValueMap(endpoint.allowedBodyValues);
  }

  return Object.freeze(endpoint);
}

const definitions = {
  "auth.login": {
    id: "auth.login",
    method: "POST",
    path: "/login",
    group: "auth",
    source: "observed-other",
    internalAuth: true,
    allowedBodyKeys: ["username", "password"],
    description: "创建管理后台认证会话；仅供服务内部认证，不暴露为 MCP 工具。",
  },
  "session.info": {
    id: "session.info",
    method: "GET",
    path: "/getInfo",
    group: "session",
    source: "observed-other",
    allowedQueryKeys: [],
    description: "读取当前管理后台会话对应的用户与权限摘要。",
  },
  "session.routers": {
    id: "session.routers",
    method: "GET",
    path: "/getRouters",
    group: "session",
    source: "observed-other",
    allowedQueryKeys: [],
    description: "读取当前管理后台会话可访问的菜单路由。",
  },
  "dashboard.user_activity.summary": {
    id: "dashboard.user_activity.summary",
    method: "POST",
    path: "/api/dashboard/user-activity/summary",
    group: "dashboard-user-activity",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取用户活跃汇总。",
  },
  "dashboard.user_activity.daily_trend": {
    id: "dashboard.user_activity.daily_trend",
    method: "POST",
    path: "/api/dashboard/user-activity/daily-trend",
    group: "dashboard-user-activity",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取用户活跃日趋势。",
  },
  "dashboard.user_activity.monthly_trend": {
    id: "dashboard.user_activity.monthly_trend",
    method: "POST",
    path: "/api/dashboard/user-activity/monthly-trend",
    group: "dashboard-user-activity",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取用户活跃月趋势。",
  },
  "dashboard.user_activity.rank_distribution": {
    id: "dashboard.user_activity.rank_distribution",
    method: "POST",
    path: "/api/dashboard/user-activity/rank-distribution",
    group: "dashboard-user-activity",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate", "dimension"],
    allowedBodyValues: {
      dimension: ["vehicle_model", "country", "version"],
    },
    description: "按车型、国家或版本维度读取用户活跃排名分布。",
  },
  "dashboard.app_usage.daily_download_trend": {
    id: "dashboard.app_usage.daily_download_trend",
    method: "POST",
    path: "/api/dashboard/app-usage/daily-download-trend",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取应用下载日趋势。",
  },
  "dashboard.app_usage.download_source_distribution": {
    id: "dashboard.app_usage.download_source_distribution",
    method: "POST",
    path: "/api/dashboard/app-usage/download-source-distribution",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取应用下载来源分布。",
  },
  "dashboard.app_usage.app_download_stats": {
    id: "dashboard.app_usage.app_download_stats",
    method: "POST",
    path: "/api/dashboard/app-usage/app-download-stats",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取各应用下载统计。",
  },
  "dashboard.app_usage.download_by_vehicle_model": {
    id: "dashboard.app_usage.download_by_vehicle_model",
    method: "POST",
    path: "/api/dashboard/app-usage/download-by-vehicle-model",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取车型维度的应用下载统计。",
  },
  "dashboard.app_usage.download_by_country": {
    id: "dashboard.app_usage.download_by_country",
    method: "POST",
    path: "/api/dashboard/app-usage/download-by-country",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取国家维度的应用下载统计。",
  },
  "dashboard.app_usage.app_open_stats": {
    id: "dashboard.app_usage.app_open_stats",
    method: "POST",
    path: "/api/dashboard/app-usage/app-open-stats",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取各应用打开统计。",
  },
  "dashboard.app_usage.app_uninstall_stats": {
    id: "dashboard.app_usage.app_uninstall_stats",
    method: "POST",
    path: "/api/dashboard/app-usage/app-uninstall-stats",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取各应用卸载统计。",
  },
  "dashboard.app_usage.app_update_stats": {
    id: "dashboard.app_usage.app_update_stats",
    method: "POST",
    path: "/api/dashboard/app-usage/app-update-stats",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取各应用更新统计。",
  },
  "dashboard.app_usage.web_app_duration_stats": {
    id: "dashboard.app_usage.web_app_duration_stats",
    method: "POST",
    path: "/api/dashboard/app-usage/web-app-duration-stats",
    group: "dashboard-app-usage",
    source: "observed-other",
    readOnlyPost: true,
    allowedBodyKeys: ["startDate", "endDate"],
    description: "按日期范围读取 WebApp 使用时长统计。",
  },
  "dictionary.by_type": {
    id: "dictionary.by_type",
    method: "GET",
    path: "/system/dict/data/type/{dictType}",
    group: "dictionary",
    source: "observed-other",
    allowedQueryKeys: [],
    allowedPathValues: {
      dictType: DICT_TYPES,
    },
    description: "读取已观察到的应用标签、应用类型、审核状态、开关、区域或向量类型字典。",
  },
  "dictionary.list": {
    id: "dictionary.list",
    method: "GET",
    path: "/system/dict/data/list",
    group: "dictionary",
    source: "observed-other",
    allowedQueryKeys: ["pageNum", "pageSize", "dictType"],
    description: "分页读取指定字典类型的数据项。",
  },
  "application.type_list": {
    id: "application.type_list",
    method: "GET",
    path: "/system/app_type/data/list",
    group: "application",
    source: "observed-other",
    allowedQueryKeys: ["pageNum", "pageSize"],
    description: "分页读取后台维护的应用类型列表。",
  },
  "application.departments": {
    id: "application.departments",
    method: "GET",
    path: "/system/appinfo/getDept",
    group: "application",
    source: "observed-other",
    allowedQueryKeys: [],
    description: "读取应用可用的部门列表。",
  },
  "application.plugin_list": {
    id: "application.plugin_list",
    method: "GET",
    path: "/system/appinfo/getPluginList",
    group: "application",
    source: "observed-other",
    allowedQueryKeys: [],
    description: "读取应用后台可选择的插件列表。",
  },
  "application.web_name_list": {
    id: "application.web_name_list",
    method: "GET",
    path: "/system/appinfo/getWebNameList",
    group: "application",
    source: "observed-config",
    allowedQueryKeys: [],
    description: "读取 WebApp 名称候选列表。",
  },
  "application.list": {
    id: "application.list",
    method: "GET",
    path: "/system/appinfo/list",
    group: "application",
    source: "observed-other",
    allowedQueryKeys: ["pageNum", "pageSize"],
    description: "分页读取完整应用记录。",
  },
  "application.android_versions": {
    id: "application.android_versions",
    method: "GET",
    path: "/system/appinfo/listAndroidVersion",
    group: "application",
    source: "observed-other",
    allowedQueryKeys: [],
    description: "读取 Android 版本候选列表。",
  },
  "car_model.list": {
    id: "car_model.list",
    method: "GET",
    path: "/system/carmodel/list",
    group: "car-model",
    source: "observed-config",
    allowedQueryKeys: ["pageNum", "pageSize"],
    description: "分页读取车型列表。",
  },
  "car_model.departments": {
    id: "car_model.departments",
    method: "GET",
    path: "/system/carmodel/listDept",
    group: "car-model",
    source: "observed-config",
    allowedQueryKeys: [],
    description: "读取车型关联的部门列表。",
  },
  "country.list": {
    id: "country.list",
    method: "GET",
    path: "/system/country/list",
    group: "country",
    source: "observed-other",
    allowedQueryKeys: ["pageNum", "pageSize", "state"],
    description: "分页读取国家代码表，可按状态筛选。",
  },
  "language.list": {
    id: "language.list",
    method: "GET",
    path: "/system/language/list",
    group: "language",
    source: "observed-other",
    allowedQueryKeys: ["pageNum", "pageSize", "enabled"],
    description: "分页读取后台语言配置，可按启用状态筛选。",
  },
  "webapp_config.list": {
    id: "webapp_config.list",
    method: "GET",
    path: "/api/webappconfig/getList",
    group: "webapp-config",
    source: "observed-config",
    allowedQueryKeys: ["pageNum", "pageSize"],
    description: "分页读取 WebApp 运行配置。",
  },
  "application.country_list": {
    id: "application.country_list",
    method: "GET",
    path: "/system/appinfo/appInfoCountryList",
    group: "country",
    source: "skill-reference",
    allowedQueryKeys: ["pageNum", "pageSize"],
    description: "分页读取应用信息页面使用的国家列表。",
  },
  "car_model.country_map": {
    id: "car_model.country_map",
    method: "GET",
    path: "/system/carmodel/list/country/car-model",
    group: "car-model",
    source: "skill-reference",
    allowedQueryKeys: ["carModelId", "pageNum", "pageSize"],
    description: "按车型标识分页读取车型与国家的映射。",
  },
  "carousel.list": {
    id: "carousel.list",
    method: "GET",
    path: "/system/carouselmap/list",
    group: "carousel",
    source: "skill-reference",
    allowedQueryKeys: ["pageNum", "pageSize", "appName"],
    description: "分页读取 Banner 与轮播配置，可按应用名称筛选。",
  },
  "application.list_simple": {
    id: "application.list_simple",
    method: "GET",
    path: "/system/appinfo/listAppInfo",
    group: "application",
    source: "skill-reference",
    allowedQueryKeys: ["pageNum", "pageSize"],
    description: "分页读取精简应用信息列表。",
  },
  "application.channel_list": {
    id: "application.channel_list",
    method: "GET",
    path: "/system/appInfoChannel/list",
    group: "channel",
    source: "skill-reference",
    allowedQueryKeys: ["pageNum", "pageSize"],
    description: "分页读取应用包与渠道分发状态。",
  },
  "application.name_list": {
    id: "application.name_list",
    method: "GET",
    path: "/system/appinfo/getNameList",
    group: "application",
    source: "skill-reference",
    allowedQueryKeys: [],
    description: "读取应用名称候选列表。",
  },
  "application.car_name_list": {
    id: "application.car_name_list",
    method: "GET",
    path: "/system/appinfo/getCarNameList",
    group: "application",
    source: "skill-reference",
    allowedQueryKeys: [],
    description: "读取车型名称候选列表。",
  },
};

export const ENDPOINTS = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => {
      if (definition.id !== id) {
        throw new Error(`Endpoint id mismatch: ${id}`);
      }
      return [id, freezeEndpoint(definition)];
    })
  )
);

const TOOL_ENDPOINTS = Object.freeze(
  Object.values(ENDPOINTS).filter((endpoint) => !endpoint.internalAuth)
);

export function endpointCatalogForTools() {
  return TOOL_ENDPOINTS;
}
