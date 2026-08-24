const TB_TASK_ID_RE = /^[0-9a-f]{24}$/i;
const TB_NUMBER_RE = /^(?:CARB-)?(\d+)$/i;

function taskIdFromUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(url.protocol)) return "";
  const host = url.hostname.toLowerCase();
  if (host !== "teambition.com" && !host.endsWith(".teambition.com")) return "";
  const match = url.pathname.match(/\/task\/([0-9a-f]{24})(?:\/|$)/i);
  return match?.[1] || "";
}

/**
 * 新建故事点/待办共用的 TB 输入约束：CARB-123、123 或 task/<24位id> 链接。
 * 返回规范化 lookup，交给既有 Teambition 查询链路继续解析。
 */
export function parseTbTaskEntryInput(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return { ok: false, code: "TB_INPUT_REQUIRED", error: "请输入 TB 单号或 TB 单链接" };
  }

  const number = raw.match(TB_NUMBER_RE);
  if (number) {
    return {
      ok: true,
      kind: "number",
      lookup: `CARB-${number[1]}`,
      display: `CARB-${number[1]}`,
    };
  }

  const taskId = taskIdFromUrl(raw);
  if (taskId && TB_TASK_ID_RE.test(taskId)) {
    return {
      ok: true,
      kind: "link",
      taskId,
      lookup: `https://www.teambition.com/task/${taskId}`,
      display: `TB task/${taskId}`,
    };
  }

  return {
    ok: false,
    code: "TB_INPUT_INVALID",
    error: "格式不正确，请输入 CARB-12345、12345，或完整的 Teambition 任务链接",
  };
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 10) : null;
}

/**
 * 把单条 TB 详情转成 devbench 故事点/待办都能消费的稳定字段。
 */
export function buildTbTaskEntryPayload(resolved = {}, detail = {}) {
  const tbTaskId = String(firstValue(
    resolved.tbTaskId,
    detail._id,
    detail.taskId,
    detail.id,
  ) || "").trim();
  const uniqueId = firstValue(detail.uniqueId, detail.uniqueID);
  const carbId = String(firstValue(
    resolved.carbId,
    uniqueId !== undefined ? `CARB-${uniqueId}` : "",
    String(firstValue(detail.content, detail.title) || "").match(/\bCARB-\d+\b/i)?.[0],
  ) || "").toUpperCase();
  const projectId = String(firstValue(
    detail.projectId,
    detail._projectId,
    detail.project?._id,
    detail.project?.id,
  ) || "").trim();
  const tasklistId = String(firstValue(
    detail.tasklistId,
    detail._tasklistId,
    detail.tasklist?._id,
    detail.tasklist?.id,
  ) || "").trim();
  const sprintId = String(firstValue(
    detail.sprintId,
    detail._sprintId,
    detail.sprint?._id,
    detail.sprint?.id,
  ) || "").trim();

  return {
    tbTaskId,
    carbId: carbId || null,
    title: String(firstValue(resolved.title, detail.content, detail.title, carbId, tbTaskId) || "").trim(),
    ticketUrl: resolved.ticketUrl || (tbTaskId ? `https://www.teambition.com/task/${tbTaskId}` : ""),
    projectId: projectId || null,
    projectName: String(firstValue(detail.project?.name, detail.projectName) || "").trim() || null,
    tasklistId: tasklistId || null,
    tasklistName: String(firstValue(detail.tasklist?.title, detail.tasklist?.name, detail.tasklistName) || "").trim() || null,
    sprintId: sprintId || null,
    sprintName: String(firstValue(detail.sprint?.name, detail.sprint?.title, detail.sprintName) || "").trim() || null,
    sprintDueDate: dateOnly(firstValue(detail.sprint?.dueDate, detail.sprintDueDate)),
    sprintStatus: firstValue(detail.sprint?.status, detail.sprintStatus) || null,
    statusName: String(firstValue(
      detail.taskflowstatus?.name,
      detail.statusName,
      typeof detail.status === "string" ? detail.status : "",
    ) || "").trim() || null,
    priority: detail.priority ?? null,
    deadline: dateOnly(firstValue(detail.dueDate, detail.deadline)),
  };
}
