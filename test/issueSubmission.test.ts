import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatAttachmentSize,
  validateIssueAttachments,
} from "../src/components/pages/About/issueAttachments.ts";

test("工单附件限制为三个文件并校验图片视频大小", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/issueAttachments.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /MAX_ATTACHMENT_COUNT = 3/);
  assert.match(source, /MAX_IMAGE_SIZE = 10 \* 1024 \* 1024/);
  assert.match(source, /MAX_VIDEO_SIZE = 100 \* 1024 \* 1024/);
  assert.match(source, /MAX_TOTAL_SIZE = 200 \* 1024 \* 1024/);
  assert.match(source, /image\/jpeg/);
  assert.match(source, /video\/x-matroska/);
});

test("附件校验拒绝超量、伪装类型和超限文件", () => {
  const image = (name: string, size: number, type = "image/png") => ({ name, size, type }) as File;
  assert.equal(validateIssueAttachments([image("a.png", 1024)]), null);
  assert.equal(validateIssueAttachments([
    image("a.png", 1),
    image("b.png", 1),
    image("c.png", 1),
    image("d.png", 1),
  ]), "最多上传 3 个附件");
  assert.equal(validateIssueAttachments([image("伪装.exe", 1)]), "伪装.exe 的文件类型不支持");
  assert.equal(validateIssueAttachments([image("大图.png", 11 * 1024 * 1024)]), "大图.png 超过图片 10 MB 限制");
  assert.equal(formatAttachmentSize(1536 * 1024), "1.5 MB");
});

test("工单提交使用 multipart 并保留认证头", async () => {
  const source = await readFile(
    new URL("../src/services/backendApi.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /const formData = new FormData\(\)/);
  assert.match(source, /payload\.attachments\?\.forEach/);
  // XHR 上传：multipart 边界由浏览器生成，authHeaders 的 Content-Type 被移除
  assert.match(source, /const headers = authHeaders\(\);\s*\n\s*delete headers\["Content-Type"\]/);
  assert.match(source, /uploadFormData<IssueSubmitResponse>/);
  assert.doesNotMatch(source, /body: JSON\.stringify\(\{[\s\S]*?title: payload\.title[\s\S]*?captcha:/);
});

test("点击提交时先隐藏工单弹窗并在验证失败后恢复", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueSubmitDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /setCaptchaActive\(true\)[\s\S]*?await verifyCaptcha\(\)/);
  assert.match(source, /setCaptchaActive\(false\)/);
  assert.match(source, /open=\{open && !captchaActive\}/);
  assert.doesNotMatch(source, /if \(open\) \{\s*setTitle\(""\)/);
});

test("工单弹窗展示资格状态且不再显示提交规则说明", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueSubmitDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /getIssueSubmitPermission/);
  assert.match(source, /permission\.allowed/);
  // 提交规则文案已按要求移除，仅保留资格状态提示
  assert.doesNotMatch(source, /首次登录满 24 小时/);
  assert.doesNotMatch(source, /每天最多提交 5 个工单/);
  assert.doesNotMatch(source, /滥用工单可能会被禁用/);
});

test("工单详情批量获取附件预览并支持图片放大与视频播放", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueListSection.tsx", import.meta.url),
    "utf8",
  );
  // 打开详情后为主附件与回复附件并行解析本地缓存或在线预览 URL
  assert.match(source, /resolveIssueAttachmentUrl/);
  assert.match(source, /res\.data\.attachments \|\| \[\]/);
  assert.match(source, /flatMap\(\(r\) => r\.attachments \|\| \[\]\)/);
  // 图片点击放大
  assert.match(source, /setLightboxUrl/);
  // 视频在线播放
  assert.match(source, /<video[\s\S]*?controls/);
});

test("回复工单支持选择并上传附件", async () => {
  const apiSource = await readFile(
    new URL("../src/services/backendApi.ts", import.meta.url),
    "utf8",
  );
  const sectionSource = await readFile(
    new URL("../src/components/pages/About/IssueListSection.tsx", import.meta.url),
    "utf8",
  );
  // API：有附件时走 multipart 表单
  assert.match(apiSource, /formData\.append\("attachments", file, file\.name\)/);
  // 组件：附件选择、数量上限与移除交互
  assert.match(sectionSource, /handleReplyFileSelect/);
  assert.match(sectionSource, /validateIssueAttachments\(merged\)/);
  assert.match(sectionSource, /replyFiles\.length >= MAX_ATTACHMENT_COUNT/);
  assert.match(sectionSource, /removeReplyFile/);
  // 带附件时传递进度回调（上传进度条）
  assert.match(sectionSource, /hasFiles \? setReplyUploadProgress : undefined/);
});
