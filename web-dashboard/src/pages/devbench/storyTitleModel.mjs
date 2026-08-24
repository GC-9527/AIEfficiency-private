const text = (value) => String(value || "").trim();

/**
 * 故事点标题属于业务数据，必须保留来源工单的完整标题。
 * Tab 和归档路径如需缩略，应在各自的展示层或文件安全 slug 中处理。
 */
export function taskStoryTitle(task = null) {
  const carbId = text(task?.carbId);
  const sourceTitle = task?.title || "新故事点";
  return `${carbId ? `#${carbId}# ` : ""}${sourceTitle}`.trim();
}

export function repairStoryTitleCarbId(currentTitle, carbId) {
  const title = String(currentTitle || "");
  const nextCarbId = text(carbId);
  if (!title || !nextCarbId) return title;
  return title.replace(/^#CARB-\d+#/i, `#${nextCarbId}#`);
}
