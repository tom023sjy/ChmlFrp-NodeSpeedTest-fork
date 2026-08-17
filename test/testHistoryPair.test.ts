import assert from "node:assert/strict";
import test from "node:test";
import {
  addTestHistory,
  getNodeTestHistory,
  type TestHistoryRecord,
} from "../src/services/testHistoryService.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const pairAB = {
  senderId: "A",
  senderName: "设备 A",
  receiverId: "B",
  receiverName: "设备 B",
};

const pairBA = {
  senderId: "B",
  senderName: "设备 B",
  receiverId: "A",
  receiverName: "设备 A",
};

function record(timestamp: number, pair?: typeof pairAB): TestHistoryRecord {
  return {
    nodeName: "节点 1",
    nodeId: 1,
    timestamp,
    latency: timestamp,
    success: true,
    ...(pair ?? {}),
  } as TestHistoryRecord;
}

test("历史记录隔离 A→B 与 B→A", () => {
  globalThis.localStorage = new MemoryStorage() as Storage;
  addTestHistory(record(1, pairAB), "alice");
  addTestHistory(record(2, pairBA), "alice");

  assert.deepEqual(getNodeTestHistory("节点 1", "alice", pairAB).map((item) => item.timestamp), [1]);
  assert.deepEqual(getNodeTestHistory("节点 1", "alice", pairBA).map((item) => item.timestamp), [2]);
});

test("旧历史记录迁移为本机→本机", () => {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage as Storage;
  storage.setItem("node_test_history", JSON.stringify([record(1)]));

  const history = getNodeTestHistory("节点 1", "alice", {
    senderId: "local",
    senderName: "本机",
    receiverId: "local",
    receiverName: "本机",
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].pairKey, "local__local");
});

test("每个节点每个有向设备对最多保留 50 条历史", () => {
  globalThis.localStorage = new MemoryStorage() as Storage;
  for (let timestamp = 1; timestamp <= 51; timestamp += 1) {
    addTestHistory(record(timestamp, pairAB), "alice");
  }

  const history = getNodeTestHistory("节点 1", "alice", pairAB);
  assert.equal(history.length, 50);
  assert.equal(history[0].timestamp, 51);
  assert.equal(history.at(-1)?.timestamp, 2);
});
