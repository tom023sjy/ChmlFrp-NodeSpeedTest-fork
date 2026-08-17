import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DEVICE_PAIR,
  loadDevicePair,
  saveDevicePair,
} from "../src/services/devicePairStorage.ts";

test("设备对按账号保存并可恢复", () => {
  const storage = new Map<string, string>();
  const pair = {
    senderId: "device-a",
    senderName: "设备 A",
    receiverId: "device-b",
    receiverName: "设备 B",
  };

  saveDevicePair(storage, "alice", pair);

  assert.deepEqual(loadDevicePair(storage, "alice"), pair);
  assert.deepEqual(loadDevicePair(storage, "bob"), DEFAULT_DEVICE_PAIR);
});

test("设备对缓存损坏或字段不完整时回退本机自测", () => {
  const storage = new Map<string, string>([
    ["node_test_pair__alice", JSON.stringify({ senderId: "device-a" })],
  ]);

  assert.deepEqual(loadDevicePair(storage, "alice"), DEFAULT_DEVICE_PAIR);
});
