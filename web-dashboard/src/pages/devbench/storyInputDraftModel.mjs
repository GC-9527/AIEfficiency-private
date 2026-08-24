const stringValue = (value) => String(value ?? "");

export function storyInputDraftStorageKey(tabId) {
  return `devbench_input_${String(tabId || "")}`;
}

export function resolveStoryInputSubmission({
  submission,
  currentValue = "",
  currentRevision = 0,
  ok = false,
  restoreAllowed = true,
} = {}) {
  const value = stringValue(currentValue);
  const unchangedSinceClear = !!submission
    && Number(currentRevision) === Number(submission.clearedRevision)
    && value === "";

  if (!ok && restoreAllowed && unchangedSinceClear) {
    return {
      value: stringValue(submission.value),
      restored: true,
      unchangedSinceClear: true,
    };
  }

  return {
    value,
    restored: false,
    unchangedSinceClear,
  };
}

export function mergeStoryDraftAttachments(submitted = [], current = []) {
  const result = [];
  const seen = new Set();
  for (const attachment of [...(Array.isArray(submitted) ? submitted : []), ...(Array.isArray(current) ? current : [])]) {
    if (!attachment || typeof attachment !== "object") continue;
    const identity = String(
      attachment.id
      || attachment.relPath
      || attachment.storageName
      || attachment.name
      || "",
    );
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    result.push(attachment);
  }
  return result;
}
