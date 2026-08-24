import { ToolkitError, redactErrorMessage } from "../../../packages/tb-domain/src/index.js";

export const AIEFFICIENCY_ADAPTER_MODES = Object.freeze(["off", "shadow", "canonical"]);

function normalizeMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  if (!AIEFFICIENCY_ADAPTER_MODES.includes(mode)) {
    throw new ToolkitError("ADAPTER_MODE_INVALID", `unsupported AIEfficiency adapter mode: ${mode}`);
  }
  return mode;
}

function legacyCounts(snapshot = {}) {
  return {
    comments: Array.isArray(snapshot.comments) ? snapshot.comments.length : Number(snapshot.comments || 0),
    attachments: Array.isArray(snapshot.attachments) ? snapshot.attachments.length : Number(snapshot.attachments || 0),
  };
}

function canonicalCounts(context = {}) {
  return {
    comments: Array.isArray(context.comments) ? context.comments.length : 0,
    attachments: Array.isArray(context.attachments) ? context.attachments.length : 0,
  };
}

function compareReadModels(legacySnapshot, canonicalResult) {
  const legacy = legacyCounts(legacySnapshot);
  const canonical = canonicalCounts(canonicalResult?.context);
  return {
    matched: legacy.comments === canonical.comments && legacy.attachments === canonical.attachments,
    legacy,
    canonical,
    canonicalContextDigest: canonicalResult?.context?.contextDigest || "",
    officialCoverage: canonicalResult?.snapshot?.officialCoverage || null,
    supplementalCoverage: canonicalResult?.snapshot?.supplementalCoverage || null,
  };
}

export function createAiefficiencyAdapter({
  application,
  mode = "off",
  legacyReader,
  legacyWriter,
} = {}) {
  const selectedMode = normalizeMode(mode);
  if (typeof legacyReader !== "function") throw new ToolkitError("ADAPTER_CONFIG_INVALID", "legacyReader is required");
  if (selectedMode !== "off" && !application) throw new ToolkitError("ADAPTER_CONFIG_INVALID", "canonical application is required");

  return Object.freeze({
    mode: selectedMode,
    async read(taskRef) {
      if (selectedMode === "canonical") return application.readContext(taskRef);
      const legacy = await legacyReader(taskRef);
      if (selectedMode === "off") return { source: "legacy", value: legacy, shadow: null };
      try {
        const canonical = await application.readContext(taskRef);
        return { source: "legacy", value: legacy, shadow: { ok: true, ...compareReadModels(legacy, canonical) } };
      } catch (error) {
        return {
          source: "legacy",
          value: legacy,
          shadow: { ok: false, error: { code: error?.code || "SHADOW_READ_FAILED", message: redactErrorMessage(error) } },
        };
      }
    },
    async update(input) {
      if (selectedMode === "canonical") {
        if (!input?.plan) throw new ToolkitError("INVALID_ARGUMENT", "canonical update requires plan input");
        return application.updateApply(input.plan);
      }
      if (typeof legacyWriter !== "function") throw new ToolkitError("WRITE_DISABLED", "legacyWriter is not configured");
      // Shadow mode deliberately uses exactly the legacy writer. The canonical
      // application is read-only here, so one user action cannot become two writes.
      return legacyWriter(input);
    },
  });
}

