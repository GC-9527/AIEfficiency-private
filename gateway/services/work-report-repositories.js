/**
 * 工作报告 Git 数据源：以 devbench「仓库定义」为唯一仓库清单，
 * 再从本机登记工程/checkout 中解析可用源码路径。
 */
import { execFile, execFileSync } from "child_process";
import { existsSync } from "fs";
import {
  configuredOutboundM2MToken,
  isTrustedPeerOrigin,
  normalizeHttpOrigin,
} from "./m2m-auth.js";

function pathKey(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function repositoryRemoteKey(remoteUrl) {
  const raw = String(remoteUrl || "").trim().replace(/[?#].*$/, "");
  if (!raw) return "";
  let host = "", repoPath = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      host = `${parsed.hostname || ""}${parsed.port ? `:${parsed.port}` : ""}`;
      repoPath = parsed.pathname || "";
    } catch {
      return "";
    }
  } else {
    const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) {
      host = scp[1];
      repoPath = scp[2];
    } else {
      return raw.replace(/\\/g, "/").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
    }
  }
  const cleanPath = repoPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return host && cleanPath ? `${host.toLowerCase()}/${cleanPath.toLowerCase()}` : "";
}

function uniqueNames(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

/**
 * 解析工作报告需要采集的仓库。
 *
 * 同一 Git 远程允许存在多个逻辑仓库定义（例如应用工程与 SDK 模块），
 * 采集时按远程合并，并保留全部定义名，防止同一提交被重复统计。
 */
export function resolveWorkReportRepositories({
  projectDefs = [],
  localProjects = [],
  localCheckoutsByRepository = {},
  remoteUrlForPath = () => "",
  pathExists = existsSync,
} = {}) {
  const defs = (Array.isArray(projectDefs) ? projectDefs : [])
    .filter((def) => def && String(def.id || "").trim())
    .map((def) => ({
      ...def,
      id: String(def.id).trim(),
      name: String(def.name || def.id).trim(),
      remoteKey: repositoryRemoteKey(def.ssh || def.https),
    }));

  const groups = new Map();
  for (const def of defs) {
    const key = def.remoteKey || `definition:${def.id.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, remoteKey: def.remoteKey, definitions: [] });
    groups.get(key).definitions.push(def);
  }

  const candidates = [];
  const appendCandidate = ({ repoPath, name, linkedRepositoryId = "", source = "local-project" }) => {
    const value = String(repoPath || "").trim();
    if (!value || !pathExists(value)) return;
    candidates.push({
      path: value,
      name: String(name || value).trim(),
      linkedRepositoryId: String(linkedRepositoryId || "").trim(),
      remoteKey: repositoryRemoteKey(remoteUrlForPath(value)),
      source,
    });
  };

  for (const project of Array.isArray(localProjects) ? localProjects : []) {
    if (!project || project.exists === false) continue;
    appendCandidate({ repoPath: project.path, name: project.name, linkedRepositoryId: project.id });
    appendCandidate({ repoPath: project.webAppPath, name: `${project.name || project.id || "工程"}/WebApp`, source: "local-webapp" });
  }
  for (const def of defs) {
    const checkouts = Array.isArray(localCheckoutsByRepository[def.id])
      ? localCheckoutsByRepository[def.id]
      : [];
    for (const checkout of checkouts) {
      appendCandidate({
        repoPath: checkout?.path,
        name: checkout?.name || def.name,
        linkedRepositoryId: def.id,
        source: checkout?.source || "checkout",
      });
    }
  }

  return [...groups.values()].map((group) => {
    const definitionIds = new Set(group.definitions.map((def) => def.id));
    const seenPaths = new Set();
    const paths = [];
    for (const candidate of candidates) {
      const linked = definitionIds.has(candidate.linkedRepositoryId);
      const remoteMatched = !!group.remoteKey && candidate.remoteKey === group.remoteKey;
      // 仓库定义存在远程地址时必须以真实 Git remote 为准；本机 checkout 的关联 ID
      // 只能帮助无远程定义定位路径，不能让误登记/路径替换后的其它仓库混入报告。
      if (group.remoteKey ? !remoteMatched : !linked) continue;
      const key = pathKey(candidate.path);
      if (!key || seenPaths.has(key)) continue;
      seenPaths.add(key);
      paths.push({
        path: candidate.path,
        name: candidate.name,
        source: candidate.source,
      });
    }
    const definitionNames = uniqueNames(group.definitions.map((def) => def.name));
    const remote = group.definitions.find((def) => def.ssh || def.https);
    return {
      id: group.definitions[0].id,
      key: group.key,
      name: definitionNames.join(" / "),
      definitionIds: group.definitions.map((def) => def.id),
      definitionNames,
      remote: remote?.ssh || remote?.https || "",
      paths,
      hasLocal: paths.length > 0,
    };
  });
}

export function getDefinedWorkReportRepositories(store, options = {}) {
  const projectDefs = Array.isArray(options.projectDefs) ? options.projectDefs : store.getProjectDefs();
  const localCheckoutsByRepository = Object.fromEntries(
    projectDefs.map((def) => [def.id, store.getLocalCheckouts(def.id)]),
  );
  return resolveWorkReportRepositories({
    projectDefs,
    localProjects: store.listProjects(),
    localCheckoutsByRepository,
    remoteUrlForPath: (repoPath) => store.gitRemoteUrl(repoPath),
    ...options,
    projectDefs,
  });
}

/**
 * 获取当前角色的权威仓库定义：standalone/server 本机权威；node 以中心服务端为准。
 * node 不允许静默回退本地种子，否则报告会采集错误的仓库范围。
 */
export async function getAuthoritativeWorkReportRepositories(store, config = {}, fetchImpl = fetch, options = {}) {
  const role = String(process.env.ROLE || config.role || "standalone").trim().toLowerCase();
  let projectDefs;
  if (role === "node") {
    const base = normalizeHttpOrigin(config.claudeProxyClient?.host);
    if (!base || !isTrustedPeerOrigin(base, config)) {
      throw new Error("node 中心服务端不是管理员明确登记的可信 peer，无法读取权威仓库定义");
    }
    const token = configuredOutboundM2MToken(config);
    if (!token) throw new Error("node 未配置独立的中心 M2M 出站口令，无法读取权威仓库定义");
    let response;
    try {
      response = await fetchImpl(`${base}/api/devbench/project-defs`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
      });
    } catch (error) {
      throw new Error(`中心服务端不可达，无法读取权威仓库定义：${error.message}`);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || !Array.isArray(payload.data)) {
      throw new Error(payload.error || `中心仓库定义读取失败（HTTP ${response.status}）`);
    }
    projectDefs = payload.data;
  } else {
    projectDefs = store.getProjectDefs();
  }
  return getDefinedWorkReportRepositories(store, { ...options, projectDefs });
}

function parseStats(stats) {
  const text = String(stats || "");
  return {
    files: Number((text.match(/(\d+) files? changed/) || [])[1] || 0),
    insertions: Number((text.match(/(\d+) insertions?/) || [])[1] || 0),
    deletions: Number((text.match(/(\d+) deletions?/) || [])[1] || 0),
  };
}

function gitLogArgs(since, until, author) {
  const args = [
    "log",
    "--all",
    `--after=${since} 00:00:00`,
    `--before=${until} 23:59:59`,
    "--date=short",
    "--pretty=format:%x1e%H%x1f%h%x1f%ad%x1f%an%x1f%s",
    "--shortstat",
  ];
  if (author) args.splice(2, 0, `--author=${author}`);
  return args;
}

function parseGitLog(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];

  const commits = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.indexOf("\u001e");
    if (marker >= 0) {
      const [id, hash, date, commitAuthor, ...message] = line.slice(marker + 1).split("\u001f");
      current = { id, hash, date, author: commitAuthor, message: message.join("\u001f"), stats: "" };
      commits.push(current);
      continue;
    }
    const trimmed = line.trim();
    if (current && /\d+ files? changed|\d+ insertions?|\d+ deletions?/.test(trimmed)) current.stats = trimmed;
  }
  return commits;
}

function collectPathCommits(repoPath, since, until, author) {
  const raw = execFileSync("git", gitLogArgs(since, until, author), {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseGitLog(raw);
}

function collectPathCommitsAsync(repoPath, since, until, author) {
  return new Promise((resolve, reject) => {
    execFile("git", gitLogArgs(since, until, author), {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(parseGitLog(stdout));
    });
  });
}

/** 采集按仓库定义分组后的 Git 提交；同仓库多份本地源码按完整 commit hash 去重。 */
export function collectGitData(repositories, since, until, { author = "" } = {}) {
  return (Array.isArray(repositories) ? repositories : []).map((repo) => {
    const commitsById = new Map();
    const sourcePaths = [];
    const errors = [];
    for (const source of Array.isArray(repo.paths) ? repo.paths : []) {
      const repoPath = String(source?.path || source || "").trim();
      if (!repoPath || !existsSync(repoPath)) continue;
      try {
        for (const commit of collectPathCommits(repoPath, since, until, author)) {
          if (commit.id && !commitsById.has(commit.id)) commitsById.set(commit.id, commit);
        }
        sourcePaths.push(repoPath);
      } catch (error) {
        errors.push(`${repoPath}: ${String(error?.message || error).slice(0, 160)}`);
      }
    }
    const commits = [...commitsById.values()].sort((left, right) => (
      String(right.date).localeCompare(String(left.date)) || String(left.hash).localeCompare(String(right.hash))
    ));
    const total = commits.reduce((sum, commit) => {
      const stats = parseStats(commit.stats);
      sum.files += stats.files;
      sum.insertions += stats.insertions;
      sum.deletions += stats.deletions;
      return sum;
    }, { commits: commits.length, files: 0, insertions: 0, deletions: 0 });
    return {
      ...repo,
      commits,
      total,
      sourcePaths,
      ...(sourcePaths.length ? {} : { error: errors[0] || "本机未找到与仓库定义匹配的源码" }),
      ...(errors.length && sourcePaths.length ? { warnings: errors } : {}),
    };
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return output;
}

/**
 * 工作总结专用的异步 Git 采集。
 *
 * 与 collectGitData 返回同一结构，但最多并行执行 4 个本地 git log，
 * 避免配置仓库较多时按 15 秒超时逐仓库串行等待。
 */
export async function collectGitDataAsync(repositories, since, until, { author = "", concurrency = 4 } = {}) {
  const repos = Array.isArray(repositories) ? repositories : [];
  const jobs = repos.flatMap((repo, repoIndex) => (
    (Array.isArray(repo.paths) ? repo.paths : [])
      .map((source) => String(source?.path || source || "").trim())
      .filter((repoPath) => repoPath && existsSync(repoPath))
      .map((repoPath) => ({ repoIndex, repoPath }))
  ));
  const completed = await mapWithConcurrency(jobs, Math.max(1, Number(concurrency) || 1), async (job) => {
    const { repoIndex, repoPath } = job;
    try {
      return { repoIndex, repoPath, commits: await collectPathCommitsAsync(repoPath, since, until, author), error: null };
    } catch (error) {
      return { repoIndex, repoPath, commits: [], error };
    }
  });

  return repos.map((repo, repoIndex) => {
    const results = completed.filter((result) => result.repoIndex === repoIndex);
    const commitsById = new Map();
    const sourcePaths = [];
    const errors = [];
    for (const result of results) {
      if (result.error) {
        errors.push(`${result.repoPath}: ${String(result.error?.message || result.error).slice(0, 160)}`);
        continue;
      }
      for (const commit of result.commits) {
        if (commit.id && !commitsById.has(commit.id)) commitsById.set(commit.id, commit);
      }
      sourcePaths.push(result.repoPath);
    }
    const commits = [...commitsById.values()].sort((left, right) => (
      String(right.date).localeCompare(String(left.date)) || String(left.hash).localeCompare(String(right.hash))
    ));
    const total = commits.reduce((sum, commit) => {
      const stats = parseStats(commit.stats);
      sum.files += stats.files;
      sum.insertions += stats.insertions;
      sum.deletions += stats.deletions;
      return sum;
    }, { commits: commits.length, files: 0, insertions: 0, deletions: 0 });
    return {
      ...repo,
      commits,
      total,
      sourcePaths,
      ...(sourcePaths.length ? {} : { error: errors[0] || "本机未找到与仓库定义匹配的源码" }),
      ...(errors.length && sourcePaths.length ? { warnings: errors } : {}),
    };
  });
}
