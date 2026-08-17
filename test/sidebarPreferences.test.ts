import assert from "node:assert/strict";
import test from "node:test";
import {
  filterVisibleSidebarItems,
  normalizeHiddenSidebarItems,
} from "../src/services/sidebarPreferences.ts";

test("设置和关于不能从侧边栏隐藏", () => {
  assert.deepEqual(
    normalizeHiddenSidebarItems(["ssl-certs", "settings", "about"]),
    ["ssl-certs"],
  );
});

test("侧边栏过滤用户主动隐藏的项目", () => {
  const items = [{ id: "node-test" }, { id: "ssl-certs" }, { id: "settings" }];
  assert.deepEqual(
    filterVisibleSidebarItems(items, ["ssl-certs"]).map((item) => item.id),
    ["node-test", "settings"],
  );
});
