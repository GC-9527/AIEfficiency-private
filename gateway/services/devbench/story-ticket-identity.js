import { createHash } from "node:crypto";

const text = (value) => String(value ?? "").trim();

function normalizedTbTaskId(value) {
  const raw = text(value);
  const direct = raw.match(/^[0-9a-f]{24}$/i)?.[0];
  const fromUrl = raw.match(/(?:^|\/)task\/([0-9a-f]{24})(?:$|[/?#])/i)?.[1];
  return text(direct || fromUrl).toLowerCase();
}

function normalizedCarbId(value) {
  return (text(value).match(/#\s*(CARB-\d+)\s*#/i)?.[1]
    || text(value).match(/\bCARB-\d+\b/i)?.[0]
    || "").toUpperCase();
}

function normalizedExplicitUrl(value) {
  const raw = text(value);
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    const parsed = new URL(raw);
    // Fragments are client-only navigation and must not create a second story
    // identity for the same explicit source URL.
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function urlIdentity(value) {
  const normalized = normalizedExplicitUrl(value);
  if (!normalized) return "";
  return `url:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

/**
 * Return every stable alias that represents an explicitly bound story ticket.
 * A generic URL is hashed so active/closed-story uniqueness and AI review
 * scopes can bind it without persisting the raw URL in fingerprints.
 */
export function storyTicketIdentities(ticket = {}) {
  const source = ticket && typeof ticket === "object" ? ticket : { ticketUrl: ticket };
  // A CARB token retained only for naming is not an explicit ticket binding.
  if (source.ticketBound === false || source.inputProvided === false) return [];
  const explicitUrlValue = [source.ticketUrl, source.url]
    .map(normalizedExplicitUrl)
    .find(Boolean);
  const tbTaskId = [source.tbTaskId, source.ticketUrl, source.url, source.ticketId]
    .map(normalizedTbTaskId)
    .find(Boolean);
  const explicitCarbId = normalizedCarbId(source.carbId);
  const urlCarbId = [source.ticketUrl, source.url].map(normalizedCarbId).find(Boolean);
  // When a generic URL is explicitly supplied, ticketId can still contain the
  // CARB token derived from the story title solely for worktree naming. In that
  // shape the URL, not the title hint, is the bound source identity. Callers
  // with a real separate CARB identity must provide carbId explicitly.
  const genericUrl = explicitUrlValue && !tbTaskId && !explicitCarbId && !urlCarbId;
  const carbId = genericUrl
    ? ""
    : (explicitCarbId || normalizedCarbId(source.ticketId) || urlCarbId);
  // Prefer first-class TB/CARB aliases. A URL hash is the stable fallback for
  // explicit sources that do not expose either known business identifier.
  const explicitUrl = !tbTaskId && !carbId && explicitUrlValue
    ? urlIdentity(explicitUrlValue)
    : "";
  return [...new Set([
    ...(tbTaskId ? [`tb-task:${tbTaskId}`] : []),
    ...(carbId ? [`carb:${carbId}`] : []),
    ...(explicitUrl ? [explicitUrl] : []),
  ])];
}
