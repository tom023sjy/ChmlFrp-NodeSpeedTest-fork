import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("工单提交使用 XHR 支持附件上传进度", async () => {
  const source = await readFile(
    new URL("../src/services/backendApi.ts", import.meta.url),
    "utf8",
  );

  // fetch 无法跟踪上传进度，必须使用 XMLHttpRequest
  assert.match(source, /function uploadFormData<T>/);
  assert.match(source, /xhr\.upload\.onprogress/);
  // submitIssue 暴露进度回调
  assert.match(source, /onUploadProgress\?: \(percent: number\) => void/);
});

test("工单对话框展示附件上传进度条", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueSubmitDialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /uploadProgress/);
  assert.match(source, /附件上传中/);
  assert.match(source, /等待服务器处理/);
  // 按文件大小占比拆分分段进度
  assert.match(source, /totalAttachmentBytes/);
});
