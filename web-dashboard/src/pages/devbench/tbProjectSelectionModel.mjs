function text(value) {
  return String(value || "").trim();
}

/**
 * Preserve an explicit user choice. For legacy/automatic selections, prefer
 * the sole visible TB project that already contains synchronized vehicle data.
 */
export function resolveInitialTbProjectSelection({
  projects = [],
  previousProjectId = "",
  recommendedVehicleSourceProjectId = "",
  explicitlySelected = false,
} = {}) {
  const visibleIds = [...new Set((Array.isArray(projects) ? projects : [])
    .map((project) => text(project?.id))
    .filter(Boolean))];
  const previous = text(previousProjectId);
  const recommended = text(recommendedVehicleSourceProjectId);
  const previousIsVisible = visibleIds.includes(previous);
  const recommendedIsVisible = visibleIds.includes(recommended);

  if (explicitlySelected && previousIsVisible) {
    return { projectId: previous, explicitlySelected: true };
  }
  if (recommendedIsVisible) {
    return { projectId: recommended, explicitlySelected: false };
  }
  return {
    projectId: previousIsVisible ? previous : (visibleIds[0] || ""),
    explicitlySelected: false,
  };
}

/**
 * Rolling-upgrade fallback for an older Gateway that does not yet expose the
 * lightweight recommendation metadata. Any failed project read makes the
 * result indeterminate, so the caller keeps the existing selection.
 */
export async function discoverVehicleSourceProjectRecommendation(projects = [], loadProjectConfig) {
  if (typeof loadProjectConfig !== "function") return "";
  const visibleIds = [...new Set((Array.isArray(projects) ? projects : [])
    .map((project) => text(project?.id))
    .filter(Boolean))];
  const results = await Promise.all(visibleIds.map(async (projectId) => {
    try {
      const result = await loadProjectConfig(projectId);
      if (!result?.ok) return { projectId, available: false, configured: false };
      const vehicleMap = result.data?.vehicleMap;
      return {
        projectId,
        available: true,
        configured: vehicleMap && typeof vehicleMap === "object" && Object.keys(vehicleMap).length > 0,
      };
    } catch {
      return { projectId, available: false, configured: false };
    }
  }));
  if (results.some((result) => !result.available)) return "";
  const configuredIds = results.filter((result) => result.configured).map((result) => result.projectId);
  return configuredIds.length === 1 ? configuredIds[0] : "";
}
