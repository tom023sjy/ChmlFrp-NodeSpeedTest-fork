import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("设备管理状态每 5 秒刷新一次", async () => {
  const source = await readFile(
    new URL("../src/components/pages/DeviceManagement/index.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /}, 5_000\);/);
  assert.doesNotMatch(source, /每 2 秒|2 秒轮询|}, 2_000\);/);
});
