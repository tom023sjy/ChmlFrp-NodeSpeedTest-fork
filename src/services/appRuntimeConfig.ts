import { BACKEND_API_BASE_URL } from "../lib/api-endpoints.ts";

export type AnnouncementLevel = "info" | "warning" | "error";

export interface Announcement {
  id: string;
  revision: number;
  title: string;
  content: string;
  contentFormat?: "markdown";
  level: AnnouncementLevel;
  publishedAt: string;
  expiresAt: string | null;
  sortOrder: number;
}

export interface FeatureAvailability {
  enabled: boolean;
  reason: string | null;
}

export const FEATURE_KEYS = [
  "nodeTesting",
  "deviceManagement",
  "deviceRelay",
  "remoteOperations",
  "remoteTesting",
  "dnsCredentials",
  "dnsFailover",
  "ddns",
  "sslCertificates",
  "issueFeedback",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureAvailabilityMap = Record<FeatureKey, FeatureAvailability>;

export interface RuntimeConfig {
  version: number;
  updatedAt: string;
  announcements: Announcement[];
  features: FeatureAvailabilityMap;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type RuntimeConfigRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const CACHE_PREFIX = "app_runtime_config";
const READ_PREFIX = "app_announcement_read";
export const RUNTIME_CONFIG_REFRESH_INTERVAL_MS = 60_000;

function accountKey(account: string): string {
  return encodeURIComponent(account.trim() || "anonymous");
}

function browserStorage(): StorageLike | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isAnnouncement(value: unknown): value is Announcement {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    Number.isInteger(value.revision) &&
    (value.revision as number) > 0 &&
    typeof value.title === "string" &&
    typeof value.content === "string" &&
    (value.contentFormat === undefined || value.contentFormat === "markdown") &&
    (value.level === "info" || value.level === "warning" || value.level === "error") &&
    typeof value.publishedAt === "string" &&
    isNullableString(value.expiresAt) &&
    Number.isFinite(value.sortOrder)
  );
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  if (!isRecord(value) || !isRecord(value.features)) return false;
  const features = value.features;
  return (
    Number.isInteger(value.version) &&
    (value.version as number) > 0 &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.announcements) &&
    value.announcements.every(isAnnouncement) &&
    FEATURE_KEYS.every((key) => {
      const feature = features[key];
      return isRecord(feature) && typeof feature.enabled === "boolean" && isNullableString(feature.reason);
    })
  );
}

function stableRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    version: config.version,
    updatedAt: config.updatedAt,
    announcements: config.announcements.map((announcement) => ({ ...announcement })),
    features: Object.fromEntries(
      FEATURE_KEYS.map((key) => [key, { ...config.features[key] }]),
    ) as FeatureAvailabilityMap,
  };
}

function defaultFeatures(): FeatureAvailabilityMap {
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, { enabled: true, reason: null }]),
  ) as FeatureAvailabilityMap;
}

export function defaultRuntimeConfig(): RuntimeConfig {
  return {
    version: 1,
    updatedAt: "",
    announcements: [],
    features: defaultFeatures(),
  };
}

export function runtimeConfigCacheKey(account: string): string {
  return `${CACHE_PREFIX}:${accountKey(account)}`;
}

export function announcementReadKey(account: string, announcementId: string, revision: number): string {
  return `${READ_PREFIX}:${accountKey(account)}:${encodeURIComponent(announcementId)}:${revision}`;
}

export function readAppRuntimeConfig(
  account: string,
  storage: StorageLike | null = browserStorage(),
): RuntimeConfig | null {
  if (!storage) return null;
  const raw = storage.getItem(runtimeConfigCacheKey(account));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRuntimeConfig(parsed) ? stableRuntimeConfig(parsed) : null;
  } catch {
    return null;
  }
}

export function writeAppRuntimeConfig(
  account: string,
  config: RuntimeConfig,
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  if (!isRuntimeConfig(config)) throw new Error("运行时配置无效");
  storage.setItem(runtimeConfigCacheKey(account), JSON.stringify(config));
}

export function isRuntimeConfigEqual(left: RuntimeConfig, right: RuntimeConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function findNewAnnouncements(
  current: Announcement[],
  next: Announcement[],
): Announcement[] {
  const revisions = new Map(current.map((item) => [item.id, item.revision]));
  return next.filter((item) => !revisions.has(item.id) || revisions.get(item.id) !== item.revision);
}

export function isAnnouncementRead(
  account: string,
  announcement: Pick<Announcement, "id" | "revision">,
  storage: StorageLike | null = browserStorage(),
): boolean {
  return storage?.getItem(announcementReadKey(account, announcement.id, announcement.revision)) === "1";
}

export function markAnnouncementRead(
  account: string,
  announcement: Pick<Announcement, "id" | "revision">,
  storage: StorageLike | null = browserStorage(),
): void {
  storage?.setItem(announcementReadKey(account, announcement.id, announcement.revision), "1");
}

export async function fetchAppRuntimeConfig(
  request: RuntimeConfigRequest = fetch,
): Promise<RuntimeConfig> {
  const response = await request(`${BACKEND_API_BASE_URL}/api/app/runtime-config`, {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("运行时配置响应无效");
  }
  if (!response.ok) throw new Error("获取运行时配置失败");
  if (!isRecord(body) || body.success !== true) {
    throw new Error("运行时配置响应无效");
  }
  if (body.data === null || body.data === undefined) return defaultRuntimeConfig();
  if (!isRuntimeConfig(body.data)) throw new Error("运行时配置响应无效");
  return stableRuntimeConfig(body.data);
}
