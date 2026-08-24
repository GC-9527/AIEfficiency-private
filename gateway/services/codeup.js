const DEFAULT_API_BASE_URL = "https://openapi-rdc.aliyuncs.com";

function text(value) {
  return String(value == null ? "" : value).trim();
}

function stringList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  return text(value).split(/[,;\s]+/).map((item) => item.trim()).filter(Boolean);
}

function trimBaseUrl(value) {
  return (text(value) || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

function normalizeEdition(value) {
  return text(value).toLowerCase() === "region" ? "region" : "central";
}

export function missingCodeupPrConfig(config = {}) {
  const missing = [];
  if (!text(config.accessToken)) missing.push("accessToken");
  const edition = normalizeEdition(config.edition);
  if (edition === "central" && !text(config.organizationId)) {
    missing.push("organizationId");
  }
  if (edition === "region" && !text(config.apiBaseUrl)) missing.push("apiBaseUrl");
  return missing;
}

export function codeupApiBaseError(config = {}) {
  if (normalizeEdition(config.edition) === "central") return "";
  const value = text(config.apiBaseUrl);
  if (!value) return "Region 版缺少 API 接入点";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "Region API 接入点必须使用 HTTPS";
    if (url.username || url.password) return "Region API 接入点不能包含用户名或密码";
    if (url.search || url.hash) return "Region API 接入点不能包含查询参数或片段";
    return "";
  } catch {
    return "Region API 接入点不是有效 URL";
  }
}

function decodePath(value) {
  return text(value)
    .split("/")
    .map((part) => {
      try { return decodeURIComponent(part); } catch { return part; }
    })
    .filter(Boolean)
    .join("/");
}

function cleanRepositoryPath(value) {
  let repositoryPath = decodePath(text(value).replace(/^\/+|\/+$/g, ""));
  repositoryPath = repositoryPath.replace(/\.git$/i, "");
  repositoryPath = repositoryPath.replace(/\/(?:changes|merge_requests|branches|commits|files)$/i, "");
  return repositoryPath;
}

export function codeupRepositoryPathFromRemote(remoteUrl, options = {}) {
  const raw = text(remoteUrl);
  if (!raw) return "";
  const allowAnyHost = options.allowAnyHost === true;
  const acceptsHost = (host) => allowAnyHost || /(?:^|\.)codeup\.aliyun\.com$/i.test(host);

  const scp = raw.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) {
    if (!acceptsHost(scp[1])) return "";
    return cleanRepositoryPath(scp[2]);
  }

  try {
    const parsed = new URL(raw);
    if (!acceptsHost(parsed.hostname)) return "";
    return cleanRepositoryPath(parsed.pathname);
  } catch {
    return "";
  }
}

function apiPrefix(config) {
  const base = trimBaseUrl(config.apiBaseUrl);
  if (normalizeEdition(config.edition) === "region") return `${base}/oapi/v1/codeup`;
  return `${base}/oapi/v1/codeup/organizations/${encodeURIComponent(text(config.organizationId))}`;
}

function responseList(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data?.result?.[key])) return data.result[key];
    if (Array.isArray(data?.data?.[key])) return data.data[key];
  }
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function errorMessage(data, fallback) {
  return text(data?.message || data?.errorMessage || data?.error || data?.errorCode || fallback);
}

