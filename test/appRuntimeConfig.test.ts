import assert from "node:assert/strict";
import test from "node:test";
import {
  announcementReadKey,
  defaultRuntimeConfig,
  fetchAppRuntimeConfig,
  isAnnouncementRead,
  isRuntimeConfigEqual,
  markAnnouncementRead,
  readAppRuntimeConfig,
  RUNTIME_CONFIG_REFRESH_INTERVAL_MS,
  runtimeConfigCacheKey,
  writeAppRuntimeConfig,
  findNewAnnouncements,
} from "../src/services/appRuntimeConfig.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const runtimeConfig = {
  version: 3,
  updatedAt: "2026-08-14T08:00:00.000Z",
  announcements: [
    {
      id: "maintenance",
      revision: 2,
      title: "设备管理维护",
      content: "设备管理将在维护完成后恢复。",
      level: "warning" as const,
      publishedAt: "2026-08-14T08:00:00.000Z",
      expiresAt: null,
      sortOrder: 10,
    },
  ],
  features: {
    nodeTesting: { enabled: true, reason: null },
    deviceManagement: { enabled: true, reason: null },
    deviceRelay: { enabled: true, reason: null },
    remoteOperations: { enabled: true, reason: null },
    remoteTesting: { enabled: true, reason: null },
    dnsCredentials: { enabled: true, reason: null },
    dnsFailover: { enabled: true, reason: null },
    ddns: { enabled: true, reason: null },
    sslCertificates: { enabled: false, reason: "SSL 证书功能维护中" },
    issueFeedback: { enabled: true, reason: null },
  },
};

test("运行时配置缓存按账号隔离", () => {
  assert.notEqual(runtimeConfigCacheKey("alice"), runtimeConfigCacheKey("bob"));
});

test("运行时配置每 60 秒静默刷新", () => {
  assert.equal(RUNTIME_CONFIG_REFRESH_INTERVAL_MS, 60_000);
});

test("刷新配置时只识别新增或修订后的公告", () => {
  const current = [{ ...runtimeConfig.announcements[0], revision: 1 }];
  const revised = { ...runtimeConfig.announcements[0], revision: 2 };
  const added = { ...runtimeConfig.announcements[0], id: "new-feature", title: "功能公告" };
  assert.deepEqual(
    findNewAnnouncements(current, [revised, added]).map((item) => item.id),
    [revised.id, added.id],
  );
});

test("运行时配置可写入并按账号读取", () => {
  const storage = new MemoryStorage();
  writeAppRuntimeConfig("alice", runtimeConfig, storage);

  assert.deepEqual(readAppRuntimeConfig("alice", storage), runtimeConfig);
  assert.equal(readAppRuntimeConfig("bob", storage), null);
});

test("损坏或不完整的运行时配置缓存返回空值", () => {
  const storage = new MemoryStorage();
  storage.setItem(runtimeConfigCacheKey("alice"), "{");
  storage.setItem(runtimeConfigCacheKey("bob"), JSON.stringify({ version: 1 }));

  assert.equal(readAppRuntimeConfig("alice", storage), null);
  assert.equal(readAppRuntimeConfig("bob", storage), null);
});

test("无缓存时默认开启全部业务功能", () => {
  const config = defaultRuntimeConfig();

  assert.equal(config.features.sslCertificates.enabled, true);
  assert.equal(config.features.sslCertificates.reason, null);
  assert.deepEqual(config.announcements, []);
});

test("配置比较忽略对象引用但保留业务差异", () => {
  assert.equal(isRuntimeConfigEqual(runtimeConfig, structuredClone(runtimeConfig)), true);
  assert.equal(
    isRuntimeConfigEqual(runtimeConfig, {
      ...runtimeConfig,
      features: {
        ...runtimeConfig.features,
        sslCertificates: { enabled: true, reason: null },
      },
    }),
    false,
  );
});

test("公告已读状态按账号、公告和修订隔离", () => {
  const storage = new MemoryStorage();
  const announcement = runtimeConfig.announcements[0];

  assert.equal(announcementReadKey("alice", announcement.id, announcement.revision).includes("maintenance:2"), true);
  assert.equal(isAnnouncementRead("alice", announcement, storage), false);
  markAnnouncementRead("alice", announcement, storage);
  assert.equal(isAnnouncementRead("alice", announcement, storage), true);
  assert.equal(isAnnouncementRead("bob", announcement, storage), false);
  assert.equal(isAnnouncementRead("alice", { ...announcement, revision: 3 }, storage), false);
});

test("业务后端接口读取完整运行时配置", async () => {
  let requestedUrl = "";
  const request = async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ success: true, data: runtimeConfig }), { status: 200 });
  };

  const result = await fetchAppRuntimeConfig(request);

  assert.equal(requestedUrl, "https://api.cct.zdzz.top/api/app/runtime-config");
  assert.deepEqual(result, runtimeConfig);
});

test("业务后端未提供运行时配置时使用默认值", async () => {
  const result = await fetchAppRuntimeConfig(async () =>
    new Response(JSON.stringify({ success: true, data: null }), { status: 200 }),
  );
  assert.deepEqual(result, defaultRuntimeConfig());
});

test("业务后端接口拒绝失败响应和错误配置", async () => {
  await assert.rejects(
    fetchAppRuntimeConfig(async () =>
      new Response(JSON.stringify({ message: "配置不可用" }), { status: 503 }),
    ),
    /获取运行时配置失败/,
  );
  await assert.rejects(
    fetchAppRuntimeConfig(async () =>
      new Response(JSON.stringify({ success: true, data: { version: 1 } }), { status: 200 }),
    ),
    /运行时配置响应无效/,
  );
});
