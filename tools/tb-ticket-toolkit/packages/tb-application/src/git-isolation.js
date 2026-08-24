import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ToolkitError, normalizeTaskNo } from "../../tb-domain/src/index.js";

function git(args, { cwd, stdio = "pipe" } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio }).trim();
  } catch (error) {
    throw new ToolkitError("GIT_COMMAND_FAILED", `Git 命令失败：git ${args.join(" ")}`, {
      status: error?.status ?? null,
      stderr: String(error?.stderr || "").trim(),
    });
  }
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertSafeRepoPath(gitRoot, target) {
  const root = fs.realpathSync(gitRoot);
  const resolved = path.resolve(target);
  if (!pathInside(root, resolved)) throw new ToolkitError("TEMP_PATH_ESCAPE", "temp 目标路径越出 Git 根目录");
  const relative = path.relative(root, resolved);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) continue;
    const actual = fs.realpathSync(cursor);
    if (!pathInside(root, actual)) throw new ToolkitError("TEMP_PATH_ESCAPE", "temp 路径包含逃逸仓库的符号链接或目录联接");
  }
  return resolved;
}

export function resolveGitIsolation(repoPath) {
  const input = path.resolve(String(repoPath || process.cwd()));
  const gitRootOutput = git(["-C", input, "rev-parse", "--show-toplevel"]);
  const gitRoot = fs.realpathSync(path.resolve(gitRootOutput));
  const excludeOutput = git(["-C", gitRoot, "rev-parse", "--git-path", "info/exclude"]);
  const excludeFile = path.isAbsolute(excludeOutput)
    ? path.resolve(excludeOutput)
    : path.resolve(gitRoot, excludeOutput);
  return { gitRoot, excludeFile };
}

function trackedUnder(gitRoot, relativeDirectory) {
  const output = git(["-C", gitRoot, "ls-files", "--", `${relativeDirectory}/`]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function appendRuleIdempotently(excludeFile, rule) {
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const before = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
  const lines = before.split(/\r?\n/);
  if (lines.includes(rule)) return { added: false, before };
  const separator = before && !before.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludeFile, `${separator}${rule}\n`, "utf8");
  return { added: true, before };
}

function verifyIgnored(gitRoot, relativeDirectory) {
  try {
    execFileSync("git", ["-C", gitRoot, "check-ignore", "--no-index", "-q", `${relativeDirectory}/__tbfix_probe__`], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function prepareGitIsolation({ repoPath, taskNo }) {
  const safeTaskNo = normalizeTaskNo(taskNo);
  const { gitRoot, excludeFile } = resolveGitIsolation(repoPath);
  const relativeDirectory = `temp/${safeTaskNo}`;
  const tempDirectory = assertSafeRepoPath(gitRoot, path.join(gitRoot, "temp", safeTaskNo));
  const tracked = trackedUnder(gitRoot, relativeDirectory);
  if (tracked.length) {
    throw new ToolkitError("TEMP_PATH_ALREADY_TRACKED", "目标 temp 目录已有版本控制文件，禁止覆盖或自动删除", { tracked });
  }
  const ignoreRule = `/temp/${safeTaskNo}/`;
  const update = appendRuleIdempotently(excludeFile, ignoreRule);
  if (!verifyIgnored(gitRoot, relativeDirectory)) {
    if (update.added) fs.writeFileSync(excludeFile, update.before, "utf8");
    throw new ToolkitError("TEMP_IGNORE_NOT_EFFECTIVE", "Git info/exclude 精确规则未生效，禁止创建或下载附件");
  }
  fs.mkdirSync(tempDirectory, { recursive: true });
  assertSafeRepoPath(gitRoot, tempDirectory);
  return {
    gitRoot,
    excludeFile,
    ignoreRule,
    relativeDirectory,
    tempDirectory,
    verified: true,
  };
}
