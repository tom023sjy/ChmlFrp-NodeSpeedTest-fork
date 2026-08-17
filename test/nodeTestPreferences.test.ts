import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateStatistic,
  getStoredDurationSeconds,
  getStoredStatisticMode,
  setStoredDurationSeconds,
  setStoredStatisticMode,
} from "../src/services/nodeTestPreferences.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("延迟默认使用平均值，带宽默认使用最大值，并拒绝无效存储值", () => {
  const storage = new MemoryStorage();
  assert.equal(getStoredStatisticMode(storage, "latency"), "avg");
  assert.equal(getStoredStatisticMode(storage, "speed"), "max");
  storage.setItem("nodeTestLatencyStatisticMode", "unknown");
  assert.equal(getStoredStatisticMode(storage, "latency"), "avg");
});

test("延迟和带宽统计模式分别持久化", () => {
  const storage = new MemoryStorage();
  setStoredStatisticMode(storage, "latency", "min");
  setStoredStatisticMode(storage, "speed", "avg");
  assert.equal(getStoredStatisticMode(storage, "latency"), "min");
  assert.equal(getStoredStatisticMode(storage, "speed"), "avg");
});

test("统计聚合忽略空值和非有限值", () => {
  const samples = [24, null, 12, Number.NaN, 18];
  assert.equal(aggregateStatistic(samples, "max", 99), 24);
  assert.equal(aggregateStatistic(samples, "avg", 99), 18);
  assert.equal(aggregateStatistic(samples, "min", 99), 12);
  assert.equal(aggregateStatistic([null, Number.NaN], "max", 99), 99);
});

test("测速时长持久化并限制在五到一百二十秒", () => {
  const storage = new MemoryStorage();
  assert.equal(getStoredDurationSeconds(storage), 15);
  assert.equal(setStoredDurationSeconds(storage, 30), 30);
  assert.equal(getStoredDurationSeconds(storage), 30);
  assert.equal(setStoredDurationSeconds(storage, 2), 5);
  assert.equal(setStoredDurationSeconds(storage, 150), 120);
});
