import path from "path";

/**
 * 为 Gateway 发起的单仓 Git 命令补充精确的 safe.directory。
 *
 * Windows 上服务可能由管理员创建 worktree，随后由普通用户接管 Gateway。
 * Git 会把这种仓库判为 dubious ownership。这里只对当前命令、当前绝对路径
 * 临时放行，不写全局配置，也不使用 safe.directory=*。
 */
export function repositoryGitArgs(repoPath, args = [], { quotePath = false } = {}) {
  const absolutePath = path.resolve(String(repoPath || ""));
  const safeDirectory = absolutePath.replace(/\\/g, "/");
  return [
    "-c",
    `safe.directory=${safeDirectory}`,
    "-C",
    absolutePath,
    ...(quotePath ? ["-c", "core.quotePath=false"] : []),
    ...args,
  ];
}
