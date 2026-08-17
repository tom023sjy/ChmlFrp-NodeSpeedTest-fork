import type { StoredUser } from "@/services/api";
import { getDeviceId } from "@/services/deviceId";
import { dnsFailoverService } from "@/services/dnsFailoverService";
import { dnsFailoverCloudService } from "@/services/dnsFailoverCloudService";

const MIGRATION_VERSION = 1;

function migrationKey(username: string): string {
  return `dns_failover_cloud_migration_v${MIGRATION_VERSION}:${username}`;
}

export async function migrateDnsFailoverToCloud(user: StoredUser): Promise<boolean> {
  if (!user.username || !user.proxyToken) return false;
  const key = migrationKey(user.username);
  if (localStorage.getItem(key) === "done") return false;

  const [tasks, credentials, runtime, sourceDeviceId] = await Promise.all([
    dnsFailoverService.listTasks(user.username),
    dnsFailoverService.listCredentials(user.username),
    dnsFailoverService.listRuntime(user.username),
    getDeviceId(),
  ]);
  if (tasks.length === 0 && credentials.length === 0) {
    localStorage.setItem(key, "done");
    return false;
  }

  await dnsFailoverCloudService.importLocalData({
    migrationId: `dns-v${MIGRATION_VERSION}-${sourceDeviceId}-${user.username}`,
    sourceDeviceId,
    tasks,
    credentials,
    runtime,
  });
  localStorage.setItem(key, "done");
  return true;
}
