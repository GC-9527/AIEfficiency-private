export const WORKSPACE_BUNDLE_EDITABLE = "EDITABLE";
export const WORKSPACE_BUNDLE_READ_ONLY = "READ_ONLY";

function text(value) {
  return String(value || "").trim();
}

export function emptyWorkspaceBundle(definitionId) {
  const repositoryId = text(definitionId);
  return {
    version: 2,
    enabled: true,
    id: `${repositoryId || "workspace"}-bundle`,
    buildEntryRepositoryId: repositoryId,
    layoutPolicy: "SAME_PARENT_SIBLINGS",
    branchPolicy: "SAME_LOGICAL_BRANCH",
    strictBranch: true,
    members: repositoryId ? [{
      repositoryId,
      checkoutDirName: "",
      required: true,
      mode: WORKSPACE_BUNDLE_EDITABLE,
    }] : [],
  };
}

export function editableWorkspaceBundle(input, definitionId) {
  if (!input || input.enabled !== true) return null;
  const fallback = emptyWorkspaceBundle(definitionId);
  return {
    ...fallback,
    ...input,
    enabled: true,
    buildEntryRepositoryId: text(input.buildEntryRepositoryId || input.buildEntryRepoId || definitionId),
    layoutPolicy: "SAME_PARENT_SIBLINGS",
    branchPolicy: "SAME_LOGICAL_BRANCH",
    strictBranch: true,
    members: (Array.isArray(input.members) ? input.members : []).map((member) => ({
      repositoryId: text(member?.repositoryId || member?.repoId),
      checkoutDirName: text(member?.checkoutDirName || member?.relativeDir),
      required: member?.required !== false,
      mode: text(member?.mode || member?.defaultMode).toUpperCase() === WORKSPACE_BUNDLE_READ_ONLY
        ? WORKSPACE_BUNDLE_READ_ONLY
        : WORKSPACE_BUNDLE_EDITABLE,
    })),
  };
}

export function workspaceBundlePayload(input, definitionId) {
  if (!input || input.enabled !== true) return null;
  return editableWorkspaceBundle(input, definitionId);
}

export function workspaceBundleDraftError(input, definitions = [], definitionId = "") {
  if (!input || input.enabled !== true) return "";
  const bundle = editableWorkspaceBundle(input, definitionId);
  const known = new Set((Array.isArray(definitions) ? definitions : []).map((definition) => text(definition?.id)).filter(Boolean));
  const repositories = new Set();
  const directories = new Set();
  if (!bundle.buildEntryRepositoryId || bundle.buildEntryRepositoryId !== text(definitionId)) {
    return "Bundle 必须配置在构建入口仓库上";
  }
  if (!bundle.members.length) return "Bundle 至少需要一个成员仓库";
  for (const member of bundle.members) {
    if (!member.repositoryId) return "请选择成员仓库";
    if (known.size && !known.has(member.repositoryId)) return `成员仓库不存在：${member.repositoryId}`;
    if (repositories.has(member.repositoryId)) return `成员仓库重复：${member.repositoryId}`;
    repositories.add(member.repositoryId);
    if (!member.checkoutDirName) return `请填写 ${member.repositoryId} 的固定目录名`;
    const directoryKey = member.checkoutDirName.toLowerCase();
    if (directories.has(directoryKey)) return `固定目录名重复：${member.checkoutDirName}`;
    directories.add(directoryKey);
  }
  const entry = bundle.members.find((member) => member.repositoryId === bundle.buildEntryRepositoryId);
  if (!entry) return "成员中缺少构建入口仓库";
  if (entry.mode !== WORKSPACE_BUNDLE_EDITABLE || entry.required === false) return "构建入口必须是可修改的必需成员";
  return "";
}
