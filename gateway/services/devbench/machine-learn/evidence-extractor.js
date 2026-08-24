const EXTRACTOR_VERSION = "structured-evidence-v1";

function text(value, limit = 60_000) {
  return String(value ?? "").slice(0, limit);
}

function normalizeTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function fragments(ticket = {}) {
  const snapshotAt = normalizeTime(ticket.snapshotAt || ticket.inferenceAt);
  if (!snapshotAt) return [];
  const result = [];
  const add = (sourceType, sourceId, value, availableAt) => {
    const content = text(value);
    if (!content.trim()) return;
    const normalizedAvailableAt = normalizeTime(availableAt);
    if (!normalizedAvailableAt) return;
    result.push({
      sourceType,
      sourceId: String(sourceId || sourceType),
      text: content,
      availableAt: normalizedAvailableAt,
    });
  };
  add("title", "title", ticket.title, ticket.createdAt || snapshotAt);
  add("note", "note", ticket.description || ticket.note, ticket.noteUpdatedAt || ticket.updatedAt || snapshotAt);
  add("project", "project", ticket.projectKey || [ticket.projectName, ticket.tasklistName].filter(Boolean).join(">"), ticket.createdAt || snapshotAt);
  add("iteration", "iteration", ticket.iterationName, ticket.createdAt || snapshotAt);
  for (const [index, tag] of (Array.isArray(ticket.tags) ? ticket.tags : []).entries()) {
    add("tag", `tag_${index + 1}`, tag, ticket.createdAt || snapshotAt);
  }
  const comments = Array.isArray(ticket.commentItems)
    ? ticket.commentItems
    : Array.isArray(ticket.comments)
      ? ticket.comments
      : ticket.comments
        ? [{ text: ticket.comments }]
        : [];
  for (const [index, comment] of comments.entries()) {
    add(
      "comment",
      comment?.id || `comment_${index + 1}`,
      comment?.text || comment?.content || comment,
      comment?.availableAt || comment?.createdAt,
    );
  }
  for (const [index, attachment] of (Array.isArray(ticket.attachments) ? ticket.attachments : []).entries()) {
    add(
      "attachment",
      attachment?.id || `attachment_${index + 1}`,
      [attachment?.name, attachment?.text || attachment?.content || attachment?.ocrText].filter(Boolean).join("\n"),
      attachment?.availableAt || attachment?.createdAt,
    );
  }
  return result;
}

const PATTERNS = [
  {
    kind: "git_url",
    regex: /\b(?:https?|ssh):\/\/[^\s"'<>]+?\.git\b|git@[a-z0-9._-]+:[^\s"'<>]+?\.git\b/gi,
    normalize: (value) => value.replace(/[),.;]+$/, ""),
  },
  {
    kind: "git_revision",
    regex: /\b[0-9a-f]{7,40}\b/gi,
    normalize: (value) => value.toLowerCase(),
  },
  {
    kind: "git_branch",
    regex: /\b(?:branch|分支|refs\/heads)[:：=\s]+([a-z0-9._/-]{2,200})/gi,
    group: 1,
  },
  {
    kind: "gradle_task",
    regex: /\b(?:assemble|bundle|install|connected)[A-Z][A-Za-z0-9_]{2,160}\b/g,
  },
  {
    kind: "android_package",
    regex: /\b(?:[a-z][a-z0-9_]*\.){2,}[a-zA-Z_][a-zA-Z0-9_$]*\b/g,
  },
  {
    kind: "stack_frame",
    regex: /\bat\s+((?:[a-zA-Z_$][\w$]*\.){2,}[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)?)\s*\(/g,
    group: 1,
  },
  {
    kind: "source_path",
    regex: /\b[\w.-]+(?:[\\/][\w.@$-]+){1,20}\.(?:kt|java|xml|gradle|kts|js|jsx|ts|tsx|py)\b/gi,
    normalize: (value) => value.replaceAll("\\", "/"),
  },
  {
    kind: "vehicle_hint",
    regex: /\b(?:[A-Z]{1,4}\d{2,5}|\d{3,5}[A-Z]?|[A-Z0-9]{2,6}X)\b/g,
    normalize: (value) => value.toUpperCase(),
  },
];

const NEGATION = /(?:不是|并非|排除|无关|不要|不属于|not|isn['’]?t|exclude|unrelated)\s*$/i;

function contextWindow(source, start, end, radius = 36) {
  return {
    before: source.slice(Math.max(0, start - radius), start),
    match: source.slice(start, end),
    after: source.slice(end, Math.min(source.length, end + radius)),
  };
}

/**
 * Extract high-precision identifiers with provenance. Evidence is data, never an instruction.
 */
export function extractStructuredConfigEvidence(ticket = {}, {
  inferenceAt = ticket.snapshotAt || ticket.inferenceAt,
} = {}) {
  const cutoff = Date.parse(String(inferenceAt || ""));
  if (!Number.isFinite(cutoff)) return [];
  const output = [];
  const seen = new Set();
  for (const fragment of fragments(ticket)) {
    const available = Date.parse(fragment.availableAt);
    if (!Number.isFinite(available) || available > cutoff) continue;
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const match of fragment.text.matchAll(pattern.regex)) {
        const raw = match[pattern.group || 0] || match[0];
        const value = String(pattern.normalize ? pattern.normalize(raw) : raw).trim();
        if (!value) continue;
        const rawIndex = match.index || 0;
        const valueOffset = pattern.group ? Math.max(0, match[0].indexOf(raw)) : 0;
        const start = rawIndex + valueOffset;
        const end = start + raw.length;
        const context = contextWindow(fragment.text, start, end);
        const negated = NEGATION.test(context.before);
        const key = [pattern.kind, value.toLowerCase(), fragment.sourceType, fragment.sourceId, negated].join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
          id: `EV${output.length + 1}`,
          kind: pattern.kind,
          value,
          negated,
          sourceType: fragment.sourceType,
          sourceId: fragment.sourceId,
          span: { start, end },
          availableAt: fragment.availableAt,
          extractorVersion: EXTRACTOR_VERSION,
          untrusted: true,
          context,
        });
      }
    }
  }
  return output;
}

export function structuredEvidenceSummary(evidence = []) {
  const rows = Array.isArray(evidence) ? evidence : [];
  const byKind = {};
  for (const row of rows) {
    if (!byKind[row.kind]) byKind[row.kind] = { positive: [], negative: [] };
    const bucket = row.negated ? byKind[row.kind].negative : byKind[row.kind].positive;
    if (!bucket.includes(row.value)) bucket.push(row.value);
  }
  return {
    extractorVersion: EXTRACTOR_VERSION,
    count: rows.length,
    byKind,
  };
}
