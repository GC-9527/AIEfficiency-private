/**
 * Devbench "提 PR" 的分支准备逻辑。
 *
 * 这里刻意把已有分支视为可重入状态：第一次调用可能已创建并推送分支、
 * 但在创建 Codeup MR 时失败；再次调用必须复用该分支，而不是因为它与
 * 当前目标分支已经分叉就直接失败。
 */

function normalizeGitPath(file) {
  return String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function extractPullRequestCarbIds(value) {
  const matches = String(value || "").match(/\bCARB-\d+\b/gi) || [];
  return [...new Set(matches.map((item) => item.toUpperCase()))];
}

function storyCreatedAt(tab) {
  const stored = Number(tab?.createdAt);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const fromId = String(tab?.id || "").match(/^tab_(\d{10,})_/);
  const parsed = Number(fromId?.[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function formatStoryDevPrTimestamp(value) {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : null;
  if (!date || !Number.isFinite(date.getTime())) return "";
  const pad = (part, width = 2) => String(part).padStart(width, "0");
  return [
    pad(date.getFullYear(), 4),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function buildStoryDevPrTag(tab) {
  const timestamp = formatStoryDevPrTimestamp(storyCreatedAt(tab));
  return timestamp ? `[StoryDev:${timestamp}]` : "";
}

function normalizedStoryTitle(tab) {
  return String(tab?.title || "").replace(/\s+/g, " ").trim();
}

export function buildStoryPullRequestTitle(tab, carbId = "") {
  const title = normalizedStoryTitle(tab);
  const normalizedCarbId = extractPullRequestCarbIds(carbId)[0] || "";
  if (normalizedCarbId) {
    if (title && extractPullRequestCarbIds(title).includes(normalizedCarbId)) return title.slice(0, 180);
    return `#${normalizedCarbId}# ${title || "故事点改动"}`.slice(0, 180);
  }
  const tag = buildStoryDevPrTag(tab);
  if (!tag) return "";
  return `${tag} ${title || "故事点改动"}`.slice(0, 180);
}

function taskMatchesStory(task, tab, tbTaskId, directCarbIds) {
  if (!task) return false;
  if (tbTaskId && String(task.tbTaskId || "") === tbTaskId) return true;
  if (tab?.ticketUrl && String(task.ticketUrl || "") === String(tab.ticketUrl)) return true;
  const taskCarbIds = extractPullRequestCarbIds([task.carbId, task.title].filter(Boolean).join(" "));
  return directCarbIds.some((carbId) => taskCarbIds.includes(carbId));
}

function detailUniqueCarbId(detail) {
  const uniqueId = String(detail?.uniqueId || "").trim();
  const explicit = extractPullRequestCarbIds(uniqueId)[0] || "";
  if (explicit) return explicit;
  return /^\d+$/.test(uniqueId) ? `CARB-${uniqueId}` : "";
}

function storyTbTaskId(tab) {
  return String(tab?.ticketUrl || "").match(/task\/([0-9a-fA-F]{24})/)?.[1] || "";
}

/**
 * 解析提 PR 所需的故事点身份。
 * - 唯一 CARB：沿用现有 CARB 标题。
 * - 无任何 TB/CARB：使用稳定的 StoryDev 创建时间标识。
 * - 多 CARB、显式关联任务无法解析：阻断，避免错误关联或静默降级。
 */
export async function resolveStoryPullRequestIdentity(tab, {
  tasks = [],
  getTaskDetail,
} = {}) {
  const candidateSources = new Map();
  const addCandidates = (value, source) => {
    for (const carbId of extractPullRequestCarbIds(value)) {
      const sources = candidateSources.get(carbId) || [];
      if (!sources.includes(source)) sources.push(source);
      candidateSources.set(carbId, sources);
    }
  };

  addCandidates(tab?.title, "故事点标题");
  addCandidates(tab?.remotePull?.tbId, "远程拉取配置");
  addCandidates(tab?.ticketUrl, "关联任务链接");
  const directCarbIds = [...candidateSources.keys()];
  const tbTaskId = storyTbTaskId(tab);
  const knownTasks = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => taskMatchesStory(task, tab, tbTaskId, directCarbIds));
  for (const task of knownTasks) {
    addCandidates(task?.carbId, "本地关联任务");
    addCandidates(task?.title, "本地关联任务");
  }

  let taskDetailError = "";
  if (tbTaskId && typeof getTaskDetail === "function") {
    try {
      const detail = await getTaskDetail(tbTaskId);
      if (!detail) {
        taskDetailError = "TB 任务详情为空";
      } else {
        addCandidates(detailUniqueCarbId(detail), "TB 任务详情");
        addCandidates(detail?.content, "TB 任务详情");
        addCandidates(detail?.title, "TB 任务详情");
      }
    } catch (error) {
      taskDetailError = String(error?.message || error || "读取 TB 任务详情失败").slice(0, 240);
    }
  }

  const candidates = [...candidateSources.keys()];
  const storyDevId = String(tab?.id || "").trim();
  if (candidates.length > 1) {
    return {
      mode: "blocked",
      carbId: "",
      storyDevId,
      storyDevTag: buildStoryDevPrTag(tab),
      title: "",
      candidates,
      candidateSources: Object.fromEntries(candidateSources),
      globalBlocker: `检测到多个不同 CARB 单号（${candidates.join("、")}），请保留唯一关联后重试`,
      warning: "",
      tbTaskId,
    };
  }

  if (candidates.length === 1) {
    const carbId = candidates[0];
    return {
      mode: "carb",
      carbId,
      storyDevId,
      storyDevTag: "",
      title: buildStoryPullRequestTitle(tab, carbId),
      candidates,
      candidateSources: Object.fromEntries(candidateSources),
      globalBlocker: "",
      warning: taskDetailError
        ? `TB 任务详情暂不可用，已按本地可确认的 ${carbId} 继续预检`
        : "",
      tbTaskId,
    };
  }

  const explicitTaskReference = !!(
    tbTaskId
    || String(tab?.ticketUrl || "").trim()
    || String(tab?.remotePull?.tbId || "").trim()
  );
  if (explicitTaskReference) {
    const detail = taskDetailError ? `：${taskDetailError}` : "";
    return {
      mode: "blocked",
      carbId: "",
      storyDevId,
      storyDevTag: buildStoryDevPrTag(tab),
      title: "",
      candidates,
      candidateSources: {},
      globalBlocker: `故事点已填写关联任务信息，但未能解析有效 CARB 单号${detail}`,
      warning: "",
      tbTaskId,
    };
  }

  const title = normalizedStoryTitle(tab);
  if (!title) {
    return {
      mode: "blocked",
      carbId: "",
      storyDevId,
      storyDevTag: buildStoryDevPrTag(tab),
      title: "",
      candidates,
      candidateSources: {},
      globalBlocker: "无 TB/CARB 故事点必须填写标题",
      warning: "",
      tbTaskId,
    };
  }
  const storyDevTag = buildStoryDevPrTag(tab);
  if (!storyDevTag) {
    return {
      mode: "blocked",
      carbId: "",
      storyDevId,
      storyDevTag: "",
      title: "",
      candidates,
      candidateSources: {},
      globalBlocker: "故事点缺少稳定创建时间，无法生成 StoryDev PR 标识",
      warning: "",
      tbTaskId,
    };
  }
  return {
    mode: "storydev",
    carbId: "",
    storyDevId,
    storyDevTag,
    title: buildStoryPullRequestTitle(tab),
    candidates,
    candidateSources: {},
    globalBlocker: "",
    warning: `当前故事点未关联 TB/CARB，将使用 ${storyDevTag} 创建 PR；创建后不会自动关联 Teambition 任务`,
    tbTaskId,
  };
}

export function buildStoryMergeRequestDescription(tab, sourceBranch, targetBranch, identity = {}) {
  const lines = [`故事点：${tab?.title || ""}`];
  if (identity.mode === "storydev") {
    lines.push("关联类型：StoryDev 本地故事点");
    lines.push(`StoryDev ID：${identity.storyDevId || tab?.id || ""}`);
    lines.push(`StoryDev 标识：${identity.storyDevTag || buildStoryDevPrTag(tab)}`);
    if (tab?.reviewContext?.kind === "git_commit") {
      lines.push("来源：Git Commit 评审故事点");
      const revision = String(tab.reviewContext.revision || "").trim();
      const subject = String(tab.reviewContext.subject || "").replace(/\s+/g, " ").trim();
      if (revision || subject) lines.push(`关联提交：${[revision, subject].filter(Boolean).join(" ")}`);
      const repository = String(tab.reviewContext.repositoryName || tab.reviewContext.repositoryId || "").trim();
      if (repository) lines.push(`来源仓库：${repository}`);
    } else {
      lines.push("来源：手工创建");
    }
    const projects = [...new Set((Array.isArray(tab?.worktree?.entries) ? tab.worktree.entries : [])
      .filter((entry) => entry && entry.role !== "inactive" && entry.active !== false)
      .map((entry) => String(entry.name || entry.projectId || "").trim())
      .filter(Boolean))];
    if (projects.length) lines.push(`关联项目：${projects.join("、")}`);
  } else if (identity.carbId) {
    lines.push(`CARB 单号：${identity.carbId}`);
  }
  lines.push(`来源分支：${sourceBranch}`);
  lines.push(`目标分支：${targetBranch}`);
  if (tab?.ticketUrl) lines.push(`关联任务：${tab.ticketUrl}`);
  return lines.filter(Boolean).join("\n");
}

function normalizePrBranchSegment(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function releaseVehicleFromBranch(branch) {
  const match = String(branch || "").trim().match(/^(?:refs\/heads\/)?release\/(.+)$/i);
  return match?.[1] || "";
}

/**
 * PR 分支中的机型优先沿用 release/<机型> 的 Git 命名（例如 geely-e22），
 * 其次使用故事点确认过的车型，再回退到主工程 flavor。
 */
export function resolvePrVehicleSlug({ targetBranch = "", vehicle = "", flavor = "" } = {}) {
  for (const candidate of [releaseVehicleFromBranch(targetBranch), vehicle, flavor]) {
    const slug = normalizePrBranchSegment(candidate);
    if (slug) return slug;
  }
  return "";
}

export function buildPrSourceBranch(carbId, options = {}) {
  const ticket = String(carbId || "").match(/\bCARB-\d+\b/i)?.[0]?.toUpperCase() || "";
  const vehicle = resolvePrVehicleSlug(options);
  return ticket && vehicle ? `fix/${ticket}-${vehicle}` : "";
}

export function isPrSourceBranchInFamily(branch, sourceBranchPrefix) {
  const normalized = String(branch || "").trim().toLowerCase();
  const prefix = String(sourceBranchPrefix || "").trim().toLowerCase();
  if (!normalized || !/^fix\/carb-\d+$/i.test(prefix)) return false;
  return normalized === prefix || normalized.startsWith(`${prefix}-`);
}

export function firstPrTargetBranch(values, sourceBranchPrefix) {
  for (const value of values || []) {
    const branch = String(value || "").trim();
    const usable = !!branch
      && branch !== "HEAD"
      && !/[\s~^:?*[\]\\]/.test(branch)
      && !branch.includes("..")
      && !branch.startsWith("/")
      && !branch.endsWith("/")
      && !branch.endsWith(".lock");
    if (usable && !isPrSourceBranchInFamily(branch, sourceBranchPrefix)) return branch;
  }
  return "";
}

function prEntryIdentities(entry) {
  return [entry?.projectId, entry?.id, entry?.repoId, entry?.name]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

/** 选择提 PR 的主工程条目，显式 targetRole 优先于旧名称兼容推断。 */
export function selectPrPrimaryEntry(entries, identityCandidates = []) {
  const list = Array.isArray(entries) ? entries : [];
  const roleOf = (entry, field) => String(entry?.[field] || "").trim().toLowerCase();
  const explicitPrimary = list.find((entry) => roleOf(entry, "targetRole") === "primary");
  if (explicitPrimary) return explicitPrimary;
  const standalone = list.find((entry) => roleOf(entry, "targetRole") === "standalone");
  if (standalone) return standalone;

  const candidates = new Set((identityCandidates || [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean));
  const exact = list.find((entry) => prEntryIdentities(entry).some((key) => candidates.has(key)));
  if (exact) return exact;

  const legacyPrimary = list.find((entry) => roleOf(entry, "role") === "primary");
  if (legacyPrimary) return legacyPrimary;
  return list.find((entry) => prEntryIdentities(entry).includes("appmarket"))
    || list.find((entry) => prEntryIdentities(entry).some((key) => key.includes("appmarket") && !key.includes("sdk")))
    || null;
}

export function isGeneratedStoryArchivePath(file) {
  const normalized = normalizeGitPath(file);
  return /(?:^|\/)docs\/story\/[^/]+\/ask\/[^/]+\.(?:txt|md)$/i.test(normalized);
}

function pullRequestEntryBase(entry = {}) {
  const worktreePath = entry.worktreePath || entry.path || "";
  const basePath = entry.baseRepositoryPath || entry.basePath || "";
  const storyBranch = String(entry.branch || "").trim();
  const originalBranch = String(entry.originalBranch || "").replace(/^refs\/heads\//, "").trim()
    || String(entry.baseRef || "").replace(/^refs\/heads\//, "").trim();
  const pathParts = String(worktreePath || basePath || "工程").replace(/[\\/]+$/, "").split(/[\\/]/);
  return {
    name: entry.name || pathParts[pathParts.length - 1] || "工程",
    role: entry.role || "extra",
    path: worktreePath,
    basePath,
    storyBranch,
    originalBranch,
  };
}

function blockedPullRequestEntry(base, error) {
  return {
    ...base,
    ok: false,
    eligible: false,
    hasChanges: null,
    status: "blocked",
    error,
    dirtyCount: 0,
    aheadCount: 0,
    behindCount: 0,
    commits: [],
  };
}

async function existingGitRef(repoPath, candidates, runGit) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", candidate]);
    if (result.ok) return candidate;
  }
  return "";
}

/**
 * 只读检查一个受管 worktree 是否真的有内容可提 PR。
 *
 * 「可提」包含两类内容：
 *  - 故事分支相对目标分支已有新增提交；
 *  - worktree 还有本地改动，执行阶段会先自动提交。
 *
 * runGit/pathExists 使用依赖注入，便于用隔离临时仓库覆盖真实 Git 行为。
 */
export async function inspectPullRequestEntry(entry, { runGit, pathExists, fetchTarget = false } = {}) {
  if (typeof runGit !== "function") throw new TypeError("runGit is required");
  const base = pullRequestEntryBase(entry);
  const repoPath = base.path;

  if (!repoPath || (typeof pathExists === "function" && !pathExists(repoPath))) {
    return blockedPullRequestEntry(base, "worktree 路径不存在");
  }
  if (!base.storyBranch) return blockedPullRequestEntry(base, "无法确定故事分支（entry.branch 缺失）");
  if (!base.originalBranch) return blockedPullRequestEntry(base, "无法确定原始分支（entry.originalBranch/baseRef 缺失）");
  if (base.storyBranch === base.originalBranch) {
    return blockedPullRequestEntry(base, `来源分支与目标分支相同：${base.storyBranch}`);
  }

  const isRepo = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!isRepo.ok) return blockedPullRequestEntry(base, `worktree 非 git 仓库：${isRepo.error || ""}`);

  const current = await runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = current.ok ? current.stdout.trim() : "";
  if (!current.ok || currentBranch !== base.storyBranch) {
    return blockedPullRequestEntry(
      { ...base, currentBranch },
      `worktree 当前在「${currentBranch || "游离 HEAD"}」，不在故事分支「${base.storyBranch}」`,
    );
  }

  const unmerged = await runGit(repoPath, ["ls-files", "-u"]);
  if (!unmerged.ok) return blockedPullRequestEntry(base, `检查冲突状态失败：${unmerged.error}`);
  if (unmerged.stdout.trim()) return blockedPullRequestEntry(base, "当前存在未解决的合并冲突，请处理后再提 PR");

  const remotesResult = await runGit(repoPath, ["remote"]);
  const remotes = remotesResult.ok
    ? remotesResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] || "");
  if (!remote) return blockedPullRequestEntry(base, "未配置远程仓库");

  let targetFetched = false;
  let fetchWarning = "";
  if (fetchTarget) {
    const fetched = await runGit(
      repoPath,
      ["fetch", "--no-tags", remote, `+refs/heads/${base.originalBranch}:refs/remotes/${remote}/${base.originalBranch}`],
      90000,
    );
    targetFetched = fetched.ok;
    if (!fetched.ok) fetchWarning = `目标分支刷新失败，当前结果基于本地引用：${fetched.error || "unknown"}`;
  }

  const targetRef = await existingGitRef(repoPath, [
    `refs/remotes/${remote}/${base.originalBranch}`,
    `refs/heads/${base.originalBranch}`,
  ], runGit);
  if (!targetRef) {
    return blockedPullRequestEntry(
      { ...base, remote, targetFetched, fetchWarning },
      fetchWarning
        ? `无法刷新且本地找不到目标分支「${base.originalBranch}」：${fetchWarning}`
        : `本地找不到目标分支「${base.originalBranch}」，请先执行 Git Update`,
    );
  }

  const statusResult = await runGit(repoPath, ["status", "--porcelain", "-uall"]);
  if (!statusResult.ok) return blockedPullRequestEntry({ ...base, remote, targetRef }, `检查本地改动失败：${statusResult.error}`);
  const dirtyCount = statusResult.stdout.split(/\r?\n/).filter(Boolean).length;

  const aheadResult = await runGit(repoPath, ["rev-list", "--count", `${targetRef}..HEAD`]);
  if (!aheadResult.ok) {
    return blockedPullRequestEntry({ ...base, remote, targetRef }, `比较来源/目标分支失败：${aheadResult.error}`);
  }
  const behindResult = await runGit(repoPath, ["rev-list", "--count", `HEAD..${targetRef}`]);
  const aheadCount = Math.max(0, Number.parseInt(aheadResult.stdout.trim(), 10) || 0);
  const behindCount = behindResult.ok ? Math.max(0, Number.parseInt(behindResult.stdout.trim(), 10) || 0) : 0;
  const logResult = aheadCount > 0
    ? await runGit(repoPath, ["log", "--format=%h%x09%s", "--no-merges", "-n", "4", `${targetRef}..HEAD`])
    : { ok: true, stdout: "" };
  const commits = logResult.ok
    ? logResult.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha: sha || "", subject: subject.join("\t") || "" };
    })
    : [];
  const eligible = aheadCount > 0 || dirtyCount > 0;

  return {
    ...base,
    ok: true,
    eligible,
    hasChanges: eligible,
    status: eligible ? "ready" : "no_changes",
    reason: eligible ? "" : "来源分支相对目标分支没有新增提交，也没有本地改动",
    currentBranch,
    remote,
    targetRef,
    targetFetched,
    fetchWarning,
    dirtyCount,
    aheadCount,
    behindCount,
    commits,
  };
}

export function summarizePullRequestPreview(entries = []) {
  const results = Array.isArray(entries) ? entries : [];
  return {
    total: results.length,
    eligible: results.filter((entry) => entry?.eligible).length,
    noChanges: results.filter((entry) => entry?.status === "no_changes").length,
    blocked: results.filter((entry) => entry?.status === "blocked").length,
  };
}

async function localChanges(repoPath, runGit) {
  const status = await runGit(repoPath, ["status", "--porcelain", "-uall"]);
  if (!status.ok) return { ok: false, error: status.error };
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  return { ok: true, dirty: lines.length > 0, dirtyCount: lines.length };
}

async function unmergedFiles(repoPath, runGit) {
  const result = await runGit(repoPath, ["diff", "--name-only", "--diff-filter=U"]);
  if (!result.ok) return { ok: false, error: result.error, files: [] };
  return {
    ok: true,
    files: result.stdout.split(/\r?\n/).map((file) => normalizeGitPath(file.trim())).filter(Boolean),
  };
}

function withoutGeneratedPrArchiveLines(content) {
  return String(content || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*-{4,}\s*\[[^\]\r\n]+\]\s*提\s*PR\s*[：:]\s*fix\/CARB-[A-Z0-9_-]+\s*(?:→|->)\s*.+?\s*-{4,}\s*$/i.test(line))
    .join("\n")
    .trimEnd();
}

async function sourceArchiveOnlyAddedPrEvents(repoPath, file, runGit) {
  const base = await runGit(repoPath, ["show", `:1:${file}`]);
  const source = await runGit(repoPath, ["show", `:2:${file}`]);
  if (!base.ok || !source.ok) return false;
  return withoutGeneratedPrArchiveLines(source.stdout) === withoutGeneratedPrArchiveLines(base.stdout);
}

async function verifyStashedUntrackedFiles(repoPath, runGit) {
  const stashRef = "stash@{0}";
  const untrackedParent = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${stashRef}^3`]);
  if (!untrackedParent.ok) return { ok: true, files: [] };

  const listed = await runGit(repoPath, ["ls-tree", "-r", "--name-only", "-z", `${stashRef}^3`]);
  if (!listed.ok) {
    return { ok: false, files: [], error: `检查临时 stash 中的未跟踪文件失败：${listed.error}` };
  }
  const files = listed.stdout.split("\0").map((file) => normalizeGitPath(file)).filter(Boolean);
  const missingOrChanged = [];
  for (const file of files) {
    const expected = await runGit(repoPath, ["rev-parse", "--verify", `${stashRef}^3:${file}`]);
    // stash 中保存的是经过 Git clean/filter 规范化后的 blob。Windows 工作区常因
    // core.autocrlf 把同一内容写成 CRLF；用原始字节哈希会把已正确恢复的文件误判
    // 为内容变化。通过 --path 复用该路径的 clean/filter 后再与 stash blob 比较。
    const actual = await runGit(repoPath, ["hash-object", `--path=${file}`, "--", file]);
    if (!expected.ok || !actual.ok || expected.stdout.trim() !== actual.stdout.trim()) {
      missingOrChanged.push(file);
    }
  }
  return missingOrChanged.length
    ? { ok: false, files: missingOrChanged, error: `未跟踪文件未能从临时 stash 完整恢复：${missingOrChanged.join("、")}` }
    : { ok: true, files };
}

async function restoreStashedUntrackedFilesToWorktree(repoPath, files, runGit) {
  const restored = [];
  const failed = [];
  for (const file of files || []) {
    const checkout = await runGit(repoPath, ["checkout", "stash@{0}^3", "--", file]);
    if (!checkout.ok) {
      failed.push(file);
      continue;
    }
    // checkout <tree> 会同时写入 index；重置该路径后，原先未跟踪的文件仍为未跟踪，
    // 与来源分支已有跟踪文件重名时则成为清晰可见的工作区修改。
    const reset = await runGit(repoPath, ["reset", "--", file]);
    if (!reset.ok) {
      failed.push(file);
      continue;
    }
    restored.push(file);
  }
  return { ok: failed.length === 0, restored, failed };
}

async function resolveGeneratedArchiveConflicts(repoPath, runGit) {
  const conflicts = await unmergedFiles(repoPath, runGit);
  if (!conflicts.ok || !conflicts.files.length) return { ok: false, files: conflicts.files, error: conflicts.error };
  if (!conflicts.files.every(isGeneratedStoryArchivePath)) return { ok: false, files: conflicts.files };

  for (const file of conflicts.files) {
    if (!await sourceArchiveOnlyAddedPrEvents(repoPath, file, runGit)) {
      return {
        ok: false,
        files: conflicts.files,
        error: `故事点存档 ${file} 的来源分支包含非自动“提 PR”记录，已保留冲突供人工确认`,
      };
    }
  }

  // stash apply 的 "theirs" 是发起提 PR 时较新的工作区版本。故事点存档是
  // 追加式运行产物。仅当来源分支相对共同版本只增加了自动“提 PR”运行行时，
  // 才保留工作区版本，避免静默覆盖来源分支里的真实会话或其他记录。
  for (const file of conflicts.files) {
    const checkout = await runGit(repoPath, ["checkout", "--theirs", "--", file]);
    if (!checkout.ok) return { ok: false, files: conflicts.files, error: checkout.error };
    const add = await runGit(repoPath, ["add", "--", file]);
    if (!add.ok) return { ok: false, files: conflicts.files, error: add.error };
  }
  const remaining = await unmergedFiles(repoPath, runGit);
  if (!remaining.ok || remaining.files.length) {
    return { ok: false, files: remaining.files, error: remaining.error };
  }
  return { ok: true, files: conflicts.files };
}

async function checkoutWithLocalChanges(repoPath, checkoutArgs, branch, runGit) {
  const changes = await localChanges(repoPath, runGit);
  if (!changes.ok) return changes;
  if (!changes.dirty) {
    const checkout = await runGit(repoPath, checkoutArgs);
    return checkout.ok
      ? { ok: true, transferred: false, dirtyCount: 0 }
      : { ok: false, error: checkout.error };
  }

  const stashMessage = `[devbench-pr] transfer-to=${branch} ts=${Date.now()}`;
  const stash = await runGit(repoPath, ["stash", "push", "--include-untracked", "--message", stashMessage], 90000);
  if (!stash.ok) return { ok: false, error: `保存当前未提交改动失败：${stash.error}` };

  const checkout = await runGit(repoPath, checkoutArgs);
  if (!checkout.ok) {
    const restore = await runGit(repoPath, ["stash", "pop", "--index"], 90000);
    const restoreHint = restore.ok ? "原分支改动已恢复" : `恢复原分支改动也失败：${restore.error}`;
    return { ok: false, error: `切换到已有来源分支失败：${checkout.error}；${restoreHint}` };
  }

  const restore = await runGit(repoPath, ["stash", "pop", "--index"], 90000);
  if (restore.ok) {
    return { ok: true, transferred: true, dirtyCount: changes.dirtyCount };
  }

  // stash pop 可能同时出现普通合并冲突与“未跟踪文件已存在”等非合并失败。
  // 后者不会出现在 diff-filter=U 中；若只检查未合并文件就 drop stash，会丢掉
  // 尚未恢复的唯一副本。因此在任何自动解冲突/清理前，先逐个校验 stash 的
  // 未跟踪文件确实已经以相同 blob 落回工作区。
  const untrackedRestore = await verifyStashedUntrackedFiles(repoPath, runGit);
  if (!untrackedRestore.ok) {
    const conflicts = await unmergedFiles(repoPath, runGit);
    const files = [...new Set([...(conflicts.files || []), ...(untrackedRestore.files || [])])];
    const madeVisible = await restoreStashedUntrackedFilesToWorktree(repoPath, untrackedRestore.files, runGit);
    return {
      ok: false,
      transferConflict: true,
      branchChanged: true,
      stashPreserved: true,
      conflictFiles: files,
      error: [
        `已有来源分支 ${branch} 与当前改动存在冲突`,
        untrackedRestore.error,
        madeVisible.restored.length ? `用户未跟踪版本已放回工作区：${madeVisible.restored.join("、")}` : "",
        madeVisible.failed.length ? `未能把以下用户版本放回工作区：${madeVisible.failed.join("、")}` : "",
        "临时 stash 已保留且未被删除，请先恢复/处理上述文件后再提 PR",
      ].filter(Boolean).join("；"),
    };
  }

  const archiveResolution = await resolveGeneratedArchiveConflicts(repoPath, runGit);
  if (archiveResolution.ok) {
    // stash pop 冲突时不会自动 drop。仅在所有冲突均为生成存档且已解决后删除本次栈顶。
    const drop = await runGit(repoPath, ["stash", "drop"]);
    if (!drop.ok) {
      return {
        ok: false,
        error: `自动解决故事点存档冲突后清理临时 stash 失败：${drop.error}`,
        branchChanged: true,
        stashPreserved: true,
      };
    }
    return {
      ok: true,
      transferred: true,
      dirtyCount: changes.dirtyCount,
      autoResolvedArchiveConflicts: archiveResolution.files,
    };
  }

  const files = archiveResolution.files || [];
  return {
    ok: false,
    transferConflict: true,
    branchChanged: true,
    stashPreserved: true,
    conflictFiles: files,
    error: [
      `已有来源分支 ${branch} 与当前改动存在冲突`,
      archiveResolution.error,
      files.length ? `冲突文件：${files.join("、")}` : "",
      "当前已停留在来源分支，未提交内容及临时 stash 均已保留，请解决冲突后再次提 PR",
    ].filter(Boolean).join("；"),
  };
}

/**
 * 准备 fix/CARB-*-<机型> 来源分支。
 * runGit 使用依赖注入，便于在隔离临时仓库中覆盖真实 Git 行为。
 */
export async function ensurePrBranch(repoPath, branch, currentBranch, remote, runGit) {
  if (typeof runGit !== "function") throw new TypeError("runGit is required");

  const local = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (!local.ok) {
    const remoteRef = remote ? `${remote}/${branch}` : "";
    let remoteExists = remoteRef
      ? await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`])
      : { ok: false };
    if (remoteRef && !remoteExists.ok) {
      // 本地 remote-tracking ref 可能尚未 fetch，但服务端已经有同名分支。
      // 先只探测目标 ref；确认存在后定向 fetch，避免误创建后到 push 阶段才发现重名。
      const probe = await runGit(repoPath, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], 30000);
      if (!probe.ok) {
        return { ok: false, created: false, reused: false, error: `检查远程来源分支失败：${probe.error}` };
      }
      if (probe.stdout.trim()) {
        const fetch = await runGit(
          repoPath,
          ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remoteRef}`],
          90000,
        );
        if (!fetch.ok) {
          return { ok: false, created: false, reused: true, reusedRemote: true, error: `获取已有远程来源分支失败：${fetch.error}` };
        }
        remoteExists = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`]);
      }
    }
    if (remoteExists.ok) {
      const switched = await checkoutWithLocalChanges(
        repoPath,
        ["checkout", "-b", branch, "--track", remoteRef],
        branch,
        runGit,
      );
      return { ...switched, created: false, reused: true, reusedRemote: true, diverged: false };
    }
    const checkout = await runGit(repoPath, ["checkout", "-b", branch]);
    return checkout.ok
      ? { ok: true, created: true, reused: false, transferred: false, diverged: false }
      : { ok: false, created: false, reused: false, error: checkout.error };
  }

  if (currentBranch === branch) {
    return { ok: true, created: false, reused: true, transferred: false, diverged: false };
  }

  const sourceBehindCurrent = await runGit(repoPath, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  if (sourceBehindCurrent.ok) {
    // 保留旧行为：已有来源分支只是当前分支祖先时，可无损快进到当前 HEAD。
    const fastForward = await runGit(repoPath, ["branch", "-f", branch, "HEAD"]);
    if (!fastForward.ok) {
      return { ok: false, created: false, reused: true, error: `更新已有来源分支失败：${fastForward.error}` };
    }
    const checkout = await runGit(repoPath, ["checkout", branch]);
    return checkout.ok
      ? { ok: true, created: false, reused: true, fastForwarded: true, transferred: false, diverged: false }
      : { ok: false, created: false, reused: true, error: checkout.error };
  }

  const sourceContainsCurrent = await runGit(repoPath, ["merge-base", "--is-ancestor", "HEAD", branch]);
  const diverged = !sourceContainsCurrent.ok;
  const switched = await checkoutWithLocalChanges(repoPath, ["checkout", branch], branch, runGit);
  return {
    ...switched,
    created: false,
    reused: true,
    diverged,
  };
}
