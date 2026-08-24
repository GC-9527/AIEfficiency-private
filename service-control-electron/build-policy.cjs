"use strict";

const BUILD_TARGETS = Object.freeze([
  Object.freeze({
    id: "web",
    label: "网页",
    shortLabel: "WEB",
    description: "构建 web-dashboard 静态发布文件",
    defaultSelected: true,
  }),
  Object.freeze({
    id: "desktop",
    label: "桌面客户端",
    shortLabel: "APP",
    description: "构建网页并生成桌面安装包",
    defaultSelected: false,
  }),
  Object.freeze({
    id: "backend",
    label: "Gateway 后端",
    shortLabel: "API",
    description: "生成 Gateway 后端发布包",
    defaultSelected: false,
  }),
  Object.freeze({
    id: "service-control",
    label: "Service Control",
    shortLabel: "CTRL",
    description: "构建网页并生成服务控制安装包",
    defaultSelected: false,
  }),
  Object.freeze({
    id: "cloud",
    label: "云端部署包",
    shortLabel: "CLOUD",
    description: "组装云端部署所需的完整文件",
    defaultSelected: false,
  }),
]);

const BUILD_TARGET_IDS = new Set(BUILD_TARGETS.map((target) => target.id));

function defaultBuildTargets() {
  return BUILD_TARGETS.filter((target) => target.defaultSelected).map((target) => target.id);
}

function normalizeBuildTargets(targets) {
  if (!Array.isArray(targets)) return [];
  const requested = new Set(targets.map((target) => String(target || "").trim()).filter(Boolean));
  return BUILD_TARGETS.map((target) => target.id).filter((id) => requested.has(id));
}

function validateBuildTargets(targets) {
  if (!Array.isArray(targets)) throw new Error("请选择要编译的目标。");
  const submitted = targets.map((target) => String(target || "").trim()).filter(Boolean);
  const unknown = submitted.filter((target) => !BUILD_TARGET_IDS.has(target));
  if (unknown.length) throw new Error(`不支持的编译目标：${[...new Set(unknown)].join("、")}`);
  const normalized = normalizeBuildTargets(submitted);
  if (!normalized.length) throw new Error("请至少选择一个编译目标。");
  return normalized;
}

module.exports = {
  BUILD_TARGETS,
  defaultBuildTargets,
  normalizeBuildTargets,
  validateBuildTargets,
};
