export function normalizeProjectPath(value) {
  return String(value || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function managedEntryForProject(worktree, targetPath) {
  const target = normalizeProjectPath(targetPath);
  if (!target) return null;
  return (Array.isArray(worktree?.entries) ? worktree.entries : []).find((entry) => (
    normalizeProjectPath(entry?.path) === target || normalizeProjectPath(entry?.basePath) === target
  )) || null;
}

export function canPromoteWorktreeExtra({ projects = [], worktree = null, extraPath = "" } = {}) {
  const entry = managedEntryForProject(worktree, extraPath);
  if (!entry) return false;
  return projects.some((project) => (
    (!!entry.baseProjectId && project?.id === entry.baseProjectId)
    || normalizeProjectPath(project?.path) === normalizeProjectPath(entry.basePath)
  ));
}

export function selectedBaseProjectPaths(worktree, fallbackPaths = []) {
  const paths = (Array.isArray(worktree?.entries) ? worktree.entries : [])
    .filter((entry) => entry?.active !== false && entry?.role !== "inactive")
    .map((entry) => entry?.basePath)
    .filter(Boolean);
  if (!paths.length) paths.push(...fallbackPaths);
  return new Set(paths.map(normalizeProjectPath).filter(Boolean));
}