function changeRequestObjects(data) {
  const queue = [data];
  const seen = new Set();
  const objects = [];
  while (queue.length && objects.length < 12) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    objects.push(value);
    for (const nested of [value.result, value.data]) {
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return objects;
}

function safeHttpUrl(value) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function changeRequestLocalId(data) {
  for (const value of changeRequestObjects(data)) {
    const localId = text(value.localId);
    if (/^\d+$/.test(localId) && Number(localId) > 0) return Number(localId);
  }
  return null;
}

function changeRequestDetailUrl(baseUrl, localId = null) {
  const base = safeHttpUrl(baseUrl);
  if (!base) return "";
  const parsed = new URL(base);
  const detailMatch = parsed.pathname.match(/\/change\/(\d+)\/?$/i);
  if (!localId) return detailMatch ? parsed.toString() : "";
  if (detailMatch && Number(detailMatch[1]) === Number(localId)) return parsed.toString();

  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname
    .replace(/\/(?:changes?|merge_requests?)(?:\/\d+)?\/?$/i, "")
    .replace(/\/+$/, "");
  parsed.pathname = `${parsed.pathname}/change/${localId}`;
  return parsed.toString();
}

/**
 * Codeup 审核详情页统一使用 /change/{localId}。响应里的 webUrl 有时只是仓库页或
 * 旧式 merge_request 地址，因此只在它本身已是详情页时直接采用；有 localId 时
 * 始终结合仓库地址补出标准详情页。
 */
export function codeupChangeRequestWebUrl(data, { repository = {}, changesUrl = "" } = {}) {
  const directUrls = [];
  for (const value of changeRequestObjects(data)) {
    for (const candidate of [value.webUrl, value.detailUrl, value.url]) {
      const direct = safeHttpUrl(candidate);
      if (direct) directUrls.push(direct);
    }
  }

  const localId = changeRequestLocalId(data);
  for (const direct of directUrls) {
    const detail = changeRequestDetailUrl(direct);
    if (detail && (!localId || new URL(detail).pathname.endsWith(`/change/${localId}`))) return detail;
  }
  if (!localId) return "";

  for (const candidate of [repository?.webUrl, ...directUrls, changesUrl]) {
    const detail = changeRequestDetailUrl(candidate, localId);
    if (detail) return detail;
  }
  return "";
}

async function requestJson(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    return { ok: false, status: 0, error: text(error?.message || error) || "Codeup request failed" };
  }

  let responseText = "";
  try {
    responseText = await response.text();
  } catch (error) {
    return { ok: false, status: response.status || 0, error: `读取 Codeup 响应失败：${text(error?.message || error)}` };
  }

  let data = null;
  try { data = responseText ? JSON.parse(responseText) : null; } catch { data = { raw: responseText }; }
  if (!response.ok || data?.success === false || data?.Success === false) {
    return {
      ok: false,
      status: response.status || 0,
      error: errorMessage(data, responseText || `HTTP ${response.status}`),
      data,
    };
  }
  return { ok: true, status: response.status || 200, data };
}

function requestOptions(config, method = "GET", body) {
  const options = {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-yunxiao-token": text(config.accessToken),
    },
    signal: AbortSignal.timeout(30000),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  return options;
}

function normalizeRequestConfig(config = {}) {
  const edition = normalizeEdition(config.edition);
  return {
    ...config,
    apiBaseUrl: edition === "central"
      ? DEFAULT_API_BASE_URL
      : text(config.apiBaseUrl).replace(/\/+$/, ""),
    edition,
    organizationId: text(config.organizationId),
    accessToken: text(config.accessToken),
  };
}

export async function listCodeupOrganizations(config, fetchImpl = fetch) {
  const normalizedConfig = normalizeRequestConfig(config);
  if (!normalizedConfig.accessToken) {
    return { ok: false, reason: "missing_token", error: "请先填写 Codeup 个人访问令牌" };
  }
  if (normalizedConfig.edition === "region") {
    return { ok: false, reason: "region_no_organization", error: "Region 版不需要 organizationId，请直接检测连接" };
  }

  const url = new URL(`${normalizedConfig.apiBaseUrl}/oapi/v1/platform/organizations`);
  url.searchParams.set("page", "1");
  url.searchParams.set("perPage", "100");
  const result = await requestJson(fetchImpl, url, requestOptions(normalizedConfig));
  if (!result.ok) return { ...result, error: `读取 Codeup 组织失败：${result.error}` };

  const organizations = responseList(result.data, ["organizations", "items", "list"])
    .map((organization) => ({
      id: text(organization?.id || organization?._id),
      name: text(organization?.name),
      description: text(organization?.description),
    }))
    .filter((organization) => organization.id);
  return { ok: true, organizations };
}

