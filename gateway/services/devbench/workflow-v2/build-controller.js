import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import * as defaultStore from "../store.js";
import { assertBuildFlavorCatalogBinding } from "./build-diff-gate.js";
import { canonicalSha256 } from "./envelope-store.js";

const BUILD_INPUT_KEYS = new Set(["storyId", "repositoryId", "rootId", "buildType"]);
const BUILD_TYPES = new Set(["debug", "release"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_GRADLE_TASK = /^(?::[A-Za-z0-9_.-]+)*:?[A-Za-z][A-Za-z0-9_]*$/;
const BUILD_EXECUTOR_ATTESTATION = "workflow-v2-confined-build-executor-v1";

export class WorkflowV2BuildControllerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2BuildControllerError";
    this.code = code;
    this.details = details;
  }
}

function text(value, max = 1000) {
  return Array.from(String(value ?? "").trim()).slice(0, max).join("");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function samePath(left, right) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function cleanRootId(value, fallback) {
  const selected = String(value || "").toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (selected || fallback).slice(0, 32).replace(/-+$/g, "") || fallback;
}

function repositoryEntries(tab, storyStore) {
  const refs = typeof storyStore.tabProjectPaths === "function"
    ? storyStore.tabProjectPaths(tab)
    : [];
  const managed = Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [];
  return refs.map((ref) => {
    const managedEntry = managed.find((entry) => samePath(
      entry?.path || entry?.worktreePath,
      ref?.path,
    ));
    const stableIdentity = text(
      ref?.repositoryId
      || ref?.baseProjectId
      || managedEntry?.repositoryId
      || managedEntry?.baseProjectId
      || (ref?.role === "primary" ? tab?.primaryProjectId : ""),
      160,
    );
    const pathIdentity = sha256(path.resolve(String(ref?.path || "")).toLowerCase()).slice(0, 12);
    const rootId = ref?.role === "primary"
      ? "main"
      : ref?.role === "webapp"
        ? "webapp"
        : cleanRootId(`related-${sha256(stableIdentity || pathIdentity).slice(0, 12)}`, `related-${pathIdentity}`);
    return {
      repositoryId: stableIdentity,
      rootId,
      path: String(ref?.path || ""),
      role: String(ref?.role || "related"),
    };
  });
}

function defaultHeadReader(repositoryPath) {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repositoryPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trim();
}

function cap(value) {
  const normalized = String(value || "");
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : "";
}

function defaultBuildTarget({ catalogInfo, storyFlavor, buildType, storyStore, repositoryPath }) {
  const expanded = typeof storyStore.expandAndroidBuildFlavors === "function"
    ? storyStore.expandAndroidBuildFlavors(repositoryPath, [storyFlavor])
    : [storyFlavor];
  const variants = [...new Set((Array.isArray(expanded) ? expanded : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (variants.length !== 1) {
    throw new WorkflowV2BuildControllerError(
      "可信 catalog 将故事 Flavor 展开为多个构建变体，缺少唯一 build target 配置",
      "WORKFLOW_V2_BUILD_TARGET_AMBIGUOUS",
      { variantCount: variants.length },
    );
  }
  const flavor = variants[0];
  const allowedVariants = Array.isArray(catalogInfo?.buildVariants)
    ? catalogInfo.buildVariants.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (allowedVariants.length && !allowedVariants.includes(flavor)) {
    throw new WorkflowV2BuildControllerError(
      "派生构建变体不在可信 catalog 中",
      "WORKFLOW_V2_BUILD_VARIANT_NOT_ALLOWED",
      { flavor },
    );
  }
  return { flavor, task: `assemble${cap(flavor)}${cap(buildType)}` };
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now() must return a valid date");
  return date.toISOString();
}

function normalizedVersion(value) {
  return {
    versionName: text(value?.versionName, 100) || null,
    versionCode: Number.isSafeInteger(Number(value?.versionCode)) ? Number(value.versionCode) : null,
  };
}

function inputIdentity(input = {}) {
  return {
    storyId: text(input?.storyId, 160),
    repositoryId: text(input?.repositoryId, 160),
    rootId: text(input?.rootId, 32),
    buildType: text(input?.buildType, 20),
  };
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkflowV2BuildControllerError("build_target 参数必须是对象", "WORKFLOW_V2_BUILD_INPUT_INVALID");
  }
  const extras = Object.keys(input).filter((key) => !BUILD_INPUT_KEYS.has(key));
  if (extras.length) {
    throw new WorkflowV2BuildControllerError(
      "build_target 不接受 flavor、task、命令或其它自由参数",
      "WORKFLOW_V2_BUILD_INPUT_FORBIDDEN_FIELD",
      { fields: extras.sort() },
    );
  }
  const identity = inputIdentity(input);
  for (const key of ["storyId", "repositoryId", "rootId"]) {
    if (!SAFE_ID.test(identity[key])) {
      throw new WorkflowV2BuildControllerError(`${key} 非法`, "WORKFLOW_V2_BUILD_INPUT_INVALID", { field: key });
    }
  }
  if (!BUILD_TYPES.has(identity.buildType)) {
    throw new WorkflowV2BuildControllerError(
      "buildType 只允许 debug/release",
      "WORKFLOW_V2_BUILD_TYPE_NOT_ALLOWED",
    );
  }
  return identity;
}

function blockedReceipt({ input, code, message, startedAt, finishedAt, selector = null }) {
  const identity = inputIdentity(input);
  const operationId = `build-${canonicalSha256({ identity, code, selector }).slice(0, 32)}`;
  return {
    schemaVersion: "evidence-receipt-v2",
    receiptId: `gateway-build-${canonicalSha256({ operationId, code }).slice(0, 32)}`,
    action: "BUILD",
    status: "BLOCKED",
    startedAt,
    finishedAt,
    toolName: "build_target",
    operationId,
    idempotencyKey: operationId,
    rootId: identity.rootId || null,
    selector,
    exitCode: null,
    outputRef: null,
    sha256: null,
    summary: text(message, 2000),
    error: text(`${code}: ${message}`, 2000),
  };
}

function safeArtifact(root, artifactPath) {
  const raw = text(artifactPath, 4000);
  if (!raw || !path.isAbsolute(raw)) {
    throw new WorkflowV2BuildControllerError("构建执行器未返回绝对产物路径", "WORKFLOW_V2_BUILD_ARTIFACT_INVALID");
  }
  const rootReal = realpathSync(root);
  const artifactLstat = lstatSync(raw);
  if (artifactLstat.isSymbolicLink() || !artifactLstat.isFile()) {
    throw new WorkflowV2BuildControllerError("构建产物不是普通文件", "WORKFLOW_V2_BUILD_ARTIFACT_INVALID");
  }
  const artifactReal = realpathSync(raw);
  const relative = path.relative(rootReal, artifactReal);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkflowV2BuildControllerError("构建产物越出故事仓库 root", "WORKFLOW_V2_BUILD_ARTIFACT_OUTSIDE_ROOT");
  }
  const stat = statSync(artifactReal);
  return {
    absolutePath: artifactReal,
    relativePath: relative.replace(/\\/g, "/"),
    sha256: sha256File(artifactReal),
    sizeBytes: stat.size,
  };
}

function targetSignature(target) {
  return canonicalSha256({
    storyId: target.storyId,
    repositoryId: target.repositoryId,
    rootId: target.rootId,
    repositoryPathSha256: target.repositoryPathSha256,
    storyFlavor: target.storyFlavor,
    flavor: target.flavor,
    buildType: target.buildType,
    task: target.task,
    head: target.head,
    version: target.version,
  });
}

/**
 * Gateway-owned Build Controller.  The public execute method accepts exactly
 * story/repository/root/buildType.  Flavor and Gradle task are always resolved
 * from the live story and a trusted project catalog.  With no attested broker
 * configured, production returns an auditable BLOCKED receipt and performs no
 * process execution.
 */
export function createWorkflowV2BuildController({
  storyStore = defaultStore,
  executorBroker = null,
  readHead = defaultHeadReader,
  resolveBuildTarget = null,
  now = () => new Date(),
} = {}) {
  async function prepare(identity) {
    const tab = storyStore.getTab(identity.storyId);
    if (!tab) {
      throw new WorkflowV2BuildControllerError("故事点不存在", "WORKFLOW_V2_BUILD_STORY_NOT_FOUND");
    }
    const repositories = repositoryEntries(tab, storyStore);
    const matches = repositories.filter((entry) => (
      entry.repositoryId === identity.repositoryId && entry.rootId === identity.rootId
    ));
    if (matches.length !== 1) {
      throw new WorkflowV2BuildControllerError(
        "仓库/root 不属于该故事点或身份不唯一",
        "WORKFLOW_V2_BUILD_ROOT_BINDING_MISMATCH",
      );
    }
    const repository = matches[0];
    let repositoryPath;
    try {
      repositoryPath = realpathSync(repository.path);
      if (!statSync(repositoryPath).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new WorkflowV2BuildControllerError("故事仓库 root 不可用", "WORKFLOW_V2_BUILD_ROOT_UNAVAILABLE");
    }
    const catalogInfo = storyStore.getAndroidFlavors(repositoryPath);
    const selected = typeof storyStore.getTabFlavor === "function"
      ? storyStore.getTabFlavor(tab, repositoryPath)
      : null;
    const fallbackFlavor = repository.role === "primary"
      ? (tab.flavor || tab.targetFlavor || "")
      : "";
    const binding = assertBuildFlavorCatalogBinding({
      flavor: selected || fallbackFlavor,
      catalog: catalogInfo?.flavors,
    });
    const target = resolveBuildTarget
      ? await resolveBuildTarget({
        tab,
        repository: { ...repository, path: repositoryPath },
        catalogInfo,
        storyFlavor: binding.flavor,
        buildType: identity.buildType,
      })
      : defaultBuildTarget({
        catalogInfo,
        storyFlavor: binding.flavor,
        buildType: identity.buildType,
        storyStore,
        repositoryPath,
      });
    const flavor = text(target?.flavor, 100);
    const task = text(target?.task, 160);
    if (!flavor || !SAFE_GRADLE_TASK.test(task)) {
      throw new WorkflowV2BuildControllerError("可信构建目录生成了非法 task", "WORKFLOW_V2_BUILD_TASK_INVALID");
    }
    const expanded = typeof storyStore.expandAndroidBuildFlavors === "function"
      ? storyStore.expandAndroidBuildFlavors(repositoryPath, [binding.flavor])
      : [binding.flavor];
    if (!(Array.isArray(expanded) ? expanded : []).map(String).includes(flavor)) {
      throw new WorkflowV2BuildControllerError("构建 task 指向其它 Flavor", "WORKFLOW_V2_BUILD_TASK_FLAVOR_MISMATCH");
    }
    const version = normalizedVersion(storyStore.readProjectVersion(repositoryPath, binding.flavor));
    if (!version.versionName && version.versionCode === null) {
      throw new WorkflowV2BuildControllerError("无法回读目标 Flavor 版本", "WORKFLOW_V2_BUILD_VERSION_UNAVAILABLE");
    }
    const head = text(await readHead(repositoryPath), 64).toLowerCase();
    if (!/^[a-f0-9]{40,64}$/.test(head)) {
      throw new WorkflowV2BuildControllerError("无法回读仓库 HEAD", "WORKFLOW_V2_BUILD_HEAD_UNAVAILABLE");
    }
    return {
      ...identity,
      repositoryPath,
      repositoryPathSha256: sha256(repositoryPath.toLowerCase()),
      storyFlavor: binding.flavor,
      flavor,
      task,
      version,
      head,
    };
  }

  return Object.freeze({
    async execute(input = {}) {
      const startedAt = timestamp(now);
      let identity = inputIdentity(input);
      let target = null;
      try {
        identity = validateInput(input);
        target = await prepare(identity);
        if (!executorBroker || typeof executorBroker.attest !== "function" || typeof executorBroker.execute !== "function") {
          throw new WorkflowV2BuildControllerError(
            "未配置受证明的隔离构建执行器",
            "WORKFLOW_V2_BUILD_CONFINED_EXECUTOR_UNAVAILABLE",
          );
        }
        const attestation = await executorBroker.attest({
          storyId: target.storyId,
          repositoryId: target.repositoryId,
          rootId: target.rootId,
          repositoryPath: target.repositoryPath,
        });
        if (attestation?.ok !== true
          || attestation?.kind !== BUILD_EXECUTOR_ATTESTATION
          || attestation?.rootId !== target.rootId
          || attestation?.repositoryId !== target.repositoryId) {
          throw new WorkflowV2BuildControllerError(
            "构建执行器未通过 root 级隔离证明",
            "WORKFLOW_V2_BUILD_EXECUTOR_ATTESTATION_INVALID",
          );
        }
        const fresh = await prepare(identity);
        if (targetSignature(fresh) !== targetSignature(target)) {
          throw new WorkflowV2BuildControllerError(
            "执行前故事/仓库/Flavor/HEAD/版本发生漂移",
            "WORKFLOW_V2_BUILD_TARGET_STALE",
          );
        }
        const executionStartedAt = timestamp(now);
        let result;
        try {
          result = await executorBroker.execute(Object.freeze({
            storyId: target.storyId,
            repositoryId: target.repositoryId,
            rootId: target.rootId,
            repositoryPath: target.repositoryPath,
            storyFlavor: target.storyFlavor,
            flavor: target.flavor,
            buildType: target.buildType,
            task: target.task,
            head: target.head,
            version: Object.freeze({ ...target.version }),
          }));
        } catch (error) {
          result = { exitCode: null, error: error?.message || String(error) };
        }
        const finishedAt = timestamp(now);
        const operationId = `build-${canonicalSha256({
          storyId: target.storyId,
          repositoryId: target.repositoryId,
          rootId: target.rootId,
          head: target.head,
          task: target.task,
          buildType: target.buildType,
        }).slice(0, 32)}`;
        const selectorBase = {
          storyId: target.storyId,
          repositoryId: target.repositoryId,
          rootId: target.rootId,
          storyFlavor: target.storyFlavor,
          flavor: target.flavor,
          buildType: target.buildType,
          task: target.task,
          head: target.head,
          version: target.version,
        };
        const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
        if (exitCode !== 0) {
          return {
            ok: false,
            status: "FAIL",
            code: "WORKFLOW_V2_BUILD_EXECUTION_FAILED",
            receipt: {
              schemaVersion: "evidence-receipt-v2",
              receiptId: `gateway-build-${canonicalSha256({ operationId, status: "FAIL" }).slice(0, 32)}`,
              action: "BUILD",
              status: "FAIL",
              startedAt: executionStartedAt,
              finishedAt,
              toolName: "build_target",
              operationId,
              idempotencyKey: operationId,
              rootId: target.rootId,
              selector: selectorBase,
              exitCode,
              outputRef: null,
              sha256: null,
              summary: "受控构建执行失败",
              error: text(result?.error || "build executor returned a non-zero exit code", 2000),
            },
          };
        }
        const post = await prepare(identity);
        if (targetSignature(post) !== targetSignature(target)) {
          throw new WorkflowV2BuildControllerError(
            "构建期间故事/仓库/Flavor/HEAD/版本发生漂移",
            "WORKFLOW_V2_BUILD_TARGET_DRIFT",
          );
        }
        const artifact = safeArtifact(target.repositoryPath, result?.artifactPath);
        const provenance = result?.provenance || {};
        const expectedProvenance = {
          head: target.head,
          task: target.task,
          flavor: target.flavor,
          buildType: target.buildType,
          versionName: target.version.versionName,
          versionCode: target.version.versionCode,
          artifactSha256: artifact.sha256,
        };
        if (canonicalSha256(provenance) !== canonicalSha256(expectedProvenance)) {
          throw new WorkflowV2BuildControllerError(
            "执行器产物 provenance 与独立回读不一致",
            "WORKFLOW_V2_BUILD_PROVENANCE_MISMATCH",
          );
        }
        const outputRef = `root://${target.rootId}/${artifact.relativePath}`;
        const receipt = {
          schemaVersion: "evidence-receipt-v2",
          receiptId: `gateway-build-${canonicalSha256({ operationId, artifact: artifact.sha256 }).slice(0, 32)}`,
          action: "BUILD",
          status: "PASS",
          startedAt: executionStartedAt,
          finishedAt,
          toolName: "build_target",
          operationId,
          idempotencyKey: operationId,
          rootId: target.rootId,
          selector: {
            ...selectorBase,
            artifact: {
              outputRef,
              sha256: artifact.sha256,
              sizeBytes: artifact.sizeBytes,
            },
          },
          exitCode: 0,
          outputRef,
          sha256: artifact.sha256,
          summary: `受控构建通过：${target.task}`,
          error: null,
        };
        return { ok: true, status: "PASS", receipt };
      } catch (error) {
        const code = text(error?.code, 160) || "WORKFLOW_V2_BUILD_BLOCKED";
        const message = text(error?.message || error, 1800) || "构建被安全阻断";
        const finishedAt = timestamp(now);
        const selector = target ? {
          storyId: target.storyId,
          repositoryId: target.repositoryId,
          rootId: target.rootId,
          storyFlavor: target.storyFlavor,
          flavor: target.flavor,
          buildType: target.buildType,
          task: target.task,
          head: target.head,
          version: target.version,
        } : null;
        return {
          ok: false,
          status: "BLOCKED",
          code,
          receipt: blockedReceipt({ input: identity, code, message, startedAt, finishedAt, selector }),
        };
      }
    },
  });
}

export const WORKFLOW_V2_BUILD_EXECUTOR_ATTESTATION = BUILD_EXECUTOR_ATTESTATION;
export const __test = {
  defaultBuildTarget,
  repositoryEntries,
  safeArtifact,
  targetSignature,
};
