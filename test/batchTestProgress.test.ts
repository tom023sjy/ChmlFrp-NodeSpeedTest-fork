import assert from "node:assert/strict";
import test from "node:test";
import { calculateBatchOverallPercent } from "../src/services/batchTestProgress.ts";

test("单节点总体进度直接使用当前节点真实进度", () => {
  assert.equal(calculateBatchOverallPercent(0, 1, 60), 60);
});

test("多节点总体进度累计已完成节点和当前节点真实进度", () => {
  assert.equal(calculateBatchOverallPercent(1, 2, 40), 70);
});

test("总体进度限制在有效百分比范围内", () => {
  assert.equal(calculateBatchOverallPercent(0, 1, -10), 0);
  assert.equal(calculateBatchOverallPercent(0, 1, 120), 100);
});
