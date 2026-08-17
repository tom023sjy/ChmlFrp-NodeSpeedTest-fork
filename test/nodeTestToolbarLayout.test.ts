import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/components/pages/NodeTest/index.tsx", import.meta.url),
  "utf8",
);

test("节点测试工具栏优先压缩按钮并在更窄窗口才换行", () => {
  assert.match(source, /flex flex-col gap-3 md:flex-row md:items-center md:justify-between/);
  assert.match(source, /flex shrink-0 items-center gap-3 whitespace-nowrap/);
  assert.match(source, /flex min-w-0 flex-wrap gap-1 md:flex-1 md:flex-nowrap md:justify-end xl:gap-2/);
  assert.match(source, /h-8 px-2 text-xs xl:px-3/);
  assert.doesNotMatch(source, /lg:flex-row|lg:flex-nowrap/);
});
