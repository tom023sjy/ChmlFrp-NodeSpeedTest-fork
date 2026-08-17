import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialogSource = readFileSync("src/components/dialogs/BatchSpeedTestDialog.tsx", "utf8");
const detailSource = readFileSync("src/components/dialogs/TestHistoryDetailDialog.tsx", "utf8");
const pageSource = readFileSync("src/components/pages/NodeTest/index.tsx", "utf8");
const serviceSource = readFileSync("src/services/testHistoryService.ts", "utf8");

test("批量测速向完成回调传递所有节点结果及其独立日志", () => {
  assert.match(dialogSource, /export interface NodeResult[\s\S]*logs: LogEntry\[\]/);
  assert.match(dialogSource, /new Map<string, NodeResult>/);
  assert.doesNotMatch(dialogSource, /if \(r\.details\) resultMap\.set/);
});

test("测速历史保存日志并从历史列表打开记录详情", () => {
  assert.match(serviceSource, /logs\?: LogEntry\[\]/);
  assert.match(pageSource, /logs: result\.logs/);
  assert.match(pageSource, /<TestHistoryDetailDialog/);
  assert.match(pageSource, /variant="ghost"\s*size="sm"/);
  assert.match(pageSource, /setSelectedHistoryRecord\(record as TestHistoryRecord\)/);
  assert.match(detailSource, /测试日志/);
  assert.match(detailSource, /record\.logs/);
});

test("测速历史写入完成后立即刷新页面历史状态", () => {
  assert.match(pageSource, /saveDevicePair\(localStorage, username, pair\);\s*loadHistory\(\);/);
});