export async function probeCodeupConnection(config, fetchImpl = fetch) {
  const normalizedConfig = normalizeRequestConfig(config);
  const missing = missingCodeupPrConfig(normalizedConfig);
  if (missing.length) {
    return {
      ok: false,
      reason: "missing_config",
      missing,
      error: `缺少 Codeup API 配置：${missing.join(", ")}`,
    };
  }
  const apiBaseError = codeupApiBaseError(normalizedConfig);
  if (apiBaseError) return { ok: false, reason: "invalid_api_base", error: apiBaseError };

  // 连接检测只读取一条当前令牌可见的仓库，不创建 MR，也不修改 Codeup 数据。
  const url = new URL(`${apiPrefix(normalizedConfig)}/repositories`);
  url.searchParams.set("page", "1");
  url.searchParams.set("perPage", "1");
  url.searchParams.set("archived", "false");
  const result = await requestJson(fetchImpl, url, requestOptions(normalizedConfig));
  if (!result.ok) return { ...result, error: `检测 Codeup 连接失败：${result.error}` };

  const repositories = responseList(result.data, ["repositories", "items", "list"]);
  const repository = repositories[0];
  return {
    ok: true,
    edition: normalizedConfig.edition,
    organizationId: normalizedConfig.organizationId,
    repositoryVisible: repositories.length > 0,
    repository: repository ? {
      id: /^\d+$/.test(text(repository.id)) ? Number(repository.id) : text(repository.id),
      name: text(repository.name),
      path: text(repository.pathWithNamespace || repository.fullPath || repository.path),
    } : null,
  };
}

function repositoryPaths(repository) {
  const paths = [repository?.pathWithNamespace, repository?.fullPath];
  for (const urlValue of [repository?.webUrl, repository?.httpUrl, repository?.httpUrlToRepo, repository?.sshUrl, repository?.sshUrlToRepo]) {
    const parsed = codeupRepositoryPathFromRemote(urlValue);
    if (parsed) paths.push(parsed);
  }
  return paths.map(cleanRepositoryPath).filter(Boolean);
}

export async function resolveCodeupRepository(config, repositoryHint, fetchImpl = fetch) {
  const configuredId = text(config.repositoryId);
  if (/^\d+$/.test(configuredId)) {
    return { ok: true, repository: { id: Number(configuredId), path: cleanRepositoryPath(repositoryHint || config.repositoryPath) }, discovered: false };
  }

  const repositoryPath = cleanRepositoryPath(configuredId || repositoryHint || config.repositoryPath);
  if (!repositoryPath) {
    return { ok: false, error: "无法从 Git remote 解析 Codeup 仓库路径，且未配置 repositoryId/repositoryPath" };
  }
  const repositoryName = repositoryPath.split("/").filter(Boolean).pop() || repositoryPath;
  // GetRepository 支持 URL-Encoder 编码后的仓库全路径，使用 Git remote 的精确路径查询，
  // 避免要求开发者手工维护 repositoryId，也避免列表搜索产生同名仓库歧义。
  const url = `${apiPrefix(config)}/repositories/${encodeURIComponent(repositoryPath)}`;
  const result = await requestJson(fetchImpl, url, requestOptions(config));
  if (!result.ok) return { ...result, error: `查询 Codeup 仓库“${repositoryPath}”失败：${result.error}` };

  const selected = result.data?.id != null
    ? result.data
    : (result.data?.result?.id != null ? result.data.result : result.data?.data);
  if (!/^\d+$/.test(text(selected?.id))) {
    return { ok: false, error: `Codeup 仓库“${repositoryPath}”响应中缺少有效仓库 ID` };
  }
  return {
    ok: true,
    repository: {
      id: Number(selected.id),
      path: repositoryPaths(selected)[0] || repositoryPath,
      name: text(selected.name) || repositoryName,
      webUrl: text(selected.webUrl),
    },
    discovered: true,
  };
}

function normalizedMemberValue(value) {
  return text(value).replace(/\s+/g, "").toLowerCase();
}

