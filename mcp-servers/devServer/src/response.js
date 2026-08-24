import { AppMarketError, redactSecrets, sha256 } from "./security.js";

const COLLECTION_PATHS = [
  ["rows"],
  ["data", "records"],
  ["data", "rows"],
  ["data", "list"],
  ["records"],
  ["data"],
];

function getNested(value, path) {
  let current = value;
  for (const key of path) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

export function extractCollection(payload) {
  if (Array.isArray(payload)) {
    return { items: payload, adapter: "root-array" };
  }
  for (const path of COLLECTION_PATHS) {
    const value = getNested(payload, path);
    if (Array.isArray(value)) {
      return { items: value, adapter: path.join(".") };
    }
  }
  return { items: [], adapter: "none" };
}

export function extractTotal(payload, fallback) {
  const candidates = [
    payload?.total,
    payload?.data?.total,
    payload?.data?.page?.total,
    payload?.page?.total,
  ];
  for (const value of candidates) {
    if (
      value === null ||
      value === undefined ||
      (typeof value === "string" && value.trim() === "")
    ) {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return fallback;
}

function normalizedStrings(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(normalizedStrings);
  if (typeof value === "object") {
    return Object.values(value).flatMap(normalizedStrings);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean);
}

function containsValue(record, fields, expected, exact = false) {
  if (expected === undefined || expected === null || expected === "") return true;
  const target = String(expected).trim().toLocaleLowerCase();
  return fields.some((field) =>
    normalizedStrings(
      record && Object.hasOwn(record, field) ? record[field] : undefined
    ).some((value) =>
      exact ? value === target : value.includes(target)
    )
  );
}

const FILTER_FIELDS = Object.freeze({
  id: ["id", "appId", "auditId"],
  appId: ["appId"],
  catalogAppId: ["appId", "id"],
  appName: ["appName", "appNameEn", "name", "title", "titleEn"],
  packageName: ["packageName", "appPkg"],
  appKey: ["appKey"],
  deptId: ["deptId", "deptIds"],
  country: [
    "countryList",
    "countryCode",
    "internationalCode",
    "region",
    "chineseName",
  ],
  carModelId: ["carModelIds", "carModelId"],
  catalogCarModelId: ["carModelIds", "carModelId", "id"],
  carModel: ["carModel", "carModelName", "name"],
  channel: ["channel"],
  state: ["state", "status", "enabled"],
  keyword: [
    "id",
    "appId",
    "appName",
    "appNameEn",
    "name",
    "packageName",
    "appPkg",
    "appKey",
    "title",
    "titleEn",
    "deptName",
    "carModel",
    "internationalCode",
    "chineseName",
  ],
});

export function filterItems(items, filters = {}) {
  return items.filter((record) =>
    Object.entries(filters).every(([key, expected]) => {
      if (expected === undefined || expected === null || expected === "") {
        return true;
      }
      const fields = FILTER_FIELDS[key];
      if (!fields) return true;
      const exact = [
        "id",
        "appId",
        "catalogAppId",
        "deptId",
        "carModelId",
        "catalogCarModelId",
        "state",
        "channel",
      ].includes(key);
      return containsValue(record, fields, expected, exact);
    })
  );
}

function pruneConfigJson(value, includeConfigJson) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => pruneConfigJson(item, includeConfigJson));
  }
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key === "configJson" && !includeConfigJson) continue;
    if (key === "configJson" && typeof item === "string") {
      if (item.length > 128 * 1024) {
        output[key] = "[CONFIG_JSON_TOO_LARGE]";
        continue;
      }
      try {
        output[key] = redactSecrets(JSON.parse(item));
      } catch {
        output[key] = "[CONFIG_JSON_INVALID]";
      }
      continue;
    }
    output[key] = pruneConfigJson(item, includeConfigJson);
  }
  return output;
}

export function normalizeVoiceKey(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return /^[A-Za-z0-9 ]+$/.test(value)
    ? value.replace(/ /g, "").toLocaleLowerCase("en-US")
    : value;
}

export function voiceKeysForRecord(record) {
  const keys = new Set();
  for (const token of String(record?.appKey || "").split(",")) {
    const normalized = normalizeVoiceKey(token);
    if (normalized) keys.add(normalized);
  }
  const nameKey = normalizeVoiceKey(record?.appName);
  if (nameKey) keys.add(nameKey);
  return [...keys];
}

