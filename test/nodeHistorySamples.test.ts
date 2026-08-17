import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

const pair = {
  senderId: "A",
  senderName: "设备 A",
  receiverId: "B",
  receiverName: "设备 B",
};

test("历史记录持久化单次延迟与速度采样", () => {
  globalThis.localStorage = new MemoryStorage() as Storage;
  const record: TestHistoryRecord = {
    nodeName: "节点 1",
    nodeId: 1,
    timestamp: 1,
    latency: 20,
    downloadSpeed: 80,
    success: true,
    ...pair,
    pairKey: "A__B",
    latencySamples: [18, 20, null, 22],
    speedSamples: [
      { second: 1, bytes: 10_000_000, durationMs: 1_000, mbps: 80 },
      { second: 2, bytes: 11_000_000, durationMs: 1_000, mbps: 88 },
    ],
    jitterMs: 2,
    packetLossPercent: 25,
    testDurationSeconds: 2,
  };

  addTestHistory(record, "alice");
  const [stored] = getNodeTestHistory("节点 1", "alice", pair);
  assert.deepEqual(stored.latencySamples, [18, 20, null, 22]);
  assert.deepEqual(stored.speedSamples, record.speedSamples);
  assert.equal(stored.jitterMs, 2);
  assert.equal(stored.packetLossPercent, 25);
  assert.equal(stored.testDurationSeconds, 2);
});

test("旧记录保持无采样状态且不伪造数据", () => {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage as Storage;
  storage.setItem("node_test_history__alice", JSON.stringify([{
    nodeName: "节点 1",
    nodeId: 1,
    timestamp: 1,
    latency: 20,
    downloadSpeed: 80,
    success: true,
    ...pair,
    pairKey: "A__B",
  }]));

  const [stored] = getNodeTestHistory("节点 1", "alice", pair);
  assert.equal(stored.latencySamples, undefined);
  assert.equal(stored.speedSamples, undefined);
});

test("历史弹窗只展示最新单次测试的内部采样", async () => {
  const source = await readFile(
    new URL("../src/components/dialogs/NodeHistoryDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /latencySamples/);
  assert.match(source, /speedSamples/);
  assert.match(source, /单次延迟采样/);
  assert.match(source, /逐秒速度采样/);
  assert.match(source, /该记录没有采样数据/);
  assert.doesNotMatch(source, /最近 20 次/);
  assert.doesNotMatch(source, /延迟趋势|速度趋势/);
});

test("采样图表移除点击焦点框并使用主题化样式", async () => {
  const source = await readFile(
    new URL("../src/components/dialogs/NodeHistoryDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /recharts-wrapper.*outline-none/);
  assert.match(source, /recharts-surface.*outline-none/);
  assert.match(source, /stroke="var\(--color-border\)"/);
  assert.match(source, /axisLine=\{false\}/);
  assert.match(source, /contentStyle=/);
  assert.match(source, /activeDot=/);
});
