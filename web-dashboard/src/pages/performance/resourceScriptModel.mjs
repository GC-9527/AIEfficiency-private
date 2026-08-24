function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value) {
  return String(value ?? "").trim();
}

function cloneObject(value) {
  return { ...asObject(value) };
}

function categoryName(source) {
  const category = typeof source.category === "string"
    ? source.category
    : asObject(source.category).name || asObject(source.category).label || asObject(source.category).id;
  return clean(category || source.group || source.folder || source.categoryPath) || "未分类";
}

function availabilityReason(source) {
  const availability = asObject(source.availability);
  return clean(
    source.availabilityReason
    || source.unavailableReason
    || availability.reason
    || source.disabledReason,
  );
}

export function normalizeResourceScripts(value) {
  const scripts = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const source = asObject(raw);
    const id = clean(source.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const workflowSource = Array.isArray(source.workflow)
      ? { steps: source.workflow }
      : asObject(source.workflow);
    const steps = Array.isArray(workflowSource.steps) ? workflowSource.steps : [];
    scripts.push({
      ...source,
      id,
      name: clean(source.name || source.label) || id,
      description: clean(source.description),
      category: categoryName(source),
      runner: clean(source.runner || source.entry),
      enabled: source.enabled !== false,
      available: source.available !== false
        && source.runnable !== false
        && asObject(source.availability).available !== false,
      availabilityReason: availabilityReason(source),
      workflow: { ...workflowSource, steps },
      run: cloneObject(source.run),
      flow: cloneObject(source.flow),
    });
  }
  return scripts;
}

export function resourceScriptAvailability(script) {
  if (!script || typeof script !== "object") {
    return { code: "missing", label: "不存在", reason: "脚本目录中没有该任务", selectable: false };
  }
  if (script.enabled === false) {
    return {
      code: "disabled",
      label: "已停用",
      reason: clean(script.availabilityReason) || "配置中已禁用",
      selectable: false,
    };
  }
  if (script.available === false) {
    return {
      code: "unavailable",
      label: "入口不可用",
      reason: clean(script.availabilityReason) || "脚本入口文件不存在或未通过校验",
      selectable: false,
    };
  }
  if (!clean(script.runner)) {
    return { code: "missing-runner", label: "缺少入口", reason: "未配置 runner 入口", selectable: false };
  }
  const steps = Array.isArray(script.workflow)
    ? script.workflow
    : script.workflow?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { code: "missing-workflow", label: "缺少工作流", reason: "未配置 workflow.steps", selectable: false };
  }
  return { code: "ready", label: "可运行", reason: "", selectable: true };
}

export function groupResourceScripts(value) {
  const groups = new Map();
  for (const script of normalizeResourceScripts(value)) {
    const category = clean(script.category) || "未分类";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(script);
  }
  return [...groups.entries()].map(([category, scripts]) => ({ category, scripts }));
}

export function chooseResourceScriptId(scripts, requestedId = "", defaultScriptId = "") {
  const catalog = normalizeResourceScripts(scripts);
  const enabled = catalog.filter((script) => resourceScriptAvailability(script).selectable);
  const requested = clean(requestedId);
  const fallback = clean(defaultScriptId);
  if (enabled.some((script) => script.id === requested)) return requested;
  if (enabled.some((script) => script.id === fallback)) return fallback;
  return enabled[0]?.id || "";
}

export function findResourceScript(scripts, id) {
  const requested = clean(id);
  return normalizeResourceScripts(scripts).find((script) => script.id === requested) || null;
}

function snapshotCandidates(run, detail) {
  return [
    asObject(run?.configSnapshot).script,
    // Compatibility with the name used by an early local prototype.
    asObject(run?.configSnapshot).taskScript,
    asObject(detail?.configSnapshot).script,
    asObject(detail?.configSnapshot).taskScript,
    asObject(asObject(detail?.run).configSnapshot).script,
    asObject(asObject(detail?.run).configSnapshot).taskScript,
    run?.script,
    detail?.run?.script,
    detail?.profile?.script,
  ];
}

export function resolveResourceScript({ run = {}, detail = null, scripts = [], fallbackScriptId = "" } = {}) {
  for (const candidate of snapshotCandidates(run, detail)) {
    const normalized = normalizeResourceScripts([candidate])[0];
    if (normalized) return { ...normalized, source: "snapshot" };
  }

  const requestedId = clean(
    run?.options?.scriptId
    || detail?.run?.scriptId
    || detail?.profile?.scriptId
    || fallbackScriptId,
  );
  const catalogScript = findResourceScript(scripts, requestedId);
  return catalogScript ? { ...catalogScript, source: "catalog" } : null;
}

export function effectiveResourceRunForm(baseRun, script) {
  return { ...asObject(baseRun), ...asObject(script?.run) };
}

export function parseResourceScriptsJson(value) {
  const parsed = JSON.parse(String(value ?? ""));
  if (!Array.isArray(parsed)) throw new Error("测试任务脚本配置必须是 JSON 数组");
  const normalized = normalizeResourceScripts(parsed);
  if (normalized.length !== parsed.length) {
    throw new Error("每个脚本必须有唯一且非空的 id");
  }
  return { raw: parsed, scripts: normalized };
}
