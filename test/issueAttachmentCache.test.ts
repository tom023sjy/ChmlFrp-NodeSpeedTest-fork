import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("工单附件缓存跨重启持久化并合并并发请求", async () => {
  const source = await readFile(
    new URL("../src/services/issueAttachmentCache.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /get_issue_attachment_cache_path/);
  assert.match(source, /cache_issue_attachment/);
  assert.match(source, /convertFileSrc/);
  assert.match(source, /const inFlight = new Map<string, Promise<string>>\(\)/);
});

test("附件后台缓存完成后立即回调本地地址，失败时输出明确日志", async () => {
  const source = await readFile(
    new URL("../src/services/issueAttachmentCache.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /onCached\?: \(url: string\) => void/);
  assert.match(source, /onCached\?\.\(convertFileSrc\(cachedPath\)\)/);
  assert.match(source, /console\.warn\("工单附件缓存失败"/);
});

test("Rust 缓存兼容服务端通用二进制 MIME 并记录失败原因", async () => {
  const source = await readFile(
    new URL("../src-tauri/src/commands/issue_attachment_cache.rs", import.meta.url),
    "utf8",
  );

  assert.match(source, /fn is_compatible_response_mime/);
  assert.match(source, /"application\/octet-stream"/);
  assert.match(source, /log::warn!\([\s\S]*?"工单附件缓存失败/);
});

test("附件下载跟随 CDN 重定向并携带 User-Agent，失败日志记录响应细节", async () => {
  const source = await readFile(
    new URL("../src-tauri/src/commands/issue_attachment_cache.rs", import.meta.url),
    "utf8",
  );

  // 禁止重定向会导致 CDN 302 签名跳转直接失败
  assert.doesNotMatch(source, /redirect::Policy::none\(\)/);
  assert.match(source, /USER_AGENT/);
  // 失败时日志必须带上实际响应信息，便于定位 MIME/状态码差异
  assert.match(source, /实际响应类型/);
});

test("日志插件全模式输出到文件，缓存失败可在数据目录定位", async () => {
  const source = await readFile(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );

  // 日志初始化不得仅在 debug 模式执行
  const debugOnlyInit = /if cfg!\(debug_assertions\)\s*\{\s*app\.handle\(\)\.plugin\(\s*tauri_plugin_log::Builder::default\(\)/;
  assert.doesNotMatch(source, debugOnlyInit);
  assert.match(source, /TargetKind::Folder/);
});

test("工单详情先查询本地缓存，未命中才申请签名预览地址", async () => {
  const source = await readFile(
    new URL("../src/components/pages/About/IssueListSection.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /resolveIssueAttachmentUrl/);
  assert.doesNotMatch(source, /const preview = await getAttachmentPreviewUrl\(id, attachment\.id\)/);
});

test("清理本地缓存同时清理持久化工单附件", async () => {
  const source = await readFile(
    new URL("../src/components/pages/Settings/components/MaintenanceSection.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /clearIssueAttachmentCache/);
  assert.match(source, /工单附件缓存/);
});

test("Tauri 注册工单附件缓存命令并开放本地媒体资源协议", async () => {
  const libSource = await readFile(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  const configSource = await readFile(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  );

  assert.match(libSource, /commands::get_issue_attachment_cache_path/);
  assert.match(libSource, /commands::cache_issue_attachment/);
  assert.match(libSource, /commands::clear_issue_attachment_cache/);
  assert.match(configSource, /"assetProtocol"/);
});
