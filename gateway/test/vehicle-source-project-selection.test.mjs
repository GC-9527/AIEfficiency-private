import test from "node:test";
import assert from "node:assert/strict";
import { describeVehicleSourceProjects } from "../services/devbench/vehicle-source-project-selection.js";

test("车型配置推荐只包含当前用户可见且确有车型数据的 TB 项目", () => {
  assert.deepEqual(describeVehicleSourceProjects([
    { id: "project-empty" },
    { id: "project-configured" },
  ], {
    byProject: {
      "project-empty": {},
      "project-configured": { avatr8678: { apps: [] } },
      "project-hidden": { geelyp162: { apps: [] } },
    },
  }), {
    vehicleSourceProjectIds: ["project-configured"],
    recommendedVehicleSourceProjectId: "project-configured",
  });
});

test("多个项目都有车型配置时不擅自推荐跨项目切换", () => {
  assert.deepEqual(describeVehicleSourceProjects([
    { id: "project-a" },
    { id: "project-b" },
  ], {
    byProject: {
      "project-a": { carA: {} },
      "project-b": { carB: {} },
    },
  }), {
    vehicleSourceProjectIds: ["project-a", "project-b"],
    recommendedVehicleSourceProjectId: "",
  });
});
