import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Daemon 服务状态每 5 秒自动刷新", async () => {
  const source = await readFile(
    new URL("../src/components/pages/DeviceManagement/DaemonManagePanel.tsx", import.meta.url),
    "utf8",
  );

  // ServiceTab 每 5 秒静默轮询
  assert.match(source, /setInterval\(\s*\(\) => \{\s*void refresh\(true\);/);
  assert.match(source, /}, 5000\);/);
  // 轮询失败静默处理，保留最后一次成功状态
  assert.match(source, /silent/);
});

test("服务状态卡片已移除手动刷新按钮与自动刷新提示字眼", async () => {
  const source = await readFile(
    new URL("../src/components/pages/DeviceManagement/DaemonManagePanel.tsx", import.meta.url),
    "utf8",
  );

  // 旧的手动刷新按钮绑定方式不应再出现
  assert.doesNotMatch(source, /onClick=\{refresh\}/);
  // 界面不展示"每 5 秒自动刷新"提示字眼（自动刷新静默进行）
  assert.doesNotMatch(source, /每 5 秒自动刷新/);
});

test("RPC 请求顶层携带 runId 供后端关联活动任务", async () => {
  const source = await readFile(
    new URL("../src/services/deviceRelay.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /type: "rpc_request",[\s\S]*?\.\.\.\(options\?\.runId \? \{ runId: options\.runId \} : \{\}\),/);
});
