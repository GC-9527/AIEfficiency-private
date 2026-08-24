export const FEISHU_SOURCE_VIEW_URL_EXAMPLE = "https://project.feishu.cn/intelligentspace/workObjectView/bug/2OuLlBcDg?scope=workspaces&node=28602134";
export const MAX_FEISHU_SOURCE_VIEWS = 20;

function stringValue(value) {
  return String(value ?? "").trim();
}

function sourceViewArray(input = {}) {
  if (Array.isArray(input)) return input;
  const feishu = input?.feishu && typeof input.feishu === "object" ? input.feishu : input;
  if (Array.isArray(feishu?.sourceViews) && feishu.sourceViews.length) return feishu.sourceViews;
  if (feishu?.sourceView && typeof feishu.sourceView === "object") return [feishu.sourceView];
  if (stringValue(feishu?.web?.homepageUrl)) return [{ url: feishu.web.homepageUrl }];
  return [];
}

function sourceViewId(view = {}, index = 0) {
  const explicit = stringValue(view.id);
  if (explicit) return explicit;
  const parsed = parseFeishuSourceViewUrl(view.url);
  const projectKey = stringValue(view.sourceProjectKey || parsed.sourceProjectKey || "project")
    .replace(/[^a-zA-Z0-9_-]+/g, "-");
  const typeKey = stringValue(view.sourceWorkItemTypeKey || parsed.sourceWorkItemTypeKey || "source")
    .replace(/[^a-zA-Z0-9_-]+/g, "-");
  const viewId = stringValue(view.viewId || parsed.viewId || index + 1)
    .replace(/[^a-zA-Z0-9_-]+/g, "-");
  return `source-${projectKey}-${typeKey}-${viewId}`;
}

