import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("工单详情支持附件在线预览（签名 URL + inline 流式返回）", async () => {
  const apiSource = await readFile(
    new URL("../src/services/backendApi.ts", import.meta.url),
    "utf8",
  );

  // 与后端 GET /api/issues/:issueId/attachments/:attachmentId/preview-url 对应
  assert.match(apiSource, /\/api\/issues\/\$\{issueId\}\/attachments\/\$\{attachmentId\}\/preview-url/);
  // 预览响应带 mimeType，便于前端区分图片与视频
  assert.match(apiSource, /interface AttachmentPreviewResponse/);
  assert.match(apiSource, /mimeType: string;/);
});

test("工单回复支持 multipart 附件上传", async () => {
  const apiSource = await readFile(
    new URL("../src/services/backendApi.ts", import.meta.url),
    "utf8",
  );

  // 带附件时走 multipart（XHR 上传），无附件时保持 JSON
  assert.match(apiSource, /\/api\/issues\/\$\{issueId\}\/reply/);
  assert.match(apiSource, /formData\.append\("attachments", file, file\.name\)/);
});

test("回复附件上传使用 XHR 支持进度回调", async () => {
  const apiSource = await readFile(
    new URL("../src/services/backendApi.ts", import.meta.url),
    "utf8",
  );

  // replyIssue 必须暴露 onUploadProgress 并传给 uploadFormData
  assert.match(apiSource, /replyIssue\([\s\S]*?onUploadProgress\?: \(percent: number\) => void/);
  assert.match(apiSource, /uploadFormData<IssueReplyResponse>\([\s\S]*?onUploadProgress/);
});

test("工单详情展示附件画廊（图片缩略图 + 视频在线播放 + Lightbox 放大）", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueListSection.tsx", import.meta.url),
    "utf8",
  );

  // 附件画廊组件：图片点击放大、视频直接播放
  assert.match(source, /function AttachmentGallery/);
  assert.match(source, /attachment\.mimeType\.startsWith\("image\/"\)/);
  assert.match(source, /<video/);
  // Lightbox 放大查看
  assert.match(source, /lightboxUrl/);
  // 批量解析附件地址（优先本地持久缓存，未命中再获取在线地址）
  assert.match(source, /resolveIssueAttachmentUrl/);
});

test("打开图片时关闭工单，关闭图片后恢复工单", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueListSection.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /const openImagePreview = \(url: string\) => \{[\s\S]*?setDetailOpen\(false\);[\s\S]*?setLightboxUrl\(url\);/);
  assert.match(source, /const closeImagePreview = \(\) => \{[\s\S]*?setLightboxUrl\(null\);[\s\S]*?setDetailOpen\(true\);/);
  assert.match(source, /onClick=\{closeImagePreview\}/);
});

test("按 Esc 关闭图片后恢复工单", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueListSection.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /if \(event\.key === "Escape"\) closeImagePreview\(\);/);
  assert.match(source, /window\.addEventListener\("keydown", handleKeyDown\)/);
  assert.match(source, /window\.removeEventListener\("keydown", handleKeyDown\)/);
  assert.match(source, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
});

test("回复表单支持选择与移除附件并展示上传进度", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueListSection.tsx", import.meta.url),
    "utf8",
  );

  // 回复附件选择与移除
  assert.match(source, /handleReplyFileSelect/);
  assert.match(source, /removeReplyFile/);
  assert.match(source, /replyFiles/);
  // 回复附件上传进度（与提交工单体验一致）
  assert.match(source, /replyUploadProgress/);
  assert.match(source, /回复附件上传中/);
});
