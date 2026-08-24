const REVISION_RE = /^[0-9a-f]{7,64}$/i;

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolveGitCommitInferenceProjectId(tbProjectId = "", repositoryId = "") {
  const tbScope = String(tbProjectId || "").trim();
  if (tbScope) return tbScope;
  const repositoryScope = String(repositoryId || "").trim();
  return repositoryScope ? `git-repository:${repositoryScope}` : "";
}

export function nextGitCommitBatchRequest(requests = []) {
  const queue = Array.isArray(requests) ? requests.filter((request) => request?.body) : [];
  return {
    current: queue[0] || null,
    remaining: queue.slice(1),
  };
}

export function validateGitCommitRevision(value) {
  const revision = String(value || "").trim();
  if (!revision) return { ok: false, error: "请输入 Git commit revision number" };
  if (!REVISION_RE.test(revision)) {
    return { ok: false, error: "请输入 7 至 64 位十六进制 commit hash" };
  }
  return { ok: true, revision: revision.toLowerCase(), preview: revision.slice(0, 12).toLowerCase() };
}

export function gitRepositoryLabel(repository = {}) {
  return String(repository.name || repository.id || repository.https || repository.ssh || "未命名仓库").trim();
}

export function gitRepositoryDisplayUrl(repository = {}) {
  return String(repository.https || repository.ssh || "").trim();
}

export function filterGitRepositories(projectDefs = [], query = "") {
  const rows = Array.isArray(projectDefs) ? projectDefs : [];
  const needle = normalized(query);
  if (!needle) return rows;
  return rows.filter((repository) => [
    repository?.name,
    repository?.id,
    repository?.https,
    repository?.ssh,
    repository?.projectType,
  ].some((value) => normalized(value).includes(needle)));
}

export function resolveGitRepositoryInput(projectDefs = [], value = "", selectedRepositoryId = "") {
  const rows = Array.isArray(projectDefs) ? projectDefs : [];
  const selected = rows.find((repository) => String(repository?.id || "") === String(selectedRepositoryId || ""));
  if (selected) return { ok: true, repository: selected };
  const needle = normalized(value);
  if (!needle) return { ok: false, error: "请选择或输入 Git 仓库地址" };
  const exact = rows.filter((repository) => [
    repository?.id,
    repository?.name,
    repository?.https,
    repository?.ssh,
  ].some((candidate) => normalized(candidate) === needle));
  if (exact.length === 1) return { ok: true, repository: exact[0] };
  if (exact.length > 1) {
    return { ok: false, error: "该地址对应多个逻辑工程，请从下拉列表明确选择" };
  }
  return { ok: false, error: "未匹配到已配置仓库，请从下拉列表选择" };
}

export function buildGitCommitStoryRequest({
  revision,
  repositoryValue,
  selectedRepositoryId,
  projectDefs,
  projectId,
} = {}) {
  const parsedRevision = validateGitCommitRevision(revision);
  if (!parsedRevision.ok) return parsedRevision;
  const selected = resolveGitRepositoryInput(projectDefs, repositoryValue, selectedRepositoryId);
  if (!selected.ok) return selected;
  return {
    ok: true,
    body: {
      revision: parsedRevision.revision,
      repositoryId: selected.repository.id,
      repositoryUrl: gitRepositoryDisplayUrl(selected.repository),
      ...(projectId ? { projectId } : {}),
    },
  };
}

export function gitCommitLocalSourceValue(source = {}) {
  const projectId = String(source.projectId || source.sourceProjectId || "").trim();
  const role = String(source.role || source.sourceRole || "").trim() || "primary";
  return projectId ? `${encodeURIComponent(projectId)}::${encodeURIComponent(role)}` : "";
}

export function buildGitCommitStoryConfirmation({
  requestBody,
  sourceMode,
  localSource,
} = {}) {
  const body = requestBody && typeof requestBody === "object" ? requestBody : null;
  if (!body?.revision || !body?.repositoryId) {
    return { ok: false, error: "commit 预览信息已失效，请返回上一步重新解析" };
  }
  const mode = String(sourceMode || "").trim().toLowerCase();
  if (!["local", "remote"].includes(mode)) {
    return { ok: false, error: "请先选择使用本地工程或远程拉取" };
  }
  const configuration = { mode };
  if (mode === "local") {
    const localProjectId = String(localSource?.projectId || "").trim();
    if (!localProjectId) return { ok: false, error: "请选择要使用的本机工程" };
    configuration.localProjectId = localProjectId;
    configuration.localRole = String(localSource?.role || "").trim() || "primary";
  }
  return {
    ok: true,
    body: {
      ...body,
      configurationConfirmed: true,
      configuration,
    },
  };
}

