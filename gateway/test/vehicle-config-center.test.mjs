import assert from "node:assert/strict";
import test from "node:test";

import { resolveVehicleConfigCenter } from "../services/vehicle-config-center.js";

test("车型配置中心与 AI 代理开关解耦", () => {
  const result = resolveVehicleConfigCenter({
    role: "standalone",
    vehicleConfigCenter: {
      enabled: true,
      host: "http://192.168.10.110:3001/",
      token: "vehicle-m2m-token",
    },
    claudeProxyClient: { enabled: false, host: "", token: "" },
  }, { role: "standalone", syncMode: "disabled" });

  assert.deepEqual(result, {
    mode: "center",
    source: "vehicle-config",
    base: "http://192.168.10.110:3001",
    token: "vehicle-m2m-token",
  });
});

test("显式中心缺地址或口令时失败关闭，不回退旧本地配置", () => {
  assert.equal(resolveVehicleConfigCenter({
    vehicleConfigCenter: { enabled: true, host: "", token: "token" },
  }, { syncMode: "disabled" }).code, "VEHICLE_CONFIG_CENTER_HOST_REQUIRED");

  assert.equal(resolveVehicleConfigCenter({
    vehicleConfigCenter: { enabled: true, host: "http://center.example:3001", token: "" },
  }, { syncMode: "disabled" }).code, "VEHICLE_CONFIG_CENTER_TOKEN_REQUIRED");

  assert.equal(resolveVehicleConfigCenter({
    vehicleConfigCenter: { enabled: true, host: "http://center.example:3001", token: "token" },
  }, { syncMode: "disabled", selfOrigins: ["http://center.example:3001/"] }).code, "VEHICLE_CONFIG_CENTER_SELF_REFERENCE");
});

test("安全 peer 同步优先，未配置显式中心时保留旧 AI 中心兼容", () => {
  assert.deepEqual(resolveVehicleConfigCenter({
    vehicleConfigCenter: { enabled: true, host: "http://center.example:3001", token: "token" },
  }, { syncMode: "peer" }), { mode: "local", reason: "peer-sync" });

  const legacy = resolveVehicleConfigCenter({
    role: "node",
    claudeProxyClient: { enabled: true, host: "http://legacy.example:3001", token: "legacy-token" },
  }, { role: "node", syncMode: "disabled" });
  assert.deepEqual(legacy, {
    mode: "center",
    source: "legacy-ai",
    base: "http://legacy.example:3001",
  });
});
