import type { ExecutionTargetInfo } from "@/services/dnsFailoverCloudService";
import type {
  DnsCredential,
  DnsMonitorTask,
  TaskRuntime,
} from "@/services/dnsFailoverService";

export interface DnsFailoverSnapshot {
  tasks: DnsMonitorTask[];
  credentials: DnsCredential[];
  executionTargets: ExecutionTargetInfo[];
  runtime: Record<string, TaskRuntime>;
  updatedAt: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CACHE_PREFIX = "dns_failover_cloud_cache";

export function dnsFailoverCacheKey(username: string): string {
  return `${CACHE_PREFIX}__${username}`;
}

export function readDnsFailoverSnapshot(
  username: string,
  storage: StorageLike = localStorage,
): DnsFailoverSnapshot | null {
  if (!username) return null;
  try {
    const value = storage.getItem(dnsFailoverCacheKey(username));
    if (!value) return null;
    const parsed = JSON.parse(value) as DnsFailoverSnapshot;
    if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.credentials) || !Array.isArray(parsed.executionTargets)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDnsFailoverSnapshot(
  username: string,
  snapshot: DnsFailoverSnapshot,
  storage: StorageLike = localStorage,
): void {
  if (!username) return;
  storage.setItem(dnsFailoverCacheKey(username), JSON.stringify(snapshot));
}

export function isDnsFailoverSnapshotEqual(
  current: DnsFailoverSnapshot,
  next: DnsFailoverSnapshot,
): boolean {
  const { updatedAt: _currentUpdatedAt, ...currentData } = current;
  const { updatedAt: _nextUpdatedAt, ...nextData } = next;
  return JSON.stringify(currentData) === JSON.stringify(nextData);
}
