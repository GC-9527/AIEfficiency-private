import { isStoryArtifactRef } from "./storyMessageModel.mjs";

const STORY_ARTIFACT_CANDIDATE = /storydev:\/[^\s<>"')\]]+/gi;

export function storyArtifactRefsInText(value) {
  const text = String(value || "");
  const refs = [];
  const seen = new Set();
  for (const match of text.matchAll(STORY_ARTIFACT_CANDIDATE)) {
    const raw = String(match[0] || "").replace(/[.,;!?，。；！？]+$/u, "");
    if (!isStoryArtifactRef(raw)) continue;
    const ref = `storydev:${raw.slice(raw.indexOf(":") + 1)}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

export function chunkArtifactRefs(refs, maximum = 100) {
  const size = Math.max(1, Math.min(100, Math.trunc(Number(maximum) || 100)));
  const values = Array.isArray(refs) ? refs : [];
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function acceptedArtifactTickets(response, requestedRefs = []) {
  const allowed = new Set((Array.isArray(requestedRefs) ? requestedRefs : []).map(String));
  const result = {};
  if (response?.ok !== true || !Array.isArray(response?.data?.items)) return result;
  for (const item of response.data.items) {
    const ref = String(item?.ref || "");
    const ticket = String(item?.ticket || "");
    const expiresAt = Number(item?.expiresAt || 0);
    if (
      !allowed.has(ref)
      || !isStoryArtifactRef(ref)
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(ticket)
      || !Number.isSafeInteger(expiresAt)
      || expiresAt <= Date.now()
    ) continue;
    result[ref] = { ticket, expiresAt };
  }
  return result;
}
