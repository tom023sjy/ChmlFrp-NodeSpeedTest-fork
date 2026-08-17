import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBatchTestCompletion,
  shouldClearBatchTestArtifacts,
} from "../src/services/batchTestCompletion.ts";

test("自然完成且全部节点成功时关闭测速弹窗", () => {
  assert.deepEqual(resolveBatchTestCompletion(3, 3, false, false), {
    allSucceeded: true,
    shouldShowLogs: false,
  });
});

test("自然完成但存在失败时显示测速日志", () => {
  assert.deepEqual(resolveBatchTestCompletion(3, 2, false, false), {
    allSucceeded: false,
    shouldShowLogs: true,
  });
});

test("停止或强制停止后保留测速日志", () => {
  assert.equal(resolveBatchTestCompletion(2, 2, true, false).shouldShowLogs, true);
  assert.equal(resolveBatchTestCompletion(2, 2, true, true).shouldShowLogs, true);
});

test("失败后恢复弹窗时保留测速日志和结果", () => {
  assert.equal(shouldClearBatchTestArtifacts(false, true), false);
});

test("普通打开空闲弹窗时清理上次测速数据", () => {
  assert.equal(shouldClearBatchTestArtifacts(false, false), true);
  assert.equal(shouldClearBatchTestArtifacts(true, false), false);
});
