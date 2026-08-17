import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("打开更新管理时自动检查 daemon 最新版本", async () => {
  const source = await readFile(
    new URL(
      "../src/components/pages/DeviceManagement/DaemonManagePanel.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /void loadUpdateData\(\)/);
  assert.match(
    source,
    /Promise\.allSettled\(\[\s*daemonGetUpdateSettings\(deviceId\),\s*daemonCheckUpdate\(deviceId\),?\s*\]\)/,
  );
  assert.match(source, /setCheckResult\(updateResult\.value\)/);
});

test("自动检查不显示当前已是最新版本提示", async () => {
  const source = await readFile(
    new URL(
      "../src/components/pages/DeviceManagement/DaemonManagePanel.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /const handleCheck = async \(silent = false\)/);
  assert.match(source, /else if \(!silent\) \{\s*toast\.info\("当前已是最新版本"\)/);
});