function stableSourceViewHash(value = "") {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function ensureUniqueSourceViewIds(sources = []) {
  const idCounts = new Map();
  for (const [index, view] of sources.entries()) {
    const id = sourceViewId(view, index);
    idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }

  const usedIds = new Set();
  return sources.map((view, index) => {
    const requestedId = sourceViewId(view, index);
    let id = requestedId;
    if ((idCounts.get(requestedId) || 0) > 1 || usedIds.has(id)) {
      const fingerprint = [
        stringValue(view.url),
        stringValue(view.sourceProjectKey),
        stringValue(view.sourceWorkItemTypeKey),
        stringValue(view.viewId),
        stringValue(view.name),
      ].join("|");
      const collisionBase = `${requestedId}-${stableSourceViewHash(fingerprint)}`;
      id = collisionBase;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${collisionBase}-${suffix}`;
        suffix += 1;
      }
    }
    usedIds.add(id);
    return id === view.id ? view : { ...view, id };
  });
}

function defaultSourceName(view = {}) {
  const typeKey = stringValue(view.sourceWorkItemTypeKey);
  const viewId = stringValue(view.viewId);
  if (typeKey && viewId) return `${typeKey} · ${viewId}`;
  return typeKey || viewId || "飞书工单来源";
}

export function sourceViewControlAriaLabels(view = {}, index = 0) {
  const sourceName = stringValue(view.name) || `来源 ${index + 1}`;
  return {
    toggle: `飞书工单来源“${sourceName}”启用状态`,
    setDefault: view.isDefault
      ? `飞书工单来源“${sourceName}”已是默认来源`
      : `将飞书工单来源“${sourceName}”设为默认来源`,
    remove: `删除飞书工单来源“${sourceName}”`,
    confirmRemove: `确认删除飞书工单来源“${sourceName}”`,
    cancelRemove: `取消删除飞书工单来源“${sourceName}”`,
  };
}

function normalizeOneSourceView(value = {}, index = 0) {
  const row = typeof value === "string" ? { url: value } : (value && typeof value === "object" ? value : {});
  const url = stringValue(row.url);
  const parsed = parseFeishuSourceViewUrl(url);
  const validation = validateFeishuSourceViewUrl(url);
  const view = {
    id: sourceViewId(row, index),
    name: stringValue(row.name || row.label),
    url,
    enabled: row.enabled !== false,
    isDefault: row.isDefault === true || row.primary === true || row.default === true,
    viewId: stringValue(row.viewId || parsed.viewId),
    scope: stringValue(row.scope || parsed.scope),
    node: stringValue(row.node || parsed.node),
    sourceProjectKey: stringValue(parsed.sourceProjectKey || row.sourceProjectKey || row.projectKey),
    sourceWorkItemTypeKey: stringValue(parsed.sourceWorkItemTypeKey || row.sourceWorkItemTypeKey || row.workItemTypeKey || row.typeKey),
    valid: validation.ok,
    validationError: validation.error,
  };
  if (!view.name) view.name = defaultSourceName(view);
  return view;
}

function ensureSingleDefault(sources = []) {
  if (!sources.length) return [];
  const firstExplicitEnabledDefault = sources.findIndex((view) => view.isDefault && view.enabled);
  const firstExplicitDefault = sources.findIndex((view) => view.isDefault);
  const firstEnabled = sources.findIndex((view) => view.enabled);
  const defaultIndex = firstExplicitEnabledDefault >= 0
    ? firstExplicitEnabledDefault
    : firstEnabled >= 0
      ? firstEnabled
      : firstExplicitDefault >= 0
        ? firstExplicitDefault
        : 0;
  return sources.map((view, index) => ({ ...view, isDefault: index === defaultIndex }));
}

function normalizeSourceViewList(input = {}, options = {}) {
  const normalized = ensureUniqueSourceViewIds(sourceViewArray(input).map(normalizeOneSourceView));
  const views = options.dedupe === true ? dedupeSourceViewsByCanonicalKey(normalized) : normalized;
  return ensureSingleDefault(views);
}

function dedupeSourceViewsByCanonicalKey(sources = []) {
  const seen = new Set();
  const out = [];
  for (const view of sources) {
    const key = canonicalSourceViewKey(view);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(view);
  }
  return out;
}

function persistedSourceView(view = {}) {
  return {
    id: stringValue(view.id),
    name: stringValue(view.name),
    url: stringValue(view.url),
    enabled: view.enabled !== false,
    isDefault: view.isDefault === true,
    viewId: stringValue(view.viewId),
    scope: stringValue(view.scope),
    node: stringValue(view.node),
    sourceProjectKey: stringValue(view.sourceProjectKey),
    sourceWorkItemTypeKey: stringValue(view.sourceWorkItemTypeKey),
  };
}

export function parseFeishuSourceViewUrl(url = "") {
  try {
    const parsed = new URL(stringValue(url));
    if (
      parsed.protocol !== "https:"
      || parsed.hostname.toLowerCase() !== "project.feishu.cn"
      || parsed.username
      || parsed.password
    ) return {};
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (stringValue(parts[1]).toLowerCase() !== "workobjectview") return {};
    return {
      sourceProjectKey: stringValue(parts[0]),
      sourceWorkItemTypeKey: stringValue(parts[2]),
      viewId: stringValue(parts[3]),
      scope: stringValue(parsed.searchParams.get("scope")),
      node: stringValue(parsed.searchParams.get("node")),
      hostname: parsed.hostname.toLowerCase(),
      normalizedUrl: parsed.toString(),
    };
  } catch {
    return {};
  }
}

export function validateFeishuSourceViewUrl(url = "") {
  const value = stringValue(url);
  if (!value) return { ok: false, error: "请输入飞书工单列表对应的视图 URL" };
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    return { ok: false, error: "URL 格式不正确，请粘贴完整的 https:// 地址" };
  }
  if (parsedUrl.protocol !== "https:") {
    return { ok: false, error: "飞书来源必须使用 https:// 地址" };
  }
  if (parsedUrl.hostname.toLowerCase() !== "project.feishu.cn") {
    return { ok: false, error: "仅支持 project.feishu.cn 的飞书项目视图" };
  }
  if (parsedUrl.username || parsedUrl.password) {
    return { ok: false, error: "飞书来源 URL 不能包含账号或密码" };
  }
  const parts = parsedUrl.pathname.split("/").filter(Boolean);
  if (stringValue(parts[1]).toLowerCase() !== "workobjectview" || !parts[2] || !parts[3]) {
    return {
      ok: false,
      error: "请选择 workObjectView 列表地址，路径应包含工单类型和 View ID",
    };
  }
  const parsed = parseFeishuSourceViewUrl(value);
  return { ok: true, error: "", parsed, normalizedUrl: parsed.normalizedUrl || value };
}

export function canonicalSourceViewKey(value = {}) {
  const url = typeof value === "string" ? value : value?.url;
  const parsed = parseFeishuSourceViewUrl(url);
  if (!parsed.viewId) return "";
  return [
    parsed.hostname,
    parsed.sourceProjectKey.toLowerCase(),
    parsed.sourceWorkItemTypeKey.toLowerCase(),
    parsed.viewId.toLowerCase(),
  ].join("|");
}

export function normalizeFeishuSourceViewsForUi(config = {}) {
  return normalizeSourceViewList(config);
}

export function enabledFeishuSourceViews(config = {}) {
  return normalizeFeishuSourceViewsForUi(config).filter((view) => view.enabled);
}

export function defaultFeishuSourceView(config = {}) {
  const sources = normalizeFeishuSourceViewsForUi(config);
  return sources.find((view) => view.isDefault && view.enabled)
    || sources.find((view) => view.enabled)
    || sources.find((view) => view.isDefault)
    || sources[0]
    || normalizeOneSourceView({});
}

export function normalizeFeishuSourceViewForUi(config = {}) {
  return defaultFeishuSourceView(config);
}

export function sourceViewUrl(config = {}) {
  return defaultFeishuSourceView(config).url || FEISHU_SOURCE_VIEW_URL_EXAMPLE;
}

export function sourceViewSummary(config = {}) {
  const view = defaultFeishuSourceView(config);
  const parts = [
    view.sourceProjectKey && view.sourceWorkItemTypeKey
      ? `${view.sourceProjectKey}/${view.sourceWorkItemTypeKey}`
      : "",
    view.viewId ? `视图 ${view.viewId}` : "",
    view.node ? `节点 ${view.node}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "未设置来源视图";
}

export function sourceViewsSummary(config = {}) {
  const sources = normalizeFeishuSourceViewsForUi(config);
  const enabled = sources.filter((view) => view.enabled);
  const primary = defaultFeishuSourceView(sources);
  if (!sources.length) return "未设置飞书工单来源";
  return `已启用 ${enabled.length}/${sources.length}${primary?.name ? ` · 默认：${primary.name}` : ""}`;
}

export function sourceViewValidationIssues(config = {}) {
  const sources = normalizeFeishuSourceViewsForUi(config);
  const issues = [];
  if (!sources.length) {
    issues.push({ id: "", code: "empty", message: "请至少添加一个飞书工单来源" });
    return issues;
  }
  if (sources.length > MAX_FEISHU_SOURCE_VIEWS) {
    issues.push({
      id: "",
      code: "too-many",
      message: `飞书工单来源最多支持 ${MAX_FEISHU_SOURCE_VIEWS} 个`,
    });
  }
  if (!sources.some((view) => view.enabled)) {
    issues.push({ id: "", code: "no-enabled", message: "请至少启用一个飞书工单来源" });
  }
  const firstByKey = new Map();
  for (const view of sources) {
    if (!view.valid) {
      issues.push({
        id: view.id,
        code: "invalid-url",
        message: view.validationError || "飞书来源 URL 无效",
      });
      continue;
    }
    const key = canonicalSourceViewKey(view);
    const first = firstByKey.get(key);
    if (first) {
      issues.push({
        id: view.id,
        code: "duplicate",
        duplicateId: first.id,
        message: `与“${first.name}”指向同一个飞书视图`,
      });
    } else {
      firstByKey.set(key, view);
    }
  }
  return issues;
}

export function sourceViewsForRequest(config = {}) {
  return enabledFeishuSourceViews(config)
    .map(persistedSourceView);
}

export function applySourceViewsToConfig(config = {}, input = []) {
  const sources = normalizeSourceViewList(input, { dedupe: true });
  const persisted = sources.map(persistedSourceView);
  const primary = persisted.find((view) => view.isDefault && view.enabled)
    || persisted.find((view) => view.enabled)
    || persisted.find((view) => view.isDefault)
    || persisted[0]
    || null;
  const currentFeishu = config?.feishu && typeof config.feishu === "object" ? config.feishu : {};
  const nextFeishu = {
    ...currentFeishu,
    sourceViews: persisted,
  };
  if (primary) {
    nextFeishu.sourceView = {
      url: primary.url,
      viewId: primary.viewId,
      scope: primary.scope,
      node: primary.node,
    };
    nextFeishu.web = {
      ...(currentFeishu.web || {}),
      homepageUrl: primary.url,
    };
    nextFeishu.spaceKey = primary.sourceProjectKey;
    nextFeishu.workItemTypeKey = primary.sourceWorkItemTypeKey;
  }
  return { ...config, feishu: nextFeishu };
}

export function addFeishuSourceView(input = [], draft = {}) {
  const sources = normalizeFeishuSourceViewsForUi(input);
  if (sources.length >= MAX_FEISHU_SOURCE_VIEWS) {
    return {
      sources,
      added: null,
      error: `飞书工单来源最多支持 ${MAX_FEISHU_SOURCE_VIEWS} 个`,
      duplicateId: "",
    };
  }
  const validation = validateFeishuSourceViewUrl(draft.url);
  if (!validation.ok) return { sources, added: null, error: validation.error, duplicateId: "" };
  const duplicateKey = canonicalSourceViewKey(draft.url);
  const duplicate = sources.find((view) => canonicalSourceViewKey(view) === duplicateKey);
  if (duplicate) {
    return {
      sources,
      added: null,
      error: `该来源已存在：${duplicate.name}`,
      duplicateId: duplicate.id,
    };
  }
  const parsed = validation.parsed || {};
  const added = normalizeOneSourceView({
    id: `source-${stringValue(parsed.sourceProjectKey || "project")}-${stringValue(parsed.sourceWorkItemTypeKey || "view")}-${stringValue(parsed.viewId || Date.now())}`,
    name: stringValue(draft.name),
    url: validation.normalizedUrl || stringValue(draft.url),
    enabled: true,
    isDefault: !sources.some((view) => view.enabled),
  }, sources.length);
  const nextSources = ensureSingleDefault(ensureUniqueSourceViewIds([...sources, added]));
  return {
    sources: nextSources,
    added: nextSources.find((view) => canonicalSourceViewKey(view) === duplicateKey) || nextSources[nextSources.length - 1],
    error: "",
    duplicateId: "",
  };
}

export function updateFeishuSourceView(input = [], id = "", patch = {}) {
  const sources = normalizeFeishuSourceViewsForUi(input);
  return ensureSingleDefault(ensureUniqueSourceViewIds(sources.map((view, index) => {
    if (view.id !== id) return view;
    const urlChanged = Object.prototype.hasOwnProperty.call(patch, "url");
    const previousAutoName = defaultSourceName(view);
    const clearAutoName = urlChanged && stringValue(view.name) === previousAutoName;
    return normalizeOneSourceView({
      ...view,
      ...(urlChanged ? {
        viewId: "",
        scope: "",
        node: "",
        sourceProjectKey: "",
        sourceWorkItemTypeKey: "",
        ...(clearAutoName ? { name: "" } : {}),
      } : {}),
      ...patch,
      id: view.id,
    }, index);
  })));
}

export function setDefaultFeishuSourceView(input = [], id = "") {
  const sources = normalizeFeishuSourceViewsForUi(input);
  return sources.map((view) => ({
    ...view,
    enabled: view.id === id ? true : view.enabled,
    isDefault: view.id === id,
  }));
}

export function toggleFeishuSourceView(input = [], id = "", enabled = true) {
  const sources = normalizeFeishuSourceViewsForUi(input);
  const target = sources.find((view) => view.id === id);
  if (!target) return { sources, error: "未找到要修改的飞书来源" };
  if (!enabled && target.enabled && sources.filter((view) => view.enabled).length <= 1) {
    return { sources, error: "至少要保留一个已启用的飞书工单来源" };
  }
  let next = sources.map((view) => view.id === id ? { ...view, enabled } : view);
  if (!enabled && target.isDefault) {
    const nextDefault = next.find((view) => view.enabled);
    next = next.map((view) => ({ ...view, isDefault: view.id === nextDefault?.id }));
  } else if (enabled && !next.some((view) => view.isDefault && view.enabled)) {
    next = next.map((view) => ({ ...view, isDefault: view.id === id }));
  }
  return { sources: ensureSingleDefault(next), error: "" };
}

export function removeFeishuSourceView(input = [], id = "") {
  const sources = normalizeFeishuSourceViewsForUi(input);
  const target = sources.find((view) => view.id === id);
  if (!target) return { sources, removed: null, error: "未找到要删除的飞书来源" };
  if (sources.length <= 1) {
    return { sources, removed: null, error: "至少要保留一个飞书工单来源" };
  }
  if (target.enabled && sources.filter((view) => view.enabled).length <= 1) {
    return { sources, removed: null, error: "请先启用其他来源，再删除当前唯一启用的来源" };
  }
  return {
    sources: ensureSingleDefault(sources.filter((view) => view.id !== id)),
    removed: target,
    error: "",
  };
}
