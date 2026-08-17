import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMbps,
  createSpeedSample,
  normalizeDurationSeconds,
} from "../src/services/speedSamples.ts";

test("按十进制 Mbps 计算窗口速度", () => {
  assert.equal(calculateMbps(1_000_000, 1_000), 8);
  assert.equal(calculateMbps(750_000, 1_500), 4);
});

test("零时长窗口返回零速率", () => {
  assert.equal(calculateMbps(1_000_000, 0), 0);
  assert.equal(calculateMbps(1_000_000, -1), 0);
});

test("生成逐秒采样并保留实际窗口时长", () => {
  assert.deepEqual(createSpeedSample(2, 1_500_000, 1_000), {
    second: 2,
    bytes: 1_500_000,
    durationMs: 1_000,
    mbps: 12,
  });
});

test("测试时长限制在五到一百二十秒", () => {
  assert.equal(normalizeDurationSeconds(undefined), 15);
  assert.equal(normalizeDurationSeconds(3), 5);
  assert.equal(normalizeDurationSeconds(15.8), 15);
  assert.equal(normalizeDurationSeconds(121), 120);
});
