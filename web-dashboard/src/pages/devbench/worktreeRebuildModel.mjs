import {
  WORKTREE_FORCE_CONFIRMATION,
  WORKTREE_FORCE_UNLOCK_MS,
  worktreeCleanupCanConfirm,
  worktreeCleanupCanForce,
  worktreeCleanupCards,
  worktreeCleanupForceStatus,
} from "./worktreeCleanupModel.mjs";

export { WORKTREE_FORCE_CONFIRMATION, WORKTREE_FORCE_UNLOCK_MS };

export function isWorktreeRebuildConfirmRequired(result) {
  return result?.ok === false
    && result?.code === "WORKTREE_REBUILD_CONFIRM_REQUIRED"
    && !!result?.data?.preview;
}

export function worktreeRebuildReasonLabels(preview) {
  return (Array.isArray(preview?.reasons) ? preview.reasons : [])
    .map((reason) => reason?.label || reason?.code)
    .filter(Boolean);
}

export function worktreeRebuildDeleteRows(preview) {
  return (Array.isArray(preview?.deleteEntries) ? preview.deleteEntries : []).map((entry) => ({
    ...entry,
    title: entry.inactive
      ? `${entry.name || "worktree"}（旧/inactive）`
      : (entry.name || entry.role || "worktree"),
  }));
}

export function worktreeRebuildCanSafeConfirm(inspection, acknowledged) {
  return worktreeCleanupCanConfirm(inspection, acknowledged);
}

export function worktreeRebuildCanForceConfirm(inspection, forceAcknowledged, forceUnlocked) {
  return worktreeCleanupCanForce(inspection, forceAcknowledged, forceUnlocked);
}

export function worktreeRebuildInspectionCards(inspection) {
  return worktreeCleanupCards(inspection);
}

export function worktreeRebuildForceStatus(inspection) {
  return worktreeCleanupForceStatus(inspection);
}

export function buildWorktreeRebuildConfirmBody(pendingBody = {}, {
  token,
  force = false,
  confirmation = "",
} = {}) {
  return {
    ...(pendingBody || {}),
    confirmRebuild: true,
    cleanupToken: token,
    forceCleanup: force === true,
    cleanupConfirmation: force ? (confirmation || WORKTREE_FORCE_CONFIRMATION) : "",
  };
}
