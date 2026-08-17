import assert from "node:assert/strict";
import test from "node:test";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isCurrentSocket,
} from "../src/services/relayHeartbeat.ts";

test("心跳周期低于线上空闲超时", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 10_000);
  assert.ok(HEARTBEAT_INTERVAL_MS < 30_000);
  assert.equal(HEARTBEAT_TIMEOUT_MS, 60_000);
});

test("只有当前连接可以处理关闭事件", () => {
  const current = {};
  assert.equal(isCurrentSocket(current, current), true);
  assert.equal(isCurrentSocket(current, {}), false);
});
