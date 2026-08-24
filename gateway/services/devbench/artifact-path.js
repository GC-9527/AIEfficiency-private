import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const INSTALL_PACKAGE_EXTENSION = /\.(?:apk|apks|aab|xapk|hap)$/i;

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function uniqueRoots(roots) {
  const seen = new Set();
  const result = [];
  for (const value of roots || []) {
    const root = String(value || "").trim();
    if (!root) continue;
    const resolved = path.resolve(root);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

export function normalizeInstallPackageReference(value) {
  let reference = String(value || "").trim();
  const wrappers = [
    ["`", "`"],
    ['"', '"'],
    ["'", "'"],
    ["<", ">"],
  ];
  for (const [start, end] of wrappers) {
    if (reference.startsWith(start) && reference.endsWith(end)) {
      reference = reference.slice(start.length, -end.length).trim();
      break;
    }
  }
  return reference.replace(/[，。；;,]+$/g, "").trim();
}

function existingPlainFile(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(candidate);
  if (!pathInside(resolvedRoot, resolvedFile)) return null;

  let stat;
  try {
    stat = fs.lstatSync(resolvedFile);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;

  try {
    const realRoot = fs.realpathSync.native(resolvedRoot);
    const realFile = fs.realpathSync.native(resolvedFile);
    if (!pathInside(realRoot, realFile)) return null;
  } catch {
    return null;
  }
  return resolvedFile;
}

/**
 * 把 AI 回复里的安装包路径解析到当前故事点的 StoryDev 或工程 worktree。
 * 相对 tempFiles/reports 路径优先按 StoryDev 根目录解释，其它相对路径优先按工程解释。
 */
export function resolveInstallPackageReference(referenceValue, {
  storyDirectory = "",
  projectRoots = [],
} = {}) {
  const reference = normalizeInstallPackageReference(referenceValue);
  if (!reference) return { ok: false, status: 400, code: "ARTIFACT_PATH_REQUIRED", error: "安装包路径不能为空" };
  if (!INSTALL_PACKAGE_EXTENSION.test(reference)) {
    return { ok: false, status: 400, code: "ARTIFACT_TYPE_UNSUPPORTED", error: "只允许定位安装包文件" };
  }

  const normalizedSegments = reference
    .replace(/^storydev:\//i, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (normalizedSegments.some((segment) => segment === "..")) {
    return { ok: false, status: 403, code: "ARTIFACT_PATH_OUTSIDE", error: "安装包路径超出当前故事点范围" };
  }

  const storyRoot = storyDirectory ? path.resolve(storyDirectory) : "";
  const projects = uniqueRoots(projectRoots);
  const allowedRoots = uniqueRoots([storyRoot, ...projects]);
  if (!allowedRoots.length) {
    return { ok: false, status: 400, code: "ARTIFACT_ROOT_MISSING", error: "当前故事点没有可用的本地目录" };
  }

  const candidates = [];
  const addCandidate = (root, relativeOrAbsolute, source) => {
    if (!root) return;
    const candidate = path.isAbsolute(relativeOrAbsolute)
      ? path.resolve(relativeOrAbsolute)
      : path.resolve(root, relativeOrAbsolute);
    if (!pathInside(root, candidate)) return;
    candidates.push({ root, candidate, source });
  };

  if (/^storydev:\//i.test(reference)) {
    addCandidate(storyRoot, reference.replace(/^storydev:\/*/i, ""), "storydev");
  } else if (path.isAbsolute(reference) || /^[A-Za-z]:[\\/]/.test(reference) || /^\\\\/.test(reference)) {
    const absolute = path.resolve(reference);
    const owner = allowedRoots.find((root) => pathInside(root, absolute));
    if (!owner) {
      return { ok: false, status: 403, code: "ARTIFACT_PATH_OUTSIDE", error: "安装包路径不属于当前故事点" };
    }
    addCandidate(owner, absolute, owner === storyRoot ? "storydev" : "project");
  } else {
    const relative = reference.replace(/^(?:\.[\\/])+/, "");
    const storyFirst = /^(?:tempFiles|reports|archives|ask)[\\/]/i.test(relative);
    const orderedRoots = storyFirst
      ? [{ root: storyRoot, source: "storydev" }, ...projects.map((root) => ({ root, source: "project" }))]
      : [...projects.map((root) => ({ root, source: "project" })), { root: storyRoot, source: "storydev" }];
    for (const item of orderedRoots) addCandidate(item.root, relative, item.source);
  }

  for (const item of candidates) {
    const file = existingPlainFile(item.root, item.candidate);
    if (!file) continue;
    return {
      ok: true,
      file,
      name: path.basename(file),
      source: item.source,
      reference,
    };
  }

  return {
    ok: false,
    status: 404,
    code: "ARTIFACT_NOT_FOUND",
    error: `安装包不存在：${reference}`,
  };
}

export function revealFileInManager(target, {
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    const file = path.resolve(String(target || ""));
    let opener;
    let args;
    if (platform === "win32") {
      opener = "explorer.exe";
      args = [`/select,${file.replace(/\//g, "\\")}`];
    } else if (platform === "darwin") {
      opener = "open";
      args = ["-R", file];
    } else {
      opener = "xdg-open";
      args = [path.dirname(file)];
    }

    let child;
    try {
      child = spawnImpl(opener, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: platform !== "win32",
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("spawn", () => finish({ ok: true, opener }));
    child.unref?.();
  });
}
