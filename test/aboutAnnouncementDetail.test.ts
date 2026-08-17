import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sectionSource = readFileSync("src/components/pages/About/AnnouncementSection.tsx", "utf8");
const detailSource = readFileSync("src/components/pages/About/AnnouncementDetailDialog.tsx", "utf8");

test("关于页公告列表仅显示标题不再内联正文", () => {
  assert.doesNotMatch(sectionSource, /\{announcement\.content\}/);
  assert.match(sectionSource, /announcement\.title/);
  assert.match(sectionSource, /truncate/);
});

test("关于页公告条目可点击打开详情弹窗", () => {
  assert.match(sectionSource, /setSelectedAnnouncement\(/);
  assert.match(sectionSource, /<AnnouncementDetailDialog/);
});

test("公告详情弹窗按格式渲染 Markdown 并保持旧公告纯文本", () => {
  assert.match(detailSource, /contentFormat === "markdown"/);
  assert.match(detailSource, /<AnnouncementMarkdown/);
  assert.match(detailSource, /whitespace-pre-wrap/);
});

test("公告详情弹窗复用公告弹窗的自适应宽高", () => {
  assert.match(detailSource, /w-\[clamp\(640px,70vw,960px\)\]/);
  assert.match(detailSource, /max-h-\[85vh\]/);
  assert.match(detailSource, /w-\[calc\(100vw-2rem\)\]/);
});
