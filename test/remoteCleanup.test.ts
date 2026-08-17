import assert from "node:assert/strict";
import test from "node:test";
import { cleanupRemoteResources } from "../src/services/remoteCleanup.ts";

test("清理进行中时重试并在资源已释放后视为成功", async () => {
  const responses = [
    { success: true, data: { cleaned: false, reason: "CLEANUP_IN_PROGRESS" }, error: null },
    { success: true, data: { cleaned: false, reason: "RUN_NOT_ACTIVE" }, error: null },
  ];
  let attempts = 0;

  await cleanupRemoteResources(
    async () => responses[attempts++],
    { maxAttempts: 3, retryDelayMs: 0 },
  );

  assert.equal(attempts, 2);
});

test("资源已不活跃时直接视为清理成功", async () => {
  await cleanupRemoteResources(async () => ({
    success: true,
    data: { cleaned: false, reason: "RUN_NOT_ACTIVE" },
    error: null,
  }));
});

test("真实清理失败时保留错误信息", async () => {
  await assert.rejects(
    cleanupRemoteResources(async () => ({
      success: false,
      data: null,
      error: { code: "CLEANUP_FAILED", message: "删除隧道失败" },
    })),
    /删除隧道失败/,
  );
});

test("清理持续进行超过重试上限时返回明确错误", async () => {
  let attempts = 0;

  await assert.rejects(
    cleanupRemoteResources(
      async () => {
        attempts += 1;
        return {
          success: true,
          data: { cleaned: false, reason: "CLEANUP_IN_PROGRESS" },
          error: null,
        };
      },
      { maxAttempts: 3, retryDelayMs: 0 },
    ),
    /资源清理超时/,
  );

  assert.equal(attempts, 3);
});
