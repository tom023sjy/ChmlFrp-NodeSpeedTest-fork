import assert from "node:assert/strict";
import test from "node:test";
import { TestRunController } from "../src/services/testRunController.ts";

test("普通停止只停止后续节点", () => {
  const controller = new TestRunController("run-1");
  controller.requestStop();
  assert.equal(controller.shouldStopBatch(), true);
  assert.equal(controller.isForceStopping(), false);
  assert.equal(controller.signal.aborted, false);
});

test("强制停止立即中止当前阶段", () => {
  const controller = new TestRunController("run-2");
  controller.forceStop();
  assert.equal(controller.shouldStopBatch(), true);
  assert.equal(controller.isForceStopping(), true);
  assert.equal(controller.signal.aborted, true);
});