function findReviewer(members, reviewerName) {
  const expected = normalizedMemberValue(reviewerName);
  if (!expected) return null;
  const exact = members.filter((member) => [member?.name, member?.username, member?.email]
    .some((value) => normalizedMemberValue(value) === expected));
  if (exact.length === 1) return exact[0];
  const partial = members.filter((member) => [member?.name, member?.username, member?.email]
    .some((value) => normalizedMemberValue(value).includes(expected)));
  return partial.length === 1 ? partial[0] : null;
}

export async function resolveCodeupReviewers(config, repositoryId, fetchImpl = fetch) {
  const explicit = stringList(config.reviewerUserIds);
  if (explicit.length) return { reviewerUserIds: explicit, discovered: false, warnings: [] };
  const reviewerName = text(config.reviewerName);
  if (!reviewerName) return { reviewerUserIds: [], discovered: false, warnings: [] };

  const url = `${apiPrefix(config)}/repositories/${encodeURIComponent(repositoryId)}/members`;
  const result = await requestJson(fetchImpl, url, requestOptions(config));
  if (!result.ok) {
    return {
      reviewerUserIds: [],
      discovered: false,
      warnings: [`无法查询评审人“${reviewerName}”，将不指定评审人创建 MR：${result.error}`],
    };
  }
  const members = responseList(result.data, ["members", "items", "list"]);
  const reviewer = findReviewer(members, reviewerName);
  const userId = text(reviewer?.userId);
  if (!userId) {
    return {
      reviewerUserIds: [],
      discovered: false,
      warnings: [`未在代码库成员中唯一匹配评审人“${reviewerName}”，将不指定评审人创建 MR`],
    };
  }
  return { reviewerUserIds: [userId], discovered: true, warnings: [] };
}

export async function createCodeupChangeRequest(config, payload, fetchImpl = fetch) {
  const normalizedConfig = normalizeRequestConfig(config);
  const missing = missingCodeupPrConfig(normalizedConfig);
  if (missing.length) return { ok: false, reason: "missing_config", missing, error: `缺少 Codeup API 配置：${missing.join(", ")}` };
  const apiBaseError = codeupApiBaseError(normalizedConfig);
  if (apiBaseError) return { ok: false, reason: "invalid_api_base", error: apiBaseError };

  const repositoryResult = await resolveCodeupRepository(normalizedConfig, payload.repositoryPath, fetchImpl);
  if (!repositoryResult.ok) return { ...repositoryResult, reason: "repository_resolution_failed" };
  const repository = repositoryResult.repository;
  const reviewerResult = await resolveCodeupReviewers(normalizedConfig, repository.id, fetchImpl);
  const body = {
    sourceBranch: text(payload.sourceBranch),
    sourceProjectId: repository.id,
    targetBranch: text(payload.targetBranch),
    targetProjectId: repository.id,
    title: text(payload.title),
    description: text(payload.description),
    triggerAIReviewRun: false,
  };
  if (reviewerResult.reviewerUserIds.length) body.reviewerUserIds = reviewerResult.reviewerUserIds;
  if (text(payload.workItemId)) body.workItemIds = text(payload.workItemId);

  const url = `${apiPrefix(normalizedConfig)}/repositories/${encodeURIComponent(repository.id)}/changeRequests`;
  const result = await requestJson(fetchImpl, url, requestOptions(normalizedConfig, "POST", body));
  if (!result.ok) {
    return {
      ...result,
      reason: "api_failed",
      repository,
      reviewerUserIds: reviewerResult.reviewerUserIds,
      warnings: reviewerResult.warnings,
    };
  }
  const webUrl = codeupChangeRequestWebUrl(result.data, {
    repository,
    changesUrl: normalizedConfig.changesUrl,
  });
  return {
    ok: true,
    data: result.data,
    webUrl,
    localId: changeRequestLocalId(result.data),
    repository,
    repositoryDiscovered: repositoryResult.discovered,
    reviewerUserIds: reviewerResult.reviewerUserIds,
    reviewerDiscovered: reviewerResult.discovered,
    warnings: reviewerResult.warnings,
  };
}
