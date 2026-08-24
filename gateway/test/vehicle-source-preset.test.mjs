import assert from "node:assert/strict";
import test from "node:test";

import { getAndroidFlavorInfoFromFiles } from "../services/devbench/store.js";
import {
  APP_MARKET_VEHICLE_PRESET_POLICY,
  buildVehicleSourcePresetSuggestions,
} from "../services/devbench/vehicle-source-preset.js";

test("远程车型文件解析：flavorConfig 优先，Gradle 仅取 car 维度", () => {
  assert.deepEqual(getAndroidFlavorInfoFromFiles({
    "flavorConfig.json": JSON.stringify({ jsonCar: { versionName: "1.0.0" } }),
    "project_flavor.gradle": "android { productFlavors { gradleCar { dimension 'car' } } }",
  }), {
    isAndroid: true,
    flavors: ["jsonCar"],
    source: "flavorConfig.json",
    errors: [],
  });

  const gradle = getAndroidFlavorInfoFromFiles({
    "project_flavor.gradle": `
      android {
        flavorDimensions "car", "env"
        productFlavors {
          carA { dimension "car" }
          carB { dimension "car" }
          prod { dimension "env" }
        }
      }
    `,
  });
  assert.deepEqual(gradle.flavors, ["carA", "carB"]);
  assert.deepEqual(gradle.buildVariants, ["carAProd", "carBProd"]);
});

test("仓库订阅生成：扫描应用市场规则、按应用聚合并为其它仓库保留手工映射", async () => {
  const scanCalls = [];
  const result = await buildVehicleSourcePresetSuggestions({
    subscriptions: [
      { name: "应用市场", repositories: [{ repositoryId: "appMarket" }, { repositoryId: "weather" }] },
      { name: "桌面市场", repositories: [{ repositoryId: "appMarket" }] },
    ],
    projectDefs: [
      { id: "appMarket", name: "应用市场仓库", https: "https://example.com/AppMarket.git" },
      { id: "weather", name: "天气", ssh: "git@example.com:Weather.git" },
    ],
    scanRemote: async (remote, options) => {
      scanCalls.push({ remote, options });
      return {
        ok: true,
        transport: "https",
        matchedBranches: ["release/car-a", "v202601", "v202605-ui"],
        branches: [
          {
            branch: "release/car-a",
            files: {
              "flavorConfig.json": JSON.stringify({ carA: {}, sharedCar: {} }),
              "project_flavor.gradle": "android { productFlavors { ignoredGradleCar {} } }",
            },
            fileErrors: [],
          },
          {
            branch: "v202605-ui",
            files: { "project_flavor.gradle": "android { productFlavors { carB { dimension 'car' } } }" },
            fileErrors: [],
          },
          {
            branch: "v202601",
            files: {
              "flavorConfig.json": "{ invalid",
              "app/project_flavor.gradle": "android { productFlavors { carC { dimension 'car' } } }",
            },
            fileErrors: [],
          },
        ],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(scanCalls.length, 1, "同一仓库被多个应用订阅时只能扫描一次");
  assert.deepEqual(scanCalls[0].options.branchPatterns, [...APP_MARKET_VEHICLE_PRESET_POLICY.branchPatterns]);
  assert.deepEqual(Object.keys(result.vehicleMap), ["carA", "carB", "carC", "sharedCar"]);
  assert.deepEqual(result.vehicleMap.carA.apps.map((app) => app.appName), ["应用市场", "桌面市场"]);
  assert.deepEqual(result.vehicleMap.carA.apps[0].repos, [
    { repoId: "appMarket", branch: "release/car-a", flavor: "carA" },
  ]);
  assert.equal(result.report.generatedMappings, 8);
  assert.equal(result.report.skippedRepositories[0].repositoryId, "weather");
  assert.match(result.report.warnings.join("\n"), /flavorConfig\.json 解析失败/);
});

test("仓库订阅生成：唯一自动仓库扫描失败时返回显式错误而不是空车型", async () => {
  const result = await buildVehicleSourcePresetSuggestions({
    subscriptions: [{ name: "应用市场", repositories: [{ repositoryId: "appMarket" }] }],
    projectDefs: [{ id: "appMarket", name: "应用市场", ssh: "git@example.com:AppMarket.git" }],
    scanRemote: async () => ({ ok: false, error: "publickey" }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "VEHICLE_PRESET_SCAN_FAILED");
  assert.match(result.error, /publickey/);
  assert.deepEqual(result.vehicleMap, {});
});

test("仓库订阅生成：分支 tuple 保持 Git 大小写语义", async () => {
  const result = await buildVehicleSourcePresetSuggestions({
    subscriptions: [{ name: "应用市场", repositories: [{ repositoryId: "appMarket" }] }],
    projectDefs: [{ id: "appMarket", name: "应用市场", https: "https://example.com/AppMarket.git" }],
    scanRemote: async () => ({
      ok: true,
      matchedBranches: ["release/car-a", "release/Car-A"],
      branches: ["release/car-a", "release/Car-A"].map((branch) => ({
        branch,
        files: { "flavorConfig.json": JSON.stringify({ carA: {} }) },
        fileErrors: [],
      })),
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.vehicleMap.carA.apps[0].repos.map((repository) => repository.branch), [
    "release/car-a",
    "release/Car-A",
  ]);
});
