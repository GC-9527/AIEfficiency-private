import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverVehicleSourceProjectRecommendation,
  resolveInitialTbProjectSelection,
} from "./tbProjectSelectionModel.mjs";

const projects = [
  { id: "project-empty" },
  { id: "project-configured" },
];

test("旧版自动保存的空项目会无感切换到唯一有车型配置的项目", () => {
  assert.deepEqual(resolveInitialTbProjectSelection({
    projects,
    previousProjectId: "project-empty",
    recommendedVehicleSourceProjectId: "project-configured",
  }), {
    projectId: "project-configured",
    explicitlySelected: false,
  });
});

test("用户明确选择的空项目不会被车型推荐覆盖", () => {
  assert.deepEqual(resolveInitialTbProjectSelection({
    projects,
    previousProjectId: "project-empty",
    recommendedVehicleSourceProjectId: "project-configured",
    explicitlySelected: true,
  }), {
    projectId: "project-empty",
    explicitlySelected: true,
  });
});

test("没有唯一车型项目时保留有效旧选择并兼容首项回退", () => {
  assert.equal(resolveInitialTbProjectSelection({
    projects,
    previousProjectId: "project-configured",
  }).projectId, "project-configured");
  assert.equal(resolveInitialTbProjectSelection({
    projects,
    previousProjectId: "removed-project",
  }).projectId, "project-empty");
});

test("旧 Gateway 只在全部只读探测成功且唯一项目有配置时推荐", async () => {
  assert.equal(await discoverVehicleSourceProjectRecommendation(projects, async (projectId) => ({
    ok: true,
    data: { vehicleMap: projectId === "project-configured" ? { avatr8678: {} } : {} },
  })), "project-configured");
  assert.equal(await discoverVehicleSourceProjectRecommendation(projects, async (projectId) => (
    projectId === "project-empty"
      ? { ok: false }
      : { ok: true, data: { vehicleMap: { avatr8678: {} } } }
  )), "");
});
