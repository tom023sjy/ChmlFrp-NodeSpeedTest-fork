import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const batchDialogUrl = new URL(
  "../src/components/dialogs/BatchSpeedTestDialog.tsx",
  import.meta.url,
);
const e2eDialogUrl = new URL(
  "../src/components/dialogs/E2ETestDialog.tsx",
  import.meta.url,
);
const unifiedServiceUrl = new URL(
  "../src/services/unifiedTestService.ts",
  import.meta.url,
);

test("测速配置统一使用默认十五秒和五至一百二十秒边界", async () => {
  const sources = await Promise.all([
    readFile(batchDialogUrl, "utf8"),
    readFile(e2eDialogUrl, "utf8"),
  ]);

  for (const source of sources) {
    assert.match(source, /测试时长/);
    assert.match(source, /durationSeconds/);
    assert.match(source, /min=\{5\}/);
    assert.match(source, /max=\{120\}/);
  }
});

test("统一测试接口使用时长参数并携带采样结果", async () => {
  const source = await readFile(unifiedServiceUrl, "utf8");
  assert.match(source, /durationSeconds: number/);
  assert.match(source, /latencySamples/);
  assert.match(source, /speedSamples/);
});
