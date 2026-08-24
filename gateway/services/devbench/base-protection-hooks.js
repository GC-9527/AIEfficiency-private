import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_ENV,
  HOOK_NAMES,
  LEGACY_HOOK_MARKER,
  MANAGED_DIRNAME,
  diagnoseManagedHooks,
  guardManagedHook,
  installManagedHooks,
  managedInstallationPaths,
  resolveRepository,
  sha256,
  uninstallManagedHooks,
  uninstallPreview,
} from "./base-protection-runtime/core.mjs";

const runtimeDirectory = fileURLToPath(new URL("./base-protection-runtime/", import.meta.url));
const runtimeAssets = Object.freeze({
  core: path.join(runtimeDirectory, "core.mjs"),
  manage: path.join(runtimeDirectory, "manage.mjs"),
});

let injectedCapabilityIssuer = null;
let injectedCapabilityValidator = null;

/**
 * 注入 Controller 能力提供器。
 *
 * issuer/validator 只接受函数，且不会序列化到仓库。独立 hook 进程使用安装
 * manifest 中的 command/module validator descriptor；没有可达 validator 时
 * guard 必须失败关闭。
 */
export function configureBaseProtectionCapabilities({ issuer = null, validator = null } = {}) {
  if (issuer != null && typeof issuer !== "function") {
    throw new TypeError("capability issuer 必须是函数");
  }
  if (validator != null && typeof validator !== "function") {
    throw new TypeError("capability validator 必须是函数");
  }
  injectedCapabilityIssuer = issuer;
  injectedCapabilityValidator = validator;
  return {
    issuerConfigured: typeof injectedCapabilityIssuer === "function",
    validatorConfigured: typeof injectedCapabilityValidator === "function",
  };
}

export async function issueBaseProtectionCapability(context, { issuer } = {}) {
  const selected = issuer || injectedCapabilityIssuer;
  if (typeof selected !== "function") {
    const error = new Error("Git Controller capability issuer 不可用");
    error.code = "BASE_PROTECTION_ISSUER_UNAVAILABLE";
    throw error;
  }
  const value = await selected({ ...context });
  if (!value || (typeof value !== "string" && typeof value !== "object")) {
    const error = new Error("Git Controller capability issuer 返回了无效凭证");
    error.code = "BASE_PROTECTION_CAPABILITY_INVALID";
    throw error;
  }
  return value;
}

export async function validateBaseProtectionCapability(context, { validator } = {}) {
  const selected = validator || injectedCapabilityValidator;
  if (typeof selected !== "function") {
    return { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
  }
  try {
    const result = await selected({ ...context });
    if (typeof result === "object" && result) {
      return {
        ok: result.ok === true,
        reason: String(result.reason || (result.ok ? "CAPABILITY_VALID" : "CAPABILITY_REJECTED")),
      };
    }
    return {
      ok: result === true,
      reason: result === true ? "CAPABILITY_VALID" : "CAPABILITY_REJECTED",
    };
  } catch {
    return { ok: false, reason: "CONTROLLER_UNAVAILABLE" };
  }
}

function normalizedInstallOptions(options = {}) {
  const descriptor = options.capabilityValidatorDescriptor
    || (options.capabilityValidator && typeof options.capabilityValidator === "object"
      ? options.capabilityValidator
      : null);
  if (typeof options.capabilityValidator === "function") {
    injectedCapabilityValidator = options.capabilityValidator;
  }
  if (typeof options.capabilityIssuer === "function") {
    injectedCapabilityIssuer = options.capabilityIssuer;
  }
  return {
    ...options,
    capabilityValidatorDescriptor: descriptor,
    runtimeAssets,
  };
}

/**
 * 安装 manifest 驱动的受管 hooks。
 *
 * 兼容旧调用形式 installBaseProtectionHooks(repoPath)，但返回值新增 status、
 * managedRoot、manifestPath 等字段。安装失败不抛出半完成状态，而返回
 * status=DEGRADED；guard 在非 ACTIVE 状态下一律拒绝。
 */
export function installBaseProtectionHooks(baseRepoPath, options = {}) {
  return installManagedHooks(baseRepoPath, normalizedInstallOptions(options));
}

export function previewUninstallBaseProtectionHooks(baseRepoPath, options = {}) {
  return uninstallPreview(baseRepoPath, options);
}

/**
 * 兼容旧导出名。只解除 DevBench hooks 层；不会删除仓库、worktree、mirror、
 * refs、提交、stash、用户文件或操作系统隔离。
 */
export function uninstallBaseProtectionHooks(baseRepoPath, options = {}) {
  return uninstallManagedHooks(baseRepoPath, options);
}

export function diagnoseBaseProtectionHooks(baseRepoPath, options = {}) {
  return diagnoseManagedHooks(baseRepoPath, options);
}

export async function guardBaseProtectionHook(baseRepoPath, invocation = {}, options = {}) {
  let managedRoot;
  try {
    managedRoot = managedInstallationPaths(baseRepoPath).root;
  } catch (error) {
    return { ok: false, reason: error.code || "REPOSITORY_UNAVAILABLE" };
  }
  const validator = options.capabilityValidator || injectedCapabilityValidator;
  return guardManagedHook(managedRoot, {
    ...invocation,
    invocationRepositoryPath: invocation.repositoryPath || invocation.cwd || "",
    capabilityValidator: validator || null,
  });
}

/**
 * 兼容旧 listBaseProtectionHooks 结构，同时暴露受管状态。
 */
export function listBaseProtectionHooks(baseRepoPath) {
  try {
    const paths = managedInstallationPaths(baseRepoPath);
    const diagnosis = diagnoseManagedHooks(baseRepoPath, {
      ignoreActivity: true,
      skipAuditProbe: true,
    });
    const installed = [];
    const ours = [];
    for (const name of HOOK_NAMES) {
      const dispatcher = path.join(paths.hooks, name);
      if (diagnosis.status === "ACTIVE") {
        installed.push(name);
        ours.push(name);
      } else if (diagnosis.issues?.some((issue) => issue === `DISPATCHER_HASH_DRIFT:${name}`)) {
        installed.push(name);
      }
    }
    return {
      hooksDir: paths.hooks,
      managedRoot: paths.root,
      status: diagnosis.status,
      issues: diagnosis.issues || [],
      installed,
      ours,
    };
  } catch (error) {
    return {
      hooksDir: "",
      managedRoot: "",
      status: "NOT_INSTALLED",
      issues: [String(error.code || "REPOSITORY_UNAVAILABLE")],
      installed: [],
      ours: [],
    };
  }
}

export const __test = Object.freeze({
  CAPABILITY_ENV,
  HOOK_MARKER: LEGACY_HOOK_MARKER,
  HOOK_NAMES,
  MANAGED_DIRNAME,
  runtimeAssets,
  resolveRepository,
  sha256,
});
