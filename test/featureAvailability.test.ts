import assert from "node:assert/strict";
import test from "node:test";
import {
  getDeviceManagementAvailability,
  requireDeviceManagement,
  setDeviceManagementAvailability,
} from "../src/services/featureAvailability.ts";

test("设备管理关闭后拒绝新操作并保留维护原因", () => {
  setDeviceManagementAvailability({ enabled: false, reason: "设备服务维护中" });
  assert.deepEqual(getDeviceManagementAvailability(), {
    enabled: false,
    reason: "设备服务维护中",
  });
  assert.throws(() => requireDeviceManagement(), /设备服务维护中/);
});

test("设备管理开启时允许操作", () => {
  setDeviceManagementAvailability({ enabled: true, reason: null });
  assert.doesNotThrow(() => requireDeviceManagement());
});
