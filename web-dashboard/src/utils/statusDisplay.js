export const PLAYING_DISPLAY_VARIANTS = [
  "Jamming",
  "Vibing",
  "Grooving",
  "Chilling to",
  "Rocking out",
  "Blasting",
  "Cranking",
  "Humming along",
  "Spinning",
  "Serenading",
];

const DEFAULT_STATUS_LABELS = {
  idle: "Idle",
  pending: "Pending",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
  inspecting: "Inspecting",
  retrying: "Retrying",
  checking: "Checking...",
  error: "Error",
};

function hashSeed(value) {
  let hash = 0;
  const input = String(value || "running");
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getRunningDisplayLabel(seed = "") {
  const index = hashSeed(seed) % PLAYING_DISPLAY_VARIANTS.length;
  return PLAYING_DISPLAY_VARIANTS[index];
}

export function getStatusDisplayLabel(status, seed = "") {
  if (status === "running") {
    return getRunningDisplayLabel(seed);
  }
  return DEFAULT_STATUS_LABELS[status] || status || DEFAULT_STATUS_LABELS.pending;
}