export function buildGitCommitInferenceTicket(preview = {}, projectId = "", reviewHint = "") {
  const commit = preview?.commit || {};
  const remote = preview?.remote || {};
  const revision = String(commit.revision || "").trim();
  const shortRevision = String(commit.shortRevision || revision.slice(0, 12)).trim();
  const changedFiles = (Array.isArray(commit.changedFiles) ? commit.changedFiles : [])
    .map((item) => String(item?.path || item || "").trim())
    .filter(Boolean);
  const branches = (Array.isArray(commit.branches) ? commit.branches : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return {
    ticketId: revision ? `git:${revision}` : "",
    title: `[Git ${shortRevision || "commit"}] ${String(commit.subject || "代码评审").trim()}`,
    description: [
      `逻辑仓库：${String(remote.repositoryName || remote.repositoryId || "").trim()}`,
      `Revision：${revision}`,
      branches.length ? `包含分支：${branches.join("、")}` : "",
      changedFiles.length ? `改动文件：${changedFiles.join("、")}` : "",
      String(commit.body || "").trim() ? `提交说明：${String(commit.body).trim()}` : "",
      String(reviewHint || "").trim() ? `人工风险提示：${String(reviewHint).trim()}` : "",
    ].filter(Boolean).join("\n"),
    projectId: String(projectId || "").trim(),
    tags: ["Git Commit Review", ...branches].filter(Boolean),
    comments: [],
    attachments: [],
  };
}

export function seedGitCommitInferenceSession(session = {}, configuration = {}, repositoryId = "") {
  const targets = Array.isArray(session?.prediction?.targets) ? session.prediction.targets : [];
  const mode = String(configuration?.mode || "").trim().toLowerCase();
  const localProjectId = String(configuration?.localProjectId || "").trim();
  let anchorIndex = targets.findIndex((target) => (
    String(target?.repositoryId || "").trim() === String(repositoryId || "").trim()
  ));
  if (anchorIndex < 0) {
    anchorIndex = targets.findIndex((target) => (
      ["primary", "standalone"].includes(String(target?.targetRole || "").trim())
    ));
  }
  anchorIndex = Math.max(0, anchorIndex);
  const bindings = targets.flatMap((target, index) => {
    const targetId = String(target?.targetId || `target_${index + 1}`).trim();
    const base = {
      targetId,
      repositoryId: String(target?.repositoryId || "").trim(),
      branch: String(target?.branch || "").trim(),
    };
    if (mode === "remote") return [{ ...base, useRemote: true }];
    if (mode === "local" && localProjectId && index === anchorIndex) {
      return [{ ...base, projectId: localProjectId }];
    }
    return [];
  });
  const bindingFor = (row = {}) => bindings.find((binding) => (
    String(binding.targetId || "") === String(row.targetId || "")
    || (
      String(binding.repositoryId || "") === String(row.repositoryId || "")
      && String(binding.branch || "") === String(row.branch || "")
    )
  ));
  const resolution = session?.localResolution && typeof session.localResolution === "object"
    ? session.localResolution
    : null;
  if (!resolution) return { session, bindings };
  const resolutionTargets = (Array.isArray(resolution.targets) ? resolution.targets : []).map((row) => {
    const binding = bindingFor(row);
    if (!binding) return row;
    return binding.useRemote
      ? {
        ...row,
        selectedProjectId: "",
        matchKind: "remote_selected",
        resolved: false,
      }
      : {
        ...row,
        selectedProjectId: binding.projectId,
        matchKind: "user_selected",
        resolved: true,
      };
  });
  const complete = resolutionTargets.every((row) => (
    row.selectionRequired === false
    || row.resolved === true
    || row.matchKind === "remote_selected"
  ));
  return {
    session: {
      ...session,
      localResolution: {
        ...resolution,
        complete,
        targets: resolutionTargets,
      },
    },
    bindings,
  };
}

export function buildGitCommitReviewPrompt(reviewContext = {}) {
  const revision = String(
    reviewContext.shortRevision
      || reviewContext.revision
      || "",
  ).trim();
  return [
    `请开始评审当前 Git commit${revision ? ` ${revision}` : ""}。`,
    "严格按本故事点的只读评审约束执行：先读取真实 diff，再检查正确性、边界条件、空值、并发/生命周期、安全、性能与测试缺口。",
    "强制复核该 commit 对应分支的最新代码：在不切换分支、不修改故事点 worktree 或原基仓的前提下，记录实际比较的分支 ref 与最新 tip SHA，逐条确认原提交中的潜在问题是否已被后续提交修复。",
    "每条 finding 必须标注“仍存在 / 部分修复 / 已在对应分支最新代码修复 / 无法验证最新分支”之一；若已修复，必须说明修复提交（能定位时）、最新代码证据和仍可能存在的发布或 Flavor 风险，不得继续把它描述成当前未修复问题。",
    "运行与改动范围匹配的静态检查、编译或测试，并明确区分已验证与未验证项。",
    "重点评估 shared/main 代码、公共资源、接口或依赖变更对其它 Flavor 的影响，以及合入目标分支后的冲突、兼容性和回归风险。",
    "不要修改代码、切换分支、提交或推送。最终按严重度输出包含文件和行号、触发条件、影响范围与建议的 findings；没有发现也要说明覆盖面和残余风险。",
  ].join("\n");
}

export function gitCommitLatestBranchNotice(comparison = {}) {
  const status = String(comparison?.status || "").trim();
  if (status === "remote_verified" && comparison?.comparisonReady === true) return null;
  if (status === "remote_tip_not_local") {
    return {
      type: "warning",
      message: "已取得权威远端 tip，但本地尚无该对象；评审将只在独立临时仓库按精确 SHA 复核",
    };
  }
  if (status === "remote_history_mismatch") {
    return {
      type: "warning",
      message: "被审提交不在权威远端 tip 的线性历史中；只能做快照对比，不能声称由后续提交线性修复",
    };
  }
  if (status === "branch_ambiguous") {
    return {
      type: "error",
      message: "该提交同时位于多个分支，无法自动确定对应分支；本轮必须标记“无法验证最新分支”",
    };
  }
  if (status === "branch_unavailable") {
    return {
      type: "error",
      message: "没有能证明包含该提交的对应分支；本轮必须标记“无法验证最新分支”",
    };
  }
  return {
    type: "error",
    message: "权威远端最新代码未验证成功；本轮不得把本地分支当成最新代码，并会明确标记验证边界",
  };
}

export function gitCommitBatchCandidateKey(candidate = {}) {
  return String(
    candidate.key
      || `${candidate.repositoryId || ""}:${candidate.revision || ""}`,
  ).trim();
}

export function selectedGitCommitBatchCandidate(item = {}, selectedKey = "") {
  const candidates = Array.isArray(item.candidates) ? item.candidates : [];
  if (item.status === "resolved" && item.resolution) return item.resolution;
  if (item.status !== "ambiguous") return null;
  const key = String(selectedKey || "").trim();
  return candidates.find((candidate) => gitCommitBatchCandidateKey(candidate) === key) || null;
}

export function buildGitCommitBatchCreateRequests({
  items = [],
  selections = {},
  projectId = "",
  completedKeys = [],
  sourceMode = "",
} = {}) {
  const normalizedSourceMode = String(sourceMode || "").trim().toLowerCase();
  if (!["local", "remote"].includes(normalizedSourceMode)) {
    return {
      ok: false,
      error: "请先为本批次选择使用本地工程或远程拉取",
      unresolved: [],
      requests: [],
    };
  }
  const completed = new Set(Array.isArray(completedKeys) ? completedKeys : []);
  const requests = [];
  const unresolved = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.status === "duplicate") continue;
    const candidate = selectedGitCommitBatchCandidate(
      item,
      selections?.[item.inputIndex],
    );
    if (!candidate) {
      unresolved.push({
        inputIndex: item?.inputIndex,
        reference: item?.reference || "",
        status: item?.status || "not_found",
        error: item?.error || "该提交尚未匹配到唯一仓库",
      });
      continue;
    }
    const candidateKey = gitCommitBatchCandidateKey(candidate);
    if (!candidateKey || completed.has(candidateKey)) continue;
    if (normalizedSourceMode === "local" && !String(candidate.sourceProjectId || "").trim()) {
      unresolved.push({
        inputIndex: item?.inputIndex,
        reference: item?.reference || "",
        status: "local_source_missing",
        error: "该提交没有可确认的本机工程来源，请改用远程拉取或重新解析",
      });
      continue;
    }
    requests.push({
      key: candidateKey,
      inputIndex: item.inputIndex,
      reference: item.reference,
      excerpt: item.excerpt || "",
      body: {
        revision: candidate.revision,
        repositoryId: candidate.repositoryId,
        repositoryUrl: candidate.repositoryUrl || "",
        reviewHint: item.excerpt || "",
        configurationConfirmed: true,
        configuration: normalizedSourceMode === "local"
          ? {
            mode: "local",
            localProjectId: candidate.sourceProjectId,
            localRole: candidate.sourceRole || "primary",
          }
          : { mode: "remote" },
        ...(projectId ? { projectId } : {}),
      },
    });
  }
  if (unresolved.length) {
    return {
      ok: false,
      error: `仍有 ${unresolved.length} 条提交未完成唯一匹配`,
      unresolved,
      requests,
    };
  }
  if (!requests.length) {
    return {
      ok: false,
      error: completed.size ? "所有可创建提交均已完成" : "没有可创建的提交",
      unresolved: [],
      requests: [],
    };
  }
  return { ok: true, requests, unresolved: [] };
}
