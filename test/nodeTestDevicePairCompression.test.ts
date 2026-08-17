import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/components/pages/NodeTest/index.tsx", import.meta.url),
  "utf8",
);

test("设备对按钮空间充足时显示全名且空间不足时可收缩", () => {
  assert.match(source, /className="h-8 min-w-0 shrink items-center/);
  assert.match(source, /className="min-w-0 shrink truncate"/);
  assert.doesNotMatch(source, /max-w-\[min\(36vw,320px\)\]/);
  assert.doesNotMatch(source, /max-w-\[clamp\(2rem,9vw,120px\)\]/);
  assert.match(source, /className="h-3\.5 w-3\.5 shrink-0/);
});
