function text(value) {
  return String(value || "").trim();
}

/**
 * Describe which visible TB projects already have a materialized vehicle-source
 * configuration. Project ids outside the caller's visible project list are
 * deliberately omitted.
 */
export function describeVehicleSourceProjects(projects = [], snapshot = {}) {
  const byProject = snapshot?.byProject && typeof snapshot.byProject === "object"
    ? snapshot.byProject
    : {};
  const visibleProjectIds = [...new Set((Array.isArray(projects) ? projects : [])
    .map((project) => text(project?.id))
    .filter(Boolean))];
  const vehicleSourceProjectIds = visibleProjectIds.filter((projectId) => {
    const vehicleMap = byProject[projectId];
    return vehicleMap && typeof vehicleMap === "object" && Object.keys(vehicleMap).length > 0;
  });
  return {
    vehicleSourceProjectIds,
    recommendedVehicleSourceProjectId: vehicleSourceProjectIds.length === 1
      ? vehicleSourceProjectIds[0]
      : "",
  };
}
