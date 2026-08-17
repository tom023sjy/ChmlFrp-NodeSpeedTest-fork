import assert from "node:assert/strict";
import test from "node:test";
import { awaitWithAbort } from "../src/services/abortable.ts";

test("中止信号立即结束当前等待", async () => {
  const controller = new AbortController();
  const pending = new Promise<string>(() => undefined);
  const result = awaitWithAbort(pending, controller.signal);
  controller.abort(new DOMException("测速已强制停止", "AbortError"));
  await assert.rejects(result, /测速已强制停止/);
});

test("未中止时返回原始结果", async () => {
  const controller = new AbortController();
  await assert.doesNotReject(async () => {
    assert.equal(await awaitWithAbort(Promise.resolve("完成"), controller.signal), "完成");
  });
});
