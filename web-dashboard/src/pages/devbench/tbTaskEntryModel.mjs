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
  return url.pathname.match(/\/task\/([0-9a-f]{24})(?:\/|$)/i)?.[1] || "";
}

export function parseTbTaskInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "请输入 TB 单号或 TB 单链接" };

  const number = raw.match(TB_NUMBER_RE);
  if (number) {
    const normalized = `CARB-${number[1]}`;
    return { ok: true, kind: "number", normalized, preview: normalized };
  }

  const taskId = taskIdFromUrl(raw);
  if (taskId) {
    return {
      ok: true,
      kind: "link",
      normalized: `https://www.teambition.com/task/${taskId}`,
      preview: `task/${taskId.slice(0, 6)}…${taskId.slice(-4)}`,
    };
  }

  return {
    ok: false,
    error: "格式不正确，请输入 CARB-12345、12345，或完整的 Teambition 任务链接",
  };
}
