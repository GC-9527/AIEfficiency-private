/**
 * Git Update 的本地改动保护。
 *
 * Update 只需要临时移开会被 merge 影响的已跟踪改动。未跟踪文件留在原地：
 * Git 在远端提交出现同名路径时会拒绝覆盖，正常情况下则完全不碰它们。这样也
 * 避免 `stash -u` 为扫描缓存目录（例如无读取权限的 .pytest_cache）而整体失败。
 */

async function currentStashOid(repoPath, runGit) {
  const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", "refs/stash"]);
  return result.ok ? result.stdout.trim() : "";
}

async function stashRefForOid(repoPath, oid, runGit) {
  const result = await runGit(repoPath, ["stash", "list", "--format=%gd %H"]);
  if (!result.ok) return { ok: false, error: result.error };
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(stash@\{\d+\})\s+([0-9a-f]{40,64})$/i);
    if (match && match[2] === oid) return { ok: true, ref: match[1] };
  }
  return { ok: true, ref: null };
}

export async function stashTrackedChanges(repoPath, message, runGit) {
  const status = await runGit(repoPath, ["status", "--porcelain", "-uno"]);
  if (!status.ok) return { ok: false, stashed: false, error: status.error };
  const trackedFiles = status.stdout.split(/\r?\n/).filter(Boolean).length;
  if (!trackedFiles) return { ok: true, stashed: false, trackedFiles: 0 };

  const beforeOid = await currentStashOid(repoPath, runGit);
  // 不使用 -u：未跟踪文件原地保留，既不会丢失，也不会遍历不可读缓存目录。
  const pushed = await runGit(repoPath, ["stash", "push", "-m", message]);
  const afterOid = await currentStashOid(repoPath, runGit);
  if (!pushed.ok) {
    return {
      ok: false,
      stashed: false,
      trackedFiles,
      stashCreated: !!afterOid && afterOid !== beforeOid,
      stashOid: afterOid && afterOid !== beforeOid ? afterOid : null,
      error: pushed.error,
    };
  }
  if (!afterOid || afterOid === beforeOid) {
    return { ok: false, stashed: false, trackedFiles, error: "Git 未生成本次更新所需的临时 stash" };
  }
  return { ok: true, stashed: true, trackedFiles, stashOid: afterOid };
}

export async function restoreTrackedChanges(repoPath, stashOid, runGit) {
  if (!stashOid) return { ok: true, restored: false, dropped: false };
  // --index 恢复用户原来的 staged/unstaged 状态；apply 成功后再按 OID 精确删除。
  const applied = await runGit(repoPath, ["stash", "apply", "--index", stashOid]);
  if (!applied.ok) {
    return { ok: false, restored: false, dropped: false, stashPreserved: true, error: applied.error };
  }

  const found = await stashRefForOid(repoPath, stashOid, runGit);
  if (!found.ok) {
    return {
      ok: true,
      restored: true,
      dropped: false,
      warning: `本地改动已恢复，但无法读取临时 stash 列表：${found.error}`,
    };
  }
  if (!found.ref) {
    return { ok: true, restored: true, dropped: false, warning: "本地改动已恢复，但临时 stash 已不在列表中" };
  }
  const dropped = await runGit(repoPath, ["stash", "drop", found.ref]);
  if (!dropped.ok) {
    return {
      ok: true,
      restored: true,
      dropped: false,
      warning: `本地改动已恢复，但临时 stash 清理失败并已保留：${dropped.error}`,
    };
  }
  return { ok: true, restored: true, dropped: true };
}
