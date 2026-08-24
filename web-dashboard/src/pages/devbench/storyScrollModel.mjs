export const STORY_SCROLL_BOTTOM_THRESHOLD = 48;
export const STORY_SCROLL_PAGE_RATIO = 0.85;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function storyScrollDistanceFromBottom(metrics = {}) {
  const scrollHeight = Math.max(0, finiteNumber(metrics.scrollHeight));
  const clientHeight = Math.max(0, finiteNumber(metrics.clientHeight));
  const scrollTop = Math.max(0, finiteNumber(metrics.scrollTop));
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function storyScrollStatus(metrics, { forceFollowing = false, threshold = STORY_SCROLL_BOTTOM_THRESHOLD } = {}) {
  const distanceFromBottom = storyScrollDistanceFromBottom(metrics);
  const atBottom = distanceFromBottom <= Math.max(0, finiteNumber(threshold));
  return {
    atBottom,
    distanceFromBottom,
    following: forceFollowing || atBottom,
    showJumpToBottom: !forceFollowing && !atBottom,
  };
}

export function storyScrollKeyCommand(key) {
  if (key === "PageUp") return "page-up";
  if (key === "End") return "bottom";
  return "";
}

export function storyPageUpTarget(metrics = {}, ratio = STORY_SCROLL_PAGE_RATIO) {
  const scrollTop = Math.max(0, finiteNumber(metrics.scrollTop));
  const clientHeight = Math.max(0, finiteNumber(metrics.clientHeight));
  const safeRatio = Math.min(1, Math.max(0, finiteNumber(ratio)));
  const pageStep = Math.max(1, Math.floor(clientHeight * safeRatio));
  return Math.max(0, scrollTop - pageStep);
}
