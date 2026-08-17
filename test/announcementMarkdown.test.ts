import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync("src/components/AnnouncementMarkdown.tsx", "utf8");
const dialogSource = readFileSync("src/components/dialogs/AnnouncementDialog.tsx", "utf8");
const serviceSource = readFileSync("src/services/appRuntimeConfig.ts", "utf8");

test("公告类型兼容 Markdown 格式字段和旧缓存", () => {
  assert.match(serviceSource, /contentFormat\?: "markdown"/);
  assert.match(serviceSource, /value\.contentFormat === undefined \|\| value\.contentFormat === "markdown"/);
});

test("Markdown 公告使用标准渲染且不启用原始 HTML", () => {
  assert.match(componentSource, /import ReactMarkdown from "react-markdown"/);
  assert.doesNotMatch(componentSource, /rehypeRaw|dangerouslySetInnerHTML/);
  assert.match(componentSource, /https\?:/);
});

test("围栏代码块支持复制且超宽内容自动换行", () => {
  assert.match(componentSource, /navigator\.clipboard\.writeText/);
  assert.match(componentSource, /Copy|Check/);
  assert.match(componentSource, /whitespace-pre-wrap/);
  assert.match(componentSource, /break-words/);
});

test("围栏代码块不会复用行内代码的浅色背景", () => {
  assert.match(componentSource, /<pre[^>]*>\s*\{code\}\s*<\/pre>/s);
  assert.doesNotMatch(componentSource, /<pre[^>]*>\s*\{children\}\s*<\/pre>/s);
  assert.match(componentSource, /bg-muted px-1 py-0\.5/);
});

test("公告弹窗仅在格式标识为 Markdown 时启用 Markdown 渲染", () => {
  assert.match(dialogSource, /announcement\?\.contentFormat === "markdown"/);
  assert.match(dialogSource, /<AnnouncementMarkdown/);
  assert.match(dialogSource, /whitespace-pre-wrap/);
});

test("公告弹窗宽高随窗口自适应", () => {
  assert.match(dialogSource, /w-\[clamp\(640px,70vw,960px\)\]/);
  assert.match(dialogSource, /max-h-\[85vh\]/);
  assert.match(dialogSource, /className="[^"]*flex[^"]*min-h-0[^"]*flex-col/);
  assert.doesNotMatch(dialogSource, /max-h-72/);
});
