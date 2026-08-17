import assert from "node:assert/strict";
import test from "node:test";
import {
  dnsFailoverCacheKey,
  isDnsFailoverSnapshotEqual,
  readDnsFailoverSnapshot,
  writeDnsFailoverSnapshot,
} from "../src/services/dnsFailoverCache.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const snapshot = {
  tasks: [],
  credentials: [],
  executionTargets: [],
  runtime: {},
  updatedAt: "2026-08-13T00:00:00.000Z",
};

test("DNS 容灾缓存按账号隔离", () => {
  assert.notEqual(dnsFailoverCacheKey("alice"), dnsFailoverCacheKey("bob"));
});

test("DNS 容灾快照可写入并读取", () => {
  const storage = new MemoryStorage();
  writeDnsFailoverSnapshot("alice", snapshot, storage);
  assert.deepEqual(readDnsFailoverSnapshot("alice", storage), snapshot);
});

test("损坏缓存返回空值", () => {
  const storage = new MemoryStorage();
  storage.setItem(dnsFailoverCacheKey("alice"), "{");
  assert.equal(readDnsFailoverSnapshot("alice", storage), null);
});

test("比较快照时忽略更新时间", () => {
  assert.equal(isDnsFailoverSnapshotEqual(snapshot, { ...snapshot, updatedAt: "later" }), true);
  assert.equal(isDnsFailoverSnapshotEqual(snapshot, { ...snapshot, executionTargets: [{ type: "cloud", id: "xian-cloud", name: "云端", online: true, capabilities: [] }] }), false);
});
