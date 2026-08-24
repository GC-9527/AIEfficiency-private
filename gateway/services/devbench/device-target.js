import { adb } from "../cardev/index.js";

const deviceInfoCache = new Map();

function cleanText(value) {
  return String(value || "").trim();
}

function uniqueTexts(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = cleanText(value);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  return value == null || value === "" ? [] : [value];
}

function stripBuildVariantSuffix(value) {
  const original = cleanText(value);
  const stripped = original.replace(
    /(?:[-_.]?(?:development|production|release|debug|stage|staging|prod|dev|stg|uat|qa))+$/i,
    "",
  );
  return stripped || original;
}

function normalizedIdentity(value) {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function identitiesMatch(left, right) {
  const a = normalizedIdentity(left);
  const b = normalizedIdentity(right);
  return !!a && a === b;
}

function mappingForTarget(vehicleMap, target) {
  if (!vehicleMap || typeof vehicleMap !== "object") return null;
  const wanted = normalizedIdentity(stripBuildVariantSuffix(target));
  if (!wanted) return null;
  for (const [key, mapping] of Object.entries(vehicleMap)) {
    if (normalizedIdentity(stripBuildVariantSuffix(key)) === wanted) return mapping;
  }
  return null;
}

/**
 * Resolve the business vehicle/flavor aliases and any explicitly registered
 * Android models. Business vehicle names alone are not enough to prove that a
 * ro.product.model value is a mismatch, so they are kept separate.
 */
export function resolveVerifyTargetHints(tab, { vehicleMap = {} } = {}) {
  const businessTargets = [];
  const explicitModels = [];
  const addBusiness = (value) => {
    const text = stripBuildVariantSuffix(value);
    if (text) businessTargets.push(text);
  };
  const addModels = (value) => {
    for (const item of listValues(value)) {
      const text = cleanText(item);
      if (text) explicitModels.push(text);
    }
  };

  addBusiness(tab?.targetVehicle);
  addBusiness(tab?.vehicle);
  addBusiness(tab?.remotePull?.vehicle);
  addBusiness(tab?.reviewContext?.inference?.vehicle);
  addBusiness(tab?.reviewContext?.vehicle);
  addBusiness(tab?.tbContext?.vehicle);
  for (const entry of tab?.flavors || []) addBusiness(entry?.vehicle || entry?.flavor);

  addModels(tab?.targetDeviceModel);
  addModels(tab?.targetAndroidModel);
  addModels(tab?.androidModels);
  addModels(tab?.deviceModels);
  addModels(tab?.remotePull?.modelName);
  addModels(tab?.remotePull?.androidModels);
  addModels(tab?.remotePull?.deviceModels);

  const uniqueBusinessTargets = uniqueTexts(businessTargets);
  for (const target of uniqueBusinessTargets) {
    const mapping = mappingForTarget(vehicleMap, target);
    if (!mapping) continue;
    addModels(mapping.modelName);
    addModels(mapping.androidModel);
    addModels(mapping.deviceModel);
    addModels(mapping.androidModels);
    addModels(mapping.deviceModels);
    for (const alias of listValues(mapping.aliases)) addBusiness(alias);
  }

  return {
    businessTargets: uniqueTexts(businessTargets),
    explicitModels: uniqueTexts(explicitModels),
  };
}

export function parseDeviceModelInfo(serial, stdout) {
  const [
    model = "",
    brand = "",
    manufacturer = "",
    device = "",
    product = "",
    androidVersion = "",
    apiLevel = "",
  ] = String(stdout || "").split(/\r?\n/).map((item) => item.trim());
  const vendor = brand || manufacturer || "";
  return {
    serial: cleanText(serial),
    model,
    brand: vendor,
    manufacturer,
    device,
    product,
    androidVersion,
    apiLevel,
    label: [vendor, model].filter(Boolean).join(" ").trim(),
  };
}

/**
 * Shared device metadata reader. The device list UI may use the cache, while
 * the acceptance entry forces a fresh read so its prompt cannot use stale
 * model/Android information.
 */
export async function readDeviceModelInfo(serial, {
  online = true,
  force = false,
  timeout = 6000,
} = {}) {
  const key = cleanText(serial);
  if (!key) return { serial: "", online: false, label: "", error: "设备 serial 为空" };
  if (!force && deviceInfoCache.has(key)) {
    return { ...deviceInfoCache.get(key), online: !!online };
  }
  if (!online) return { serial: key, online: false, label: "" };
  try {
    const result = await adb.shell(
      key,
      "getprop ro.product.model; getprop ro.product.brand; getprop ro.product.manufacturer; getprop ro.product.device; getprop ro.product.name; getprop ro.build.version.release; getprop ro.build.version.sdk",
      { timeout },
    );
    if (!result?.ok) {
      return {
        serial: key,
        online: false,
        label: "",
        error: cleanText(result?.error || result?.stderr || "读取设备属性失败"),
      };
    }
    const info = { ...parseDeviceModelInfo(key, result.stdout), online: true };
    if (info.model || info.androidVersion) deviceInfoCache.set(key, info);
    return info;
  } catch (error) {
    return { serial: key, online: false, label: "", error: error?.message || String(error) };
  }
}

export function assessVerifyDeviceTarget(tab, deviceInfo = {}, options = {}) {
  const targets = resolveVerifyTargetHints(tab, options);
  const serial = cleanText(tab?.deviceSerial || deviceInfo?.serial);
  const actualModelIdentities = uniqueTexts([
    deviceInfo?.model,
    deviceInfo?.device,
    deviceInfo?.product,
    [deviceInfo?.brand || deviceInfo?.manufacturer, deviceInfo?.model].filter(Boolean).join(" "),
  ]);
  const base = {
    status: "unknown",
    checkedAt: Date.now(),
    serial,
    device: {
      model: cleanText(deviceInfo?.model),
      brand: cleanText(deviceInfo?.brand || deviceInfo?.manufacturer),
      androidVersion: cleanText(deviceInfo?.androidVersion),
      apiLevel: cleanText(deviceInfo?.apiLevel),
      label: cleanText(deviceInfo?.label),
    },
    ...targets,
  };

  if (deviceInfo?.online === false || (deviceInfo?.deviceStatus && deviceInfo.deviceStatus !== "device")) {
    return { ...base, status: "offline", error: cleanText(deviceInfo?.error) };
  }
  if (deviceInfo?.error) {
    return { ...base, status: "offline", error: cleanText(deviceInfo.error) };
  }
  if (!actualModelIdentities.length) {
    return { ...base, status: "offline", error: "未读取到设备型号属性" };
  }

  // A business vehicle/flavor name or the device brand alone cannot prove that
  // this is the target Android model. Only an explicitly registered Android
  // model may produce a positive match.
  const matchedTarget = targets.explicitModels.find(
    (target) => actualModelIdentities.some((actual) => identitiesMatch(target, actual)),
  );
  if (matchedTarget) return { ...base, status: "matched", matchedTarget };
  if (targets.explicitModels.length) return { ...base, status: "mismatch" };
  return base;
}

export async function inspectVerifyDeviceTarget(tab, options = {}) {
  const serial = cleanText(tab?.deviceSerial);
  if (!serial) {
    return assessVerifyDeviceTarget(tab, {
      serial: "",
      online: false,
      error: "未绑定目标设备",
    }, options);
  }

  const listed = await adb.listDevices();
  if (!listed?.ok) {
    return assessVerifyDeviceTarget(tab, {
      serial,
      online: false,
      error: cleanText(listed?.error || "无法读取 adb 设备列表"),
    }, options);
  }
  const current = (listed.devices || []).find((device) => cleanText(device?.id) === serial);
  if (!current || current.status !== "device") {
    return assessVerifyDeviceTarget(tab, {
      serial,
      online: false,
      deviceStatus: current?.status || "missing",
      error: current ? `设备状态为 ${current.status}` : "绑定设备当前未连接",
    }, options);
  }

  const info = await readDeviceModelInfo(serial, { online: true, force: true });
  return assessVerifyDeviceTarget(tab, { ...info, deviceStatus: current.status }, options);
}

function deviceDescription(assessment) {
  const device = assessment?.device || {};
  const label = device.label || [device.brand, device.model].filter(Boolean).join(" ").trim() || "型号未知";
  const android = [
    device.androidVersion && `Android ${device.androidVersion}`,
    device.apiLevel && `API ${device.apiLevel}`,
  ].filter(Boolean).join(" / ");
  return `${label}${android ? `，${android}` : ""}${assessment?.serial ? `（${assessment.serial}）` : ""}`;
}

function fallbackGuidanceLines() {
  return [
    `- 根据实际情况，可以在确认包名、明确卸载会清除该应用本机数据且不会破坏升级/缓存/数据库/登录态等复现前提后，卸载绑定设备上的应用市场；用户未授权卸载时不要自行执行。`,
    `- 可使用 AppMock 模拟并回读目标车型 Profile，再用 Appium、UIAutomator 或图形识别脚本模拟真实点击，采集录屏、截图、UI 层级树和 logcat 完成验收。`,
    `- AppMock 结果必须明确标为“兼容 Android 设备 + AppMock 环境验收”，不得描述成目标车型真机通过；验收后恢复 AppMock 与设备原状态。`,
  ];
}

export function buildVerifyDeviceGuidance(assessment) {
  if (!assessment) {
    return [
      `0.【设备与目标核对】本轮尚未取得实时设备核对结果，不能声称系统已经读取设备，也不能仅凭绑定 serial 宣称目标车型真机通过。先读取当前连接设备的 Android 型号并与目标登记核对；无法证明一致时，按兼容设备模拟范围验收。`,
      ...fallbackGuidanceLines(),
    ];
  }
  const value = assessment;
  const targetText = uniqueTexts([...(value.businessTargets || []), ...(value.explicitModels || [])]).join(" / ") || "未登记";
  const currentText = deviceDescription(value);

  if (value.status === "matched") {
    return [
      `0.【设备与目标核对】系统刚刚读取绑定设备属性：${currentText}；目标车型/Android 型号线索：${targetText}。当前设备标识命中已登记目标（${value.matchedTarget || "已匹配"}）。`,
      `- 仍须在报告中写明实际设备型号、Android 版本和证据范围，不要只凭 serial 或车型名称宣称真机通过。`,
    ];
  }

  if (value.status === "mismatch") {
    return [
      `0.【设备与目标核对】系统刚刚读取绑定设备属性：${currentText}；目标车型/Android 型号线索：${targetText}。当前设备未匹配已登记的目标型号，不能把它当作目标车型真机。`,
      ...fallbackGuidanceLines(),
    ];
  }

  if (value.status === "offline") {
    return [
      `0.【设备与目标核对】绑定设备 ${value.serial || "未登记"} 当前离线、未授权、未连接或属性读取失败；目标车型/Android 型号线索：${targetText}。先恢复该设备连接并成功读取属性，不得沿用旧缓存宣称设备匹配。`,
      `- 当前没有可用于验收的已连接 Android 设备，本轮必须停止，且不得输出 VERIFY 结论；恢复连接后重新开始自我验收。`,
    ];
  }

  return [
    `0.【设备与目标核对】系统刚刚读取绑定设备属性：${currentText}；目标车型/Android 型号线索：${targetText}。当前缺少可靠的“业务车型 → Android 型号”登记或设备属性，暂时无法证明两者一致，不能把该设备描述为目标车型真机。`,
    `- 开始前先用 \`adb -s ${value.serial || "<serial>"} shell getprop ro.product.model\` 等命令复核实际型号；若仍不能匹配，按下面的兼容设备模拟范围验收。`,
    ...fallbackGuidanceLines(),
  ];
}