export function mergeVoiceRecords(catalogRecords, detailRecords) {
  const detailsById = new Map();
  const detailsWithoutId = [];
  for (const detail of detailRecords) {
    const id = String(detail?.appId || "").trim();
    if (id) detailsById.set(id, detail);
    else detailsWithoutId.push(detail);
  }
  const merged = [];
  for (const catalog of catalogRecords) {
    // Full app-list records use `id`, while WebApp records reference that
    // application through `appId`.
    const id = String(catalog?.appId || catalog?.id || "").trim();
    const detail = id ? detailsById.get(id) : undefined;
    if (!detail) {
      merged.push(catalog);
      continue;
    }
    detailsById.delete(id);
    const aliases = new Set([
      ...voiceKeysForRecord(catalog),
      ...voiceKeysForRecord(detail),
    ]);
    merged.push({
      ...catalog,
      ...Object.fromEntries(
        Object.entries(detail).filter(
          ([, value]) => value !== null && value !== undefined && value !== ""
        )
      ),
      appKey: [...aliases].join(","),
    });
  }
  merged.push(...detailsById.values(), ...detailsWithoutId);
  return merged;
}

function pageMetadata(payload, query, returned) {
  const number = Number(query?.pageNum || payload?.current || 1);
  const size = Number(query?.pageSize || payload?.size || returned || 0);
  const total = extractTotal(payload, returned);
  return {
    number,
    size,
    returned,
    total,
    complete: total <= number * Math.max(size, 1),
  };
}

export function collectionPayload(
  result,
  {
    query = {},
    filters = {},
    includeConfigJson = false,
    expectedAdapter,
    warnings = [],
  } = {}
) {
  const { items: rawItems, adapter } = extractCollection(result.data);
  const filtered = filterItems(rawItems, filters);
  const items = pruneConfigJson(filtered, includeConfigJson);
  const schemaWarnings = [...warnings];
  if (expectedAdapter && adapter !== expectedAdapter) {
    schemaWarnings.push(
      `响应容器为 ${adapter}，与已观察契约 ${expectedAdapter} 不一致`
    );
  }
  return {
    status: schemaWarnings.length ? "partial" : "ok",
    data: { items },
    meta: {
      environment: result.environment || "stg",
      source: "appmarket-admin-api",
      endpointIds: [result.endpointId],
      requestIds: [result.requestId],
      fetchedAt: result.fetchedAt,
      page: pageMetadata(result.data, query, items.length),
      validation: {
        schema: schemaWarnings.length ? "warning" : "pass",
        adapter,
        warnings: schemaWarnings,
      },
      evidenceSha256: sha256(items),
    },
  };
}

export function objectPayload(result, data = result.data, warnings = []) {
  const safeData = pruneConfigJson(data, false);
  return {
    status: warnings.length ? "partial" : "ok",
    data: safeData,
    meta: {
      environment: result.environment || "stg",
      source: "appmarket-admin-api",
      endpointIds: [result.endpointId],
      requestIds: [result.requestId],
      fetchedAt: result.fetchedAt,
      validation: {
        schema: warnings.length ? "warning" : "pass",
        warnings,
      },
      evidenceSha256: sha256(safeData),
    },
  };
}

export function combinePayloads(payloads, data, warnings = []) {
  const statuses = payloads.map((item) => item.status);
  const partial = warnings.length || statuses.some((status) => status !== "ok");
  return {
    status: partial ? "partial" : "ok",
    data,
    meta: {
      environment: payloads[0]?.meta?.environment || "stg",
      source: "appmarket-admin-api",
      endpointIds: [
        ...new Set(payloads.flatMap((item) => item.meta?.endpointIds || [])),
      ],
      requestIds: [
        ...new Set(payloads.flatMap((item) => item.meta?.requestIds || [])),
      ],
      fetchedAt: new Date().toISOString(),
      validation: {
        schema: partial ? "warning" : "pass",
        warnings: [
          ...warnings,
          ...payloads.flatMap(
            (item) => item.meta?.validation?.warnings || []
          ),
        ],
      },
      evidenceSha256: sha256(data),
    },
  };
}

export function assertAtLeastOneIdentifier(args, keys) {
  const present = keys.filter((key) => {
    const value = args?.[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
  if (!present.length) {
    throw new AppMarketError(
      "INVALID_ARGUMENT",
      `至少提供一个标识：${keys.join(", ")}`
    );
  }
  return present;
}

export function compareExpected(actual, expected) {
  const checks = [];
  for (const [field, expectedValue] of Object.entries(expected || {})) {
    if (expectedValue === undefined) continue;
    const actualValue = actual?.[field];
    const pass = Array.isArray(expectedValue)
      ? expectedValue.every((value) =>
          normalizedStrings(actualValue).includes(
            String(value).trim().toLocaleLowerCase()
          )
        )
      : normalizedStrings(actualValue).includes(
          String(expectedValue).trim().toLocaleLowerCase()
        );
    checks.push({ field, expected: expectedValue, actual: actualValue, pass });
  }
  return checks;
}

export function validateRequiredFields(items, requiredFields) {
  if (!items.length) return { pass: true, missing: [] };
  const missing = requiredFields.filter((field) =>
    items.some((item) => !Object.hasOwn(item || {}, field))
  );
  return { pass: missing.length === 0, missing };
}
